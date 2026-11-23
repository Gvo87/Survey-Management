import { hash, verify } from '@node-rs/argon2';
import { and, eq, gt, isNull } from 'drizzle-orm';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import {
  ForgotPasswordRequest,
  LoginRequest,
  ResetPasswordRequest,
  SignupRequest,
  SwitchOrgRequest,
  TokenRequest,
  type Me,
} from '@survey/contracts';
import { randomId } from '@survey/core';
import {
  authTokens,
  memberships,
  newId,
  organizations,
  sessions,
  sha256,
  users,
  withGlobal,
  withTenant,
} from '@survey/db';
import type { Deps } from '../deps';
import { audit } from '../audit';
import { requireUser } from '../auth/context';
import {
  createSession,
  loadSession,
  sessionCookieName,
  sessionCookieOptions,
  userMemberships,
  type AuthContext,
} from '../auth/session';
import { AppError, badRequest, conflict, forbidden } from '../lib/errors';
import { rateLimit } from '../infra/rate-limit';
import { hmac, ipHash } from '../lib/security';
import { slugify } from '../lib/misc';
import { parse } from '../lib/validate';

export function toMe(auth: AuthContext): Me {
  const active = auth.memberships.find((m) => m.orgId === auth.orgId);
  return {
    user: {
      id: auth.userId,
      email: auth.email,
      name: auth.name,
      isSuperAdmin: auth.isSuperAdmin,
      emailVerified: auth.emailVerified,
    },
    activeOrg: active
      ? { id: active.orgId, name: active.orgName, slug: active.orgSlug, role: active.role }
      : null,
    memberships: auth.memberships.map((m) => ({ orgId: m.orgId, orgName: m.orgName, role: m.role })),
    csrfToken: auth.csrfToken,
  };
}

export const hashPassword = (password: string) => hash(password);

let dummyHash: Promise<string> | null = null;
/** Verify against a throwaway hash when the user doesn't exist, so timing doesn't reveal it. */
const burnTime = (password: string) => {
  dummyHash ??= hash('dummy-password-for-timing');
  return dummyHash.then((h) => verify(h, password)).then(() => false);
};

export const isUniqueViolation = (error: unknown) => (error as { code?: string }).code === '23505';

export async function startSession(deps: Deps, reply: FastifyReply, token: string): Promise<Me> {
  reply.setCookie(sessionCookieName(deps.config), token, sessionCookieOptions(deps.config));
  const auth = await loadSession(deps.pool, deps.config, token);
  if (!auth) throw new AppError(500, 'session_failed', 'Could not start a session.');
  return toMe(auth);
}

