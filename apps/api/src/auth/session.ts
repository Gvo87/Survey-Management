import { and, eq, gt, isNull } from 'drizzle-orm';
import { newToken, sessions, sha256, users, withGlobal, type Pool, type Tx } from '@survey/db';
import type { ApiScope, OrgRole } from '@survey/contracts';
import type { Config } from '../config';
import { csrfTokenFor } from '../lib/security';

const SLIDING_TTL_MS = 14 * 24 * 3600 * 1000;
const ABSOLUTE_TTL_MS = 30 * 24 * 3600 * 1000;
const TOUCH_INTERVAL_MS = 5 * 60 * 1000;

export interface Membership {
  orgId: string;
  orgName: string;
  orgSlug: string;
  role: OrgRole;
}

export interface AuthContext {
  userId: string;
  email: string;
  name: string;
  isSuperAdmin: boolean;
  emailVerified: boolean;
  sessionHash: Buffer;
  csrfToken: string;
  orgId: string | null;
  orgRole: OrgRole | null;
  memberships: Membership[];
  /** Phase 3A: set when the request authenticated with an API key instead of a session. */
  apiKey?: { id: string; name: string; scopes: ApiScope[] } | null;
}

export interface OrgAuth extends AuthContext {
  orgId: string;
  orgRole: OrgRole;
}

export const sessionCookieName = (config: Config) => (config.cookieSecure ? '__Host-sid' : 'sid');

export function sessionCookieOptions(config: Config) {
  return {
    httpOnly: true,
    secure: config.cookieSecure,
    sameSite: 'lax' as const,
    path: '/',
    maxAge: ABSOLUTE_TTL_MS / 1000,
  };
}

export async function createSession(
  tx: Tx,
  input: { userId: string; orgId: string | null; ip?: string; userAgent?: string },
): Promise<string> {
  const token = newToken();
  await tx.db.insert(sessions).values({
    idHash: sha256(token),
    userId: input.userId,
    activeOrgId: input.orgId,
    ip: input.ip ?? null,
    userAgent: input.userAgent?.slice(0, 300) ?? null,
    expiresAt: new Date(Date.now() + SLIDING_TTL_MS),
  });
  return token;
}

export async function userMemberships(tx: Tx, userId: string): Promise<Membership[]> {
  const { rows } = await tx.client.query<{
    org_id: string;
    org_name: string;
    org_slug: string;
    role: OrgRole;
  }>('select * from user_memberships($1)', [userId]);
  return rows.map((r) => ({ orgId: r.org_id, orgName: r.org_name, orgSlug: r.org_slug, role: r.role }));
}

/** Resolve a session cookie to an auth context (or null if invalid/expired). */
export async function loadSession(pool: Pool, config: Config, token: string): Promise<AuthContext | null> {
  if (token.length < 20 || token.length > 100) return null;
  const hash = sha256(token);
  return withGlobal(pool, async (tx) => {
    const [row] = await tx.db
      .select({ session: sessions, user: users })
      .from(sessions)
      .innerJoin(users, eq(users.id, sessions.userId))
      .where(and(eq(sessions.idHash, hash), gt(sessions.expiresAt, new Date()), isNull(users.disabledAt)))
      .limit(1);
    if (!row) return null;

    const now = Date.now();
    if (now - row.session.lastSeenAt.getTime() > TOUCH_INTERVAL_MS) {
      const absoluteEnd = row.session.createdAt.getTime() + ABSOLUTE_TTL_MS;
      await tx.db
        .update(sessions)
        .set({ lastSeenAt: new Date(now), expiresAt: new Date(Math.min(now + SLIDING_TTL_MS, absoluteEnd)) })
        .where(eq(sessions.idHash, hash));
    }

    const memberships = await userMemberships(tx, row.user.id);
    const active = memberships.find((m) => m.orgId === row.session.activeOrgId) ?? null;
    return {
      userId: row.user.id,
      email: row.user.email,
      name: row.user.name,
      isSuperAdmin: row.user.isSuperAdmin,
      emailVerified: row.user.emailVerifiedAt !== null,
      sessionHash: hash,
      csrfToken: csrfTokenFor(config.sessionSecret, token),
      orgId: active?.orgId ?? null,
      orgRole: active?.role ?? null,
      memberships,
    };
  });
}
