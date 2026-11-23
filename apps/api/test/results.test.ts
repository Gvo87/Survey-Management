import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createOption, createQuestion, type Question, type SurveyDefinition } from '@survey/core';
import { aggregateResponse, rebuildSurveyAggregates, withTenant } from '@survey/db';
import {
  createTestContext,
  drainJobs,
  publishedSurvey,
  Respondent,
  signup,
  type Client,
  type TestContext,
} from './helpers';

let ctx: TestContext;
let admin: Client;
let surveyId: string;
let publicId: string;
let q: Record<
  'single' | 'multi' | 'dropdown' | 'likert' | 'rating' | 'nps' | 'short' | 'long' | 'email' | 'date',
  Question
>;
const N = 12;
const NPS = [10, 9, 9, 8, 7, 6, 0, 3, 10, 9, 5, 8];

const opts = (question: Question) => ('options' in question ? question.options.map((o) => o.key) : []);

function answersFor(i: number): Record<string, unknown> {
  const single = opts(q.single);
  return {
    [q.single.key]:
      i % 4 === 3
        ? { option: single[3], other: i === 3 ? '=HYPERLINK("http://evil.example")' : 'Teal' }
        : single[i % 3],
    [q.multi.key]: i % 2 ? [opts(q.multi)[0], opts(q.multi)[1]] : [opts(q.multi)[0]],
    [q.dropdown.key]: opts(q.dropdown)[i % 2],
    [q.likert.key]: opts(q.likert)[i % 5],
    [q.rating.key]: (i % 5) + 1,
    [q.nps.key]: NPS[i],
    [q.short.key]: i === 0 ? '日本語のテキスト, "quoted"' : `answer ${i}`,
    ...(i < 6 ? { [q.long.key]: `long answer ${i}` } : {}),
    [q.email.key]: `person${i}@example.com`,
    [q.date.key]: `2026-03-0${(i % 3) + 1}`,
  };
}

beforeAll(async () => {
  ctx = await createTestContext();
  admin = await signup(ctx.app);
  const single = createQuestion('single_choice', 'Favourite colour');
  if ('options' in single)
    single.options = [
      createOption('Red'),
      createOption('Green'),
      createOption('Blue'),
      createOption('Other', { isOther: true }),
    ];
  q = {
    single,
    multi: createQuestion('multi_choice', 'Channels'),
    dropdown: createQuestion('dropdown', 'Region'),
    likert: createQuestion('likert', 'It was easy'),
    rating: createQuestion('rating', 'Rate us'),
    nps: createQuestion('nps', 'Recommend?'),
    short: createQuestion('short_text', 'Name'),
    long: createQuestion('long_text', 'Comments'),
    email: createQuestion('email', 'Email'),
    date: createQuestion('date', 'Visit date'),
  };
  const def: SurveyDefinition = {
    schemaVersion: 1,
    defaultLocale: 'en',
    hiddenFields: [{ key: 'source' }],
    settings: { showProgressBar: true, allowBack: true, thankYou: { title: 'Thanks', body: '' } },
    pages: [
      { key: 'p_page0000', elements: [q.single, q.multi, q.dropdown, q.likert, q.rating, q.nps] },
      { key: 'p_page0001', elements: [q.short, q.long, q.email, q.date] },
    ],
  };
  const { survey } = await publishedSurvey(admin, def, 'Results fixture');
  surveyId = survey.id;
  publicId = survey.publicId;
  for (let i = 0; i < N; i++) {
    const r = await new Respondent(ctx.app, publicId).complete(answersFor(i), {
      start: { hiddenFields: { source: i % 2 ? 'email' : 'web' } },
    });
    if (r.status !== 200) throw new Error(JSON.stringify(r.body));
  }
  // One respondent who stopped on page 1.
  await new Respondent(ctx.app, publicId).save({ [q.nps.key]: 10, [q.single.key]: opts(q.single)[0] });
  await drainJobs(ctx);
}, 60_000);
afterAll(async () => ctx.close());

const summary = (query = '') => admin.get(`/api/v1/surveys/${surveyId}/results/summary${query}`);
const question = (body: any, key: string) =>
  body.questions.find((x: { questionKey: string }) => x.questionKey === key);

