/**
 * Public API (Phase 3A): `Authorization: Bearer sk_live_…` keys, their scopes, a per-key rate limit and
 * `Idempotency-Key` replays. Keys act as an org admin limited to their scopes, and only on the routes
 * listed in PUBLIC_ROUTES; everything else answers 403.
 */
import { createHash, randomBytes } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { ApiScope } from '@survey/contracts';
import { apiKeys, idempotencyKeys, sha256, withGlobal, withTenant } from '@survey/db';
import type { Deps } from '../deps';
import {
  AppError,
  badRequest,
  conflict,
  forbidden,
  tooManyRequests,
  unauthorized,
  unprocessable,
} from '../lib/errors';
import type { AuthContext } from './session';

/** `METHOD /route` → the scope it needs. The curated OpenAPI document is built from the same list. */
export const PUBLIC_ROUTES: Record<string, ApiScope> = {
  'GET /api/v1/surveys': 'surveys:read',
  'POST /api/v1/surveys': 'surveys:write',
  'GET /api/v1/surveys/:id': 'surveys:read',
  'GET /api/v1/surveys/:id/draft': 'surveys:read',
  'POST /api/v1/surveys/:id/draft': 'surveys:write',
  'PUT /api/v1/surveys/:id/draft': 'surveys:write',
  'POST /api/v1/surveys/:id/publish': 'surveys:write',
  'POST /api/v1/surveys/:id/close': 'surveys:write',
  'POST /api/v1/surveys/:id/reopen': 'surveys:write',
  'POST /api/v1/surveys/:id/archive': 'surveys:write',
  'GET /api/v1/surveys/:id/versions': 'surveys:read',
  'GET /api/v1/surveys/:id/versions/:versionId': 'surveys:read',
  'GET /api/v1/surveys/:id/results/summary': 'responses:read',
  'GET /api/v1/surveys/:id/responses': 'responses:read',
  'GET /api/v1/surveys/:id/responses/:responseId': 'responses:read',
  'DELETE /api/v1/surveys/:id/responses/:responseId': 'responses:delete',
  'GET /api/v1/surveys/:id/export.csv': 'responses:read',
  'GET /api/v1/contacts': 'contacts:read',
  'POST /api/v1/contacts': 'contacts:write',
  'PATCH /api/v1/contacts/:id': 'contacts:write',
  'DELETE /api/v1/contacts/:id': 'contacts:write',
  'GET /api/v1/contact-lists': 'contacts:read',
  'POST /api/v1/contact-lists': 'contacts:write',
  'PATCH /api/v1/contact-lists/:id': 'contacts:write',
  'DELETE /api/v1/contact-lists/:id': 'contacts:write',
  'POST /api/v1/contact-lists/:id/members': 'contacts:write',
  'POST /api/v1/contact-lists/:id/members/remove': 'contacts:write',
  'GET /api/v1/contacts/imports/:id': 'contacts:read',
  'GET /api/v1/webhooks': 'webhooks:manage',
  'POST /api/v1/webhooks': 'webhooks:manage',
  'GET /api/v1/webhooks/:id': 'webhooks:manage',
  'PATCH /api/v1/webhooks/:id': 'webhooks:manage',
  'DELETE /api/v1/webhooks/:id': 'webhooks:manage',
  'POST /api/v1/webhooks/:id/rotate-secret': 'webhooks:manage',
  'POST /api/v1/webhooks/:id/test': 'webhooks:manage',
  'GET /api/v1/webhooks/:id/deliveries': 'webhooks:manage',
  'GET /api/v1/webhooks/:id/deliveries/:deliveryId': 'webhooks:manage',
  'POST /api/v1/webhooks/:id/deliveries/:deliveryId/redeliver': 'webhooks:manage',
};

export const KEY_PREFIX = 'sk_live_';

/** A new key: shown once, only its SHA-256 is stored. */
export function generateApiKey(): { key: string; prefix: string; hash: Buffer } {
  const key = `${KEY_PREFIX}${randomBytes(24).toString('base64url')}`;
  return { key, prefix: key.slice(0, KEY_PREFIX.length + 4), hash: sha256(key) };
}

/** Resolve a bearer token to an auth context. Throws 401 for any key that can't be used. */
export async function authenticateApiKey(deps: Deps, token: string): Promise<AuthContext> {
  if (!token.startsWith(KEY_PREFIX) || token.length > 100) throw unauthorized('The API key is invalid.');
  const row = await withGlobal(deps.pool, async (tx) => {
    const { rows } = await tx.client.query<{
      id: string;
      org_id: string;
      name: string;
      scopes: ApiScope[];
      created_by: string;
      expires_at: Date | null;
      revoked_at: Date | null;
      last_used_at: Date | null;
      creator_is_admin: boolean;
    }>('select * from api_key_by_hash($1)', [sha256(token)]);
    return rows[0];
  });
  if (!row || row.revoked_at) throw unauthorized('The API key is invalid or has been revoked.');
  if (row.expires_at && row.expires_at.getTime() <= Date.now())
    throw unauthorized('The API key has expired.');
  if (!row.creator_is_admin)
    throw unauthorized('The API key stopped working because the admin who created it no longer is one.');
  if (!row.last_used_at || Date.now() - row.last_used_at.getTime() > 60_000) {
    await withTenant(deps.pool, row.org_id, (tx) =>
      tx.db.update(apiKeys).set({ lastUsedAt: new Date() }).where(eq(apiKeys.id, row.id)),
    );
  }
  return {
    userId: row.created_by,
    email: '',
    name: `API key "${row.name}"`,
    isSuperAdmin: false,
    emailVerified: true,
    sessionHash: Buffer.alloc(0),
    csrfToken: '',
    orgId: row.org_id,
    orgRole: 'org_admin',
    memberships: [],
    apiKey: { id: row.id, name: row.name, scopes: row.scopes },
  };
}

