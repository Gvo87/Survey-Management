import { Readable } from 'node:stream';
import { and, desc, eq, inArray } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import {
  CrosstabRequest,
  DropoffRequest,
  ExportQuery,
  ListResponsesQuery,
  ResultFilterSchema,
  ResultsQuery,
  ResultsQueryRequest,
  TermsQuery,
  TextAnswersQuery,
  type CrosstabResult,
  type DropoffByQuestion,
  type QuestionSummary,
  type ResponseDetail,
  type ResponseSummary,
  type ResultFilter,
  type ResultsQueryResult,
  type ResultsSummary,
  type TermsResult,
} from '@survey/contracts';
import {
  displayAnswer,
  listQuestions,
  otherText,
  plainTitle,
  selectedOptionKeys,
  type AnswerValue,
  type Question,
  type SurveyDefinition,
} from '@survey/core';
import {
  ANSWERED_BUCKET,
  bucketCountsSql,
  answers as answersTable,
  contacts,
  distributions,
  recipients,
  responseNotes,
  users,
  fromCells,
  responses,
  surveys,
  surveyVersions,
  unaggregateResponse,
  withTenant,
  type AnswerCell,
  type Tx,
} from '@survey/db';
import type { Deps } from '../deps';
import { audit } from '../audit';
import { requireOrg } from '../auth/context';
import { notFound, unprocessable } from '../lib/errors';
import { compileResultFilter } from '../lib/result-filter';
import { chiSquare } from '../lib/stats';
import { STOP_WORDS } from '../lib/stop-words';
import { csvRow, UTF8_BOM } from '../lib/csv';
import { decodeCursor, encodeCursor, iso, slugify } from '../lib/misc';
import { parse } from '../lib/validate';
import { loadSurvey } from './surveys';
import { filesForResponses } from './respondent';
import { exportRows } from './export-data';

type SurveyRow = typeof surveys.$inferSelect;
type ResponseRow = typeof responses.$inferSelect;
export interface VersionInfo {
  id: string;
  versionNumber: number;
  definition: SurveyDefinition;
}

/** Collects positional parameters for hand-written SQL. */
export class Params {
  readonly values: unknown[] = [];
  add(value: unknown): string {
    this.values.push(value);
    return `$${this.values.length}`;
  }
}

export interface Filter {
  from?: string;
  to?: string;
  versionId?: string;
  includeTest: boolean;
  statuses?: ('in_progress' | 'completed' | 'disqualified')[];
  /** Leave out responses with any quality flag. */
  excludeFlagged?: boolean;
  /** Only responses with this quality flag. */
  flag?: string;
  /** Phase 2B: results filter (logic grammar), with the questions it may refer to. */
  filter?: ResultFilter;
  questions?: Map<string, Question>;
  /** Phase 2B: full-text search in open answers, and a tag. */
  q?: string;
  tag?: string;
}

/** WHERE conditions on `responses r`. Every value is a bound parameter. */
export function responseConditions(p: Params, surveyId: string, f: Filter): string {
  const parts = [`r.survey_id = ${p.add(surveyId)}`];
  if (!f.includeTest) parts.push('not r.is_test');
  if (f.versionId) parts.push(`r.version_id = ${p.add(f.versionId)}`);
  if (f.from) parts.push(`r.started_at >= ${p.add(f.from)}::timestamptz`);
  if (f.to) parts.push(`r.started_at < ${p.add(f.to)}::timestamptz`);
  if (f.statuses) parts.push(`r.status = any(${p.add(f.statuses)}::text[])`);
  if (f.excludeFlagged) parts.push(`r.quality_flags = '{}'`);
  if (f.flag) parts.push(`${p.add(f.flag)} = any(r.quality_flags)`);
  if (f.filter) parts.push(compileResultFilter(p, f.filter, f.questions ?? new Map()));
  if (f.q)
    // Same expression as the answers_fulltext index, so the index is used.
    parts.push(
      `exists (select 1 from answers a where a.survey_id = r.survey_id and a.response_id = r.id
         and (a.value_text is not null or a.other_text is not null)
         and to_tsvector('simple', coalesce(a.value_text, '') || ' ' || coalesce(a.other_text, '')) @@ websearch_to_tsquery('simple', ${p.add(f.q)}))`,
    );
  if (f.tag) parts.push(`exists (select 1 from response_tags t where t.response_id = r.id and t.tag_id = ${p.add(f.tag)}::uuid)`);
  return parts.join(' and ');
}

/** Questions of every version by key (for compiling filters). */
export function questionIndex(versions: VersionInfo[], currentVersionId: string | null): Map<string, Question> {
  return new Map(questionUnion(versions, currentVersionId).map(({ question }) => [question.key, question]));
}

export async function loadVersions(tx: Tx, surveyId: string): Promise<VersionInfo[]> {
  return tx.db
    .select({
      id: surveyVersions.id,
      versionNumber: surveyVersions.versionNumber,
      definition: surveyVersions.definition,
    })
    .from(surveyVersions)
    .where(and(eq(surveyVersions.surveyId, surveyId), eq(surveyVersions.status, 'published')))
    .orderBy(desc(surveyVersions.versionNumber));
}

/**
 * Every question across all published versions: the current version's questions in order, then
 * questions removed in later versions. Each uses its newest definition.
 */
export function questionUnion(versions: VersionInfo[], currentVersionId: string | null) {
  const current = versions.find((v) => v.id === currentVersionId) ?? versions[0];
  const currentKeys = new Set(current ? listQuestions(current.definition).map((q) => q.key) : []);
  const seen = new Map<string, { question: Question; removed: boolean }>();
  const ordered = current ? [current, ...versions.filter((v) => v !== current)] : versions;
  for (const version of ordered) {
    for (const question of listQuestions(version.definition)) {
      if (!seen.has(question.key))
        seen.set(question.key, { question, removed: !currentKeys.has(question.key) });
    }
  }
  return [...seen.values()];
}

/** questionKey → sub_key (matrix row / ranked option; '' otherwise) → bucket → count */
type Buckets = Map<string, Map<string, Map<string, number>>>;

