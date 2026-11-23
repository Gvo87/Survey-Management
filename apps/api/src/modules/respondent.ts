/**
 * Public respondent API (/r/v1). Protocol (docs/03-api-design.md §3.6):
 * - The browser generates a secret response key; the server stores only its SHA-256.
 *   The key is the idempotency key, the resume credential and the authorization for later calls.
 * - Every save carries the full answer snapshot and a `seq`; stale or replayed saves are ignored.
 * - Completion re-validates everything server-side with @survey/core: the respondent's path
 *   through the logic decides which answers count; the rest are dropped.
 * Phase 2A adds password protection, open dates, CAPTCHA, file uploads, quality flags,
 * piped end screens, redirects and themes.
 */
import { createHash } from 'node:crypto';
import { verify as verifyPassword } from '@node-rs/argon2';
import { and, eq, inArray, ne } from 'drizzle-orm';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { fileTypeFromBuffer } from 'file-type';
import {
  SaveResponseRequest,
  UnlockRequest,
  type CompleteResult,
  type RespondentSurvey,
  type RespondentTheme,
  type ResumeState,
  type SaveResponseResult,
  type UnlockResult,
  type UploadedFile,
} from '@survey/contracts';
import {
  checkCompletion,
  completionRedirect,
  DEFAULT_THEME,
  FILE_CATEGORY_MIME,
  findQuestion,
  listQuestions,
  pageIndex,
  pipe,
  validatePartialAnswers,
  type AnswerValue,
  type Answers,
  type Question,
  type SurveyDefinition,
} from '@survey/core';
import {
  answers as answersTable,
  distributions,
  files,
  fromCells,
  newId,
  readAccess,
  responses,
  sha256,
  surveys,
  surveyVersions,
  themes,
  toCells,
  withGlobal,
  withTenant,
  type AnswerCell,
  type Tx,
} from '@survey/db';
import type { Deps } from '../deps';
import { rateLimit } from '../infra/rate-limit';
import { AppError, conflict, forbidden, gone, notFound, unprocessable } from '../lib/errors';
import { deviceType, toHour } from '../lib/misc';
import { hmac, ipHash, safeEqual, testTokenFor } from '../lib/security';
import { parse } from '../lib/validate';
import { effectiveStatus } from './surveys';

type SurveyRow = typeof surveys.$inferSelect;
type ResponseRow = typeof responses.$inferSelect;

const PUBLIC_ID = /^[A-Za-z0-9]{6,20}$/;
const RESPONSE_KEY = /^[A-Za-z0-9_-]{22,128}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Respondents who started before a survey closed may finish within this window (open question Q7). */
const GRACE_MS = 24 * 3600 * 1000;
const ACCESS_TOKEN_TTL_S = 12 * 3600;

interface Access {
  open: boolean;
  code: 'survey_closed' | 'quota_reached' | 'link_disabled' | 'not_yet_open';
  message: string;
  closedAt: Date | null;
}

function accessFor(survey: SurveyRow): Access {
  const closed = (code: Access['code'], message: string, closedAt: Date | null): Access => ({ open: false, code, message, closedAt });
  if (survey.status === 'archived') return closed('survey_closed', 'This survey is no longer accepting responses.', null);
  const access = readAccess(survey.access);
  const { status, reason } = effectiveStatus(survey);
  if (status === 'closed') {
    const closedAt = survey.closedAt ?? (access.closesAt ? new Date(access.closesAt) : null);
    return reason === 'quota'
      ? closed('quota_reached', 'This survey has received all the responses it needs. Thank you for your interest.', closedAt)
      : closed('survey_closed', 'This survey is closed.', closedAt);
  }
  if (access.quota !== null && survey.completedCount >= access.quota)
    return closed('quota_reached', 'This survey has received all the responses it needs. Thank you for your interest.', survey.closedAt ?? new Date());
  if (access.opensAt && new Date(access.opensAt).getTime() > Date.now())
    return closed('not_yet_open', "This survey isn't open yet.", null);
  return { open: true, code: 'survey_closed', message: '', closedAt: null };
}

