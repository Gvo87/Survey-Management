/**
 * Single sign-on (Phase 3B): SAML and OIDC connections per org, just-in-time provisioning and optional
 * enforcement.
 *
 * Trust rules:
 * - An org claims email domains and proves ownership with a DNS TXT record. Only verified domains count.
 * - An SSO login is accepted only for an email in a verified domain of the connection's org. Otherwise an
 *   org admin could point a connection at their own identity provider and sign in as anyone.
 * - The first login of someone new creates their account (no password) and makes them a member with the
 *   connection's default role (creator or analyst, never admin). Existing accounts are linked by email.
 * - Enforcement turns password sign-in (and sign-up, resets and new-password invitations) off for verified
 *   domains. It can only be switched on after an SSO login worked, so a broken setup can't lock people out.
 * - The login state (PKCE verifier, nonce, SAML request) is single-use in Redis and bound to the browser
 *   that started it by a short-lived cookie, so a login can't be completed in someone else's browser.
 */
import { randomBytes } from 'node:crypto';
import { and, asc, eq, isNotNull } from 'drizzle-orm';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import {
  AddSsoDomainRequest,
  SaveSsoConnectionRequest,
  SsoDiscoverRequest,
  type SsoConnection,
  type SsoDiscoverResult,
  type SsoDomain,
  type SsoSettings,
} from '@survey/contracts';
import {
  memberships,
  newId,
  organizations,
  ssoConnections,
  ssoDomains,
  ssoIdentities,
  users,
  withGlobal,
  withTenant,
  type Tx,
} from '@survey/db';
import type { Deps } from '../deps';
import { audit } from '../audit';
import { requireOrg } from '../auth/context';
import { createSession, sessionCookieName, sessionCookieOptions } from '../auth/session';
import {
  checkOidcIssuer,
  normalizeCertificate,
  oidcAuthorizationUrl,
  oidcIdentity,
  samlAuthorizationUrl,
  samlIdentity,
  samlMetadata,
  SsoError,
  ssoUrls,
  type OidcConfig,
  type SamlConfigStored,
  type SsoIdentity,
} from '../auth/sso-protocols';
import { rateLimit } from '../infra/rate-limit';
import { decryptSecret, encryptSecret } from '../lib/crypto';
import { AppError, conflict, notFound, unprocessable } from '../lib/errors';
import { ipHash } from '../lib/security';
import { parse } from '../lib/validate';
import { isUniqueViolation } from './auth';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const STATE_TTL_S = 600;
const BIND_COOKIE = 'sso_bind';
type ConnectionRow = typeof ssoConnections.$inferSelect;

interface LoginState {
  connectionId: string;
  orgId: string;
  protocol: 'oidc' | 'saml';
  returnTo: string;
  codeVerifier?: string;
  nonce?: string;
}

export const emailDomain = (email: string) => email.split('@')[1]?.toLowerCase() ?? '';
const txtName = (domain: string) => `_survey-verification.${domain}`;
const txtValue = (token: string) => `survey-verification=${token}`;

/** Enforcement needs a verified domain and an enabled connection someone has signed in with. */
export async function canEnforceSso(tx: Tx, orgId: string): Promise<boolean> {
  const [domain] = await tx.db
    .select({ d: ssoDomains.domain })
    .from(ssoDomains)
    .where(and(eq(ssoDomains.orgId, orgId), isNotNull(ssoDomains.verifiedAt)))
    .limit(1);
  const [connection] = await tx.db
    .select({ id: ssoConnections.id })
    .from(ssoConnections)
    .where(and(eq(ssoConnections.orgId, orgId), eq(ssoConnections.enabled, true), isNotNull(ssoConnections.lastLoginAt)))
    .limit(1);
  return Boolean(domain && connection);
}

