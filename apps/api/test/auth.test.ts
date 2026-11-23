import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  addMember,
  Client,
  createSurvey,
  createTestContext,
  drainJobs,
  login,
  PASSWORD,
  signup,
  uniqueEmail,
  type TestContext,
} from './helpers';

let ctx: TestContext;
beforeAll(async () => {
  ctx = await createTestContext();
});
afterAll(async () => ctx.close());

const tokenFrom = (text: string, path: string) =>
  text.match(new RegExp(`${path}[?/](?:token=)?([A-Za-z0-9_-]+)`))?.[1];

describe('signup and login', () => {
  it('creates an org with the user as org_admin and sends a verification email', async () => {
    const email = uniqueEmail('founder');
    const client = new Client(ctx.app);
    const res = await client.post('/api/v1/auth/signup', {
      name: 'Founder',
      email,
      password: PASSWORD,
      orgName: 'Globex',
    });
    expect(res.status).toBe(201);
    expect(res.body.activeOrg).toMatchObject({ name: 'Globex', role: 'org_admin' });
    expect(res.body.user).toMatchObject({ email, emailVerified: false });

    const setCookie = String(res.headers['set-cookie']);
    expect(setCookie).toMatch(/HttpOnly/i);
    expect(setCookie).toMatch(/SameSite=Lax/i);
    expect(setCookie).toMatch(/Path=\//);

    await drainJobs(ctx);
    const mail = ctx.deps.mailer.outbox.find((m) => m.to === email);
    expect(mail?.subject).toMatch(/confirm/i);
    const token = tokenFrom(mail!.text, 'verify-email');
    expect((await client.post('/api/v1/auth/verify-email', { token })).status).toBe(204);
    expect((await client.post('/api/v1/auth/verify-email', { token })).status).toBe(400); // single use
    expect((await client.get('/api/v1/auth/me')).body.user.emailVerified).toBe(true);
  });

  it('rejects a duplicate email and weak passwords', async () => {
    const admin = await signup(ctx.app);
    const dup = await new Client(ctx.app).post('/api/v1/auth/signup', {
      name: 'X',
      email: admin.me!.user.email,
      password: PASSWORD,
      orgName: 'X',
    });
    expect(dup.status).toBe(409);
    expect(dup.body.code).toBe('email_taken');

    const weak = await new Client(ctx.app).post('/api/v1/auth/signup', {
      name: 'X',
      email: uniqueEmail(),
      password: 'short',
      orgName: 'X',
    });
    expect(weak.status).toBe(422);
    expect(weak.body.errors[0].path).toBe('password');
  });

  it('gives the same error for a wrong password and an unknown email', async () => {
    const admin = await signup(ctx.app);
    const wrong = await new Client(ctx.app).post('/api/v1/auth/login', {
      email: admin.me!.user.email,
      password: 'nope-nope-nope',
    });
    const unknown = await new Client(ctx.app).post('/api/v1/auth/login', {
      email: uniqueEmail('ghost'),
      password: 'nope-nope-nope',
    });
    expect(wrong.status).toBe(401);
    expect(unknown.status).toBe(401);
    expect(wrong.body.title).toBe(unknown.body.title);
  });

  it('throttles repeated login attempts for one account', async () => {
    const admin = await signup(ctx.app);
    const statuses: number[] = [];
    for (let i = 0; i < 11; i++) {
      statuses.push(
        (
          await new Client(ctx.app).post('/api/v1/auth/login', {
            email: admin.me!.user.email,
            password: 'wrong-password-x',
          })
        ).status,
      );
    }
    expect(statuses.slice(0, 10).every((s) => s === 401)).toBe(true);
    expect(statuses[10]).toBe(429);
  });

  it('logs out', async () => {
    const admin = await signup(ctx.app);
    expect((await admin.post('/api/v1/auth/logout')).status).toBe(204);
    expect((await admin.get('/api/v1/auth/me')).status).toBe(401);
  });
});

describe('CSRF and request hygiene', () => {
  it('rejects state-changing requests without a valid CSRF token', async () => {
    const admin = await signup(ctx.app);
    const csrf = admin.csrf;
    admin.csrf = null;
    expect((await admin.post('/api/v1/surveys', { title: 'x' })).status).toBe(403);
    admin.csrf = 'forged-token';
    const forged = await admin.post('/api/v1/surveys', { title: 'x' });
    expect(forged.status).toBe(403);
    expect(forged.body.code).toBe('csrf_failed');
    admin.csrf = csrf;
    expect((await admin.post('/api/v1/surveys', { title: 'x' })).status).toBe(201);
  });

  it('only accepts JSON bodies (blocks cross-site form posts)', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: '{"email":"a@b.co","password":"x"}',
      headers: { 'content-type': 'text/plain' },
    });
    expect(res.statusCode).toBe(415);
  });

  it('returns problem+json with a request id', async () => {
    const res = await ctx.app.inject({ method: 'GET', url: '/api/v1/auth/me' });
    expect(res.statusCode).toBe(401);
    expect(res.headers['content-type']).toContain('application/problem+json');
    expect(res.json()).toMatchObject({ status: 401, code: 'unauthorized' });
    expect(res.json().requestId).toBe(res.headers['x-request-id']);
  });
});

