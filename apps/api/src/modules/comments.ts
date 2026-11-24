/**
 * Comments on drafts (Phase 3A). Anyone who can view a survey can read and add comments, anchored to a
 * question or page key or to the survey as a whole, and reply in one-level threads. The author or an
 * editor resolves a thread. Comments live in their own table and never reach respondents.
 */
import { asc, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { CreateCommentRequest, UpdateCommentRequest, type Comment } from '@survey/contracts';
import { listQuestions, type SurveyDefinition } from '@survey/core';
import { comments, newId, surveyVersions, users, withTenant, type Tx } from '@survey/db';
import type { Deps } from '../deps';
import { audit } from '../audit';
import { requireOrg } from '../auth/context';
import type { OrgAuth } from '../auth/session';
import { surveyCan } from '../auth/permissions';
import { forbidden, notFound, unprocessable } from '../lib/errors';
import { parse } from '../lib/validate';
import { findDraft, loadSurvey } from './surveys';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
type CommentRow = typeof comments.$inferSelect;

async function listComments(tx: Tx, auth: OrgAuth, surveyId: string, onlyId?: string): Promise<Comment[]> {
  const rows = await tx.db
    .select({ c: comments, authorName: users.name })
    .from(comments)
    .leftJoin(users, eq(users.id, comments.authorId))
    .where(onlyId ? eq(comments.id, onlyId) : eq(comments.surveyId, surveyId))
    .orderBy(asc(comments.createdAt));
  return rows.map(({ c, authorName }) => ({
    id: c.id,
    anchorKey: c.anchorKey,
    parentId: c.parentId,
    author: c.authorId ? { id: c.authorId, name: authorName ?? 'Former member' } : null,
    body: c.body,
    createdAt: c.createdAt.toISOString(),
    editedAt: c.editedAt?.toISOString() ?? null,
    resolvedAt: c.resolvedAt?.toISOString() ?? null,
    resolvedBy: c.resolvedBy,
    mine: c.authorId === auth.userId,
  }));
}

/** Keys that exist in the draft (or, without one, the published version): pages and questions. */
async function anchorKeys(tx: Tx, surveyId: string, currentVersionId: string | null): Promise<Set<string>> {
  let definition: SurveyDefinition | null = (await findDraft(tx, surveyId))?.definition ?? null;
  if (!definition && currentVersionId) {
    const [current] = await tx.db
      .select({ definition: surveyVersions.definition })
      .from(surveyVersions)
      .where(eq(surveyVersions.id, currentVersionId));
    definition = current?.definition ?? null;
  }
  if (!definition) return new Set();
  return new Set([...definition.pages.map((p) => p.key), ...listQuestions(definition).map((q) => q.key)]);
}

export function registerCommentRoutes(app: FastifyInstance, deps: Deps): void {
  const { pool } = deps;
  type Params = { Params: { id: string; commentId: string } };

  app.get<{ Params: { id: string } }>('/api/v1/surveys/:id/comments', async (req) => {
    const auth = requireOrg(req);
    return withTenant(pool, auth.orgId, async (tx) => {
      const { survey } = await loadSurvey(tx, auth, req.params.id, 'survey.view');
      return listComments(tx, auth, survey.id);
    });
  });

  app.post<{ Params: { id: string } }>('/api/v1/surveys/:id/comments', async (req, reply) => {
    const auth = requireOrg(req);
    const body = parse(CreateCommentRequest, req.body);
    const comment = await withTenant(pool, auth.orgId, async (tx) => {
      const { survey } = await loadSurvey(tx, auth, req.params.id, 'survey.view');
      let anchorKey = body.anchorKey ?? null;
      let parentId: string | null = null;
      if (body.parentId) {
        const [parent] = await tx.db.select().from(comments).where(eq(comments.id, body.parentId));
        if (!parent || parent.surveyId !== survey.id)
          throw unprocessable('invalid_parent', 'That comment no longer exists.');
        // Replies attach to the first comment of the thread and share its anchor.
        parentId = parent.parentId ?? parent.id;
        anchorKey = parent.anchorKey;
      } else if (anchorKey && !(await anchorKeys(tx, survey.id, survey.currentVersionId)).has(anchorKey)) {
        throw unprocessable('invalid_anchor', "That question or page isn't in the survey.");
      }
      const id = newId();
      await tx.db
        .insert(comments)
        .values({
          id,
          orgId: auth.orgId,
          surveyId: survey.id,
          anchorKey,
          parentId,
          authorId: auth.userId,
          body: body.body,
        });
      await audit(tx, {
        orgId: auth.orgId,
        actorId: auth.userId,
        action: 'survey.commented',
        entityType: 'survey',
        entityId: survey.id,
        metadata: { commentId: id, anchorKey },
        ip: req.ip,
      });
      return (await listComments(tx, auth, survey.id, id))[0]!;
    });
    reply.code(201);
    return comment;
  });

  async function loadComment(tx: Tx, surveyId: string, commentId: string): Promise<CommentRow> {
    if (!UUID.test(commentId)) throw notFound('Comment');
    const [row] = await tx.db.select().from(comments).where(eq(comments.id, commentId));
    if (!row || row.surveyId !== surveyId) throw notFound('Comment');
    return row;
  }

  app.patch<Params>('/api/v1/surveys/:id/comments/:commentId', async (req) => {
    const auth = requireOrg(req);
    const body = parse(UpdateCommentRequest, req.body);
    return withTenant(pool, auth.orgId, async (tx) => {
      const { survey, role } = await loadSurvey(tx, auth, req.params.id, 'survey.view');
      const comment = await loadComment(tx, survey.id, req.params.commentId);
      const isAuthor = comment.authorId === auth.userId;
      if (body.body !== undefined && !isAuthor) throw forbidden('Only the author can edit a comment.');
      if (body.resolved !== undefined && !isAuthor && !surveyCan(role, 'survey.edit'))
        throw forbidden('Only the author or an editor can resolve a comment.');
      // Resolving applies to the whole thread, through its first comment.
      const threadId = comment.parentId ?? comment.id;
      if (body.body !== undefined)
        await tx.db
          .update(comments)
          .set({ body: body.body, editedAt: new Date() })
          .where(eq(comments.id, comment.id));
      if (body.resolved !== undefined)
        await tx.db
          .update(comments)
          .set(
            body.resolved
              ? { resolvedAt: new Date(), resolvedBy: auth.userId }
              : { resolvedAt: null, resolvedBy: null },
          )
          .where(eq(comments.id, threadId));
      if (body.resolved !== undefined)
        await audit(tx, {
          orgId: auth.orgId,
          actorId: auth.userId,
          action: body.resolved ? 'survey.comment_resolved' : 'survey.comment_reopened',
          entityType: 'survey',
          entityId: survey.id,
          metadata: { commentId: threadId },
          ip: req.ip,
        });
      return (await listComments(tx, auth, survey.id, comment.id))[0]!;
    });
  });

  app.delete<Params>('/api/v1/surveys/:id/comments/:commentId', async (req, reply) => {
    const auth = requireOrg(req);
    await withTenant(pool, auth.orgId, async (tx) => {
      const { survey, role } = await loadSurvey(tx, auth, req.params.id, 'survey.view');
      const comment = await loadComment(tx, survey.id, req.params.commentId);
      if (comment.authorId !== auth.userId && role !== 'owner')
        throw forbidden('Only the author or the survey owner can delete a comment.');
      await tx.db.delete(comments).where(eq(comments.id, comment.id));
      await audit(tx, {
        orgId: auth.orgId,
        actorId: auth.userId,
        action: 'survey.comment_deleted',
        entityType: 'survey',
        entityId: survey.id,
        metadata: { commentId: comment.id },
        ip: req.ip,
      });
    });
    return reply.code(204).send();
  });
}
