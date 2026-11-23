import { randomBytes } from 'node:crypto';
import type { FastifyInstance, FastifyServerOptions, InjectOptions } from 'fastify';
import {
  createDefinition,
  createQuestion,
  type Question,
  type QuestionType,
  type SurveyDefinition,
} from '@survey/core';
import type { Me, SurveyDetail } from '@survey/contracts';
import { ALL_QUEUES, createPool, loadRootEnv, requireEnv, type Pool } from '@survey/db';
import { buildApp } from '../src/app';
import { loadConfig } from '../src/config';
import { closeDeps, createDeps, type Deps } from '../src/deps';
import { createJobHandlers, type JobHandlers } from '../src/jobs/handlers';

loadRootEnv();

export interface TestContext {
  app: FastifyInstance;
  deps: Deps;
  owner: Pool;
  handlers: JobHandlers;
  close(): Promise<void>;
}

export async function createTestContext(
  opts: { logger?: FastifyServerOptions['logger'] } = {},
): Promise<TestContext> {
  // Lets tests simulate different respondent IPs with X-Forwarded-For.
  process.env.TRUST_PROXY = 'true';
  const config = loadConfig({
    env: 'test',
    databaseUrl: requireEnv('TEST_DATABASE_URL'),
    redisUrl: requireEnv('TEST_REDIS_URL'),
    emailTransport: 'memory',
    cookieSecure: false,
    signupMode: 'open',
    storage: 'memory',
    scanner: 'fake',
    captcha: 'fake',
  });
  const deps = await createDeps(config, { worker: false });
  const app = await buildApp(deps, { logger: opts.logger ?? false });
  const owner = createPool(requireEnv('TEST_DATABASE_OWNER_URL'), 2);
  await resetData(owner, deps);
  return {
    app,
    deps,
    owner,
    handlers: createJobHandlers(deps),
    async close() {
      await app.close();
      await owner.end();
      await closeDeps(deps);
    },
  };
}

/** Empty every table and queue between test files. */
export async function resetData(owner: Pool, deps: Deps): Promise<void> {
  const { rows } = await owner.query<{ tablename: string }>(
    `select tablename from pg_tables where schemaname = 'public' and tablename <> 'schema_migrations'`,
  );
  await owner.query(`truncate ${rows.map((r) => `"${r.tablename}"`).join(', ')} cascade`);
  await owner.query(`delete from pgboss.job`);
  await deps.redis.flushdb();
  deps.mailer.outbox.length = 0;
}

/** Run every queued job in-process until all queues are empty (deterministic stand-in for the worker). */
export async function drainJobs(ctx: TestContext): Promise<number> {
  let processed = 0;
  for (let round = 0; round < 10; round++) {
    let found = 0;
    for (const name of ALL_QUEUES) {
      const jobs = await ctx.deps.jobs.boss.fetch<unknown>(name, { batchSize: 100 });
      for (const job of jobs) {
        await (ctx.handlers[name] as (data: unknown) => Promise<void>)(job.data);
        await ctx.deps.jobs.boss.complete(name, job.id);
      }
      found += jobs.length;
    }
    processed += found;
    if (found === 0) break;
  }
  return processed;
}

export interface Res<T = any> {
  status: number;
  body: T;
  headers: Record<string, string | string[] | undefined>;
  raw: string;
}

/** Minimal browser stand-in: keeps the session cookie and sends the CSRF token like the web app. */
export class Client {
  cookie: string | null = null;
  csrf: string | null = null;
  me: Me | null = null;

  constructor(readonly app: FastifyInstance) {}

  async request<T = any>(
    method: InjectOptions['method'],
    url: string,
    body?: unknown,
    headers: Record<string, string> = {},
  ): Promise<Res<T>> {
    const unsafe = !['GET', 'HEAD'].includes(String(method));
    const res = await this.app.inject({
      method,
      url,
      ...(body !== undefined ? { payload: JSON.stringify(body) } : {}),
      headers: {
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        ...(this.cookie ? { cookie: this.cookie } : {}),
        ...(unsafe && this.csrf ? { 'x-csrf-token': this.csrf } : {}),
        ...headers,
      },
    });
    const sid = res.cookies.find((c) => c.name === 'sid');
    if (sid) this.cookie = sid.value ? `sid=${sid.value}` : null;
    let parsed: unknown = undefined;
    const type = String(res.headers['content-type'] ?? '');
    if (type.includes('json')) parsed = res.json();
    if (parsed && typeof parsed === 'object' && 'csrfToken' in parsed) {
      this.csrf = (parsed as Me).csrfToken;
      if ('user' in parsed) this.me = parsed as Me;
    }
    return {
      status: res.statusCode,
      body: parsed as T,
      headers: res.headers as Res['headers'],
      raw: res.body,
    };
  }