/** An in-progress respondent may keep going for a while after the survey closes. */
function canContinue(survey: SurveyRow, access: Access): boolean {
  if (access.open) return true;
  if (survey.status === 'archived' || !access.closedAt) return false;
  return Date.now() - access.closedAt.getTime() < GRACE_MS;
}

// ── Password access tokens: stateless, expire, and die when the password changes ─────
function accessTokenFor(secret: string, survey: SurveyRow, exp: number): string {
  const fingerprint = createHash('sha256').update(readAccess(survey.access).passwordHash ?? '').digest('hex').slice(0, 16);
  return `${exp}.${hmac(secret, `unlock:${survey.id}:${exp}:${fingerprint}`).slice(0, 43)}`;
}

function hasAccessToken(req: FastifyRequest, secret: string, survey: SurveyRow): boolean {
  if (!readAccess(survey.access).passwordHash) return true;
  const token = req.headers['x-access-token'];
  if (typeof token !== 'string' || token.length > 100) return false;
  const exp = Number(token.split('.')[0]);
  return Number.isFinite(exp) && exp * 1000 > Date.now() && safeEqual(token, accessTokenFor(secret, survey, exp));
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
    tx.client.query<{ org_id: string; survey_id: string }>('select * from resolve_public_survey($1)', [publicId]),
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

/** The survey's theme, or the org default. Themes aren't versioned: edits apply to live surveys. */
export async function themeFor(tx: Tx, survey: SurveyRow): Promise<RespondentTheme | null> {
  const [row] = survey.themeId
    ? await tx.db.select().from(themes).where(eq(themes.id, survey.themeId))
    : await tx.db.select().from(themes).where(and(eq(themes.orgId, survey.orgId), eq(themes.isDefault, true)));
  if (!row) return null;
  const [logo] = row.logoFileId
    ? await tx.db.select({ status: files.scanStatus }).from(files).where(eq(files.id, row.logoFileId))
    : [];
  return {
    tokens: { ...DEFAULT_THEME, ...row.tokens },
    logoUrl: logo?.status === 'clean' ? `/r/v1/assets/${row.logoFileId}` : null,
  };
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

async function replaceAnswers(tx: Tx, response: ResponseRow, definition: SurveyDefinition, values: Answers): Promise<void> {
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

/** File answers must name files this response uploaded for that question (and not quarantined). */
async function checkFileAnswers(tx: Tx, definition: SurveyDefinition, response: ResponseRow, values: Answers): Promise<void> {
  const fileQuestions = listQuestions(definition).filter((q) => q.type === 'file_upload' && Array.isArray(values[q.key]));
  if (!fileQuestions.length) return;
  const owned = await tx.db
    .select({ id: files.id, questionKey: files.questionKey, scanStatus: files.scanStatus })
    .from(files)
    .where(and(eq(files.responseId, response.id), ne(files.scanStatus, 'infected')));
  for (const q of fileQuestions) {
    const ids = values[q.key] as string[];
    if (ids.some((id) => !owned.some((f) => f.id === id && f.questionKey === q.key)))
      throw unprocessable('invalid_file', 'One of the uploaded files is missing. Upload it again.', [
        { path: q.key, code: 'invalid_file', message: 'Upload the file again.' },
      ]);
  }
}

/** Filter hidden fields: declared only, and only non-identifying ones when anonymous. */
function filterHiddenFields(def: SurveyDefinition, provided: Record<string, string> = {}, preset: Record<string, string> = {}, anonymous: boolean) {
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

/**
 * Response-quality heuristics, computed on completion and shown (and filterable) in results:
 * - too_fast: under 1.5 seconds per answered question (with at least 3 answers)
 * - straight_lined: every row of a 4+ row matrix, or 5+ Likert answers in a row, got the same answer
 */
export function qualityFlags(definition: SurveyDefinition, answers: Answers, durationMs: number | null): string[] {
  const flags: string[] = [];
  const answered = Object.keys(answers).length;
  if (durationMs !== null && answered >= 3 && durationMs < 1500 * answered) flags.push('too_fast');
  let straight = false;
  let likertRun: string[] = [];
  for (const q of listQuestions(definition)) {
    const value = answers[q.key];
    if (q.type === 'matrix' && value && typeof value === 'object' && !Array.isArray(value) && !q.config.multiplePerRow) {
      const cells = Object.values(value as Record<string, string>);
      if (cells.length >= 4 && new Set(cells).size === 1) straight = true;
    }
    if (q.type === 'likert' && typeof value === 'string') {
      const position = String(q.options.findIndex((o) => o.key === value));
      likertRun = likertRun.length && likertRun[0] === position ? [...likertRun, position] : [position];
      if (likertRun.length >= 5) straight = true;
    } else if (q.type === 'likert') likertRun = [];
  }
  if (straight) flags.push('straight_lined');
  return flags;
}

function toResume(response: ResponseRow, answers: Record<string, AnswerValue>): ResumeState {
  return {
    versionId: response.versionId,
    status: response.status,
    currentPageKey: response.currentPageKey,
    seq: response.seq,
    answers,
    hiddenFields: response.hiddenFields,
  };
}

const FILE_LIMIT_BYTES = 25 * 1024 * 1024;
const TEXT_EXTENSIONS: Record<string, string> = { '.txt': 'text/plain', '.csv': 'text/csv' };

/** Detect a file's type from its bytes. Plain text has no signature, so it's accepted only as valid UTF-8 without NULs. */
export async function detectMime(buffer: Buffer, filename: string): Promise<string | null> {
  const detected = await fileTypeFromBuffer(buffer);
  if (detected) return detected.mime;
  const ext = filename.toLowerCase().match(/\.[a-z0-9]+$/)?.[0] ?? '';
  if (!TEXT_EXTENSIONS[ext] || buffer.includes(0)) return null;
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(buffer);
    return TEXT_EXTENSIONS[ext]!;
  } catch {
    return null;
  }
}

export function registerRespondentRoutes(app: FastifyInstance, deps: Deps): void {
  const { pool, redis, config } = deps;
  type Params = { Params: { publicId: string } };

  app.get<Params & { Querystring: { d?: string } }>('/r/v1/s/:publicId', async (req, reply): Promise<RespondentSurvey> => {
    reply.header('cache-control', 'no-store');
    const { orgId, surveyId } = await resolveSurvey(deps, req.params.publicId);
    const keyHash = responseKeyHash(req, false);
    return withTenant(pool, orgId, async (tx) => {
      const [survey] = await tx.db.select().from(surveys).where(eq(surveys.id, surveyId));
      if (!survey?.currentVersionId) throw notFound('Survey');
      const settings = readAccess(survey.access);

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
          resume = toResume(existing, existing.status === 'in_progress' ? await loadAnswerValues(tx, definition, existing) : {});
        }
      }

      let access = accessFor(survey);
      let presetHiddenFields: Record<string, string> = {};
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
        if (!link || link.disabledAt) access = { open: false, code: 'link_disabled', message: 'This link is no longer active.', closedAt: null };
        else presetHiddenFields = link.presetHiddenFields;
      }
      const open = resume?.status === 'in_progress' ? canContinue(survey, access) : access.open;
      const locked = open && !resume && !hasAccessToken(req, config.sessionSecret, survey);
      const theme = await themeFor(tx, survey);
      const base = {
        survey: { publicId: survey.publicId, title: survey.title, anonymous: survey.anonymous, onePerBrowser: settings.onePerBrowser },
        resume,
        theme,
        captchaSiteKey: settings.captcha && !resume ? deps.captcha.siteKey : null,
        presetHiddenFields,
      };
      if (access.code === 'not_yet_open' && !open)
        return { ...base, access: { state: 'not_yet_open', opensAt: settings.opensAt! }, version: null };
      if (locked) return { ...base, access: { state: 'password_required' }, version: null };
      return {
        ...base,
        access: open || resume?.status === 'completed' || resume?.status === 'disqualified' ? { state: 'open' } : { state: 'closed', message: access.message },
        version: open || resume ? { id: versionId, definition: await loadDefinition(deps, tx, versionId) } : null,
      };
    });
  });

  app.post<Params>('/r/v1/s/:publicId/unlock', async (req): Promise<UnlockResult> => {
    const { password } = parse(UnlockRequest, req.body);
    const { orgId, surveyId } = await resolveSurvey(deps, req.params.publicId);
    await rateLimit(redis, `unlock:${surveyId}:${ipHash(config.sessionSecret, req.ip)}`, 10, 300);
    const survey = await withTenant(pool, orgId, async (tx) => (await tx.db.select().from(surveys).where(eq(surveys.id, surveyId)))[0]);
    const hash = survey ? readAccess(survey.access).passwordHash : null;
    if (!survey || !hash) throw notFound('Survey');
    if (!(await verifyPassword(hash, password))) throw new AppError(401, 'wrong_password', "That password isn't right.");
    const exp = Math.floor(Date.now() / 1000) + ACCESS_TOKEN_TTL_S;
    return { accessToken: accessTokenFor(config.sessionSecret, survey, exp) };
  });

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
      return toResume(response, response.status === 'in_progress' ? await loadAnswerValues(tx, definition, response) : {});
    });
  });

  /**
   * Apply a save (creating the response on first contact). Returns `honeypot: true` if the
   * honeypot fired. Runs in its own transaction so a later failed completion never loses answers.
   */
  async function applySave(req: FastifyRequest<Params>) {
    const body = parse(SaveResponseRequest, req.body);
    const keyHash = responseKeyHash(req, true);
    const { orgId, surveyId } = await resolveSurvey(deps, req.params.publicId);
    if (body.hp) return { orgId, surveyId, body, keyHash, honeypot: true as const };
    await rateLimit(redis, `resp:save:${keyHash.toString('hex')}`, 120, 60);

    // CAPTCHA is verified before the transaction (it's a network call) and only for new responses.
    const before = await withTenant(pool, orgId, async (tx) => {
      const [survey] = await tx.db.select().from(surveys).where(eq(surveys.id, surveyId));
      const [existing] = await tx.db
        .select({ id: responses.id })
        .from(responses)
        .where(and(eq(responses.surveyId, surveyId), eq(responses.responseKeyHash, keyHash)));
      return { survey, exists: Boolean(existing) };
    });
    if (!before.survey?.currentVersionId) throw notFound('Survey');
    if (!before.exists) {
      const settings = readAccess(before.survey.access);
      if (!hasAccessToken(req, config.sessionSecret, before.survey))
        throw new AppError(401, 'password_required', 'Enter the survey password first.');
      if (settings.captcha && !(await deps.captcha.verify(body.start?.captchaToken ?? '')))
        throw forbidden('Please complete the "I am human" check and try again.', 'captcha_failed');
    }

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
        if (access.code === 'not_yet_open' && !access.open) throw forbidden(access.message, 'not_yet_open');
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
          await redis.set(`resp:start:${keyHash.toString('hex')}`, String(now.getTime()), 'EX', 30 * 86400).catch(() => {});
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
            isTest: Boolean(start.testToken && safeEqual(start.testToken, testTokenFor(config.sessionSecret, surveyId))),
            locale: start.locale,
            hiddenFields: filterHiddenFields(definition, start.hiddenFields, link.presetHiddenFields, survey.anonymous),
            deviceType: deviceType(req.headers['user-agent']),
            startedAt,
            lastActivityAt: startedAt,
          })
          .returning();
      } else if (response.status === 'in_progress' && !canContinue(survey, access)) {
        throw gone(access.code === 'not_yet_open' ? 'survey_closed' : access.code, access.message);
      }

      const row = response!;
      const definition = await loadDefinition(deps, tx, row.versionId);
      if (row.status !== 'in_progress' || body.seq <= row.seq) return { survey, response: row, definition, applied: false };

      const provided = Object.fromEntries(Object.entries(body.answers).filter(([, v]) => v !== null));
      const { answers, errors } = validatePartialAnswers(definition, provided);
      if (errors.length)
        throw unprocessable(
          'validation_failed',
          'Some answers are invalid.',
          errors.map((e) => ({ path: e.questionKey, code: e.code, message: e.message, pageKey: e.pageKey })),
        );
      await checkFileAnswers(tx, definition, row, answers);
      await replaceAnswers(tx, row, definition, answers);

      const currentIndex = pageIndex(definition, body.currentPageKey);
      const furthestIndex = Math.max(currentIndex, row.furthestPageKey ? pageIndex(definition, row.furthestPageKey) : -1);
      const lastAnswered = listQuestions(definition).filter((q) => q.key in answers).at(-1);
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
    if (result.response.status !== 'in_progress') throw conflict('already_completed', 'This response has already been submitted.');
    return { applied: result.applied, seq: result.response.seq };
  });

  /** The end screen for a finished response, with piping applied (and the redirect, if any). */
  function endScreen(definition: SurveyDefinition, response: ResponseRow, answers: Answers): CompleteResult {
    const ctx = { def: definition, answers, hidden: response.hiddenFields };
    const disqualified = response.status === 'disqualified';
    const screen = disqualified
      ? (definition.settings.disqualified ?? { title: 'Thank you for your time', body: "Unfortunately you don't qualify for this survey." })
      : definition.settings.thankYou;
    return {
      responseStatus: disqualified ? 'disqualified' : 'completed',
      thankYou: { title: pipe(screen.title, ctx), body: pipe(screen.body, ctx) },
      redirectUrl: disqualified ? null : completionRedirect(ctx),
    };
  }

  app.post<Params>('/r/v1/s/:publicId/response/complete', async (req): Promise<CompleteResult> => {
    const saved = await applySave(req);
    if (saved.honeypot) {
      // Look like success, store nothing.
      return { responseStatus: 'completed', thankYou: { title: 'Thank you!', body: 'Your response has been recorded.' }, redirectUrl: null };
    }
    const { definition } = saved;

    return withTenant(pool, saved.orgId, async (tx) => {
      const [response] = await tx.db.select().from(responses).where(eq(responses.id, saved.response.id)).for('update');
      if (!response) throw notFound('Response');
      if (response.status !== 'in_progress') return endScreen(definition, response, await loadAnswerValues(tx, definition, response));

      const stored = await loadAnswerValues(tx, definition, response);
      const result = checkCompletion(definition, stored, response.hiddenFields);
      if (!result.ok)
        throw unprocessable(
          'validation_failed',
          'Some questions need an answer before you can submit.',
          result.errors.map((e) => ({ path: e.questionKey, code: e.code, message: e.message, pageKey: e.pageKey })),
        );
      await checkFileAnswers(tx, definition, response, result.answers);
      await replaceAnswers(tx, response, definition, result.answers);
      // Files uploaded but no longer referenced (removed, or on a question the path skipped) are deleted.
      const kept = new Set(
        listQuestions(definition)
          .filter((q) => q.type === 'file_upload')
          .flatMap((q) => (result.answers[q.key] as string[] | undefined) ?? []),
      );
      const uploaded = await tx.db
        .select({ id: files.id, storageKey: files.storageKey })
        .from(files)
        .where(eq(files.responseId, response.id));
      const orphaned = uploaded.filter((f) => !kept.has(f.id));
      if (orphaned.length) {
        await tx.db.delete(files).where(inArray(files.id, orphaned.map((f) => f.id)));
        await deps.jobs.enqueue(tx, 'files.delete-objects', { keys: orphaned.map((f) => f.storageKey) });
      }

      const survey = saved.survey;
      const now = new Date();
      let durationMs: number | null = now.getTime() - response.startedAt.getTime();
      if (survey.anonymous) {
        const key = `resp:start:${saved.keyHash.toString('hex')}`;
        const start = await redis.get(key).catch(() => null);
        durationMs = start ? now.getTime() - Number(start) : null;
        await redis.del(key).catch(() => {});
      }
      const lastPage = result.path.at(-1) ?? definition.pages.at(-1)!.key;
      const [finished] = await tx.db
        .update(responses)
        .set({
          status: result.outcome,
          completedAt: survey.anonymous ? toHour(now) : now,
          lastActivityAt: survey.anonymous ? toHour(now) : now,
          durationMs,
          currentPageKey: lastPage,
          furthestPageKey: lastPage,
          qualityFlags: [...new Set([...response.qualityFlags, ...qualityFlags(definition, result.answers, durationMs)])],
        })
        .where(eq(responses.id, response.id))
        .returning();

      if (!response.isTest && result.outcome === 'completed') {
        const { rows } = await tx.client.query<{ completed_count: number; quota: number | null; status: string }>(
          `update surveys set completed_count = completed_count + 1
            where id = $1
            returning completed_count, (access->>'quota')::int as quota, status`,
          [survey.id],
        );
        const counts = rows[0]!;
        if (counts.status === 'live' && counts.quota !== null && counts.completed_count >= counts.quota) {
          await tx.db.update(surveys).set({ status: 'closed', closedReason: 'quota', closedAt: now, updatedAt: now }).where(eq(surveys.id, survey.id));
        }
        await deps.jobs.enqueue(tx, 'aggregates.response-completed', { orgId: saved.orgId, surveyId: survey.id, responseId: response.id });
      }
      return endScreen(definition, finished!, result.answers);
    });
  });

  // ── File uploads ─────────────────────────────────────────────────────────
  app.post<Params & { Querystring: { questionKey?: string } }>('/r/v1/s/:publicId/uploads', async (req, reply): Promise<UploadedFile> => {
    const keyHash = responseKeyHash(req, true);
    const { orgId, surveyId } = await resolveSurvey(deps, req.params.publicId);
    await rateLimit(redis, `upload:${keyHash.toString('hex')}`, 30, 3600);
    const questionKey = String(req.query.questionKey ?? '');

    // The response must exist (the respondent app saves before uploading) and still be open.
    const ctx = await withTenant(pool, orgId, async (tx) => {
      const [survey] = await tx.db.select().from(surveys).where(eq(surveys.id, surveyId));
      const [response] = await tx.db
        .select()
        .from(responses)
        .where(and(eq(responses.surveyId, surveyId), eq(responses.responseKeyHash, keyHash)));
      if (!survey || !response) throw conflict('not_started', 'Start the survey before uploading files.');
      if (response.status !== 'in_progress' || !canContinue(survey, accessFor(survey)))
        throw gone('survey_closed', 'This response can no longer be changed.');
      if (survey.anonymous) throw forbidden("Anonymous surveys don't accept files.", 'uploads_not_allowed');
      const definition = await loadDefinition(deps, tx, response.versionId);
      const question = findQuestion(definition, questionKey);
      if (question?.type !== 'file_upload') throw unprocessable('invalid_question', "That question doesn't accept files.");
      const existing = await tx.db
        .select({ id: files.id })
        .from(files)
        .where(and(eq(files.responseId, response.id), eq(files.questionKey, questionKey), ne(files.scanStatus, 'infected')));
      if (existing.length >= question.config.maxFiles)
        throw unprocessable('too_many_files', `You can upload at most ${question.config.maxFiles} file${question.config.maxFiles > 1 ? 's' : ''} here.`);
      return { response, question };
    });

    const limitBytes = Math.min(ctx.question.config.maxSizeMb * 1024 * 1024, FILE_LIMIT_BYTES);
    const part = await req.file({ limits: { fileSize: limitBytes, files: 1 } });
    if (!part) throw unprocessable('no_file', 'Choose a file to upload.');
    const buffer = await part.toBuffer().catch((error: { code?: string }) => {
      if (error.code === 'FST_REQ_FILE_TOO_LARGE') throw new AppError(413, 'file_too_large', `Files can be at most ${ctx.question.config.maxSizeMb} MB.`);
      throw error;
    });
    if (buffer.length === 0) throw unprocessable('empty_file', 'That file is empty.');

    const mime = await detectMime(buffer, part.filename);
    const allowed = ctx.question.config.allowedTypes.flatMap((c) => FILE_CATEGORY_MIME[c]);
    if (!mime || !allowed.includes(mime)) throw unprocessable('file_type_not_allowed', "This type of file isn't accepted here.");

    const fileId = newId();
    const storageKey = `uploads/${orgId}/${surveyId}/${fileId}`;
    const filename = part.filename.replace(/[\\/\0\r\n]/g, '_').slice(0, 200) || 'file';
    await deps.storage.put(storageKey, buffer, mime);
    await withTenant(pool, orgId, async (tx) => {
      await tx.db.insert(files).values({
        id: fileId,
        orgId,
        purpose: 'response_upload',
        surveyId,
        responseId: ctx.response.id,
        questionKey,
        storageKey,
        filename,
        mime,
        size: buffer.length,
        sha256: createHash('sha256').update(buffer).digest(),
      });
      await deps.jobs.enqueue(tx, 'files.scan', { orgId, fileId });
    });
    reply.code(201);
    return { fileId, filename, size: buffer.length, mime };
  });

  app.delete<Params & { Params: { fileId: string } }>('/r/v1/s/:publicId/uploads/:fileId', async (req, reply) => {
    const keyHash = responseKeyHash(req, true);
    const { orgId, surveyId } = await resolveSurvey(deps, req.params.publicId);
    if (!UUID.test(req.params.fileId)) throw notFound('File');
    await withTenant(pool, orgId, async (tx) => {
      const [response] = await tx.db
        .select()
        .from(responses)
        .where(and(eq(responses.surveyId, surveyId), eq(responses.responseKeyHash, keyHash)));
      if (!response || response.status !== 'in_progress') throw notFound('File');
      const [removed] = await tx.db
        .delete(files)
        .where(and(eq(files.id, req.params.fileId), eq(files.responseId, response.id)))
        .returning({ storageKey: files.storageKey });
      if (!removed) throw notFound('File');
      await deps.jobs.enqueue(tx, 'files.delete-objects', { keys: [removed.storageKey] });
    });
    return reply.code(204).send();
  });

  // ── Public theme logos ───────────────────────────────────────────────────
  app.get<{ Params: { fileId: string } }>('/r/v1/assets/:fileId', async (req, reply) => {
    if (!UUID.test(req.params.fileId)) throw notFound('Asset');
    const { rows } = await withGlobal(pool, (tx) =>
      tx.client.query<{ storage_key: string; mime: string }>('select * from public_logo($1)', [req.params.fileId]),
    );
    if (!rows[0]) throw notFound('Asset');
    reply
      .header('content-type', rows[0].mime)
      .header('cache-control', 'public, max-age=86400')
      .header('content-security-policy', "default-src 'none'; style-src 'unsafe-inline'; sandbox");
    return reply.send(await deps.storage.stream(rows[0].storage_key));
  });
}

/** Used by results/export to show who uploaded what (response ids → files). */
export async function filesForResponses(tx: Tx, responseIds: string[]) {
  if (!responseIds.length) return [];
  return tx.db.select().from(files).where(inArray(files.responseId, responseIds));
}

export type { Question };
