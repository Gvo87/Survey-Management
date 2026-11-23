/**
 * Phase 2B through the API: contacts and CSV import, email campaigns (scheduling, unique links,
 * reminders, unsubscribe, SES bounces, one response per recipient, anonymous tracking), analytics
 * (filters, segments, cross-tab, drop-off, word counts, live updates), the response viewer (search,
 * tags, notes, bulk delete) and exports (XLSX, PDF, scheduled reports).
 */
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import type { AddressInfo } from 'node:net';
import ExcelJS from 'exceljs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createOption, createQuestion, type Question, type SurveyDefinition } from '@survey/core';
import { stringToSign, type SnsMessage } from '../src/infra/sns';
import { recipientToken } from '../src/lib/campaign-email';
import {
  addMember,
  createSurvey,
  createTestContext,
  definitionWith,
  drainJobs,
  multipartBody,
  publishedSurvey,
  Respondent,
  saveDraft,
  signup,
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

async function importCsv(client: Client, csv: string, fields: Record<string, string>) {
  const form = multipartBody('contacts.csv', csv, 'text/csv');
  // Fields go before the file, as a browser's FormData sends them.
  const boundary = form.headers['content-type'].split('boundary=')[1]!;
  const prefix = Object.entries(fields)
    .map(([k, v]) => `--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`)
    .join('');
  const res = await ctx.app.inject({
    method: 'POST',
    url: '/api/v1/contacts/imports',
    payload: Buffer.concat([Buffer.from(prefix), form.payload]),
    headers: { ...form.headers, cookie: client.cookie!, 'x-csrf-token': client.csrf! },
  });
  return { status: res.statusCode, body: res.json() };
}

const mapping = JSON.stringify({ email: 'Email', firstName: 'First', lastName: 'Last', attributes: { Plan: 'plan' } });

// ── Contacts ─────────────────────────────────────────────────────────────
describe('contacts and CSV import', () => {
  it('imports, merges duplicates by email, reports bad rows and keeps unsubscribes', async () => {
    const existing = await admin.post('/api/v1/contacts', { email: 'kept@example.com', firstName: 'Kept', attributes: { team: 'blue' } });
    expect(existing.status).toBe(201);
    await ctx.owner.query(`update contacts set unsubscribed_at = now() where id = $1`, [existing.body.id]);

    const csv = [
      'Email,First,Last,Plan',
      'ana@example.com,Ana,Alves,pro',
      'not-an-email,Bad,Row,free',
      'ANA@example.com,,Alves-Smith,team',
      ',Missing,Email,free',
      'kept@example.com,Kept,Again,enterprise',
      'bo@example.com,"Bo, Jr.",Brown,free',
    ].join('\n');
    const started = await importCsv(admin, csv, { mapping, newListName: 'Customers' });
    expect(started.status).toBe(202);
    await drainJobs(ctx);
    const result = await admin.get(`/api/v1/contacts/imports/${started.body.id}`);
    expect(result.body).toMatchObject({ status: 'done', total: 6, created: 2, updated: 1, skipped: 2 });
    expect(result.body.errors).toEqual([
      { row: 3, message: 'Email address is not valid.' },
      { row: 5, message: 'Email is missing.' },
    ]);
    const report = await admin.get(result.body.errorReportUrl.replace('/api/v1', '/api/v1'));
    expect(report.status).toBe(200);
    expect(report.raw).toContain('not-an-email');

    const list = (await admin.get('/api/v1/contact-lists')).body.find((l: { name: string }) => l.name === 'Customers');
    expect(list.memberCount).toBe(3);
    const contacts = (await admin.get(`/api/v1/contacts?listId=${list.id}`)).body.data as { email: string; firstName: string; lastName: string; attributes: Record<string, string>; status: string }[];
    const ana = contacts.find((c) => c.email === 'ana@example.com')!;
    // Later non-empty values win; empty cells don't erase.
    expect(ana).toMatchObject({ firstName: 'Ana', lastName: 'Alves-Smith', attributes: { plan: 'team' } });
    expect(contacts.find((c) => c.email === 'bo@example.com')!.firstName).toBe('Bo, Jr.');
    const kept = contacts.find((c) => c.email === 'kept@example.com')!;
    expect(kept).toMatchObject({ status: 'unsubscribed', attributes: { team: 'blue', plan: 'enterprise' } });

    // The uploaded file isn't kept once imported.
    const { rows } = await ctx.owner.query('select storage_key from contact_imports where id = $1', [started.body.id]);
    await expect(ctx.deps.storage.get(rows[0].storage_key)).rejects.toThrow();
  });

  it('imports 50,000 rows in under 2 minutes', async () => {
    const lines = ['Email,First,Last,Plan'];
    for (let i = 0; i < 50_000; i++) lines.push(`person${i}@bulk.example.com,First${i},Last${i},${i % 3 ? 'free' : 'pro'}`);
    const t0 = Date.now();
    const started = await importCsv(admin, lines.join('\n'), { mapping, newListName: 'Bulk' });
    expect(started.status).toBe(202);
    await drainJobs(ctx);
    const elapsed = Date.now() - t0;
    const result = await admin.get(`/api/v1/contacts/imports/${started.body.id}`);
    expect(result.body).toMatchObject({ status: 'done', total: 50_000, created: 50_000, skipped: 0 });
    expect(elapsed).toBeLessThan(120_000);
    console.log(`[perf] 50k-row contact import: ${(elapsed / 1000).toFixed(1)} s`);
  }, 150_000);

  it('keeps contacts away from analysts and other orgs', async () => {
    const analyst = await addMember(ctx, admin, 'analyst');
    expect((await analyst.get('/api/v1/contacts')).status).toBe(403);
    const other = await signup(ctx.app, { orgName: 'Elsewhere' });
    expect((await other.get('/api/v1/contacts')).body.data).toEqual([]);
    expect((await admin.post('/api/v1/contacts', { email: 'kept@example.com' })).body.code).toBe('contact_exists');
  });
});

// ── Campaigns ────────────────────────────────────────────────────────────
async function listWith(client: Client, name: string, people: { email: string; firstName?: string }[]) {
  const list = await client.post('/api/v1/contact-lists', { name });
  for (const p of people) {
    const c = await client.post('/api/v1/contacts', { ...p, listIds: [list.body.id] });
    if (c.status !== 201) throw new Error(c.raw);
  }
  return list.body.id as string;
}

const linkIn = (text: string) => /https?:\/\/\S+\/s\/\S+?t=([A-Za-z0-9_-]{32})/.exec(text);

describe('email campaigns', () => {
  let survey: { id: string; publicId: string };
  let question: Question;

  beforeAll(async () => {
    question = createQuestion('short_text', 'Anything to add, {{contact.first_name|friend}}?');
    const published = await publishedSurvey(admin, definitionWith([question]), 'Campaign survey');
    survey = published.survey;
  });

  it('sends personal links, skips suppressed contacts, and links responses to recipients', async () => {
    const listId = await listWith(admin, 'Campaign list', [
      { email: 'c1@example.com', firstName: 'Cleo' },
      { email: 'c2@example.com', firstName: 'Dev' },
      { email: 'c3@example.com' },
    ]);
    await ctx.owner.query(`update contacts set unsubscribed_at = now() where email = 'c3@example.com'`);
    const created = await admin.post(`/api/v1/surveys/${survey.id}/campaigns`, {
      name: 'November invite',
      listId,
      subject: 'Quick question, {{contact.first_name|there}}',
      body: 'Hi {{contact.first_name|there}},\n\nPlease answer: {{survey.link}}',
      reminders: { afterDays: 3, max: 2 },
    });
    expect(created.status).toBe(201);
    const bad = await admin.post(`/api/v1/surveys/${survey.id}/campaigns`, { name: 'x', listId, subject: 's', body: 'Hi {{contact.shoe_size}}' });
    expect(bad.body.code).toBe('unknown_merge_tag');

    ctx.deps.mailer.outbox.length = 0;
    const sent = await admin.post(`/api/v1/campaigns/${created.body.id}/send`, {});
    expect(sent.body.status).toBe('scheduled');
    await drainJobs(ctx);
    const campaign = (await admin.get(`/api/v1/campaigns/${created.body.id}`)).body;
    expect(campaign).toMatchObject({ status: 'sent', counts: { total: 3, sent: 2, suppressed: 1 } });

    const mails = ctx.deps.mailer.outbox.filter((m) => m.subject.startsWith('Quick question'));
    expect(mails.map((m) => m.to).sort()).toEqual(['c1@example.com', 'c2@example.com']);
    const cleo = mails.find((m) => m.to === 'c1@example.com')!;
    expect(cleo.subject).toBe('Quick question, Cleo');
    expect(cleo.headers?.['List-Unsubscribe-Post']).toBe('List-Unsubscribe=One-Click');
    expect(cleo.html).toContain('Take the survey');
    const tokens = mails.map((m) => linkIn(m.text)![1]!);
    expect(new Set(tokens).size).toBe(2);

    // Cleo opens her link: contact piping, then a response linked to her recipient row.
    const token = linkIn(cleo.text)![1]!;
    const cleoR = new Respondent(ctx.app, survey.publicId, { key: token, query: `?t=${token}` });
    const page = await cleoR.load();
    expect(page.body.contact).toMatchObject({ first_name: 'Cleo', email: 'c1@example.com' });
    const done = await cleoR.complete({ [question.key]: 'All good' }, { start: { recipientToken: token } });
    expect(done.status).toBe(200);
    const { rows } = await ctx.owner.query(
      `select r.status, r.responded_at, resp.recipient_id = r.id as linked from recipients r join responses resp on resp.recipient_id = r.id where r.token_hash = $1`,
      [createHash('sha256').update(token).digest()],
    );
    expect(rows[0]).toMatchObject({ status: 'responded', linked: true });

    // The same link again: already answered (resume shows the completed response).
    expect((await new Respondent(ctx.app, survey.publicId, { key: token, query: `?t=${token}` }).load()).body.resume.status).toBe('completed');
    // A different browser key with the same token can't start a second response.
    const second = await new Respondent(ctx.app, survey.publicId, { query: `?t=${token}` }).save({}, { start: { recipientToken: token } });
    expect(second.status).toBe(409);
    expect(second.body.code).toBe('already_responded');

    // Reminders: only non-responders, only after the delay, never more than the maximum.
    const reminders = ctx.handlers['campaigns.reminders'];
    ctx.deps.mailer.outbox.length = 0;
    await reminders({});
    expect(ctx.deps.mailer.outbox).toHaveLength(0);
    for (let round = 1; round <= 3; round++) {
      await ctx.owner.query(`update recipients set last_sent_at = now() - interval '4 days' where campaign_id = $1`, [created.body.id]);
      await reminders({});
    }
    const reminded = ctx.deps.mailer.outbox.filter((m) => m.subject.startsWith('Reminder:'));
    expect(reminded.map((m) => m.to)).toEqual(['c2@example.com', 'c2@example.com']);
    const recipients = (await admin.get(`/api/v1/campaigns/${created.body.id}/recipients`)).body.data as { email: string; remindersSent: number; status: string }[];
    expect(recipients.find((r) => r.email === 'c2@example.com')).toMatchObject({ remindersSent: 2, status: 'sent' });
  });

  it("schedules in the creator's time zone and can be cancelled", async () => {
    const listId = await listWith(admin, 'Scheduled list', [{ email: 's1@example.com' }]);
    const created = await admin.post(`/api/v1/surveys/${survey.id}/campaigns`, { name: 'Later', listId, subject: 'Hi', body: 'Hello {{survey.link}}' });
    const year = new Date().getUTCFullYear() + 1;
    const scheduled = await admin.post(`/api/v1/campaigns/${created.body.id}/send`, { scheduledAt: `${year}-07-01T09:00`, timezone: 'America/New_York' });
    expect(scheduled.body).toMatchObject({ status: 'scheduled', scheduledAt: `${year}-07-01T13:00:00.000Z`, timezone: 'America/New_York' });
    expect((await admin.post(`/api/v1/campaigns/${created.body.id}/send`, { scheduledAt: '2020-01-01T09:00', timezone: 'UTC' })).body.code).toBe('in_the_past');
    // Nothing goes out before the scheduled time.
    await drainJobs(ctx);
    expect((await admin.get(`/api/v1/campaigns/${created.body.id}`)).body.counts.total).toBe(0);
    expect((await admin.post(`/api/v1/campaigns/${created.body.id}/cancel`)).body.status).toBe('cancelled');
    // A stale job for the cancelled schedule does nothing.
    await ctx.handlers['campaigns.start']({ orgId: admin.orgId, campaignId: created.body.id, scheduledAt: `${year}-07-01T13:00:00.000Z` });
    expect((await admin.get(`/api/v1/campaigns/${created.body.id}`)).body).toMatchObject({ status: 'cancelled', counts: { total: 0 } });
  });

  it('unsubscribes without login, including one-click from mail clients', async () => {
    const listId = await listWith(admin, 'Unsub list', [{ email: 'u1@example.com' }, { email: 'u2@example.com' }]);
    const created = await admin.post(`/api/v1/surveys/${survey.id}/campaigns`, { name: 'Unsub', listId, subject: 'Hi', body: 'Hello' });
    ctx.deps.mailer.outbox.length = 0;
    await admin.post(`/api/v1/campaigns/${created.body.id}/send`, {});
    await drainJobs(ctx);
    const mail = ctx.deps.mailer.outbox.find((m) => m.to === 'u1@example.com')!;
    const token = /\/u\/([A-Za-z0-9_-]{32})/.exec(mail.text)![1]!;
    expect(mail.text).toContain(`/s/${survey.publicId}`); // link appended though the body has no {{survey.link}}
    const info = await ctx.app.inject({ url: `/r/v1/unsubscribe/${token}` });
    expect(info.json()).toMatchObject({ email: 'u•@example.com', unsubscribed: false });
    const oneClick = await ctx.app.inject({
      method: 'POST',
      url: `/r/v1/unsubscribe/${token}`,
      payload: 'List-Unsubscribe=One-Click',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
    });
    expect(oneClick.statusCode).toBe(200);
    expect((await ctx.app.inject({ url: `/r/v1/unsubscribe/${token}` })).json().unsubscribed).toBe(true);
    expect((await ctx.app.inject({ url: `/r/v1/unsubscribe/${'x'.repeat(32)}` })).statusCode).toBe(404);
    // Reminders skip them from now on.
    await ctx.owner.query(`update campaigns set reminder_after_days = 1, reminder_max = 1 where id = $1`, [created.body.id]);
    await ctx.owner.query(`update recipients set last_sent_at = now() - interval '2 days' where campaign_id = $1`, [created.body.id]);
    ctx.deps.mailer.outbox.length = 0;
    await ctx.handlers['campaigns.reminders']({});
    expect(ctx.deps.mailer.outbox.map((m) => m.to)).toEqual(['u2@example.com']);
  });

  it('records SES bounces and complaints from signed SNS messages only', async () => {
    const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const topic = 'arn:aws:sns:eu-west-1:123456789012:ses-feedback';
    ctx.deps.config.sesTopicArns = [topic];
    ctx.deps.sns = { fetchCert: async () => publicKey.export({ type: 'spki', format: 'pem' }).toString(), confirm: async () => {} };
    await admin.post('/api/v1/contacts', { email: 'bounce@example.com' });
    await admin.post('/api/v1/contacts', { email: 'angry@example.com' });

    const message = (payload: object, signWith = privateKey): SnsMessage => {
      const m: SnsMessage = {
        Type: 'Notification',
        MessageId: crypto.randomUUID(),
        TopicArn: topic,
        Message: JSON.stringify(payload),
        Timestamp: new Date().toISOString(),
        SignatureVersion: '2',
        Signature: '',
        SigningCertURL: 'https://sns.eu-west-1.amazonaws.com/SimpleNotificationService-abc.pem',
      };
      m.Signature = sign('RSA-SHA256', Buffer.from(stringToSign(m)), signWith).toString('base64');
      return m;
    };
    const post = (m: SnsMessage) =>
      ctx.app.inject({ method: 'POST', url: '/api/v1/webhooks/ses', payload: JSON.stringify(m), headers: { 'content-type': 'text/plain' } });

    const forged = message({ notificationType: 'Bounce', bounce: { bounceType: 'Permanent', bouncedRecipients: [{ emailAddress: 'bounce@example.com' }] } }, generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey);
    expect((await post(forged)).statusCode).toBe(403);
    expect((await post({ ...message({}), TopicArn: 'arn:aws:sns:eu-west-1:1:other' })).statusCode).toBe(403);

    expect((await post(message({ notificationType: 'Bounce', bounce: { bounceType: 'Permanent', bouncedRecipients: [{ emailAddress: 'Bounce@example.com' }] } }))).json()).toEqual({ recorded: 1 });
    expect((await post(message({ notificationType: 'Bounce', bounce: { bounceType: 'Transient', bouncedRecipients: [{ emailAddress: 'angry@example.com' }] } }))).json()).toEqual({ recorded: 0 });
    expect((await post(message({ notificationType: 'Complaint', complaint: { complainedRecipients: [{ emailAddress: 'angry@example.com' }] } }))).json()).toEqual({ recorded: 1 });
    const byEmail = Object.fromEntries(((await admin.get('/api/v1/contacts?q=example.com&limit=100')).body.data as { email: string; status: string }[]).map((c) => [c.email, c.status]));
    expect(byEmail['bounce@example.com']).toBe('bounced');
    expect(byEmail['angry@example.com']).toBe('unsubscribed');

    // Suppressed addresses are never emailed, even if added to a list later.
    const listId = await listWith(admin, 'After bounce', []);
    await admin.post(`/api/v1/contact-lists/${listId}/members`, { contactIds: (await admin.get('/api/v1/contacts?q=bounce@')).body.data.map((c: { id: string }) => c.id) });
    const created = await admin.post(`/api/v1/surveys/${survey.id}/campaigns`, { name: 'After', listId, subject: 'Hi', body: 'Hello' });
    ctx.deps.mailer.outbox.length = 0;
    await admin.post(`/api/v1/campaigns/${created.body.id}/send`, {});
    await drainJobs(ctx);
    expect(ctx.deps.mailer.outbox).toHaveLength(0);
    ctx.deps.config.sesTopicArns = [];
  });
});

describe('anonymous campaigns', () => {
  it('mark recipients as responded without linking the response', async () => {
    const q = createQuestion('nps', 'Recommend us?');
    const draft = await createSurvey(admin, 'Anonymous campaign');
    await admin.patch(`/api/v1/surveys/${draft.id}`, { anonymous: true });
    const saved = await saveDraft(admin, draft.id, definitionWith([q]));
    await admin.post(`/api/v1/surveys/${draft.id}/publish`, { revision: saved.body.revision });
    const listId = await listWith(admin, 'Anon list', [{ email: 'anon1@example.com', firstName: 'Ann' }]);
    const created = await admin.post(`/api/v1/surveys/${draft.id}/campaigns`, { name: 'Anon', listId, subject: 'Hi', body: 'Hello {{survey.link}}' });
    ctx.deps.mailer.outbox.length = 0;
    await admin.post(`/api/v1/campaigns/${created.body.id}/send`, {});
    await drainJobs(ctx);
    const token = linkIn(ctx.deps.mailer.outbox[0]!.text)![1]!;

    const r = new Respondent(ctx.app, draft.publicId, { query: `?t=${token}` });
    expect((await r.load()).body.contact).toBeNull(); // no contact fields in anonymous surveys
    expect((await r.complete({ [q.key]: 9 }, { start: { recipientToken: token } })).status).toBe(200);

    const { rows } = await ctx.owner.query(
      `select r.status, r.responded_at, (select count(*)::int from responses where survey_id = $2 and recipient_id is not null) as linked
         from recipients r where r.campaign_id = $1`,
      [created.body.id, draft.id],
    );
    expect(rows[0].status).toBe('responded');
    expect(rows[0].linked).toBe(0);
    expect(new Date(rows[0].responded_at).getUTCMinutes()).toBe(0); // hour precision
    // The database refuses a link even if the app tried.
    await expect(
      ctx.owner.query(`update responses set recipient_id = gen_random_uuid() where survey_id = $1`, [draft.id]).then(() =>
        ctx.owner.query(`insert into responses (id, org_id, survey_id, version_id, response_key_hash, status, locale, started_at, last_activity_at, recipient_id)
          select gen_random_uuid(), org_id, survey_id, version_id, '\\x00', 'in_progress', 'en', now(), now(), gen_random_uuid() from responses where survey_id = $1 limit 1`, [draft.id]),
      ),
    ).rejects.toThrow(/anonymous/);

    // The link is used up: a second visit says so, and a second response is refused.
    const again = new Respondent(ctx.app, draft.publicId, { query: `?t=${token}` });
    expect((await again.load()).body.access).toEqual({ state: 'already_responded' });
    expect((await again.save({}, { start: { recipientToken: token } })).body.code).toBe('already_responded');
  });
});

describe('resume link by email', () => {
  it('emails a link carrying the response key in the fragment, not for anonymous surveys', async () => {
    const q = createQuestion('short_text', 'Q');
    const { survey } = await publishedSurvey(admin, definitionWith([q], ['long_text']), 'Resume');
    const r = new Respondent(ctx.app, survey.publicId);
    const send = () => ctx.app.inject({ method: 'POST', url: `/r/v1/s/${survey.publicId}/response/resume-link`, payload: { email: 'me@example.com' }, headers: { 'x-response-key': r.key } });
    expect((await send()).json().code).toBe('not_started');
    await r.save({ [q.key]: 'halfway' });
    ctx.deps.mailer.outbox.length = 0;
    expect((await send()).statusCode).toBe(202);
    expect(ctx.deps.mailer.outbox[0]!.text).toContain(`/s/${survey.publicId}#k=${r.key}`);
    for (let i = 0; i < 3; i++) await send();
    expect((await send()).statusCode).toBe(429);
  });
});

// ── Analytics ────────────────────────────────────────────────────────────
describe('analytics', () => {
  let surveyId: string;
  let publicId: string;
  let color: Question & { options: { key: string }[] };
  let size: Question & { options: { key: string }[] };
  let why: Question;

  beforeAll(async () => {
    const c = createQuestion('single_choice', 'Favourite colour');
    const s = createQuestion('single_choice', 'Size');
    if (c.type !== 'single_choice' || s.type !== 'single_choice') throw new Error('unreachable');
    c.options = [createOption('Red'), createOption('Blue')];
    s.options = [createOption('Small'), createOption('Large')];
    color = c;
    size = s;
    why = { ...createQuestion('long_text', 'Why?'), required: false };
    const def: SurveyDefinition = definitionWith([color, size], [why]);
    def.hiddenFields = [{ key: 'src' }];
    const { survey } = await publishedSurvey(admin, def, 'Analytics');
    surveyId = survey.id;
    publicId = survey.publicId;
    // Red goes with Small (8 of 10), Blue with Large (8 of 10): a strong association.
    const plan = [
      ...Array.from({ length: 8 }, () => ['Red', 'Small', 'web', 'fast delivery and friendly support']),
      ...Array.from({ length: 2 }, () => ['Red', 'Large', 'email', 'support was slow']),
      ...Array.from({ length: 8 }, () => ['Blue', 'Large', 'email', 'pricing too high']),
      ...Array.from({ length: 2 }, () => ['Blue', 'Small', 'web', 'friendly support']),
    ];
    for (const [i, [col, sz, src, text]] of plan.entries()) {
      const r = new Respondent(ctx.app, publicId, { ip: `10.60.${Math.floor(i / 10)}.${i}` });
      const res = await r.complete(
        { [color.key]: color.options[col === 'Red' ? 0 : 1]!.key, [size.key]: size.options[sz === 'Small' ? 0 : 1]!.key, [why.key]: text },
        { start: { hiddenFields: { src } } },
      );
      if (res.status !== 200) throw new Error(JSON.stringify(res.body));
    }
    // Two people stop after the first page.
    for (let i = 0; i < 2; i++) {
      const r = new Respondent(ctx.app, publicId, { ip: `10.61.0.${i}` });
      await r.save({ [color.key]: color.options[0]!.key }, { currentPageKey: 'p_page0001' });
    }
    await drainJobs(ctx);
  }, 60_000);

  const query = (body: object) => admin.post(`/api/v1/surveys/${surveyId}/results/query`, body);
  const pick = (summary: { questions: { questionKey: string }[] }, key: string) => summary.questions.find((q) => q.questionKey === key) as never as { options: { label: string; count: number }[] };

  it('filters by answer, hidden field and response field, and compares segments', async () => {
    const red = await query({ filter: { question: color.key, op: 'eq', value: color.options[0]!.key } });
    expect(red.status).toBe(200);
    expect(red.body.overall.totals.completed).toBe(10);
    expect(pick(red.body.overall, size.key).options.map((o) => o.count)).toEqual([8, 2]);
    const web = await query({ filter: { hidden: 'src', op: 'eq', value: 'WEB' } });
    expect(web.body.overall.totals.completed).toBe(10);
    const notRed = await query({ filter: { not: { question: color.key, op: 'eq', value: color.options[0]!.key } } });
    expect(notRed.body.overall.totals.completed).toBe(10);
    const partial = await query({ includePartial: true, filter: { field: 'status', op: 'eq', value: 'in_progress' } });
    expect(partial.body.overall.totals.started).toBe(2);

    const segments = await query({
      segments: [
        { name: 'Web', filter: { hidden: 'src', op: 'eq', value: 'web' } },
        { name: 'Email', filter: { hidden: 'src', op: 'eq', value: 'email' } },
      ],
    });
    expect(segments.body.segments.map((s: { name: string; summary: { totals: { completed: number } } }) => [s.name, s.summary.totals.completed])).toEqual([
      ['Web', 10],
      ['Email', 10],
    ]);
    expect(pick(segments.body.segments[0].summary, color.key).options.map((o) => o.count)).toEqual([8, 2]);
    expect((await query({ filter: { question: 'q_nope000000', op: 'answered' } })).body.code).toBe('invalid_filter');
  });

  it('cross-tabulates two questions with a chi-square test', async () => {
    const res = await admin.post(`/api/v1/surveys/${surveyId}/results/crosstab`, { rows: { questionKey: color.key }, columns: { questionKey: size.key } });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ counts: [[8, 2], [2, 8]], rowTotals: [10, 10], columnTotals: [10, 10], total: 20 });
    expect(res.body.rowPct).toEqual([[80, 20], [20, 80]]);
    // Chi-square = 7.2 with 1 degree of freedom, p ≈ 0.0073.
    expect(res.body.chiSquare).toEqual({ value: 7.2, df: 1, p: 0.0073 });
  });

  it('reports drop-off by question and frequent words', async () => {
    const drop = await admin.post(`/api/v1/surveys/${surveyId}/results/dropoff`, {});
    expect(drop.body.started).toBe(22);
    expect(drop.body.questions.find((q: { questionKey: string }) => q.questionKey === color.key)).toMatchObject({ answered: 22, leftAfter: 2 });
    expect(drop.body.questions.find((q: { questionKey: string }) => q.questionKey === why.key)).toMatchObject({ answered: 20, leftAfter: 0 });

    const terms = await admin.get(`/api/v1/surveys/${surveyId}/results/questions/${why.key}/terms`);
    expect(terms.body.answered).toBe(20);
    expect(terms.body.terms.slice(0, 3)).toEqual([
      { term: 'support', count: 12 },
      { term: 'friendly', count: 10 },
      { term: 'delivery', count: 8 },
    ]);
    expect(terms.body.terms.map((t: { term: string }) => t.term)).not.toContain('and');
  });

  it('hides small groups in anonymous surveys', async () => {
    const q = createQuestion('single_choice', 'Team');
    if (q.type !== 'single_choice') throw new Error('unreachable');
    const draft = await createSurvey(admin, 'Anonymous groups');
    await admin.patch(`/api/v1/surveys/${draft.id}`, { anonymous: true });
    const saved = await saveDraft(admin, draft.id, definitionWith([q]));
    const pub = await admin.post(`/api/v1/surveys/${draft.id}/publish`, { revision: saved.body.revision });
    const answers = [0, 0, 0, 0, 0, 0, 1, 1];
    for (const [i, o] of answers.entries())
      await new Respondent(ctx.app, pub.body.survey.publicId, { ip: `10.62.0.${i}` }).complete({ [q.key]: q.options[o]!.key });
    const res = await admin.post(`/api/v1/surveys/${draft.id}/results/query`, {
      segments: [
        { name: 'First', filter: { question: q.key, op: 'eq', value: q.options[0]!.key } },
        { name: 'Second', filter: { question: q.key, op: 'eq', value: q.options[1]!.key } },
      ],
    });
    expect(res.body.minGroupSize).toBe(5);
    expect(res.body.segments.map((s: { suppressed: boolean }) => s.suppressed)).toEqual([false, true]);
    expect(res.body.segments[1].summary).toBeNull();
  });

  it('pushes a live update when a response is completed', async () => {
    await ctx.app.listen({ port: 0, host: '127.0.0.1' });
    const { port } = ctx.app.server.address() as AddressInfo;
    const events: string[] = [];
    const req = httpRequest({ host: '127.0.0.1', port, path: `/api/v1/surveys/${surveyId}/live`, headers: { cookie: admin.cookie! } });
    const response = await new Promise<import('node:http').IncomingMessage>((resolve) => {
      req.on('response', resolve);
      req.end();
    });
    expect(response.headers['content-type']).toContain('text/event-stream');
    response.on('data', (chunk: Buffer) => events.push(chunk.toString()));
    await new Promise((r) => setTimeout(r, 100));
    expect(events.join('')).toContain('event: ready');

    const started = Date.now();
    await new Respondent(ctx.app, publicId, { ip: '10.63.0.1' }).complete({ [color.key]: color.options[0]!.key, [size.key]: size.options[0]!.key });
    await drainJobs(ctx);
    while (!events.join('').includes('event: update') && Date.now() - started < 3000) await new Promise((r) => setTimeout(r, 50));
    expect(events.join('')).toContain('"type":"response.completed"');
    expect(Date.now() - started).toBeLessThan(3000);
    req.destroy();
  });
});

