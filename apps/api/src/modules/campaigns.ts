/**
 * Email campaigns (Phase 2B): create, schedule in the creator's time zone, send, cancel, follow
 * recipients. Plus the public unsubscribe endpoints and the SES bounce/complaint webhook.
 */
import { and, desc, eq, gt, inArray } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import {
  RecipientsQuery,
  SaveCampaignRequest,
  SendCampaignRequest,
  type Campaign,
  type CampaignRecipient,
} from '@survey/contracts';
import {
  campaigns,
  contactLists,
  contacts,
  distributions,
  newId,
  newToken,
  organizations,
  recipients,
  sha256,
  withGlobal,
  withTenant,
  type Tx,
} from '@survey/db';
import type { Deps } from '../deps';
import { audit } from '../audit';
import { requireOrg } from '../auth/context';
import { orgCan } from '../auth/permissions';
import { verifySnsMessage, isSnsUrl, type SnsMessage } from '../infra/sns';
import { campaignCounts } from '../jobs/campaigns';
import { RECIPIENT_TOKEN, unknownMergeTags } from '../lib/campaign-email';
import { conflict, forbidden, notFound, unprocessable } from '../lib/errors';
import { decodeCursor, encodeCursor, iso } from '../lib/misc';
import { rateLimit } from '../infra/rate-limit';
import { ipHash } from '../lib/security';
import { isValidTimeZone, localDateTimeToUtc } from '../lib/time';
import { parse } from '../lib/validate';
import { loadSurvey } from './surveys';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
type CampaignRow = typeof campaigns.$inferSelect;

async function toCampaigns(tx: Tx, rows: CampaignRow[]): Promise<Campaign[]> {
  const counts = await campaignCounts(tx, rows.map((r) => r.id));
  const listIds = [...new Set(rows.map((r) => r.listId).filter((id): id is string => Boolean(id)))];
  const lists = listIds.length ? await tx.db.select().from(contactLists).where(inArray(contactLists.id, listIds)) : [];
  return rows.map((c) => {
    const n = counts.get(c.id) ?? {};
    const list = lists.find((l) => l.id === c.listId);
    return {
      id: c.id,
      surveyId: c.surveyId,
      name: c.name,
      list: list ? { id: list.id, name: list.name } : null,
      subject: c.subject,
      body: c.body,
      status: c.status,
      scheduledAt: iso(c.scheduledAt),
      timezone: c.timezone,
      reminders: c.reminderAfterDays ? { afterDays: c.reminderAfterDays, max: c.reminderMax } : null,
      counts: {
        total: Object.values(n).reduce((a, b) => a + b, 0),
        pending: n.pending ?? 0,
        sent: n.sent ?? 0,
        responded: n.responded ?? 0,
        bounced: n.bounced ?? 0,
        failed: n.failed ?? 0,
        suppressed: n.suppressed ?? 0,
      },
      startedAt: iso(c.startedAt),
      finishedAt: iso(c.finishedAt),
      createdAt: c.createdAt.toISOString(),
    };
  });
}

const maskEmail = (email: string) => {
  const [user = '', domain = ''] = email.split('@');
  return `${user.slice(0, 1)}${'•'.repeat(Math.max(1, Math.min(6, user.length - 1)))}@${domain}`;
};

