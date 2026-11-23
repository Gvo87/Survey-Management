/**
 * Phase 2A through the API: logic (shared vectors), disqualification, piping and redirects,
 * password / open date / CAPTCHA access, uploads with malware scanning, themes, templates,
 * the question bank, quality flags and results for the new question types.
 */
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createDefinition,
  createQuestion,
  listQuestions,
  type Question,
  type SurveyDefinition,
} from '@survey/core';
import { EICAR } from '../src/infra/scanner';
import {
  addMember,
  createSurvey,
  createTestContext,
  definitionWith,
  drainJobs,
  publishedSurvey,
  Respondent,
  saveDraft,
  signup,
  TINY_PNG,
  type Client,
  type TestContext,
} from './helpers';

let ctx: TestContext;
let admin: Client;

beforeAll(async () => {
  ctx = await createTestContext();
  admin = await signup(ctx.app);
}, 60_000);
afterAll(async () => ctx.close());

const keyHash = (r: Respondent) => createHash('sha256').update(r.key).digest();

async function responseRow(r: Respondent) {
  const { rows } = await ctx.owner.query<{ id: string; status: string; quality_flags: string[] }>(
    'select id, status, quality_flags from responses where response_key_hash = $1',
    [keyHash(r)],
  );
  return rows[0];
}

async function storedKeys(r: Respondent): Promise<string[]> {
  const { rows } = await ctx.owner.query<{ question_key: string }>(
    `select distinct a.question_key from answers a join responses r on r.id = a.response_id
      where r.response_key_hash = $1 order by 1`,
    [keyHash(r)],
  );
  return rows.map((r) => r.question_key);
}

/** Pretend the respondent started 10 minutes ago, so completion isn't flagged as too fast. */
async function backdate(r: Respondent) {
  await ctx.owner.query(`update responses set started_at = now() - interval '10 minutes' where response_key_hash = $1`, [keyHash(r)]);
}

// ── Logic ──────────────────────────────────────────────────────────────────
interface Vector {
  name: string;
  hidden?: Record<string, string>;
  answers: Record<string, unknown>;
  expect: { ok: boolean; outcome: 'completed' | 'disqualified'; path: string[]; answeredKeys: string[]; errors: string[] };
}
const vectors = JSON.parse(
  readFileSync(new URL('../../../packages/survey-core/test-vectors/logic.json', import.meta.url), 'utf8'),
) as { definition: SurveyDefinition; cases: Vector[] };

describe('logic: shared test vectors through the API', () => {
  let publicId: string;
  let surveyId: string;

  beforeAll(async () => {
    const { survey } = await publishedSurvey(admin, vectors.definition, 'Logic vectors');
    publicId = survey.publicId;
    surveyId = survey.id;
  });

  for (const [i, vector] of vectors.cases.entries()) {
    it(vector.name, async () => {
      const r = new Respondent(ctx.app, publicId, { ip: `10.20.0.${i + 1}` });
      const res = await r.complete(vector.answers, { start: { hiddenFields: vector.hidden ?? {} } });
      if (vector.expect.ok) {
        expect(res.status, JSON.stringify(res.body)).toBe(200);
        expect(res.body.responseStatus).toBe(vector.expect.outcome);
        // Answers on skipped pages or hidden questions are dropped on completion.
        expect(await storedKeys(r)).toEqual([...vector.expect.answeredKeys].sort());
        expect((await responseRow(r))!.status).toBe(vector.expect.outcome);
      } else {
        expect(res.status).toBe(422);
        expect(res.body.errors.map((e: { path: string }) => e.path).sort()).toEqual(vector.expect.errors);
        expect((await responseRow(r))!.status).toBe('in_progress');
      }
    });
  }

  it('disqualified responses show the screen-out message and are not counted', async () => {
    const r = new Respondent(ctx.app, publicId, { ip: '10.20.1.1' });
    const res = await r.complete({ q_vecage001: 'o_vecu18001' });
    expect(res.body).toEqual({
      responseStatus: 'disqualified',
      thankYou: { title: 'Sorry', body: "You don't qualify." },
      redirectUrl: null,
    });
    await drainJobs(ctx);
    const { rows } = await ctx.owner.query('select completed_count from surveys where id = $1', [surveyId]);
    const completed = vectors.cases.filter((c) => c.expect.ok && c.expect.outcome === 'completed').length;
    expect(rows[0].completed_count).toBe(completed);
    const summary = await admin.get(`/api/v1/surveys/${surveyId}/results/summary`);
    expect(summary.body.totals.completed).toBe(completed);
    // Resubmitting returns the same screen-out, idempotently.
    expect((await r.complete({ q_vecage001: 'o_vecu18001' })).body.responseStatus).toBe('disqualified');
  });
});

