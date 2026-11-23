/**
 * Question-level aggregation (data model §2.10). One SQL definition of "bucket" is used for the
 * incremental job, the nightly rebuild and live filtered queries, so they can't disagree.
 *
 * Buckets per answer cell: each selected option key; the numeric value (only when there are no
 * choices: a Likert ordinal is covered by its option key); the date; and `__answered__`.
 */
import type { PoolClient } from './client';

export const ANSWERED_BUCKET = '__answered__';

/**
 * SQL computing bucket counts for the answers of responses matching `where` (a condition on
 * `responses r` and optionally `answers a`). Returns (question_key, sub_key, bucket, count), plus
 * version_id first when `byVersion` is set.
 *
 * Written as a materialized CTE plus grouped UNION ALL rather than a per-row LATERAL: on 50k
 * responses the LATERAL form made the planner add a Memoize node that missed on every row
 * (5.7 s vs ~0.3 s).
 */
export function bucketCountsSql(where: string, opts: { byVersion: boolean }): string {
  const v = opts.byVersion ? 'version_id, ' : '';
  return `
    with cells as materialized (
      select ${opts.byVersion ? 'r.version_id, ' : ''}a.question_key, a.sub_key, a.value_choices, a.value_number, a.value_date
        from responses r
        join answers a on a.survey_id = r.survey_id and a.response_id = r.id
       where ${where}
    )
    select ${v}question_key, sub_key, bucket, count(*)::int as count
      from (
        select ${v}question_key, sub_key, unnest(value_choices) as bucket from cells where value_choices is not null
        union all
        select ${v}question_key, sub_key, trim_scale(value_number)::text from cells where value_number is not null and value_choices is null
        union all
        select ${v}question_key, sub_key, value_date::text from cells where value_date is not null
        union all
        select ${v}question_key, sub_key, '${ANSWERED_BUCKET}' from cells
      ) buckets
     group by ${v}question_key, sub_key, bucket`;
}

async function lockSurvey(client: PoolClient, surveyId: string): Promise<void> {
  await client.query(`select pg_advisory_xact_lock(hashtext('aggregates:' || $1))`, [surveyId]);
}

/**
 * Add one completed response to question_counts. Idempotent: `aggregated_at` is set in the same
 * transaction, so a retried job (or a rebuild that already counted it) adds nothing.
 * Must run inside a tenant transaction.
 */
export async function aggregateResponse(
  client: PoolClient,
  surveyId: string,
  responseId: string,
): Promise<boolean> {
  await lockSurvey(client, surveyId);
  const claimed = await client.query<{ org_id: string }>(
    `update responses set aggregated_at = now()
      where id = $1 and survey_id = $2 and status = 'completed' and not is_test and aggregated_at is null
      returning org_id`,
    [responseId, surveyId],
  );
  if (claimed.rowCount === 0) return false;
  await client.query(
    `insert into question_counts (org_id, survey_id, version_id, question_key, sub_key, bucket, count)
     select $3::uuid, $2::uuid, version_id, question_key, sub_key, bucket, count
       from (${bucketCountsSql('r.id = $1 and r.survey_id = $2', { byVersion: true })}) x
     on conflict (survey_id, version_id, question_key, sub_key, bucket)
     do update set count = question_counts.count + excluded.count`,
    [responseId, surveyId, claimed.rows[0]!.org_id],
  );
  return true;
}

/** Remove a response's contribution before it is deleted. Must run in the deleting transaction. */
export async function unaggregateResponse(
  client: PoolClient,
  surveyId: string,
  responseId: string,
): Promise<void> {
  await lockSurvey(client, surveyId);
  await client.query(
    `with contribution as (
       ${bucketCountsSql('r.id = $1 and r.survey_id = $2 and r.aggregated_at is not null', { byVersion: true })}
     )
     update question_counts qc set count = qc.count - c.count
       from contribution c
      where qc.survey_id = $2 and qc.version_id = c.version_id and qc.question_key = c.question_key
        and qc.sub_key = c.sub_key and qc.bucket = c.bucket`,
    [responseId, surveyId],
  );
  await client.query(`delete from question_counts where survey_id = $1 and count <= 0`, [surveyId]);
}

/** Recompute a survey's aggregates from raw answers (nightly repair, seed, on demand). */
export async function rebuildSurveyAggregates(client: PoolClient, surveyId: string): Promise<void> {
  await lockSurvey(client, surveyId);
  const { rows } = await client.query<{ org_id: string }>('select org_id from surveys where id = $1', [
    surveyId,
  ]);
  if (!rows[0]) return;
  await client.query(`delete from question_counts where survey_id = $1`, [surveyId]);
  await client.query(
    `insert into question_counts (org_id, survey_id, version_id, question_key, sub_key, bucket, count)
     select $2::uuid, $1::uuid, version_id, question_key, sub_key, bucket, count
       from (${bucketCountsSql(`r.survey_id = $1 and r.status = 'completed' and not r.is_test`, { byVersion: true })}) x`,
    [surveyId, rows[0].org_id],
  );
  await client.query(
    `update responses set aggregated_at = now()
      where survey_id = $1 and status = 'completed' and not is_test and aggregated_at is null`,
    [surveyId],
  );
}
