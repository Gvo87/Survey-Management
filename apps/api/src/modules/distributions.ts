import { and, asc, eq, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { CreateDistributionRequest, UpdateDistributionRequest, type Distribution } from '@survey/contracts';
import { distributions, newId, newToken, responses, withTenant, type Tx } from '@survey/db';
import type { Deps } from '../deps';
import { audit } from '../audit';
import { requireOrg } from '../auth/context';
import type { OrgAuth } from '../auth/session';
import { notFound } from '../lib/errors';
import { iso } from '../lib/misc';
import { parse } from '../lib/validate';
import { loadSurvey } from './surveys';

type DistributionRow = typeof distributions.$inferSelect;

export function distributionUrl(
  deps: Deps,
  publicId: string,
  d: Pick<DistributionRow, 'isDefault' | 'token'>,
): string {
  const base = `${deps.config.respondentUrl}/s/${publicId}`;
  return d.isDefault ? base : `${base}?d=${d.token}`;
}

export function registerDistributionRoutes(app: FastifyInstance, deps: Deps): void {
  const { pool } = deps;

  async function list(tx: Tx, surveyId: string, publicId: string): Promise<Distribution[]> {
    const rows = await tx.db
      .select()
      .from(distributions)
      .where(eq(distributions.surveyId, surveyId))
      .orderBy(asc(distributions.createdAt));
    const counts = await tx.db
      .select({ id: responses.distributionId, n: sql<number>`count(*)::int` })
      .from(responses)
      .where(and(eq(responses.surveyId, surveyId), eq(responses.isTest, false)))
      .groupBy(responses.distributionId);
    return rows.map((d) => ({
      id: d.id,
      channel: d.channel,
      name: d.name,
      isDefault: d.isDefault,
      url: distributionUrl(deps, publicId, d),
      presetHiddenFields: d.presetHiddenFields,
      responseCount: counts.find((c) => c.id === d.id)?.n ?? 0,
      disabledAt: iso(d.disabledAt),
      createdAt: d.createdAt.toISOString(),
    }));
  }

  async function loadDistribution(tx: Tx, auth: OrgAuth, id: string) {
    if (!/^[0-9a-f-]{36}$/i.test(id)) throw notFound('Link');
    const [d] = await tx.db.select().from(distributions).where(eq(distributions.id, id));
    if (!d) throw notFound('Link');
    const { survey } = await loadSurvey(tx, auth, d.surveyId, 'survey.distribute');
    return { d, survey };
  }

  app.get<{ Params: { id: string } }>('/api/v1/surveys/:id/distributions', async (req) => {
    const auth = requireOrg(req);
    return withTenant(pool, auth.orgId, async (tx) => {
      const { survey } = await loadSurvey(tx, auth, req.params.id, 'survey.view');
      return list(tx, survey.id, survey.publicId);
    });
  });

  app.post<{ Params: { id: string } }>('/api/v1/surveys/:id/distributions', async (req, reply) => {
    const auth = requireOrg(req);
    const body = parse(CreateDistributionRequest, req.body);
    const result = await withTenant(pool, auth.orgId, async (tx) => {
      const { survey } = await loadSurvey(tx, auth, req.params.id, 'survey.distribute');
      const id = newId();
      await tx.db.insert(distributions).values({
        id,
        orgId: auth.orgId,
        surveyId: survey.id,
        channel: body.channel,
        name: body.name,
        token: newToken(9),
        presetHiddenFields: body.presetHiddenFields ?? {},
        createdBy: auth.userId,
      });
      await audit(tx, {
        orgId: auth.orgId,
        actorId: auth.userId,
        action: 'distribution.created',
        entityType: 'distribution',
        entityId: id,
        ip: req.ip,
      });
      return (await list(tx, survey.id, survey.publicId)).find((d) => d.id === id)!;
    });
    reply.code(201);
    return result;
  });

  app.patch<{ Params: { id: string } }>('/api/v1/distributions/:id', async (req) => {
    const auth = requireOrg(req);
    const body = parse(UpdateDistributionRequest, req.body);
    return withTenant(pool, auth.orgId, async (tx) => {
      const { d, survey } = await loadDistribution(tx, auth, req.params.id);
      await tx.db
        .update(distributions)
        .set({
          ...(body.name !== undefined ? { name: body.name } : {}),
          ...(body.presetHiddenFields !== undefined ? { presetHiddenFields: body.presetHiddenFields } : {}),
          ...(body.disabled !== undefined ? { disabledAt: body.disabled ? new Date() : null } : {}),
        })
        .where(eq(distributions.id, d.id));
      await audit(tx, {
        orgId: auth.orgId,
        actorId: auth.userId,
        action: 'distribution.updated',
        entityType: 'distribution',
        entityId: d.id,
        metadata: { fields: Object.keys(body) },
        ip: req.ip,
      });
      return (await list(tx, survey.id, survey.publicId)).find((x) => x.id === d.id)!;
    });
  });

  // Links are disabled rather than deleted, so response attribution keeps working.
  app.delete<{ Params: { id: string } }>('/api/v1/distributions/:id', async (req, reply) => {
    const auth = requireOrg(req);
    await withTenant(pool, auth.orgId, async (tx) => {
      const { d } = await loadDistribution(tx, auth, req.params.id);
      await tx.db.update(distributions).set({ disabledAt: new Date() }).where(eq(distributions.id, d.id));
      await audit(tx, {
        orgId: auth.orgId,
        actorId: auth.userId,
        action: 'distribution.disabled',
        entityType: 'distribution',
        entityId: d.id,
        ip: req.ip,
      });
    });
    return reply.code(204).send();
  });
}