describe('piping and redirects on the end screen', () => {
  it('pipes answers as plain text and appends hidden fields to the redirect', async () => {
    const name = createQuestion('short_text', 'Your name');
    const def = definitionWith([name]);
    def.hiddenFields = [{ key: 'src', nonIdentifying: true }];
    def.settings.thankYou = {
      title: 'Thanks, {{q.' + name.key + '|friend}}!',
      body: 'From {{param.src|nowhere}}',
      redirectUrl: 'https://example.com/done?survey=1',
      appendHiddenFields: true,
    };
    const { survey } = await publishedSurvey(admin, def, 'Piping');
    const xss = '<img src=x onerror=alert(1)>';
    const res = await new Respondent(ctx.app, survey.publicId).complete({ [name.key]: xss }, { start: { hiddenFields: { src: 'panel' } } });
    expect(res.status).toBe(200);
    // The API returns text; the respondent app renders it as text (never HTML).
    expect(res.body.thankYou).toEqual({ title: `Thanks, ${xss}!`, body: 'From panel' });
    expect(res.body.redirectUrl).toBe('https://example.com/done?survey=1&src=panel');

    const fallback = await new Respondent(ctx.app, survey.publicId).complete({});
    expect(fallback.body.thankYou).toEqual({ title: 'Thanks, friend!', body: 'From nowhere' });
    expect(fallback.body.redirectUrl).toBe('https://example.com/done?survey=1');
  });

  it('refuses to publish a non-http redirect', async () => {
    const def = definitionWith(['short_text']);
    def.settings.thankYou = { title: 'Thanks', body: '', redirectUrl: 'javascript:alert(1)' };
    const survey = await createSurvey(admin, 'Bad redirect');
    const saved = await saveDraft(admin, survey.id, def);
    const pub = await admin.post(`/api/v1/surveys/${survey.id}/publish`, { revision: saved.body.revision });
    expect(pub.status).toBe(422);
    expect(pub.body.errors.map((e: { code: string }) => e.code)).toContain('invalid_url');
  });
});

