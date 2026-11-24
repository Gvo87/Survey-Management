/**
 * Usage metrics (Phase 3B): responses, published versions, campaign emails and AI tokens per month, plus
 * what an org holds now. Org admins see their own org; super admins see any org (modules/admin.ts).
 */
import type { FastifyInstance } from 'fastify';
import { UsageQuery, type UsageMonth, type UsageReport } from '@survey/contracts';
import { organizations, withTenant, type Tx } from '@survey/db';
import { eq } from 'drizzle-orm';
import type { Deps } from '../deps';
import { readAiSettings } from '../ai/status';
import { requireOrg } from '../auth/context';
import { parse } from '../lib/validate';

/** Usage of one org (run in its tenant context). Months with no activity are listed with zeros. */
export async function usageReport(deps: Deps, tx: Tx, orgId: string, months: number): Promise<UsageReport> {
  const { rows } = await tx.client.query<{ month: string; responses: number; surveys_published: number; emails_sent: number; ai_tokens: number }>(
    `select to_char(month, 'YYYY-MM') as month, responses, surveys_published, emails_sent, ai_tokens
       from org_usage_monthly where org_id = $1 and month >= (date_trunc('month', now() at time zone 'UTC') - make_interval(months => $2 - 1))::date`,
    [orgId, months],
  );
  const now = new Date();
  const list: UsageMonth[] = [];
  for (let i = months - 1; i >= 0; i--) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1));
    const key = d.toISOString().slice(0, 7);
    const row = rows.find((r) => r.month === key);
    list.push({
      month: key,
      responses: row?.responses ?? 0,
      surveysPublished: row?.surveys_published ?? 0,
      emailsSent: row?.emails_sent ?? 0,
      aiTokens: row?.ai_tokens ?? 0,
    });
  }
  const { rows: current } = await tx.client.query<{ members: number; surveys: number; responses: number; storage: number }>(
    `select (select count(*)::int from memberships where org_id = $1) as members,
            (select count(*)::int from surveys where org_id = $1 and deleted_at is null and not is_template) as surveys,
            (select count(*)::int from responses where org_id = $1 and not is_test) as responses,
            (select coalesce(sum(size), 0)::bigint from files where org_id = $1) as storage`,
    [orgId],
  );
  const [org] = await tx.db.select({ settings: organizations.settings }).from(organizations).where(eq(organizations.id, orgId));
  const sum = (field: keyof Omit<UsageMonth, 'month'>) => list.reduce((n, m) => n + m[field], 0);
  return {
    months: list,
    totals: { responses: sum('responses'), surveysPublished: sum('surveysPublished'), emailsSent: sum('emailsSent'), aiTokens: sum('aiTokens') },
    current: {
      members: current[0]!.members,
      surveys: current[0]!.surveys,
      responsesStored: current[0]!.responses,
      storageBytes: Number(current[0]!.storage),
    },
    limits: { aiMonthlyTokenCap: readAiSettings(org?.settings ?? {}).monthlyTokenCap ?? deps.config.ai.defaultMonthlyTokenCap },
  };
}

export function registerUsageRoutes(app: FastifyInstance, deps: Deps): void {
  app.get('/api/v1/org/usage', async (req) => {
    const auth = requireOrg(req, 'org.update');
    const { months } = parse(UsageQuery, req.query);
    return withTenant(deps.pool, auth.orgId, (tx) => usageReport(deps, tx, auth.orgId, months));
  });
}