export function registerAuthRoutes(app: FastifyInstance, deps: Deps): void {
  const { pool, redis, config, jobs } = deps;
  const ua = (req: FastifyRequest) => req.headers['user-agent'];

  app.post('/api/v1/auth/signup', async (req, reply) => {
    const body = parse(SignupRequest, req.body);
    if (config.signupMode === 'invite_only')
      throw forbidden('Sign-up is by invitation only. Ask an admin to invite you.', 'signup_disabled');
    await rateLimit(redis, `signup:ip:${ipHash(config.sessionSecret, req.ip)}`, config.signupsPerHour, 3600);

    const passwordHash = await hashPassword(body.password);
    const userId = newId();
    const orgId = newId();
    let token: string;
    try {
      token = await withTenant(pool, orgId, async (tx) => {
        const [existing] = await tx.db
          .select({ id: users.id })
          .from(users)
          .where(eq(users.email, body.email));
        if (existing)
          throw conflict('email_taken', 'An account with this email already exists. Log in instead.');
        await tx.db.insert(users).values({ id: userId, email: body.email, name: body.name, passwordHash });
        await tx.db.insert(organizations).values({
          id: orgId,
          name: body.orgName,
          slug: `${slugify(body.orgName)}-${randomId(5).toLowerCase()}`,
        });
        await tx.db.insert(memberships).values({ orgId, userId, role: 'org_admin' });
        await audit(tx, {
          orgId,
          actorId: userId,
          action: 'auth.signup',
          entityType: 'user',
          entityId: userId,
          ip: req.ip,
        });
        await jobs.enqueue(tx, 'email.send', { type: 'verify_email', userId });
        return createSession(tx, { userId, orgId, ip: req.ip, userAgent: ua(req) });
      });
    } catch (error) {
      if (isUniqueViolation(error))
        throw conflict('email_taken', 'An account with this email already exists. Log in instead.');
      throw error;
    }
    reply.code(201);
    return startSession(deps, reply, token);
  });

  app.post('/api/v1/auth/login', async (req, reply) => {
    const body = parse(LoginRequest, req.body);
    await rateLimit(redis, `login:ip:${ipHash(config.sessionSecret, req.ip)}`, 100, 900);
    await rateLimit(redis, `login:email:${hmac(config.sessionSecret, body.email)}`, 10, 900);

    const [user] = await withGlobal(pool, (tx) =>
      tx.db.select().from(users).where(eq(users.email, body.email)).limit(1),
    );
    const valid = user?.passwordHash
      ? await verify(user.passwordHash, body.password)
      : await burnTime(body.password);
    if (!user || !valid || user.disabledAt)
      throw new AppError(401, 'invalid_credentials', 'Email or password is incorrect.');

    const orgs = await withGlobal(pool, (tx) => userMemberships(tx, user.id));
    const orgId = orgs[0]?.orgId ?? null;
    const token = await withTenant(pool, orgId, async (tx) => {
      await tx.db.update(users).set({ lastLoginAt: new Date() }).where(eq(users.id, user.id));
      if (orgId) await audit(tx, { orgId, actorId: user.id, action: 'auth.login', ip: req.ip });
      return createSession(tx, { userId: user.id, orgId, ip: req.ip, userAgent: ua(req) });
    });
    return startSession(deps, reply, token);
  });

  app.post('/api/v1/auth/logout', async (req, reply) => {
    const auth = req.auth;
    if (auth)
      await withGlobal(pool, (tx) => tx.db.delete(sessions).where(eq(sessions.idHash, auth.sessionHash)));
    reply.clearCookie(sessionCookieName(config), { path: '/' });
    return reply.code(204).send();
  });

  app.get('/api/v1/auth/me', async (req) => toMe(requireUser(req)));

  app.get('/api/v1/auth/csrf', async (req) => ({ csrfToken: requireUser(req).csrfToken }));

  app.post('/api/v1/auth/switch-org', async (req) => {
    const auth = requireUser(req);
    const { orgId } = parse(SwitchOrgRequest, req.body);
    if (!auth.memberships.some((m) => m.orgId === orgId))
      throw forbidden("You're not a member of that organization.");
    await withGlobal(pool, (tx) =>
      tx.db.update(sessions).set({ activeOrgId: orgId }).where(eq(sessions.idHash, auth.sessionHash)),
    );
    return toMe({ ...auth, orgId, orgRole: auth.memberships.find((m) => m.orgId === orgId)!.role });
  });

  app.post('/api/v1/auth/verify-email', async (req, reply) => {
    const { token } = parse(TokenRequest, req.body);
    const ok = await consumeToken(deps, token, 'email_verify', async (tx, userId) => {
      await tx.db.update(users).set({ emailVerifiedAt: new Date() }).where(eq(users.id, userId));
    });
    if (!ok) throw badRequest('invalid_token', 'This link is invalid or has expired.');
    return reply.code(204).send();
  });

  app.post('/api/v1/auth/password/forgot', async (req, reply) => {
    const { email } = parse(ForgotPasswordRequest, req.body);
    await rateLimit(redis, `forgot:ip:${ipHash(config.sessionSecret, req.ip)}`, 20, 3600);
    await rateLimit(redis, `forgot:email:${hmac(config.sessionSecret, email)}`, 5, 3600);
    await withGlobal(pool, async (tx) => {
      const [user] = await tx.db
        .select({ id: users.id })
        .from(users)
        .where(and(eq(users.email, email), isNull(users.disabledAt)));
      if (user) await jobs.enqueue(tx, 'email.send', { type: 'password_reset', userId: user.id });
    });
    // Same answer whether or not the account exists.
    return reply.code(202).send({ status: 'sent_if_account_exists' });
  });

  app.post('/api/v1/auth/password/reset', async (req, reply) => {
    const { token, password } = parse(ResetPasswordRequest, req.body);
    const passwordHash = await hashPassword(password);
    const ok = await consumeToken(deps, token, 'password_reset', async (tx, userId) => {
      await tx.db.update(users).set({ passwordHash }).where(eq(users.id, userId));
      // Revoke every existing session: whoever had the old password is logged out.
      await tx.db.delete(sessions).where(eq(sessions.userId, userId));
    });
    if (!ok) throw badRequest('invalid_token', 'This link is invalid or has expired.');
    return reply.code(204).send();
  });
}

/** Single-use, expiring token: marks it used and runs `apply` in the same transaction. */
async function consumeToken(
  deps: Deps,
  token: string,
  purpose: 'email_verify' | 'password_reset',
  apply: (tx: Parameters<Parameters<typeof withGlobal>[1]>[0], userId: string) => Promise<void>,
): Promise<boolean> {
  return withGlobal(deps.pool, async (tx) => {
    const [row] = await tx.db
      .update(authTokens)
      .set({ usedAt: new Date() })
      .where(
        and(
          eq(authTokens.tokenHash, sha256(token)),
          eq(authTokens.purpose, purpose),
          isNull(authTokens.usedAt),
          gt(authTokens.expiresAt, new Date()),
        ),
      )
      .returning({ userId: authTokens.userId });
    if (!row) return false;
    await apply(tx, row.userId);
    return true;
  });
}