// ── Access ─────────────────────────────────────────────────────────────────
describe('password protection', () => {
  let surveyId: string;
  let publicId: string;
  let question: Question;

  beforeAll(async () => {
    question = createQuestion('short_text', 'Anything?');
    const { survey } = await publishedSurvey(admin, definitionWith([question]), 'Members only');
    surveyId = survey.id;
    publicId = survey.publicId;
  });

  it('stores only a hash and reports a flag', async () => {
    const res = await admin.patch(`/api/v1/surveys/${surveyId}`, { access: { password: 'open sesame' } });
    expect(res.status).toBe(200);
    expect(res.body.access.passwordEnabled).toBe(true);
    expect(res.raw).not.toContain('open sesame');
    expect(res.raw).not.toContain('argon2');
    expect(res.raw).not.toContain('passwordHash');
  });

  it('hides the survey until unlocked, then lets the respondent in', async () => {
    const locked = await new Respondent(ctx.app, publicId).load();
    expect(locked.body.access).toEqual({ state: 'password_required' });
    expect(locked.body.version).toBeNull();
    expect((await new Respondent(ctx.app, publicId).save({})).body.code).toBe('password_required');

    const wrong = await ctx.app.inject({ method: 'POST', url: `/r/v1/s/${publicId}/unlock`, payload: { password: 'nope' } });
    expect(wrong.statusCode).toBe(401);
    expect(wrong.json().code).toBe('wrong_password');

    const unlocked = await ctx.app.inject({ method: 'POST', url: `/r/v1/s/${publicId}/unlock`, payload: { password: 'open sesame' } });
    expect(unlocked.statusCode).toBe(200);
    const token = unlocked.json().accessToken as string;
    const r = new Respondent(ctx.app, publicId, { headers: { 'x-access-token': token } });
    expect((await r.load()).body.access).toEqual({ state: 'open' });
    expect((await r.complete({ [question.key]: 'hi' })).status).toBe(200);

    // A tampered token is rejected.
    const forged = new Respondent(ctx.app, publicId, { headers: { 'x-access-token': token.replace(/.$/, (c) => (c === 'a' ? 'b' : 'a')) } });
    expect((await forged.save({})).status).toBe(401);
  });

  it('changing the password invalidates earlier tokens; removing it opens the survey', async () => {
    const unlocked = await ctx.app.inject({ method: 'POST', url: `/r/v1/s/${publicId}/unlock`, payload: { password: 'open sesame' } });
    const token = unlocked.json().accessToken as string;
    await admin.patch(`/api/v1/surveys/${surveyId}`, { access: { password: 'new secret' } });
    const stale = new Respondent(ctx.app, publicId, { headers: { 'x-access-token': token } });
    expect((await stale.save({})).status).toBe(401);

    await admin.patch(`/api/v1/surveys/${surveyId}`, { access: { password: null } });
    expect((await admin.get(`/api/v1/surveys/${surveyId}`)).body.access.passwordEnabled).toBe(false);
    expect((await new Respondent(ctx.app, publicId).save({})).status).toBe(200);
  });

  it('rate-limits password guesses', async () => {
    await admin.patch(`/api/v1/surveys/${surveyId}`, { access: { password: 'open sesame' } });
    const codes: number[] = [];
    for (let i = 0; i < 12; i++) {
      const res = await ctx.app.inject({
        method: 'POST',
        url: `/r/v1/s/${publicId}/unlock`,
        payload: { password: `guess-${i}` },
        headers: { 'x-forwarded-for': '10.30.0.1' },
      });
      codes.push(res.statusCode);
    }
    expect(codes.slice(0, 10).every((c) => c === 401)).toBe(true);
    expect(codes.at(-1)).toBe(429);
  });
});

describe('open date and CAPTCHA', () => {
  it('does not accept responses before the open date', async () => {
    const q = createQuestion('short_text', 'Q');
    const { survey } = await publishedSurvey(admin, definitionWith([q]), 'Opens later');
    const future = new Date(Date.now() + 86_400_000).toISOString();
    await admin.patch(`/api/v1/surveys/${survey.id}`, { access: { opensAt: future } });
    const page = await new Respondent(ctx.app, survey.publicId).load();
    expect(page.body.access).toEqual({ state: 'not_yet_open', opensAt: future });
    expect(page.body.version).toBeNull();
    const save = await new Respondent(ctx.app, survey.publicId).save({});
    expect(save.status).toBe(403);
    expect(save.body.code).toBe('not_yet_open');

    await admin.patch(`/api/v1/surveys/${survey.id}`, { access: { opensAt: new Date(Date.now() - 1000).toISOString() } });
    expect((await new Respondent(ctx.app, survey.publicId).complete({ [q.key]: 'now' })).status).toBe(200);
  });

  it('requires a CAPTCHA for new responses only', async () => {
    const q = createQuestion('short_text', 'Q');
    const { survey } = await publishedSurvey(admin, definitionWith([q]), 'Bot check');
    await admin.patch(`/api/v1/surveys/${survey.id}`, { access: { captcha: true } });
    const r = new Respondent(ctx.app, survey.publicId);
    expect((await r.load()).body.captchaSiteKey).toBe('test-site-key');
    const missing = await r.save({});
    expect(missing.status).toBe(403);
    expect(missing.body.code).toBe('captcha_failed');
    expect((await r.save({}, { start: { captchaToken: 'wrong' } })).status).toBe(403);
    expect((await r.save({}, { start: { captchaToken: 'pass' } })).status).toBe(200);
    // The response exists now: later saves and resuming don't ask again.
    expect((await r.load()).body.captchaSiteKey).toBeNull();
    expect((await r.complete({ [q.key]: 'human' })).status).toBe(200);
  });
});

