import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Deps } from '../deps';
import { conflict, forbidden, unauthorized } from '../lib/errors';
import { safeEqual } from '../lib/security';
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
 */
export function registerAuth(app: FastifyInstance, deps: Deps): void {
  app.decorateRequest('auth', null);

  app.addHook('onRequest', async (req) => {
    if (!req.url.startsWith('/api/')) return;
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
}

export function requireUser(req: FastifyRequest): AuthContext {
  if (!req.auth) throw unauthorized();
  return req.auth;
}

export function requireOrg(req: FastifyRequest, capability?: OrgCapability): OrgAuth {
  const auth = requireUser(req);
  if (!auth.orgId || !auth.orgRole) throw forbidden('Choose an organization first.', 'no_active_org');
  if (capability && !orgCan(auth.orgRole, capability)) throw forbidden();
  return auth as OrgAuth;
}