/** Only the listed routes, and only with the right scope. */
export function checkApiKeyRoute(req: FastifyRequest): void {
  const scopes = req.auth?.apiKey?.scopes;
  if (!scopes || !req.routeOptions.url) return;
  // The API description itself is public.
  if (req.routeOptions.url === '/api/v1/openapi.json') return;
  const needed = PUBLIC_ROUTES[`${req.method} ${req.routeOptions.url}`];
  if (!needed) throw forbidden("This endpoint isn't part of the public API.", 'not_available_with_api_key');
  if (!scopes.includes(needed))
    throw new AppError(403, 'insufficient_scope', `This API key needs the ${needed} scope.`, undefined, {
      requiredScope: needed,
    });
}

/** Fixed one-minute window per key, with the IETF RateLimit headers. */
export async function rateLimitApiKey(deps: Deps, req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const key = req.auth?.apiKey;
  if (!key) return;
  const limit = deps.config.apiKeyRequestsPerMinute;
  const redisKey = `rl:apikey:${key.id}`;
  const result = await deps.redis.multi().incr(redisKey).expire(redisKey, 60, 'NX').ttl(redisKey).exec();
  const count = Number(result?.[0]?.[1] ?? 0);
  const ttl = Math.max(1, Number(result?.[2]?.[1] ?? 60));
  reply.header('ratelimit-limit', String(limit));
  reply.header('ratelimit-remaining', String(Math.max(0, limit - count)));
  reply.header('ratelimit-reset', String(ttl));
  if (count > limit) throw tooManyRequests(ttl);
}

declare module 'fastify' {
  interface FastifyRequest {
    idempotency: { orgId: string; key: string } | null;
  }
}

const IDEMPOTENCY_KEY = /^[\x21-\x7e]{1,255}$/;
/** A request still "processing" after this long was abandoned (crash, timeout) and may be retried. */
const ABANDONED_MS = 60_000;

/**
 * `Idempotency-Key` on an authenticated POST: the first request runs, and later requests with the same
 * key and body get the first response (`Idempotent-Replayed: true`) instead of running again. A
 * different body with the same key is refused. Server errors aren't stored, so they can be retried.
 */
export function registerIdempotency(app: FastifyInstance, deps: Deps): void {
  app.decorateRequest('idempotency', null);

  app.addHook('preHandler', async (req, reply) => {
    const header = req.headers['idempotency-key'];
    if (req.method !== 'POST' || header === undefined || !req.auth?.orgId) return;
    if (typeof header !== 'string' || !IDEMPOTENCY_KEY.test(header))
      throw badRequest(
        'invalid_idempotency_key',
        'Idempotency-Key must be 1 to 255 printable ASCII characters.',
      );
    const orgId = req.auth.orgId;
    const key = `${req.auth.apiKey?.id ?? req.auth.userId}:${header}`;
    const requestHash = createHash('sha256')
      .update(`${req.method} ${req.url}\n${JSON.stringify(req.body ?? null)}`)
      .digest();

    const existing = await withTenant(deps.pool, orgId, async (tx) => {
      const inserted = await tx.db
        .insert(idempotencyKeys)
        .values({ orgId, key, requestHash })
        .onConflictDoNothing()
        .returning({ key: idempotencyKeys.key });
      if (inserted.length) return null;
      const [row] = await tx.db
        .select()
        .from(idempotencyKeys)
        .where(and(eq(idempotencyKeys.orgId, orgId), eq(idempotencyKeys.key, key)))
        .for('update');
      if (row && row.status === 'processing' && Date.now() - row.createdAt.getTime() > ABANDONED_MS) {
        await tx.db
          .update(idempotencyKeys)
          .set({ requestHash, createdAt: new Date() })
          .where(and(eq(idempotencyKeys.orgId, orgId), eq(idempotencyKeys.key, key)));
        return null;
      }
      return row ?? null;
    });

    if (!existing) {
      req.idempotency = { orgId, key };
      return;
    }
    if (!existing.requestHash.equals(requestHash))
      throw unprocessable(
        'idempotency_key_reused',
        'This Idempotency-Key was already used for a different request.',
      );
    if (existing.status === 'processing')
      throw conflict(
        'idempotency_in_progress',
        'A request with this Idempotency-Key is still being processed.',
      );
    reply.header('idempotent-replayed', 'true');
    reply.code(existing.statusCode ?? 200);
    if (existing.contentType) reply.type(existing.contentType);
    reply.send(existing.response ?? undefined);
    return reply;
  });

  app.addHook('onSend', async (req, reply, payload) => {
    const pending = req.idempotency;
    if (!pending) return payload;
    req.idempotency = null;
    const where = and(eq(idempotencyKeys.orgId, pending.orgId), eq(idempotencyKeys.key, pending.key));
    await withTenant(deps.pool, pending.orgId, async (tx) => {
      if (
        reply.statusCode >= 500 ||
        (payload !== null && payload !== undefined && typeof payload !== 'string')
      ) {
        await tx.db.delete(idempotencyKeys).where(where);
        return;
      }
      await tx.db
        .update(idempotencyKeys)
        .set({
          status: 'done',
          statusCode: reply.statusCode,
          contentType: String(reply.getHeader('content-type') ?? '') || null,
          response: (payload as string | null | undefined) ?? null,
        })
        .where(where);
    }).catch((error: Error) => req.log.error({ err: error }, 'could not store idempotent response'));
    return payload;
  });
}
