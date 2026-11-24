/**
 * Super-admin console (Phase 3B): every org with its size and this month's usage, suspension, plan and the
 * monthly AI token cap. Super admins still can't read survey content (architecture §1.5): the list comes
 * from one narrow SECURITY DEFINER function, and changes touch only the org row, inside that org's tenant
 * context, with an entry in the org's own audit log so its admins can see what was done.
 */
import { eq } from 'drizzle-orm';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { AdminOrgsQuery, UpdateAdminOrgRequest, UsageQuery, type AdminOrg, type AdminOverview } from '@survey/contracts';
import { organizations, withGlobal, withTenant } from '@survey/db';
import type { Deps } from '../deps';
import { audit } from '../audit';
import { requireSessionUser } from '../auth/context';
import { forbidden, notFound } from '../lib/errors';
import { usageMonth } from '../lib/usage';
import { parse } from '../lib/validate';
import { usageReport } from './usage';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function requireSuperAdmin(req: FastifyRequest) {
  const auth = requireSessionUser(req);
  if (!auth.isSuperAdmin) throw forbidden('Only platform administrators can do that.', 'super_admin_only');
  return auth;
}

interface OverviewRow {
  id: string;
  name: string;
  slug: string;
  plan: string;
  status: 'active' | 'suspended';
  created_at: Date;
  ai_enabled: boolean;
  ai_token_cap: number | null;
  members: number;
  surveys: number;
  responses: number;
  surveys_published: number;
  emails_sent: number;
  ai_tokens: number;
}

export function registerAdminRoutes(app: FastifyInstance, deps: Deps): void {
  const { pool } = deps;
  const toAdminOrg = (r: OverviewRow): AdminOrg => ({
    id: r.id,
    name: r.name,
    slug: r.slug,
    plan: r.plan,
    status: r.status,
    createdAt: r.created_at.toISOString(),
    members: r.members,
    surveys: r.surveys,
    aiEnabled: r.ai_enabled,
    aiMonthlyTokenCap: r.ai_token_cap ?? deps.config.ai.defaultMonthlyTokenCap,
    aiCapOverridden: r.ai_token_cap !== null,
    thisMonth: { responses: r.responses, surveysPublished: r.surveys_published, emailsSent: r.emails_sent, aiTokens: r.ai_tokens },
  });
  const overview = () => withGlobal(pool, (tx) => tx.client.query<OverviewRow>('select * from admin_org_overview($1)', [usageMonth()]));

  app.get('/api/v1/admin/overview', async (req): Promise<AdminOverview> => {
    requireSuperAdmin(req);
    const query = parse(AdminOrgsQuery, req.query);
    const { rows } = await overview();
    const all = rows.map(toAdminOrg);
    const q = query.q?.toLowerCase();
    const orgs = all.filter((o) => (!q || o.name.toLowerCase().includes(q) || o.slug.toLowerCase().includes(q)) && (!query.status || o.status === query.status));
    const sum = (f: keyof AdminOrg['thisMonth']) => all.reduce((n, o) => n + o.thisMonth[f], 0);
    return {
      orgs,
      totals: {
        orgs: all.length,
        activeOrgs: all.filter((o) => o.status === 'active').length,
        members: all.reduce((n, o) => n + o.members, 0),
        surveys: all.reduce((n, o) => n + o.surveys, 0),
        thisMonth: { responses: sum('responses'), surveysPublished: sum('surveysPublished'), emailsSent: sum('emailsSent'), aiTokens: sum('aiTokens') },
      },
    };
  });

  app.get<{ Params: { id: string } }>('/api/v1/admin/orgs/:id/usage', async (req) => {
    requireSuperAdmin(req);
    if (!UUID.test(req.params.id)) throw notFound('Organization');
    const { months } = parse(UsageQuery, req.query);
    return withTenant(pool, req.params.id, async (tx) => {
      const [org] = await tx.db.select({ id: organizations.id }).from(organizations).where(eq(organizations.id, req.params.id));
      if (!org) throw notFound('Organization');
      return usageReport(deps, tx, org.id, months);
    });
  });

  app.patch<{ Params: { id: string } }>('/api/v1/admin/orgs/:id', async (req): Promise<AdminOrg> => {
    const auth = requireSuperAdmin(req);
    const body = parse(UpdateAdminOrgRequest, req.body);
    if (!UUID.test(req.params.id)) throw notFound('Organization');
    await withTenant(pool, req.params.id, async (tx) => {
      const [org] = await tx.db.select().from(organizations).where(eq(organizations.id, req.params.id)).for('update');
      if (!org) throw notFound('Organization');
      const settings = { ...org.settings };
      if (body.aiMonthlyTokenCap !== undefined) {
        const { monthlyTokenCap: _old, ...ai } = (settings.ai ?? {}) as Record<string, unknown>;
        settings.ai = body.aiMonthlyTokenCap === null ? ai : { ...ai, monthlyTokenCap: body.aiMonthlyTokenCap };
      }
      await tx.db
        .update(organizations)
        .set({
          ...(body.status ? { status: body.status } : {}),
          ...(body.plan ? { plan: body.plan } : {}),
          settings,
          updatedAt: new Date(),
        })
        .where(eq(organizations.id, org.id));
      const changes = {
        ...(body.status && body.status !== org.status ? { status: { from: org.status, to: body.status } } : {}),
        ...(body.plan && body.plan !== org.plan ? { plan: { from: org.plan, to: body.plan } } : {}),
        ...(body.aiMonthlyTokenCap !== undefined ? { aiMonthlyTokenCap: body.aiMonthlyTokenCap } : {}),
      };
      await audit(tx, {
        orgId: org.id,
        actorId: auth.userId,
        action: body.status === 'suspended' && org.status !== 'suspended' ? 'org.suspended' : body.status === 'active' && org.status !== 'active' ? 'org.reactivated' : 'org.admin_updated',
        entityType: 'organization',
        entityId: org.id,
        metadata: { bySuperAdmin: true, ...changes, ...(body.reason ? { reason: body.reason } : {}) },
        ip: req.ip,
      });
    });
    const { rows } = await overview();
    return toAdminOrg(rows.find((r) => r.id === req.params.id)!);
  });
}