  get<T = any>(url: string, headers?: Record<string, string>) {
    return this.request<T>('GET', url, undefined, headers);
  }
  post<T = any>(url: string, body?: unknown, headers?: Record<string, string>) {
    return this.request<T>('POST', url, body, headers);
  }
  put<T = any>(url: string, body?: unknown, headers?: Record<string, string>) {
    return this.request<T>('PUT', url, body, headers);
  }
  patch<T = any>(url: string, body?: unknown) {
    return this.request<T>('PATCH', url, body);
  }
  delete<T = any>(url: string) {
    return this.request<T>('DELETE', url);
  }

  /** Upload one file as multipart/form-data, with the session cookie and CSRF token. */
  async upload<T = any>(url: string, filename: string, content: Buffer | string): Promise<Res<T>> {
    const form = multipartBody(filename, content);
    const res = await this.app.inject({
      method: 'POST',
      url,
      payload: form.payload,
      headers: { ...form.headers, ...(this.cookie ? { cookie: this.cookie } : {}), ...(this.csrf ? { 'x-csrf-token': this.csrf } : {}) },
    });
    return { status: res.statusCode, body: res.json() as T, headers: res.headers as Res['headers'], raw: res.body };
  }

  get orgId(): string {
    return this.me!.activeOrg!.id;
  }
  get userId(): string {
    return this.me!.user.id;
  }
}

let counter = 0;
export const uniqueEmail = (prefix = 'user') => `${prefix}.${Date.now()}.${counter++}@example.com`;
export const PASSWORD = 'correct-horse-battery';

export async function signup(
  app: FastifyInstance,
  overrides: Partial<{ name: string; email: string; orgName: string }> = {},
) {
  const client = new Client(app);
  const res = await client.post('/api/v1/auth/signup', {
    name: overrides.name ?? 'Ada Admin',
    email: overrides.email ?? uniqueEmail('admin'),
    password: PASSWORD,
    orgName: overrides.orgName ?? 'Acme Research',
  });
  if (res.status !== 201) throw new Error(`signup failed: ${res.status} ${res.raw}`);
  return client;
}

export async function login(app: FastifyInstance, email: string, password = PASSWORD) {
  const client = new Client(app);
  const res = await client.post('/api/v1/auth/login', { email, password });
  if (res.status !== 200) throw new Error(`login failed: ${res.status} ${res.raw}`);
  return client;
}

/** Invite someone into the admin's org with a role, accept, and return their logged-in client. */
export async function addMember(
  ctx: TestContext,
  admin: Client,
  role: 'org_admin' | 'creator' | 'analyst',
  name: string = role,
) {
  const email = uniqueEmail(role);
  const inv = await admin.post('/api/v1/org/invitations', { email, role });
  if (inv.status !== 201) throw new Error(`invite failed: ${inv.raw}`);
  await drainJobs(ctx);
  const message = ctx.deps.mailer.outbox.find((m) => m.to === email);
  const token = message?.text.match(/\/invite\/([A-Za-z0-9_-]+)/)?.[1];
  if (!token) throw new Error('invitation email not sent');
  const client = new Client(ctx.app);
  const res = await client.post(`/api/v1/invitations/${token}/accept`, { name, password: PASSWORD });
  if (res.status !== 200) throw new Error(`accept failed: ${res.status} ${res.raw}`);
  return Object.assign(client, { email });
}

/** A small publishable definition: one page per entry in `pages`. */
export function definitionWith(...pages: (QuestionType | Question)[][]): SurveyDefinition {
  const def = createDefinition();
  def.pages = pages.map((elements, i) => ({
    key: `p_page${String(i).padStart(4, '0')}`,
    elements: elements.map((e) => {
      if (typeof e !== 'string') return e;
      const q = createQuestion(e, `Question ${e}`);
      return q;
    }),
  }));
  return def;
}

export async function createSurvey(client: Client, title = 'Customer survey'): Promise<SurveyDetail> {
  const res = await client.post<SurveyDetail>('/api/v1/surveys', { title });
  if (res.status !== 201) throw new Error(`create survey failed: ${res.raw}`);
  return res.body;
}

