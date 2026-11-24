/**
 * Hard-delete responses of one survey (bulk delete, retention purges, privacy erasure): answers, tags,
 * notes and uploaded files go with them (cascades), aggregates and the completed count are repaired in the
 * same transaction, and the files' stored objects are deleted by a job that commits with it.
 */
import type { Tx } from '@survey/db';
import { rebuildSurveyAggregates } from '@survey/db';
import type { Deps } from '../deps';

export async function deleteSurveyResponses(deps: Deps, tx: Tx, surveyId: string, ids: string[]): Promise<number> {
  if (ids.length === 0) return 0;
  const { rows: objects } = await tx.client.query<{ storage_key: string }>(
    `select storage_key from files where response_id = any($1::uuid[])`,
    [ids],
  );
  const { rowCount } = await tx.client.query(`delete from responses where survey_id = $1 and id = any($2::uuid[])`, [surveyId, ids]);
  await rebuildSurveyAggregates(tx.client, surveyId);
  await tx.client.query(
    `update surveys set completed_count = (select count(*) from responses where survey_id = $1 and status = 'completed' and not is_test) where id = $1`,
    [surveyId],
  );
  if (objects.length) await deps.jobs.enqueue(tx, 'files.delete-objects', { keys: objects.map((o) => o.storage_key) });
  return rowCount ?? 0;
}
