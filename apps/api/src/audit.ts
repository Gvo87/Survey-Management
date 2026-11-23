import { auditLogs, type Tx } from '@survey/db';

export interface AuditEntry {
  orgId: string;
  actorId: string | null;
  actorType?: 'user' | 'api_key' | 'system';
  action: string;
  entityType?: string;
  entityId?: string;
  /** Small, non-sensitive context. Never answer values. */
  metadata?: Record<string, unknown>;
  ip?: string | null;
}

/** Append an audit event in the caller's transaction (same commit as the change it records). */
export async function audit(tx: Tx, entry: AuditEntry): Promise<void> {
  await tx.db.insert(auditLogs).values({
    orgId: entry.orgId,
    actorType: entry.actorType ?? (entry.actorId ? 'user' : 'system'),
    actorId: entry.actorId,
    action: entry.action,
    entityType: entry.entityType ?? null,
    entityId: entry.entityId ?? null,
    metadata: entry.metadata ?? {},
    ip: entry.ip ?? null,
  });
}
