/**
 * Teams (Phase 3A): named groups of members that surveys can be shared with. A team share gives each
 * member the team's role, still capped by their org role (analysts stay viewers).
 */
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import {
  SaveTeamRequest,
  SetTeamMembersRequest,
  SetTeamShareRequest,
  type Team,
  type TeamShare,
} from '@survey/contracts';
import {
  memberships,
  newId,
  surveyTeamCollaborators,
  teamMembers,
  teams,
  users,
  withTenant,
  type Tx,
} from '@survey/db';
import type { Deps } from '../deps';
import { audit } from '../audit';
import { requireOrg } from '../auth/context';
import { conflict, notFound, unprocessable } from '../lib/errors';
import { parse } from '../lib/validate';
import { isUniqueViolation } from './auth';
import { loadSurvey } from './surveys';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function listTeams(tx: Tx, teamId?: string): Promise<Team[]> {
  const rows = await tx.db
    .select()
    .from(teams)
    .where(teamId ? eq(teams.id, teamId) : undefined)
    .orderBy(asc(teams.name));
  if (rows.length === 0) return [];
  const members = await tx.db
    .select({
      teamId: teamMembers.teamId,
      id: users.id,
      name: users.name,
      email: users.email,
      role: memberships.role,
    })
    .from(teamMembers)
    .innerJoin(users, eq(users.id, teamMembers.userId))
    .innerJoin(
      memberships,
      and(eq(memberships.userId, teamMembers.userId), eq(memberships.orgId, teamMembers.orgId)),
    )
    .where(
      inArray(
        teamMembers.teamId,
        rows.map((t) => t.id),
      ),
    )
    .orderBy(asc(users.name));
  return rows.map((t) => ({
    id: t.id,
    name: t.name,
    createdAt: t.createdAt.toISOString(),
    members: members.filter((m) => m.teamId === t.id).map(({ teamId: _, ...m }) => m),
  }));
}

async function loadTeam(tx: Tx, id: string) {
  if (!UUID.test(id)) throw notFound('Team');
  const [team] = await tx.db.select().from(teams).where(eq(teams.id, id));
  if (!team) throw notFound('Team');
  return team;
}

async function listShares(tx: Tx, surveyId: string): Promise<TeamShare[]> {
  const rows = await tx.db
    .select({
      id: teams.id,
      name: teams.name,
      role: surveyTeamCollaborators.role,
      memberCount: sql<number>`(select count(*)::int from team_members tm where tm.team_id = ${teams.id})`,
    })
    .from(surveyTeamCollaborators)
    .innerJoin(teams, eq(teams.id, surveyTeamCollaborators.teamId))
    .where(eq(surveyTeamCollaborators.surveyId, surveyId))
    .orderBy(asc(teams.name));
  return rows.map((r) => ({ team: { id: r.id, name: r.name, memberCount: r.memberCount }, role: r.role }));
}

