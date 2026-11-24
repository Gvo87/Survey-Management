/**
 * AI summaries of open-text answers (Phase 3B, roadmap §4.6):
 * - off until an org admin opts in (org settings), and unavailable without a configured provider;
 * - every summary names the provider, model and date, and how many answers it analysed;
 * - each theme links to sample answers (only ids the provider was actually sent are kept);
 * - a per-org monthly token cap is checked before calling and usage is counted after;
 * - emails and phone numbers are redacted before anything leaves the platform.
 */
import { and, desc, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { CreateInsightRequest, type AiStatus, type InsightTheme, type TextInsight } from '@survey/contracts';
import { plainTitle } from '@survey/core';
import { newId, organizations, textInsights, withTenant, type InsightTheme as StoredTheme, type Tx } from '@survey/db';
import type { Deps } from '../deps';
import { audit } from '../audit';
import { aiStatus, readAiSettings } from '../ai/status';
import { AiProviderError, estimateTokens } from '../ai/provider';
import { redactPersonalData } from '../ai/redact';
import { requireOrg } from '../auth/context';
import { AppError, forbidden, notFound, unprocessable } from '../lib/errors';
import { recordUsage } from '../lib/usage';
import { parse } from '../lib/validate';
import { loadVersions, questionIndex } from './results';
import { loadSurvey } from './surveys';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TEXT_TYPES = new Set(['short_text', 'long_text']);
const SAMPLES_PER_THEME = 5;
const MAX_THEMES = 8;

const ERROR_MESSAGES: Record<string, string> = {
  token_cap_reached: "This month's AI token allowance for your organization is used up. It resets on the 1st (UTC).",
  not_enabled: 'AI summaries were switched off for your organization.',
  unavailable: "AI summaries aren't available on this platform right now.",
  no_answers: 'There are no answers to summarise yet.',
  provider_error: "The AI provider couldn't be reached. Try again later.",
  rate_limited: 'The AI provider is busy. Try again in a few minutes.',
  timeout: 'The AI provider took too long to answer. Try again.',
  invalid_output: "The AI provider's answer couldn't be used. Try again.",
};

type InsightRow = typeof textInsights.$inferSelect;

/** Sample answer texts for each theme, from responses that still exist. */
async function toInsight(tx: Tx, row: InsightRow): Promise<TextInsight> {
  const ids = [...new Set(row.themes.flatMap((t) => t.responseIds.slice(0, SAMPLES_PER_THEME * 2)))];
  const texts = new Map<string, string>();
  if (ids.length) {
    const { rows } = await tx.client.query<{ response_id: string; value_text: string }>(
      `select response_id, value_text from answers
        where survey_id = $1 and question_key = $2 and sub_key = '' and response_id = any($3::uuid[]) and value_text is not null`,
      [row.surveyId, row.questionKey, ids],
    );
    for (const r of rows) texts.set(r.response_id, r.value_text);
  }
  const themes: InsightTheme[] = row.themes.map((t) => ({
    label: t.label,
    summary: t.summary,
    sentiment: t.sentiment,
    count: t.count,
    samples: t.responseIds
      .filter((id) => texts.has(id))
      .slice(0, SAMPLES_PER_THEME)
      .map((id) => ({ responseId: id, text: texts.get(id)!.slice(0, 500) })),
  }));
  return {
    id: row.id,
    questionKey: row.questionKey,
    status: row.status,
    error: row.errorCode ? { code: row.errorCode, message: ERROR_MESSAGES[row.errorCode] ?? 'The summary failed. Try again.' } : null,
    provider: row.provider,
    model: row.model,
    generatedAt: row.generatedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    responsesAnalysed: row.responsesAnalysed,
    responsesTotal: row.responsesTotal,
    summary: row.summary,
    themes,
    sentiment: row.sentiment,
    tokens: row.inputTokens + row.outputTokens,
  };
}

async function orgAi(deps: Deps, tx: Tx, orgId: string): Promise<AiStatus> {
  const [org] = await tx.db.select({ settings: organizations.settings }).from(organizations).where(eq(organizations.id, orgId));
  return aiStatus(deps, tx, orgId, org?.settings ?? {});
}

export function registerInsightRoutes(app: FastifyInstance, deps: Deps): void {
  const { pool } = deps;
  type Params = { Params: { id: string; insightId?: string } };

  app.get<Params>('/api/v1/surveys/:id/insights', async (req) => {
    const auth = requireOrg(req);
    return withTenant(pool, auth.orgId, async (tx) => {
      const { survey } = await loadSurvey(tx, auth, req.params.id, 'responses.view');
      const rows = await tx.db.select().from(textInsights).where(eq(textInsights.surveyId, survey.id)).orderBy(desc(textInsights.createdAt));
      // The latest summary per question.
      const latest = [...new Map(rows.reverse().map((r) => [r.questionKey, r])).values()];
      return { ai: await orgAi(deps, tx, auth.orgId), insights: await Promise.all(latest.map((r) => toInsight(tx, r))) };
    });
  });

  app.get<Params>('/api/v1/surveys/:id/insights/:insightId', async (req) => {
    const auth = requireOrg(req);
    if (!UUID.test(req.params.insightId ?? '')) throw notFound('Summary');
    return withTenant(pool, auth.orgId, async (tx) => {
      const { survey } = await loadSurvey(tx, auth, req.params.id, 'responses.view');
      const [row] = await tx.db
        .select()
        .from(textInsights)
        .where(and(eq(textInsights.id, req.params.insightId!), eq(textInsights.surveyId, survey.id)));
      if (!row) throw notFound('Summary');
      return toInsight(tx, row);
    });
  });

  app.post<Params>('/api/v1/surveys/:id/insights', async (req, reply) => {
    const auth = requireOrg(req);
    const { questionKey } = parse(CreateInsightRequest, req.body);
    const insight = await withTenant(pool, auth.orgId, async (tx) => {
      const { survey } = await loadSurvey(tx, auth, req.params.id, 'responses.view');
      const ai = await orgAi(deps, tx, auth.orgId);
      if (!ai.available) throw new AppError(503, 'ai_unavailable', ERROR_MESSAGES.unavailable!);
      if (!ai.enabled) throw forbidden('An org admin has to switch on AI summaries first (Settings → General).', 'ai_not_enabled');
      if (ai.tokensUsedThisMonth >= ai.monthlyTokenCap) throw new AppError(429, 'ai_token_cap_reached', ERROR_MESSAGES.token_cap_reached!);
      const question = questionIndex(await loadVersions(tx, survey.id), survey.currentVersionId).get(questionKey);
      if (!question || !TEXT_TYPES.has(question.type)) throw unprocessable('not_a_text_question', 'AI summaries work on short and long text questions.');
      // One at a time per question.
      const [pending] = await tx.db
        .select()
        .from(textInsights)
        .where(and(eq(textInsights.surveyId, survey.id), eq(textInsights.questionKey, questionKey), eq(textInsights.status, 'pending')));
      if (pending) return toInsight(tx, pending);
      const [row] = await tx.db
        .insert(textInsights)
        .values({ id: newId(), orgId: auth.orgId, surveyId: survey.id, questionKey, requestedBy: auth.userId })
        .returning();
      await deps.jobs.enqueue(tx, 'insights.generate', { orgId: auth.orgId, insightId: row!.id });
      await audit(tx, {
        orgId: auth.orgId,
        actorId: auth.userId,
        action: 'ai.summary_requested',
        entityType: 'survey',
        entityId: survey.id,
        metadata: { questionKey },
        ip: req.ip,
      });
      return toInsight(tx, row!);
    });
    reply.code(202);
    return insight;
  });
}

/** The worker: gather answers, redact, check the cap, call the provider, store the summary. */
export async function generateInsight(deps: Deps, orgId: string, insightId: string): Promise<void> {
  const prepared = await withTenant(deps.pool, orgId, async (tx) => {
    const [row] = await tx.db.select().from(textInsights).where(eq(textInsights.id, insightId));
    if (!row || row.status !== 'pending') return null;
    const fail = async (code: string) => {
      await tx.db.update(textInsights).set({ status: 'failed', errorCode: code }).where(eq(textInsights.id, row.id));
      return null;
    };
    if (!deps.ai) return fail('unavailable');
    const [org] = await tx.db.select({ settings: organizations.settings }).from(organizations).where(eq(organizations.id, orgId));
    if (!readAiSettings(org?.settings ?? {}).enabled) return fail('not_enabled');
    const versions = await loadVersions(tx, row.surveyId);
    const [survey] = await tx.client.query<{ current_version_id: string | null }>('select current_version_id from surveys where id = $1', [row.surveyId]).then((r) => r.rows);
    const question = questionIndex(versions, survey?.current_version_id ?? null).get(row.questionKey);
    if (!question) return fail('no_answers');
    const { rows: answers } = await tx.client.query<{ response_id: string; value_text: string; total: number }>(
      `select a.response_id, a.value_text, count(*) over ()::int as total
         from answers a join responses r on r.id = a.response_id
        where a.survey_id = $1 and a.question_key = $2 and a.sub_key = '' and r.status = 'completed' and not r.is_test
          and btrim(coalesce(a.value_text, '')) <> ''
        order by r.completed_at desc nulls last, r.id
        limit $3`,
      [row.surveyId, row.questionKey, deps.config.ai.maxAnswers],
    );
    if (answers.length === 0) return fail('no_answers');
    const ai = await aiStatus(deps, tx, orgId, org?.settings ?? {});
    // Short ids only: neither response ids nor anything else identifying goes to the provider.
    const sent = answers.map((a, i) => ({ id: `a${i + 1}`, responseId: a.response_id, text: redactPersonalData(a.value_text.slice(0, 2000)).text }));
    const questionText = plainTitle(question);
    const estimate = estimateTokens(questionText + sent.map((s) => s.text).join('\n')) + 1500;
    if (ai.tokensUsedThisMonth + estimate > ai.monthlyTokenCap) return fail('token_cap_reached');
    return { row, sent, questionText, total: answers[0]!.total };
  });
  if (!prepared || !deps.ai) return;

  let output;
  try {
    output = await deps.ai.summarize({ question: prepared.questionText, answers: prepared.sent.map(({ id, text }) => ({ id, text })), maxThemes: MAX_THEMES });
  } catch (error) {
    const code = error instanceof AiProviderError ? error.code : 'provider_error';
    await withTenant(deps.pool, orgId, (tx) => tx.db.update(textInsights).set({ status: 'failed', errorCode: code }).where(eq(textInsights.id, insightId)));
    return;
  }

  const byShortId = new Map(prepared.sent.map((s) => [s.id, s.responseId]));
  const themes: StoredTheme[] = output.themes.slice(0, MAX_THEMES).map((t) => {
    // Ids the provider made up (or repeated) are dropped: a theme only links to answers it was sent.
    const responseIds = [...new Set(t.answerIds.map((id) => byShortId.get(id)).filter((id): id is string => Boolean(id)))];
    return { label: t.label, summary: t.summary, sentiment: t.sentiment, count: responseIds.length, responseIds: responseIds.slice(0, 50) };
  });
  const tokens = output.usage.inputTokens + output.usage.outputTokens;
  await withTenant(deps.pool, orgId, async (tx) => {
    await tx.db
      .update(textInsights)
      .set({
        status: 'done',
        provider: deps.ai!.name,
        model: deps.ai!.model,
        responsesAnalysed: prepared.sent.length,
        responsesTotal: prepared.total,
        summary: output.summary,
        themes: themes.filter((t) => t.count > 0),
        sentiment: output.sentiment,
        inputTokens: output.usage.inputTokens,
        outputTokens: output.usage.outputTokens,
        generatedAt: new Date(),
      })
      .where(eq(textInsights.id, insightId));
    await recordUsage(tx, orgId, 'ai_tokens', tokens);
    await audit(tx, {
      orgId,
      actorId: null,
      action: 'ai.summary_generated',
      entityType: 'survey',
      entityId: prepared.row.surveyId,
      metadata: { questionKey: prepared.row.questionKey, responses: prepared.sent.length, tokens, provider: deps.ai!.name, model: deps.ai!.model },
    });
  });
}