function median(distribution: { value: number; count: number }[], total: number): number | null {
  if (total === 0) return null;
  const sorted = [...distribution].sort((a, b) => a.value - b.value);
  const mid = (total + 1) / 2;
  let cumulative = 0;
  let lower: number | null = null;
  for (const { value, count } of sorted) {
    cumulative += count;
    if (lower === null && cumulative >= Math.floor(mid)) lower = value;
    if (cumulative >= Math.ceil(mid)) return lower === null ? value : (lower + value) / 2;
  }
  return lower;
}

const round = (n: number, digits = 2) => Math.round(n * 10 ** digits) / 10 ** digits;

function summarizeQuestion(
  question: Question,
  removed: boolean,
  subBuckets: Map<string, Map<string, number>>,
  latest: { responseId: string; text: string }[],
): QuestionSummary {
  const buckets = subBuckets.get('') ?? new Map<string, number>();
  const answered = buckets.get(ANSWERED_BUCKET) ?? 0;
  const base = {
    questionKey: question.key,
    title: plainTitle(question),
    answered,
    removedInCurrentVersion: removed,
  };
  const numeric = (from: number, to: number) =>
    Array.from({ length: to - from + 1 }, (_, i) => ({
      value: from + i,
      count: buckets.get(String(from + i)) ?? 0,
    }));
  const mean = (dist: { value: number; count: number }[]) => {
    const total = dist.reduce((s, d) => s + d.count, 0);
    return total ? round(dist.reduce((s, d) => s + d.value * d.count, 0) / total) : null;
  };

  switch (question.type) {
    case 'single_choice':
    case 'multi_choice':
    case 'dropdown':
    case 'likert': {
      const known = new Set(question.options.map((o) => o.key));
      const options = [
        ...question.options.map((o) => ({ key: o.key, label: o.label, count: buckets.get(o.key) ?? 0 })),
        // Options deleted in a later version still have historical answers.
        ...[...buckets.entries()]
          .filter(([key]) => key !== ANSWERED_BUCKET && !known.has(key))
          .map(([key, count]) => ({ key, label: '(removed option)', count })),
      ].map((o) => ({ ...o, pct: answered ? round((o.count / answered) * 100, 1) : 0 }));
      const otherKey = question.options.find((o) => o.isOther)?.key;
      const likertMean =
        question.type === 'likert'
          ? mean(
              question.options.map((o, i) => ({ value: o.value ?? i + 1, count: buckets.get(o.key) ?? 0 })),
            )
          : null;
      return {
        ...base,
        type: question.type,
        options,
        otherCount: otherKey ? (buckets.get(otherKey) ?? 0) : 0,
        mean: likertMean,
      };
    }
    case 'rating': {
      const distribution = numeric(1, question.config.scale);
      return {
        ...base,
        type: 'rating',
        scale: question.config.scale,
        distribution,
        mean: mean(distribution),
        median: median(distribution, answered),
      };
    }
    case 'nps': {
      const distribution = numeric(0, 10);
      const sum = (from: number, to: number) =>
        distribution.filter((d) => d.value >= from && d.value <= to).reduce((s, d) => s + d.count, 0);
      const promoters = sum(9, 10);
      const passives = sum(7, 8);
      const detractors = sum(0, 6);
      const total = promoters + passives + detractors;
      return {
        ...base,
        type: 'nps',
        distribution,
        promoters,
        passives,
        detractors,
        score: total ? Math.round(((promoters - detractors) / total) * 100) : null,
      };
    }
    case 'matrix': {
      const rows = question.rows.map((r) => ({
        key: r.key,
        label: r.label,
        answered: subBuckets.get(r.key)?.get(ANSWERED_BUCKET) ?? 0,
      }));
      return {
        ...base,
        // People who answered at least one row: the busiest row is the best available lower bound.
        answered: Math.max(0, ...rows.map((r) => r.answered)),
        type: 'matrix',
        rows,
        columns: question.options.map((c) => ({ key: c.key, label: c.label })),
        counts: question.rows.map((r) => question.options.map((c) => subBuckets.get(r.key)?.get(c.key) ?? 0)),
      };
    }
    case 'ranking': {
      const options = question.options
        .map((o) => {
          const b = subBuckets.get(o.key) ?? new Map<string, number>();
          const ranks = [...b.entries()]
            .filter(([k]) => k !== ANSWERED_BUCKET)
            .map(([k, count]) => ({ value: Number(k), count }));
          return {
            key: o.key,
            label: o.label,
            meanRank: mean(ranks),
            firstPlace: b.get('1') ?? 0,
            ranked: ranks.reduce((sum, r) => sum + r.count, 0),
          };
        })
        .sort((a, b) => (a.meanRank ?? Infinity) - (b.meanRank ?? Infinity));
      // Every ranking has exactly one first place, so first places add up to the people who ranked.
      return { ...base, answered: options.reduce((sum, o) => sum + o.firstPlace, 0), type: 'ranking', options };
    }
    case 'slider': {
      const values = [...buckets.entries()]
        .filter(([k]) => k !== ANSWERED_BUCKET)
        .map(([k, count]) => ({ value: Number(k), count }));
      const { min, max } = question.config;
      const bins = 10;
      const width = (max - min) / bins;
      const histogram = Array.from({ length: bins }, (_, i) => ({ from: round(min + i * width), to: round(min + (i + 1) * width), count: 0 }));
      for (const v of values) histogram[Math.min(bins - 1, Math.max(0, Math.floor((v.value - min) / width)))]!.count += v.count;
      return { ...base, type: 'slider', min, max, mean: mean(values), median: median(values, answered), histogram };
    }
    case 'file_upload':
      return { ...base, type: 'file_upload', files: answered };
    case 'consent':
      return { ...base, type: 'consent', agreed: buckets.get('1') ?? 0 };
    case 'date': {
      const byDay = [...buckets.entries()]
        .filter(([key]) => key !== ANSWERED_BUCKET)
        .map(([date, count]) => ({ date, count }))
        .sort((a, b) => a.date.localeCompare(b.date));
      return { ...base, type: 'date', byDay };
    }
    case 'short_text':
    case 'long_text':
    case 'email':
    case 'phone':
      return { ...base, type: question.type, latest };
  }
}

