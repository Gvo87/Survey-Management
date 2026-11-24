/**
 * Response viewer tools (Phase 2B): tags, notes and bulk delete.
 *
 * Anyone who can view responses can tag and annotate them (analysts included). Deleting tags or
 * responses needs `responses.delete`. A bulk delete must name the count the user confirmed, is
 * audited with its selection, and rebuilds the survey's aggregates in the same transaction.
 */
import { and, eq, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { BulkDeleteRequest, CreateNoteRequest, CreateTagRequest, type BulkDeleteResult, type Tag } from '@survey/contracts';
import { newId, responseNotes, responses, responseTags, tags, withTenant, type Tx } from '@survey/db';
import type { Deps } from '../deps';
import { audit } from '../audit';
import { requireOrg } from '../auth/context';
import { conflict, forbidden, notFound } from '../lib/errors';
import { parse } from '../lib/validate';
import { deleteSurveyResponses } from '../lib/response-deletion';
import { loadSurvey } from './surveys';
import { Params, questionIndex, loadVersions, responseConditions } from './results';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function listTags(tx: Tx, surveyId: string): Promise<Tag[]> {
  const { rows } = await tx.client.query<{ id: string; name: string; n: number }>(
    `select t.id, t.name, (select count(*)::int from response_tags rt where rt.tag_id = t.id) as n
       from tags t where t.survey_id = $1 order by lower(t.name)`,
    [surveyId],
  );
  return rows.map((r) => ({ id: r.id, name: r.name, responseCount: r.n }));
}

export function registerResponseToolRoutes(app: FastifyInstance, deps: Deps): void {
  const { pool } = deps;
  type SurveyParams = { Params: { id: string } };
  type ResponseParams = { Params: { id: string; responseId: string } };

  async function loadResponse(tx: Tx, surveyId: string, responseId: string) {
    if (!UUID.test(responseId)) throw notFound('Response');
    const [row] = await tx.db
      .select({ id: responses.id })
      .from(responses)
      .where(and(eq(responses.id, responseId), eq(responses.surveyId, surveyId)));
    if (!row) throw notFound('Response');
    return row;
  }

  // ── Tags ──────────────────────────────────────────────────────────────
  app.get<SurveyParams>('/api/v1/surveys/:id/tags', async (req) => {
    const auth = requireOrg(req);
    return withTenant(pool, auth.orgId, async (tx) => {
      const { survey } = await loadSurvey(tx, auth, req.params.id, 'responses.view');
      return listTags(tx, survey.id);
    });
  });

  app.post<SurveyParams>('/api/v1/surveys/:id/tags', async (req, reply) => {
    const auth = requireOrg(req);
    const { name } = parse(CreateTagRequest, req.body);
    const tag = await withTenant(pool, auth.orgId, async (tx) => {
      const { survey } = await loadSurvey(tx, auth, req.params.id, 'responses.view');
      const [existing] = await tx.db
        .select()
        .from(tags)
        .where(and(eq(tags.surveyId, survey.id), sql`lower(${tags.name}) = lower(${name})`));
      if (existing) return { id: existing.id, name: existing.name, responseCount: 0, existed: true };
      if ((await listTags(tx, survey.id)).length >= 100) throw conflict('too_many_tags', 'A survey can have at most 100 tags.');
      const id = newId();
      await tx.db.insert(tags).values({ id, orgId: auth.orgId, surveyId: survey.id, name });
      return { id, name, responseCount: 0, existed: false };
    });
    reply.code(tag.existed ? 200 : 201);
    return { id: tag.id, name: tag.name, responseCount: tag.responseCount };
  });

  app.delete<{ Params: { id: string; tagId: string } }>('/api/v1/surveys/:id/tags/:tagId', async (req, reply) => {
    const auth = requireOrg(req);
    if (!UUID.test(req.params.tagId)) throw notFound('Tag');
    await withTenant(pool, auth.orgId, async (tx) => {
      const { survey } = await loadSurvey(tx, auth, req.params.id, 'responses.delete');
      const [row] = await tx.db
        .delete(tags)
        .where(and(eq(tags.id, req.params.tagId), eq(tags.surveyId, survey.id)))
        .returning({ id: tags.id });
      if (!row) throw notFound('Tag');
    });
    return reply.code(204).send();
  });

  for (const method of ['put', 'delete'] as const) {
    app[method]<{ Params: { id: string; responseId: string; tagId: string } }>(
      '/api/v1/surveys/:id/responses/:responseId/tags/:tagId',
      async (req, reply) => {
        const auth = requireOrg(req);
        if (!UUID.test(req.params.tagId)) throw notFound('Tag');
        await withTenant(pool, auth.orgId, async (tx) => {
          const { survey } = await loadSurvey(tx, auth, req.params.id, 'responses.view');
          const response = await loadResponse(tx, survey.id, req.params.responseId);
          const [tag] = await tx.db.select({ id: tags.id }).from(tags).where(and(eq(tags.id, req.params.tagId), eq(tags.surveyId, survey.id)));
          if (!tag) throw notFound('Tag');
          if (method === 'put')
            await tx.db.insert(responseTags).values({ orgId: auth.orgId, responseId: response.id, tagId: tag.id }).onConflictDoNothing();
          else await tx.db.delete(responseTags).where(and(eq(responseTags.responseId, response.id), eq(responseTags.tagId, tag.id)));
        });
        return reply.code(204).send();
      },
    );
  }

  // ── Notes ─────────────────────────────────────────────────────────────
  app.post<ResponseParams>('/api/v1/surveys/:id/responses/:responseId/notes', async (req, reply) => {
    const auth = requireOrg(req);
    const { body } = parse(CreateNoteRequest, req.body);
    const note = await withTenant(pool, auth.orgId, async (tx) => {
      const { survey } = await loadSurvey(tx, auth, req.params.id, 'responses.view');
      const response = await loadResponse(tx, survey.id, req.params.responseId);
      const id = newId();
      const [row] = await tx.db.insert(responseNotes).values({ id, orgId: auth.orgId, responseId: response.id, authorId: auth.userId, body }).returning();
      return row!;
    });
    reply.code(201);
    return { id: note.id, author: auth.name, authorId: auth.userId, body: note.body, createdAt: note.createdAt.toISOString() };
  });

  app.delete<{ Params: { id: string; responseId: string; noteId: string } }>(
    '/api/v1/surveys/:id/responses/:responseId/notes/:noteId',
    async (req, reply) => {
      const auth = requireOrg(req);
      if (!UUID.test(req.params.noteId)) throw notFound('Note');
      await withTenant(pool, auth.orgId, async (tx) => {
        const { survey } = await loadSurvey(tx, auth, req.params.id, 'responses.view');
        const response = await loadResponse(tx, survey.id, req.params.responseId);
        const [note] = await tx.db
          .select()
          .from(responseNotes)
          .where(and(eq(responseNotes.id, req.params.noteId), eq(responseNotes.responseId, response.id)));
        if (!note) throw notFound('Note');
        if (note.authorId !== auth.userId && auth.orgRole !== 'org_admin') throw forbidden('Only its author or an admin can delete a note.');
        await tx.db.delete(responseNotes).where(eq(responseNotes.id, note.id));
      });
      return reply.code(204).send();
    },
  );

  // ── Bulk delete ───────────────────────────────────────────────────────
  app.post<SurveyParams>('/api/v1/surveys/:id/responses/bulk-delete', async (req): Promise<BulkDeleteResult> => {
    const auth = requireOrg(req);
    const body = parse(BulkDeleteRequest, req.body);
    return withTenant(pool, auth.orgId, async (tx) => {
      const { survey } = await loadSurvey(tx, auth, req.params.id, 'responses.delete');
      await tx.client.query(`set local statement_timeout = '120s'`);
      const p = new Params();
      let where: string;
      if (body.ids) {
        where = `r.survey_id = ${p.add(survey.id)} and r.id = any(${p.add(body.ids)}::uuid[])`;
      } else {
        const scope = body.scope!;
        const versions = await loadVersions(tx, survey.id);
        where = responseConditions(p, survey.id, {
          includeTest: scope.includeTest,
          statuses: scope.status === 'all' ? undefined : [scope.status],
          q: scope.q,
          tag: scope.tag,
          flag: scope.flag,
          filter: scope.filter,
          questions: questionIndex(versions, survey.currentVersionId),
        });
      }
      // Lock the selection, then check it's still what the user confirmed.
      const { rows: selected } = await tx.client.query<{ id: string }>(`select r.id from responses r where ${where} for update`, p.values);
      if (selected.length !== body.expectedCount)
        throw conflict('selection_changed', `The selection now has ${selected.length} responses, not ${body.expectedCount}. Review it and try again.`, {
          count: selected.length,
        });
      const ids = selected.map((r) => r.id);
      await deleteSurveyResponses(deps, tx, survey.id, ids);
      await audit(tx, {
        orgId: auth.orgId,
        actorId: auth.userId,
        action: 'responses.bulk_deleted',
        entityType: 'survey',
        entityId: survey.id,
        metadata: { count: ids.length, selection: body.ids ? { ids: ids.length } : body.scope },
        ip: req.ip,
      });
      return { deleted: ids.length };
    });
  });
}