/** The SSO set-up of the org that verified this email's domain (login page, enforcement checks). */
export async function ssoForEmail(deps: Deps, email: string): Promise<SsoDiscoverResult> {
  const domain = emailDomain(email);
  if (!domain) return { connections: [], enforced: false };
  const { rows } = await withGlobal(deps.pool, (tx) =>
    tx.client.query<{ enforced: boolean; connection_id: string | null; connection_name: string | null; protocol: 'oidc' | 'saml' | null }>(
      'select * from sso_for_domain($1)',
      [domain],
    ),
  );
  return {
    enforced: rows.some((r) => r.enforced) && rows.some((r) => r.connection_id),
    connections: rows
      .filter((r) => r.connection_id)
      .map((r) => ({ id: r.connection_id!, name: r.connection_name!, protocol: r.protocol!, loginUrl: ssoUrls(deps.config.appUrl, r.connection_id!).loginUrl })),
  };
}

/** Problem for password-based flows when the email's domain enforces SSO. */
export async function assertPasswordAllowed(deps: Deps, email: string): Promise<void> {
  const sso = await ssoForEmail(deps, email);
  if (sso.enforced)
    throw new AppError(403, 'sso_required', 'Your organization signs you in with single sign-on. Use “Sign in with SSO”.', undefined, {
      connections: sso.connections,
    });
}

function toConnection(deps: Deps, c: ConnectionRow): SsoConnection {
  const urls = ssoUrls(deps.config.appUrl, c.id);
  return {
    id: c.id,
    protocol: c.protocol,
    name: c.name,
    defaultRole: c.defaultRole,
    enabled: c.enabled,
    summary: c.summary,
    lastLoginAt: c.lastLoginAt?.toISOString() ?? null,
    createdAt: c.createdAt.toISOString(),
    serviceProvider:
      c.protocol === 'oidc'
        ? { redirectUri: urls.oidcRedirectUri }
        : { entityId: urls.samlEntityId, acsUrl: urls.samlAcsUrl, metadataUrl: urls.samlEntityId },
    loginUrl: urls.loginUrl,
  };
}

const toDomain = (d: typeof ssoDomains.$inferSelect): SsoDomain => ({
  domain: d.domain,
  verified: d.verifiedAt !== null,
  verifiedAt: d.verifiedAt?.toISOString() ?? null,
  txtRecord: { name: txtName(d.domain), value: txtValue(d.verificationToken) },
});

/** Only relative paths inside the admin app (no open redirects). */
function safeReturnTo(raw: unknown): string {
  return typeof raw === 'string' && /^\/(?![/\\])[\x21-\x7e]{0,500}$/.test(raw) ? raw : '/surveys';
}