describe('results summary', () => {
  it('computes totals and drop-off', async () => {
    const { body } = await summary();
    expect(body.source).toBe('aggregate');
    expect(body.totals).toMatchObject({
      started: N + 1,
      completed: N,
      completionRate: Number((N / (N + 1)).toFixed(4)),
    });
    expect(body.totals.avgDurationSec).toBeGreaterThanOrEqual(0);
    expect(body.dropoff).toEqual([
      { pageKey: 'p_page0000', title: 'Page 1', reached: N + 1, abandonedHere: 1 },
      { pageKey: 'p_page0001', title: 'Page 2', reached: N, abandonedHere: 0 },
    ]);
  });

  it('pre-aggregated and live computations agree exactly', async () => {
    const aggregate = await summary();
    const live = await summary('?from=2000-01-01T00:00:00Z');
    expect(live.body.source).toBe('live');
    expect(live.body.questions).toEqual(aggregate.body.questions);
    expect(live.body.totals).toEqual(aggregate.body.totals);
  });

  it('summarises each question type', async () => {
    const { body } = await summary();
    const nps = question(body, q.nps.key);
    const promoters = NPS.filter((v) => v >= 9).length;
    const detractors = NPS.filter((v) => v <= 6).length;
    expect(nps).toMatchObject({
      type: 'nps',
      answered: N,
      promoters,
      detractors,
      passives: N - promoters - detractors,
    });
    expect(nps.score).toBe(Math.round(((promoters - detractors) / N) * 100));

    const rating = question(body, q.rating.key);
    const values = Array.from({ length: N }, (_, i) => (i % 5) + 1);
    expect(rating.mean).toBeCloseTo(values.reduce((a, b) => a + b) / N, 2);
    expect(rating.distribution).toHaveLength(5);

    const single = question(body, q.single.key);
    expect(single.answered).toBe(N);
    expect(single.otherCount).toBe(N / 4);
    expect(single.options.reduce((s: number, o: { count: number }) => s + o.count, 0)).toBe(N);

    const multi = question(body, q.multi.key);
    expect(multi.options[0]).toMatchObject({ count: N, pct: 100 });
    expect(multi.options[1]).toMatchObject({ count: N / 2, pct: 50 });

    expect(question(body, q.likert.key).mean).not.toBeNull();
    expect(question(body, q.date.key).byDay).toEqual([
      { date: '2026-03-01', count: 4 },
      { date: '2026-03-02', count: 4 },
      { date: '2026-03-03', count: 4 },
    ]);
    expect(question(body, q.long.key).answered).toBe(6);
    expect(question(body, q.short.key).latest).toHaveLength(5);
  });

  it('includes partial responses when asked', async () => {
    const { body } = await summary('?includePartial=true');
    expect(question(body, q.nps.key).answered).toBe(N + 1);
  });

  it('filters by date range', async () => {
    const future = await summary(
      `?from=${encodeURIComponent(new Date(Date.now() + 3600_000).toISOString())}`,
    );
    expect(future.body.totals.started).toBe(0);
    expect(question(future.body, q.nps.key).answered).toBe(0);
  });
});

describe('aggregation jobs', () => {
  it('counting a response twice has no effect (idempotent), and a rebuild matches', async () => {
    const before = (await summary()).body.questions;
    const { rows } = await ctx.owner.query(
      `select id, org_id from responses where survey_id = $1 and status = 'completed' limit 1`,
      [surveyId],
    );
    const added = await withTenant(ctx.deps.pool, rows[0].org_id, (tx) =>
      aggregateResponse(tx.client, surveyId, rows[0].id),
    );
    expect(added).toBe(false);
    expect((await summary()).body.questions).toEqual(before);

    await withTenant(ctx.deps.pool, rows[0].org_id, (tx) => rebuildSurveyAggregates(tx.client, surveyId));
    expect((await summary()).body.questions).toEqual(before);
  });
});

