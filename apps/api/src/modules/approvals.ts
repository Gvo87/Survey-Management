/**
 * Approval before publishing (Phase 3A). With `approvalRequired` on, publishing creates a request for
 * one exact draft revision. Only an org admin or a designated approver, never the requester, can approve
 * it, and approving publishes exactly that revision. Any later edit to the draft supersedes the request.
 */
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { DecideApprovalRequest, ListApprovalsQuery, type ApprovalRequest } from '@survey/contracts';
import { approvalRequests, newId, organizations, surveys, users, withTenant, type Tx } from '@survey/db';
import type { Deps } from '../deps';
import { audit } from '../audit';
import { requireOrg } from '../auth/context';
import type { OrgAuth } from '../auth/session';
import { conflict, forbidden, notFound, unprocessable } from '../lib/errors';
import { parse } from '../lib/validate';
import { notifyUsers, orgAdmins } from '../jobs/notifications';
import { findDraft, loadSurvey, publishDraft, validationFor } from './surveys';

type RequestRow = typeof approvalRequests.$inferSelect;
type SurveyRow = typeof surveys.$inferSelect;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface ApprovalSettings {
  approvalRequired: boolean;
  approverIds: string[];
}

export async function approvalSettings(tx: Tx, orgId: string): Promise<ApprovalSettings> {
  const [org] = await tx.db
    .select({ settings: organizations.settings })
    .from(organizations)
    .where(eq(organizations.id, orgId));
  const settings = org?.settings ?? {};
  return {
    approvalRequired: settings.approvalRequired === true,
    approverIds: Array.isArray(settings.approverIds)
      ? settings.approverIds.filter((id): id is string => typeof id === 'string')
      : [],
  };
}

function canDecide(auth: OrgAuth, settings: ApprovalSettings, request: RequestRow): boolean {
  if (request.requestedBy === auth.userId) return false;
  return auth.orgRole === 'org_admin' || settings.approverIds.includes(auth.userId);
}

export async function toApprovalRequests(
  tx: Tx,
  auth: OrgAuth,
  rows: RequestRow[],
): Promise<ApprovalRequest[]> {
  if (rows.length === 0) return [];
  const settings = await approvalSettings(tx, auth.orgId);
  const titles = await tx.db
    .select({ id: surveys.id, title: surveys.title })
    .from(surveys)
    .where(inArray(surveys.id, [...new Set(rows.map((r) => r.surveyId))]));
  const userIds = [
    ...new Set(rows.flatMap((r) => [r.requestedBy, r.decidedBy]).filter((id): id is string => Boolean(id))),
  ];
  const names = await tx.db
    .select({ id: users.id, name: users.name })
    .from(users)
    .where(inArray(users.id, userIds));
  const person = (id: string | null) =>
    id ? { id, name: names.find((n) => n.id === id)?.name ?? 'Former member' } : null;
  return rows.map((r) => ({
    id: r.id,
    survey: { id: r.surveyId, title: titles.find((t) => t.id === r.surveyId)?.title ?? '' },
    revision: r.revision,
    status: r.status,
    requestedBy: person(r.requestedBy)!,
    requestNote: r.requestNote,
    decidedBy: person(r.decidedBy),
    decisionNote: r.decisionNote,
    decidedAt: r.decidedAt?.toISOString() ?? null,
    createdAt: r.createdAt.toISOString(),
    canDecide: r.status === 'pending' && canDecide(auth, settings, r),
  }));
}

export async function toApprovalRequest(tx: Tx, auth: OrgAuth, row: RequestRow): Promise<ApprovalRequest> {
  return (await toApprovalRequests(tx, auth, [row]))[0]!;
}

