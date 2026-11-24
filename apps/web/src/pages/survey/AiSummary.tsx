/**
 * Phase 3B: an AI summary of an open-text question (themes, sentiment, sample answers). Every summary says
 * it's AI-generated, with the model, the date and how many answers it read, and each theme links to the
 * answers behind it, so readers can check it against what people actually wrote.
 */
import { Link } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { AiStatus, TextInsight } from '@survey/contracts';
import { errorMessage, get, post } from '../../api';
import { Alert, Badge, Button, Spinner, cx } from '../../components/ui';
import { formatDateTime, formatNumber } from '../../lib/format';

const SENTIMENT_STYLE: Record<string, string> = {
  positive: 'bg-green-100 text-green-800',
  negative: 'bg-red-100 text-red-800',
  neutral: 'bg-gray-100 text-gray-700',
  mixed: 'bg-amber-100 text-amber-900',
};

export const insightsKey = (surveyId: string) => ['insights', surveyId] as const;

export function AiSummary({ surveyId, questionKey, answered }: { surveyId: string; questionKey: string; answered: number }) {
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: insightsKey(surveyId),
    queryFn: () => get<{ ai: AiStatus; insights: TextInsight[] }>(`/surveys/${surveyId}/insights`),
    // Poll while a summary is being written.
    refetchInterval: (q) => (q.state.data?.insights.some((i) => i.status === 'pending') ? 2000 : false),
  });
  const request = useMutation({
    mutationFn: () => post<TextInsight>(`/surveys/${surveyId}/insights`, { questionKey }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: insightsKey(surveyId) }),
  });
  const data = query.data;
  if (!data || !data.ai.available) return null;
  if (!data.ai.enabled)
    return <p className="mt-4 text-xs text-muted">AI summaries are off for your organization. An admin can turn them on in Settings → General.</p>;
  const insight = data.insights.find((i) => i.questionKey === questionKey);
  const pending = insight?.status === 'pending' || request.isPending;
  const capReached = data.ai.tokensUsedThisMonth >= data.ai.monthlyTokenCap;

  return (
    <section className="mt-5 rounded-lg border border-violet-200 bg-violet-50/40 p-4" aria-label="AI summary">
      <div className="flex flex-wrap items-center gap-2">
        <h4 className="text-sm font-semibold">AI summary</h4>
        {insight?.status === 'done' ? (
          <Badge className="bg-violet-100 text-violet-900">
            AI-generated · {insight.model} · {formatDateTime(insight.generatedAt!)}
          </Badge>
        ) : null}
        <Button size="sm" className="ml-auto" busy={pending} disabled={pending || answered === 0 || capReached} onClick={() => request.mutate()}>
          {insight ? 'Summarize again' : 'Summarize with AI'}
        </Button>
      </div>
      <p className="mt-1 text-xs text-muted">
        Answers go to {data.ai.provider === 'openai' ? 'OpenAI' : data.ai.provider} with emails and phone numbers removed. AI can be wrong: check the
        sample answers.{' '}
        {capReached ? "This month's AI allowance is used up." : `${formatNumber(data.ai.monthlyTokenCap - data.ai.tokensUsedThisMonth)} tokens left this month.`}
      </p>
      {request.error ? (
        <Alert tone="error" className="mt-3">
          {errorMessage(request.error)}
        </Alert>
      ) : null}
      {pending ? (
        <div className="mt-3">
          <Spinner label="Writing the summary…" />
        </div>
      ) : insight?.status === 'failed' ? (
        <Alert tone="error" className="mt-3">
          {insight.error?.message}
        </Alert>
      ) : insight?.status === 'done' ? (
        <InsightBody surveyId={surveyId} insight={insight} />
      ) : null}
    </section>
  );
}

function InsightBody({ surveyId, insight }: { surveyId: string; insight: TextInsight }) {
  const s = insight.sentiment;
  const total = s ? s.positive + s.neutral + s.negative : 0;
  return (
    <div className="mt-3 flex flex-col gap-3">
      <p className="text-xs text-muted">
        Based on {formatNumber(insight.responsesAnalysed)} {insight.responsesAnalysed === 1 ? 'answer' : 'answers'}
        {insight.responsesTotal > insight.responsesAnalysed ? ` (the most recent of ${formatNumber(insight.responsesTotal)})` : ''}.
      </p>
      {insight.summary ? <p className="text-sm">{insight.summary}</p> : null}
      {s && total > 0 ? (
        <div>
          <div className="flex h-2 overflow-hidden rounded-full bg-gray-100" aria-hidden="true">
            <span className="bg-green-600" style={{ width: `${(s.positive / total) * 100}%` }} />
            <span className="bg-gray-400" style={{ width: `${(s.neutral / total) * 100}%` }} />
            <span className="bg-red-600" style={{ width: `${(s.negative / total) * 100}%` }} />
          </div>
          <p className="mt-1 text-xs text-muted">
            Sentiment: {s.positive} positive, {s.neutral} neutral, {s.negative} negative
          </p>
        </div>
      ) : null}
      {insight.themes.length ? (
        <ul className="flex flex-col gap-2">
          {insight.themes.map((theme, i) => (
            <li key={i} className="rounded-md border border-line bg-white p-3">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-sm font-medium">{theme.label}</span>
                <Badge className={cx(SENTIMENT_STYLE[theme.sentiment])}>{theme.sentiment}</Badge>
                <span className="text-xs text-muted">
                  {theme.count} {theme.count === 1 ? 'answer' : 'answers'}
                </span>
              </div>
              <p className="mt-1 text-sm text-muted">{theme.summary}</p>
              {theme.samples.length ? (
                <details className="mt-2">
                  <summary className="cursor-pointer text-sm text-brand-600">Sample answers ({theme.samples.length})</summary>
                  <ul className="mt-2 flex flex-col gap-1">
                    {theme.samples.map((sample) => (
                      <li key={sample.responseId} className="text-sm">
                        <q>{sample.text}</q>{' '}
                        <Link className="text-xs text-brand-600 underline" to={`/surveys/${surveyId}/responses/${sample.responseId}`}>
                          View response
                        </Link>
                      </li>
                    ))}
                  </ul>
                </details>
              ) : null}
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-sm text-muted">No recurring themes.</p>
      )}
    </div>
  );
}