export async function computeSummary(
  tx: Tx,
  survey: SurveyRow,
  query: ResultsQuery & { filter?: ResultFilter },
): Promise<ResultsSummary> {
  const versions = await loadVersions(tx, survey.id);
  const generatedAt = new Date().toISOString();
  const versionList = versions.map((v) => ({ id: v.id, versionNumber: v.versionNumber }));
  const empty: ResultsSummary = {
    totals: {
      started: 0,
      completed: 0,
      disqualified: 0,
      completionRate: null,
      avgDurationSec: null,
      medianDurationSec: null,
    },
    dropoff: [],
    questions: [],
    versions: versionList,
    generatedAt,
    source: 'live',
  };
  if (versions.length === 0) return empty;

  const isDefaultView =
    !query.from && !query.to && !query.versionId && !query.includePartial && !query.includeTest && !query.excludeFlagged && !query.filter;
  const filter: Filter = {
    from: query.from,
    to: query.to,
    versionId: query.versionId,
    includeTest: query.includeTest,
    excludeFlagged: query.excludeFlagged,
    filter: query.filter,
    questions: questionIndex(versions, survey.currentVersionId),
  };

  // Totals: cheap index scans on responses, always live.
  const tp = new Params();
  const {
    rows: [t],
  } = await tx.client.query<{
    started: number;
    completed: number;
    disqualified: number;
    avg_ms: number | null;
    median_ms: number | null;
  }>(
    `select count(*)::int as started,
            count(*) filter (where status = 'completed')::int as completed,
            count(*) filter (where status = 'disqualified')::int as disqualified,
            avg(duration_ms) filter (where status = 'completed') as avg_ms,
            percentile_cont(0.5) within group (order by duration_ms) filter (where status = 'completed') as median_ms
       from responses r where ${responseConditions(tp, survey.id, filter)}`,
    tp.values,
  );

  // Drop-off by page, for one version (pages differ between versions).
  const dropVersion =
    versions.find((v) => v.id === (query.versionId ?? survey.currentVersionId)) ?? versions[0]!;
  const dp = new Params();
  const { rows: dropRows } = await tx.client.query<{
    furthest_page_key: string | null;
    status: string;
    n: number;
  }>(
    `select furthest_page_key, status, count(*)::int as n from responses r
      where ${responseConditions(dp, survey.id, { ...filter, versionId: dropVersion.id })}
      group by 1, 2`,
    dp.values,
  );
  const pages = dropVersion.definition.pages;
  const indexOf = (key: string | null) =>
    Math.max(
      0,
      pages.findIndex((p) => p.key === key),
    );
  const dropoff = pages.map((page, i) => {
    let reached = 0;
    let abandonedHere = 0;
    for (const row of dropRows) {
      const furthest = row.status === 'in_progress' ? indexOf(row.furthest_page_key) : pages.length - 1;
      if (furthest >= i) reached += row.n;
      if (row.status === 'in_progress' && furthest === i) abandonedHere += row.n;
    }
    return { pageKey: page.key, title: page.title?.trim() || `Page ${i + 1}`, reached, abandonedHere };
  });

  // Question buckets: pre-aggregated for the default view, live otherwise.
  const buckets: Buckets = new Map();
  const bp = new Params();
  const bucketRows = isDefaultView
    ? (
        await tx.client.query<{ question_key: string; sub_key: string; bucket: string; count: number }>(
          `select question_key, sub_key, bucket, sum(count)::int as count from question_counts
            where survey_id = ${bp.add(survey.id)} group by 1, 2, 3`,
          bp.values,
        )
      ).rows
    : (
        await tx.client.query<{ question_key: string; sub_key: string; bucket: string; count: number }>(
          bucketCountsSql(
            responseConditions(bp, survey.id, { ...filter, statuses: query.includePartial ? ['completed', 'in_progress'] : ['completed'] }),
            { byVersion: false },
          ),
          bp.values,
        )
      ).rows;
  for (const row of bucketRows) {
    if (!buckets.has(row.question_key)) buckets.set(row.question_key, new Map());
    const bySub = buckets.get(row.question_key)!;
    if (!bySub.has(row.sub_key)) bySub.set(row.sub_key, new Map());
    bySub.get(row.sub_key)!.set(row.bucket, row.count);
  }

  const union = questionUnion(versions, survey.currentVersionId);
  const textKeys = union
    .filter(({ question }) => ['short_text', 'long_text', 'email', 'phone'].includes(question.type))
    .map(({ question }) => question.key);
  const latest = new Map<string, { responseId: string; text: string }[]>();
  if (textKeys.length) {
    const lp = new Params();
    const keysParam = lp.add(textKeys);
    const { rows } = await tx.client.query<{ question_key: string; response_id: string; value_text: string }>(
      `select q.key as question_key, x.response_id, x.value_text
         from unnest(${keysParam}::text[]) as q(key)
         cross join lateral (
           select a.response_id, a.value_text
             from answers a join responses r on r.id = a.response_id
            where a.survey_id = r.survey_id and a.question_key = q.key and a.value_text is not null
              and ${responseConditions(lp, survey.id, { ...filter, statuses: query.includePartial ? ['completed', 'in_progress'] : ['completed'] })}
            order by r.started_at desc, r.id desc
            limit 5
         ) x`,
      lp.values,
    );
    for (const row of rows) {
      if (!latest.has(row.question_key)) latest.set(row.question_key, []);
      latest.get(row.question_key)!.push({ responseId: row.response_id, text: row.value_text });
    }
  }

  return {
    totals: {
      started: t!.started,
      completed: t!.completed,
      disqualified: t!.disqualified,
      completionRate: t!.started ? round(t!.completed / t!.started, 4) : null,
      avgDurationSec: t!.avg_ms === null ? null : Math.round(Number(t!.avg_ms) / 1000),
      medianDurationSec: t!.median_ms === null ? null : Math.round(Number(t!.median_ms) / 1000),
    },
    dropoff,
    questions: union.map(({ question, removed }) =>
      summarizeQuestion(
        question,
        removed,
        buckets.get(question.key) ?? new Map(),
        latest.get(question.key) ?? [],
      ),
    ),
    versions: versionList,
    generatedAt,
    source: isDefaultView ? 'aggregate' : 'live',
  };
}