/** Ask for approval of a draft revision. Asking again for the same revision returns the open request. */
export async function requestApproval(
  deps: Deps,
  tx: Tx,
  input: {
    auth: OrgAuth;
    survey: SurveyRow;
    draft: { id: string; revision: number };
    note: string | null;
    ip: string | null;
  },
): Promise<RequestRow> {
  const { auth, survey, draft } = input;
  const [open] = await tx.db
    .select()
    .from(approvalRequests)
    .where(and(eq(approvalRequests.surveyId, survey.id), eq(approvalRequests.status, 'pending')));
  if (open && open.versionId === draft.id && open.revision === draft.revision) return open;
  if (open)
    await tx.db
      .update(approvalRequests)
      .set({ status: 'superseded', decidedAt: new Date() })
      .where(eq(approvalRequests.id, open.id));
  const [created] = await tx.db
    .insert(approvalRequests)
    .values({
      id: newId(),
      orgId: auth.orgId,
      surveyId: survey.id,
      versionId: draft.id,
      revision: draft.revision,
      requestedBy: auth.userId,
      requestNote: input.note,
    })
    .returning();
  await audit(tx, {
    orgId: auth.orgId,
    actorId: auth.userId,
    action: 'survey.approval_requested',
    entityType: 'survey',
    entityId: survey.id,
    metadata: { approvalRequestId: created!.id, revision: draft.revision },
    ip: input.ip,
  });
  const settings = await approvalSettings(tx, auth.orgId);
  await notifyUsers(deps, tx, {
    orgId: auth.orgId,
    userIds: [...(await orgAdmins(tx)), ...settings.approverIds].filter((id) => id !== auth.userId),
    kind: 'approval_requested',
    title: `"${survey.title}" is waiting for approval`,
    body: input.note
      ? `Note from the author: ${input.note}`
      : 'Review the changes, then approve or reject them.',
    link: '/approvals',
    surveyId: survey.id,
    channels: ['in_app', 'email'],
  });
  return created!;
}