describe('individual responses', () => {
  it('pages through responses and shows labelled answers', async () => {
    const page1 = await admin.get(`/api/v1/surveys/${surveyId}/responses?limit=5`);
    expect(page1.body.data).toHaveLength(5);
    expect(page1.body.nextCursor).toBeTruthy();
    const page2 = await admin.get(
      `/api/v1/surveys/${surveyId}/responses?limit=5&cursor=${page1.body.nextCursor}`,
    );
    expect(page2.body.data[0].id).not.toBe(page1.body.data[4].id);

    const partial = await admin.get(`/api/v1/surveys/${surveyId}/responses?status=in_progress`);
    expect(partial.body.data).toHaveLength(1);

    const completed = await admin.get(`/api/v1/surveys/${surveyId}/responses?status=completed&limit=1`);
    const detail = await admin.get(`/api/v1/surveys/${surveyId}/responses/${completed.body.data[0].id}`);
    expect(detail.body.answers.length).toBeGreaterThan(5);
    expect(detail.body.hiddenFields).toHaveProperty('source');
    const single = detail.body.answers.find((a: { questionKey: string }) => a.questionKey === q.single.key);
    expect(['Red', 'Green', 'Blue', 'Other: Teal', 'Other: =HYPERLINK("http://evil.example")']).toContain(
      single.display,
    );
  });

  it('pages through text answers', async () => {
    const first = await admin.get(
      `/api/v1/surveys/${surveyId}/results/questions/${q.short.key}/text?limit=5`,
    );
    expect(first.body.data).toHaveLength(5);
    const rest = await admin.get(
      `/api/v1/surveys/${surveyId}/results/questions/${q.short.key}/text?limit=50&cursor=${first.body.nextCursor}`,
    );
    expect(first.body.data.length + rest.body.data.length).toBe(N);
    expect(rest.body.nextCursor).toBeNull();
  });
});

describe('CSV export', () => {
  it('exports one row per response with safe, Excel-friendly cells', async () => {
    const res = await admin.get(`/api/v1/surveys/${surveyId}/export.csv`);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/csv');
    expect(res.headers['content-disposition']).toContain('results-fixture-responses.csv');
    expect(res.raw.startsWith('﻿')).toBe(true);

    const lines = res.raw.slice(1).trim().split('\r\n');
    expect(lines).toHaveLength(N + 1); // header + completed responses only
    const header = lines[0]!;
    expect(header).toContain(
      'response_id,status,started_at,completed_at,duration_sec,version,distribution,device_type,hidden:source',
    );
    expect(header).toContain('Favourite colour,Favourite colour - Other');
    expect(res.raw).toContain('"日本語のテキスト, ""quoted"""');
    // Formula injection: the cell is prefixed with an apostrophe.
    expect(res.raw).toContain(`"'=HYPERLINK(""http://evil.example"")"`);
    expect(res.raw).not.toMatch(/,=HYPERLINK/);
  });

  it('expanded layout gives one 0/1 column per multi-choice option', async () => {
    const res = await admin.get(`/api/v1/surveys/${surveyId}/export.csv?layout=expanded&status=all`);
    const lines = res.raw.slice(1).trim().split('\r\n');
    expect(lines).toHaveLength(N + 2);
    expect(lines[0]).toContain('Channels - Option 1,Channels - Option 2,Channels - Option 3');
  });

  it('writes an audit entry for every export', async () => {
    const { rows } = await ctx.owner.query(
      `select count(*)::int as n from audit_logs where action = 'responses.exported' and entity_id = $1`,
      [surveyId],
    );
    expect(rows[0].n).toBeGreaterThanOrEqual(2);
  });
});

describe('deleting a response', () => {
  it('removes it from counts immediately', async () => {
    const before = await summary();
    const list = await admin.get(`/api/v1/surveys/${surveyId}/responses?status=completed&limit=1`);
    expect((await admin.delete(`/api/v1/surveys/${surveyId}/responses/${list.body.data[0].id}`)).status).toBe(
      204,
    );

    const after = await summary();
    expect(after.body.totals.completed).toBe(before.body.totals.completed - 1);
    expect(question(after.body, q.nps.key).answered).toBe(N - 1);
    expect((await summary('?from=2000-01-01T00:00:00Z')).body.questions).toEqual(after.body.questions);
    expect((await admin.get(`/api/v1/surveys/${surveyId}`)).body.completedCount).toBe(N - 1);
    const { rows } = await ctx.owner.query(
      `select count(*)::int as n from audit_logs where action = 'response.deleted'`,
    );
    expect(rows[0].n).toBe(1);
  });
});
