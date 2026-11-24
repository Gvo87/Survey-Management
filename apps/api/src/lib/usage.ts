/**
 * Usage metrics (Phase 3B): monthly counters per org, incremented in the transaction of the event they
 * count, so purges and erasure never rewrite usage history.
 */
import type { Tx } from '@survey/db';

export type UsageField = 'responses' | 'surveys_published' | 'emails_sent' | 'ai_tokens';

/** The first day of the month (UTC) as YYYY-MM-DD. */
export const usageMonth = (at = new Date()) => `${at.toISOString().slice(0, 7)}-01`;

export async function recordUsage(tx: Tx, orgId: string, field: UsageField, amount = 1, at = new Date()): Promise<void> {
  if (amount <= 0) return;
  // `field` is one of four fixed column names, never user input.
  await tx.client.query(
    `insert into org_usage_monthly (org_id, month, ${field}) values ($1, $2, $3)
     on conflict (org_id, month) do update set ${field} = org_usage_monthly.${field} + excluded.${field}`,
    [orgId, usageMonth(at), amount],
  );
}

/** Tokens the org has used this calendar month. */
export async function aiTokensThisMonth(tx: Tx, orgId: string): Promise<number> {
  const { rows } = await tx.client.query<{ ai_tokens: number }>(
    'select ai_tokens from org_usage_monthly where org_id = $1 and month = $2',
    [orgId, usageMonth()],
  );
  return rows[0]?.ai_tokens ?? 0;
}
