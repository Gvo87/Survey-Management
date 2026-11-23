/**
 * Public respondent API (/r/v1). Protocol (docs/03-api-design.md §3.6):
 * - The browser generates a secret response key; the server stores only its SHA-256.
 *   The key is the idempotency key, the resume credential and the authorization for later calls.
 * - Every save carries the full answer snapshot and a `seq`; stale or replayed saves are ignored.
 * - Completion re-validates everything server-side with @survey/core.
 */
import { and, eq } from 'drizzle-orm';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import {
  SaveResponseRequest,
  type CompleteResult,
  type RespondentSurvey,
  type ResumeState,
  type SaveResponseResult,
} from '@survey/contracts';
import {
  checkCompletion,
  listQuestions,
  pageIndex,
  validatePartialAnswers,
  findQuestion,
  type AnswerValue,
  type SurveyDefinition,
} from '@survey/core';
import {
  answers as answersTable,
  distributions,
  fromCells,
  newId,
  responses,
  sha256,
  surveys,
  surveyVersions,
  toCells,
  withGlobal,
  withTenant,
  type AnswerCell,
  type Tx,
} from '@survey/db';
import type { Deps } from '../deps';
import { rateLimit } from '../infra/rate-limit';
import { conflict, gone, notFound, unprocessable } from '../lib/errors';
import { deviceType, toHour } from '../lib/misc';
import { ipHash, safeEqual, testTokenFor } from '../lib/security';
import { parse } from '../lib/validate';
import { effectiveStatus } from './surveys';

type SurveyRow = typeof surveys.$inferSelect;
type ResponseRow = typeof responses.$inferSelect;

const PUBLIC_ID = /^[A-Za-z0-9]{6,20}$/;
const RESPONSE_KEY = /^[A-Za-z0-9_-]{22,128}$/;
/** Respondents who started before a survey closed may finish within this window (open question Q7). */
const GRACE_MS = 24 * 3600 * 1000;

interface Access {
  open: boolean;
  code: 'survey_closed' | 'quota_reached' | 'link_disabled';
  message: string;
  closedAt: Date | null;
}

function accessFor(survey: SurveyRow): Access {
  const closed = (code: Access['code'], message: string, closedAt: Date | null): Access => ({
    open: false,
    code,
    message,
    closedAt,
  });
  if (survey.status === 'archived')
    return closed('survey_closed', 'This survey is no longer accepting responses.', null);
  const { status, reason } = effectiveStatus(survey);
  if (status === 'closed') {
    const closedAt = survey.closedAt ?? (survey.access.closesAt ? new Date(survey.access.closesAt) : null);
    return reason === 'quota'
      ? closed(
          'quota_reached',
          'This survey has received all the responses it needs. Thank you for your interest.',
          closedAt,
        )
      : closed('survey_closed', 'This survey is closed.', closedAt);
  }
  if (survey.access.quota !== null && survey.completedCount >= survey.access.quota)
    return closed(
      'quota_reached',
      'This survey has received all the responses it needs. Thank you for your interest.',
      survey.closedAt ?? new Date(),
    );
  return { open: true, code: 'survey_closed', message: '', closedAt: null };
}

/** An in-progress respondent may keep going for a while after the survey closes. */
function canContinue(survey: SurveyRow, access: Access): boolean {
  if (access.open) return true;
  if (survey.status === 'archived' || !access.closedAt) return false;
  return Date.now() - access.closedAt.getTime() < GRACE_MS;
}

function responseKeyHash(req: FastifyRequest, required: true): Buffer;
function responseKeyHash(req: FastifyRequest, required: false): Buffer | null;
function responseKeyHash(req: FastifyRequest, required: boolean): Buffer | null {
  const key = req.headers['x-response-key'];
  if (typeof key === 'string' && RESPONSE_KEY.test(key)) return sha256(key);
  if (required) throw unprocessable('invalid_response_key', 'Missing or malformed X-Response-Key header.');
  return null;
}

async function resolveSurvey(deps: Deps, publicId: string): Promise<{ orgId: string; surveyId: string }> {
  if (!PUBLIC_ID.test(publicId)) throw notFound('Survey');
  const { rows } = await withGlobal(deps.pool, (tx) =>
    tx.client.query<{ org_id: string; survey_id: string }>('select * from resolve_public_survey($1)', [
      publicId,
    ]),
  );
  if (!rows[0]) throw notFound('Survey');
  return { orgId: rows[0].org_id, surveyId: rows[0].survey_id };
}