export function registerSsoRoutes(app: FastifyInstance, deps: Deps): void {
  const { pool, redis, config } = deps;
  const readConfig = <T>(c: ConnectionRow) => JSON.parse(decryptSecret(config.encryptionKey, c.configEnc)) as T;

  async function settings(tx: Tx, orgId: string): Promise<SsoSettings> {
    const [org] = await tx.db.select({ settings: organizations.settings }).from(organizations).where(eq(organizations.id, orgId));
    const connections = await tx.db.select().from(ssoConnections).where(eq(ssoConnections.orgId, orgId)).orderBy(asc(ssoConnections.createdAt));
    const domains = await tx.db.select().from(ssoDomains).where(eq(ssoDomains.orgId, orgId)).orderBy(asc(ssoDomains.domain));
    return {
      enforced: (org?.settings.sso as { enforced?: boolean } | undefined)?.enforced === true,
      canEnforce: await canEnforceSso(tx, orgId),
      connections: connections.map((c) => toConnection(deps, c)),
      domains: domains.map(toDomain),
    };
  }

  /** Switching enforcement off when the org would be left with no working way in. */
  async function relaxEnforcementIfStranded(tx: Tx, orgId: string, actorId: string, ip: string) {
    if (await canEnforceSso(tx, orgId)) return;
    const [org] = await tx.db.select().from(organizations).where(eq(organizations.id, orgId));
    if ((org?.settings.sso as { enforced?: boolean } | undefined)?.enforced !== true) return;
    await tx.db
      .update(organizations)
      .set({ settings: { ...org!.settings, sso: { enforced: false } }, updatedAt: new Date() })
      .where(eq(organizations.id, orgId));
    await audit(tx, { orgId, actorId, action: 'sso.enforcement_relaxed', metadata: { reason: 'no_working_connection_or_domain' }, ip });
  }

  // ── Admin: settings, connections, domains ────────────────────────────────
  app.get('/api/v1/org/sso', async (req) => {
    const auth = requireOrg(req, 'org.update');
    return withTenant(pool, auth.orgId, (tx) => settings(tx, auth.orgId));
  });

  async function prepareConfig(body: SaveSsoConnectionRequest, existing: ConnectionRow | null): Promise<{ stored: OidcConfig | SamlConfigStored; summary: Record<string, string> }> {
    if (body.protocol === 'oidc') {
      const previous = existing?.protocol === 'oidc' ? readConfig<OidcConfig>(existing) : null;
      const secret = body.clientSecret ?? previous?.clientSecret;
      if (!secret) throw unprocessable('validation_failed', 'Enter the client secret.', [{ path: 'clientSecret', code: 'required', message: 'Enter the client secret.' }]);
      const stored: OidcConfig = { issuer: body.issuer.replace(/\/$/, ''), clientId: body.clientId, clientSecret: secret };
      try {
        await checkOidcIssuer(deps, stored);
      } catch (error) {
        throw unprocessable('invalid_issuer', (error as Error).message);
      }
      return { stored, summary: { issuer: stored.issuer, clientId: stored.clientId } };
    }
    const previous = existing?.protocol === 'saml' ? readConfig<SamlConfigStored>(existing) : null;
    if (!body.idpCert && !previous) throw unprocessable('validation_failed', "Paste the identity provider's signing certificate.", [{ path: 'idpCert', code: 'required', message: 'Paste the certificate.' }]);
    let cert = previous?.idpCert ?? '';
    if (body.idpCert) {
      try {
        cert = normalizeCertificate(body.idpCert);
      } catch (error) {
        throw unprocessable('invalid_certificate', (error as Error).message);
      }
    }
    const stored: SamlConfigStored = { entryPoint: body.entryPoint, idpIssuer: body.idpIssuer, idpCert: cert };
    return { stored, summary: { entryPoint: stored.entryPoint, idpIssuer: stored.idpIssuer } };
  }

  app.post('/api/v1/org/sso/connections', async (req, reply) => {
    const auth = requireOrg(req, 'org.update');
    const body = parse(SaveSsoConnectionRequest, req.body);
    const { stored, summary } = await prepareConfig(body, null);
    const created = await withTenant(pool, auth.orgId, async (tx) => {
      const [row] = await tx.db
        .insert(ssoConnections)
        .values({
          id: newId(),
          orgId: auth.orgId,
          protocol: body.protocol,
          name: body.name,
          configEnc: encryptSecret(config.encryptionKey, JSON.stringify(stored)),
          summary,
          defaultRole: body.defaultRole,
          enabled: body.enabled,
          createdBy: auth.userId,
        })
        .returning();
      await audit(tx, { orgId: auth.orgId, actorId: auth.userId, action: 'sso.connection_created', entityType: 'sso_connection', entityId: row!.id, metadata: { protocol: body.protocol, ...summary }, ip: req.ip });
      return toConnection(deps, row!);
    });
    reply.code(201);
    return created;
  });

  app.patch<{ Params: { id: string } }>('/api/v1/org/sso/connections/:id', async (req) => {
    const auth = requireOrg(req, 'org.update');
    const body = parse(SaveSsoConnectionRequest, req.body);
    if (!UUID.test(req.params.id)) throw notFound('Connection');
    const existing = await withTenant(pool, auth.orgId, async (tx) => (await tx.db.select().from(ssoConnections).where(eq(ssoConnections.id, req.params.id)))[0]);
    if (!existing) throw notFound('Connection');
    if (existing.protocol !== body.protocol) throw unprocessable('protocol_change', "A connection's protocol can't change. Add a new connection instead.");
    const { stored, summary } = await prepareConfig(body, existing);
    return withTenant(pool, auth.orgId, async (tx) => {
      const [row] = await tx.db
        .update(ssoConnections)
        .set({
          name: body.name,
          configEnc: encryptSecret(config.encryptionKey, JSON.stringify(stored)),
          summary,
          defaultRole: body.defaultRole,
          enabled: body.enabled,
          // A changed identity provider has to prove itself again before enforcement relies on it.
          ...(JSON.stringify(summary) !== JSON.stringify(existing.summary) ? { lastLoginAt: null } : {}),
          updatedAt: new Date(),
        })
        .where(eq(ssoConnections.id, existing.id))
        .returning();
      await relaxEnforcementIfStranded(tx, auth.orgId, auth.userId, req.ip);
      await audit(tx, { orgId: auth.orgId, actorId: auth.userId, action: 'sso.connection_updated', entityType: 'sso_connection', entityId: existing.id, metadata: { enabled: body.enabled, ...summary }, ip: req.ip });
      return toConnection(deps, row!);
    });
  });

  app.delete<{ Params: { id: string } }>('/api/v1/org/sso/connections/:id', async (req, reply) => {
    const auth = requireOrg(req, 'org.update');
    if (!UUID.test(req.params.id)) throw notFound('Connection');
    await withTenant(pool, auth.orgId, async (tx) => {
      const [row] = await tx.db.delete(ssoConnections).where(eq(ssoConnections.id, req.params.id)).returning();
      if (!row) throw notFound('Connection');
      await relaxEnforcementIfStranded(tx, auth.orgId, auth.userId, req.ip);
      await audit(tx, { orgId: auth.orgId, actorId: auth.userId, action: 'sso.connection_deleted', entityType: 'sso_connection', entityId: row.id, metadata: { name: row.name }, ip: req.ip });
    });
    return reply.code(204).send();
  });

  app.post('/api/v1/org/sso/domains', async (req, reply) => {
    const auth = requireOrg(req, 'org.update');
    const { domain } = parse(AddSsoDomainRequest, req.body);
    const result = await withTenant(pool, auth.orgId, async (tx) => {
      const [existing] = await tx.db.select().from(ssoDomains).where(eq(ssoDomains.domain, domain));
      if (existing) throw conflict('domain_exists', 'This domain is already listed.');
      const auto = config.ssoDomainVerification === 'auto';
      try {
        const [row] = await tx.db
          .insert(ssoDomains)
          .values({ orgId: auth.orgId, domain, verificationToken: randomBytes(16).toString('hex'), verifiedAt: auto ? new Date() : null })
          .returning();
        await audit(tx, { orgId: auth.orgId, actorId: auth.userId, action: 'sso.domain_added', metadata: { domain, verified: auto }, ip: req.ip });
        return toDomain(row!);
      } catch (error) {
        if (isUniqueViolation(error)) throw conflict('domain_taken', 'Another organization has already verified this domain.');
        throw error;
      }
    });
    reply.code(201);
    return result;
  });

  app.post<{ Params: { domain: string } }>('/api/v1/org/sso/domains/:domain/verify', async (req) => {
    const auth = requireOrg(req, 'org.update');
    await rateLimit(redis, `sso:verify:${auth.orgId}`, 30, 3600);
    const domain = req.params.domain.toLowerCase();
    const [row] = await withTenant(pool, auth.orgId, (tx) => tx.db.select().from(ssoDomains).where(eq(ssoDomains.domain, domain)));
    if (!row) throw notFound('Domain');
    if (row.verifiedAt) return toDomain(row);
    let records: string[][] = [];
    try {
      records = await deps.dns.resolveTxt(txtName(domain));
    } catch {
      records = [];
    }
    if (!records.some((parts) => parts.join('') === txtValue(row.verificationToken)))
      throw unprocessable('not_verified', `We couldn't find the TXT record. Add ${txtName(domain)} with the value shown, wait for DNS to update, and try again.`);
    return withTenant(pool, auth.orgId, async (tx) => {
      try {
        const [updated] = await tx.db
          .update(ssoDomains)
          .set({ verifiedAt: new Date() })
          .where(and(eq(ssoDomains.orgId, auth.orgId), eq(ssoDomains.domain, domain)))
          .returning();
        await audit(tx, { orgId: auth.orgId, actorId: auth.userId, action: 'sso.domain_verified', metadata: { domain }, ip: req.ip });
        return toDomain(updated!);
      } catch (error) {
        if (isUniqueViolation(error)) throw conflict('domain_taken', 'Another organization has already verified this domain.');
        throw error;
      }
    });
  });

  app.delete<{ Params: { domain: string } }>('/api/v1/org/sso/domains/:domain', async (req, reply) => {
    const auth = requireOrg(req, 'org.update');
    await withTenant(pool, auth.orgId, async (tx) => {
      const [row] = await tx.db.delete(ssoDomains).where(eq(ssoDomains.domain, req.params.domain.toLowerCase())).returning();
      if (!row) throw notFound('Domain');
      await relaxEnforcementIfStranded(tx, auth.orgId, auth.userId, req.ip);
      await audit(tx, { orgId: auth.orgId, actorId: auth.userId, action: 'sso.domain_removed', metadata: { domain: row.domain }, ip: req.ip });
    });
    return reply.code(204).send();
  });

  // ── Login ────────────────────────────────────────────────────────────────
  app.post('/api/v1/auth/sso/discover', async (req): Promise<SsoDiscoverResult> => {
    const { email } = parse(SsoDiscoverRequest, req.body);
    await rateLimit(redis, `sso:discover:${ipHash(config.sessionSecret, req.ip)}`, 60, 300);
    return ssoForEmail(deps, email);
  });

  const failLogin = (reply: FastifyReply, code: string) => reply.redirect(`${config.appUrl}/login?sso_error=${encodeURIComponent(code)}`, 302);

  app.get<{ Params: { id: string }; Querystring: { returnTo?: string } }>('/api/v1/auth/sso/:id/start', async (req, reply) => {
    await rateLimit(redis, `sso:start:${ipHash(config.sessionSecret, req.ip)}`, 60, 300);
    if (!UUID.test(req.params.id)) return failLogin(reply, 'unknown_connection');
    const { rows } = await withGlobal(pool, (tx) => tx.client.query<{ org_id: string }>('select * from sso_connection_org($1)', [req.params.id]));
    const orgId = rows[0]?.org_id;
    if (!orgId) return failLogin(reply, 'unknown_connection');
    const [connection] = await withTenant(pool, orgId, (tx) => tx.db.select().from(ssoConnections).where(eq(ssoConnections.id, req.params.id)));
    if (!connection?.enabled) return failLogin(reply, 'unknown_connection');
    const state = randomBytes(24).toString('base64url');
    const urls = ssoUrls(config.appUrl, connection.id);
    const saved: LoginState = { connectionId: connection.id, orgId, protocol: connection.protocol, returnTo: safeReturnTo(req.query.returnTo) };
    let target: string;
    try {
      if (connection.protocol === 'oidc') {
        const auth = await oidcAuthorizationUrl(deps, `${connection.id}:${connection.updatedAt.getTime()}`, readConfig<OidcConfig>(connection), urls.oidcRedirectUri, state);
        Object.assign(saved, { codeVerifier: auth.codeVerifier, nonce: auth.nonce });
        target = auth.url;
      } else {
        target = await samlAuthorizationUrl(deps, connection.id, readConfig<SamlConfigStored>(connection), state);
      }
    } catch (error) {
      req.log.warn({ err: error, connectionId: connection.id }, 'sso start failed');
      return failLogin(reply, error instanceof SsoError ? error.code : 'idp_unreachable');
    }
    await redis.set(`sso:state:${state}`, JSON.stringify(saved), 'EX', STATE_TTL_S);
    // Bind the login to this browser. SameSite=None so the SAML response (a cross-site POST) carries it.
    reply.setCookie(BIND_COOKIE, state, { httpOnly: true, secure: true, sameSite: 'none', path: '/api/v1/auth/sso', maxAge: STATE_TTL_S });
    return reply.redirect(target, 302);
  });

  /** Single use: the state is deleted as it's read, and must match this browser's cookie. */
  async function takeState(req: FastifyRequest, state: unknown): Promise<LoginState | null> {
    if (typeof state !== 'string' || state.length > 100) return null;
    const raw = await redis.getdel(`sso:state:${state}`);
    if (!raw || req.cookies[BIND_COOKIE] !== state) return null;
    return JSON.parse(raw) as LoginState;
  }

  async function finish(req: FastifyRequest, reply: FastifyReply, state: LoginState, identity: SsoIdentity) {
    reply.clearCookie(BIND_COOKIE, { path: '/api/v1/auth/sso', secure: true, sameSite: 'none' });
    try {
      const token = await signInWithSso(deps, state, identity, req);
      reply.setCookie(sessionCookieName(config), token, sessionCookieOptions(config));
      return reply.redirect(`${config.appUrl}${state.returnTo}`, 302);
    } catch (error) {
      if (error instanceof SsoError) {
        req.log.warn({ code: error.code, connectionId: state.connectionId }, 'sso login refused');
        return failLogin(reply, error.code);
      }
      throw error;
    }
  }

  app.get<{ Querystring: Record<string, string> }>('/api/v1/auth/sso/oidc/callback', async (req, reply) => {
    const state = await takeState(req, req.query.state);
    if (!state || state.protocol !== 'oidc') return failLogin(reply, 'expired');
    if (req.query.error) return failLogin(reply, 'idp_denied');
    const [connection] = await withTenant(pool, state.orgId, (tx) => tx.db.select().from(ssoConnections).where(eq(ssoConnections.id, state.connectionId)));
    if (!connection?.enabled) return failLogin(reply, 'unknown_connection');
    const redirectUri = ssoUrls(config.appUrl, connection.id).oidcRedirectUri;
    const callbackUrl = new URL(redirectUri);
    for (const [k, v] of Object.entries(req.query)) if (typeof v === 'string') callbackUrl.searchParams.set(k, v);
    let identity: SsoIdentity;
    try {
      identity = await oidcIdentity(deps, `${connection.id}:${connection.updatedAt.getTime()}`, readConfig<OidcConfig>(connection), callbackUrl, {
        state: req.query.state!,
        nonce: state.nonce!,
        codeVerifier: state.codeVerifier!,
        redirectUri,
      });
    } catch (error) {
      req.log.warn({ err: error, connectionId: connection.id }, 'oidc callback failed');
      return failLogin(reply, error instanceof SsoError ? error.code : 'oidc_failed');
    }
    return finish(req, reply, state, identity);
  });

  // The SAML response arrives as a form POST from the identity provider (no session, no CSRF token: the
  // signed assertion, InResponseTo and the browser binding authenticate it).
  void app.register(async (scope) => {
    scope.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'string', bodyLimit: 512 * 1024 }, (_req, body, done) =>
      done(null, Object.fromEntries(new URLSearchParams(body as string))),
    );
    scope.post<{ Body: Record<string, string> }>('/api/v1/auth/sso/saml/acs', async (req, reply) => {
      const body = req.body ?? {};
      const state = await takeState(req, body.RelayState);
      if (!state || state.protocol !== 'saml' || typeof body.SAMLResponse !== 'string') return failLogin(reply, 'expired');
      const [connection] = await withTenant(pool, state.orgId, (tx) => tx.db.select().from(ssoConnections).where(eq(ssoConnections.id, state.connectionId)));
      if (!connection?.enabled) return failLogin(reply, 'unknown_connection');
      let identity: SsoIdentity;
      try {
        identity = await samlIdentity(deps, connection.id, readConfig<SamlConfigStored>(connection), { SAMLResponse: body.SAMLResponse, RelayState: body.RelayState ?? '' });
      } catch (error) {
        req.log.warn({ err: error, connectionId: connection.id }, 'saml response refused');
        return failLogin(reply, error instanceof SsoError ? error.code : 'saml_failed');
      }
      return finish(req, reply, state, identity);
    });
  });

  app.get<{ Params: { id: string } }>('/api/v1/auth/sso/saml/:id/metadata', async (req, reply) => {
    if (!UUID.test(req.params.id)) throw notFound('Connection');
    const { rows } = await withGlobal(pool, (tx) => tx.client.query<{ org_id: string }>('select * from sso_connection_org($1)', [req.params.id]));
    if (!rows[0]) throw notFound('Connection');
    return reply.type('application/samlmetadata+xml').header('cache-control', 'public, max-age=300').send(samlMetadata(deps, req.params.id));
  });
}