export async function loadCells(
  tx: Tx,
  surveyId: string,
  responseIds: string[],
): Promise<Map<string, AnswerCell[]>> {
  const byResponse = new Map<string, AnswerCell[]>();
  if (responseIds.length === 0) return byResponse;
  const rows = await tx.db
    .select()
    .from(answersTable)
    .where(and(eq(answersTable.surveyId, surveyId), inArray(answersTable.responseId, responseIds)));
  for (const row of rows) {
    if (!byResponse.has(row.responseId)) byResponse.set(row.responseId, []);
    byResponse.get(row.responseId)!.push(row as AnswerCell);
  }
  return byResponse;
}

export function answerValues(definition: SurveyDefinition, cells: AnswerCell[]) {
  return listQuestions(definition)
    .map((question) => {
      const own = cells.filter((c) => c.questionKey === question.key);
      const value = own.length ? fromCells(question, own) : null;
      return { question, value };
    })
    .filter((a): a is { question: Question; value: AnswerValue } => a.value !== null);
}

/** A results filter passed as a JSON query parameter. */
export function parseFilterParam(raw: string | undefined): ResultFilter | undefined {
  if (!raw) return undefined;
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    throw unprocessable('invalid_filter', 'The filter is malformed.');
  }
  return parse(ResultFilterSchema, json);
}

export async function tagsForResponses(tx: Tx, responseIds: string[]) {
  if (!responseIds.length) return [];
  const { rows } = await tx.client.query<{ response_id: string; id: string; name: string }>(
    `select rt.response_id, t.id, t.name from response_tags rt join tags t on t.id = rt.tag_id
      where rt.response_id = any($1::uuid[]) order by lower(t.name)`,
    [responseIds],
  );
  return rows.map((r) => ({ responseId: r.response_id, id: r.id, name: r.name }));
}

async function contactOf(tx: Tx, recipientId: string | null) {
  if (!recipientId) return null;
  const [row] = await tx.db
    .select({ email: contacts.email, first: contacts.firstName, last: contacts.lastName })
    .from(recipients)
    .innerJoin(contacts, eq(contacts.id, recipients.contactId))
    .where(eq(recipients.id, recipientId));
  return row ? { email: row.email, name: [row.first, row.last].filter(Boolean).join(' ') } : null;
}

/** Statuses counted by results: completed, plus partial responses when asked. */
const countedStatuses = (includePartial: boolean): ('completed' | 'in_progress')[] =>
  includePartial ? ['completed', 'in_progress'] : ['completed'];

/** Choice-like answers usable in a cross-tab: their categories in display order. */
function crosstabAxis(question: Question | undefined, subKey: string | undefined) {
  if (!question) throw unprocessable('invalid_question', 'Choose questions from this survey.');
  if (question.type === 'matrix') {
    const row = question.rows.find((r) => r.key === subKey);
    if (!row) throw unprocessable('invalid_question', `Choose a row of "${question.title}".`);
    return { label: `${question.title} › ${row.label}`, categories: question.options.map((o) => ({ key: o.key, label: o.label })), single: !question.config.multiplePerRow };
  }
  if (!['single_choice', 'dropdown', 'likert', 'multi_choice'].includes(question.type) || !('options' in question))
    throw unprocessable('invalid_question', 'Cross-tabs work with choice questions (single, multiple, dropdown, Likert, matrix rows).');
  return {
    label: question.title,
    categories: question.options.map((o) => ({ key: o.key, label: o.label })),
    single: question.type !== 'multi_choice',
  };
}

