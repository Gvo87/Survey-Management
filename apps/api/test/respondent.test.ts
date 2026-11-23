import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createQuestion } from '@survey/core';
import {
  createTestContext,
  definitionWith,
  newResponseKey,
  publishedSurvey,
  Respondent,
  saveDraft,
  createSurvey,
  signup,
  type Client,
  type TestContext,
} from './helpers';

let ctx: TestContext;
let admin: Client;
beforeAll(async () => {
  ctx = await createTestContext();
  admin = await signup(ctx.app);
});
beforeEach(async () => {
  await ctx.deps.redis.flushdb(); // rate-limit counters
});
afterAll(async () => ctx.close());

const keys = (def: ReturnType<typeof definitionWith>) =>
  def.pages.flatMap((p) => p.elements.map((e) => e.key));

async function responseRows(surveyId: string) {
  const { rows } = await ctx.owner.query(`select * from responses where survey_id = $1 order by started_at`, [
    surveyId,
  ]);
  return rows;
}

async function twoPageSurvey(title = 'Two pages') {
  const def = definitionWith(['short_text'], ['rating']);
  const rating = def.pages[1]!.elements[0]!;
  if (rating.kind === 'question') rating.required = true;
  const published = await publishedSurvey(admin, def, title);
  const [text, rate] = keys(def);
  return { ...published, text: text!, rate: rate! };
}

