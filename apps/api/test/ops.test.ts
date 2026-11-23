/** Logging hygiene, health checks and scheduled jobs. */
import { Writable } from 'node:stream';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  addMember,
  createTestContext,
  definitionWith,
  drainJobs,
  publishedSurvey,
  Respondent,
  signup,
  type TestContext,
} from './helpers';

const logLines: string[] = [];
let ctx: TestContext;

beforeAll(async () => {
  const stream = new Writable({
    write(chunk, _enc, done) {
      logLines.push(chunk.toString());
      done();
    },
  });
  const { loggerOptions } = await import('../src/app');
  ctx = await createTestContext({ logger: false });
  await ctx.app.close();
  // Rebuild the app with the production logger configuration writing into memory.
  const { buildApp } = await import('../src/app');
  const options = loggerOptions(ctx.deps) as Record<string, unknown>;
  delete options.transport;
  ctx.app = await buildApp(ctx.deps, { logger: { ...options, level: 'info', stream } as never });
});
afterAll(async () => ctx.close());

describe('logs', () => {
  it('never contain answers, emails, tokens, cookies or IPs', async () => {
    const admin = await signup(ctx.app, { name: 'Logan Logs' });
    const email = admin.me!.user.email;
    const member = await addMember(ctx, admin, 'creator'); // invitation token travels in the URL path
    const def = definitionWith(['short_text']);
    const { survey } = await publishedSurvey(admin, def);
    const key = def.pages[0]!.elements[0]!.key;
    const respondent = new Respondent(ctx.app, survey.publicId, { ip: '198.51.100.23' });
    await respondent.complete({ [key]: 'SECRET-ANSWER-9431' });
    await admin.get(`/api/v1/surveys/${survey.id}/export.csv`);

    const invite = ctx.deps.mailer.outbox.find((m) => m.to === member.email)!;
    const inviteToken = invite.text.match(/\/invite\/([A-Za-z0-9_-]+)/)![1]!;
    const log = logLines.join('\n');

    expect(logLines.length).toBeGreaterThan(5);
    expect(log).toContain('"url":"/api/v1/invitations/[token]/accept"');
    for (const secret of [
      email,
      'SECRET-ANSWER-9431',
      inviteToken,
      respondent.key,
      admin.csrf!,
      '198.51.100.23',
      admin.cookie!.split('=')[1]!,
    ]) {
      expect(log, `log leaked ${secret.slice(0, 12)}…`).not.toContain(secret);
    }
  });
});

describe('health', () => {
  it('reports liveness and readiness', async () => {
    expect((await ctx.app.inject({ method: 'GET', url: '/healthz' })).json()).toEqual({ status: 'ok' });
    expect((await ctx.app.inject({ method: 'GET', url: '/readyz' })).json()).toEqual({ status: 'ready' });
  });
});

describe('scheduled jobs', () => {
  it('closes surveys whose close date has passed, with an audit entry', async () => {
    const admin = await signup(ctx.app);
    const { survey } = await publishedSurvey(admin, definitionWith(['short_text']));
    await ctx.owner.query(
      `update surveys set access = jsonb_set(access, '{closesAt}', to_jsonb(now() - interval '1 minute')) where id = $1`,
      [survey.id],
    );
    await ctx.handlers['surveys.close-expired']({});
    const { rows } = await ctx.owner.query('select status, closed_reason from surveys where id = $1', [
      survey.id,
    ]);
    expect(rows[0]).toEqual({ status: 'closed', closed_reason: 'close_date' });
    const audit = await ctx.owner.query(
      `select actor_type from audit_logs where entity_id = $1 and action = 'survey.closed'`,
      [survey.id],
    );
    expect(audit.rows[0].actor_type).toBe('system');
  });

  it('nightly repair re-queues aggregation for surveys with recent activity', async () => {
    const admin = await signup(ctx.app);
    const def = definitionWith(['nps']);
    const { survey } = await publishedSurvey(admin, def);
    await new Respondent(ctx.app, survey.publicId).complete({ [def.pages[0]!.elements[0]!.key]: 9 });
    await drainJobs(ctx);
    await ctx.owner.query('delete from question_counts where survey_id = $1', [survey.id]); // simulate drift
    await ctx.handlers['aggregates.nightly']({});
    await drainJobs(ctx);
    const { rows } = await ctx.owner.query(
      `select sum(count)::int as n from question_counts where survey_id = $1 and bucket = '__answered__'`,
      [survey.id],
    );
    expect(rows[0].n).toBe(1);
  });

  it('removes expired sessions', async () => {
    const admin = await signup(ctx.app);
    await ctx.owner.query(`update sessions set expires_at = now() - interval '1 day' where user_id = $1`, [
      admin.userId,
    ]);
    await ctx.handlers['sessions.cleanup']({});
    const { rows } = await ctx.owner.query('select count(*)::int as n from sessions where user_id = $1', [
      admin.userId,
    ]);
    expect(rows[0].n).toBe(0);
  });
});
