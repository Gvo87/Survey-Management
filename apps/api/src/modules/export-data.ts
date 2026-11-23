/**
 * The rows of a response export, shared by CSV (streamed), XLSX and scheduled reports, so every
 * format has exactly the same columns and cell values.
 */
import { eq } from 'drizzle-orm';
import type { ExportOptions } from '@survey/contracts';
import type { AnswerValue } from '@survey/core';
import { distributions, surveys, withTenant, type Pool } from '@survey/db';
import {
  answerValues,
  buildExportColumns,
  loadCells,
  loadVersions,
  Params,
  questionIndex,
  responseConditions,
  type Filter,
  type VersionInfo,
} from './results';
import { filesForResponses } from './respondent';
import { tagsForResponses } from './results';

type SurveyRow = typeof surveys.$inferSelect;
export type ExportSettings = Partial<ExportOptions> & { layout: 'compact' | 'expanded'; includeTest: boolean };

interface RawRow {
  id: string;
  started_at: Date;
  version_id: string;
  [key: string]: unknown;
}

/** Yields the header row, then one array of cell values per response, in batches of 1,000. */
export async function* exportRows(pool: Pool, orgId: string, survey: SurveyRow, options: ExportSettings): AsyncGenerator<unknown[][]> {
  const { versions, links } = await withTenant(pool, orgId, async (tx) => ({
    versions: await loadVersions(tx, survey.id),
    links: await tx.db.select().from(distributions).where(eq(distributions.surveyId, survey.id)),
  }));
  const fileNames = new Map<string, string>();
  const tagNames = new Map<string, string[]>();
  const columns = buildExportColumns(versions, survey.currentVersionId, links, options.layout, options.includeTest, fileNames);
  columns.push({ header: 'tags', value: (r) => (tagNames.get(r.id) ?? []).join('; ') });
  const filter: Filter = {
    from: options.from,
    to: options.to,
    versionId: options.versionId,
    includeTest: options.includeTest,
    statuses: (options.status ?? 'completed') === 'completed' ? ['completed'] : undefined,
    excludeFlagged: options.excludeFlagged,
    filter: options.filter,
    questions: questionIndex(versions, survey.currentVersionId),
  };

  yield [columns.map((c) => c.header)];
  let after: [string, string] | null = null;
  for (;;) {
    const batch = await withTenant(pool, orgId, async (tx) => {
      const p = new Params();
      const { rows: found } = await tx.client.query<RawRow>(
        `select r.* from responses r
          where ${responseConditions(p, survey.id, filter)}
            ${after ? `and (r.started_at, r.id) > (${p.add(after[0])}::timestamptz, ${p.add(after[1])}::uuid)` : ''}
          order by r.started_at, r.id limit 1000`,
        p.values,
      );
      const ids = found.map((r) => r.id);
      const cells = await loadCells(tx, survey.id, ids);
      for (const f of await filesForResponses(tx, ids)) fileNames.set(f.id, f.filename);
      tagNames.clear();
      for (const t of await tagsForResponses(tx, ids)) tagNames.set(t.responseId, [...(tagNames.get(t.responseId) ?? []), t.name]);
      return { found, cells };
    });
    if (batch.found.length === 0) return;
    const rows: unknown[][] = [];
    for (const r of batch.found) {
      const version: VersionInfo | undefined = versions.find((v) => v.id === r.version_id);
      const values = new Map<string, AnswerValue>();
      if (version) for (const { question, value } of answerValues(version.definition, batch.cells.get(r.id) ?? [])) values.set(question.key, value);
      rows.push(columns.map((c) => c.value(r as never, values, version)));
    }
    yield rows;
    const last = batch.found.at(-1)!;
    after = [last.started_at.toISOString(), last.id];
  }
}
