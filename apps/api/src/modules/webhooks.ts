/**
 * Outgoing webhooks (Phase 3A): org admins, or API keys with `webhooks:manage`, register endpoints for
 * events. Secrets are shown once and stored encrypted (they're needed to sign). Every delivery and
 * attempt is kept for 30 days and can be redelivered.
 */
import { randomBytes } from 'node:crypto';
import { and, asc, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import {
  CreateWebhookRequest,
  DeliveriesQuery,
  UpdateWebhookRequest,
  type CreatedWebhook,
  type PageResult,
  type Webhook,
  type WebhookDelivery,
  type WebhookDeliveryDetail,
  type WebhookEvent,
  type WebhookTestResult,
} from '@survey/contracts';
import {
  newId,
  surveys,
  webhookAttempts,
  webhookDeliveries,
  webhooks,
  withTenant,
  type Tx,
} from '@survey/db';
import type { Deps } from '../deps';
import { audit } from '../audit';
import { requireOrg } from '../auth/context';
import { newEventId } from '../events';
import { deliverWebhook } from '../jobs/events';
import { encryptSecret } from '../lib/crypto';
import { conflict, notFound, unprocessable } from '../lib/errors';
import { decodeCursor, encodeCursor } from '../lib/misc';
import { checkOutboundUrl } from '../lib/outbound';
import { parse } from '../lib/validate';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
type WebhookRow = typeof webhooks.$inferSelect;
type DeliveryRow = typeof webhookDeliveries.$inferSelect;

const newSecret = () => `whsec_${randomBytes(24).toString('base64url')}`;

function toWebhook(row: WebhookRow): Webhook {
  return {
    id: row.id,
    url: row.url,
    description: row.description,
    events: row.events as WebhookEvent[],
    surveyIds: row.surveyIds,
    active: row.active,
    consecutiveFailures: row.consecutiveFailures,
    disabledReason: row.disabledReason,
    previousSecretExpiresAt:
      row.previousSecretExpiresAt && row.previousSecretExpiresAt.getTime() > Date.now()
        ? row.previousSecretExpiresAt.toISOString()
        : null,
    createdAt: row.createdAt.toISOString(),
  };
}

function toDelivery(row: DeliveryRow): WebhookDelivery {
  return {
    id: row.id,
    eventId: row.eventId,
    eventType: row.eventType,
    status: row.status,
    attempts: row.attempts,
    httpStatus: row.lastHttpStatus,
    createdAt: row.createdAt.toISOString(),
    nextAttemptAt: row.nextAttemptAt?.toISOString() ?? null,
  };
}

export function registerWebhookRoutes(app: FastifyInstance, deps: Deps): void {
  const { pool, config } = deps;
  type IdParams = { Params: { id: string } };
  type DeliveryParams = { Params: { id: string; deliveryId: string } };

  function checkUrl(url: string) {
    const problem = checkOutboundUrl(url, config.allowPrivateUrls);
    if (problem) throw unprocessable('invalid_url', problem);
  }

  async function checkSurveys(tx: Tx, ids: string[] | null | undefined) {
    if (!ids?.length) return;
    const found = await tx.db
      .select({ id: surveys.id })
      .from(surveys)
      .where(and(inArray(surveys.id, ids), isNull(surveys.deletedAt)));
    if (found.length !== new Set(ids).size)
      throw unprocessable('invalid_surveys', "Some of those surveys don't exist.");
  }

  async function loadWebhook(tx: Tx, id: string): Promise<WebhookRow> {
    if (!UUID.test(id)) throw notFound('Webhook');
    const [row] = await tx.db.select().from(webhooks).where(eq(webhooks.id, id));
    if (!row) throw notFound('Webhook');
    return row;
  }

  app.get('/api/v1/webhooks', async (req) => {
    const auth = requireOrg(req, 'org.update');
    return withTenant(pool, auth.orgId, async (tx) =>
      (await tx.db.select().from(webhooks).orderBy(asc(webhooks.createdAt))).map(toWebhook),
    );
  });

  app.post('/api/v1/webhooks', async (req, reply): Promise<CreatedWebhook> => {
    const auth = requireOrg(req, 'org.update');
    const body = parse(CreateWebhookRequest, req.body);
    checkUrl(body.url);
    const secret = newSecret();
    const row = await withTenant(pool, auth.orgId, async (tx) => {
      await checkSurveys(tx, body.surveyIds);
      const [created] = await tx.db
        .insert(webhooks)
        .values({
          id: newId(),
          orgId: auth.orgId,
          url: body.url,
          description: body.description || null,
          events: [...new Set(body.events)],
          surveyIds: body.surveyIds ? [...new Set(body.surveyIds)] : null,
          secretEnc: encryptSecret(config.encryptionKey, secret),
          createdBy: auth.userId,
        })
        .returning();
      await audit(tx, {
        orgId: auth.orgId,
        actorId: auth.userId,
        action: 'webhook.created',
        entityType: 'webhook',
        entityId: created!.id,
        metadata: { url: body.url, events: created!.events },
        ip: req.ip,
      });
      return created!;
    });
    reply.code(201);
    return { ...toWebhook(row), secret };
  });

  app.get<IdParams>('/api/v1/webhooks/:id', async (req) => {
    const auth = requireOrg(req, 'org.update');
    return withTenant(pool, auth.orgId, async (tx) => toWebhook(await loadWebhook(tx, req.params.id)));
  });

  app.patch<IdParams>('/api/v1/webhooks/:id', async (req) => {
    const auth = requireOrg(req, 'org.update');
    const body = parse(UpdateWebhookRequest, req.body);
    if (body.url) checkUrl(body.url);
    return withTenant(pool, auth.orgId, async (tx) => {
      const hook = await loadWebhook(tx, req.params.id);
      await checkSurveys(tx, body.surveyIds);
      const reenabled = body.active === true && !hook.active;
      const [updated] = await tx.db
        .update(webhooks)
        .set({
          ...(body.url !== undefined ? { url: body.url } : {}),
          ...(body.description !== undefined ? { description: body.description || null } : {}),
          ...(body.events !== undefined ? { events: [...new Set(body.events)] } : {}),
          ...(body.surveyIds !== undefined
            ? { surveyIds: body.surveyIds ? [...new Set(body.surveyIds)] : null }
            : {}),
          ...(body.active !== undefined ? { active: body.active } : {}),
          // Turning an endpoint back on starts its failure count again.
          ...(reenabled ? { consecutiveFailures: 0, disabledReason: null } : {}),
          updatedAt: new Date(),
        })
        .where(eq(webhooks.id, hook.id))
        .returning();
      await audit(tx, {
        orgId: auth.orgId,
        actorId: auth.userId,
        action: 'webhook.updated',
        entityType: 'webhook',
        entityId: hook.id,
        metadata: { fields: Object.keys(body) },
        ip: req.ip,
      });
      return toWebhook(updated!);
    });
  });

  app.delete<IdParams>('/api/v1/webhooks/:id', async (req, reply) => {
    const auth = requireOrg(req, 'org.update');
    await withTenant(pool, auth.orgId, async (tx) => {
      const hook = await loadWebhook(tx, req.params.id);
      await tx.db.delete(webhooks).where(eq(webhooks.id, hook.id));
      await audit(tx, {
        orgId: auth.orgId,
        actorId: auth.userId,
        action: 'webhook.deleted',
        entityType: 'webhook',
        entityId: hook.id,
        metadata: { url: hook.url },
        ip: req.ip,
      });
    });
    return reply.code(204).send();
  });

  /** A new secret. The old one keeps signing (as a second signature) for 24 hours. */
  app.post<IdParams>('/api/v1/webhooks/:id/rotate-secret', async (req) => {
    const auth = requireOrg(req, 'org.update');
    const secret = newSecret();
    await withTenant(pool, auth.orgId, async (tx) => {
      const hook = await loadWebhook(tx, req.params.id);
      await tx.db
        .update(webhooks)
        .set({
          secretEnc: encryptSecret(config.encryptionKey, secret),
          previousSecretEnc: hook.secretEnc,
          previousSecretExpiresAt: new Date(Date.now() + 24 * 3600 * 1000),
          updatedAt: new Date(),
        })
        .where(eq(webhooks.id, hook.id));
      await audit(tx, {
        orgId: auth.orgId,
        actorId: auth.userId,
        action: 'webhook.secret_rotated',
        entityType: 'webhook',
        entityId: hook.id,
        ip: req.ip,
      });
    });
    return { secret };
  });

  /** Send a `ping` event now and report what the endpoint answered. */
  app.post<IdParams>('/api/v1/webhooks/:id/test', async (req): Promise<WebhookTestResult> => {
    const auth = requireOrg(req, 'org.update');
    const deliveryId = await withTenant(pool, auth.orgId, async (tx) => {
      const hook = await loadWebhook(tx, req.params.id);
      const id = newId();
      const eventId = newEventId();
      await tx.db.insert(webhookDeliveries).values({
        id,
        orgId: auth.orgId,
        webhookId: hook.id,
        eventId,
        eventType: 'ping',
        payload: {
          id: eventId,
          type: 'ping',
          createdAt: new Date().toISOString(),
          data: { webhookId: hook.id },
        },
      });
      return id;
    });
    const result = await deliverWebhook(deps, { orgId: auth.orgId, deliveryId, manual: true });
    return {
      deliveryId,
      httpStatus: result?.httpStatus ?? null,
      durationMs: result?.durationMs ?? 0,
      error: result?.error ?? null,
    };
  });

  app.get<IdParams>('/api/v1/webhooks/:id/deliveries', async (req): Promise<PageResult<WebhookDelivery>> => {
    const auth = requireOrg(req, 'org.update');
    const query = parse(DeliveriesQuery, req.query);
    return withTenant(pool, auth.orgId, async (tx) => {
      const hook = await loadWebhook(tx, req.params.id);
      const conditions = [eq(webhookDeliveries.webhookId, hook.id)];
      if (query.status) conditions.push(eq(webhookDeliveries.status, query.status));
      const cursor = decodeCursor(query.cursor, 2);
      if (cursor)
        conditions.push(
          sql`(${webhookDeliveries.createdAt}, ${webhookDeliveries.id}) < (${cursor[0]}::timestamptz, ${cursor[1]}::uuid)`,
        );
      const rows = await tx.db
        .select()
        .from(webhookDeliveries)
        .where(and(...conditions))
        .orderBy(desc(webhookDeliveries.createdAt), desc(webhookDeliveries.id))
        .limit(query.limit + 1);
      const page = rows.slice(0, query.limit);
      const last = page.at(-1);
      return {
        data: page.map(toDelivery),
        nextCursor:
          rows.length > query.limit && last ? encodeCursor([last.createdAt.toISOString(), last.id]) : null,
      };
    });
  });

  async function loadDelivery(tx: Tx, webhookId: string, deliveryId: string): Promise<DeliveryRow> {
    if (!UUID.test(deliveryId)) throw notFound('Delivery');
    const [row] = await tx.db
      .select()
      .from(webhookDeliveries)
      .where(and(eq(webhookDeliveries.id, deliveryId), eq(webhookDeliveries.webhookId, webhookId)));
    if (!row) throw notFound('Delivery');
    return row;
  }

  app.get<DeliveryParams>(
    '/api/v1/webhooks/:id/deliveries/:deliveryId',
    async (req): Promise<WebhookDeliveryDetail> => {
      const auth = requireOrg(req, 'org.update');
      return withTenant(pool, auth.orgId, async (tx) => {
        const hook = await loadWebhook(tx, req.params.id);
        const delivery = await loadDelivery(tx, hook.id, req.params.deliveryId);
        const attempts = await tx.db
          .select()
          .from(webhookAttempts)
          .where(eq(webhookAttempts.deliveryId, delivery.id))
          .orderBy(asc(webhookAttempts.attempt));
        return {
          ...toDelivery(delivery),
          payload: delivery.payload,
          attemptLog: attempts.map((a) => ({
            attempt: a.attempt,
            manual: a.manual,
            httpStatus: a.httpStatus,
            error: a.error,
            durationMs: a.durationMs,
            responseSnippet: a.responseSnippet,
            createdAt: a.createdAt.toISOString(),
          })),
        };
      });
    },
  );

  /** One more attempt, now, with the same event id (receivers can drop duplicates). */
  app.post<DeliveryParams>('/api/v1/webhooks/:id/deliveries/:deliveryId/redeliver', async (req, reply) => {
    const auth = requireOrg(req, 'org.update');
    await withTenant(pool, auth.orgId, async (tx) => {
      const hook = await loadWebhook(tx, req.params.id);
      const delivery = await loadDelivery(tx, hook.id, req.params.deliveryId);
      if (delivery.status === 'pending')
        throw conflict('delivery_pending', 'This delivery is still being retried automatically.');
      await deps.jobs.enqueue(tx, 'webhooks.deliver', {
        orgId: auth.orgId,
        deliveryId: delivery.id,
        manual: true,
      });
      await audit(tx, {
        orgId: auth.orgId,
        actorId: auth.userId,
        action: 'webhook.redelivered',
        entityType: 'webhook',
        entityId: hook.id,
        metadata: { deliveryId: delivery.id, eventId: delivery.eventId },
        ip: req.ip,
      });
    });
    return reply.code(202).send({ queued: true });
  });
}