/** Published definitions are immutable, so they can be cached forever. */
async function loadDefinition(deps: Deps, tx: Tx, versionId: string): Promise<SurveyDefinition> {
  const cacheKey = `def:v1:${versionId}`;
  const cached = await deps.redis.get(cacheKey).catch(() => null);
  if (cached) return JSON.parse(cached) as SurveyDefinition;
  const [row] = await tx.db
    .select({ definition: surveyVersions.definition })
    .from(surveyVersions)
    .where(and(eq(surveyVersions.id, versionId), eq(surveyVersions.status, 'published')));
  if (!row) throw notFound('Survey version');
  await deps.redis.set(cacheKey, JSON.stringify(row.definition), 'EX', 7 * 86400).catch(() => {});
  return row.definition;
}

async function loadAnswerValues(tx: Tx, definition: SurveyDefinition, response: ResponseRow) {
  const rows = await tx.db
    .select()
    .from(answersTable)
    .where(and(eq(answersTable.surveyId, response.surveyId), eq(answersTable.responseId, response.id)));
  const values: Record<string, AnswerValue> = {};
  for (const question of listQuestions(definition)) {
    const cells = rows.filter((r) => r.questionKey === question.key) as AnswerCell[];
    const value = cells.length ? fromCells(question, cells) : null;
    if (value !== null) values[question.key] = value;
  }
  return values;
}

async function replaceAnswers(
  tx: Tx,
  response: ResponseRow,
  definition: SurveyDefinition,
  values: Record<string, AnswerValue>,
): Promise<void> {
  await tx.db
    .delete(answersTable)
    .where(and(eq(answersTable.surveyId, response.surveyId), eq(answersTable.responseId, response.id)));
  const rows = Object.entries(values).flatMap(([key, value]) => {
    const question = findQuestion(definition, key);
    return question ? toCells(question, value) : [];
  });
  if (rows.length === 0) return;
  await tx.db.insert(answersTable).values(
    rows.map((cell) => ({
      orgId: response.orgId,
      surveyId: response.surveyId,
      responseId: response.id,
      questionKey: cell.questionKey,
      subKey: cell.subKey,
      valueText: cell.valueText,
      valueNumber: cell.valueNumber,
      valueChoices: cell.valueChoices,
      valueDate: cell.valueDate,
      valueJson: cell.valueJson ?? null,
      otherText: cell.otherText,
    })),
  );
}

/** Keep only declared hidden fields (and only non-identifying ones when anonymous). */
function filterHiddenFields(
  def: SurveyDefinition,
  provided: Record<string, string> = {},
  preset: Record<string, string> = {},
  anonymous: boolean,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const field of def.hiddenFields) {
    if (anonymous && !field.nonIdentifying) continue;
    // Link presets win over URL params, so attribution can't be overridden by editing the URL.
    const value = preset[field.key] ?? provided[field.key];
    if (typeof value === 'string' && value !== '') out[field.key] = value.slice(0, 500);
  }
  if (!anonymous) for (const [k, v] of Object.entries(preset)) if (!(k in out)) out[k] = v;
  return out;
}

function toResume(response: ResponseRow, answers: Record<string, AnswerValue>): ResumeState {
  return {
    versionId: response.versionId,
    status: response.status,
    currentPageKey: response.currentPageKey,
    seq: response.seq,
    answers,
  };
}

