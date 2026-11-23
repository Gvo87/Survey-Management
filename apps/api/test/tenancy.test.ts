/**
 * Tenant isolation (docs/01-architecture.md §1.6): org A can never read, list or modify org B's
 * data through any endpoint, and the database itself enforces it (RLS fails closed).
 */
import { getTableConfig } from 'drizzle-orm/pg-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPool, requireEnv, tables, withTenant } from '@survey/db';
import {
  createTestContext,
  definitionWith,
  drainJobs,
  publishedSurvey,
  Respondent,
  signup,
  uniqueEmail,
  type Client,
  type TestContext,
} from './helpers';

let ctx: TestContext;
let adminA: Client;
let adminB: Client;
let b: { surveyId: string; responseId: string; distributionId: string; invitationId: string };

beforeAll(async () => {
  ctx = await createTestContext();
  adminA = await signup(ctx.app, { orgName: 'Org A' });
  adminB = await signup(ctx.app, { orgName: 'Org B' });
  await publishedSurvey(adminA, definitionWith(['short_text']), 'A survey');

  const def = definitionWith(['short_text']);
  const { survey } = await publishedSurvey(adminB, def, 'B survey');
  const key = (def.pages[0]!.elements[0] as { key: string }).key;
  await new Respondent(ctx.app, survey.publicId).complete({ [key]: 'secret from B' });
  await drainJobs(ctx);
  const responses = await adminB.get(`/api/v1/surveys/${survey.id}/responses`);
  const links = await adminB.get(`/api/v1/surveys/${survey.id}/distributions`);
  const invitation = await adminB.post('/api/v1/org/invitations', { email: uniqueEmail(), role: 'creator' });
  b = {
    surveyId: survey.id,
    responseId: responses.body.data[0].id,
    distributionId: links.body[0].id,
    invitationId: invitation.body.id,
  };
});
afterAll(async () => ctx.close());

describe("org A cannot reach org B's data through the API", () => {
  const attempts: [string, () => Promise<{ status: number }>][] = [
    ['GET survey', () => adminA.get(`/api/v1/surveys/${b.surveyId}`)],
    ['PATCH survey', () => adminA.patch(`/api/v1/surveys/${b.surveyId}`, { title: 'pwned' })],
    ['DELETE survey', () => adminA.delete(`/api/v1/surveys/${b.surveyId}`)],
    ['duplicate survey', () => adminA.post(`/api/v1/surveys/${b.surveyId}/duplicate`, {})],
    ['close survey', () => adminA.post(`/api/v1/surveys/${b.surveyId}/close`)],
    ['GET draft', () => adminA.get(`/api/v1/surveys/${b.surveyId}/draft`)],
    ['POST draft', () => adminA.post(`/api/v1/surveys/${b.surveyId}/draft`)],
    ['publish', () => adminA.post(`/api/v1/surveys/${b.surveyId}/publish`, { revision: 0 })],
    ['versions', () => adminA.get(`/api/v1/surveys/${b.surveyId}/versions`)],
    ['collaborators', () => adminA.get(`/api/v1/surveys/${b.surveyId}/collaborators`)],
    [
      'share',
      () => adminA.put(`/api/v1/surveys/${b.surveyId}/collaborators/${adminA.userId}`, { role: 'viewer' }),
    ],
    ['distributions', () => adminA.get(`/api/v1/surveys/${b.surveyId}/distributions`)],
    ['PATCH distribution', () => adminA.patch(`/api/v1/distributions/${b.distributionId}`, { name: 'x' })],
    ['DELETE distribution', () => adminA.delete(`/api/v1/distributions/${b.distributionId}`)],
    ['results', () => adminA.get(`/api/v1/surveys/${b.surveyId}/results/summary`)],
    ['responses', () => adminA.get(`/api/v1/surveys/${b.surveyId}/responses`)],
    ['response detail', () => adminA.get(`/api/v1/surveys/${b.surveyId}/responses/${b.responseId}`)],
    ['delete response', () => adminA.delete(`/api/v1/surveys/${b.surveyId}/responses/${b.responseId}`)],
    ['export', () => adminA.get(`/api/v1/surveys/${b.surveyId}/export.csv`)],
    ['revoke invitation', () => adminA.delete(`/api/v1/org/invitations/${b.invitationId}`)],
    ['change member role', () => adminA.patch(`/api/v1/org/members/${adminB.userId}`, { role: 'analyst' })],
    ['remove member', () => adminA.delete(`/api/v1/org/members/${adminB.userId}`)],
  ];

  it.each(attempts)('%s → 404', async (_name, attempt) => {
    expect((await attempt()).status).toBe(404);
  });

  it('lists never include the other org', async () => {
    const surveys = await adminA.get('/api/v1/surveys?limit=100');
    expect(surveys.body.data.map((s: { title: string }) => s.title)).toEqual(['A survey']);
    const members = await adminA.get('/api/v1/org/members');
    expect(members.body.data.map((m: { userId: string }) => m.userId)).toEqual([adminA.userId]);
    const invitations = await adminA.get('/api/v1/org/invitations');
    expect(invitations.body.data).toEqual([]);
  });

  it("left B's data untouched", async () => {
    const survey = await adminB.get(`/api/v1/surveys/${b.surveyId}`);
    expect(survey.body).toMatchObject({ title: 'B survey', status: 'live', responseCount: 1 });
  });

  it('a super admin without membership gets no access either', async () => {
    await ctx.owner.query('update users set is_super_admin = true where id = $1', [adminA.userId]);
    expect((await adminA.get(`/api/v1/surveys/${b.surveyId}`)).status).toBe(404);
    expect((await adminA.post('/api/v1/auth/switch-org', { orgId: adminB.orgId })).status).toBe(403);
  });
});

