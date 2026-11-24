/**
 * Phase 3B through the API, one block per acceptance criterion (roadmap §4.6): multi-language surveys with
 * right-to-left support, AI summaries, SSO (OIDC and SAML against local mock identity providers, JIT
 * provisioning, enforcement), retention purges, usage metrics, the super-admin console, subject export and
 * erasure, and login-required respondents (open question Q5).
 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createQuestion, type Question, type SurveyDefinition } from '@survey/core';
import { createOpenAiProvider } from '../src/ai/openai';
import { fakeAiProvider } from '../src/ai/fake';
import { redactPersonalData } from '../src/ai/redact';
import { runRetention } from '../src/jobs/retention';
import { parseTranslationCsv } from '../src/modules/translations';
import {
  addMember,
  Client,
  createSurvey,
  createTestContext,
  definitionWith,
  drainJobs,
  login,
  PASSWORD,
  publishedSurvey,
  Respondent,
  saveDraft,
  signup,
  uniqueEmail,
  type TestContext,
} from './helpers';
import { startMockOidc } from './mock-oidc';
import { createMockSaml, IDP_ENTRY_POINT, IDP_ISSUER } from './mock-saml';

let ctx: TestContext;
let admin: Client;

beforeAll(async () => {
  ctx = await createTestContext();
  // The deterministic stand-in for OpenAI (a real-client test below uses a local mock of its API).
  ctx.deps.ai = fakeAiProvider;
  admin = await signup(ctx.app, { orgName: 'Phase 3B org' });
}, 60_000);
afterAll(async () => ctx.close());

const setSuperAdmin = (client: Client) => ctx.owner.query('update users set is_super_admin = true where id = $1', [client.userId]);
const auditActions = async (orgId: string) =>
  (await ctx.owner.query<{ action: string; metadata: Record<string, unknown> }>('select action, metadata from audit_logs where org_id = $1 order by id', [orgId])).rows;

// ── Multi-language ───────────────────────────────────────────────────────────
describe('multi-language surveys', () => {
  let like: Question;
  let why: Question;
  let def: SurveyDefinition;
  let survey: { id: string; publicId: string };
  let versionId: string;

  const french = () => ({
    'survey.title': 'Enquête client',
    [`${like.key}.title`]: 'Vous aimez notre produit ?',
    [`${like.key}.option.${(like as { options: { key: string }[] }).options[0]!.key}`]: 'Oui',
    [`${like.key}.option.${(like as { options: { key: string }[] }).options[1]!.key}`]: 'Non',
    [`${why.key}.title`]: 'Pourquoi avez-vous répondu {{q.' + like.key + '}} ?',
    'thankYou.title': 'Merci ! Vous avez dit {{q.' + like.key + '}}',
    'ui.next': 'Suivant',
  });

  beforeAll(async () => {
    like = createQuestion('single_choice', 'Do you like our product?');
    (like as { options: { label: string }[] }).options[0]!.label = 'Yes';
    (like as { options: { label: string }[] }).options[1]!.label = 'No';
    like.required = true;
    why = createQuestion('long_text', 'Why did you answer {{q.' + like.key + '}}?');
    def = definitionWith([like], [why]);
    def.settings.thankYou = { title: 'Thanks! You said {{q.' + like.key + '}}', body: 'Done.' };
    // Logic: "No" ends the survey after page 1.
    def.logic = [{ id: 'r_endOnNo01', afterPage: def.pages[0]!.key, when: { source: { question: like.key }, op: 'eq', value: (like as { options: { key: string }[] }).options[1]!.key }, then: { end: true } }];
    const created = await createSurvey(admin, 'Customer survey (languages)');
    survey = created;
    const saved = await saveDraft(admin, created.id, def);
    expect(saved.status).toBe(200);
    versionId = (await admin.get(`/api/v1/surveys/${created.id}/draft`)).body.versionId;
  });

  it('lists every translatable string and saves a language on the draft (unknown keys dropped, audited)', async () => {
    const overview = await admin.get(`/api/v1/surveys/${survey.id}/versions/${versionId}/translations`);
    expect(overview.status).toBe(200);
    expect(overview.body.defaultLocale).toBe('en');
    expect(overview.body.strings.map((s: { key: string }) => s.key)).toEqual(expect.arrayContaining(['survey.title', `${like.key}.title`, `${why.key}.title`, 'thankYou.title', 'ui.next']));

    const saved = await admin.put(`/api/v1/surveys/${survey.id}/versions/${versionId}/translations/fr`, { strings: { ...french(), 'q_doesnotexist.title': 'x' } });
    expect(saved.status).toBe(200);
    expect(saved.body.strings).not.toHaveProperty('q_doesnotexist.title');
    expect(saved.body.missing).toContain('ui.back');
    expect(saved.body.dir).toBe('ltr');

    const arabic = await admin.put(`/api/v1/surveys/${survey.id}/versions/${versionId}/translations/ar`, {
      strings: { [`${like.key}.title`]: 'هل يعجبك منتجنا؟', 'ui.next': 'التالي' },
    });
    expect(arabic.body.dir).toBe('rtl');
    expect((await admin.put(`/api/v1/surveys/${survey.id}/versions/${versionId}/translations/en`, { strings: {} })).body.code).toBe('default_locale');
    expect((await admin.put(`/api/v1/surveys/${survey.id}/versions/${versionId}/translations/french`, { strings: {} })).body.code).toBe('invalid_locale');
    const analyst = await addMember(ctx, admin, 'analyst');
    expect((await analyst.put(`/api/v1/surveys/${survey.id}/versions/${versionId}/translations/fr`, { strings: {} })).status).toBe(404);

    const languages = (await admin.get(`/api/v1/surveys/${survey.id}/versions/${versionId}/translations`)).body.languages;
    expect(languages.map((l: { locale: string }) => l.locale)).toEqual(['ar', 'fr']);
    expect((await auditActions(admin.orgId)).filter((a) => a.action === 'survey.translation_saved').map((a) => a.metadata.locale)).toEqual(['fr', 'ar']);
  });

  it('warns about missing strings before and at publishing, without blocking it', async () => {
    const draft = await admin.get(`/api/v1/surveys/${survey.id}/draft`);
    expect(draft.body.validation.translations.map((w: { locale: string }) => w.locale)).toEqual(['ar', 'fr']);
    const published = await admin.post(`/api/v1/surveys/${survey.id}/publish`, { revision: draft.body.revision });
    expect(published.status).toBe(200);
    const fr = published.body.translationWarnings.find((w: { locale: string }) => w.locale === 'fr');
    expect(fr.missing).toBeGreaterThan(0);
    expect(fr.tokenMismatches).toBe(0);
  });

  it('serves each language by ?lang= and by browser detection, mirrored for right-to-left', async () => {
    const byParam = await new Respondent(ctx.app, survey.publicId, { query: '?lang=fr' }).load();
    expect(byParam.body.language).toMatchObject({ locale: 'fr', dir: 'ltr', available: ['en', 'ar', 'fr'] });
    expect(byParam.body.survey.title).toBe('Enquête client');
    expect(byParam.body.version.definition.pages[0].elements[0].title).toBe('Vous aimez notre produit ?');
    expect(byParam.body.language.ui.next).toBe('Suivant');
    expect(byParam.body.language.ui.back).toBe('Back');

    const detected = await new Respondent(ctx.app, survey.publicId, { headers: { 'accept-language': 'de-DE,de;q=0.9,fr-CA;q=0.8,en;q=0.5' } }).load();
    expect(detected.body.language.locale).toBe('fr');
    const english = await new Respondent(ctx.app, survey.publicId, { headers: { 'accept-language': 'ja' } }).load();
    expect(english.body.language.locale).toBe('en');
    expect(english.body.version.definition.pages[0].elements[0].title).toBe('Do you like our product?');

    const arabic = await new Respondent(ctx.app, survey.publicId, { query: '?lang=ar' }).load();
    expect(arabic.body.language).toMatchObject({ locale: 'ar', dir: 'rtl' });
    expect(arabic.body.version.definition.pages[0].elements[0].title).toBe('هل يعجبك منتجنا؟');
    // Untranslated strings fall back to the default language.
    expect(arabic.body.version.definition.pages[1].elements[0].title).toContain('Why did you answer');
  });

  it('runs logic and piping in every language and records the language', async () => {
    const [yes, no] = (like as { options: { key: string }[] }).options.map((o) => o.key);
    const fr = new Respondent(ctx.app, survey.publicId, { query: '?lang=fr' });
    expect((await fr.save({ [like.key]: yes }, { start: { locale: 'fr' }, locale: 'fr' })).status).toBe(200);
    const done = await fr.complete({ [like.key]: yes, [why.key]: 'Parce que.' }, { locale: 'fr', currentPageKey: def.pages[1]!.key });
    expect(done.status).toBe(200);
    expect(done.body.thankYou.title).toBe('Merci ! Vous avez dit Oui');

    // "No" ends after page 1 in French too: completing without page 2 is accepted.
    const frNo = new Respondent(ctx.app, survey.publicId, { query: '?lang=fr' });
    const ended = await frNo.complete({ [like.key]: no }, { start: { locale: 'fr' }, locale: 'fr' });
    expect(ended.status).toBe(200);
    expect(ended.body.thankYou.title).toBe('Merci ! Vous avez dit Non');

    // Switching language mid-way: the end screen follows the latest choice.
    const switcher = new Respondent(ctx.app, survey.publicId);
    await switcher.save({ [like.key]: yes }, { start: { locale: 'en' } });
    const switched = await switcher.complete({ [like.key]: yes }, { locale: 'fr', currentPageKey: def.pages[1]!.key });
    expect(switched.body.thankYou.title).toBe('Merci ! Vous avez dit Oui');

    const { rows } = await ctx.owner.query<{ locale: string }>('select locale from responses where survey_id = $1 order by started_at', [survey.id]);
    expect(rows.map((r) => r.locale)).toEqual(['fr', 'fr', 'fr']);
    const list = await admin.get(`/api/v1/surveys/${survey.id}/responses?status=all`);
    expect(list.body.data[0].locale).toBe('fr');
  });

  it('edits translations of the live version (audited) and respondents see them at once', async () => {
    const detail = await admin.get(`/api/v1/surveys/${survey.id}`);
    const liveVersion = (await admin.get(`/api/v1/surveys/${survey.id}/versions`)).body[0].id;
    expect(detail.body.currentVersionNumber).toBe(1);
    await new Respondent(ctx.app, survey.publicId, { query: '?lang=fr' }).load(); // warm the cache
    const edited = await admin.put(`/api/v1/surveys/${survey.id}/versions/${liveVersion}/translations/fr`, { strings: { ...french(), 'ui.back': 'Retour' } });
    expect(edited.status).toBe(200);
    const after = await new Respondent(ctx.app, survey.publicId, { query: '?lang=fr' }).load();
    expect(after.body.language.ui.back).toBe('Retour');
    const audit = (await auditActions(admin.orgId)).filter((a) => a.action === 'survey.translation_saved').at(-1)!;
    expect(audit.metadata).toMatchObject({ locale: 'fr', published: true, versionNumber: 1 });

    // A new draft starts with the live version's translations.
    const draft = await admin.post(`/api/v1/surveys/${survey.id}/draft`);
    const draftLanguages = (await admin.get(`/api/v1/surveys/${survey.id}/versions/${draft.body.versionId}/translations`)).body.languages;
    expect(draftLanguages.map((l: { locale: string }) => l.locale)).toEqual(['ar', 'fr']);
  });

  it('exports and imports strings as CSV, undoing the formula protection', async () => {
    const liveVersion = (await admin.get(`/api/v1/surveys/${survey.id}/versions`)).body[0].id;
    const csv = await admin.get(`/api/v1/surveys/${survey.id}/versions/${liveVersion}/translations/fr/export.csv`);
    expect(csv.status).toBe(200);
    expect(csv.headers['content-type']).toContain('text/csv');
    expect(csv.raw).toContain('key,context,source,translation');
    expect(csv.raw).toContain('Vous aimez notre produit ?');

    const upload = `key,translation\r\nui.submit,Envoyer\r\n${why.key}.title,"'=Pourquoi {{q.${like.key}}} ?"\r\nnope.title,x\r\n`;
    const imported = await admin.post(`/api/v1/surveys/${survey.id}/versions/${liveVersion}/translations/fr/import`, { csv: upload });
    expect(imported.status).toBe(200);
    expect(imported.body.imported).toBe(2);
    expect(imported.body.unknownKeys).toEqual(['nope.title']);
    expect(imported.body.translation.strings['ui.submit']).toBe('Envoyer');
    expect(imported.body.translation.strings[`${why.key}.title`]).toBe(`=Pourquoi {{q.${like.key}}} ?`);
    // Existing strings the CSV didn't mention are kept.
    expect(imported.body.translation.strings['ui.back']).toBe('Retour');
    expect(() => parseTranslationCsv('a,b\n1,2')).toThrow(/key/);
  });
});

// ── AI summaries ─────────────────────────────────────────────────────────────
describe('AI summaries of open text', () => {
  let survey: { id: string; publicId: string };
  let text: Question;

  beforeAll(async () => {
    text = createQuestion('long_text', 'What should we improve?');
    const published = await publishedSurvey(admin, definitionWith([text]), 'Feedback (AI)');
    survey = published.survey;
    const answers = [
      'Support was slow to answer, write to me at jane.doe@example.com',
      'Slow support, call me on +44 20 7946 0958',
      'The app is slow on mobile',
      'Love the new design, great work',
      'Great design and easy setup',
      'Pricing is too expensive for small teams',
      'Too expensive compared to others',
    ];
    for (const [i, answer] of answers.entries()) {
      const r = new Respondent(ctx.app, survey.publicId, { ip: `10.9.0.${i + 1}` });
      expect((await r.complete({ [text.key]: answer })).status).toBe(200);
    }
    await drainJobs(ctx);
  });

  it('is off until an org admin opts in, and unavailable without a provider', async () => {
    const status = (await admin.get(`/api/v1/surveys/${survey.id}/insights`)).body.ai;
    expect(status).toMatchObject({ available: true, enabled: false, provider: 'fake', model: 'fake-summarizer' });
    expect((await admin.post(`/api/v1/surveys/${survey.id}/insights`, { questionKey: text.key })).body.code).toBe('ai_not_enabled');

    const saved = ctx.deps.ai;
    ctx.deps.ai = null;
    try {
      expect((await admin.patch('/api/v1/org', { ai: { enabled: true } })).body.code).toBe('ai_unavailable');
      expect((await admin.get('/api/v1/org')).body.ai.available).toBe(false);
    } finally {
      ctx.deps.ai = saved;
    }
    const creator = await addMember(ctx, admin, 'creator');
    expect((await creator.patch('/api/v1/org', { ai: { enabled: true } })).status).toBe(403);
    const enabled = await admin.patch('/api/v1/org', { ai: { enabled: true } });
    expect(enabled.body.ai).toMatchObject({ enabled: true, available: true, monthlyTokenCap: 500_000 });
    expect((await auditActions(admin.orgId)).some((a) => a.action === 'org.updated' && a.metadata.aiEnabled === true)).toBe(true);
  });

  it('labels the summary with provider, model and date, counts the answers and links themes to them', async () => {
    const requested = await admin.post(`/api/v1/surveys/${survey.id}/insights`, { questionKey: text.key });
    expect(requested.status).toBe(202);
    expect(requested.body.status).toBe('pending');
    await drainJobs(ctx);
    const { insights } = (await admin.get(`/api/v1/surveys/${survey.id}/insights`)).body;
    const insight = insights.find((i: { questionKey: string }) => i.questionKey === text.key);
    expect(insight).toMatchObject({ status: 'done', provider: 'fake', model: 'fake-summarizer', responsesAnalysed: 7, responsesTotal: 7 });
    expect(new Date(insight.generatedAt).getTime()).toBeGreaterThan(Date.now() - 60_000);
    expect(insight.themes.length).toBeGreaterThan(0);
    const ids = new Set((await ctx.owner.query<{ id: string }>('select id from responses where survey_id = $1', [survey.id])).rows.map((r) => r.id));
    for (const theme of insight.themes) {
      expect(theme.samples.length).toBeGreaterThan(0);
      for (const sample of theme.samples) expect(ids.has(sample.responseId)).toBe(true);
    }
    expect(insight.tokens).toBeGreaterThan(0);
    expect(insight.sentiment.positive + insight.sentiment.neutral + insight.sentiment.negative).toBe(7);
    const usage = (await admin.get('/api/v1/org/usage')).body;
    expect(usage.months.at(-1).aiTokens).toBe(insight.tokens);
    expect((await auditActions(admin.orgId)).filter((a) => a.action.startsWith('ai.summary')).map((a) => a.action)).toEqual(['ai.summary_requested', 'ai.summary_generated']);
    // Only text questions.
    const nps = await publishedSurvey(admin, definitionWith(['nps']), 'Not text');
    expect((await admin.post(`/api/v1/surveys/${nps.survey.id}/insights`, { questionKey: nps.definition.pages[0]!.elements[0]!.key })).body.code).toBe('not_a_text_question');
  });

  it('respects the per-org monthly token cap', async () => {
    const root = await signup(ctx.app, { orgName: 'Platform ops' });
    await setSuperAdmin(root);
    const capped = await root.patch(`/api/v1/admin/orgs/${admin.orgId}`, { aiMonthlyTokenCap: 50 });
    expect(capped.status).toBe(200);
    expect(capped.body).toMatchObject({ aiMonthlyTokenCap: 50, aiCapOverridden: true });
    const refused = await admin.post(`/api/v1/surveys/${survey.id}/insights`, { questionKey: text.key });
    expect(refused.status).toBe(429);
    expect(refused.body.code).toBe('ai_token_cap_reached');
    // A request already queued is checked again by the job against what it would cost.
    const used = (await admin.get('/api/v1/org')).body.ai.tokensUsedThisMonth;
    await root.patch(`/api/v1/admin/orgs/${admin.orgId}`, { aiMonthlyTokenCap: used + 10 });
    const queued = await admin.post(`/api/v1/surveys/${survey.id}/insights`, { questionKey: text.key });
    expect(queued.status).toBe(202);
    await drainJobs(ctx);
    const failed = (await admin.get(`/api/v1/surveys/${survey.id}/insights/${queued.body.id}`)).body;
    expect(failed).toMatchObject({ status: 'failed', error: { code: 'token_cap_reached' } });
    await root.patch(`/api/v1/admin/orgs/${admin.orgId}`, { aiMonthlyTokenCap: null });
    expect((await admin.get('/api/v1/org')).body.ai.monthlyTokenCap).toBe(500_000);
  });

  it('redacts emails and phone numbers before sending, and keeps only answer ids it sent', async () => {
    expect(redactPersonalData('Mail jane.doe+x@example.co.uk or call +1 (555) 123-4567, or 020 7946 0958. Order 2026-11-24, 3 items.').text).toBe(
      'Mail [email] or call [phone], or [phone]. Order 2026-11-24, 3 items.',
    );
    expect(redactPersonalData('reach me at bob [at] corp [dot] com').text).toBe('reach me at [email]');

    // The real OpenAI client against a local stand-in for the Chat Completions API.
    const received: string[] = [];
    const server: Server = createServer((req, res) => {
      let body = '';
      req.on('data', (c: Buffer) => (body += c.toString('utf8')));
      req.on('end', () => {
        received.push(body);
        expect(req.headers.authorization).toBe('Bearer sk-test');
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    summary: 'Support is slow.',
                    themes: [{ label: 'Slow support', summary: 'Answers take too long.', sentiment: 'negative', answerIds: ['a1', 'a2', 'a999'] }],
                    sentiment: { positive: 2, neutral: 1, negative: 4 },
                  }),
                },
              },
            ],
            usage: { prompt_tokens: 321, completion_tokens: 45 },
          }),
        );
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const saved = ctx.deps.ai;
    ctx.deps.ai = createOpenAiProvider({ apiKey: 'sk-test', model: 'gpt-6-luna', baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1` });
    try {
      const requested = await admin.post(`/api/v1/surveys/${survey.id}/insights`, { questionKey: text.key });
      expect(requested.status).toBe(202);
      await drainJobs(ctx);
      expect(received).toHaveLength(1);
      const sent = JSON.parse(received[0]!);
      expect(sent.model).toBe('gpt-6-luna');
      expect(sent.response_format.type).toBe('json_schema');
      const payload = sent.messages.map((m: { content: string }) => m.content).join('\n');
      expect(payload).not.toMatch(/jane\.doe|example\.com|7946|0958/);
      expect(payload).toContain('[email]');
      expect(payload).toContain('[phone]');
      // No response ids or anything identifying: opaque short ids only.
      expect(payload).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-/);
      const insight = (await admin.get(`/api/v1/surveys/${survey.id}/insights/${requested.body.id}`)).body;
      expect(insight).toMatchObject({ status: 'done', provider: 'openai', model: 'gpt-6-luna', tokens: 366 });
      // "a999" was never sent: the theme keeps the two real answers.
      expect(insight.themes[0]).toMatchObject({ label: 'Slow support', count: 2 });
      expect(insight.themes[0].samples).toHaveLength(2);
    } finally {
      ctx.deps.ai = saved;
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('the fake provider is deterministic', async () => {
    const input = { question: 'q', answers: [{ id: 'a1', text: 'slow support' }, { id: 'a2', text: 'support slow again' }], maxThemes: 3 };
    expect(await fakeAiProvider.summarize(input)).toEqual(await fakeAiProvider.summarize(input));
  });
});

// ── SSO ──────────────────────────────────────────────────────────────────────
describe('single sign-on', () => {
  let ssoAdmin: Client;
  const domain = `sso-${Date.now()}.example`;
  const txt: string[][] = [];

  beforeAll(async () => {
    ssoAdmin = await signup(ctx.app, { orgName: 'SSO org', email: `admin@${domain}` });
    ctx.deps.dns = { resolveTxt: async () => txt };
    ctx.deps.config.allowPrivateUrls = true;
  });

  /** Follow the browser's steps: start → identity provider → callback. Returns the session cookie. */
  async function oidcLogin(connectionId: string, options: { dropBindCookie?: boolean } = {}) {
    const start = await ctx.app.inject({ method: 'GET', url: `/api/v1/auth/sso/${connectionId}/start?returnTo=/surveys` });
    expect(start.statusCode).toBe(302);
    const bind = start.cookies.find((c) => c.name === 'sso_bind')!;
    expect(bind).toMatchObject({ httpOnly: true, sameSite: 'None', secure: true });
    const idp = await fetch(start.headers.location as string, { redirect: 'manual' });
    expect(idp.status).toBe(302);
    const callback = new URL(idp.headers.get('location')!);
    const done = await ctx.app.inject({
      method: 'GET',
      url: callback.pathname + callback.search,
      headers: options.dropBindCookie ? {} : { cookie: `sso_bind=${bind.value}` },
    });
    return { done, sid: done.cookies.find((c) => c.name === 'sid')?.value ?? null };
  }

  const asSession = (sid: string) => Object.assign(new Client(ctx.app), { cookie: `sid=${sid}` });

  it('verifies domains with a DNS TXT record, and only one org can hold a domain', async () => {
    const added = await ssoAdmin.post('/api/v1/org/sso/domains', { domain });
    expect(added.status).toBe(201);
    expect(added.body).toMatchObject({ domain, verified: false, txtRecord: { name: `_survey-verification.${domain}` } });
    expect((await ssoAdmin.post(`/api/v1/org/sso/domains/${domain}/verify`)).body.code).toBe('not_verified');
    txt.push([added.body.txtRecord.value]);
    const verified = await ssoAdmin.post(`/api/v1/org/sso/domains/${domain}/verify`);
    expect(verified.body.verified).toBe(true);

    const rival = await signup(ctx.app, { orgName: 'Rival org' });
    const claim = await rival.post('/api/v1/org/sso/domains', { domain });
    expect(claim.status).toBe(201); // a claim is fine…
    txt.push([claim.body.txtRecord.value]);
    expect((await rival.post(`/api/v1/org/sso/domains/${domain}/verify`)).body.code).toBe('domain_taken'); // …verifying isn't
  });

  it('OIDC: signs people in with PKCE, provisions them just in time and links returning users', async () => {
    const oidc = await startMockOidc({ clientId: 'survey-app', clientSecret: 'oidc-secret' });
    try {
      const bad = await ssoAdmin.post('/api/v1/org/sso/connections', { protocol: 'oidc', name: 'Nope', issuer: 'http://127.0.0.1:9/none', clientId: 'x', clientSecret: 'y' });
      expect(bad.body.code).toBe('invalid_issuer');
      const created = await ssoAdmin.post('/api/v1/org/sso/connections', {
        protocol: 'oidc',
        name: 'Google Workspace',
        issuer: oidc.issuer,
        clientId: 'survey-app',
        clientSecret: 'oidc-secret',
        defaultRole: 'analyst',
      });
      expect(created.status).toBe(201);
      expect(created.body.summary).toEqual({ issuer: oidc.issuer, clientId: 'survey-app' });
      expect(JSON.stringify(created.body)).not.toContain('oidc-secret');
      const stored = await ctx.owner.query<{ config_enc: string }>('select config_enc from sso_connections where id = $1', [created.body.id]);
      expect(stored.rows[0]!.config_enc).not.toContain('oidc-secret');

      oidc.setUser({ sub: 'g-123', email: `newbie@${domain}`, name: 'Nina Newbie' });
      const first = await oidcLogin(created.body.id);
      expect(first.done.statusCode).toBe(302);
      expect(first.done.headers.location).toBe('http://localhost:5173/surveys');
      expect(oidc.state.authorizeRequests.at(-1)!.get('code_challenge_method')).toBe('S256');
      const me = await asSession(first.sid!).get('/api/v1/auth/me');
      expect(me.body.user).toMatchObject({ email: `newbie@${domain}`, name: 'Nina Newbie', emailVerified: true });
      expect(me.body.activeOrg).toMatchObject({ id: ssoAdmin.orgId, role: 'analyst' });
      const actions = (await auditActions(ssoAdmin.orgId)).map((a) => a.action);
      expect(actions).toEqual(expect.arrayContaining(['member.jit_provisioned', 'auth.sso_login']));
      // No password: password login can't be used for this account.
      expect((await ctx.app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { email: `newbie@${domain}`, password: 'whatever-123' } })).statusCode).toBe(401);

      // Same subject again: the same user, no second provisioning.
      const again = await oidcLogin(created.body.id);
      expect((await asSession(again.sid!).get('/api/v1/auth/me')).body.user.id).toBe(me.body.user.id);
      expect((await auditActions(ssoAdmin.orgId)).filter((a) => a.action === 'member.jit_provisioned')).toHaveLength(1);

      // An existing password account in the domain is linked by email (and keeps its role).
      oidc.setUser({ sub: 'g-admin', email: `admin@${domain}`, name: 'Admin' });
      const linked = await oidcLogin(created.body.id);
      expect((await asSession(linked.sid!).get('/api/v1/auth/me')).body.user.id).toBe(ssoAdmin.userId);
      expect((await asSession(linked.sid!).get('/api/v1/auth/me')).body.activeOrg.role).toBe('org_admin');

      // Someone outside the org's verified domains is refused (a rogue IdP can't sign in as anyone).
      oidc.setUser({ sub: 'evil', email: 'ceo@other-company.example' });
      const outsider = await oidcLogin(created.body.id);
      expect(outsider.done.headers.location).toContain('/login?sso_error=domain_not_verified');
      expect(outsider.sid).toBeNull();
      // Unverified email at the IdP.
      oidc.setUser({ sub: 'unverified', email: `x@${domain}`, emailVerified: false });
      expect((await oidcLogin(created.body.id)).done.headers.location).toContain('sso_error=email_not_verified');
      // The login must finish in the browser that started it.
      oidc.setUser({ sub: 'g-123', email: `newbie@${domain}` });
      expect((await oidcLogin(created.body.id, { dropBindCookie: true })).done.headers.location).toContain('sso_error=expired');
      // A state can't be used twice.
      const start = await ctx.app.inject({ method: 'GET', url: `/api/v1/auth/sso/${created.body.id}/start` });
      const bind = start.cookies.find((c) => c.name === 'sso_bind')!.value;
      const idp = new URL((await fetch(start.headers.location as string, { redirect: 'manual' })).headers.get('location')!);
      const once = await ctx.app.inject({ method: 'GET', url: idp.pathname + idp.search, headers: { cookie: `sso_bind=${bind}` } });
      expect(once.headers.location).toBe('http://localhost:5173/surveys');
      const twice = await ctx.app.inject({ method: 'GET', url: idp.pathname + idp.search, headers: { cookie: `sso_bind=${bind}` } });
      expect(twice.headers.location).toContain('sso_error=expired');
      // Open redirects are refused.
      const evilReturn = await ctx.app.inject({ method: 'GET', url: `/api/v1/auth/sso/${created.body.id}/start?returnTo=//evil.example` });
      const evilState = new URL(evilReturn.headers.location as string).searchParams.get('state')!;
      expect(JSON.parse((await ctx.deps.redis.get(`sso:state:${evilState}`))!).returnTo).toBe('/surveys');
    } finally {
      await oidc.close();
    }
  });

  it('SAML: accepts signed assertions that answer our request, once, from the configured certificate', async () => {
    const idp = await createMockSaml();
    const created = await ssoAdmin.post('/api/v1/org/sso/connections', {
      protocol: 'saml',
      name: 'Okta',
      entryPoint: IDP_ENTRY_POINT,
      idpIssuer: IDP_ISSUER,
      idpCert: idp.cert,
      defaultRole: 'creator',
    });
    expect(created.status).toBe(201);
    expect(created.body.serviceProvider.acsUrl).toBe('http://localhost:5173/api/v1/auth/sso/saml/acs');
    expect((await ssoAdmin.post('/api/v1/org/sso/connections', { protocol: 'saml', name: 'x', entryPoint: IDP_ENTRY_POINT, idpIssuer: IDP_ISSUER, idpCert: 'x'.repeat(120) })).body.code).toBe('invalid_certificate');
    const metadata = await ctx.app.inject({ method: 'GET', url: `/api/v1/auth/sso/saml/${created.body.id}/metadata` });
    expect(metadata.body).toContain('AssertionConsumerService');
    expect(metadata.body).toContain(created.body.serviceProvider.entityId);

    const begin = async () => {
      const start = await ctx.app.inject({ method: 'GET', url: `/api/v1/auth/sso/${created.body.id}/start` });
      expect(start.statusCode).toBe(302);
      expect(String(start.headers.location)).toMatch(/^https:\/\/idp\.example\.test\/sso\?SAMLRequest=/);
      return { request: idp.requestIdFrom(start.headers.location as string), bind: start.cookies.find((c) => c.name === 'sso_bind')!.value };
    };
    const post = (samlResponse: string, relayState: string, bind: string) =>
      ctx.app.inject({
        method: 'POST',
        url: '/api/v1/auth/sso/saml/acs',
        payload: new URLSearchParams({ SAMLResponse: samlResponse, RelayState: relayState }).toString(),
        headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: `sso_bind=${bind}` },
      });
    const answer = (request: { id: string; acs: string }, extra: Partial<Parameters<typeof idp.response>[0]> = {}) =>
      idp.response({ inResponseTo: request.id, acsUrl: request.acs, audience: created.body.serviceProvider.entityId, email: `sam@${domain}`, name: 'Sam Saml', ...extra });

    const one = await begin();
    expect(one.request.acs).toBe(created.body.serviceProvider.acsUrl);
    const response = answer(one.request);
    const ok = await post(response, one.request.relayState, one.bind);
    expect(ok.statusCode).toBe(302);
    expect(ok.headers.location).toBe('http://localhost:5173/surveys');
    const sid = ok.cookies.find((c) => c.name === 'sid')!.value;
    const me = (await asSession(sid).get('/api/v1/auth/me')).body;
    expect(me.user).toMatchObject({ email: `sam@${domain}`, name: 'Sam Saml' });
    expect(me.activeOrg.role).toBe('creator');

    // Replaying the same response (even with a fresh state) is refused.
    const two = await begin();
    expect((await post(response, two.request.relayState, two.bind)).headers.location).toContain('sso_error=saml_failed');
    // Unsigned, or signed by another key: refused.
    const three = await begin();
    expect((await post(answer(three.request, { sign: false }), three.request.relayState, three.bind)).headers.location).toContain('sso_error=saml_failed');
    const other = await createMockSaml();
    const four = await begin();
    expect((await post(answer(four.request, { signingKey: other.privateKey, signingCert: other.cert }), four.request.relayState, four.bind)).headers.location).toContain(
      'sso_error=saml_failed',
    );
    // An assertion for another request id, or another audience.
    const five = await begin();
    expect((await post(answer({ id: '_not_ours', acs: five.request.acs }), five.request.relayState, five.bind)).headers.location).toContain('sso_error=saml_failed');
    const six = await begin();
    expect((await post(answer(six.request, { audience: 'https://someone-else.example' }), six.request.relayState, six.bind)).headers.location).toContain('sso_error=saml_failed');
    // An identity outside the verified domains.
    const seven = await begin();
    expect((await post(answer(seven.request, { email: 'boss@elsewhere.example' }), seven.request.relayState, seven.bind)).headers.location).toContain('sso_error=domain_not_verified');
  });

  it('enforced SSO blocks password login, sign-up, resets and invitations for the domain', async () => {
    const settings = (await ssoAdmin.get('/api/v1/org/sso')).body;
    expect(settings.canEnforce).toBe(true);
    // Enforcement can't be switched on before a working login (fresh org).
    const fresh = await signup(ctx.app, { orgName: 'Fresh SSO org' });
    expect((await fresh.patch('/api/v1/org', { sso: { enforced: true } })).body.code).toBe('sso_not_ready');

    expect((await ssoAdmin.patch('/api/v1/org', { sso: { enforced: true } })).body.sso.enforced).toBe(true);
    const discover = await ctx.app.inject({ method: 'POST', url: '/api/v1/auth/sso/discover', payload: { email: `anyone@${domain}` } });
    expect(discover.json()).toMatchObject({ enforced: true });
    expect(discover.json().connections.length).toBeGreaterThanOrEqual(1);

    const password = await ctx.app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { email: `admin@${domain}`, password: PASSWORD } });
    expect(password.statusCode).toBe(403);
    expect(password.json().code).toBe('sso_required');
    const signupTry = await ctx.app.inject({ method: 'POST', url: '/api/v1/auth/signup', payload: { name: 'X', email: `new2@${domain}`, password: PASSWORD, orgName: 'Shadow org' } });
    expect(signupTry.json().code).toBe('sso_required');
    ctx.deps.mailer.outbox.length = 0;
    expect((await ctx.app.inject({ method: 'POST', url: '/api/v1/auth/password/forgot', payload: { email: `admin@${domain}` } })).statusCode).toBe(202);
    await drainJobs(ctx);
    expect(ctx.deps.mailer.outbox.filter((m) => m.to === `admin@${domain}`)).toHaveLength(0);
    // Other domains are unaffected.
    await login(ctx.app, admin.me!.user.email);
    // Sessions that already exist keep working. Invitations into the domain can't be accepted with a new password.
    const invited = `invitee@${domain}`;
    await ssoAdmin.post('/api/v1/org/invitations', { email: invited, role: 'creator' });
    await drainJobs(ctx);
    const token = ctx.deps.mailer.outbox.find((m) => m.to === invited)!.text.match(/\/invite\/([A-Za-z0-9_-]+)/)![1];
    const accept = await new Client(ctx.app).post(`/api/v1/invitations/${token}/accept`, { name: 'Ivy', password: PASSWORD });
    expect(accept.body.code).toBe('sso_required');

    // Removing the only working connections relaxes enforcement instead of locking everyone out.
    for (const c of (await ssoAdmin.get('/api/v1/org/sso')).body.connections) await ssoAdmin.delete(`/api/v1/org/sso/connections/${c.id}`);
    expect((await ssoAdmin.get('/api/v1/org')).body.sso.enforced).toBe(false);
    expect((await auditActions(ssoAdmin.orgId)).some((a) => a.action === 'sso.enforcement_relaxed')).toBe(true);
    expect((await ctx.app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { email: `admin@${domain}`, password: PASSWORD } })).statusCode).toBe(200);
  });
});