export function registerResultsRoutes(app: FastifyInstance, deps: Deps): void {
  const { pool } = deps;
  type IdParams = { Params: { id: string } };

  app.get<IdParams>('/api/v1/surveys/:id/results/summary', async (req) => {
    const auth = requireOrg(req);
    const query = parse(ResultsQuery, req.query);
    return withTenant(pool, auth.orgId, async (tx) => {
      const { survey } = await loadSurvey(tx, auth, req.params.id, 'responses.view');
      await tx.client.query(`set local statement_timeout = '15s'`);
      return computeSummary(tx, survey, query);
    });
  });

  /**
   * Filtered results and up to 4 side-by-side segments. Anonymous surveys hide any group smaller
   * than the minimum group size, so a filter can't single out a respondent.
   */
  app.post<IdParams>('/api/v1/surveys/:id/results/query', async (req): Promise<ResultsQueryResult> => {
    const auth = requireOrg(req);
    const body = parse(ResultsQueryRequest, req.body);
    return withTenant(pool, auth.orgId, async (tx) => {
      const { survey } = await loadSurvey(tx, auth, req.params.id, 'responses.view');
      await tx.client.query(`set local statement_timeout = '20s'`);
      const min = survey.anonymous ? deps.config.minGroupSize : 0;
      const tooSmall = (s: ResultsSummary) => min > 0 && s.totals.started > 0 && s.totals.started < min;
      const overall = await computeSummary(tx, survey, body);
      const overallSuppressed = Boolean(body.filter) && tooSmall(overall);
      const segments = [];
      for (const segment of body.segments) {
        const filter: ResultFilter = body.filter ? { all: [body.filter, segment.filter] } : segment.filter;
        const summary = await computeSummary(tx, survey, { ...body, filter });
        const suppressed = tooSmall(summary);
        segments.push({ name: segment.name, summary: suppressed ? null : summary, suppressed });
      }
      return { overall: overallSuppressed ? null : overall, suppressed: overallSuppressed, segments, minGroupSize: min || null };
    });
  });

  app.post<IdParams>('/api/v1/surveys/:id/results/crosstab', async (req): Promise<CrosstabResult> => {
    const auth = requireOrg(req);
    const body = parse(CrosstabRequest, req.body);
    return withTenant(pool, auth.orgId, async (tx) => {
      const { survey } = await loadSurvey(tx, auth, req.params.id, 'responses.view');
      await tx.client.query(`set local statement_timeout = '20s'`);
      const versions = await loadVersions(tx, survey.id);
      const questions = questionIndex(versions, survey.currentVersionId);
      const rowAxis = crosstabAxis(questions.get(body.rows.questionKey), body.rows.subKey);
      const colAxis = crosstabAxis(questions.get(body.columns.questionKey), body.columns.subKey);
      // Each query gets its own parameter list (unused parameters make Postgres fail).
      const scoped = () => {
        const p = new Params();
        const where = responseConditions(p, survey.id, {
          from: body.from,
          to: body.to,
          versionId: body.versionId,
          includeTest: body.includeTest,
          excludeFlagged: body.excludeFlagged,
          statuses: countedStatuses(body.includePartial),
          filter: body.filter,
          questions,
        });
        const cell = (alias: string, ref: { questionKey: string; subKey?: string }) =>
          `join answers ${alias} on ${alias}.survey_id = r.survey_id and ${alias}.response_id = r.id
             and ${alias}.question_key = ${p.add(ref.questionKey)} and ${alias}.sub_key = ${p.add(ref.subKey ?? '')}`;
        return { p, where, joins: `${cell('a1', body.rows)} ${cell('a2', body.columns)}` };
      };
      const q1 = scoped();
      const { rows } = await tx.client.query<{ rk: string; ck: string; n: number }>(
        `select x.rk, y.ck, count(distinct r.id)::int as n
           from responses r
           ${q1.joins}
           cross join lateral unnest(a1.value_choices) as x(rk)
           cross join lateral unnest(a2.value_choices) as y(ck)
          where ${q1.where}
          group by 1, 2`,
        q1.p.values,
      );
      const q2 = scoped();
      const { rows: totalRows } = await tx.client.query<{ n: number }>(
        `select count(*)::int as n from responses r ${q2.joins} where ${q2.where}`,
        q2.p.values,
      );
      const counts = rowAxis.categories.map((rc) => colAxis.categories.map((cc) => rows.find((r) => r.rk === rc.key && r.ck === cc.key)?.n ?? 0));
      const rowTotals = counts.map((r) => r.reduce((a, b) => a + b, 0));
      const columnTotals = colAxis.categories.map((_, j) => counts.reduce((a, r) => a + r[j]!, 0));
      const total = totalRows[0]!.n;
      const pct = (n: number, d: number) => (d ? Math.round((n / d) * 1000) / 10 : 0);
      const warnings: string[] = [];
      let test: CrosstabResult['chiSquare'] = null;
      if (survey.anonymous && total > 0 && total < deps.config.minGroupSize)
        throw unprocessable('group_too_small', `This anonymous survey hides groups of fewer than ${deps.config.minGroupSize} responses.`);
      if (!rowAxis.single || !colAxis.single)
        warnings.push('No chi-square test: a question allows several answers, so the cells overlap.');
      else {
        const result = chiSquare(counts);
        if (!result) warnings.push('No chi-square test: at least two answered categories are needed on each side.');
        else {
          test = { value: result.value, df: result.df, p: Math.round(result.p * 10000) / 10000 };
          if (result.lowExpected > 0.2) warnings.push('Over 20% of cells have an expected count below 5, so the chi-square result is unreliable.');
        }
      }
      return {
        rows: rowAxis.categories,
        columns: colAxis.categories,
        counts,
        rowTotals,
        columnTotals,
        total,
        rowPct: counts.map((r, i) => r.map((n) => pct(n, rowTotals[i]!))),
        columnPct: counts.map((r) => r.map((n, j) => pct(n, columnTotals[j]!))),
        chiSquare: test,
        warnings,
      };
    });
  });

  /** Where respondents stop: per question, how many answered and how many left right after it. */
  app.post<IdParams>('/api/v1/surveys/:id/results/dropoff', async (req): Promise<DropoffByQuestion> => {
    const auth = requireOrg(req);
    const body = parse(DropoffRequest, req.body);
    return withTenant(pool, auth.orgId, async (tx) => {
      const { survey } = await loadSurvey(tx, auth, req.params.id, 'responses.view');
      const versions = await loadVersions(tx, survey.id);
      const version = versions.find((v) => v.id === (body.versionId ?? survey.currentVersionId)) ?? versions[0];
      if (!version) return { started: 0, questions: [], leftBeforeFirst: 0 };
      const base: Filter = {
        from: body.from,
        to: body.to,
        versionId: version.id,
        includeTest: body.includeTest,
        excludeFlagged: body.excludeFlagged,
        filter: body.filter,
        questions: questionIndex(versions, survey.currentVersionId),
      };
      const p1 = new Params();
      const { rows: left } = await tx.client.query<{ key: string | null; n: number }>(
        `select r.last_question_key as key, count(*)::int as n from responses r
          where ${responseConditions(p1, survey.id, { ...base, statuses: ['in_progress'] })} group by 1`,
        p1.values,
      );
      const p2 = new Params();
      const { rows: answered } = await tx.client.query<{ key: string; n: number }>(
        `select a.question_key as key, count(distinct a.response_id)::int as n
           from responses r join answers a on a.survey_id = r.survey_id and a.response_id = r.id
          where ${responseConditions(p2, survey.id, base)} group by 1`,
        p2.values,
      );
      const p3 = new Params();
      const { rows: started } = await tx.client.query<{ n: number }>(
        `select count(*)::int as n from responses r where ${responseConditions(p3, survey.id, base)}`,
        p3.values,
      );
      return {
        started: started[0]!.n,
        leftBeforeFirst: left.find((l) => l.key === null)?.n ?? 0,
        questions: version.definition.pages.flatMap((page) =>
          page.elements
            .filter((e): e is Question => e.kind === 'question')
            .map((q) => ({
              questionKey: q.key,
              title: plainTitle(q),
              pageKey: page.key,
              answered: answered.find((a) => a.key === q.key)?.n ?? 0,
              leftAfter: left.find((l) => l.key === q.key)?.n ?? 0,
            })),
        ),
      };
    });
  });

  /** Most frequent words in a text question (word cloud). Stop words and very short words are skipped. */
  app.get<{ Params: { id: string; questionKey: string } }>(
    '/api/v1/surveys/:id/results/questions/:questionKey/terms',
    async (req): Promise<TermsResult> => {
      const auth = requireOrg(req);
      const query = parse(TermsQuery, req.query);
      const filterJson = parseFilterParam(query.filter);
      return withTenant(pool, auth.orgId, async (tx) => {
        const { survey } = await loadSurvey(tx, auth, req.params.id, 'responses.view');
        await tx.client.query(`set local statement_timeout = '15s'`);
        const versions = await loadVersions(tx, survey.id);
        const questions = questionIndex(versions, survey.currentVersionId);
        const scoped = () => {
          const p = new Params();
          const where = responseConditions(p, survey.id, { includeTest: query.includeTest, statuses: ['completed'], filter: filterJson, questions });
          return { p, where, key: p.add(req.params.questionKey) };
        };
        const t = scoped();
        const { rows } = await tx.client.query<{ term: string; n: number }>(
          `select w as term, count(*)::int as n
             from (
               select distinct a.response_id, w
                 from responses r
                 join answers a on a.survey_id = r.survey_id and a.response_id = r.id
                 cross join lateral regexp_split_to_table(lower(a.value_text), '[^[:alnum:]'']+') as w
                where a.question_key = ${t.key} and a.value_text is not null and ${t.where}
             ) x
            where length(w) between 3 and 40 and w !~ '^[0-9'']+$' and not (w = any(${t.p.add(STOP_WORDS)}::text[]))
            group by 1 order by 2 desc, 1 limit 80`,
          t.p.values,
        );
        const c = scoped();
        const { rows: count } = await tx.client.query<{ n: number }>(
          `select count(*)::int as n from responses r join answers a on a.survey_id = r.survey_id and a.response_id = r.id
            where a.question_key = ${c.key} and a.value_text is not null and ${c.where}`,
          c.p.values,
        );
        return { answered: count[0]!.n, terms: rows.map((r) => ({ term: r.term.replace(/^'+|'+$/g, ''), count: r.n })) };
      });
    },
  );

  app.get<{ Params: { id: string; questionKey: string } }>(
    '/api/v1/surveys/:id/results/questions/:questionKey/text',
    async (req) => {
      const auth = requireOrg(req);
      const query = parse(TextAnswersQuery, req.query);
      return withTenant(pool, auth.orgId, async (tx) => {
        const { survey } = await loadSurvey(tx, auth, req.params.id, 'responses.view');
        const cursor = decodeCursor(query.cursor, 2);
        const p = new Params();
        const { rows } = await tx.client.query<{
          response_id: string;
          value_text: string;
          started_at: Date;
          completed_at: Date | null;
        }>(
          `select a.response_id, a.value_text, r.started_at, r.completed_at
             from answers a join responses r on r.id = a.response_id
            where a.survey_id = ${p.add(survey.id)} and r.survey_id = a.survey_id
              and a.question_key = ${p.add(req.params.questionKey)} and a.value_text is not null
              and r.status = 'completed' and not r.is_test
              ${cursor ? `and (r.started_at, r.id) < (${p.add(cursor[0])}::timestamptz, ${p.add(cursor[1])}::uuid)` : ''}
            order by r.started_at desc, r.id desc
            limit ${p.add(query.limit + 1)}`,
          p.values,
        );
        const page = rows.slice(0, query.limit);
        const last = page.at(-1);
        return {
          data: page.map((r) => ({
            responseId: r.response_id,
            text: r.value_text,
            completedAt: iso(r.completed_at),
          })),
          nextCursor:
            rows.length > query.limit && last
              ? encodeCursor([last.started_at.toISOString(), last.response_id])
              : null,
        };
      });
    },
  );

  // ── Individual responses ──────────────────────────────────────────
  app.get<IdParams>('/api/v1/surveys/:id/responses', async (req) => {
    const auth = requireOrg(req);
    const query = parse(ListResponsesQuery, req.query);
    const filterJson = parseFilterParam(query.filter);
    return withTenant(pool, auth.orgId, async (tx) => {
      const { survey } = await loadSurvey(tx, auth, req.params.id, 'responses.view');
      const cursor = decodeCursor(query.cursor, 2);
      const p = new Params();
      const versionsForFilter = await loadVersions(tx, survey.id);
      const where = responseConditions(p, survey.id, {
        from: query.from,
        to: query.to,
        includeTest: query.includeTest,
        statuses: query.status === 'all' ? undefined : [query.status],
        flag: query.flag,
        q: query.q,
        tag: query.tag,
        filter: filterJson,
        questions: questionIndex(versionsForFilter, survey.currentVersionId),
      });
      const { rows } = await tx.client.query<
        ResponseRow & { version_number: number; distribution_name: string | null }
      >(
        `select r.id, r.status, r.is_test, r.started_at, r.completed_at, r.duration_ms, r.device_type, r.version_id,
                r.quality_flags, r.locale, v.version_number, d.name as distribution_name
           from responses r
           join survey_versions v on v.id = r.version_id
           left join distributions d on d.id = r.distribution_id
          where ${where}
            ${cursor ? `and (r.started_at, r.id) < (${p.add(cursor[0])}::timestamptz, ${p.add(cursor[1])}::uuid)` : ''}
          order by r.started_at desc, r.id desc
          limit ${p.add(query.limit + 1)}`,
        p.values,
      );
      const page = rows.slice(0, query.limit) as unknown as {
        id: string;
        status: ResponseSummary['status'];
        is_test: boolean;
        started_at: Date;
        completed_at: Date | null;
        duration_ms: number | null;
        device_type: string | null;
        version_id: string;
        version_number: number;
        distribution_name: string | null;
        quality_flags: string[];
        locale: string;
      }[];
      const versions = versionsForFilter;
      const cells = await loadCells(
        tx,
        survey.id,
        page.map((r) => r.id),
      );
      const tagRows = await tagsForResponses(tx, page.map((r) => r.id));
      const data: ResponseSummary[] = page.map((r) => {
        const definition = versions.find((v) => v.id === r.version_id)?.definition;
        const first = definition
          ? answerValues(definition, cells.get(r.id) ?? []).find(({ question }) =>
              ['short_text', 'long_text'].includes(question.type),
            )
          : undefined;
        return {
          id: r.id,
          status: r.status,
          isTest: r.is_test,
          startedAt: r.started_at.toISOString(),
          completedAt: iso(r.completed_at),
          durationSec: r.duration_ms === null ? null : Math.round(r.duration_ms / 1000),
          versionNumber: r.version_number,
          distributionName: r.distribution_name,
          deviceType: r.device_type,
          preview: first ? String(first.value).slice(0, 140) : '',
          qualityFlags: r.quality_flags,
          tags: tagRows.filter((t) => t.responseId === r.id).map(({ id, name }) => ({ id, name })),
          locale: r.locale,
        };
      });
      const last = page.at(-1);
      // The total matching the filters (first page only): the viewer shows it and bulk delete confirms it.
      let total: number | undefined;
      if (!cursor) {
        const cp = new Params();
        const countWhere = responseConditions(cp, survey.id, {
          from: query.from,
          to: query.to,
          includeTest: query.includeTest,
          statuses: query.status === 'all' ? undefined : [query.status],
          flag: query.flag,
          q: query.q,
          tag: query.tag,
          filter: filterJson,
          questions: questionIndex(versionsForFilter, survey.currentVersionId),
        });
        total = (await tx.client.query<{ n: number }>(`select count(*)::int as n from responses r where ${countWhere}`, cp.values)).rows[0]!.n;
      }
      return {
        data,
        nextCursor:
          rows.length > query.limit && last ? encodeCursor([last.started_at.toISOString(), last.id]) : null,
        ...(total !== undefined ? { total } : {}),
      };
    });
  });

  app.get<{ Params: { id: string; responseId: string } }>(
    '/api/v1/surveys/:id/responses/:responseId',
    async (req): Promise<ResponseDetail> => {
      const auth = requireOrg(req);
      return withTenant(pool, auth.orgId, async (tx) => {
        const { survey } = await loadSurvey(tx, auth, req.params.id, 'responses.view');
        if (!/^[0-9a-f-]{36}$/i.test(req.params.responseId)) throw notFound('Response');
        const [row] = await tx.db
          .select({
            r: responses,
            versionNumber: surveyVersions.versionNumber,
            definition: surveyVersions.definition,
            distributionName: distributions.name,
          })
          .from(responses)
          .innerJoin(surveyVersions, eq(surveyVersions.id, responses.versionId))
          .leftJoin(distributions, eq(distributions.id, responses.distributionId))
          .where(and(eq(responses.id, req.params.responseId), eq(responses.surveyId, survey.id)));
        if (!row) throw notFound('Response');
        const cells = (await loadCells(tx, survey.id, [row.r.id])).get(row.r.id) ?? [];
        const answers = answerValues(row.definition, cells).map(({ question, value }) => ({
          questionKey: question.key,
          title: plainTitle(question),
          type: question.type,
          value,
          display: displayAnswer(question, value),
        }));
        return {
          id: row.r.id,
          status: row.r.status,
          isTest: row.r.isTest,
          startedAt: row.r.startedAt.toISOString(),
          completedAt: iso(row.r.completedAt),
          durationSec: row.r.durationMs === null ? null : Math.round(row.r.durationMs / 1000),
          versionNumber: row.versionNumber,
          distributionName: row.distributionName,
          deviceType: row.r.deviceType,
          preview: '',
          qualityFlags: row.r.qualityFlags,
          tags: (await tagsForResponses(tx, [row.r.id])).map(({ id, name }) => ({ id, name })),
          notes: (
            await tx.db
              .select({ n: responseNotes, author: users.name })
              .from(responseNotes)
              .leftJoin(users, eq(users.id, responseNotes.authorId))
              .where(eq(responseNotes.responseId, row.r.id))
              .orderBy(responseNotes.createdAt)
          ).map(({ n, author }) => ({ id: n.id, author, authorId: n.authorId, body: n.body, createdAt: n.createdAt.toISOString() })),
          contact: await contactOf(tx, row.r.recipientId),
          respondent: row.r.respondentUserId
            ? ((await tx.db.select({ email: users.email, name: users.name }).from(users).where(eq(users.id, row.r.respondentUserId)))[0] ?? null)
            : null,
          locale: row.r.locale,
          hiddenFields: row.r.hiddenFields,
          answers,
          files: (await filesForResponses(tx, [row.r.id])).map((f) => ({
            id: f.id,
            filename: f.filename,
            size: f.size,
            mime: f.mime,
            scanStatus: f.scanStatus,
            questionKey: f.questionKey,
          })),
        };
      });
    },
  );

  app.delete<{ Params: { id: string; responseId: string } }>(
    '/api/v1/surveys/:id/responses/:responseId',
    async (req, reply) => {
      const auth = requireOrg(req);
      await withTenant(pool, auth.orgId, async (tx) => {
        const { survey } = await loadSurvey(tx, auth, req.params.id, 'responses.delete');
        if (!/^[0-9a-f-]{36}$/i.test(req.params.responseId)) throw notFound('Response');
        const [row] = await tx.db
          .select()
          .from(responses)
          .where(and(eq(responses.id, req.params.responseId), eq(responses.surveyId, survey.id)))
          .for('update');
        if (!row) throw notFound('Response');
        await unaggregateResponse(tx.client, survey.id, row.id);
        const uploads = await filesForResponses(tx, [row.id]);
        await tx.db.delete(responses).where(eq(responses.id, row.id));
        if (uploads.length) await deps.jobs.enqueue(tx, 'files.delete-objects', { keys: uploads.map((f) => f.storageKey) });
        if (row.status === 'completed' && !row.isTest)
          await tx.client.query(
            'update surveys set completed_count = greatest(completed_count - 1, 0) where id = $1',
            [survey.id],
          );
        await audit(tx, {
          orgId: auth.orgId,
          actorId: auth.userId,
          action: 'response.deleted',
          entityType: 'response',
          entityId: row.id,
          metadata: { surveyId: survey.id, status: row.status },
          ip: req.ip,
        });
      });
      return reply.code(204).send();
    },
  );

  // ── CSV export (streamed in keyset-paginated batches) ─────────────
  app.get<IdParams>('/api/v1/surveys/:id/export.csv', async (req, reply) => {
    const auth = requireOrg(req);
    const query = parse(ExportQuery, req.query);
    const survey = await withTenant(pool, auth.orgId, async (tx) => {
      const { survey } = await loadSurvey(tx, auth, req.params.id, 'responses.export');
      await audit(tx, {
        orgId: auth.orgId,
        actorId: auth.userId,
        action: 'responses.exported',
        entityType: 'survey',
        entityId: survey.id,
        metadata: { format: 'csv', ...query },
        ip: req.ip,
      });
      return survey;
    });
    // Same rows as the XLSX export (export-data.ts), streamed in batches of 1,000.
    async function* csv(): AsyncGenerator<string> {
      let first = true;
      for await (const rows of exportRows(pool, auth.orgId, survey, query)) {
        yield (first ? UTF8_BOM : '') + rows.map((r) => csvRow(r)).join('');
        first = false;
      }
    }
    const filename = `${slugify(survey.title) || 'survey'}-responses.csv`;
    reply
      .header('content-type', 'text/csv; charset=utf-8')
      .header('content-disposition', `attachment; filename="${filename}"`)
      .header('cache-control', 'no-store');
    return reply.send(Readable.from(csv()));
  });
}