describe('row-level security in the database', () => {
  it('is enabled and forced on every table with an org_id column', async () => {
    const { rows } = await ctx.owner.query<{ table_name: string; rls: boolean; forced: boolean }>(`
      select c.table_name, cls.relrowsecurity as rls, cls.relforcerowsecurity as forced
        from information_schema.columns c
        join pg_class cls on cls.relname = c.table_name and cls.relnamespace = 'public'::regnamespace
       where c.table_schema = 'public' and c.column_name = 'org_id'`);
    expect(rows.length).toBeGreaterThanOrEqual(10);
    for (const row of rows)
      expect({ table: row.table_name, rls: row.rls, forced: row.forced }).toEqual({
        table: row.table_name,
        rls: true,
        forced: true,
      });
    const org = await ctx.owner.query(
      `select relrowsecurity, relforcerowsecurity from pg_class where relname = 'organizations'`,
    );
    expect(org.rows[0]).toEqual({ relrowsecurity: true, relforcerowsecurity: true });
  });

  it('the application role is not a superuser and cannot bypass RLS', async () => {
    const { rows } = await ctx.owner.query(
      `select rolsuper, rolbypassrls from pg_roles where rolname = 'survey_app'`,
    );
    expect(rows[0]).toEqual({ rolsuper: false, rolbypassrls: false });
  });

  it('fails closed: no tenant context means no rows', async () => {
    const app = createPool(requireEnv('TEST_DATABASE_URL'), 1);
    try {
      const all = await ctx.owner.query('select count(*)::int as n from surveys');
      expect(all.rows[0].n).toBeGreaterThan(0);
      const none = await app.query('select count(*)::int as n from surveys');
      expect(none.rows[0].n).toBe(0);
      const scoped = await withTenant(app, adminA.orgId, (tx) =>
        tx.client.query('select count(*)::int as n from surveys'),
      );
      expect(scoped.rows[0].n).toBe(1);
    } finally {
      await app.end();
    }
  });

  it("rejects writes that carry another tenant's org_id", async () => {
    const app = createPool(requireEnv('TEST_DATABASE_URL'), 1);
    try {
      await expect(
        withTenant(app, adminA.orgId, (tx) =>
          tx.client
            .query(`update surveys set title = 'x' where id = $1 returning id`, [b.surveyId])
            .then((r) => r.rowCount),
        ),
      ).resolves.toBe(0);
      await expect(
        withTenant(app, adminA.orgId, (tx) =>
          tx.client.query(`insert into audit_logs (org_id, actor_type, action) values ($1, 'system', 'x')`, [
            adminB.orgId,
          ]),
        ),
      ).rejects.toThrow(/row-level security/);
    } finally {
      await app.end();
    }
  });

  it('the audit log is append-only for the application role', async () => {
    const app = createPool(requireEnv('TEST_DATABASE_URL'), 1);
    try {
      await expect(
        withTenant(app, adminA.orgId, (tx) => tx.client.query('delete from audit_logs')),
      ).rejects.toThrow(/permission denied/);
    } finally {
      await app.end();
    }
  });

  it('Drizzle table definitions match the migrated columns', async () => {
    for (const table of Object.values(tables)) {
      const config = getTableConfig(table);
      const { rows } = await ctx.owner.query<{ column_name: string }>(
        `select column_name from information_schema.columns where table_schema = 'public' and table_name = $1`,
        [config.name],
      );
      expect(config.columns.map((c) => c.name).sort(), config.name).toEqual(
        rows.map((r) => r.column_name).sort(),
      );
    }
  });
});
