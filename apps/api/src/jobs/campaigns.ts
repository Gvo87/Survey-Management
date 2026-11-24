/**
 * Campaign sending (Phase 2B).
 *
 * - start: snapshots the list into recipients (suppressed addresses are recorded, never emailed).
 * - send: claims a batch of pending recipients, then emails them. Claim-then-send means a crash can
 *   lose an email but never send one twice. Respects a per-org daily limit; re-queues itself until done.
 * - reminders: every 15 minutes, emails recipients who haven't responded, up to the campaign's maximum.
 */
import { eq, inArray, sql } from 'drizzle-orm';
import { campaigns, distributions, newId, organizations, recipients, surveys, withGlobal, withTenant, type Tx } from '@survey/db';
import { recordUsage } from '../lib/usage';
import type { Deps } from '../deps';
import { audit } from '../audit';
import { recipientToken, recipientTokenHash, renderCampaignEmail } from '../lib/campaign-email';

const BATCH = 50;

interface Claimed {
  id: string;
  email: string;
  first_name: string | null;
  last_name: string | null;
  attributes: Record<string, string>;
}

async function context(tx: Tx, campaignId: string) {
  const [row] = await tx.db
    .select({ c: campaigns, survey: surveys, orgName: organizations.name, distToken: distributions.token })
    .from(campaigns)
    .innerJoin(surveys, eq(surveys.id, campaigns.surveyId))
    .innerJoin(organizations, eq(organizations.id, campaigns.orgId))
    .leftJoin(distributions, eq(distributions.id, campaigns.distributionId))
    .where(eq(campaigns.id, campaignId));
  return row;
}

async function deliver(deps: Deps, ctx: NonNullable<Awaited<ReturnType<typeof context>>>, people: Claimed[], reminder: boolean) {
  const failures: { id: string; error: string }[] = [];
  for (const person of people) {
    const token = recipientToken(deps.config.sessionSecret, person.id);
    const base = deps.config.respondentUrl;
    const link = `${base}/s/${ctx.survey.publicId}?${ctx.distToken ? `d=${ctx.distToken}&` : ''}t=${token}`;
    const message = renderCampaignEmail(
      ctx.c,
      {
        contact: { email: person.email, firstName: person.first_name, lastName: person.last_name, attributes: person.attributes ?? {} },
        survey: { title: ctx.survey.title, link },
        org: { name: ctx.orgName },
      },
      { unsubscribe: `${base}/u/${token}`, oneClickUnsubscribe: `${base}/r/v1/unsubscribe/${token}` },
      reminder,
    );
    try {
      await deps.mailer.send({ to: person.email, ...message });
    } catch (error) {
      failures.push({ id: person.id, error: (error instanceof Error ? error.message : 'Send failed').slice(0, 300) });
    }
  }
  return failures;
}

/** Emails sent by this org in the last 24 hours (first sends and reminders). */
async function sentToday(tx: Tx): Promise<number> {
  const { rows } = await tx.client.query<{ n: number }>(
    `select count(*)::int as n from recipients where last_sent_at > now() - interval '1 day'`,
  );
  return rows[0]!.n;
}

