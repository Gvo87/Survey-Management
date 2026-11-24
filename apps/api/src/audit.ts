import { auditLogs, type Tx } from '@survey/db';
import { requestContext } from './lib/request-context';

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

/**
 * Append an audit event in the caller's transaction (same commit as the change it records). During an
 * API-key request the actor is the key (Phase 3A), and the admin who created it is kept in the metadata.
 */
export async function audit(tx: Tx, entry: AuditEntry): Promise<void> {
  const apiKeyId = entry.actorType === undefined && entry.actorId ? requestContext.getStore()?.apiKeyId : undefined;
  await tx.db.insert(auditLogs).values({
    orgId: entry.orgId,
    actorType: apiKeyId ? 'api_key' : (entry.actorType ?? (entry.actorId ? 'user' : 'system')),
    actorId: apiKeyId ?? entry.actorId,
    action: entry.action,
    entityType: entry.entityType ?? null,
    entityId: entry.entityId ?? null,
    metadata: apiKeyId ? { ...entry.metadata, keyCreatedBy: entry.actorId } : (entry.metadata ?? {}),
    ip: entry.ip ?? null,
  });
}