// ── Retention ────────────────────────────────────────────────────────────────
describe('retention policies', () => {
  it('purges responses older than N days on schedule, repairs aggregates and audits it', async () => {
    const owner = await signup(ctx.app, { orgName: 'Retention org' });
    const choice = createQuestion('single_choice', 'Pick');
    const keep = await publishedSurvey(owner, definitionWith([choice]), 'Org default (30 days)');
    const short = await publishedSurvey(owner, definitionWith([createQuestion('single_choice', 'Pick')]), 'Override (10 days)');
    const optionKey = (choice as { options: { key: string }[] }).options[0]!.key;
    for (let i = 0; i < 4; i++) {
      await new Respondent(ctx.app, keep.survey.publicId, { ip: `10.8.0.${i}` }).complete({ [choice.key]: optionKey });
      const q = short.definition.pages[0]!.elements[0]! as Question & { options: { key: string }[] };
      await new Respondent(ctx.app, short.survey.publicId, { ip: `10.8.1.${i}` }).complete({ [q.key]: q.options[0]!.key });
    }
    await drainJobs(ctx);
    // Two responses per survey are 20 days old, one 40 days.
    const age = async (surveyId: string, days: number, limit: number) =>
      ctx.owner.query(
        `update responses set completed_at = now() - make_interval(days => $2), last_activity_at = now() - make_interval(days => $2)
          where id in (select id from responses where survey_id = $1 and completed_at > now() - interval '1 day' order by id limit $3)`,
        [surveyId, days, limit],
      );
    for (const s of [keep.survey.id, short.survey.id]) {
      await age(s, 20, 2);
      await age(s, 40, 1);
    }
    expect((await owner.patch('/api/v1/org', { retention: { responsesDays: 30 } })).body.retention).toEqual({ responsesDays: 30 });
    const overridden = await owner.patch(`/api/v1/surveys/${short.survey.id}`, { retentionDays: 10 });
    expect(overridden.body).toMatchObject({ retentionDays: 10, effectiveRetentionDays: 10 });
    expect((await owner.get(`/api/v1/surveys/${keep.survey.id}`)).body).toMatchObject({ retentionDays: null, effectiveRetentionDays: 30 });

    const result = await runRetention(ctx.deps);
    expect(result.responses).toBeGreaterThanOrEqual(4);
    const counts = async (surveyId: string) => (await ctx.owner.query<{ n: number }>('select count(*)::int as n from responses where survey_id = $1', [surveyId])).rows[0]!.n;
    expect(await counts(keep.survey.id)).toBe(3); // the 40-day-old one went
    expect(await counts(short.survey.id)).toBe(1); // everything older than 10 days went
    const summary = (await owner.get(`/api/v1/surveys/${keep.survey.id}/results/summary`)).body;
    expect(summary.totals.completed).toBe(3);
    expect(summary.questions[0].answered).toBe(3);
    expect((await owner.get(`/api/v1/surveys/${keep.survey.id}`)).body.completedCount).toBe(3);
    const audits = (await auditActions(owner.orgId)).filter((a) => a.action === 'responses.retention_purged');
    expect(audits.map((a) => a.metadata.count).sort()).toEqual([1, 3]);
    expect(audits.find((a) => a.metadata.count === 3)!.metadata.retentionDays).toBe(10);
    // Running again finds nothing new.
    expect((await runRetention(ctx.deps)).responses).toBe(0);
    // Retention is an admin setting; creators can't change the org default.
    const creator = await addMember(ctx, owner, 'creator');
    expect((await creator.patch('/api/v1/org', { retention: { responsesDays: 1 } })).status).toBe(403);
  });

  it('purges soft-deleted surveys after 30 days', async () => {
    const owner = await signup(ctx.app, { orgName: 'Purge org' });
    const old = await publishedSurvey(owner, definitionWith(['short_text']), 'Deleted long ago');
    await owner.delete(`/api/v1/surveys/${old.survey.id}`);
    await ctx.owner.query(`update surveys set deleted_at = now() - interval '31 days' where id = $1`, [old.survey.id]);
    const recent = await publishedSurvey(owner, definitionWith(['short_text']), 'Deleted yesterday');
    await owner.delete(`/api/v1/surveys/${recent.survey.id}`);
    const result = await runRetention(ctx.deps);
    expect(result.surveys).toBe(1);
    expect((await ctx.owner.query('select id from surveys where id = $1', [old.survey.id])).rowCount).toBe(0);
    expect((await ctx.owner.query('select id from surveys where id = $1', [recent.survey.id])).rowCount).toBe(1);
    expect((await auditActions(owner.orgId)).some((a) => a.action === 'survey.purged')).toBe(true);
  });
});

