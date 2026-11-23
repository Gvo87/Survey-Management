/**
 * Event fan-out and webhook delivery (Phase 3A, docs/03-api-design.md §3.8).
 *
 * `events.dispatch` builds the payload once, records one delivery per matching webhook (unique per
 * webhook and event, so a retried job adds nothing) and queues each delivery. `webhooks.deliver`
 * signs and POSTs it, records the attempt, and schedules the next retry after 1 m, 5 m, 30 m, 2 h, 6 h,
 * 12 h and 24 h. A delivery that fails all eight attempts counts against its endpoint; 50 such events in
 * a row disable the endpoint and notify the org admins.
 */
import { and, eq, sql } from 'drizzle-orm';
import { displayAnswer, plainTitle } from '@survey/core';
import {
  distributions,
  newId,
  responses,
  surveys,
  surveyVersions,
  webhookAttempts,
  webhookDeliveries,
  webhooks,
  withTenant,
  type Tx,
} from '@survey/db';
import type { Deps } from '../deps';
import type { DomainEvent } from '../events';
import { decryptSecret, webhookSignature } from '../lib/crypto';
import { postJson } from '../lib/outbound';
import { answerValues, loadCells } from '../modules/results';
import { evaluateNotificationRules, notifyUsers, orgAdmins } from './notifications';

/** Seconds before each retry. The first attempt is immediate, so there are 8 attempts in all. */
export const RETRY_DELAYS_SEC = [60, 300, 1800, 7200, 21_600, 43_200, 86_400];
export const AUTO_DISABLE_AFTER = 50;

/** The `data` of an event's webhook payload. Only what the database stores is ever sent. */
async function eventData(deps: Deps, tx: Tx, event: DomainEvent): Promise<Record<string, unknown> | null> {
  const [survey] = await tx.db.select().from(surveys).where(eq(surveys.id, event.surveyId));
  if (!survey) return null;
  if (event.type === 'survey.published') {
    const [version] = event.versionId
      ? await tx.db.select().from(surveyVersions).where(eq(surveyVersions.id, event.versionId))
      : [];
    return {
      surveyId: survey.id,
      title: survey.title,
      versionNumber: version?.versionNumber ?? null,
      publishedAt: version?.publishedAt?.toISOString() ?? event.occurredAt,
      publicUrl: `${deps.config.respondentUrl}/s/${survey.publicId}`,
    };
  }
  if (event.type === 'survey.closed') {
    return {
      surveyId: survey.id,
      title: survey.title,
      reason: event.reason ?? null,
      closedAt: event.occurredAt,
    };
  }
  if (!event.responseId) return null;
  const [row] = await tx.db
    .select({
      r: responses,
      versionNumber: surveyVersions.versionNumber,
      definition: surveyVersions.definition,
      distribution: distributions.name,
    })
    .from(responses)
    .innerJoin(surveyVersions, eq(surveyVersions.id, responses.versionId))
    .leftJoin(distributions, eq(distributions.id, responses.distributionId))
    .where(eq(responses.id, event.responseId));
  if (!row) return null;
  const cells = (await loadCells(tx, survey.id, [row.r.id])).get(row.r.id) ?? [];
  return {
    surveyId: survey.id,
    responseId: row.r.id,
    status: row.r.status,
    versionNumber: row.versionNumber,
    completedAt: row.r.completedAt?.toISOString() ?? null,
    distribution: row.distribution,
    hiddenFields: row.r.hiddenFields,
    answers: answerValues(row.definition, cells).map(({ question, value }) => ({
      questionKey: question.key,
      title: plainTitle(question),
      type: question.type,
      value,
      display: displayAnswer(question, value),
    })),
  };
}

export async function dispatchEvent(deps: Deps, event: DomainEvent): Promise<void> {
  await withTenant(deps.pool, event.orgId, async (tx) => {
    const targets = await tx.db
      .select({ id: webhooks.id })
      .from(webhooks)
      .where(
        and(
          eq(webhooks.active, true),
          sql`${event.type} = any(${webhooks.events})`,
          sql`(${webhooks.surveyIds} is null or ${event.surveyId}::uuid = any(${webhooks.surveyIds}))`,
        ),
      );
    if (targets.length === 0) return;
    const data = await eventData(deps, tx, event);
    if (!data) return;
    const payload = { id: event.id, type: event.type, createdAt: event.occurredAt, data };
    for (const target of targets) {
      const [delivery] = await tx.db
        .insert(webhookDeliveries)
        .values({
          id: newId(),
          orgId: event.orgId,
          webhookId: target.id,
          eventId: event.id,
          eventType: event.type,
          payload,
          nextAttemptAt: new Date(),
        })
        .onConflictDoNothing()
        .returning({ id: webhookDeliveries.id });
      if (delivery)
        await deps.jobs.enqueue(tx, 'webhooks.deliver', { orgId: event.orgId, deliveryId: delivery.id });
    }
  });
  await evaluateNotificationRules(deps, event);
}

/** Signature header: one `v1=` value per valid secret (two for 24 hours after a rotation). */
function signatureHeader(
  deps: Deps,
  hook: typeof webhooks.$inferSelect,
  timestamp: number,
  body: string,
): string {
  const secrets = [decryptSecret(deps.config.encryptionKey, hook.secretEnc)];
  if (
    hook.previousSecretEnc &&
    hook.previousSecretExpiresAt &&
    hook.previousSecretExpiresAt.getTime() > Date.now()
  )
    secrets.push(decryptSecret(deps.config.encryptionKey, hook.previousSecretEnc));
  return secrets.map((s) => `v1=${webhookSignature(s, timestamp, body)}`).join(' ');
}