describe('protocol and idempotency', () => {
  it('requires a well-formed response key', async () => {
    const { survey } = await twoPageSurvey();
    const res = await ctx.app.inject({
      method: 'PUT',
      url: `/r/v1/s/${survey.publicId}/response`,
      payload: JSON.stringify({ seq: 1, answers: {}, currentPageKey: 'p_page0000' }),
      headers: { 'content-type': 'application/json', 'x-response-key': 'short' },
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().code).toBe('invalid_response_key');
  });

  it('refuses a first save without start metadata', async () => {
    const { survey } = await twoPageSurvey();
    const res = await ctx.app.inject({
      method: 'PUT',
      url: `/r/v1/s/${survey.publicId}/response`,
      payload: JSON.stringify({ seq: 1, answers: {}, currentPageKey: 'p_page0000' }),
      headers: { 'content-type': 'application/json', 'x-response-key': newResponseKey() },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe('not_started');
  });

  it('replaying the same save or completion creates exactly one response', async () => {
    const { survey, text, rate } = await twoPageSurvey();
    const r = new Respondent(ctx.app, survey.publicId);
    expect((await r.save({ [text]: 'hi' })).body).toEqual({ applied: true, seq: 1 });
    r.seq--; // network retry of the same request
    expect((await r.save({ [text]: 'hi' })).body).toEqual({ applied: false, seq: 1 });

    const first = await r.complete({ [text]: 'hi', [rate]: 4 });
    r.seq--;
    const replay = await r.complete({ [text]: 'hi', [rate]: 4 });
    expect(first.status).toBe(200);
    expect(replay.status).toBe(200);
    expect(replay.body).toEqual(first.body);

    const rows = await responseRows(survey.id);
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe('completed');
    const { rows: s } = await ctx.owner.query('select completed_count from surveys where id = $1', [
      survey.id,
    ]);
    expect(s[0].completed_count).toBe(1);
  });

  it('ignores out-of-order (stale) saves and treats each save as a full snapshot', async () => {
    const { survey, text } = await twoPageSurvey();
    const r = new Respondent(ctx.app, survey.publicId);
    r.seq = 4;
    await r.save({ [text]: 'newest' }); // seq 5
    r.seq = 2;
    const stale = await r.save({ [text]: 'older' }); // seq 3 arrives late
    expect(stale.body.applied).toBe(false);
    expect((await r.load()).body.resume.answers).toEqual({ [text]: 'newest' });

    r.seq = 10;
    await r.save({ [text]: null }); // cleared
    expect((await r.load()).body.resume.answers).toEqual({});
  });

  it('rejects saves after completion', async () => {
    const { survey, text, rate } = await twoPageSurvey();
    const r = new Respondent(ctx.app, survey.publicId);
    await r.complete({ [text]: 'x', [rate]: 3 });
    const res = await r.save({ [text]: 'changed' });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('already_completed');
  });
});

describe('server-side validation', () => {
  it('rejects malformed answers and unknown questions', async () => {
    const { survey, rate } = await twoPageSurvey();
    const bad = await new Respondent(ctx.app, survey.publicId).save({ [rate]: 99 });
    expect(bad.status).toBe(422);
    expect(bad.body.errors[0]).toMatchObject({ path: rate, code: 'out_of_range' });
    const unknown = await new Respondent(ctx.app, survey.publicId).save({ q_injected1: 'x' });
    expect(unknown.status).toBe(422);
    expect(unknown.body.errors[0].code).toBe('unknown_question');
  });

  it('refuses to complete without required answers even if the client skips validation, and keeps the saved answers', async () => {
    const { survey, text, rate } = await twoPageSurvey();
    const r = new Respondent(ctx.app, survey.publicId);
    const res = await r.complete({ [text]: 'only page one' });
    expect(res.status).toBe(422);
    expect(res.body.errors).toEqual([
      expect.objectContaining({ path: rate, code: 'required', pageKey: 'p_page0001' }),
    ]);
    const resumed = await r.load();
    expect(resumed.body.resume).toMatchObject({
      status: 'in_progress',
      answers: { [text]: 'only page one' },
    });
    expect((await r.complete({ [text]: 'only page one', [rate]: 5 })).status).toBe(200);
  });
});

describe('abuse protection', () => {
  it('silently drops honeypot submissions', async () => {
    const { survey, text, rate } = await twoPageSurvey();
    const res = await new Respondent(ctx.app, survey.publicId).complete(
      { [text]: 'spam', [rate]: 5 },
      { hp: 'http://spam.example' },
    );
    expect(res.status).toBe(200);
    expect(res.body.responseStatus).toBe('completed');
    expect(await responseRows(survey.id)).toHaveLength(0);
  });

  it('limits new responses per IP per survey', async () => {
    const { survey, text } = await twoPageSurvey();
    const statuses: number[] = [];
    for (let i = 0; i < 21; i++)
      statuses.push(
        (await new Respondent(ctx.app, survey.publicId, { ip: '203.0.113.7' }).save({ [text]: `r${i}` }))
          .status,
      );
    expect(statuses.slice(0, 20).every((s) => s === 200)).toBe(true);
    expect(statuses[20]).toBe(429);
    expect(
      (await new Respondent(ctx.app, survey.publicId, { ip: '203.0.113.8' }).save({ [text]: 'other ip' }))
        .status,
    ).toBe(200);
  });
});

describe('closing, quotas and links', () => {
  it('stops new respondents when closed but lets in-progress ones finish', async () => {
    const { survey, text, rate } = await twoPageSurvey();
    const inFlight = new Respondent(ctx.app, survey.publicId);
    await inFlight.save({ [text]: 'started before close' });
    await admin.post(`/api/v1/surveys/${survey.id}/close`);

    const late = new Respondent(ctx.app, survey.publicId);
    expect((await late.load()).body.access).toEqual({ state: 'closed', message: 'This survey is closed.' });
    const blocked = await late.save({ [text]: 'too late' });
    expect(blocked.status).toBe(410);
    expect(blocked.body.code).toBe('survey_closed');

    expect((await inFlight.load()).body.access.state).toBe('open');
    expect((await inFlight.complete({ [text]: 'started before close', [rate]: 2 })).status).toBe(200);
  });

  it('closes automatically when the quota is reached', async () => {
    const { survey, text, rate } = await twoPageSurvey();
    await admin.patch(`/api/v1/surveys/${survey.id}`, { access: { quota: 2 } });
    const third = new Respondent(ctx.app, survey.publicId);
    await third.save({ [text]: 'in progress' });
    for (let i = 0; i < 2; i++)
      await new Respondent(ctx.app, survey.publicId).complete({ [text]: 'x', [rate]: 1 });

    const detail = await admin.get(`/api/v1/surveys/${survey.id}`);
    expect(detail.body).toMatchObject({ status: 'closed', closedReason: 'quota', completedCount: 2 });
    const newcomer = await new Respondent(ctx.app, survey.publicId).save({ [text]: 'x' });
    expect(newcomer.status).toBe(410);
    expect(newcomer.body.code).toBe('quota_reached');
    expect((await third.complete({ [text]: 'in progress', [rate]: 1 })).status).toBe(200); // small, deliberate overrun
  });

  it('attributes responses to named links, applies presets and honours disabled links', async () => {
    const def = definitionWith(['short_text']);
    def.hiddenFields = [{ key: 'source' }, { key: 'customer_id' }];
    const { survey } = await publishedSurvey(admin, def);
    const link = await admin.post(`/api/v1/surveys/${survey.id}/distributions`, {
      channel: 'link',
      name: 'Newsletter',
      presetHiddenFields: { source: 'newsletter' },
    });
    expect(link.body.url).toMatch(/\?d=/);
    const token = new URL(link.body.url).searchParams.get('d')!;

    const r = new Respondent(ctx.app, survey.publicId, { query: `?d=${token}` });
    await r.save(
      {},
      {
        start: {
          distributionToken: token,
          hiddenFields: { source: 'tampered', customer_id: 'C-42', evil: 'x' },
        },
      },
    );
    const [row] = await responseRows(survey.id);
    expect(row.distribution_id).toBe(link.body.id);
    expect(row.hidden_fields).toEqual({ source: 'newsletter', customer_id: 'C-42' });

    await admin.delete(`/api/v1/distributions/${link.body.id}`);
    const fresh = new Respondent(ctx.app, survey.publicId, { query: `?d=${token}` });
    expect((await fresh.load()).body.access).toEqual({
      state: 'closed',
      message: 'This link is no longer active.',
    });
    expect((await fresh.save({}, { start: { distributionToken: token } })).status).toBe(410);
  });
});

describe('metadata, test responses and anonymity', () => {
  it('records a coarse device type', async () => {
    const { survey } = await twoPageSurvey();
    await new Respondent(ctx.app, survey.publicId, {
      userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0) Mobile/15E148',
    }).save({});
    expect((await responseRows(survey.id))[0].device_type).toBe('mobile');
  });

  it('flags responses from the test link and keeps them out of counts', async () => {
    const { survey, text, rate } = await twoPageSurvey();
    const detail = await admin.get(`/api/v1/surveys/${survey.id}`);
    const testToken = new URL(detail.body.testUrl).searchParams.get('test')!;
    await new Respondent(ctx.app, survey.publicId).complete(
      { [text]: 't', [rate]: 1 },
      { start: { testToken } },
    );
    await new Respondent(ctx.app, survey.publicId).complete(
      { [text]: 't', [rate]: 1 },
      { start: { testToken: 'forged' } },
    );
    const rows = await responseRows(survey.id);
    expect(rows.map((r) => r.is_test).sort()).toEqual([false, true]);
    expect((await admin.get(`/api/v1/surveys/${survey.id}`)).body.completedCount).toBe(1);
  });

  it('stores nothing identifying in anonymous surveys', async () => {
    const survey = await createSurvey(admin, 'Anonymous pulse');
    await admin.patch(`/api/v1/surveys/${survey.id}`, { anonymous: true });
    const def = definitionWith(['nps', 'long_text']);
    def.hiddenFields = [{ key: 'team', nonIdentifying: true }, { key: 'employee_id' }];
    const saved = await saveDraft(admin, survey.id, def);
    const pub = await admin.post(`/api/v1/surveys/${survey.id}/publish`, { revision: saved.body.revision });
    expect(pub.status).toBe(200);
    const [nps, text] = keys(def);

    const r = new Respondent(ctx.app, survey.publicId);
    const loaded = await r.load();
    expect(loaded.body.survey.anonymous).toBe(true);
    const done = await r.complete(
      { [nps!]: 8, [text!]: 'fine' },
      { start: { hiddenFields: { team: 'blue', employee_id: 'E-1' } } },
    );
    expect(done.status).toBe(200);

    const [row] = await responseRows(survey.id);
    expect(row.hidden_fields).toEqual({ team: 'blue' });
    expect(row.recipient_id).toBeNull();
    expect(row.respondent_user_id).toBeNull();
    expect(row.country).toBeNull();
    for (const ts of [row.started_at, row.completed_at, row.last_activity_at] as Date[]) {
      expect(ts.getUTCMinutes()).toBe(0);
      expect(ts.getUTCSeconds()).toBe(0);
    }
    expect(row.duration_ms).toBeGreaterThanOrEqual(0); // measured via a short-lived Redis key, not stored timestamps

    await expect(
      ctx.owner.query(`update responses set country = 'FR' where id = $1`, [row.id]),
    ).rejects.toThrow(/anonymous/);
  });
});

describe('resume', () => {
  it('returns the saved answers and page for the same response key', async () => {
    const { survey, text, versionId } = await twoPageSurvey();
    const r = new Respondent(ctx.app, survey.publicId);
    await r.save({ [text]: 'halfway' }, { currentPageKey: 'p_page0001' });
    const res = await ctx.app.inject({
      method: 'GET',
      url: `/r/v1/s/${survey.publicId}/response`,
      headers: { 'x-response-key': r.key },
    });
    expect(res.json()).toEqual({
      versionId,
      status: 'in_progress',
      currentPageKey: 'p_page0001',
      seq: 1,
      answers: { [text]: 'halfway' },
      hiddenFields: {},
    });
    const other = await ctx.app.inject({
      method: 'GET',
      url: `/r/v1/s/${survey.publicId}/response`,
      headers: { 'x-response-key': newResponseKey() },
    });
    expect(other.statusCode).toBe(404);
  });

  it('normalises answers server-side on completion', async () => {
    const def = definitionWith([createQuestion('email', 'Email'), createQuestion('multi_choice', 'Pick')]);
    const [email, multi] = def.pages[0]!.elements as { key: string; options?: { key: string }[] }[];
    const { survey } = await publishedSurvey(admin, def);
    const r = new Respondent(ctx.app, survey.publicId);
    const opts = multi!.options!.map((o) => o.key);
    await r.complete({ [email!.key]: '  Mixed@Case.COM ', [multi!.key]: [opts[2], opts[0]] });
    const responses = await admin.get(`/api/v1/surveys/${survey.id}/responses`);
    const detail = await admin.get(`/api/v1/surveys/${survey.id}/responses/${responses.body.data[0].id}`);
    expect(detail.body.answers.map((a: { value: unknown }) => a.value)).toEqual([
      'mixed@case.com',
      [opts[0], opts[2]],
    ]);
    expect(detail.body.answers[1].display).toBe('Option 1; Option 3');
  });
});