// ── Uploads ────────────────────────────────────────────────────────────────
describe('file uploads', () => {
  let surveyId: string;
  let publicId: string;
  let upload: Question;

  beforeAll(async () => {
    const q = createQuestion('file_upload', 'Attach a screenshot');
    if (q.type !== 'file_upload') throw new Error('unreachable');
    upload = { ...q, required: false, config: { maxFiles: 2, maxSizeMb: 1, allowedTypes: ['text', 'image'] } };
    const { survey } = await publishedSurvey(admin, definitionWith([upload]), 'Uploads');
    surveyId = survey.id;
    publicId = survey.publicId;
  });

  async function fileRow(id: string) {
    const { rows } = await ctx.owner.query<{ scan_status: string; storage_key: string }>('select scan_status, storage_key from files where id = $1', [id]);
    return rows[0];
  }

  it('scans, gates downloads, quarantines malware and flags the response', async () => {
    const r = new Respondent(ctx.app, publicId, { ip: '10.40.0.1' });
    expect((await r.upload(upload.key, 'a.txt', 'hello')).body.code).toBe('not_started');
    await r.save({});

    const clean = await r.upload(upload.key, 'notes.txt', 'hello world');
    expect(clean.status).toBe(201);
    expect(clean.body).toMatchObject({ filename: 'notes.txt', mime: 'text/plain', size: 11 });

    // Type comes from the bytes, not the name: a Windows executable named .png is refused.
    const exe = await r.upload(upload.key, 'cat.png', Buffer.concat([Buffer.from('MZ'), Buffer.alloc(200, 1)]));
    expect(exe.status).toBe(422);
    expect(exe.body.code).toBe('file_type_not_allowed');
    const big = await r.upload(upload.key, 'big.txt', 'x'.repeat(1024 * 1024 + 1));
    expect(big.status).toBe(413);

    const infected = await r.upload(upload.key, 'eicar.txt', EICAR);
    expect(infected.status).toBe(201);
    expect((await r.upload(upload.key, 'third.txt', 'more')).body.code).toBe('too_many_files');

    const pending = await admin.get(`/api/v1/files/${clean.body.fileId}`);
    expect(pending.status).toBe(409);
    expect(pending.body.code).toBe('scan_pending');

    await drainJobs(ctx);
    const download = await admin.get(`/api/v1/files/${clean.body.fileId}`);
    expect(download.status).toBe(200);
    expect(download.raw).toBe('hello world');
    expect(download.headers['content-disposition']).toContain('filename="notes.txt"');
    expect(download.headers['content-security-policy']).toContain('sandbox');

    const quarantined = await admin.get(`/api/v1/files/${infected.body.fileId}`);
    expect(quarantined.status).toBe(403);
    expect(quarantined.body.code).toBe('file_quarantined');
    const row = await fileRow(infected.body.fileId);
    expect(row).toMatchObject({ scan_status: 'infected' });
    expect(row!.storage_key.startsWith('quarantine/')).toBe(true);
    expect((await responseRow(r))!.quality_flags).toContain('malware');
    const audit = await ctx.owner.query(`select 1 from audit_logs where action = 'file.quarantined' and entity_id = $1`, [infected.body.fileId]);
    expect(audit.rowCount).toBe(1);

    // A quarantined file can't be submitted; the clean one can.
    expect((await r.complete({ [upload.key]: [infected.body.fileId] })).body.errors[0].code).toBe('invalid_file');
    expect((await r.complete({ [upload.key]: [clean.body.fileId] })).status).toBe(200);
    await drainJobs(ctx);
    // Files the final answer doesn't reference are deleted with their objects.
    expect(await fileRow(infected.body.fileId)).toBeUndefined();
    await expect(ctx.deps.storage.get(row!.storage_key)).rejects.toThrow();

    const detail = await admin.get(`/api/v1/surveys/${surveyId}/responses/${(await responseRow(r))!.id}`);
    expect(detail.body.files).toEqual([
      expect.objectContaining({ id: clean.body.fileId, filename: 'notes.txt', scanStatus: 'clean', questionKey: upload.key }),
    ]);
    expect(detail.body.qualityFlags).toContain('malware');
    const csv = await admin.get(`/api/v1/surveys/${surveyId}/export.csv`);
    expect(csv.raw).toContain('notes.txt');
    expect(csv.raw).toContain('malware');
  });

  it("only accepts this response's own files", async () => {
    const owner = new Respondent(ctx.app, publicId, { ip: '10.40.0.2' });
    await owner.save({});
    const file = await owner.upload(upload.key, 'mine.txt', 'mine');
    const thief = new Respondent(ctx.app, publicId, { ip: '10.40.0.3' });
    const res = await thief.complete({ [upload.key]: [file.body.fileId] });
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('invalid_file');
    expect((await thief.removeUpload(file.body.fileId)).status).toBe(404);
    expect((await owner.removeUpload(file.body.fileId)).status).toBe(204);
  });

  it('deleting a response deletes its files', async () => {
    const r = new Respondent(ctx.app, publicId, { ip: '10.40.0.4' });
    await r.save({});
    const file = await r.upload(upload.key, 'gone.txt', 'bye');
    await r.complete({ [upload.key]: [file.body.fileId] });
    await drainJobs(ctx);
    const { storage_key } = (await fileRow(file.body.fileId))!;
    await ctx.deps.storage.get(storage_key);
    const del = await admin.delete(`/api/v1/surveys/${surveyId}/responses/${(await responseRow(r))!.id}`);
    expect(del.status).toBe(204);
    await drainJobs(ctx);
    expect(await fileRow(file.body.fileId)).toBeUndefined();
    await expect(ctx.deps.storage.get(storage_key)).rejects.toThrow();
  });

  it('anonymous surveys never accept files', async () => {
    const survey = await createSurvey(admin, 'Anonymous');
    await admin.patch(`/api/v1/surveys/${survey.id}`, { anonymous: true });
    const saved = await saveDraft(admin, survey.id, definitionWith(['short_text']));
    await admin.post(`/api/v1/surveys/${survey.id}/publish`, { revision: saved.body.revision });
    const r = new Respondent(ctx.app, survey.publicId);
    await r.save({});
    const res = await r.upload('q_whatever01', 'a.txt', 'hello');
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('uploads_not_allowed');
  });
});