export interface AttemptResult {
  httpStatus: number | null;
  durationMs: number;
  error: string | null;
}

/** Make one attempt at a delivery and record it. Scheduled attempts also schedule the next retry. */
export async function deliverWebhook(
  deps: Deps,
  job: { orgId: string; deliveryId: string; manual?: boolean },
): Promise<AttemptResult | null> {
  const [loaded] = await withTenant(deps.pool, job.orgId, (tx) =>
    tx.db
      .select({ d: webhookDeliveries, w: webhooks })
      .from(webhookDeliveries)
      .innerJoin(webhooks, eq(webhooks.id, webhookDeliveries.webhookId))
      .where(eq(webhookDeliveries.id, job.deliveryId)),
  );
  if (!loaded) return null;
  const { d: delivery, w: hook } = loaded;
  if (!job.manual && (delivery.status !== 'pending' || !hook.active)) return null;

  const body = JSON.stringify(delivery.payload);
  const timestamp = Math.floor(Date.now() / 1000);
  const started = Date.now();
  let result: AttemptResult;
  let snippet: string | null = null;
  try {
    const res = await postJson(hook.url, body, {
      allowPrivate: deps.config.allowPrivateUrls,
      headers: {
        'survey-webhook-id': delivery.eventId,
        'survey-webhook-event': delivery.eventType,
        'survey-webhook-timestamp': String(timestamp),
        'survey-webhook-signature': signatureHeader(deps, hook, timestamp, body),
      },
    });
    const ok = res.status >= 200 && res.status < 300;
    result = { httpStatus: res.status, durationMs: res.durationMs, error: ok ? null : `HTTP ${res.status}` };
    snippet = res.body.slice(0, 500) || null;
  } catch (error) {
    result = {
      httpStatus: null,
      durationMs: Date.now() - started,
      error: (error as Error).message.slice(0, 300),
    };
  }
  const succeeded = result.error === null;

  await withTenant(deps.pool, job.orgId, async (tx) => {
    const [current] = await tx.db
      .select()
      .from(webhookDeliveries)
      .where(eq(webhookDeliveries.id, delivery.id))
      .for('update');
    if (!current) return;
    const attempt = current.attempts + 1;
    await tx.db.insert(webhookAttempts).values({
      orgId: job.orgId,
      deliveryId: delivery.id,
      attempt,
      manual: Boolean(job.manual),
      httpStatus: result.httpStatus,
      error: result.error,
      durationMs: result.durationMs,
      responseSnippet: snippet,
    });
    const now = new Date();
    if (succeeded) {
      await tx.db
        .update(webhookDeliveries)
        .set({
          status: 'succeeded',
          attempts: attempt,
          lastHttpStatus: result.httpStatus,
          nextAttemptAt: null,
          finishedAt: now,
        })
        .where(eq(webhookDeliveries.id, delivery.id));
      await tx.db.update(webhooks).set({ consecutiveFailures: 0 }).where(eq(webhooks.id, hook.id));
      return;
    }
    // A test or redelivery is one attempt: it never schedules retries or counts toward disabling.
    // Scheduled deliveries only ever have scheduled attempts, so `attempts` is the retries used so far.
    if (!job.manual && current.attempts < RETRY_DELAYS_SEC.length) {
      const next = new Date(now.getTime() + RETRY_DELAYS_SEC[current.attempts]! * 1000);
      await tx.db
        .update(webhookDeliveries)
        .set({ attempts: attempt, lastHttpStatus: result.httpStatus, nextAttemptAt: next })
        .where(eq(webhookDeliveries.id, delivery.id));
      await deps.jobs.enqueue(
        tx,
        'webhooks.deliver',
        { orgId: job.orgId, deliveryId: delivery.id },
        { startAfter: next },
      );
      return;
    }
    const wasPending = current.status === 'pending';
    await tx.db
      .update(webhookDeliveries)
      .set({
        status: 'failed',
        attempts: attempt,
        lastHttpStatus: result.httpStatus,
        nextAttemptAt: null,
        finishedAt: now,
      })
      .where(eq(webhookDeliveries.id, delivery.id));
    if (job.manual || !wasPending) return;
    const [updated] = await tx.db
      .update(webhooks)
      .set({ consecutiveFailures: sql`${webhooks.consecutiveFailures} + 1` })
      .where(eq(webhooks.id, hook.id))
      .returning();
    if (updated && updated.active && updated.consecutiveFailures >= AUTO_DISABLE_AFTER) {
      await tx.db
        .update(webhooks)
        .set({
          active: false,
          disabledReason: `Disabled automatically after ${AUTO_DISABLE_AFTER} events in a row failed every attempt.`,
          updatedAt: now,
        })
        .where(eq(webhooks.id, hook.id));
      await notifyUsers(deps, tx, {
        orgId: job.orgId,
        userIds: await orgAdmins(tx),
        kind: 'webhook_disabled',
        title: 'A webhook endpoint was disabled',
        body: `${hook.url} failed for ${AUTO_DISABLE_AFTER} events in a row, so we stopped sending to it. Fix the endpoint, then turn it back on.`,
        link: '/settings/api',
        channels: ['in_app', 'email'],
      });
    }
  });
  return result;
}
