import { and, eq, isNull, lt, or } from 'drizzle-orm';
import {
  aggregateResponse,
  authTokens,
  files,
  invitations,
  newToken,
  organizations,
  rebuildSurveyAggregates,
  sessions,
  sha256,
  users,
  withGlobal,
  withTenant,
  type QueueName,
} from '@survey/db';
import type { Deps } from '../deps';
import { audit } from '../audit';
import type { EmailJob, JobPayloads } from '../infra/jobs';
import { campaignJobs } from './campaigns';
import { publishLiveEvent } from '../modules/live';
import { importContacts } from './import-contacts';
import { exportJobs } from './exports';

export type JobHandlers = { [Q in QueueName]: (data: JobPayloads[Q]) => Promise<void> };

const HOUR = 3600 * 1000;

/**
 * Email jobs carry only IDs. The worker generates the secret token when it sends the email,
 * so raw tokens never sit in the job table.
 */
async function sendEmail(deps: Deps, job: EmailJob): Promise<void> {
  const { appUrl } = deps.config;

  if (job.type === 'verify_email' || job.type === 'password_reset') {
    const message = await withGlobal(deps.pool, async (tx) => {
      const [user] = await tx.db.select().from(users).where(eq(users.id, job.userId));
      if (!user || user.disabledAt) return null;
      if (job.type === 'verify_email' && user.emailVerifiedAt) return null;
      const token = newToken();
      const isReset = job.type === 'password_reset';
      await tx.db.insert(authTokens).values({
        tokenHash: sha256(token),
        userId: user.id,
        purpose: isReset ? 'password_reset' : 'email_verify',
        expiresAt: new Date(Date.now() + (isReset ? 1 : 48) * HOUR),
      });
      return isReset
        ? {
            to: user.email,
            subject: 'Reset your password',
            text: `Hi ${user.name},\n\nSomeone asked to reset the password for your account. If it was you, open this link within 1 hour:\n\n${appUrl}/reset-password?token=${token}\n\nIf it wasn't you, ignore this email: your password hasn't changed.\n`,
          }
        : {
            to: user.email,
            subject: 'Confirm your email address',
            text: `Hi ${user.name},\n\nConfirm your email address by opening this link within 48 hours:\n\n${appUrl}/verify-email?token=${token}\n`,
          };
    });
    if (message) await deps.mailer.send(message);
    return;
  }

  const message = await withTenant(deps.pool, job.orgId, async (tx) => {
    const [row] = await tx.db
      .select({ i: invitations, orgName: organizations.name, inviter: users.name })
      .from(invitations)
      .innerJoin(organizations, eq(organizations.id, invitations.orgId))
      .innerJoin(users, eq(users.id, invitations.invitedBy))
      .where(
        and(
          eq(invitations.id, job.invitationId),
          isNull(invitations.acceptedAt),
          isNull(invitations.revokedAt),
        ),
      );
    if (!row) return null;
    const token = newToken();
    await tx.db
      .update(invitations)
      .set({ tokenHash: sha256(token) })
      .where(eq(invitations.id, row.i.id));
    const role = { org_admin: 'an admin', creator: 'a survey creator', analyst: 'an analyst' }[row.i.role];
    return {
      to: row.i.email,
      subject: `${row.inviter} invited you to ${row.orgName}`,
      text: `${row.inviter} invited you to join ${row.orgName} as ${role}.\n\nAccept the invitation (valid for 7 days):\n\n${appUrl}/invite/${token}\n`,
    };
  });
  if (message) await deps.mailer.send(message);
}

