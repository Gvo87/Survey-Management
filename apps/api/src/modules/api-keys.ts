/** API keys (Phase 3A): org admins create (shown once), list and revoke them. Keys can't manage keys. */
import { desc, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { CreateApiKeyRequest, type ApiKey, type ApiScope, type CreatedApiKey } from '@survey/contracts';
import { apiKeys, newId, users, withTenant } from '@survey/db';
import type { Deps } from '../deps';
import { audit } from '../audit';
import { generateApiKey } from '../auth/api-keys';
import { requireOrg } from '../auth/context';
import { conflict, notFound, unprocessable } from '../lib/errors';
import { parse } from '../lib/validate';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function toApiKey(row: typeof apiKeys.$inferSelect, creator: string | null): ApiKey {
  return {
    id: row.id,
    name: row.name,
    prefix: row.prefix,
    scopes: row.scopes as ApiScope[],
    createdBy: creator ? { id: row.createdBy, name: creator } : null,
    createdAt: row.createdAt.toISOString(),
    lastUsedAt: row.lastUsedAt?.toISOString() ?? null,
    expiresAt: row.expiresAt?.toISOString() ?? null,
    revokedAt: row.revokedAt?.toISOString() ?? null,
  };
}

export function registerApiKeyRoutes(app: FastifyInstance, deps: Deps): void {
  const { pool } = deps;

  app.get('/api/v1/api-keys', async (req) => {
    const auth = requireOrg(req, 'org.update');
    return withTenant(pool, auth.orgId, async (tx) => {
      const rows = await tx.db
        .select({ k: apiKeys, creator: users.name })
        .from(apiKeys)
        .leftJoin(users, eq(users.id, apiKeys.createdBy))
        .orderBy(desc(apiKeys.createdAt));
      return rows.map((r) => toApiKey(r.k, r.creator));
    });
  });

  app.post('/api/v1/api-keys', async (req, reply): Promise<CreatedApiKey> => {
    const auth = requireOrg(req, 'org.update');
    const body = parse(CreateApiKeyRequest, req.body);
    if (body.expiresAt && new Date(body.expiresAt).getTime() <= Date.now())
      throw unprocessable('invalid_expiry', 'Choose an expiry date in the future.');
    const { key, prefix, hash } = generateApiKey();
    const created = await withTenant(pool, auth.orgId, async (tx) => {
      const [row] = await tx.db
        .insert(apiKeys)
        .values({
          id: newId(),
          orgId: auth.orgId,
          name: body.name,
          prefix,
          keyHash: hash,
          scopes: [...new Set(body.scopes)],
          createdBy: auth.userId,
          expiresAt: body.expiresAt ? new Date(body.expiresAt) : null,
        })
        .returning();
      await audit(tx, {
        orgId: auth.orgId,
        actorId: auth.userId,
        action: 'api_key.created',
        entityType: 'api_key',
        entityId: row!.id,
        metadata: { name: body.name, scopes: row!.scopes },
        ip: req.ip,
      });
      return row!;
    });
    reply.code(201);
    return { ...toApiKey(created, auth.name), key };
  });

  app.delete<{ Params: { id: string } }>('/api/v1/api-keys/:id', async (req, reply) => {
    const auth = requireOrg(req, 'org.update');
    if (!UUID.test(req.params.id)) throw notFound('API key');
    await withTenant(pool, auth.orgId, async (tx) => {
      const [row] = await tx.db.select().from(apiKeys).where(eq(apiKeys.id, req.params.id));
      if (!row) throw notFound('API key');
      if (row.revokedAt) throw conflict('already_revoked', 'This key is already revoked.');
      await tx.db.update(apiKeys).set({ revokedAt: new Date() }).where(eq(apiKeys.id, row.id));
      await audit(tx, {
        orgId: auth.orgId,
        actorId: auth.userId,
        action: 'api_key.revoked',
        entityType: 'api_key',
        entityId: row.id,
        metadata: { name: row.name },
        ip: req.ip,
      });
    });
    return reply.code(204).send();
  });
}