// ── Response viewer ──────────────────────────────────────────────────────
describe('response viewer: search, tags, notes, bulk delete', () => {
  let surveyId: string;
  let q: Question;

  beforeAll(async () => {
    q = createQuestion('long_text', 'Comments');
    const nps = createQuestion('nps', 'Score');
    const { survey } = await publishedSurvey(admin, definitionWith([q, nps]), 'Viewer');
    surveyId = survey.id;
    const texts = ['The checkout was confusing', 'Loved the new dashboard', 'Checkout crashed twice', 'Fine overall', 'Dashboard is slow'];
    for (const [i, text] of texts.entries())
      await new Respondent(ctx.app, survey.publicId, { ip: `10.70.0.${i}` }).complete({ [q.key]: text, [nps.key]: i * 2 });
    await drainJobs(ctx);
  });

  const list = (params: string) => admin.get(`/api/v1/surveys/${surveyId}/responses?${params}`);

  it('finds responses by words in open answers', async () => {
    expect((await list('q=checkout')).body.data).toHaveLength(2);
    expect((await list('q=dashboard')).body.data).toHaveLength(2);
    expect((await list('q=nothing-like-this')).body.data).toHaveLength(0);
  });

  it('tags and annotates responses', async () => {
    const tag = await admin.post(`/api/v1/surveys/${surveyId}/tags`, { name: 'Bug' });
    expect(tag.status).toBe(201);
    expect((await admin.post(`/api/v1/surveys/${surveyId}/tags`, { name: 'bug' })).status).toBe(200); // same tag
    const checkout = (await list('q=checkout')).body.data as { id: string }[];
    for (const r of checkout) expect((await admin.put(`/api/v1/surveys/${surveyId}/responses/${r.id}/tags/${tag.body.id}`)).status).toBe(204);
    const tagged = await list(`tag=${tag.body.id}`);
    expect(tagged.body.data).toHaveLength(2);
    expect(tagged.body.data[0].tags).toEqual([{ id: tag.body.id, name: 'Bug' }]);
    const filtered = await admin.post(`/api/v1/surveys/${surveyId}/results/query`, { filter: { field: 'tag', op: 'eq', value: tag.body.id } });
    expect(filtered.body.overall.totals.completed).toBe(2);

    const analyst = await addMember(ctx, admin, 'analyst', 'Ana Analyst');
    await admin.put(`/api/v1/surveys/${surveyId}/collaborators/${analyst.userId}`, { role: 'viewer' });
    const note = await analyst.post(`/api/v1/surveys/${surveyId}/responses/${checkout[0]!.id}/notes`, { body: 'Follow up with the payments team.' });
    expect(note.status).toBe(201);
    const detail = await admin.get(`/api/v1/surveys/${surveyId}/responses/${checkout[0]!.id}`);
    expect(detail.body.notes).toEqual([expect.objectContaining({ body: 'Follow up with the payments team.', author: 'Ana Analyst' })]);
    expect(detail.body.tags).toEqual([{ id: tag.body.id, name: 'Bug' }]);
    // Analysts can't delete tags; an admin can delete anyone's note.
    expect((await analyst.delete(`/api/v1/surveys/${surveyId}/tags/${tag.body.id}`)).status).toBe(403);
    expect((await admin.delete(`/api/v1/surveys/${surveyId}/responses/${checkout[0]!.id}/notes/${note.body.id}`)).status).toBe(204);
  });

  it('bulk deletes exactly the confirmed selection, audits it and repairs aggregates', async () => {
    const before = await admin.get(`/api/v1/surveys/${surveyId}/results/summary`);
    expect(before.body.totals.completed).toBe(5);
    const scope = { status: 'completed', q: 'dashboard' };
    const stale = await admin.post(`/api/v1/surveys/${surveyId}/responses/bulk-delete`, { scope, expectedCount: 3 });
    expect(stale.status).toBe(409);
    expect(stale.body.code).toBe('selection_changed');
    const res = await admin.post(`/api/v1/surveys/${surveyId}/responses/bulk-delete`, { scope, expectedCount: 2 });
    expect(res.body).toEqual({ deleted: 2 });
    const after = await admin.get(`/api/v1/surveys/${surveyId}/results/summary`);
    expect(after.body.source).toBe('aggregate');
    expect(after.body.totals.completed).toBe(3);
    const score = after.body.questions.find((x: { type: string }) => x.type === 'nps');
    expect(score.answered).toBe(3);
    const { rows } = await ctx.owner.query(`select metadata from audit_logs where action = 'responses.bulk_deleted' and entity_id = $1`, [surveyId]);
    expect(rows[0].metadata).toMatchObject({ count: 2, selection: { q: 'dashboard' } });
    const viewer = await addMember(ctx, admin, 'analyst');
    await admin.put(`/api/v1/surveys/${surveyId}/collaborators/${viewer.userId}`, { role: 'viewer' });
    expect((await viewer.post(`/api/v1/surveys/${surveyId}/responses/bulk-delete`, { ids: [crypto.randomUUID()], expectedCount: 1 })).status).toBe(403);
  });
});

