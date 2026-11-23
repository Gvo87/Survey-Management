/**
 * Audit-log viewer (Phase 3A): org admins filter by actor, action, entity and date, and export CSV.
 * The app's database role can only read and insert audit rows (no UPDATE or DELETE grant).
 */
import type { FastifyInstance } from 'fastify';
import { AuditLogQuery, type AuditEntry, type PageResult } from '@survey/contracts';
import { withTenant, type Tx } from '@survey/db';
import type { Deps } from '../deps';
import { audit } from '../audit';
import { requireOrg } from '../auth/context';
import { csvRow, UTF8_BOM } from '../lib/csv';
import { decodeCursor, encodeCursor } from '../lib/misc';
import { parse } from '../lib/validate';
import type { z } from 'zod';

const EXPORT_LIMIT = 50_000;

interface Row {
  id: number;
  created_at: Date;
  action: string;
  actor_type: 'user' | 'api_key' | 'system';
  actor_id: string | null;
  actor_name: string | null;
  entity_type: string | null;
  entity_id: string | null;
  metadata: Record<string, unknown>;
}

async function query(
  tx: Tx,
  filters: z.infer<typeof AuditLogQuery>,
  limit: number,
  cursorId: number | null,
): Promise<Row[]> {
  const where: string[] = [];
  const values: unknown[] = [];
  const add = (clause: (n: string) => string, value: unknown) => {
    values.push(value);
    where.push(clause(`$${values.length}`));
  };
  if (filters.action) add((n) => `(a.action = ${n} or a.action like ${n} || '.%')`, filters.action);
  if (filters.actorId) add((n) => `a.actor_id = ${n}::uuid`, filters.actorId);
  if (filters.entityType) add((n) => `a.entity_type = ${n}`, filters.entityType);
  if (filters.entityId) add((n) => `a.entity_id = ${n}::uuid`, filters.entityId);
  if (filters.from) add((n) => `a.created_at >= ${n}::timestamptz`, filters.from);
  if (filters.to) add((n) => `a.created_at <= ${n}::timestamptz`, filters.to);
  if (cursorId !== null) add((n) => `a.id < ${n}`, cursorId);
  values.push(limit);
  const { rows } = await tx.client.query<Row>(
    `select a.id, a.created_at, a.action, a.actor_type, a.actor_id, a.entity_type, a.entity_id, a.metadata,
            coalesce(u.name, k.name) as actor_name
       from audit_logs a
       left join users u on a.actor_type = 'user' and u.id = a.actor_id
       left join api_keys k on a.actor_type = 'api_key' and k.id = a.actor_id
      ${where.length ? `where ${where.join(' and ')}` : ''}
      order by a.id desc
      limit $${values.length}`,
    values,
  );
  return rows;
}

const toEntry = (r: Row): AuditEntry => ({
  id: r.id,
  createdAt: r.created_at.toISOString(),
  action: r.action,
  actor: { type: r.actor_type, id: r.actor_id, name: r.actor_type === 'system' ? 'System' : r.actor_name },
  entityType: r.entity_type,
  entityId: r.entity_id,
  metadata: r.metadata,
});

export function registerAuditLogRoutes(app: FastifyInstance, deps: Deps): void {
  const { pool } = deps;

  app.get('/api/v1/audit-logs', async (req): Promise<PageResult<AuditEntry>> => {
    const auth = requireOrg(req, 'org.update');
    const filters = parse(AuditLogQuery, req.query);
    const cursor = decodeCursor(filters.cursor, 1);
    return withTenant(pool, auth.orgId, async (tx) => {
      const rows = await query(tx, filters, filters.limit + 1, cursor ? Number(cursor[0]) : null);
      const page = rows.slice(0, filters.limit);
      const last = page.at(-1);
      return {
        data: page.map(toEntry),
        nextCursor: rows.length > filters.limit && last ? encodeCursor([last.id]) : null,
      };
    });
  });

  app.get('/api/v1/audit-logs/export.csv', async (req, reply) => {
    const auth = requireOrg(req, 'org.update');
    const filters = parse(AuditLogQuery, req.query);
    const csv = await withTenant(pool, auth.orgId, async (tx) => {
      const rows = await query(tx, filters, EXPORT_LIMIT, null);
      await audit(tx, {
        orgId: auth.orgId,
        actorId: auth.userId,
        action: 'audit_logs.exported',
        metadata: { rows: rows.length, filters: { ...filters, cursor: undefined, limit: undefined } },
        ip: req.ip,
      });
      const lines = [
        csvRow([
          'id',
          'time',
          'action',
          'actor_type',
          'actor_id',
          'actor_name',
          'entity_type',
          'entity_id',
          'details',
        ]),
      ];
      for (const r of rows)
        lines.push(
          csvRow([
            String(r.id),
            r.created_at.toISOString(),
            r.action,
            r.actor_type,
            r.actor_id ?? '',
            r.actor_type === 'system' ? 'System' : (r.actor_name ?? ''),
            r.entity_type ?? '',
            r.entity_id ?? '',
            JSON.stringify(r.metadata),
          ]),
        );
      return lines.join('');
    });
    const day = new Date().toISOString().slice(0, 10);
    return reply
      .type('text/csv; charset=utf-8')
      .header('content-disposition', `attachment; filename="audit-log-${day}.csv"`)
      .send(UTF8_BOM + csv);
  });
}