// ── Usage and the super-admin console ────────────────────────────────────────
describe('usage metrics and the super-admin console', () => {
  it('org admins see their usage; others are refused', async () => {
    const owner = await signup(ctx.app, { orgName: 'Usage org' });
    const pub = await publishedSurvey(owner, definitionWith(['short_text']), 'Counted');
    const q = pub.definition.pages[0]!.elements[0]!.key;
    for (let i = 0; i < 3; i++) await new Respondent(ctx.app, pub.survey.publicId, { ip: `10.7.0.${i}` }).complete({ [q]: 'hi' });
    await drainJobs(ctx);
    // A retried aggregation job doesn't count a response twice.
    const { rows: done } = await ctx.owner.query<{ id: string }>('select id from responses where survey_id = $1 limit 1', [pub.survey.id]);
    await ctx.handlers['aggregates.response-completed']({ orgId: owner.orgId, surveyId: pub.survey.id, responseId: done[0]!.id });
    const usage = (await owner.get('/api/v1/org/usage?months=3')).body;
    expect(usage.months).toHaveLength(3);
    expect(usage.months.at(-1)).toMatchObject({ responses: 3, surveysPublished: 1, emailsSent: 0, aiTokens: 0 });
    expect(usage.current).toMatchObject({ members: 1, surveys: 1, responsesStored: 3 });
    const analyst = await addMember(ctx, owner, 'analyst');
    expect((await analyst.get('/api/v1/org/usage')).status).toBe(403);
    expect((await owner.get('/api/v1/admin/overview')).status).toBe(403);
  });

  it('super admins list orgs with usage, suspend and reactivate them, audited in the org', async () => {
    const root = await signup(ctx.app, { orgName: 'Root org' });
    await setSuperAdmin(root);
    const target = await signup(ctx.app, { orgName: 'Suspend me' });
    const targetOrgId = target.orgId;
    const pub = await publishedSurvey(target, definitionWith(['short_text']), 'Will stop');
    const key = (await target.post('/api/v1/api-keys', { name: 'k', scopes: ['surveys:read'] })).body.key as string;

    const overview = (await root.get('/api/v1/admin/overview?q=suspend')).body;
    expect(overview.orgs).toHaveLength(1);
    expect(overview.orgs[0]).toMatchObject({ name: 'Suspend me', status: 'active', members: 1, surveys: 1, thisMonth: { surveysPublished: 1 } });
    expect(overview.totals.orgs).toBeGreaterThan(1);
    // Usage of a single org, without its content.
    expect((await root.get(`/api/v1/admin/orgs/${targetOrgId}/usage`)).body.months.at(-1).surveysPublished).toBe(1);
    expect((await root.get(`/api/v1/surveys/${pub.survey.id}`)).status).toBe(404);

    const suspended = await root.patch(`/api/v1/admin/orgs/${targetOrgId}`, { status: 'suspended', plan: 'enterprise', reason: 'Unpaid invoice' });
    expect(suspended.body).toMatchObject({ status: 'suspended', plan: 'enterprise' });
    expect((await target.get('/api/v1/auth/me')).body.activeOrg).toBeNull();
    expect((await new Respondent(ctx.app, pub.survey.publicId).load()).status).toBe(404);
    expect((await ctx.app.inject({ method: 'GET', url: '/api/v1/surveys', headers: { authorization: `Bearer ${key}` } })).statusCode).toBe(401);
    const audit = (await auditActions(targetOrgId)).find((a) => a.action === 'org.suspended')!;
    expect(audit.metadata).toMatchObject({ bySuperAdmin: true, reason: 'Unpaid invoice', plan: { from: 'free', to: 'enterprise' } });

    await root.patch(`/api/v1/admin/orgs/${targetOrgId}`, { status: 'active' });
    expect((await target.get('/api/v1/auth/me')).body.activeOrg.id).toBe(targetOrgId);
    expect((await new Respondent(ctx.app, pub.survey.publicId).load()).status).toBe(200);
    expect((await auditActions(targetOrgId)).some((a) => a.action === 'org.reactivated')).toBe(true);
  });
});