// ── Exports ──────────────────────────────────────────────────────────────
describe('exports and scheduled reports', () => {
  let surveyId: string;

  beforeAll(async () => {
    const choice = createQuestion('single_choice', 'Pick one');
    const text = createQuestion('short_text', 'Say something');
    const { survey } = await publishedSurvey(admin, definitionWith([choice, text, createQuestion('nps', 'NPS')]), 'Exports');
    surveyId = survey.id;
    const opts = 'options' in choice ? choice.options : [];
    for (let i = 0; i < 6; i++)
      await new Respondent(ctx.app, survey.publicId, { ip: `10.80.0.${i}` }).complete({
        [choice.key]: opts[i % 2]!.key,
        [text.key]: i === 0 ? '=HYPERLINK("http://evil.example")' : `text ${i}, with "quotes"`,
        ['q_x']: undefined,
      });
    await drainJobs(ctx);
  });

  async function runExport(format: 'csv' | 'xlsx' | 'pdf') {
    const created = await admin.post(`/api/v1/surveys/${surveyId}/exports`, { format });
    expect(created.status).toBe(202);
    await drainJobs(ctx);
    const job = await admin.get(`/api/v1/exports/${created.body.id}`);
    expect(job.body).toMatchObject({ status: 'done', rowCount: 6 });
    const file = await ctx.app.inject({ url: job.body.downloadUrl, headers: { cookie: admin.cookie! } });
    expect(file.statusCode).toBe(200);
    return file;
  }

  it('produces XLSX with exactly the CSV content, and a PDF report', async () => {
    const csv = await admin.get(`/api/v1/surveys/${surveyId}/export.csv`);
    const csvRows = parseCsv(csv.raw.trimStart());
    const xlsx = await runExport('xlsx');
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(xlsx.rawPayload as unknown as ArrayBuffer);
    const sheet = workbook.getWorksheet('Responses')!;
    const xlsxRows: string[][] = [];
    // Empty cells come back as holes in row.values; Array.from turns them into undefined.
    sheet.eachRow((row) => xlsxRows.push(Array.from(row.values as unknown[]).slice(1).map((v) => (v === null || v === undefined ? '' : String(v)))));
    const width = csvRows[0]!.length;
    expect(xlsxRows.map((r) => [...r, ...Array(width - r.length).fill('')])).toEqual(csvRows);
    expect(xlsxRows.flat()).toContain(`'=HYPERLINK("http://evil.example")`);

    const pdf = await runExport('pdf');
    expect(pdf.headers['content-type']).toBe('application/pdf');
    expect(pdf.rawPayload.subarray(0, 5).toString()).toBe('%PDF-');
    expect(pdf.rawPayload.length).toBeGreaterThan(2000);

    const csvJob = await runExport('csv');
    expect(csvJob.rawPayload.toString('utf8').trimStart()).toBe(csv.raw.trimStart());
    const { rows } = await ctx.owner.query(`select count(*)::int as n from audit_logs where action = 'export.downloaded'`);
    expect(rows[0].n).toBeGreaterThanOrEqual(3);
  });

  it('runs scheduled reports once per due time, only for people who can see the survey', async () => {
    const outsider = await signup(ctx.app, { orgName: 'Outsiders' });
    const bad = await admin.post(`/api/v1/surveys/${surveyId}/scheduled-reports`, {
      name: 'Weekly', frequency: 'weekly', day: 1, hour: 8, timezone: 'Europe/London', format: 'xlsx', recipientIds: [outsider.userId],
    });
    expect(bad.body.code).toBe('invalid_recipient');
    const created = await admin.post(`/api/v1/surveys/${surveyId}/scheduled-reports`, {
      name: 'Weekly', frequency: 'weekly', day: 1, hour: 8, timezone: 'Europe/London', format: 'csv', recipientIds: [admin.userId],
    });
    expect(created.status).toBe(201);
    const next = new Date(created.body.nextRunAt);
    expect(next.getTime()).toBeGreaterThan(Date.now());
    expect(next.getUTCDay()).toBe(1);

    await ctx.owner.query(`update scheduled_reports set next_run_at = now() - interval '1 minute' where id = $1`, [created.body.id]);
    ctx.deps.mailer.outbox.length = 0;
    await ctx.handlers['reports.tick']({});
    await ctx.handlers['reports.tick']({}); // not due any more: nothing sent twice
    expect(ctx.deps.mailer.outbox).toHaveLength(1);
    const mail = ctx.deps.mailer.outbox[0]!;
    expect(mail.to).toBe(admin.me!.user.email);
    expect(mail.attachments?.[0]?.filename).toMatch(/\.csv$/);
    expect(mail.attachments?.[0]?.content.toString('utf8')).toContain('Pick one');
    const after = (await admin.get(`/api/v1/surveys/${surveyId}/scheduled-reports`)).body[0];
    expect(after).toMatchObject({ lastStatus: 'sent' });
    expect(new Date(after.nextRunAt).getTime()).toBeGreaterThan(Date.now());
  });
});

/** RFC 4180 parser for test assertions. */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') {
      row.push(cell);
      cell = '';
    } else if (ch === '\n') {
      row.push(cell.replace(/\r$/, ''));
      rows.push(row);
      row = [];
      cell = '';
    } else cell += ch;
  }
  if (cell || row.length) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}

void recipientToken;