export function registerCampaignRoutes(app: FastifyInstance, deps: Deps): void {
  const { pool } = deps;

  async function loadCampaign(tx: Tx, auth: Parameters<typeof loadSurvey>[1], id: string, capability: Parameters<typeof loadSurvey>[3]) {
    if (!UUID.test(id)) throw notFound('Campaign');
    const [row] = await tx.db.select().from(campaigns).where(eq(campaigns.id, id));
    if (!row) throw notFound('Campaign');
    const { survey } = await loadSurvey(tx, auth, row.surveyId, capability);
    return { campaign: row, survey };
  }

  async function validateContent(tx: Tx, body: { subject: string; body: string; listId: string }) {
    const [list] = await tx.db.select({ id: contactLists.id }).from(contactLists).where(eq(contactLists.id, body.listId));
    if (!list) throw unprocessable('invalid_list', "That list doesn't exist.");
    const { rows } = await tx.client.query<{ key: string }>(`select distinct jsonb_object_keys(attributes) as key from contacts`);
    const unknown = unknownMergeTags(`${body.subject}\n${body.body}`, rows.map((r) => r.key));
    if (unknown.length)
      throw unprocessable('unknown_merge_tag', `Unknown merge tag${unknown.length > 1 ? 's' : ''}: ${unknown.map((t) => `{{${t}}}`).join(', ')}.`);
  }

  app.get<{ Params: { id: string } }>('/api/v1/surveys/:id/campaigns', async (req) => {
    const auth = requireOrg(req);
    return withTenant(pool, auth.orgId, async (tx) => {
      const { survey } = await loadSurvey(tx, auth, req.params.id, 'survey.view');
      const rows = await tx.db.select().from(campaigns).where(eq(campaigns.surveyId, survey.id)).orderBy(desc(campaigns.createdAt));
      return toCampaigns(tx, rows);
    });
  });

  app.post<{ Params: { id: string } }>('/api/v1/surveys/:id/campaigns', async (req, reply) => {
    const auth = requireOrg(req, 'contacts.manage');
    const body = parse(SaveCampaignRequest, req.body);
    const campaign = await withTenant(pool, auth.orgId, async (tx) => {
      const { survey } = await loadSurvey(tx, auth, req.params.id, 'survey.distribute');
      if (survey.isTemplate) throw conflict('template_not_publishable', "Templates can't be sent.");
      await validateContent(tx, body);
      // A dedicated link, so responses from the campaign can be told apart in results.
      const distributionId = newId();
      await tx.db.insert(distributions).values({
        id: distributionId,
        orgId: auth.orgId,
        surveyId: survey.id,
        channel: 'email',
        name: `Email: ${body.name}`.slice(0, 100),
        token: newToken(9),
        createdBy: auth.userId,
      });
      const id = newId();
      const [row] = await tx.db
        .insert(campaigns)
        .values({
          id,
          orgId: auth.orgId,
          surveyId: survey.id,
          distributionId,
          listId: body.listId,
          name: body.name,
          subject: body.subject,
          body: body.body,
          reminderAfterDays: body.reminders?.afterDays ?? null,
          reminderMax: body.reminders?.max ?? 0,
          createdBy: auth.userId,
        })
        .returning();
      await audit(tx, { orgId: auth.orgId, actorId: auth.userId, action: 'campaign.created', entityType: 'campaign', entityId: id, metadata: { surveyId: survey.id }, ip: req.ip });
      return (await toCampaigns(tx, [row!]))[0]!;
    });
    reply.code(201);
    return campaign;
  });

  app.get<{ Params: { id: string } }>('/api/v1/campaigns/:id', async (req) => {
    const auth = requireOrg(req);
    return withTenant(pool, auth.orgId, async (tx) => {
      const { campaign } = await loadCampaign(tx, auth, req.params.id, 'survey.view');
      return (await toCampaigns(tx, [campaign]))[0]!;
    });
  });

  app.patch<{ Params: { id: string } }>('/api/v1/campaigns/:id', async (req) => {
    const auth = requireOrg(req, 'contacts.manage');
    const body = parse(SaveCampaignRequest, req.body);
    return withTenant(pool, auth.orgId, async (tx) => {
      const { campaign } = await loadCampaign(tx, auth, req.params.id, 'survey.distribute');
      if (campaign.status !== 'draft' && campaign.status !== 'scheduled')
        throw conflict('campaign_locked', 'This campaign has already been sent and can no longer be edited.');
      await validateContent(tx, body);
      const [row] = await tx.db
        .update(campaigns)
        .set({
          name: body.name,
          listId: body.listId,
          subject: body.subject,
          body: body.body,
          reminderAfterDays: body.reminders?.afterDays ?? null,
          reminderMax: body.reminders?.max ?? 0,
          updatedAt: new Date(),
        })
        .where(eq(campaigns.id, campaign.id))
        .returning();
      return (await toCampaigns(tx, [row!]))[0]!;
    });
  });

  app.post<{ Params: { id: string } }>('/api/v1/campaigns/:id/send', async (req) => {
    const auth = requireOrg(req, 'contacts.manage');
    const body = parse(SendCampaignRequest, req.body ?? {});
    if (!isValidTimeZone(body.timezone)) throw unprocessable('invalid_timezone', 'Choose a valid time zone.');
    const at = body.scheduledAt ? localDateTimeToUtc(body.scheduledAt, body.timezone) : new Date();
    if (body.scheduledAt && at.getTime() < Date.now() - 60_000) throw unprocessable('in_the_past', 'Choose a time in the future.');
    return withTenant(pool, auth.orgId, async (tx) => {
      const { campaign, survey } = await loadCampaign(tx, auth, req.params.id, 'survey.distribute');
      if (campaign.status !== 'draft' && campaign.status !== 'scheduled')
        throw conflict('campaign_locked', 'This campaign has already been sent.');
      if (survey.status !== 'live') throw conflict('survey_not_live', 'Publish the survey (and keep it open) before sending invitations.');
      const { rows } = await tx.client.query<{ n: number }>(`select count(*)::int as n from contact_list_members where list_id = $1`, [campaign.listId]);
      if (!rows[0]!.n) throw unprocessable('empty_list', 'The list has no contacts.');
      const [row] = await tx.db
        .update(campaigns)
        .set({ status: 'scheduled', scheduledAt: at, timezone: body.timezone, updatedAt: new Date() })
        .where(eq(campaigns.id, campaign.id))
        .returning();
      await deps.jobs.enqueue(tx, 'campaigns.start', { orgId: auth.orgId, campaignId: campaign.id, scheduledAt: at.toISOString() }, { startAfter: at });
      await audit(tx, {
        orgId: auth.orgId,
        actorId: auth.userId,
        action: body.scheduledAt ? 'campaign.scheduled' : 'campaign.send_requested',
        entityType: 'campaign',
        entityId: campaign.id,
        metadata: { scheduledAt: at.toISOString(), timezone: body.timezone },
        ip: req.ip,
      });
      return (await toCampaigns(tx, [row!]))[0]!;
    });
  });

  app.post<{ Params: { id: string } }>('/api/v1/campaigns/:id/cancel', async (req) => {
    const auth = requireOrg(req, 'contacts.manage');
    return withTenant(pool, auth.orgId, async (tx) => {
      const { campaign } = await loadCampaign(tx, auth, req.params.id, 'survey.distribute');
      if (!['draft', 'scheduled', 'sending'].includes(campaign.status)) throw conflict('campaign_locked', 'This campaign has already finished.');
      const [row] = await tx.db
        .update(campaigns)
        .set({ status: 'cancelled', finishedAt: new Date(), updatedAt: new Date() })
        .where(eq(campaigns.id, campaign.id))
        .returning();
      await audit(tx, { orgId: auth.orgId, actorId: auth.userId, action: 'campaign.cancelled', entityType: 'campaign', entityId: campaign.id, ip: req.ip });
      return (await toCampaigns(tx, [row!]))[0]!;
    });
  });

  app.delete<{ Params: { id: string } }>('/api/v1/campaigns/:id', async (req, reply) => {
    const auth = requireOrg(req, 'contacts.manage');
    await withTenant(pool, auth.orgId, async (tx) => {
      const { campaign } = await loadCampaign(tx, auth, req.params.id, 'survey.distribute');
      if (campaign.status !== 'draft') throw conflict('campaign_locked', 'Only draft campaigns can be deleted. Cancel it instead.');
      await tx.db.delete(campaigns).where(eq(campaigns.id, campaign.id));
      if (campaign.distributionId) await tx.db.delete(distributions).where(eq(distributions.id, campaign.distributionId));
    });
    return reply.code(204).send();
  });

  app.get<{ Params: { id: string } }>('/api/v1/campaigns/:id/recipients', async (req) => {
    const auth = requireOrg(req);
    if (!orgCan(auth.orgRole, 'contacts.manage')) throw forbidden('Only admins and creators can see recipients.');
    const query = parse(RecipientsQuery, req.query);
    const cursor = decodeCursor(query.cursor, 1);
    return withTenant(pool, auth.orgId, async (tx) => {
      const { campaign } = await loadCampaign(tx, auth, req.params.id, 'survey.view');
      const rows = await tx.db
        .select({ r: recipients, email: contacts.email, first: contacts.firstName, last: contacts.lastName })
        .from(recipients)
        .innerJoin(contacts, eq(contacts.id, recipients.contactId))
        .where(
          and(
            eq(recipients.campaignId, campaign.id),
            query.status ? eq(recipients.status, query.status) : undefined,
            cursor ? gt(recipients.id, String(cursor[0])) : undefined,
          ),
        )
        .orderBy(recipients.id)
        .limit(query.limit + 1);
      const page = rows.slice(0, query.limit);
      return {
        data: page.map(
          ({ r, email, first, last }): CampaignRecipient => ({
            id: r.id,
            email,
            name: [first, last].filter(Boolean).join(' '),
            status: r.status,
            sentAt: iso(r.sentAt),
            remindersSent: r.remindersSent,
            respondedAt: iso(r.respondedAt),
            error: r.error,
          }),
        ),
        nextCursor: rows.length > query.limit ? encodeCursor([page.at(-1)!.r.id]) : null,
      };
    });
  });

  // ── Unsubscribe (public, no login: the personal token is the credential) ───
  async function resolveToken(token: string) {
    if (!RECIPIENT_TOKEN.test(token)) throw notFound('Link');
    const { rows } = await withGlobal(pool, (tx) =>
      tx.client.query<{ org_id: string; contact_id: string }>('select * from resolve_recipient($1)', [sha256(token)]),
    );
    if (!rows[0]) throw notFound('Link');
    return rows[0];
  }

  app.get<{ Params: { token: string } }>('/r/v1/unsubscribe/:token', async (req, reply) => {
    reply.header('cache-control', 'no-store');
    const { org_id: orgId, contact_id: contactId } = await resolveToken(req.params.token);
    return withTenant(pool, orgId, async (tx) => {
      const [row] = await tx.db
        .select({ c: contacts, orgName: organizations.name })
        .from(contacts)
        .innerJoin(organizations, eq(organizations.id, contacts.orgId))
        .where(eq(contacts.id, contactId));
      if (!row) throw notFound('Link');
      return { orgName: row.orgName, email: maskEmail(row.c.email), unsubscribed: Boolean(row.c.unsubscribedAt) };
    });
  });

  // These two routes accept other bodies than JSON, so their parsers are scoped to them (the rest of
  // the API stays JSON-only): one-click unsubscribe posts a form, and SNS posts JSON as text/plain.
  void app.register(async (scope) => {
    scope.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'string', bodyLimit: 1024 }, (_req, body, done) => done(null, body));
    scope.addContentTypeParser('text/plain', { parseAs: 'string', bodyLimit: 256 * 1024 }, (_req, body, done) => done(null, body));
    // Also the RFC 8058 one-click target (mail clients POST "List-Unsubscribe=One-Click").
      scope.post<{ Params: { token: string } }>('/r/v1/unsubscribe/:token', async (req) => {
      await rateLimit(deps.redis, `unsub:${ipHash(deps.config.sessionSecret, req.ip)}`, 30, 3600);
      const { org_id: orgId, contact_id: contactId } = await resolveToken(req.params.token);
      await withTenant(pool, orgId, async (tx) => {
        const [row] = await tx.db
          .update(contacts)
          .set({ unsubscribedAt: new Date(), updatedAt: new Date() })
          .where(and(eq(contacts.id, contactId)))
          .returning({ id: contacts.id, already: contacts.unsubscribedAt });
        if (!row) throw notFound('Link');
        // Invitations still queued in any campaign are dropped.
        await tx.db
          .update(recipients)
          .set({ status: 'suppressed' })
          .where(and(eq(recipients.contactId, contactId), eq(recipients.status, 'pending')));
        await audit(tx, { orgId, actorId: null, action: 'contact.unsubscribed', entityType: 'contact', entityId: contactId });
      });
      return { unsubscribed: true };
    });

    // ── SES bounce and complaint notifications (via SNS) ──────────────────────
      scope.post('/api/v1/webhooks/ses', async (req, reply) => {
      if (!deps.config.sesTopicArns.length) throw notFound();
      let message: SnsMessage;
      try {
        message = (typeof req.body === 'string' ? JSON.parse(req.body) : req.body) as SnsMessage;
      } catch {
        throw unprocessable('invalid_message', 'Not an SNS message.');
      }
      if (!message || typeof message !== 'object' || !deps.config.sesTopicArns.includes(message.TopicArn))
        throw forbidden('Unknown topic.');
      if (!(await verifySnsMessage(message, deps.sns).catch(() => false))) throw forbidden('Invalid signature.');

      if (message.Type === 'SubscriptionConfirmation') {
        if (message.SubscribeURL && isSnsUrl(message.SubscribeURL)) await deps.sns.confirm(message.SubscribeURL);
        return reply.code(200).send({ confirmed: true });
      }
      if (message.Type !== 'Notification') return { ignored: true };
      let payload: {
        notificationType?: string;
        bounce?: { bounceType?: string; bouncedRecipients?: { emailAddress: string; diagnosticCode?: string }[] };
        complaint?: { complainedRecipients?: { emailAddress: string }[] };
      };
      try {
        payload = JSON.parse(message.Message);
      } catch {
        return { ignored: true };
      }
      const suppress: { email: string; reason: 'bounce' | 'complaint'; detail: string | null }[] = [];
      if (payload.notificationType === 'Bounce' && payload.bounce?.bounceType === 'Permanent')
        for (const r of payload.bounce.bouncedRecipients ?? [])
          suppress.push({ email: r.emailAddress, reason: 'bounce', detail: r.diagnosticCode?.slice(0, 300) ?? null });
      if (payload.notificationType === 'Complaint')
        for (const r of payload.complaint?.complainedRecipients ?? []) suppress.push({ email: r.emailAddress, reason: 'complaint', detail: null });
      if (suppress.length)
        await withGlobal(pool, async (tx) => {
          for (const s of suppress)
            await tx.client.query('select record_email_suppression($1, $2, $3)', [s.email.toLowerCase().slice(0, 254), s.reason, s.detail]);
        });
      return { recorded: suppress.length };
    });
  });
}