export async function saveDraft(client: Client, surveyId: string, definition: SurveyDefinition) {
  const draft = await client.get(`/api/v1/surveys/${surveyId}/draft`);
  return client.put(
    `/api/v1/surveys/${surveyId}/draft`,
    { definition },
    { 'if-match': `"rev-${draft.body.revision}"` },
  );
}

/** Create, fill and publish a survey; returns its detail and the published definition. */
export async function publishedSurvey(
  client: Client,
  definition: SurveyDefinition,
  title = 'Customer survey',
) {
  const survey = await createSurvey(client, title);
  const saved = await saveDraft(client, survey.id, definition);
  if (saved.status !== 200) throw new Error(`save failed: ${saved.raw}`);
  const pub = await client.post(`/api/v1/surveys/${survey.id}/publish`, { revision: saved.body.revision });
  if (pub.status !== 200) throw new Error(`publish failed: ${pub.raw}`);
  return { survey: pub.body.survey as SurveyDetail, versionId: pub.body.version.id as string, definition };
}

export const newResponseKey = () => randomBytes(16).toString('base64url');

/** Respondent stand-in: GET the survey, save once, complete. */
export class Respondent {
  readonly key: string;
  seq = 0;
  constructor(
    readonly app: FastifyInstance,
    readonly publicId: string,
    readonly opts: { ip?: string; userAgent?: string; query?: string; headers?: Record<string, string>; key?: string } = {},
  ) {
    this.key = opts.key ?? newResponseKey();
  }

  private headers() {
    return {
      ...this.opts.headers,
      'x-response-key': this.key,
      ...(this.opts.ip ? { 'x-forwarded-for': this.opts.ip } : {}),
      'user-agent': this.opts.userAgent ?? 'Mozilla/5.0 (Windows NT 10.0) Chrome/140',
    };
  }

  async load() {
    const res = await this.app.inject({
      method: 'GET',
      url: `/r/v1/s/${this.publicId}${this.opts.query ?? ''}`,
      headers: this.headers(),
    });
    return { status: res.statusCode, body: res.json() };
  }

  async save(answers: Record<string, unknown>, extra: Record<string, unknown> = {}, path = 'response') {
    const survey = await this.load();
    this.seq++;
    const body = {
      seq: this.seq,
      start: {
        versionId: survey.body.version?.id ?? '00000000-0000-0000-0000-000000000000',
        locale: 'en',
        ...(extra.start as object),
      },
      answers,
      currentPageKey:
        (extra.currentPageKey as string) ?? survey.body.version?.definition.pages[0].key ?? 'p_x',
      ...Object.fromEntries(Object.entries(extra).filter(([k]) => !['start', 'currentPageKey'].includes(k))),
    };
    const res = await this.app.inject({
      method: path === 'response' ? 'PUT' : 'POST',
      url: `/r/v1/s/${this.publicId}/${path}`,
      payload: JSON.stringify(body),
      headers: { ...this.headers(), 'content-type': 'application/json' },
    });
    return { status: res.statusCode, body: res.json() };
  }

  complete(answers: Record<string, unknown>, extra: Record<string, unknown> = {}) {
    return this.save(answers, extra, 'response/complete');
  }

  async upload(questionKey: string, filename: string, content: Buffer | string) {
    const form = multipartBody(filename, content);
    const res = await this.app.inject({
      method: 'POST',
      url: `/r/v1/s/${this.publicId}/uploads?questionKey=${questionKey}`,
      payload: form.payload,
      headers: { ...this.headers(), ...form.headers },
    });
    return { status: res.statusCode, body: res.json() };
  }

  async removeUpload(fileId: string) {
    const res = await this.app.inject({ method: 'DELETE', url: `/r/v1/s/${this.publicId}/uploads/${fileId}`, headers: this.headers() });
    return { status: res.statusCode };
  }
}

/** A multipart/form-data body with one file field, as a browser would send it. */
export function multipartBody(filename: string, content: Buffer | string, type = 'application/octet-stream') {
  const boundary = `----survey-test-${randomBytes(8).toString('hex')}`;
  const payload = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: ${type}\r\n\r\n`),
    Buffer.isBuffer(content) ? content : Buffer.from(content),
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  return { payload, headers: { 'content-type': `multipart/form-data; boundary=${boundary}` } };
}

/** A 1×1 PNG. */
export const TINY_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
);
