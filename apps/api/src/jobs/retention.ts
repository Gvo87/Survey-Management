/**
 * Daily retention purge (Phase 3B):
 * - responses older than the survey's retention period (its own, else the org default) are deleted in
 *   batches of 5,000, with aggregates repaired in the same transaction and one audit entry per survey;
 *   "older" means completed (or last active, if never completed) more than N days ago;
 * - soft-deleted surveys are deleted for good 30 days after deletion, with their stored files;
 * - subject-export files expire after 7 days.
 * The cross-org scans are narrow SECURITY DEFINER functions; the work runs in each org's tenant context.
 */
import { withGlobal, withTenant } from '@survey/db';
import type { Deps } from '../deps';
import { audit } from '../audit';
import { deleteSurveyResponses } from '../lib/response-deletion';

const BATCH = 5000;

export interface RetentionResult {
  responses: number;
  surveys: number;
  exports: number;
}

export async function runRetention(deps: Deps, now = new Date()): Promise<RetentionResult> {
  const result: RetentionResult = { responses: 0, surveys: 0, exports: 0 };
  const { rows: targets } = await withGlobal(deps.pool, (tx) =>
    tx.client.query<{ org_id: string; survey_id: string; days: number }>('select * from retention_targets()'),
  );
  for (const target of targets) {
    const cutoff = new Date(now.getTime() - target.days * 86_400_000);
    let purged = 0;
    for (;;) {
      const deleted = await withTenant(deps.pool, target.org_id, async (tx) => {
        await tx.client.query(`set local statement_timeout = '120s'`);
        const { rows } = await tx.client.query<{ id: string }>(
          `select id from responses where survey_id = $1 and coalesce(completed_at, last_activity_at) < $2
            order by coalesce(completed_at, last_activity_at) limit ${BATCH} for update skip locked`,
          [target.survey_id, cutoff],
        );
        const n = await deleteSurveyResponses(deps, tx, target.survey_id, rows.map((r) => r.id));
        purged += n;
        const last = n < BATCH;
        if (last && purged > 0)
          await audit(tx, {
            orgId: target.org_id,
            actorId: null,
            action: 'responses.retention_purged',
            entityType: 'survey',
            entityId: target.survey_id,
            metadata: { count: purged, retentionDays: target.days, olderThan: cutoff.toISOString() },
          });
        return n;
      });
      if (deleted < BATCH) break;
    }
    result.responses += purged;
  }

  const { rows: dueSurveys } = await withGlobal(deps.pool, (tx) =>
    tx.client.query<{ org_id: string; survey_id: string }>('select * from deleted_surveys_due($1)', [now]),
  );
  for (const due of dueSurveys) {
    await withTenant(deps.pool, due.org_id, async (tx) => {
      const { rows: objects } = await tx.client.query<{ storage_key: string }>(
        `select storage_key from files where survey_id = $1
         union all select storage_key from exports where survey_id = $1 and storage_key is not null`,
        [due.survey_id],
      );
      const { rows: gone } = await tx.client.query<{ title: string }>(
        `delete from surveys where id = $1 and deleted_at is not null returning title`,
        [due.survey_id],
      );
      if (!gone[0]) return;
      if (objects.length) await deps.jobs.enqueue(tx, 'files.delete-objects', { keys: objects.map((o) => o.storage_key) });
      await audit(tx, { orgId: due.org_id, actorId: null, action: 'survey.purged', entityType: 'survey', entityId: due.survey_id, metadata: { title: gone[0].title } });
      result.surveys++;
    });
  }

  const { rows: expired } = await withGlobal(deps.pool, (tx) =>
    tx.client.query<{ org_id: string; request_id: string; storage_key: string }>('select * from expired_privacy_exports($1)', [now]),
  );
  for (const e of expired) {
    await deps.storage.delete(e.storage_key).catch(() => {});
    await withTenant(deps.pool, e.org_id, (tx) => tx.client.query('update privacy_requests set storage_key = null where id = $1', [e.request_id]));
    result.exports++;
  }
  return result;
}