// ── Privacy requests ─────────────────────────────────────────────────────────
describe('subject export and erasure', () => {
  it('exports every non-anonymous record for an email, erases them, and audits without the address', async () => {
    const owner = await signup(ctx.app, { orgName: 'Privacy org' });
    const subject = uniqueEmail('subject');
    const email = createQuestion('email', 'Your email');
    const comment = createQuestion('short_text', 'Comment');
    const named = await publishedSurvey(owner, definitionWith([email, comment]), 'Named survey');
    const anonymousDef = definitionWith([createQuestion('short_text', 'Anything?')]);
    const anon = await createSurvey(owner, 'Anonymous survey');
    await owner.patch(`/api/v1/surveys/${anon.id}`, { anonymous: true });
    await saveDraft(owner, anon.id, anonymousDef);
    const draft = await owner.get(`/api/v1/surveys/${anon.id}/draft`);
    await owner.post(`/api/v1/surveys/${anon.id}/publish`, { revision: draft.body.revision });

    // By email answer; by campaign link; someone else; an anonymous response mentioning the address.
    await new Respondent(ctx.app, named.survey.publicId, { ip: '10.6.0.1' }).complete({ [email.key]: subject.toUpperCase(), [comment.key]: 'Mine' });
    await new Respondent(ctx.app, named.survey.publicId, { ip: '10.6.0.2' }).complete({ [email.key]: 'other@example.com', [comment.key]: 'Not mine' });
    await new Respondent(ctx.app, anon.publicId, { ip: '10.6.0.3' }).complete({ [anonymousDef.pages[0]!.elements[0]!.key]: subject });
    const list = await owner.post('/api/v1/contact-lists', { name: 'People' });
    await owner.post('/api/v1/contacts', { email: subject, firstName: 'Sub', listIds: [list.body.id] });
    const campaign = await owner.post(`/api/v1/surveys/${named.survey.id}/campaigns`, { name: 'Invite', listId: list.body.id, subject: 'Hi', body: 'Answer: {{survey.link}}' });
    await owner.post(`/api/v1/campaigns/${campaign.body.id}/send`, {});
    ctx.deps.mailer.outbox.length = 0;
    await drainJobs(ctx);
    const link = ctx.deps.mailer.outbox.find((m) => m.to === subject)!.text.match(/t=([A-Za-z0-9_-]{32})/)![1]!;
    await new Respondent(ctx.app, named.survey.publicId, { ip: '10.6.0.4', key: link }).complete({ [comment.key]: 'Via the email' }, { start: { recipientToken: link } });
    await drainJobs(ctx);
    // The AI summary cites the subject's response.
    await owner.patch('/api/v1/org', { ai: { enabled: true } });
    await owner.post(`/api/v1/surveys/${named.survey.id}/insights`, { questionKey: comment.key });
    await drainJobs(ctx);

    const analyst = await addMember(ctx, owner, 'analyst');
    expect((await analyst.post('/api/v1/privacy/requests', { subjectEmail: subject, kind: 'export' })).status).toBe(403);

    const exported = await owner.post('/api/v1/privacy/requests', { subjectEmail: subject, kind: 'export' });
    expect(exported.status).toBe(202);
    await drainJobs(ctx);
    const done = (await owner.get(`/api/v1/privacy/requests/${exported.body.id}`)).body;
    expect(done).toMatchObject({ status: 'done', result: { contacts: 1, campaignMessages: 1, responses: 2, anonymousSurveysNotSearched: 1 } });
    const file = await owner.get(done.downloadUrl);
    expect(file.status).toBe(200);
    const json = JSON.parse(file.raw);
    expect(json.subject).toBe(subject);
    expect(json.contacts[0]).toMatchObject({ email: subject, firstName: 'Sub' });
    expect(json.responses.map((r: { linkedBy: string }) => r.linkedBy).sort()).toEqual(['answer', 'campaign_link']);
    expect(JSON.stringify(json.responses)).toContain('Via the email');
    expect(JSON.stringify(json)).not.toContain('Not mine');

    // Erasure needs the address typed twice.
    expect((await owner.post('/api/v1/privacy/requests', { subjectEmail: subject, kind: 'erase' })).body.code).toBe('confirmation_mismatch');
    const erased = await owner.post('/api/v1/privacy/requests', { subjectEmail: subject, kind: 'erase', confirmEmail: subject });
    await drainJobs(ctx);
    expect((await owner.get(`/api/v1/privacy/requests/${erased.body.id}`)).body).toMatchObject({ status: 'done', result: { contacts: 1, responses: 2, aiSummaries: 1 } });
    const remaining = await ctx.owner.query<{ n: number }>('select count(*)::int as n from responses where survey_id = $1', [named.survey.id]);
    expect(remaining.rows[0]!.n).toBe(1);
    expect((await ctx.owner.query('select 1 from contacts where email = $1', [subject])).rowCount).toBe(0);
    expect((await ctx.owner.query(`select 1 from answers where lower(value_text) = lower($1) and survey_id = $2`, [subject, named.survey.id])).rowCount).toBe(0);
    // The anonymous response is untouched (correctly out of scope).
    expect((await ctx.owner.query('select 1 from responses where survey_id = $1', [anon.id])).rowCount).toBe(1);
    expect((await owner.get(`/api/v1/surveys/${named.survey.id}/results/summary`)).body.totals.completed).toBe(1);
    const audits = await auditActions(owner.orgId);
    expect(audits.map((a) => a.action)).toEqual(expect.arrayContaining(['privacy.export_requested', 'privacy.exported', 'privacy.export_downloaded', 'privacy.erase_requested', 'privacy.erased']));
    expect(JSON.stringify(audits.filter((a) => a.action.startsWith('privacy.')))).not.toContain(subject);
    // A second export finds nothing left.
    const again = await owner.post('/api/v1/privacy/requests', { subjectEmail: subject, kind: 'export' });
    await drainJobs(ctx);
    expect((await owner.get(`/api/v1/privacy/requests/${again.body.id}`)).body.result).toMatchObject({ contacts: 0, responses: 0 });
  });
});