export function registerTeamRoutes(app: FastifyInstance, deps: Deps): void {
  const { pool } = deps;
  type IdParams = { Params: { id: string } };

  // Any member can list teams (to share surveys with them); only admins manage them.
  app.get('/api/v1/org/teams', async (req) => {
    const auth = requireOrg(req);
    return withTenant(pool, auth.orgId, (tx) => listTeams(tx));
  });

  app.post('/api/v1/org/teams', async (req, reply) => {
    const auth = requireOrg(req, 'org.members.manage');
    const { name } = parse(SaveTeamRequest, req.body);
    const team = await withTenant(pool, auth.orgId, async (tx) => {
      const id = newId();
      try {
        await tx.db.insert(teams).values({ id, orgId: auth.orgId, name });
      } catch (error) {
        if (isUniqueViolation(error)) throw conflict('team_exists', 'A team with that name already exists.');
        throw error;
      }
      await audit(tx, {
        orgId: auth.orgId,
        actorId: auth.userId,
        action: 'team.created',
        entityType: 'team',
        entityId: id,
        metadata: { name },
        ip: req.ip,
      });
      return (await listTeams(tx, id))[0]!;
    });
    reply.code(201);
    return team;
  });

  app.patch<IdParams>('/api/v1/org/teams/:id', async (req) => {
    const auth = requireOrg(req, 'org.members.manage');
    const { name } = parse(SaveTeamRequest, req.body);
    return withTenant(pool, auth.orgId, async (tx) => {
      const team = await loadTeam(tx, req.params.id);
      try {
        await tx.db.update(teams).set({ name }).where(eq(teams.id, team.id));
      } catch (error) {
        if (isUniqueViolation(error)) throw conflict('team_exists', 'A team with that name already exists.');
        throw error;
      }
      await audit(tx, {
        orgId: auth.orgId,
        actorId: auth.userId,
        action: 'team.renamed',
        entityType: 'team',
        entityId: team.id,
        metadata: { name },
        ip: req.ip,
      });
      return (await listTeams(tx, team.id))[0]!;
    });
  });

  app.delete<IdParams>('/api/v1/org/teams/:id', async (req, reply) => {
    const auth = requireOrg(req, 'org.members.manage');
    await withTenant(pool, auth.orgId, async (tx) => {
      const team = await loadTeam(tx, req.params.id);
      await tx.db.delete(teams).where(eq(teams.id, team.id));
      await audit(tx, {
        orgId: auth.orgId,
        actorId: auth.userId,
        action: 'team.deleted',
        entityType: 'team',
        entityId: team.id,
        metadata: { name: team.name },
        ip: req.ip,
      });
    });
    return reply.code(204).send();
  });

  /** Replace the team's members. Everyone listed must be a member of this org. */
  app.put<IdParams>('/api/v1/org/teams/:id/members', async (req) => {
    const auth = requireOrg(req, 'org.members.manage');
    const { userIds } = parse(SetTeamMembersRequest, req.body);
    return withTenant(pool, auth.orgId, async (tx) => {
      const team = await loadTeam(tx, req.params.id);
      const ids = [...new Set(userIds)];
      const found = ids.length
        ? await tx.db
            .select({ userId: memberships.userId })
            .from(memberships)
            .where(and(eq(memberships.orgId, auth.orgId), inArray(memberships.userId, ids)))
        : [];
      if (found.length !== ids.length)
        throw unprocessable('not_a_member', 'Only members of this organization can join a team.');
      await tx.db.delete(teamMembers).where(eq(teamMembers.teamId, team.id));
      if (ids.length)
        await tx.db
          .insert(teamMembers)
          .values(ids.map((userId) => ({ orgId: auth.orgId, teamId: team.id, userId })));
      await audit(tx, {
        orgId: auth.orgId,
        actorId: auth.userId,
        action: 'team.members_changed',
        entityType: 'team',
        entityId: team.id,
        metadata: { count: ids.length },
        ip: req.ip,
      });
      return (await listTeams(tx, team.id))[0]!;
    });
  });

  // ── Sharing a survey with teams ────────────────────────────────────
  app.get<IdParams>('/api/v1/surveys/:id/teams', async (req) => {
    const auth = requireOrg(req);
    return withTenant(pool, auth.orgId, async (tx) => {
      const { survey } = await loadSurvey(tx, auth, req.params.id, 'survey.view');
      return listShares(tx, survey.id);
    });
  });

  app.put<{ Params: { id: string; teamId: string } }>('/api/v1/surveys/:id/teams/:teamId', async (req) => {
    const auth = requireOrg(req);
    const { role } = parse(SetTeamShareRequest, req.body);
    return withTenant(pool, auth.orgId, async (tx) => {
      const { survey } = await loadSurvey(tx, auth, req.params.id, 'survey.share');
      const team = await loadTeam(tx, req.params.teamId);
      await tx.db
        .insert(surveyTeamCollaborators)
        .values({ orgId: auth.orgId, surveyId: survey.id, teamId: team.id, role, addedBy: auth.userId })
        .onConflictDoUpdate({
          target: [surveyTeamCollaborators.surveyId, surveyTeamCollaborators.teamId],
          set: { role },
        });
      await audit(tx, {
        orgId: auth.orgId,
        actorId: auth.userId,
        action: 'survey.shared_with_team',
        entityType: 'survey',
        entityId: survey.id,
        metadata: { teamId: team.id, role },
        ip: req.ip,
      });
      return listShares(tx, survey.id);
    });
  });

  app.delete<{ Params: { id: string; teamId: string } }>(
    '/api/v1/surveys/:id/teams/:teamId',
    async (req, reply) => {
      const auth = requireOrg(req);
      await withTenant(pool, auth.orgId, async (tx) => {
        const { survey } = await loadSurvey(tx, auth, req.params.id, 'survey.share');
        if (!UUID.test(req.params.teamId)) throw notFound('Team');
        const removed = await tx.db
          .delete(surveyTeamCollaborators)
          .where(
            and(
              eq(surveyTeamCollaborators.surveyId, survey.id),
              eq(surveyTeamCollaborators.teamId, req.params.teamId),
            ),
          )
          .returning({ teamId: surveyTeamCollaborators.teamId });
        if (removed.length === 0) throw notFound('Team share');
        await audit(tx, {
          orgId: auth.orgId,
          actorId: auth.userId,
          action: 'survey.unshared_with_team',
          entityType: 'survey',
          entityId: survey.id,
          metadata: { teamId: req.params.teamId },
          ip: req.ip,
        });
      });
      return reply.code(204).send();
    },
  );
}