/**
 * The identity provider vouched for `identity`: find or create the user, link the identity, make them a
 * member (just-in-time) and start a session in the connection's org. Returns the session token.
 */
export async function signInWithSso(deps: Deps, state: LoginState, identity: SsoIdentity, req: FastifyRequest): Promise<string> {
  const email = identity.email.trim().toLowerCase();
  if (!identity.emailVerified) throw new SsoError('email_not_verified', 'Your identity provider says your email address isn’t verified.');
  const attempt = () =>
    withTenant(deps.pool, state.orgId, async (tx) => {
      const [connection] = await tx.db.select().from(ssoConnections).where(eq(ssoConnections.id, state.connectionId));
      if (!connection?.enabled) throw new SsoError('unknown_connection', 'This sign-in method was switched off.');
      const [domain] = await tx.db
        .select({ d: ssoDomains.domain })
        .from(ssoDomains)
        .where(and(eq(ssoDomains.orgId, state.orgId), eq(ssoDomains.domain, emailDomain(email)), isNotNull(ssoDomains.verifiedAt)));
      if (!domain) throw new SsoError('domain_not_verified', `${emailDomain(email)} isn't a verified domain of this organization.`);

      const [linked] = await tx.db
        .select({ userId: ssoIdentities.userId })
        .from(ssoIdentities)
        .where(and(eq(ssoIdentities.connectionId, connection.id), eq(ssoIdentities.subject, identity.subject)));
      let [user] = linked
        ? await tx.db.select().from(users).where(eq(users.id, linked.userId))
        : await tx.db.select().from(users).where(eq(users.email, email));
      let created = false;
      if (!user) {
        [user] = await tx.db
          .insert(users)
          .values({ id: newId(), email, name: (identity.name ?? email.split('@')[0]!).slice(0, 200), passwordHash: null, emailVerifiedAt: new Date() })
          .returning();
        created = true;
      }
      if (user!.disabledAt) throw new SsoError('account_disabled', 'This account is disabled.');
      const userId = user!.id;
      if (!linked)
        await tx.db
          .insert(ssoIdentities)
          .values({ orgId: state.orgId, connectionId: connection.id, subject: identity.subject, userId, email })
          .onConflictDoNothing();
      else await tx.db.update(ssoIdentities).set({ lastLoginAt: new Date(), email }).where(and(eq(ssoIdentities.connectionId, connection.id), eq(ssoIdentities.subject, identity.subject)));

      const [membership] = await tx.db
        .select({ role: memberships.role })
        .from(memberships)
        .where(and(eq(memberships.orgId, state.orgId), eq(memberships.userId, userId)));
      if (!membership) {
        await tx.db.insert(memberships).values({ orgId: state.orgId, userId, role: connection.defaultRole });
        await audit(tx, {
          orgId: state.orgId,
          actorId: null,
          action: 'member.jit_provisioned',
          entityType: 'user',
          entityId: userId,
          metadata: { connectionId: connection.id, role: connection.defaultRole, newAccount: created },
        });
      }
      await tx.db.update(ssoConnections).set({ lastLoginAt: new Date() }).where(eq(ssoConnections.id, connection.id));
      await tx.db.update(users).set({ lastLoginAt: new Date(), ...(user!.emailVerifiedAt ? {} : { emailVerifiedAt: new Date() }) }).where(eq(users.id, userId));
      await audit(tx, { orgId: state.orgId, actorId: userId, action: 'auth.sso_login', metadata: { connectionId: connection.id, protocol: connection.protocol }, ip: req.ip });
      return createSession(tx, { userId, orgId: state.orgId, ip: req.ip, userAgent: req.headers['user-agent'] });
    });
  try {
    return await attempt();
  } catch (error) {
    // Two first logins at once: the second finds the user the first created.
    if (isUniqueViolation(error)) return attempt();
    throw error;
  }
}
