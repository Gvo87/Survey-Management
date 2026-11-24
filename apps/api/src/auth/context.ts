import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Deps } from '../deps';
import { conflict, forbidden, unauthorized } from '../lib/errors';
import { requestContext } from '../lib/request-context';
import { safeEqual } from '../lib/security';
import { authenticateApiKey, checkApiKeyRoute, rateLimitApiKey, registerIdempotency } from './api-keys';
import { orgCan, type OrgCapability } from './permissions';
import { loadSession, sessionCookieName, type AuthContext, type OrgAuth } from './session';

declare module 'fastify' {
  interface FastifyRequest {
    auth: AuthContext | null;
  }
}

const UNSAFE = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/**
 * Loads the session for /api/v1 requests and enforces:
 * - CSRF: cookie-authenticated unsafe requests must carry X-CSRF-Token (bound to the session).
 * - Org mismatch: if the client says which org it thinks is active (X-Org-Id) and that's no
 *   longer true (switched in another tab), reject with 409 instead of acting on the wrong org.
 *
 * Phase 3A: `Authorization: Bearer sk_live_…` authenticates with an API key instead (no cookie, no
 * CSRF). The key's routes, scopes and rate limit are checked here too.
 */
export function registerAuth(app: FastifyInstance, deps: Deps): void {
  app.decorateRequest('auth', null);

  app.addHook('onRequest', async (req, reply) => {
    if (!req.url.startsWith('/api/')) return;
    // Phase 3B: the SAML response is a cross-site form POST from the identity provider. It never acts on an
    // existing session (it starts a new one), so it skips session loading and the CSRF check.
    if (req.method === 'POST' && req.url.split('?')[0] === '/api/v1/auth/sso/saml/acs') return;
    const authorization = req.headers.authorization;
    if (authorization?.startsWith('Bearer ')) {
      req.auth = await authenticateApiKey(deps, authorization.slice('Bearer '.length).trim());
      checkApiKeyRoute(req);
      await rateLimitApiKey(deps, req, reply);
      return;
    }
    const token = req.cookies[sessionCookieName(deps.config)];
    if (!token) return;
    req.auth = await loadSession(deps.pool, deps.config, token);
    if (!req.auth) return;

    if (UNSAFE.has(req.method)) {
      const header = req.headers['x-csrf-token'];
      if (typeof header !== 'string' || !safeEqual(header, req.auth.csrfToken)) {
        throw forbidden('Missing or invalid CSRF token. Reload the page and try again.', 'csrf_failed');
      }
    }
    const expectedOrg = req.headers['x-org-id'];
    if (typeof expectedOrg === 'string' && expectedOrg && expectedOrg !== req.auth.orgId) {
      throw conflict('org_mismatch', 'You switched organization in another tab. Reload to continue.', {
        activeOrgId: req.auth.orgId,
      });
    }
  });

  // Audit entries written during an API-key request record the key as the actor.
  app.addHook('onRequest', (req, _reply, done) => {
    const apiKeyId = req.auth?.apiKey?.id;
    if (apiKeyId) requestContext.run({ apiKeyId }, done);
    else done();
  });

  registerIdempotency(app, deps);
}

export function requireUser(req: FastifyRequest): AuthContext {
  if (!req.auth) throw unauthorized();
  return req.auth;
}

/** Session-only routes (the account itself, switching org): an API key can't use them. */
export function requireSessionUser(req: FastifyRequest): AuthContext {
  const auth = requireUser(req);
  if (auth.apiKey) throw forbidden("This endpoint isn't part of the public API.", 'not_available_with_api_key');
  return auth;
}

export function requireOrg(req: FastifyRequest, capability?: OrgCapability): OrgAuth {
  const auth = requireUser(req);
  if (!auth.orgId || !auth.orgRole) throw forbidden('Choose an organization first.', 'no_active_org');
  if (capability && !orgCan(auth.orgRole, capability)) throw forbidden();
  return auth as OrgAuth;
}
