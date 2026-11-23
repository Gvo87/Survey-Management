/**
 * Templates and the question bank (Phase 2A).
 * - Global templates are platform content (super admins manage them); org templates are surveys
 *   flagged `is_template`, edited in the builder like any survey but never published.
 * - Creating a survey from a template gives every page, question and option a fresh key
 *   (`remapDefinitionKeys`), and bank questions are inserted with fresh keys too.
 */
import { and, desc, eq, ilike, isNull, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import {
  BankQuery,
  CreateBankItemRequest,
  SaveAsTemplateRequest,
  type BankItem,
  type TemplateSummary,
} from '@survey/contracts';
import { bankQuestion, listQuestions, type SurveyDefinition } from '@survey/core';
import { parseDefinition, QuestionSchema } from '@survey/core/schema';
import { globalTemplates, newId, questionBankItems, surveys, surveyVersions, users, withTenant } from '@survey/db';
import type { Deps } from '../deps';
import { audit } from '../audit';
import { requireOrg, requireUser } from '../auth/context';
import { forbidden, notFound, unprocessable } from '../lib/errors';
import { parse } from '../lib/validate';
import { buildDetail, createSurveyRecords, findDraft, loadSurvey } from './surveys';
import { z } from 'zod';

const UUID = /^[0-9a-f-]{36}$/i;

export function registerTemplateRoutes(app: FastifyInstance, deps: Deps): void {
  const { pool } = deps;

  async function orgTemplateDefinition(tx: Parameters<Parameters<typeof withTenant>[2]>[0], surveyId: string): Promise<SurveyDefinition | null> {
    const [row] = await tx.db.select().from(surveys).where(and(eq(surveys.id, surveyId), eq(surveys.isTemplate, true), isNull(surveys.deletedAt)));
    if (!row) return null;
    const draft = await findDraft(tx, row.id);
    if (draft) return draft.definition;
    if (!row.currentVersionId) return null;
    const [version] = await tx.db.select().from(surveyVersions).where(eq(surveyVersions.id, row.currentVersionId));
    return version?.definition ?? null;
  }

  app.get('/api/v1/templates', async (req): Promise<TemplateSummary[]> => {
    const auth = requireOrg(req);
    return withTenant(pool, auth.orgId, async (tx) => {
      const global = await tx.db.select().from(globalTemplates).orderBy(globalTemplates.category, globalTemplates.name);
      const org = await tx.db
        .select()
        .from(surveys)
        .where(and(eq(surveys.isTemplate, true), isNull(surveys.deletedAt)))
        .orderBy(desc(surveys.updatedAt));
      const orgDefs = await Promise.all(org.map((s) => orgTemplateDefinition(tx, s.id)));
      return [
        ...org.map((s, i) => ({
          kind: 'org' as const,
          id: s.id,
          name: s.title,
          description: s.templateDescription ?? '',
          category: 'Your organization',
          questionCount: orgDefs[i] ? listQuestions(orgDefs[i]!).length : 0,
        })),
        ...global.map((t) => ({
          kind: 'global' as const,
          id: t.id,
          name: t.name,
          description: t.description,
          category: t.category,
          questionCount: listQuestions(t.definition).length,
        })),
      ];
    });
  });

  app.get<{ Params: { kind: string; id: string } }>('/api/v1/templates/:kind/:id', async (req) => {
    const auth = requireOrg(req);
    if (!UUID.test(req.params.id)) throw notFound('Template');
    return withTenant(pool, auth.orgId, async (tx) => {
      if (req.params.kind === 'global') {
        const [t] = await tx.db.select().from(globalTemplates).where(eq(globalTemplates.id, req.params.id));
        if (!t) throw notFound('Template');
        return { name: t.name, description: t.description, definition: t.definition };
      }
      const definition = await orgTemplateDefinition(tx, req.params.id);
      if (!definition) throw notFound('Template');
      const [s] = await tx.db.select().from(surveys).where(eq(surveys.id, req.params.id));
      return { name: s!.title, description: s!.templateDescription ?? '', definition };
    });
  });

  app.post<{ Params: { id: string } }>('/api/v1/surveys/:id/save-as-template', async (req, reply) => {
    const auth = requireOrg(req, 'surveys.create');
    const body = parse(SaveAsTemplateRequest, req.body);
    const detail = await withTenant(pool, auth.orgId, async (tx) => {
      const { survey } = await loadSurvey(tx, auth, req.params.id, 'survey.view');
      const draft = await findDraft(tx, survey.id);
      const [current] = survey.currentVersionId
        ? await tx.db.select().from(surveyVersions).where(eq(surveyVersions.id, survey.currentVersionId))
        : [];
      const definition = (draft ?? current)?.definition;
      if (!definition) throw unprocessable('empty_survey', 'This survey has no content to save.');
      const template = await createSurveyRecords(tx, auth, { title: body.name, definition, anonymous: survey.anonymous });
      const [updated] = await tx.db
        .update(surveys)
        .set({ isTemplate: true, templateDescription: body.description })
        .where(eq(surveys.id, template.id))
        .returning();
      await audit(tx, { orgId: auth.orgId, actorId: auth.userId, action: 'template.created', entityType: 'survey', entityId: template.id, metadata: { sourceId: survey.id }, ip: req.ip });
      return buildDetail(deps, tx, updated!, 'owner');
    });
    reply.code(201);
    return detail;
  });

  // ── Super admin: global templates ──────────────────────────────────────
  const GlobalTemplateRequest = z.object({
    name: z.string().trim().min(1).max(200),
    description: z.string().trim().max(1000).default(''),
    category: z.string().trim().min(1).max(60).default('general'),
    definition: z.unknown(),
  });

  app.post('/api/v1/admin/templates', async (req, reply) => {
    const auth = requireUser(req);
    if (!auth.isSuperAdmin) throw forbidden();
    const body = parse(GlobalTemplateRequest, req.body);
    const parsed = parseDefinition(body.definition);
    if (!parsed.ok) throw unprocessable('invalid_definition', 'The template definition is malformed.', parsed.issues);
    const id = newId();
    await withTenant(pool, null, (tx) =>
      tx.db.insert(globalTemplates).values({ id, name: body.name, description: body.description, category: body.category, definition: parsed.definition }),
    );
    reply.code(201);
    return { id };
  });

  app.delete<{ Params: { id: string } }>('/api/v1/admin/templates/:id', async (req, reply) => {
    const auth = requireUser(req);
    if (!auth.isSuperAdmin) throw forbidden();
    if (!UUID.test(req.params.id)) throw notFound('Template');
    await withTenant(pool, null, (tx) => tx.db.delete(globalTemplates).where(eq(globalTemplates.id, req.params.id)));
    return reply.code(204).send();
  });

  // ── Question bank ──────────────────────────────────────────────────────
  app.get('/api/v1/question-bank', async (req): Promise<BankItem[]> => {
    const auth = requireOrg(req);
    const { q } = parse(BankQuery, req.query);
    return withTenant(pool, auth.orgId, async (tx) => {
      const rows = await tx.db
        .select({ item: questionBankItems, by: users.name })
        .from(questionBankItems)
        .leftJoin(users, eq(users.id, questionBankItems.createdBy))
        .where(q ? ilike(sql`${questionBankItems.question}->>'title'`, `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`) : undefined)
        .orderBy(desc(questionBankItems.createdAt))
        .limit(200);
      return rows.map(({ item, by }) => ({
        id: item.id,
        question: item.question,
        tags: item.tags,
        createdBy: by,
        createdAt: item.createdAt.toISOString(),
      }));
    });
  });

  app.post('/api/v1/question-bank', async (req, reply) => {
    const auth = requireOrg(req, 'surveys.create');
    const body = parse(CreateBankItemRequest, req.body);
    const parsed = QuestionSchema.safeParse(body.question);
    if (!parsed.success) throw unprocessable('invalid_question', 'That question is malformed.');
    // Stored with fresh keys and without conditions: they'd refer to another survey's questions.
    const question = bankQuestion(parsed.data);
    const id = newId();
    await withTenant(pool, auth.orgId, async (tx) => {
      await tx.db.insert(questionBankItems).values({ id, orgId: auth.orgId, question, tags: body.tags, createdBy: auth.userId });
      await audit(tx, { orgId: auth.orgId, actorId: auth.userId, action: 'question_bank.added', entityType: 'question_bank_item', entityId: id, ip: req.ip });
    });
    reply.code(201);
    return { id, question, tags: body.tags, createdBy: auth.name, createdAt: new Date().toISOString() } satisfies BankItem;
  });

  app.delete<{ Params: { id: string } }>('/api/v1/question-bank/:id', async (req, reply) => {
    const auth = requireOrg(req, 'surveys.create');
    if (!UUID.test(req.params.id)) throw notFound('Question');
    await withTenant(pool, auth.orgId, async (tx) => {
      const [item] = await tx.db.select().from(questionBankItems).where(eq(questionBankItems.id, req.params.id));
      if (!item) throw notFound('Question');
      if (auth.orgRole !== 'org_admin' && item.createdBy !== auth.userId) throw forbidden('Only its author or an admin can remove this question.');
      await tx.db.delete(questionBankItems).where(eq(questionBankItems.id, item.id));
    });
    return reply.code(204).send();
  });
}