describe('password reset', () => {
  it('answers the same for unknown emails and sends nothing', async () => {
    await drainJobs(ctx);
    const sentBefore = ctx.deps.mailer.outbox.length;
    const res = await new Client(ctx.app).post('/api/v1/auth/password/forgot', {
      email: uniqueEmail('nobody'),
    });
    expect(res.status).toBe(202);
    expect(await drainJobs(ctx)).toBe(0);
    expect(ctx.deps.mailer.outbox.length).toBe(sentBefore);
  });

  it('resets with a single-use token and revokes existing sessions', async () => {
    const admin = await signup(ctx.app);
    const email = admin.me!.user.email;
    await drainJobs(ctx);
    ctx.deps.mailer.outbox.length = 0;

    expect((await new Client(ctx.app).post('/api/v1/auth/password/forgot', { email })).status).toBe(202);
    await drainJobs(ctx);
    const token = tokenFrom(ctx.deps.mailer.outbox.find((m) => m.to === email)!.text, 'reset-password');

    const reset = await new Client(ctx.app).post('/api/v1/auth/password/reset', {
      token,
      password: 'a-brand-new-password',
    });
    expect(reset.status).toBe(204);
    expect(
      (
        await new Client(ctx.app).post('/api/v1/auth/password/reset', {
          token,
          password: 'another-password-1',
        })
      ).status,
    ).toBe(400);
    expect((await admin.get('/api/v1/auth/me')).status).toBe(401);
    await expect(login(ctx.app, email, 'a-brand-new-password')).resolves.toBeInstanceOf(Client);
  });
});