// ── Themes ─────────────────────────────────────────────────────────────────
describe('themes', () => {
  const tokens = { primary: '#2445a8', background: '#f6f7f9', surface: '#ffffff', text: '#1b1f24', font: 'serif', radius: 'large' } as const;
  let publicId: string;
  let surveyId: string;

  beforeAll(async () => {
    const { survey } = await publishedSurvey(admin, definitionWith(['short_text']), 'Themed');
    publicId = survey.publicId;
    surveyId = survey.id;
  });

  it('blocks colours that fail WCAG AA contrast', async () => {
    const res = await admin.post('/api/v1/themes', { name: 'Faint', tokens: { ...tokens, text: '#c8c8c8' } });
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('contrast_too_low');
    expect(res.body.errors[0].path).toMatch(/^tokens\./);
  });

  it('applies the org default, a survey override and the logo once it is scanned', async () => {
    expect((await new Respondent(ctx.app, publicId).load()).body.theme).toBeNull();
    const a = await admin.post('/api/v1/themes', { name: 'Brand', tokens, isDefault: true });
    expect(a.status).toBe(201);
    expect((await new Respondent(ctx.app, publicId).load()).body.theme).toEqual({ tokens, logoUrl: null });

    const b = await admin.post('/api/v1/themes', { name: 'Dark', tokens: { ...tokens, primary: '#7aa2ff', background: '#101418', surface: '#1b2128', text: '#f1f3f5' }, isDefault: true });
    const list = (await admin.get('/api/v1/themes')).body as { id: string; isDefault: boolean }[];
    expect(list.filter((t) => t.isDefault).map((t) => t.id)).toEqual([b.body.id]);
    expect((await new Respondent(ctx.app, publicId).load()).body.theme.tokens.primary).toBe('#7aa2ff');

    expect((await admin.patch(`/api/v1/surveys/${surveyId}`, { themeId: a.body.id })).status).toBe(200);
    expect((await new Respondent(ctx.app, publicId).load()).body.theme.tokens.primary).toBe(tokens.primary);
    expect((await admin.patch(`/api/v1/surveys/${surveyId}`, { themeId: randomUUID() })).body.code).toBe('invalid_theme');

    const svg = await admin.upload('/api/v1/themes/logo', 'logo.svg', '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
    expect(svg.status).toBe(422);
    const logo = await admin.upload('/api/v1/themes/logo', 'logo.png', TINY_PNG);
    expect(logo.status).toBe(201);
    await admin.put(`/api/v1/themes/${a.body.id}`, { name: 'Brand', tokens, logoFileId: logo.body.fileId });
    expect((await new Respondent(ctx.app, publicId).load()).body.theme.logoUrl).toBeNull();
    expect((await ctx.app.inject({ url: `/r/v1/assets/${logo.body.fileId}` })).statusCode).toBe(404);

    await drainJobs(ctx);
    expect((await new Respondent(ctx.app, publicId).load()).body.theme.logoUrl).toBe(`/r/v1/assets/${logo.body.fileId}`);
    const asset = await ctx.app.inject({ url: `/r/v1/assets/${logo.body.fileId}` });
    expect(asset.statusCode).toBe(200);
    expect(asset.headers['content-type']).toBe('image/png');
    expect(asset.rawPayload.equals(TINY_PNG)).toBe(true);
  });

  it('only org admins manage themes', async () => {
    const creator = await addMember(ctx, admin, 'creator');
    expect((await creator.post('/api/v1/themes', { name: 'Mine', tokens })).status).toBe(403);
    expect((await creator.get('/api/v1/themes')).status).toBe(200);
  });
});

// ── Templates and question bank ────────────────────────────────────────────
describe('templates', () => {
  let globalId: string;
  let template: SurveyDefinition;

  beforeAll(async () => {
    await ctx.owner.query('update users set is_super_admin = true where id = $1', [admin.userId]);
    const age = createQuestion('single_choice', 'Age group');
    const why = { ...createQuestion('long_text', 'Why, {{q.' + age.key + '}}?'), required: false };
    if (!('options' in age)) throw new Error('unreachable');
    template = definitionWith([age, { ...why, visibleIf: { source: { question: age.key }, op: 'eq', value: age.options[0]!.key } } as Question]);
    const res = await admin.post('/api/v1/admin/templates', { name: 'Customer feedback', category: 'feedback', definition: template });
    expect(res.status).toBe(201);
    globalId = res.body.id;
  });

  it('creates surveys from a template with fresh keys and remapped references', async () => {
    const list = await admin.get('/api/v1/templates');
    expect(list.body).toContainEqual(expect.objectContaining({ kind: 'global', id: globalId, name: 'Customer feedback', questionCount: 2 }));
    const created = await admin.post('/api/v1/surveys', { title: 'From template', fromTemplate: { kind: 'global', id: globalId } });
    expect(created.status).toBe(201);
    const draft = (await admin.get(`/api/v1/surveys/${created.body.id}/draft`)).body.definition as SurveyDefinition;
    const [age, why] = listQuestions(draft) as [Question, Question];
    const [oldAge, oldWhy] = listQuestions(template) as [Question, Question];
    expect(age.title).toBe(oldAge.title);
    expect(age.key).not.toBe(oldAge.key);
    expect(why.key).not.toBe(oldWhy.key);
    expect(draft.pages[0]!.key).not.toBe(template.pages[0]!.key);
    expect(why.visibleIf).toMatchObject({ source: { question: age.key } });
    expect(why.title).toBe(`Why, {{q.${age.key}}}?`);
    // A second survey from the same template gets different keys again.
    const again = await admin.post('/api/v1/surveys', { title: 'Again', fromTemplate: { kind: 'global', id: globalId } });
    const againDraft = (await admin.get(`/api/v1/surveys/${again.body.id}/draft`)).body.definition as SurveyDefinition;
    expect(listQuestions(againDraft)[0]!.key).not.toBe(age.key);
  });

  it('saves a survey as an org template that is listed separately and never published', async () => {
    const source = await createSurvey(admin, 'Quarterly pulse');
    await saveDraft(admin, source.id, definitionWith(['nps', 'long_text']));
    const saved = await admin.post(`/api/v1/surveys/${source.id}/save-as-template`, { name: 'Pulse template', description: 'Every quarter' });
    expect(saved.status).toBe(201);
    expect(saved.body.isTemplate).toBe(true);

    const surveys = await admin.get('/api/v1/surveys');
    expect(surveys.body.data.map((s: { id: string }) => s.id)).not.toContain(saved.body.id);
    const templates = await admin.get('/api/v1/templates');
    expect(templates.body).toContainEqual(expect.objectContaining({ kind: 'org', id: saved.body.id, name: 'Pulse template', description: 'Every quarter', questionCount: 2 }));

    const draft = await admin.get(`/api/v1/surveys/${saved.body.id}/draft`);
    const pub = await admin.post(`/api/v1/surveys/${saved.body.id}/publish`, { revision: draft.body.revision });
    expect(pub.status).toBe(409);
    expect(pub.body.code).toBe('template_not_publishable');

    const fromOrg = await admin.post('/api/v1/surveys', { title: 'Q3 pulse', fromTemplate: { kind: 'org', id: saved.body.id } });
    expect(fromOrg.status).toBe(201);

    // Other organizations see global templates but not this one.
    const other = await signup(ctx.app, { orgName: 'Other Org' });
    const theirs = (await other.get('/api/v1/templates')).body as { id: string }[];
    expect(theirs.map((t) => t.id)).toContain(globalId);
    expect(theirs.map((t) => t.id)).not.toContain(saved.body.id);
    expect((await other.post('/api/v1/surveys', { title: 'Steal', fromTemplate: { kind: 'org', id: saved.body.id } })).status).toBe(404);
  });

  it('only super admins manage global templates', async () => {
    const other = await signup(ctx.app, { orgName: 'Plain Org' });
    expect((await other.post('/api/v1/admin/templates', { name: 'X', definition: createDefinition() })).status).toBe(403);
  });
});

describe('question bank', () => {
  it('stores questions with fresh keys and no conditions, searchable by title', async () => {
    const q = { ...createQuestion('rating', 'How satisfied are you with support?'), visibleIf: { source: { question: 'q_other00001' }, op: 'answered' } };
    const added = await admin.post('/api/v1/question-bank', { question: q, tags: ['support'] });
    expect(added.status).toBe(201);
    expect(added.body.question.key).not.toBe(q.key);
    expect(added.body.question.visibleIf).toBeUndefined();

    expect((await admin.get('/api/v1/question-bank?q=satisfied')).body.map((i: { id: string }) => i.id)).toContain(added.body.id);
    expect((await admin.get('/api/v1/question-bank?q=100%25')).body).toEqual([]);
    expect((await admin.post('/api/v1/question-bank', { question: { type: 'nope' } })).status).toBe(422);

    const creator = await addMember(ctx, admin, 'creator', 'Bank creator');
    expect((await creator.delete(`/api/v1/question-bank/${added.body.id}`)).status).toBe(403);
    const own = await creator.post('/api/v1/question-bank', { question: createQuestion('email', 'Work email') });
    expect((await creator.delete(`/api/v1/question-bank/${own.body.id}`)).status).toBe(204);
    expect((await admin.delete(`/api/v1/question-bank/${added.body.id}`)).status).toBe(204);
  });
});

// ── Results for the new types, and quality flags ───────────────────────────
describe('results for Phase 2A question types', () => {
  let surveyId: string;
  let q: Record<'matrix' | 'ranking' | 'slider' | 'consent' | 'phone', Question>;

  beforeAll(async () => {
    const matrix = createQuestion('matrix', 'Satisfaction');
    if (matrix.type === 'matrix') matrix.rows = ['Speed', 'Design', 'Price', 'Support'].map((label, i) => ({ key: `o_row${i}000000`, label }));
    q = {
      matrix,
      ranking: createQuestion('ranking', 'Priorities'),
      slider: createQuestion('slider', 'Budget'),
      consent: createQuestion('consent', 'Consent'),
      phone: { ...createQuestion('phone', 'Phone'), required: false },
    };
    const { survey } = await publishedSurvey(admin, definitionWith([q.matrix, q.ranking, q.slider], [q.consent, q.phone]), 'New types');
    surveyId = survey.id;
    const cols = 'options' in matrix ? matrix.options.map((o) => o.key) : [];
    const rank = 'options' in q.ranking ? q.ranking.options.map((o) => o.key) : [];
    const rows = matrix.type === 'matrix' ? matrix.rows.map((r) => r.key) : [];
    const answers = [
      // Straight-lined and instant: flagged.
      { matrix: Object.fromEntries(rows.map((r) => [r, cols[0]])), ranking: [rank[0], rank[1], rank[2]], slider: 10 },
      { matrix: { [rows[0]!]: cols[3], [rows[1]!]: cols[2] }, ranking: [rank[1], rank[0], rank[2]], slider: 55, phone: '+1 415 555 0123' },
      { matrix: { [rows[0]!]: cols[3], [rows[1]!]: cols[1], [rows[2]!]: cols[0] }, ranking: [rank[0], rank[2], rank[1]], slider: 100 },
    ];
    for (const [i, a] of answers.entries()) {
      const r = new Respondent(ctx.app, survey.publicId, { ip: `10.50.0.${i}` });
      const values = { [q.matrix.key]: a.matrix, [q.ranking.key]: a.ranking, [q.slider.key]: a.slider, [q.consent.key]: true, ...(a.phone ? { [q.phone.key]: a.phone } : {}) };
      await r.save(values);
      if (i > 0) await backdate(r);
      const res = await r.complete(values);
      if (res.status !== 200) throw new Error(JSON.stringify(res.body));
    }
    await drainJobs(ctx);
  }, 60_000);

  const summary = (query = '') => admin.get(`/api/v1/surveys/${surveyId}/results/summary${query}`);
  const find = (body: any, key: string) => body.questions.find((x: { questionKey: string }) => x.questionKey === key);

  it('summarises matrix, ranking, slider, consent and phone answers', async () => {
    const { body } = await summary();
    const matrix = find(body, q.matrix.key);
    expect(matrix.type).toBe('matrix');
    expect(matrix.rows.map((r: { answered: number }) => r.answered)).toEqual([3, 3, 2, 1]);
    expect(matrix.counts[0]).toEqual([1, 0, 0, 2]);
    expect(matrix.answered).toBe(3);

    const ranking = find(body, q.ranking.key);
    expect(ranking.answered).toBe(3);
    const [first] = ranking.options;
    expect(first).toMatchObject({ key: 'options' in q.ranking ? q.ranking.options[0]!.key : '', firstPlace: 2, ranked: 3 });
    expect(first.meanRank).toBeCloseTo(4 / 3, 2);

    const slider = find(body, q.slider.key);
    expect(slider).toMatchObject({ type: 'slider', min: 0, max: 100, answered: 3 });
    expect(slider.mean).toBeCloseTo(55, 5);
    expect(slider.histogram).toHaveLength(10);
    expect(slider.histogram.reduce((n: number, b: { count: number }) => n + b.count, 0)).toBe(3);

    expect(find(body, q.consent.key)).toMatchObject({ type: 'consent', agreed: 3, answered: 3 });
    expect(find(body, q.phone.key)).toMatchObject({ type: 'phone', answered: 1 });
    expect(find(body, q.phone.key).latest[0].text).toBe('+14155550123');
  });

  it('pre-aggregated and live computations agree for the new types', async () => {
    const aggregate = await summary();
    const live = await summary('?from=2000-01-01T00:00:00Z');
    expect(live.body.source).toBe('live');
    expect(live.body.questions).toEqual(aggregate.body.questions);
  });

  it('flags straight-lining and speeding, and filters on flags', async () => {
    const fast = await admin.get(`/api/v1/surveys/${surveyId}/responses?flag=too_fast`);
    expect(fast.body.data).toHaveLength(1);
    expect(fast.body.data[0].qualityFlags.sort()).toEqual(['straight_lined', 'too_fast']);
    expect((await admin.get(`/api/v1/surveys/${surveyId}/responses?flag=straight_lined`)).body.data).toHaveLength(1);
    expect((await admin.get(`/api/v1/surveys/${surveyId}/responses?flag=malware`)).body.data).toHaveLength(0);
    const clean = await summary('?excludeFlagged=true');
    expect(clean.body.totals.completed).toBe(2);
    expect(find(clean.body, q.consent.key).agreed).toBe(2);
  });

  it('exports one column per matrix row and ranked option', async () => {
    const csv = await admin.get(`/api/v1/surveys/${surveyId}/export.csv`);
    // trim() also drops the byte-order mark Excel needs.
    const [header, ...lines] = csv.raw.trim().split(/\r?\n/);
    expect(header).toContain('Satisfaction - Speed,Satisfaction - Design,Satisfaction - Price,Satisfaction - Support');
    expect(header).toContain('Priorities - Option 1 (rank),Priorities - Option 2 (rank),Priorities - Option 3 (rank)');
    expect(header).toContain('quality_flags');
    expect(lines).toHaveLength(3);
    expect(csv.raw).toContain('straight_lined too_fast');
  });
});