export function createJobHandlers(deps: Deps): JobHandlers {
  const { pool, jobs } = deps;
  return {
    'email.send': (job) => sendEmail(deps, job),

    'aggregates.response-completed': async ({ orgId, surveyId, responseId }) => {
      const counted = await withTenant(pool, orgId, async (tx) => {
        const added = await aggregateResponse(tx.client, surveyId, responseId);
        const { rows } = await tx.client.query<{ completed_count: number }>('select completed_count from surveys where id = $1', [surveyId]);
        return added ? (rows[0]?.completed_count ?? null) : null;
      });
      // Dashboards refetch as soon as the aggregates include the response.
      if (counted !== null) await publishLiveEvent(deps.redis, surveyId, { type: 'response.completed', completedCount: counted });
    },

    'aggregates.rebuild': async ({ orgId, surveyId }) => {
      await withTenant(pool, orgId, (tx) => rebuildSurveyAggregates(tx.client, surveyId));
    },

    // Repairs any drift by recomputing surveys that had completions in the last ~day.
    'aggregates.nightly': async () => {
      const { rows } = await withGlobal(pool, (tx) =>
        tx.client.query<{ org_id: string; survey_id: string }>(
          'select * from surveys_with_activity_since($1)',
          [new Date(Date.now() - 26 * HOUR)],
        ),
      );
      for (const row of rows)
        await jobs.enqueue(null, 'aggregates.rebuild', { orgId: row.org_id, surveyId: row.survey_id });
    },

    'surveys.close-expired': async () => {
      const { rows } = await withGlobal(pool, (tx) =>
        tx.client.query<{ org_id: string; survey_id: string }>('select * from close_expired_surveys()'),
      );
      for (const row of rows) {
        await withTenant(pool, row.org_id, (tx) =>
          audit(tx, {
            orgId: row.org_id,
            actorId: null,
            action: 'survey.closed',
            entityType: 'survey',
            entityId: row.survey_id,
            metadata: { reason: 'close_date' },
          }),
        );
      }
    },

    'sessions.cleanup': async () => {
      await withGlobal(pool, async (tx) => {
        await tx.db.delete(sessions).where(lt(sessions.expiresAt, new Date()));
        await tx.db
          .delete(authTokens)
          .where(
            or(
              lt(authTokens.expiresAt, new Date(Date.now() - 7 * 24 * HOUR)),
              lt(authTokens.createdAt, new Date(Date.now() - 30 * 24 * HOUR)),
            ),
          );
      });
    },

    /**
     * Scan an upload. The file stays undownloadable until this marks it clean. Infected files move
     * to the quarantine prefix, are flagged on their response and audited.
     */
    'files.scan': async ({ orgId, fileId }) => {
      const [file] = await withTenant(pool, orgId, (tx) => tx.db.select().from(files).where(eq(files.id, fileId)));
      if (!file || file.scanStatus !== 'pending') return;
      const result = await deps.scanner.scan(await deps.storage.get(file.storageKey));
      if (!result.infected) {
        await withTenant(pool, orgId, (tx) =>
          tx.db.update(files).set({ scanStatus: 'clean', scanDetail: result.detail, scannedAt: new Date() }).where(eq(files.id, fileId)),
        );
        return;
      }
      const quarantineKey = file.storageKey.replace(/^[a-z]+\//, 'quarantine/');
      await deps.storage.copy(file.storageKey, quarantineKey);
      await deps.storage.delete(file.storageKey);
      await withTenant(pool, orgId, async (tx) => {
        await tx.db
          .update(files)
          .set({ scanStatus: 'infected', scanDetail: result.detail, scannedAt: new Date(), storageKey: quarantineKey })
          .where(eq(files.id, fileId));
        if (file.responseId)
          await tx.client.query(
            `update responses set quality_flags = array(select distinct unnest(quality_flags || '{malware}'::text[])) where id = $1`,
            [file.responseId],
          );
        await audit(tx, { orgId, actorId: null, action: 'file.quarantined', entityType: 'file', entityId: fileId, metadata: { signature: result.detail } });
      });
    },

    'files.delete-objects': async ({ keys }) => {
      for (const key of keys) await deps.storage.delete(key);
    },

    'contacts.import': ({ orgId, importId }) => importContacts(deps, orgId, importId),
    ...campaignJobs(deps),
    ...exportJobs(deps),
  };
}
