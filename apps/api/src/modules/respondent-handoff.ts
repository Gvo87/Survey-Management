/**
 * Login-required surveys (Phase 3B), admin side: a signed-in member asks for a one-time link that takes
 * them back to the respondent app signed in. See lib/respondent-tokens.ts for the whole design.
 *
 * Any org the user belongs to works, not only the active one, so someone in two orgs needn't switch.
 */
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { RespondentHandoffRequest, type RespondentHandoffResult } from '@survey/contracts';
import { organizations, readAccess, surveys, withGlobal, withTenant } from '@survey/db';
import type { Deps } from '../deps';
import { requireSessionUser } from '../auth/context';
import { rateLimit } from '../infra/rate-limit';
import { forbidden, notFound } from '../lib/errors';
import { signHandoff } from '../lib/respondent-tokens';
import { parse } from '../lib/validate';

export function registerRespondentHandoffRoutes(app: FastifyInstance, deps: Deps): void {
  const { pool, config } = deps;

  app.post('/api/v1/respondent-handoff', async (req): Promise<RespondentHandoffResult> => {
    const auth = requireSessionUser(req);
    const { publicId, lang } = parse(RespondentHandoffRequest, req.body);
    await rateLimit(deps.redis, `handoff:${auth.userId}`, 30, 300);
    const { rows } = await withGlobal(pool, (tx) =>
      tx.client.query<{ org_id: string; survey_id: string }>('select * from resolve_public_survey($1)', [publicId]),
    );
    const target = rows[0];
    if (!target) throw notFound('Survey');
    const membership = auth.memberships.find((m) => m.orgId === target.org_id);
    return withTenant(pool, target.org_id, async (tx) => {
      const [survey] = await tx.db.select().from(surveys).where(eq(surveys.id, target.survey_id));
      if (!survey || !readAccess(survey.access).requireLogin) throw notFound('Survey');
      const [org] = await tx.db.select({ name: organizations.name }).from(organizations).where(eq(organizations.id, target.org_id));
      // The survey exists and needs a login, so saying whose members may answer reveals nothing new.
      if (!membership)
        throw forbidden(`Only members of ${org?.name ?? 'this organization'} can answer this survey. You're signed in as ${auth.email}.`, 'not_a_member');
      const token = signHandoff(config.sessionSecret, survey.id, auth.userId);
      const query = lang && /^[A-Za-z-]{2,20}$/.test(lang) ? `?lang=${encodeURIComponent(lang)}` : '';
      return {
        url: `${config.respondentUrl}/s/${survey.publicId}${query}#rt=${token}`,
        survey: { title: survey.title, orgName: org?.name ?? '' },
      };
    });
  });
}