// ── Login-required respondents (Q5) ──────────────────────────────────────────
describe('login-required respondents', () => {
  let owner: Client;
  let survey: { id: string; publicId: string };
  let question: string;

  beforeAll(async () => {
    owner = await signup(ctx.app, { orgName: 'Members-only org' });
    const pub = await publishedSurvey(owner, definitionWith(['short_text']), 'Staff pulse');
    survey = pub.survey;
    question = pub.definition.pages[0]!.elements[0]!.key;
  });

  const exchange = async (url: string) => {
    const token = new URL(url).hash.replace('#rt=', '');
    return ctx.app.inject({ method: 'POST', url: `/r/v1/s/${survey.publicId}/login`, payload: { token } });
  };

  it("can't be combined with anonymity", async () => {
    const anon = await createSurvey(owner, 'Anon');
    await owner.patch(`/api/v1/surveys/${anon.id}`, { anonymous: true });
    expect((await owner.patch(`/api/v1/surveys/${anon.id}`, { access: { requireLogin: true } })).body.code).toBe('login_not_allowed_anonymous');
    const named = await createSurvey(owner, 'Named');
    await owner.patch(`/api/v1/surveys/${named.id}`, { access: { requireLogin: true } });
    expect((await owner.patch(`/api/v1/surveys/${named.id}`, { anonymous: true })).body.code).toBe('login_not_allowed_anonymous');
  });

  it('asks anonymous visitors to sign in on the admin app, and hands members back with a one-time token', async () => {
    expect((await owner.patch(`/api/v1/surveys/${survey.id}`, { access: { requireLogin: true } })).body.access.requireLogin).toBe(true);
    const visitor = await new Respondent(ctx.app, survey.publicId, { query: '?lang=en' }).load();
    expect(visitor.body.access).toEqual({ state: 'login_required', loginUrl: `http://localhost:5173/respond/${survey.publicId}?lang=en` });
    expect(visitor.body.version).toBeNull();
    // Saving without a token is refused.
    expect((await new Respondent(ctx.app, survey.publicId).save({ [question]: 'x' })).body.code).toBe('login_required');

    const member = await addMember(ctx, owner, 'analyst', 'Mia Member');
    const handoff = await member.post('/api/v1/respondent-handoff', { publicId: survey.publicId });
    expect(handoff.status).toBe(200);
    expect(handoff.body.url).toMatch(new RegExp(`^http://localhost:5174/s/${survey.publicId}#rt=`));
    expect(handoff.body.survey).toEqual({ title: 'Staff pulse', orgName: 'Members-only org' });

    const login = await exchange(handoff.body.url);
    expect(login.statusCode).toBe(200);
    const { respondentToken, responseKey, respondent } = login.json();
    expect(respondent).toEqual({ name: 'Mia Member', email: member.email });
    // One use only.
    expect((await exchange(handoff.body.url)).json().code).toBe('invalid_login_token');

    const signedIn = new Respondent(ctx.app, survey.publicId, { key: responseKey, headers: { 'x-respondent-token': respondentToken } });
    const loaded = await signedIn.load();
    expect(loaded.body.access.state).toBe('open');
    expect(loaded.body.respondent).toEqual({ name: 'Mia Member', email: member.email });
    expect((await signedIn.complete({ [question]: 'All good' })).status).toBe(200);
    const { rows } = await ctx.owner.query<{ respondent_user_id: string }>('select respondent_user_id from responses where survey_id = $1', [survey.id]);
    expect(rows).toEqual([{ respondent_user_id: member.userId }]);
    const detail = await owner.get(`/api/v1/surveys/${survey.id}/responses?status=all`);
    const one = await owner.get(`/api/v1/surveys/${survey.id}/responses/${detail.body.data[0].id}`);
    expect(one.body.respondent).toEqual({ email: member.email, name: 'Mia Member' });

    // One response per member: the same key resumes (already done), another key is refused.
    expect((await signedIn.load()).body.resume.status).toBe('completed');
    const secondTry = new Respondent(ctx.app, survey.publicId, { headers: { 'x-respondent-token': respondentToken } });
    expect((await secondTry.save({ [question]: 'again' })).body.code).toBe('respondent_key_mismatch');
    const fresh = (await exchange((await member.post('/api/v1/respondent-handoff', { publicId: survey.publicId })).body.url)).json();
    expect(fresh.responseKey).toBe(responseKey);
  });

  it('refuses non-members, forged tokens, and members who were removed', async () => {
    const outsider = await signup(ctx.app, { orgName: 'Outside org' });
    const refused = await outsider.post('/api/v1/respondent-handoff', { publicId: survey.publicId });
    expect(refused.status).toBe(403);
    expect(refused.body.code).toBe('not_a_member');
    expect((await ctx.app.inject({ method: 'POST', url: `/r/v1/s/${survey.publicId}/login`, payload: { token: 'x'.repeat(40) + '.' + 'y'.repeat(43) } })).json().code).toBe(
      'invalid_login_token',
    );
    // A token for another survey doesn't work here.
    const other = await publishedSurvey(owner, definitionWith(['short_text']), 'Other');
    await owner.patch(`/api/v1/surveys/${other.survey.id}`, { access: { requireLogin: true } });
    const member = await addMember(ctx, owner, 'creator', 'Leaving Lee');
    const url = (await member.post('/api/v1/respondent-handoff', { publicId: other.survey.publicId })).body.url as string;
    expect((await exchange(url)).json().code).toBe('invalid_login_token');

    const login = (await exchange((await member.post('/api/v1/respondent-handoff', { publicId: survey.publicId })).body.url)).json();
    const signedIn = new Respondent(ctx.app, survey.publicId, { key: login.responseKey, headers: { 'x-respondent-token': login.respondentToken } });
    expect((await signedIn.save({ [question]: 'started' })).status).toBe(200);
    await owner.delete(`/api/v1/org/members/${member.userId}`);
    expect((await signedIn.load()).body.access.state).toBe('login_required');
    expect((await signedIn.save({ [question]: 'more' })).body.code).toBe('login_required');
    // Emailing a resume link isn't offered: members sign in on any device instead.
    const resume = await ctx.app.inject({
      method: 'POST',
      url: `/r/v1/s/${survey.publicId}/response/resume-link`,
      payload: { email: 'x@example.com' },
      headers: { 'x-response-key': login.responseKey },
    });
    expect(resume.json().code).toBe('not_available');
  });
});