export interface RawResponse {
  id: string;
  status: string;
  is_test: boolean;
  started_at: Date;
  completed_at: Date | null;
  duration_ms: number | null;
  device_type: string | null;
  distribution_id: string | null;
  hidden_fields: Record<string, string>;
  quality_flags: string[];
}

export interface ExportColumn {
  header: string;
  value: (r: RawResponse, answers: Map<string, AnswerValue>, version: VersionInfo | undefined) => unknown;
}

export function buildExportColumns(
  versions: VersionInfo[],
  currentVersionId: string | null,
  links: { id: string; name: string; presetHiddenFields: Record<string, string> }[],
  layout: 'compact' | 'expanded',
  includeTest: boolean,
  fileNames: Map<string, string> = new Map(),
): ExportColumn[] {
  const columns: ExportColumn[] = [
    { header: 'response_id', value: (r) => r.id },
    { header: 'status', value: (r) => r.status },
    { header: 'started_at', value: (r) => r.started_at.toISOString() },
    { header: 'completed_at', value: (r) => r.completed_at?.toISOString() ?? '' },
    {
      header: 'duration_sec',
      value: (r) => (r.duration_ms === null ? '' : Math.round(r.duration_ms / 1000)),
    },
    { header: 'version', value: (_r, _a, v) => v?.versionNumber ?? '' },
    { header: 'distribution', value: (r) => links.find((l) => l.id === r.distribution_id)?.name ?? '' },
    { header: 'device_type', value: (r) => r.device_type ?? '' },
    { header: 'quality_flags', value: (r) => [...r.quality_flags].sort().join(' ') },
  ];
  if (includeTest) columns.push({ header: 'is_test', value: (r) => (r.is_test ? 1 : 0) });

  const hiddenKeys = new Set<string>();
  for (const v of versions) for (const f of v.definition.hiddenFields) hiddenKeys.add(f.key);
  for (const l of links) for (const k of Object.keys(l.presetHiddenFields)) hiddenKeys.add(k);
  for (const key of hiddenKeys)
    columns.push({ header: `hidden:${key}`, value: (r) => r.hidden_fields[key] ?? '' });

  const union = questionUnion(versions, currentVersionId);
  const titleCounts = new Map<string, number>();
  for (const { question } of union)
    titleCounts.set(plainTitle(question), (titleCounts.get(plainTitle(question)) ?? 0) + 1);
  for (const { question } of union) {
    const title = plainTitle(question);
    const header = (titleCounts.get(title) ?? 0) > 1 ? `${title} [${question.key}]` : title;
    const hasOther = 'options' in question && question.options.some((o) => o.isOther);

    if (question.type === 'matrix') {
      for (const row of question.rows) {
        columns.push({
          header: `${header} - ${row.label}`,
          value: (_r, answers) => {
            const value = answers.get(question.key) as Record<string, string | string[]> | undefined;
            const cell = value?.[row.key];
            if (cell === undefined) return '';
            return (Array.isArray(cell) ? cell : [cell]).map((c) => question.options.find((o) => o.key === c)?.label ?? c).join('; ');
          },
        });
      }
      continue;
    }
    if (question.type === 'ranking') {
      for (const option of question.options) {
        columns.push({
          header: `${header} - ${option.label} (rank)`,
          value: (_r, answers) => {
            const value = answers.get(question.key);
            const rank = Array.isArray(value) ? value.indexOf(option.key) : -1;
            return rank === -1 ? '' : rank + 1;
          },
        });
      }
      continue;
    }
    if (question.type === 'file_upload') {
      columns.push({
        header,
        value: (_r, answers) => {
          const value = answers.get(question.key);
          return Array.isArray(value) ? value.map((id) => fileNames.get(id) ?? id).join('; ') : '';
        },
      });
      continue;
    }
    if (question.type === 'slider' || question.type === 'consent') {
      columns.push({
        header,
        value: (_r, answers) => {
          const value = answers.get(question.key);
          return value === undefined ? '' : question.type === 'consent' ? (value === true ? 'yes' : '') : value;
        },
      });
      continue;
    }
    if (question.type === 'multi_choice' && layout === 'expanded') {
      for (const option of question.options) {
        columns.push({
          header: `${header} - ${option.label}`,
          value: (_r, answers) => {
            const value = answers.get(question.key);
            if (value === undefined) return '';
            return selectedOptionKeys(value).includes(option.key) ? 1 : 0;
          },
        });
      }
    } else if ('options' in question) {
      columns.push({
        header,
        value: (_r, answers) => {
          const value = answers.get(question.key);
          if (value === undefined) return '';
          return selectedOptionKeys(value)
            .map((key) => question.options.find((o) => o.key === key)?.label ?? key)
            .join('; ');
        },
      });
    } else {
      columns.push({
        header,
        value: (_r, answers) => displayAnswer(question, answers.get(question.key) ?? null),
      });
    }
    if (hasOther)
      columns.push({
        header: `${header} - Other`,
        value: (_r, answers) => otherText(answers.get(question.key) ?? null) ?? '',
      });
  }
  return columns;
}