export function registerRespondentRoutes(app: FastifyInstance, deps: Deps): void {
  const { pool, redis, config } = deps;
  type Params = { Params: { publicId: string } };

  app.get<Params & { Querystring: { d?: string } }>(
    '/r/v1/s/:publicId',
    async (req, reply): Promise<RespondentSurvey> => {
      reply.header('cache-control', 'no-store');
      const { orgId, surveyId } = await resolveSurvey(deps, req.params.publicId);
      const keyHash = responseKeyHash(req, false);
      return withTenant(pool, orgId, async (tx) => {
        const [survey] = await tx.db.select().from(surveys).where(eq(surveys.id, surveyId));
        if (!survey?.currentVersionId) throw notFound('Survey');

        let resume: ResumeState | null = null;
        let versionId = survey.currentVersionId;
        if (keyHash) {
          const [existing] = await tx.db
            .select()
            .from(responses)
            .where(and(eq(responses.surveyId, survey.id), eq(responses.responseKeyHash, keyHash)));
          if (existing) {
            versionId = existing.versionId;
            const definition = await loadDefinition(deps, tx, existing.versionId);
            resume = toResume(
              existing,
              existing.status === 'in_progress' ? await loadAnswerValues(tx, definition, existing) : {},
            );
          }
        }

        let access = accessFor(survey);
        if (access.open && !resume) {
          const token = typeof req.query.d === 'string' ? req.query.d.slice(0, 64) : null;
          const [link] = await tx.db
            .select()
            .from(distributions)
            .where(
              token
                ? and(eq(distributions.surveyId, survey.id), eq(distributions.token, token))
                : and(eq(distributions.surveyId, survey.id), eq(distributions.isDefault, true)),
            );
          if (!link || link.disabledAt)
            access = {
              open: false,
              code: 'link_disabled',
              message: 'This link is no longer active.',
              closedAt: null,
            };
        }
        const open = resume?.status === 'in_progress' ? canContinue(survey, access) : access.open;
        return {
          survey: {
            publicId: survey.publicId,
            title: survey.title,
            anonymous: survey.anonymous,
            onePerBrowser: survey.access.onePerBrowser,
          },
          access:
            open || resume?.status === 'completed'
              ? { state: 'open' }
              : { state: 'closed', message: access.message },
          version:
            open || resume ? { id: versionId, definition: await loadDefinition(deps, tx, versionId) } : null,
          resume,
        };
      });
    },
  );

  app.get<Params>('/r/v1/s/:publicId/response', async (req, reply): Promise<ResumeState> => {
    reply.header('cache-control', 'no-store');
    const keyHash = responseKeyHash(req, true);
    const { orgId, surveyId } = await resolveSurvey(deps, req.params.publicId);
    return withTenant(pool, orgId, async (tx) => {
      const [response] = await tx.db
        .select()
        .from(responses)
        .where(and(eq(responses.surveyId, surveyId), eq(responses.responseKeyHash, keyHash)));
      if (!response) throw notFound('Response');
      const definition = await loadDefinition(deps, tx, response.versionId);
      return toResume(
        response,
        response.status === 'in_progress' ? await loadAnswerValues(tx, definition, response) : {},
      );
    });
  });

  /**
   * Apply a save (creating the response on first contact). Returns null if the honeypot fired.
   * Runs in its own transaction so a later failed completion never loses saved answers.
   */
  async function applySave(req: FastifyRequest<Params>) {
    const body = parse(SaveResponseRequest, req.body);
    const keyHash = responseKeyHash(req, true);
    const { orgId, surveyId } = await resolveSurvey(deps, req.params.publicId);
    if (body.hp) return { orgId, surveyId, body, keyHash, honeypot: true as const };
    await rateLimit(redis, `resp:save:${keyHash.toString('hex')}`, 120, 60);

    const outcome = await withTenant(pool, orgId, async (tx) => {
      const [survey] = await tx.db.select().from(surveys).where(eq(surveys.id, surveyId));
      if (!survey?.currentVersionId) throw notFound('Survey');
      const access = accessFor(survey);
      let [response] = await tx.db
        .select()
        .from(responses)
        .where(and(eq(responses.surveyId, surveyId), eq(responses.responseKeyHash, keyHash)))
        .for('update');

      if (!response) {
        const start = body.start;
        if (!start) throw conflict('not_started', 'This response has not been started.');
        if (!access.open) throw gone(access.code, access.message);
        const [link] = await tx.db
          .select()
          .from(distributions)
          .where(
            start.distributionToken
              ? and(eq(distributions.surveyId, surveyId), eq(distributions.token, start.distributionToken))
              : and(eq(distributions.surveyId, surveyId), eq(distributions.isDefault, true)),
          );
        if (!link || link.disabledAt) throw gone('link_disabled', 'This link is no longer active.');
        if (start.versionId !== survey.currentVersionId)
          throw conflict('version_changed', 'This survey was just updated. Reload the page to continue.');
        await rateLimit(redis, `resp:new:${surveyId}:${ipHash(config.sessionSecret, req.ip)}`, 20, 60);

        const definition = await loadDefinition(deps, tx, start.versionId);
        const now = new Date();
        const startedAt = survey.anonymous ? toHour(now) : now;
        if (survey.anonymous)
          await redis
            .set(`resp:start:${keyHash.toString('hex')}`, String(now.getTime()), 'EX', 30 * 86400)
            .catch(() => {});
        [response] = await tx.db
          .insert(responses)
          .values({
            id: newId(),
            orgId,
            surveyId,
            versionId: start.versionId,
            distributionId: link.id,
            responseKeyHash: keyHash,
            status: 'in_progress',
            isTest: Boolean(
              start.testToken && safeEqual(start.testToken, testTokenFor(config.sessionSecret, surveyId)),
            ),
            locale: start.locale,
            hiddenFields: filterHiddenFields(
              definition,
              start.hiddenFields,
              link.presetHiddenFields,
              survey.anonymous,
            ),
            deviceType: deviceType(req.headers['user-agent']),
            startedAt,
            lastActivityAt: startedAt,
          })
          .returning();
      } else if (response.status === 'in_progress' && !canContinue(survey, access)) {
        throw gone(access.code, access.message);
      }

      const row = response!;
      const definition = await loadDefinition(deps, tx, row.versionId);
      if (row.status !== 'in_progress' || body.seq <= row.seq)
        return { survey, response: row, definition, applied: false };

      const provided = Object.fromEntries(Object.entries(body.answers).filter(([, v]) => v !== null));
      const { answers, errors } = validatePartialAnswers(definition, provided);
      if (errors.length)
        throw unprocessable(
          'validation_failed',
          'Some answers are invalid.',
          errors.map((e) => ({ path: e.questionKey, code: e.code, message: e.message, pageKey: e.pageKey })),
        );
      await replaceAnswers(tx, row, definition, answers);

      const currentIndex = pageIndex(definition, body.currentPageKey);
      const furthestIndex = Math.max(
        currentIndex,
        row.furthestPageKey ? pageIndex(definition, row.furthestPageKey) : -1,
      );
      const lastAnswered = listQuestions(definition)
        .filter((q) => q.key in answers)
        .at(-1);
      const now = new Date();
      const [updated] = await tx.db
        .update(responses)
        .set({
          seq: body.seq,
          currentPageKey: currentIndex >= 0 ? body.currentPageKey : row.currentPageKey,
          furthestPageKey: furthestIndex >= 0 ? definition.pages[furthestIndex]!.key : null,
          lastQuestionKey: lastAnswered?.key ?? null,
          lastActivityAt: survey.anonymous ? toHour(now) : now,
        })
        .where(eq(responses.id, row.id))
        .returning();
      return { survey, response: updated!, definition, applied: true };
    });
    return { orgId, surveyId, body, keyHash, honeypot: false as const, ...outcome };
  }

  app.put<Params>('/r/v1/s/:publicId/response', async (req): Promise<SaveResponseResult> => {
    const result = await applySave(req);
    if (result.honeypot) return { applied: true, seq: result.body.seq };
    if (result.response.status !== 'in_progress')
      throw conflict('already_completed', 'This response has already been submitted.');
    return { applied: result.applied, seq: result.response.seq };
  });

  app.post<Params>('/r/v1/s/:publicId/response/complete', async (req): Promise<CompleteResult> => {
    const saved = await applySave(req);
    if (saved.honeypot) {
      // Look like success, store nothing.
      return {
        responseStatus: 'completed',
        thankYou: { title: 'Thank you!', body: 'Your response has been recorded.' },
      };
    }
    const { definition } = saved;
    const thankYou = definition.settings.thankYou;
    if (saved.response.status !== 'in_progress')
      return { responseStatus: saved.response.status as 'completed', thankYou };

    return withTenant(pool, saved.orgId, async (tx) => {
      const [response] = await tx.db
        .select()
        .from(responses)
        .where(and(eq(responses.id, saved.response.id)))
        .for('update');
      if (!response) throw notFound('Response');
      if (response.status !== 'in_progress')
        return { responseStatus: response.status as 'completed', thankYou };

      const stored = await loadAnswerValues(tx, definition, response);
      const result = checkCompletion(definition, stored);
      if (!result.ok)
        throw unprocessable(
          'validation_failed',
          'Some questions need an answer before you can submit.',
          result.errors.map((e) => ({
            path: e.questionKey,
            code: e.code,
            message: e.message,
            pageKey: e.pageKey,
          })),
        );
      await replaceAnswers(tx, response, definition, result.answers);

      const survey = saved.survey;
      const now = new Date();
      let durationMs: number | null = now.getTime() - response.startedAt.getTime();
      if (survey.anonymous) {
        const key = `resp:start:${saved.keyHash.toString('hex')}`;
        const start = await redis.get(key).catch(() => null);
        durationMs = start ? now.getTime() - Number(start) : null;
        await redis.del(key).catch(() => {});
      }
      const lastPage = definition.pages.at(-1)!.key;
      await tx.db
        .update(responses)
        .set({
          status: 'completed',
          completedAt: survey.anonymous ? toHour(now) : now,
          lastActivityAt: survey.anonymous ? toHour(now) : now,
          durationMs,
          currentPageKey: lastPage,
          furthestPageKey: lastPage,
        })
        .where(eq(responses.id, response.id));

      if (!response.isTest) {
        const { rows } = await tx.client.query<{
          completed_count: number;
          quota: number | null;
          status: string;
        }>(
          `update surveys set completed_count = completed_count + 1
            where id = $1
            returning completed_count, (access->>'quota')::int as quota, status`,
          [survey.id],
        );
        const counts = rows[0]!;
        if (counts.status === 'live' && counts.quota !== null && counts.completed_count >= counts.quota) {
          await tx.db
            .update(surveys)
            .set({ status: 'closed', closedReason: 'quota', closedAt: now, updatedAt: now })
            .where(eq(surveys.id, survey.id));
        }
        await deps.jobs.enqueue(tx, 'aggregates.response-completed', {
          orgId: saved.orgId,
          surveyId: survey.id,
          responseId: response.id,
        });
      }
      return { responseStatus: 'completed', thankYou };
    });
  });
}