export function registerApprovalRoutes(app: FastifyInstance, deps: Deps): void {
  const { pool } = deps;
  type IdParams = { Params: { id: string } };

  app.get('/api/v1/approval-requests', async (req) => {
    const auth = requireOrg(req);
    const query = parse(ListApprovalsQuery, req.query);
    return withTenant(pool, auth.orgId, async (tx) => {
      const conditions = [];
      if (query.status) conditions.push(eq(approvalRequests.status, query.status));
      if (query.surveyId) conditions.push(eq(approvalRequests.surveyId, query.surveyId));
      // Only requests for surveys the caller can see.
      if (auth.orgRole !== 'org_admin')
        conditions.push(sql`(
          exists (select 1 from survey_collaborators sc
                   where sc.survey_id = ${approvalRequests.surveyId} and sc.user_id = ${auth.userId}::uuid)
          or exists (select 1 from survey_team_collaborators stc join team_members tm on tm.team_id = stc.team_id
                      where stc.survey_id = ${approvalRequests.surveyId} and tm.user_id = ${auth.userId}::uuid))`);
      const rows = await tx.db
        .select({ r: approvalRequests })
        .from(approvalRequests)
        .innerJoin(surveys, and(eq(surveys.id, approvalRequests.surveyId), sql`${surveys.deletedAt} is null`))
        .where(and(...conditions))
        .orderBy(desc(approvalRequests.createdAt))
        .limit(100);
      return toApprovalRequests(
        tx,
        auth,
        rows.map((r) => r.r),
      );
    });
  });

  async function loadRequest(tx: Tx, auth: OrgAuth, id: string) {
    if (!UUID.test(id)) throw notFound('Approval request');
    const [request] = await tx.db
      .select()
      .from(approvalRequests)
      .where(eq(approvalRequests.id, id))
      .for('update');
    if (!request) throw notFound('Approval request');
    const { survey } = await loadSurvey(tx, auth, request.surveyId, 'survey.view');
    return { request, survey };
  }

  function checkDecider(auth: OrgAuth, settings: ApprovalSettings, request: RequestRow) {
    if (request.requestedBy === auth.userId)
      throw forbidden("You can't approve or reject your own request. Ask another approver.", 'self_approval');
    if (!canDecide(auth, settings, request))
      throw forbidden('Only org admins and designated approvers can decide on approvals.', 'not_an_approver');
    if (request.status !== 'pending')
      throw conflict('not_pending', `This request is already ${request.status}.`);
  }

  app.post<IdParams>('/api/v1/approval-requests/:id/approve', async (req) => {
    const auth = requireOrg(req);
    const { note } = parse(DecideApprovalRequest, req.body);
    const outcome = await withTenant(pool, auth.orgId, async (tx) => {
      const { request, survey } = await loadRequest(tx, auth, req.params.id);
      checkDecider(auth, await approvalSettings(tx, auth.orgId), request);
      await tx.client.query('select 1 from surveys where id = $1 for update', [survey.id]);
      const draft = await findDraft(tx, survey.id);
      // Approval covers exactly the reviewed revision.
      if (!draft || draft.id !== request.versionId || draft.revision !== request.revision) {
        await tx.db
          .update(approvalRequests)
          .set({ status: 'superseded', decidedAt: new Date() })
          .where(eq(approvalRequests.id, request.id));
        return { stale: true as const };
      }
      const { errors } = await validationFor(tx, survey, draft.definition);
      if (errors.length > 0)
        throw unprocessable(
          'publish_blocked',
          'The draft has problems that block publishing.',
          errors.map((e) => ({ path: e.path, code: e.code, message: e.message })),
        );
      const [decided] = await tx.db
        .update(approvalRequests)
        .set({
          status: 'approved',
          decidedBy: auth.userId,
          decisionNote: note ?? null,
          decidedAt: new Date(),
        })
        .where(eq(approvalRequests.id, request.id))
        .returning();
      await audit(tx, {
        orgId: auth.orgId,
        actorId: auth.userId,
        action: 'survey.approval_approved',
        entityType: 'survey',
        entityId: survey.id,
        metadata: { approvalRequestId: request.id, revision: request.revision },
        ip: req.ip,
      });
      await publishDraft(deps, tx, {
        orgId: auth.orgId,
        actorId: auth.userId,
        publishedBy: request.requestedBy,
        survey,
        draft,
        ip: req.ip,
        approvalRequestId: request.id,
      });
      await notifyUsers(deps, tx, {
        orgId: auth.orgId,
        userIds: [request.requestedBy],
        kind: 'approval_decided',
        title: `"${survey.title}" was approved and published`,
        body: note ? `Note from the approver: ${note}` : 'Your changes are live.',
        link: `/surveys/${survey.id}/edit`,
        surveyId: survey.id,
        channels: ['in_app', 'email'],
      });
      return { stale: false as const, request: await toApprovalRequest(tx, auth, decided!) };
    });
    if (outcome.stale)
      throw conflict(
        'approval_stale',
        'The draft changed after this request was made. Its author needs to ask again.',
      );
    return outcome.request;
  });

  app.post<IdParams>('/api/v1/approval-requests/:id/reject', async (req) => {
    const auth = requireOrg(req);
    const { note } = parse(DecideApprovalRequest, req.body);
    return withTenant(pool, auth.orgId, async (tx) => {
      const { request, survey } = await loadRequest(tx, auth, req.params.id);
      checkDecider(auth, await approvalSettings(tx, auth.orgId), request);
      const [decided] = await tx.db
        .update(approvalRequests)
        .set({
          status: 'rejected',
          decidedBy: auth.userId,
          decisionNote: note ?? null,
          decidedAt: new Date(),
        })
        .where(eq(approvalRequests.id, request.id))
        .returning();
      await audit(tx, {
        orgId: auth.orgId,
        actorId: auth.userId,
        action: 'survey.approval_rejected',
        entityType: 'survey',
        entityId: survey.id,
        metadata: { approvalRequestId: request.id },
        ip: req.ip,
      });
      await notifyUsers(deps, tx, {
        orgId: auth.orgId,
        userIds: [request.requestedBy],
        kind: 'approval_decided',
        title: `Changes to "${survey.title}" were not approved`,
        body: note ? `Note from the approver: ${note}` : 'Talk to the approver, then ask again.',
        link: `/surveys/${survey.id}/edit`,
        surveyId: survey.id,
        channels: ['in_app', 'email'],
      });
      return toApprovalRequest(tx, auth, decided!);
    });
  });

  /** The requester (or an admin) withdraws a waiting request. */
  app.post<IdParams>('/api/v1/approval-requests/:id/cancel', async (req) => {
    const auth = requireOrg(req);
    return withTenant(pool, auth.orgId, async (tx) => {
      const { request, survey } = await loadRequest(tx, auth, req.params.id);
      if (request.requestedBy !== auth.userId && auth.orgRole !== 'org_admin') throw forbidden();
      if (request.status !== 'pending')
        throw conflict('not_pending', `This request is already ${request.status}.`);
      const [cancelled] = await tx.db
        .update(approvalRequests)
        .set({ status: 'cancelled', decidedAt: new Date() })
        .where(eq(approvalRequests.id, request.id))
        .returning();
      await audit(tx, {
        orgId: auth.orgId,
        actorId: auth.userId,
        action: 'survey.approval_cancelled',
        entityType: 'survey',
        entityId: survey.id,
        metadata: { approvalRequestId: request.id },
        ip: req.ip,
      });
      return toApprovalRequest(tx, auth, cancelled!);
    });
  });
}