export function campaignJobs(deps: Deps) {
  const { pool, jobs } = deps;

  return {
    'campaigns.start': async ({ orgId, campaignId, scheduledAt }: { orgId: string; campaignId: string; scheduledAt: string }) => {
      await withTenant(pool, orgId, async (tx) => {
        const [c] = await tx.db.select().from(campaigns).where(eq(campaigns.id, campaignId)).for('update');
        if (!c || c.status !== 'scheduled' || c.scheduledAt?.toISOString() !== scheduledAt) return; // rescheduled or cancelled
        const [survey] = await tx.db.select().from(surveys).where(eq(surveys.id, c.surveyId));
        if (!survey || survey.status !== 'live' || survey.deletedAt) {
          await tx.db.update(campaigns).set({ status: 'cancelled', finishedAt: new Date(), updatedAt: new Date() }).where(eq(campaigns.id, c.id));
          await audit(tx, { orgId, actorId: null, action: 'campaign.cancelled', entityType: 'campaign', entityId: c.id, metadata: { reason: 'survey_not_live' } });
          return;
        }
        const members = c.listId
          ? (
              await tx.client.query<{ contact_id: string; suppressed: boolean }>(
                `select m.contact_id,
                        (k.unsubscribed_at is not null or k.bounced_at is not null or k.complained_at is not null
                          or exists (select 1 from email_suppressions s where s.email = k.email)) as suppressed
                   from contact_list_members m join contacts k on k.id = m.contact_id
                  where m.list_id = $1`,
                [c.listId],
              )
            ).rows
          : [];
        const rows = members.map((m) => {
          const id = newId();
          return {
            id,
            org_id: orgId,
            campaign_id: c.id,
            contact_id: m.contact_id,
            token_hash: recipientTokenHash(deps.config.sessionSecret, id).toString('hex'),
            status: m.suppressed ? 'suppressed' : 'pending',
          };
        });
        for (let i = 0; i < rows.length; i += 1000)
          await tx.client.query(
            `insert into recipients (id, org_id, campaign_id, contact_id, token_hash, status)
             select x.id, x.org_id, x.campaign_id, x.contact_id, decode(x.token_hash, 'hex'), x.status
               from jsonb_to_recordset($1::jsonb) as x(id uuid, org_id uuid, campaign_id uuid, contact_id uuid, token_hash text, status text)
             on conflict (campaign_id, contact_id) do nothing`,
            [JSON.stringify(rows.slice(i, i + 1000))],
          );
        await tx.db.update(campaigns).set({ status: 'sending', startedAt: new Date(), updatedAt: new Date() }).where(eq(campaigns.id, c.id));
        await audit(tx, { orgId, actorId: null, action: 'campaign.started', entityType: 'campaign', entityId: c.id, metadata: { recipients: rows.length } });
        await jobs.enqueue(tx, 'campaigns.send', { orgId, campaignId: c.id });
      });
    },

    'campaigns.send': async ({ orgId, campaignId }: { orgId: string; campaignId: string }) => {
      const claimed = await withTenant(pool, orgId, async (tx) => {
        const ctx = await context(tx, campaignId);
        if (!ctx || ctx.c.status !== 'sending') return null;
        const room = deps.config.emailsPerOrgPerDay - (await sentToday(tx));
        if (room <= 0) {
          await audit(tx, { orgId, actorId: null, action: 'campaign.throttled', entityType: 'campaign', entityId: campaignId });
          await jobs.enqueue(tx, 'campaigns.send', { orgId, campaignId }, { startAfter: new Date(Date.now() + 3600 * 1000) });
          return null;
        }
        const { rows } = await tx.client.query<Claimed>(
          `update recipients r set status = 'sent', sent_at = now(), last_sent_at = now()
             from contacts k
            where k.id = r.contact_id
              and r.id in (select id from recipients where campaign_id = $1 and status = 'pending' order by id limit $2 for update skip locked)
           returning r.id, k.email, k.first_name, k.last_name, k.attributes`,
          [campaignId, Math.min(BATCH, room)],
        );
        if (!rows.length) {
          await tx.db.update(campaigns).set({ status: 'sent', finishedAt: new Date(), updatedAt: new Date() }).where(eq(campaigns.id, campaignId));
          await audit(tx, { orgId, actorId: null, action: 'campaign.sent', entityType: 'campaign', entityId: campaignId });
          return null;
        }
        return { ctx, rows };
      });
      if (!claimed) return;
      const failures = await deliver(deps, claimed.ctx, claimed.rows, false);
      await withTenant(pool, orgId, async (tx) => {
        for (const f of failures) await tx.db.update(recipients).set({ status: 'failed', error: f.error }).where(eq(recipients.id, f.id));
        await recordUsage(tx, orgId, 'emails_sent', claimed.rows.length - failures.length);
        await jobs.enqueue(tx, 'campaigns.send', { orgId, campaignId });
      });
    },

    'campaigns.reminders': async () => {
      const { rows: due } = await withGlobal(pool, (tx) =>
        tx.client.query<{ org_id: string; campaign_id: string }>('select * from campaigns_needing_reminders()'),
      );
      for (const { org_id: orgId, campaign_id: campaignId } of due) {
        const claimed = await withTenant(pool, orgId, async (tx) => {
          const ctx = await context(tx, campaignId);
          if (!ctx || ctx.c.status !== 'sent' || ctx.survey.status !== 'live' || !ctx.c.reminderAfterDays) return null;
          const room = deps.config.emailsPerOrgPerDay - (await sentToday(tx));
          if (room <= 0) return null;
          // Recipients who unsubscribed or bounced since the first email are dropped, not reminded.
          await tx.client.query(
            `update recipients r set status = case when k.bounced_at is not null then 'bounced' else 'suppressed' end
               from contacts k
              where k.id = r.contact_id and r.campaign_id = $1 and r.status = 'sent'
                and (k.unsubscribed_at is not null or k.bounced_at is not null or k.complained_at is not null
                     or exists (select 1 from email_suppressions s where s.email = k.email))`,
            [campaignId],
          );
          const { rows } = await tx.client.query<Claimed>(
            `update recipients r set reminders_sent = r.reminders_sent + 1, last_sent_at = now()
               from contacts k
              where k.id = r.contact_id
                and r.id in (select id from recipients
                              where campaign_id = $1 and status = 'sent' and reminders_sent < $2
                                and last_sent_at <= now() - make_interval(days => $3)
                              order by id limit $4 for update skip locked)
             returning r.id, k.email, k.first_name, k.last_name, k.attributes`,
            [campaignId, ctx.c.reminderMax, ctx.c.reminderAfterDays, Math.min(500, room)],
          );
          return rows.length ? { ctx, rows } : null;
        });
        if (!claimed) continue;
        const failures = await deliver(deps, claimed.ctx, claimed.rows, true);
        await withTenant(pool, orgId, async (tx) => {
          for (const f of failures) await tx.db.update(recipients).set({ error: f.error }).where(eq(recipients.id, f.id));
          await recordUsage(tx, orgId, 'emails_sent', claimed.rows.length - failures.length);
        });
      }
    },
  };
}

/** Recipient counts by status, for the campaign list and detail. */
export async function campaignCounts(tx: Tx, campaignIds: string[]) {
  if (!campaignIds.length) return new Map<string, Record<string, number>>();
  const rows = await tx.db
    .select({ campaignId: recipients.campaignId, status: recipients.status, n: sql<number>`count(*)::int` })
    .from(recipients)
    .where(inArray(recipients.campaignId, campaignIds))
    .groupBy(recipients.campaignId, recipients.status);
  const map = new Map<string, Record<string, number>>();
  for (const r of rows) {
    const m = map.get(r.campaignId) ?? {};
    m[r.status] = r.n;
    map.set(r.campaignId, m);
  }
  return map;
}