describe('invitations and members', () => {
  it('lets a new person accept an invitation and join with the invited role', async () => {
    const admin = await signup(ctx.app);
    const analyst = await addMember(ctx, admin, 'analyst', 'Ana Analyst');
    expect(analyst.me!.activeOrg).toMatchObject({ id: admin.orgId, role: 'analyst' });
    expect(analyst.me!.user.emailVerified).toBe(true);

    const members = await admin.get('/api/v1/org/members');
    expect(members.body.data.map((m: { role: string }) => m.role).sort()).toEqual(['analyst', 'org_admin']);
  });

  it('requires an existing user to be logged in as the invited account', async () => {
    const adminA = await signup(ctx.app, { orgName: 'A' });
    const adminB = await signup(ctx.app, { orgName: 'B' });
    const emailB = adminB.me!.user.email;
    await adminA.post('/api/v1/org/invitations', { email: emailB, role: 'creator' });
    await drainJobs(ctx);
    const token = tokenFrom(
      ctx.deps.mailer.outbox.find((m) => m.to === emailB && m.subject.includes('invited'))!.text,
      'invite',
    );

    const preview = await new Client(ctx.app).get(`/api/v1/invitations/${token}`);
    expect(preview.body).toMatchObject({ email: emailB, role: 'creator', userExists: true });

    const anonymous = await new Client(ctx.app).post(`/api/v1/invitations/${token}/accept`, {});
    expect(anonymous.status).toBe(403);
    expect(anonymous.body.code).toBe('login_required');
    const wrongUser = await adminA.post(`/api/v1/invitations/${token}/accept`, {});
    expect(wrongUser.status).toBe(403);

    const accepted = await adminB.post(`/api/v1/invitations/${token}/accept`, {});
    expect(accepted.status).toBe(200);
    expect(accepted.body.activeOrg.id).toBe(adminA.orgId);
    expect(accepted.body.memberships).toHaveLength(2);
    expect((await new Client(ctx.app).get(`/api/v1/invitations/${token}`)).status).toBe(404); // used up
  });

  it('revokes invitations and refuses to invite existing members', async () => {
    const admin = await signup(ctx.app);
    const email = uniqueEmail('revoked');
    const inv = await admin.post('/api/v1/org/invitations', { email, role: 'creator' });
    await drainJobs(ctx);
    const token = tokenFrom(ctx.deps.mailer.outbox.find((m) => m.to === email)!.text, 'invite');
    expect((await admin.delete(`/api/v1/org/invitations/${inv.body.id}`)).status).toBe(204);
    expect((await new Client(ctx.app).get(`/api/v1/invitations/${token}`)).status).toBe(404);

    const dup = await admin.post('/api/v1/org/invitations', { email: admin.me!.user.email, role: 'creator' });
    expect(dup.status).toBe(409);
  });

  it('protects the last admin and transfers surveys when removing a member', async () => {
    const admin = await signup(ctx.app);
    const demote = await admin.patch(`/api/v1/org/members/${admin.userId}`, { role: 'creator' });
    expect(demote.status).toBe(409);
    expect(demote.body.code).toBe('last_admin');

    const creator = await addMember(ctx, admin, 'creator', 'Cora Creator');
    const survey = await createSurvey(creator, 'Creator survey');
    expect((await admin.delete(`/api/v1/org/members/${creator.userId}`)).status).toBe(204);

    const detail = await admin.get(`/api/v1/surveys/${survey.id}`);
    expect(detail.body.owner.id).toBe(admin.userId);
    expect((await creator.get('/api/v1/surveys')).status).toBe(403); // no active org any more
  });

  it('only org admins can manage members', async () => {
    const admin = await signup(ctx.app);
    const creator = await addMember(ctx, admin, 'creator');
    expect(
      (await creator.post('/api/v1/org/invitations', { email: uniqueEmail(), role: 'creator' })).status,
    ).toBe(403);
    expect((await creator.patch(`/api/v1/org/members/${admin.userId}`, { role: 'analyst' })).status).toBe(
      403,
    );
    expect((await creator.get('/api/v1/org/members')).status).toBe(200);
  });
});

describe('multiple organizations', () => {
  it('switches org and only shows the active org data; rejects stale tabs', async () => {
    const adminA = await signup(ctx.app, { orgName: 'Org A' });
    const adminB = await signup(ctx.app, { orgName: 'Org B' });
    await createSurvey(adminA, 'A survey');
    await createSurvey(adminB, 'B survey');

    // B's admin joins org A as a creator.
    const email = adminB.me!.user.email;
    await adminA.post('/api/v1/org/invitations', { email, role: 'creator' });
    await drainJobs(ctx);
    const invite = ctx.deps.mailer.outbox.find((m) => m.to === email && m.subject.includes('invited'))!;
    const token = tokenFrom(invite.text, 'invite');
    expect((await adminB.post(`/api/v1/invitations/${token}/accept`, {})).status).toBe(200);
    const orgA = adminA.orgId;
    const orgB = adminB.me!.memberships.find((m) => m.orgName === 'Org B')!.orgId;

    await adminB.post('/api/v1/auth/switch-org', { orgId: orgB });
    const listB = await adminB.get('/api/v1/surveys');
    expect(listB.body.data.map((s: { title: string }) => s.title)).toEqual(['B survey']);

    // A tab that still believes org A is active gets 409 instead of acting on org B.
    const stale = await adminB.request('POST', '/api/v1/surveys', { title: 'oops' }, { 'x-org-id': orgA });
    expect(stale.status).toBe(409);
    expect(stale.body.code).toBe('org_mismatch');

    expect((await adminB.post('/api/v1/auth/switch-org', { orgId: orgA })).status).toBe(200);
    const listA = await adminB.get('/api/v1/surveys');
    expect(listA.body.data).toEqual([]); // a creator sees only surveys shared with them

    const outsider = await signup(ctx.app);
    expect((await outsider.post('/api/v1/auth/switch-org', { orgId: orgA })).status).toBe(403);
  });
});
