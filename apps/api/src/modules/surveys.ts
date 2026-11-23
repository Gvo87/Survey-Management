import { and, asc, desc, eq, ilike, inArray, isNotNull, isNull, max, ne, or, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import {
  CreateSurveyRequest,
  DuplicateSurveyRequest,
  ListSurveysQuery,
  PublishRequest,
  SetCollaboratorRequest,
  TransferSurveyRequest,
  UpdateSurveyRequest,
  type AccessSettings,
  type Collaborator,
  type Draft,
  type DraftValidation,
  type ApprovalPending,
  type PublishResult,
  type SaveDraftResult,
  type SurveyDetail,
  type SurveyRole,
  type SurveySummary,
  type VersionDetail,
  type VersionSummary,
} from '@survey/contracts';
import { createDefinition, remapDefinitionKeys, validateDefinition, type SurveyDefinition } from '@survey/core';
import { parseDefinition } from '@survey/core/schema';
import {
  approvalRequests,
  distributions,
  folders,
  memberships,
  newId,
  newPublicId,
  newToken,
  responses,
  surveyCollaborators,
  surveys,
  surveyVersions,
  globalTemplates,
  readAccess,
  themes,
  users,
  withTenant,
  type SurveyAccess,
  type Tx,
} from '@survey/db';
import type { Deps } from '../deps';
import { audit } from '../audit';
import { requireOrg } from '../auth/context';
import { effectiveSurveyRole, maxSurveyRole, surveyCan, type SurveyCapability } from '../auth/permissions';
import type { OrgAuth } from '../auth/session';
import { AppError, conflict, forbidden, notFound, unprocessable } from '../lib/errors';
import { decodeCursor, encodeCursor } from '../lib/misc';
import { testTokenFor } from '../lib/security';
import { parse } from '../lib/validate';
import { emitEvent } from '../events';
import { approvalSettings, requestApproval, toApprovalRequest } from './approvals';
import { hashPassword } from './auth';

type SurveyRow = typeof surveys.$inferSelect;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Status as respondents experience it: a passed close date counts as closed before the job persists it. */
export function effectiveStatus(s: SurveyRow): {
  status: SurveyRow['status'];
  reason: SurveyRow['closedReason'];
} {
  if (s.status === 'live' && s.access.closesAt && new Date(s.access.closesAt).getTime() <= Date.now())
    return { status: 'closed', reason: 'close_date' };
  return { status: s.status, reason: s.closedReason };
}

/** Phase 3A: the highest role a user holds on the survey through teams, or null. */
export const teamRoleSql = (userId: string) => sql<SurveyRole | null>`(
  select stc.role from survey_team_collaborators stc
    join team_members tm on tm.team_id = stc.team_id and tm.user_id = ${userId}::uuid
   where stc.survey_id = ${surveys.id}
   order by case stc.role when 'editor' then 2 else 1 end desc
   limit 1)`;

/** The same for each user row of a query over `users`, on one survey. */
export const teamRoleOfUsersSql = (surveyId: string) => sql<SurveyRole | null>`(
  select stc.role from survey_team_collaborators stc
    join team_members tm on tm.team_id = stc.team_id and tm.user_id = ${users.id}
   where stc.survey_id = ${surveyId}::uuid
   order by case stc.role when 'editor' then 2 else 1 end desc
   limit 1)`;

const ROLE_RANK: Record<SurveyRole, number> = { viewer: 1, editor: 2, owner: 3 };
/** The stronger of a direct share and a team share. */
export function strongerRole(a: SurveyRole | null, b: SurveyRole | null): SurveyRole | null {
  if (!a) return b;
  if (!b) return a;
  return ROLE_RANK[a] >= ROLE_RANK[b] ? a : b;
}

/**
 * Load a survey the caller can see and check a capability. Surveys the caller has no role on
 * are reported as 404, so their existence isn't revealed.
 */
export async function loadSurvey(tx: Tx, auth: OrgAuth, surveyId: string, capability: SurveyCapability) {
  if (!UUID.test(surveyId)) throw notFound('Survey');
  const [row] = await tx.db
    .select({ survey: surveys, shared: surveyCollaborators.role, teamRole: teamRoleSql(auth.userId) })
    .from(surveys)
    .leftJoin(
      surveyCollaborators,
      and(eq(surveyCollaborators.surveyId, surveys.id), eq(surveyCollaborators.userId, auth.userId)),
    )
    .where(and(eq(surveys.id, surveyId), isNull(surveys.deletedAt)));
  const role = row ? effectiveSurveyRole(auth.orgRole, strongerRole(row.shared, row.teamRole)) : null;
  if (!row || !role) throw notFound('Survey');
  if (!surveyCan(role, capability)) throw forbidden();
  return { survey: row.survey, role };
}

export function publicUrl(deps: Deps, s: Pick<SurveyRow, 'publicId' | 'currentVersionId'>): string | null {
  return s.currentVersionId ? `${deps.config.respondentUrl}/s/${s.publicId}` : null;
}

async function buildSummaries(
  deps: Deps,
  tx: Tx,
  rows: { survey: SurveyRow; role: SurveyRole }[],
): Promise<SurveySummary[]> {
  if (rows.length === 0) return [];
  const ids = rows.map((r) => r.survey.id);
  const owners = await tx.db
    .select({ surveyId: surveyCollaborators.surveyId, id: users.id, name: users.name })
    .from(surveyCollaborators)
    .innerJoin(users, eq(users.id, surveyCollaborators.userId))
    .where(and(inArray(surveyCollaborators.surveyId, ids), eq(surveyCollaborators.role, 'owner')));
  const versions = await tx.db
    .select({
      surveyId: surveyVersions.surveyId,
      id: surveyVersions.id,
      n: surveyVersions.versionNumber,
      status: surveyVersions.status,
    })
    .from(surveyVersions)
    .where(inArray(surveyVersions.surveyId, ids));
  const pending = await tx.db
    .select({ surveyId: approvalRequests.surveyId })
    .from(approvalRequests)
    .where(and(inArray(approvalRequests.surveyId, ids), eq(approvalRequests.status, 'pending')));

  return rows.map(({ survey: s, role }) => {
    const owner = owners.find((o) => o.surveyId === s.id);
    const current = versions.find((v) => v.id === s.currentVersionId);
    return {
      id: s.id,
      publicId: s.publicId,
      title: s.title,
      status: effectiveStatus(s).status,
      myRole: role,
      owner: owner ? { id: owner.id, name: owner.name } : null,
      completedCount: s.completedCount,
      currentVersionNumber: current?.n ?? null,
      hasDraft: versions.some((v) => v.surveyId === s.id && v.status === 'draft'),
      publicUrl: publicUrl(deps, s),
      updatedAt: s.updatedAt.toISOString(),
      folderId: s.folderId,
      pendingApproval: pending.some((p) => p.surveyId === s.id),
    };
  });
}

async function checkFolder(tx: Tx, folderId: string | null | undefined): Promise<void> {
  if (!folderId) return;
  const [folder] = await tx.db.select({ id: folders.id }).from(folders).where(eq(folders.id, folderId));
  if (!folder) throw unprocessable('invalid_folder', "That folder doesn't exist.");
}

/** Mark waiting approval requests as out of date (the draft changed or was discarded). */
export async function retireApprovals(tx: Tx, surveyId: string, status: 'superseded' | 'cancelled'): Promise<void> {
  await tx.db
    .update(approvalRequests)
    .set({ status, decidedAt: new Date() })
    .where(and(eq(approvalRequests.surveyId, surveyId), eq(approvalRequests.status, 'pending')));
}

/**
 * Publish a draft: freeze it, make it current, audit it and emit `survey.published` in the same
 * transaction. Used by the publish endpoint and by approving an approval request.
 */
export async function publishDraft(
  deps: Deps,
  tx: Tx,
  input: {
    orgId: string;
    actorId: string;
    publishedBy: string;
    survey: SurveyRow;
    draft: typeof surveyVersions.$inferSelect;
    ip: string | null;
    approvalRequestId?: string;
  },
) {
  const { survey, draft } = input;
  const now = new Date();
  await tx.db
    .update(surveyVersions)
    .set({ status: 'published', publishedBy: input.publishedBy, publishedAt: now, updatedAt: now })
    .where(eq(surveyVersions.id, draft.id));
  const [updated] = await tx.db
    .update(surveys)
    .set({
      currentVersionId: draft.id,
      status: survey.status === 'draft' ? 'live' : survey.status,
      updatedAt: now,
    })
    .where(eq(surveys.id, survey.id))
    .returning();
  await audit(tx, {
    orgId: input.orgId,
    actorId: input.actorId,
    action: 'survey.published',
    entityType: 'survey',
    entityId: survey.id,
    metadata: {
      versionNumber: draft.versionNumber,
      ...(input.approvalRequestId ? { approvalRequestId: input.approvalRequestId } : {}),
    },
    ip: input.ip,
  });
  await emitEvent(deps, tx, {
    orgId: input.orgId,
    type: 'survey.published',
    surveyId: survey.id,
    versionId: draft.id,
  });
  return {
    version: { id: draft.id, versionNumber: draft.versionNumber, publishedAt: now.toISOString() },
    survey: updated!,
  };
}

export async function buildDetail(
  deps: Deps,
  tx: Tx,
  survey: SurveyRow,
  role: SurveyRole,
): Promise<SurveyDetail> {
  const [summary] = await buildSummaries(deps, tx, [{ survey, role }]);
  const [count] = await tx.db
    .select({ n: sql<number>`count(*)::int` })
    .from(responses)
    .where(and(eq(responses.surveyId, survey.id), eq(responses.isTest, false)));
  const canEdit = surveyCan(role, 'survey.edit');
  return {
    ...summary!,
    anonymous: survey.anonymous,
    access: publicAccess(survey.access),
    closedReason: effectiveStatus(survey).reason,
    themeId: survey.themeId,
    isTemplate: survey.isTemplate,
    createdAt: survey.createdAt.toISOString(),
    responseCount: count?.n ?? 0,
    testUrl:
      canEdit && survey.currentVersionId
        ? `${deps.config.respondentUrl}/s/${survey.publicId}?test=${testTokenFor(deps.config.sessionSecret, survey.id)}`
        : null,
  };
}

/** Access settings as the API shows them: the password hash is reduced to a flag. */
export function publicAccess(access: SurveyAccess): AccessSettings {
  const a = readAccess(access);
  return {
    closesAt: a.closesAt,
    opensAt: a.opensAt,
    quota: a.quota,
    onePerBrowser: a.onePerBrowser,
    captcha: a.captcha,
    passwordEnabled: Boolean(a.passwordHash),
  };
}

/** The definition to start from: a global template or one of this org's template surveys. */
async function templateDefinition(tx: Tx, from: { kind: 'global' | 'org'; id: string }): Promise<SurveyDefinition> {
  if (from.kind === 'global') {
    const [row] = await tx.db.select().from(globalTemplates).where(eq(globalTemplates.id, from.id));
    if (!row) throw notFound('Template');
    return row.definition;
  }
  const [row] = await tx.db
    .select()
    .from(surveys)
    .where(and(eq(surveys.id, from.id), eq(surveys.isTemplate, true), isNull(surveys.deletedAt)));
  if (!row) throw notFound('Template');
  const draft = await findDraft(tx, row.id);
  const [current] = row.currentVersionId
    ? await tx.db.select().from(surveyVersions).where(eq(surveyVersions.id, row.currentVersionId))
    : [];
  return (draft ?? current)?.definition ?? createDefinition();
}

async function publishedDefinitions(tx: Tx, surveyId: string): Promise<SurveyDefinition[]> {
  const rows = await tx.db
    .select({ definition: surveyVersions.definition })
    .from(surveyVersions)
    .where(and(eq(surveyVersions.surveyId, surveyId), eq(surveyVersions.status, 'published')));
  return rows.map((r) => r.definition);
}

export async function validationFor(
  tx: Tx,
  survey: SurveyRow,
  definition: SurveyDefinition,
): Promise<DraftValidation> {
  const issues = validateDefinition(definition, {
    anonymous: survey.anonymous,
    previousVersions: await publishedDefinitions(tx, survey.id),
  });
  return {
    errors: issues.filter((i) => i.severity === 'error'),
    warnings: issues.filter((i) => i.severity === 'warning'),
  };
}

export async function findDraft(tx: Tx, surveyId: string) {
  const [draft] = await tx.db
    .select()
    .from(surveyVersions)
    .where(and(eq(surveyVersions.surveyId, surveyId), eq(surveyVersions.status, 'draft')));
  return draft ?? null;
}

async function toDraft(tx: Tx, survey: SurveyRow, draft: typeof surveyVersions.$inferSelect): Promise<Draft> {
  const [base] = survey.currentVersionId
    ? await tx.db
        .select({ n: surveyVersions.versionNumber })
        .from(surveyVersions)
        .where(eq(surveyVersions.id, survey.currentVersionId))
    : [];
  return {
    versionId: draft.id,
    revision: draft.revision,
    basedOnVersionNumber: base?.n ?? null,
    definition: draft.definition,
    validation: await validationFor(tx, survey, draft.definition),
    updatedAt: draft.updatedAt.toISOString(),
  };
}

function parseIfMatch(header: string | undefined): number {
  const match = header?.match(/^(?:W\/)?"?(?:rev-)?(\d+)"?$/);
  if (!match)
    throw new AppError(428, 'precondition_required', 'Send If-Match with the draft revision you edited.');
  return Number(match[1]);
}

export async function createSurveyRecords(
  tx: Tx,
  auth: OrgAuth,
  input: {
    title: string;
    definition: SurveyDefinition;
    anonymous?: boolean;
    access?: SurveyAccess;
    folderId?: string | null;
  },
): Promise<SurveyRow> {
  const surveyId = newId();
  const [survey] = await tx.db
    .insert(surveys)
    .values({
      id: surveyId,
      orgId: auth.orgId,
      title: input.title,
      publicId: newPublicId(),
      createdBy: auth.userId,
      anonymous: input.anonymous ?? false,
      ...(input.access ? { access: input.access } : {}),
      folderId: input.folderId ?? null,
    })
    .returning();
  await tx.db.insert(surveyVersions).values({
    id: newId(),
    orgId: auth.orgId,
    surveyId,
    versionNumber: 1,
    status: 'draft',
    definition: input.definition,
    createdBy: auth.userId,
    updatedBy: auth.userId,
  });
  await tx.db
    .insert(surveyCollaborators)
    .values({ orgId: auth.orgId, surveyId, userId: auth.userId, role: 'owner', addedBy: auth.userId });
  await tx.db.insert(distributions).values({
    id: newId(),
    orgId: auth.orgId,
    surveyId,
    channel: 'link',
    name: 'Default link',
    token: newToken(9),
    isDefault: true,
    createdBy: auth.userId,
  });
  return survey!;
}

export function registerSurveyRoutes(app: FastifyInstance, deps: Deps): void {
  const { pool } = deps;
  type IdParams = { Params: { id: string } };

  app.get('/api/v1/surveys', async (req) => {
    const auth = requireOrg(req);
    const query = parse(ListSurveysQuery, req.query);
    return withTenant(pool, auth.orgId, async (tx) => {
      const teamRole = teamRoleSql(auth.userId);
      const conditions = [isNull(surveys.deletedAt), eq(surveys.isTemplate, false)];
      if (auth.orgRole !== 'org_admin')
        conditions.push(or(isNotNull(surveyCollaborators.role), sql`${teamRole} is not null`)!);
      if (query.status) conditions.push(eq(surveys.status, query.status));
      if (query.folderId === 'none') conditions.push(isNull(surveys.folderId));
      else if (query.folderId) conditions.push(eq(surveys.folderId, query.folderId));
      if (query.q) conditions.push(ilike(surveys.title, `%${query.q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`));
      const cursor = decodeCursor(query.cursor, 2);
      if (cursor)
        conditions.push(
          sql`(${surveys.updatedAt}, ${surveys.id}) < (${cursor[0]}::timestamptz, ${cursor[1]}::uuid)`,
        );

      const rows = await tx.db
        .select({ survey: surveys, shared: surveyCollaborators.role, teamRole })
        .from(surveys)
        .leftJoin(
          surveyCollaborators,
          and(eq(surveyCollaborators.surveyId, surveys.id), eq(surveyCollaborators.userId, auth.userId)),
        )
        .where(and(...conditions))
        .orderBy(desc(surveys.updatedAt), desc(surveys.id))
        .limit(query.limit + 1);

      const page = rows.slice(0, query.limit);
      const visible = page.map((r) => ({
        survey: r.survey,
        role: effectiveSurveyRole(auth.orgRole, strongerRole(r.shared, r.teamRole))!,
      }));
      const last = page.at(-1);
      return {
        data: await buildSummaries(deps, tx, visible),
        nextCursor:
          rows.length > query.limit && last
            ? encodeCursor([last.survey.updatedAt.toISOString(), last.survey.id])
            : null,
      };
    });
  });

  app.post('/api/v1/surveys', async (req, reply) => {
    const auth = requireOrg(req, 'surveys.create');
    const { title, fromTemplate, folderId } = parse(CreateSurveyRequest, req.body);
    const detail = await withTenant(pool, auth.orgId, async (tx) => {
      await checkFolder(tx, folderId);
      // Fresh keys for everything copied from a template, so no two surveys share keys.
      const definition = fromTemplate ? remapDefinitionKeys(await templateDefinition(tx, fromTemplate)) : createDefinition();
      const survey = await createSurveyRecords(tx, auth, { title, definition, folderId: folderId ?? null });
      await audit(tx, {
        orgId: auth.orgId,
        actorId: auth.userId,
        action: 'survey.created',
        entityType: 'survey',
        entityId: survey.id,
        ip: req.ip,
      });
      return buildDetail(deps, tx, survey, 'owner');
    });
    reply.code(201);
    return detail;
  });

  app.get<IdParams>('/api/v1/surveys/:id', async (req) => {
    const auth = requireOrg(req);
    return withTenant(pool, auth.orgId, async (tx) => {
      const { survey, role } = await loadSurvey(tx, auth, req.params.id, 'survey.view');
      return buildDetail(deps, tx, survey, role);
    });
  });

  app.patch<IdParams>('/api/v1/surveys/:id', async (req) => {
    const auth = requireOrg(req);
    const body = parse(UpdateSurveyRequest, req.body);
    return withTenant(pool, auth.orgId, async (tx) => {
      const { survey, role } = await loadSurvey(tx, auth, req.params.id, 'survey.edit');
      if (body.anonymous !== undefined && body.anonymous !== survey.anonymous) {
        const [any] = await tx.db
          .select({ id: responses.id })
          .from(responses)
          .where(eq(responses.surveyId, survey.id))
          .limit(1);
        if (any)
          throw conflict(
            'anonymous_locked',
            "Anonymity can't be changed after responses have been collected. Duplicate the survey instead.",
          );
      }
      if (body.themeId) {
        const [theme] = await tx.db.select({ id: themes.id }).from(themes).where(eq(themes.id, body.themeId));
        if (!theme) throw unprocessable('invalid_theme', "That theme doesn't exist.");
      }
      await checkFolder(tx, body.folderId);
      let access: SurveyAccess | undefined;
      if (body.access) {
        const { password, ...rest } = body.access;
        access = { ...survey.access, ...rest };
        if (password !== undefined) access.passwordHash = password === null ? null : await hashPassword(password);
      }
      const [updated] = await tx.db
        .update(surveys)
        .set({
          ...(body.title !== undefined ? { title: body.title } : {}),
          ...(body.anonymous !== undefined ? { anonymous: body.anonymous } : {}),
          ...(access ? { access } : {}),
          ...(body.themeId !== undefined ? { themeId: body.themeId } : {}),
          ...(body.folderId !== undefined ? { folderId: body.folderId } : {}),
          updatedAt: new Date(),
        })
        .where(eq(surveys.id, survey.id))
        .returning();
      await audit(tx, {
        orgId: auth.orgId,
        actorId: auth.userId,
        action: 'survey.updated',
        entityType: 'survey',
        entityId: survey.id,
        metadata: { fields: Object.keys(body), ...(body.access?.password !== undefined ? { password: body.access.password ? 'set' : 'removed' } : {}) },
        ip: req.ip,
      });
      return buildDetail(deps, tx, updated!, role);
    });
  });

  app.delete<IdParams>('/api/v1/surveys/:id', async (req, reply) => {
    const auth = requireOrg(req);
    await withTenant(pool, auth.orgId, async (tx) => {
      const { survey } = await loadSurvey(tx, auth, req.params.id, 'survey.delete');
      await tx.db
        .update(surveys)
        .set({ deletedAt: new Date(), updatedAt: new Date() })
        .where(eq(surveys.id, survey.id));
      await audit(tx, {
        orgId: auth.orgId,
        actorId: auth.userId,
        action: 'survey.deleted',
        entityType: 'survey',
        entityId: survey.id,
        metadata: { title: survey.title },
        ip: req.ip,
      });
    });
    return reply.code(204).send();
  });

  app.post<IdParams>('/api/v1/surveys/:id/duplicate', async (req, reply) => {
    const auth = requireOrg(req, 'surveys.create');
    const body = parse(DuplicateSurveyRequest, req.body);
    const detail = await withTenant(pool, auth.orgId, async (tx) => {
      const { survey } = await loadSurvey(tx, auth, req.params.id, 'survey.view');
      const draft = await findDraft(tx, survey.id);
      const [current] = survey.currentVersionId
        ? await tx.db.select().from(surveyVersions).where(eq(surveyVersions.id, survey.currentVersionId))
        : [];
      const definition = (draft ?? current)?.definition ?? createDefinition();
      const copy = await createSurveyRecords(tx, auth, {
        title: body.title ?? `Copy of ${survey.title}`.slice(0, 300),
        definition,
        anonymous: survey.anonymous,
        folderId: survey.folderId,
        access: { closesAt: null, quota: null, onePerBrowser: readAccess(survey.access).onePerBrowser, captcha: readAccess(survey.access).captcha },
      });
      await audit(tx, {
        orgId: auth.orgId,
        actorId: auth.userId,
        action: 'survey.duplicated',
        entityType: 'survey',
        entityId: copy.id,
        metadata: { sourceId: survey.id },
        ip: req.ip,
      });
      return buildDetail(deps, tx, copy, 'owner');
    });
    reply.code(201);
    return detail;
  });

  // ── Status transitions ────────────────────────────────────────────
  app.post<IdParams>('/api/v1/surveys/:id/close', async (req) => {
    const auth = requireOrg(req);
    return withTenant(pool, auth.orgId, async (tx) => {
      const { survey, role } = await loadSurvey(tx, auth, req.params.id, 'survey.close');
      if (survey.status !== 'live') throw conflict('not_live', 'Only a live survey can be closed.');
      const [updated] = await tx.db
        .update(surveys)
        .set({ status: 'closed', closedReason: 'manual', closedAt: new Date(), updatedAt: new Date() })
        .where(eq(surveys.id, survey.id))
        .returning();
      await audit(tx, {
        orgId: auth.orgId,
        actorId: auth.userId,
        action: 'survey.closed',
        entityType: 'survey',
        entityId: survey.id,
        ip: req.ip,
      });
      await emitEvent(deps, tx, { orgId: auth.orgId, type: 'survey.closed', surveyId: survey.id, reason: 'manual' });
      return buildDetail(deps, tx, updated!, role);
    });
  });

  app.post<IdParams>('/api/v1/surveys/:id/reopen', async (req) => {
    const auth = requireOrg(req);
    return withTenant(pool, auth.orgId, async (tx) => {
      const { survey, role } = await loadSurvey(tx, auth, req.params.id, 'survey.close');
      if (survey.status === 'live' && effectiveStatus(survey).status === 'live')
        throw conflict('already_live', 'This survey is already open.');
      if (!survey.currentVersionId) throw conflict('not_published', 'Publish the survey first.');
      if (survey.access.quota !== null && survey.completedCount >= survey.access.quota)
        throw conflict('quota_reached', 'The response limit has been reached. Raise or remove it first.');
      if (survey.access.closesAt && new Date(survey.access.closesAt).getTime() <= Date.now())
        throw conflict('close_date_passed', 'The close date has passed. Change or remove it first.');
      const [updated] = await tx.db
        .update(surveys)
        .set({ status: 'live', closedReason: null, closedAt: null, updatedAt: new Date() })
        .where(eq(surveys.id, survey.id))
        .returning();
      await audit(tx, {
        orgId: auth.orgId,
        actorId: auth.userId,
        action: 'survey.reopened',
        entityType: 'survey',
        entityId: survey.id,
        ip: req.ip,
      });
      return buildDetail(deps, tx, updated!, role);
    });
  });

  app.post<IdParams>('/api/v1/surveys/:id/archive', async (req) => {
    const auth = requireOrg(req);
    return withTenant(pool, auth.orgId, async (tx) => {
      const { survey, role } = await loadSurvey(tx, auth, req.params.id, 'survey.close');
      const [updated] = await tx.db
        .update(surveys)
        .set({ status: 'archived', closedAt: survey.closedAt ?? new Date(), updatedAt: new Date() })
        .where(eq(surveys.id, survey.id))
        .returning();
      await audit(tx, {
        orgId: auth.orgId,
        actorId: auth.userId,
        action: 'survey.archived',
        entityType: 'survey',
        entityId: survey.id,
        ip: req.ip,
      });
      return buildDetail(deps, tx, updated!, role);
    });
  });

  // ── Drafts ────────────────────────────────────────────────────────
  app.get<IdParams>('/api/v1/surveys/:id/draft', async (req, reply) => {
    const auth = requireOrg(req);
    return withTenant(pool, auth.orgId, async (tx) => {
      const { survey } = await loadSurvey(tx, auth, req.params.id, 'survey.view');
      const draft = await findDraft(tx, survey.id);
      if (!draft) throw notFound('Draft');
      reply.header('etag', `"rev-${draft.revision}"`);
      return toDraft(tx, survey, draft);
    });
  });

  app.post<IdParams>('/api/v1/surveys/:id/draft', async (req, reply) => {
    const auth = requireOrg(req);
    return withTenant(pool, auth.orgId, async (tx) => {
      const { survey } = await loadSurvey(tx, auth, req.params.id, 'survey.edit');
      // Serialise draft creation per survey.
      await tx.client.query('select 1 from surveys where id = $1 for update', [survey.id]);
      const existing = await findDraft(tx, survey.id);
      if (existing) return toDraft(tx, survey, existing);
      if (!survey.currentVersionId) throw notFound('Published version');
      const [current] = await tx.db
        .select()
        .from(surveyVersions)
        .where(eq(surveyVersions.id, survey.currentVersionId));
      const [top] = await tx.db
        .select({ n: max(surveyVersions.versionNumber) })
        .from(surveyVersions)
        .where(eq(surveyVersions.surveyId, survey.id));
      const [draft] = await tx.db
        .insert(surveyVersions)
        .values({
          id: newId(),
          orgId: auth.orgId,
          surveyId: survey.id,
          versionNumber: (top?.n ?? 0) + 1,
          status: 'draft',
          definition: current!.definition,
          createdBy: auth.userId,
          updatedBy: auth.userId,
        })
        .returning();
      reply.code(201).header('etag', `"rev-${draft!.revision}"`);
      return toDraft(tx, survey, draft!);
    });
  });

  app.put<IdParams>('/api/v1/surveys/:id/draft', async (req, reply): Promise<SaveDraftResult> => {
    const auth = requireOrg(req);
    const revision = parseIfMatch(req.headers['if-match']);
    const parsed = parseDefinition((req.body as { definition?: unknown } | undefined)?.definition);
    if (!parsed.ok)
      throw unprocessable('invalid_definition', 'The survey definition is malformed.', parsed.issues);
    return withTenant(pool, auth.orgId, async (tx) => {
      const { survey } = await loadSurvey(tx, auth, req.params.id, 'survey.edit');
      const [saved] = await tx.db
        .update(surveyVersions)
        .set({
          definition: parsed.definition,
          revision: revision + 1,
          updatedBy: auth.userId,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(surveyVersions.surveyId, survey.id),
            eq(surveyVersions.status, 'draft'),
            eq(surveyVersions.revision, revision),
          ),
        )
        .returning();
      if (!saved) {
        const current = await findDraft(tx, survey.id);
        if (!current) throw notFound('Draft');
        const [editor] = current.updatedBy
          ? await tx.db.select({ name: users.name }).from(users).where(eq(users.id, current.updatedBy))
          : [];
        throw conflict('revision_conflict', 'Someone else saved this draft since you loaded it.', {
          currentRevision: current.revision,
          updatedBy: editor?.name ?? null,
          updatedAt: current.updatedAt.toISOString(),
        });
      }
      await tx.db.update(surveys).set({ updatedAt: new Date() }).where(eq(surveys.id, survey.id));
      // An approval covers one exact revision: any edit makes a waiting request out of date.
      await retireApprovals(tx, survey.id, 'superseded');
      reply.header('etag', `"rev-${saved.revision}"`);
      return {
        revision: saved.revision,
        validation: await validationFor(tx, survey, saved.definition),
        updatedAt: saved.updatedAt.toISOString(),
      };
    });
  });

  app.delete<IdParams>('/api/v1/surveys/:id/draft', async (req, reply) => {
    const auth = requireOrg(req);
    await withTenant(pool, auth.orgId, async (tx) => {
      const { survey } = await loadSurvey(tx, auth, req.params.id, 'survey.edit');
      if (!survey.currentVersionId)
        throw conflict(
          'cannot_discard_initial_draft',
          "A survey that has never been published can't discard its draft.",
        );
      const deleted = await tx.db
        .delete(surveyVersions)
        .where(and(eq(surveyVersions.surveyId, survey.id), eq(surveyVersions.status, 'draft')))
        .returning({ id: surveyVersions.id });
      if (deleted.length === 0) throw notFound('Draft');
      await retireApprovals(tx, survey.id, 'cancelled');
      await audit(tx, {
        orgId: auth.orgId,
        actorId: auth.userId,
        action: 'survey.draft_discarded',
        entityType: 'survey',
        entityId: survey.id,
        ip: req.ip,
      });
    });
    return reply.code(204).send();
  });

  app.post<IdParams>('/api/v1/surveys/:id/publish', async (req, reply): Promise<PublishResult | ApprovalPending> => {
    const auth = requireOrg(req);
    const { revision, note } = parse(PublishRequest, req.body);
    return withTenant(pool, auth.orgId, async (tx) => {
      const { survey, role } = await loadSurvey(tx, auth, req.params.id, 'survey.publish');
      await tx.client.query('select 1 from surveys where id = $1 for update', [survey.id]);
      if (survey.isTemplate) throw conflict('template_not_publishable', "Templates can't be published. Create a survey from it instead.");
      const draft = await findDraft(tx, survey.id);
      if (!draft) throw conflict('no_draft', 'There are no unpublished changes.');
      if (draft.revision !== revision)
        throw conflict(
          'revision_conflict',
          'The draft changed since you reviewed it. Review it again before publishing.',
          {
            currentRevision: draft.revision,
          },
        );
      const { errors } = await validationFor(tx, survey, draft.definition);
      if (errors.length > 0)
        throw unprocessable(
          'publish_blocked',
          'Fix the problems in the survey before publishing.',
          errors.map((e) => ({ path: e.path, code: e.code, message: e.message })),
        );

      // Phase 3A: with approvals on, publishing asks an approver instead (202).
      if ((await approvalSettings(tx, auth.orgId)).approvalRequired) {
        const request = await requestApproval(deps, tx, { auth, survey, draft, note: note ?? null, ip: req.ip });
        reply.code(202);
        return { approvalRequest: await toApprovalRequest(tx, auth, request) };
      }
      const published = await publishDraft(deps, tx, {
        orgId: auth.orgId,
        actorId: auth.userId,
        publishedBy: auth.userId,
        survey,
        draft,
        ip: req.ip,
      });
      return {
        version: published.version,
        survey: await buildDetail(deps, tx, published.survey, role),
        publicUrl: publicUrl(deps, published.survey)!,
      };
    });
  });

  // ── Versions ──────────────────────────────────────────────────────
  async function versionSummaries(
    tx: Tx,
    surveyId: string,
  ): Promise<(VersionSummary & { definition: SurveyDefinition })[]> {
    const rows = await tx.db
      .select({ v: surveyVersions, by: users.name })
      .from(surveyVersions)
      .leftJoin(users, eq(users.id, surveyVersions.publishedBy))
      .where(and(eq(surveyVersions.surveyId, surveyId), eq(surveyVersions.status, 'published')))
      .orderBy(desc(surveyVersions.versionNumber));
    const counts = await tx.db
      .select({ versionId: responses.versionId, n: sql<number>`count(*)::int` })
      .from(responses)
      .where(and(eq(responses.surveyId, surveyId), eq(responses.isTest, false)))
      .groupBy(responses.versionId);
    return rows.map(({ v, by }) => ({
      id: v.id,
      versionNumber: v.versionNumber,
      publishedAt: v.publishedAt!.toISOString(),
      publishedBy: by,
      responseCount: counts.find((c) => c.versionId === v.id)?.n ?? 0,
      definition: v.definition,
    }));
  }

  app.get<IdParams>('/api/v1/surveys/:id/versions', async (req) => {
    const auth = requireOrg(req);
    return withTenant(pool, auth.orgId, async (tx) => {
      const { survey } = await loadSurvey(tx, auth, req.params.id, 'survey.view');
      return (await versionSummaries(tx, survey.id)).map(({ definition: _, ...v }) => v);
    });
  });

  app.get<{ Params: { id: string; versionId: string } }>(
    '/api/v1/surveys/:id/versions/:versionId',
    async (req) => {
      const auth = requireOrg(req);
      return withTenant(pool, auth.orgId, async (tx): Promise<VersionDetail> => {
        const { survey } = await loadSurvey(tx, auth, req.params.id, 'survey.view');
        const version = (await versionSummaries(tx, survey.id)).find((v) => v.id === req.params.versionId);
        if (!version) throw notFound('Version');
        return version;
      });
    },
  );

  // ── Sharing ───────────────────────────────────────────────────────
  async function listCollaborators(tx: Tx, surveyId: string): Promise<Collaborator[]> {
    const rows = await tx.db
      .select({ c: surveyCollaborators, u: users })
      .from(surveyCollaborators)
      .innerJoin(users, eq(users.id, surveyCollaborators.userId))
      .where(eq(surveyCollaborators.surveyId, surveyId))
      .orderBy(asc(users.name));
    const order = { owner: 0, editor: 1, viewer: 2 } as const;
    return rows
      .map(({ c, u }) => ({ user: { id: u.id, name: u.name, email: u.email }, role: c.role }))
      .sort((a, b) => order[a.role] - order[b.role]);
  }

  async function memberRole(tx: Tx, orgId: string, userId: string) {
    const [m] = await tx.db
      .select({ role: memberships.role })
      .from(memberships)
      .where(and(eq(memberships.orgId, orgId), eq(memberships.userId, userId)));
    return m?.role ?? null;
  }

  app.get<IdParams>('/api/v1/surveys/:id/collaborators', async (req) => {
    const auth = requireOrg(req);
    return withTenant(pool, auth.orgId, async (tx) => {
      const { survey } = await loadSurvey(tx, auth, req.params.id, 'survey.view');
      return listCollaborators(tx, survey.id);
    });
  });

  app.put<{ Params: { id: string; userId: string } }>(
    '/api/v1/surveys/:id/collaborators/:userId',
    async (req) => {
      const auth = requireOrg(req);
      const { role } = parse(SetCollaboratorRequest, req.body);
      return withTenant(pool, auth.orgId, async (tx) => {
        const { survey } = await loadSurvey(tx, auth, req.params.id, 'survey.share');
        if (role === 'owner')
          throw unprocessable('use_transfer', 'Use "Transfer ownership" to make someone the owner.');
        if (!UUID.test(req.params.userId)) throw notFound('Member');
        const orgRole = await memberRole(tx, auth.orgId, req.params.userId);
        if (!orgRole) throw unprocessable('not_a_member', 'Only members of this organization can be added.');
        const cap = maxSurveyRole(orgRole);
        if (cap === 'viewer' && role !== 'viewer')
          throw unprocessable('role_exceeds_org_role', 'Analysts can only be given view access.');
        const [current] = await tx.db
          .select({ role: surveyCollaborators.role })
          .from(surveyCollaborators)
          .where(
            and(
              eq(surveyCollaborators.surveyId, survey.id),
              eq(surveyCollaborators.userId, req.params.userId),
            ),
          );
        if (current?.role === 'owner')
          throw conflict(
            'owner_role_locked',
            "The owner's role can't be changed. Transfer ownership instead.",
          );
        await tx.db
          .insert(surveyCollaborators)
          .values({
            orgId: auth.orgId,
            surveyId: survey.id,
            userId: req.params.userId,
            role,
            addedBy: auth.userId,
          })
          .onConflictDoUpdate({
            target: [surveyCollaborators.surveyId, surveyCollaborators.userId],
            set: { role },
          });
        await audit(tx, {
          orgId: auth.orgId,
          actorId: auth.userId,
          action: 'survey.shared',
          entityType: 'survey',
          entityId: survey.id,
          metadata: { userId: req.params.userId, role },
          ip: req.ip,
        });
        return listCollaborators(tx, survey.id);
      });
    },
  );

  app.delete<{ Params: { id: string; userId: string } }>(
    '/api/v1/surveys/:id/collaborators/:userId',
    async (req, reply) => {
      const auth = requireOrg(req);
      await withTenant(pool, auth.orgId, async (tx) => {
        const { survey } = await loadSurvey(tx, auth, req.params.id, 'survey.share');
        if (!UUID.test(req.params.userId)) throw notFound('Collaborator');
        const removed = await tx.db
          .delete(surveyCollaborators)
          .where(
            and(
              eq(surveyCollaborators.surveyId, survey.id),
              eq(surveyCollaborators.userId, req.params.userId),
              ne(surveyCollaborators.role, 'owner'),
            ),
          )
          .returning({ userId: surveyCollaborators.userId });
        if (removed.length === 0)
          throw conflict('cannot_remove', "That person isn't a collaborator, or is the owner.");
        await audit(tx, {
          orgId: auth.orgId,
          actorId: auth.userId,
          action: 'survey.unshared',
          entityType: 'survey',
          entityId: survey.id,
          metadata: { userId: req.params.userId },
          ip: req.ip,
        });
      });
      return reply.code(204).send();
    },
  );

  app.post<IdParams>('/api/v1/surveys/:id/transfer', async (req) => {
    const auth = requireOrg(req);
    const { userId } = parse(TransferSurveyRequest, req.body);
    return withTenant(pool, auth.orgId, async (tx) => {
      const { survey, role } = await loadSurvey(tx, auth, req.params.id, 'survey.transfer');
      const orgRole = await memberRole(tx, auth.orgId, userId);
      if (!orgRole || orgRole === 'analyst')
        throw unprocessable(
          'invalid_transfer',
          'Ownership can only go to an admin or creator in this organization.',
        );
      await tx.db
        .update(surveyCollaborators)
        .set({ role: 'editor' })
        .where(and(eq(surveyCollaborators.surveyId, survey.id), eq(surveyCollaborators.role, 'owner')));
      await tx.db
        .insert(surveyCollaborators)
        .values({ orgId: auth.orgId, surveyId: survey.id, userId, role: 'owner', addedBy: auth.userId })
        .onConflictDoUpdate({
          target: [surveyCollaborators.surveyId, surveyCollaborators.userId],
          set: { role: 'owner' },
        });
      await audit(tx, {
        orgId: auth.orgId,
        actorId: auth.userId,
        action: 'survey.transferred',
        entityType: 'survey',
        entityId: survey.id,
        metadata: { to: userId },
        ip: req.ip,
      });
      const after = await loadSurvey(tx, auth, survey.id, 'survey.view').catch(() => ({ survey, role }));
      return buildDetail(deps, tx, after.survey, after.role);
    });
  });
}
