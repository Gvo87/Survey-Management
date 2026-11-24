import { useMemo, useState } from 'react';
import { useEffect } from 'react';
import { Link, useSearchParams } from 'react-router';
import { keepPreviousData, useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  Distribution,
  PageResult,
  QuestionSummary,
  ResultFilter,
  ResultsQueryResult,
  Tag,
  VersionDetail,
  VersionSummary,
} from '@survey/contracts';
import { QUESTION_TYPE_META } from '@survey/core';
import { errorMessage, get, post } from '../../api';
import {
  CrosstabCard,
  DropoffCard,
  emptyFilter,
  ExportDialog,
  FilterBuilder,
  RecentExports,
  ScheduledReportsCard,
  SegmentComparison,
  toResultFilter,
  useFilterSources,
  useLiveUpdates,
  WordCloud,
  type FilterState,
  type SegmentState,
} from './analysis';
import {
  BarList,
  Columns,
  DataTable,
  SegmentedBar,
  StatTile,
  divergingColors,
  type Segment,
} from '../../components/charts';
import {
  Alert,
  Badge,
  Button,
  Card,
  Checkbox,
  EmptyState,
  SelectField,
  TextField,
} from '../../components/ui';
import { formatDuration, formatNumber, formatPercent } from '../../lib/format';
import { useSurvey } from './SurveyLayout';
import { AiSummary } from './AiSummary';

type Range = 'all' | '7' | '30' | 'custom';

export function useResultFilters() {
  const [range, setRange] = useState<Range>('all');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [versionId, setVersionId] = useState('');
  const [includePartial, setIncludePartial] = useState(false);
  const [includeTest, setIncludeTest] = useState(false);
  const [excludeFlagged, setExcludeFlagged] = useState(false);
  const params = useMemo(() => {
    const p = new URLSearchParams();
    if (range === '7' || range === '30')
      p.set('from', new Date(Date.now() - Number(range) * 86_400_000).toISOString());
    if (range === 'custom' && from) p.set('from', new Date(`${from}T00:00:00`).toISOString());
    if (range === 'custom' && to)
      p.set('to', new Date(new Date(`${to}T00:00:00`).getTime() + 86_400_000).toISOString());
    if (versionId) p.set('versionId', versionId);
    if (includePartial) p.set('includePartial', 'true');
    if (includeTest) p.set('includeTest', 'true');
    if (excludeFlagged) p.set('excludeFlagged', 'true');
    return p;
  }, [range, from, to, versionId, includePartial, includeTest, excludeFlagged]);
  return {
    range,
    setRange,
    from,
    setFrom,
    to,
    setTo,
    versionId,
    setVersionId,
    includePartial,
    setIncludePartial,
    includeTest,
    setIncludeTest,
    excludeFlagged,
    setExcludeFlagged,
    params,
  };
}

export function ResultsPage() {
  const { survey } = useSurvey();
  const f = useResultFilters();
  const queryClient = useQueryClient();
  const [search] = useSearchParams();
  const [exporting, setExporting] = useState(false);
  const [showTools, setShowTools] = useState(false);
  const [draft, setDraft] = useState<{ filter: FilterState; segments: SegmentState[] }>({ filter: emptyFilter(), segments: [] });
  const [applied, setApplied] = useState<{ filter: FilterState; segments: SegmentState[] }>({ filter: emptyFilter(), segments: [] });

  // What the filter builder can refer to: questions, hidden fields, tags and links.
  const versions = useQuery({ queryKey: ['versions', survey.id], queryFn: () => get<VersionSummary[]>(`/surveys/${survey.id}/versions`), enabled: Boolean(survey.currentVersionNumber) });
  const current = versions.data?.[0];
  const version = useQuery({ queryKey: ['version', current?.id], queryFn: () => get<VersionDetail>(`/surveys/${survey.id}/versions/${current!.id}`), enabled: Boolean(current) });
  const tags = useQuery({ queryKey: ['tags', survey.id], queryFn: () => get<Tag[]>(`/surveys/${survey.id}/tags`) });
  const links = useQuery({ queryKey: ['distributions', survey.id], queryFn: () => get<Distribution[]>(`/surveys/${survey.id}/distributions`) });

  const [questions, setQuestions] = useState<QuestionSummary[]>([]);
  const context = useMemo(
    () => ({ questions, hiddenFields: (version.data?.definition.hiddenFields ?? []).map((h) => h.key), tags: tags.data ?? [], links: links.data ?? [] }),
    [questions, version.data, tags.data, links.data],
  );
  const sources = useFilterSources(context);
  const filter = toResultFilter(applied.filter, sources);
  const segments = applied.segments
    .map((s, i) => ({ name: s.name.trim() || `Segment ${i + 1}`, filter: toResultFilter(s.filter, sources) }))
    .filter((s): s is { name: string; filter: NonNullable<typeof filter> } => Boolean(s.filter));

  const scope = useMemo(() => {
    const p = f.params;
    return {
      ...(p.get('from') ? { from: p.get('from') } : {}),
      ...(p.get('to') ? { to: p.get('to') } : {}),
      ...(p.get('versionId') ? { versionId: p.get('versionId') } : {}),
      includePartial: p.get('includePartial') === 'true',
      includeTest: p.get('includeTest') === 'true',
      excludeFlagged: p.get('excludeFlagged') === 'true',
      ...(filter ? { filter } : {}),
    };
  }, [f.params, filter]);

  const live = useLiveUpdates(survey.id, () => void queryClient.invalidateQueries({ queryKey: ['results', survey.id] }));
  const query = useQuery({
    queryKey: ['results', survey.id, JSON.stringify(scope), JSON.stringify(segments)],
    queryFn: () => post<ResultsQueryResult>(`/surveys/${survey.id}/results/query`, { ...scope, segments }),
    // Live updates push changes; without them (or as a safety net) poll.
    refetchInterval: live ? 120_000 : 15_000,
    placeholderData: keepPreviousData,
    enabled: Boolean(survey.currentVersionNumber),
  });
  const data = query.data?.overall ?? null;
  useEffect(() => {
    if (data && data.questions !== questions && !filter) setQuestions(data.questions);
  }, [data]); // eslint-disable-line react-hooks/exhaustive-deps
  const activeCount = applied.filter.rows.length + applied.segments.length;

  if (!survey.currentVersionNumber)
    return (
      <EmptyState title="No results yet">
        Publish the survey and share its link to start collecting responses.
      </EmptyState>
    );

  return (
    <div className="flex flex-col gap-6">
      {/* Filters: one row, scoping everything below. */}
      <div className="flex flex-wrap items-end gap-3">
        <SelectField label="Started" value={f.range} onChange={(e) => f.setRange(e.target.value as Range)}>
          <option value="all">All time</option>
          <option value="7">Last 7 days</option>
          <option value="30">Last 30 days</option>
          <option value="custom">Custom range</option>
        </SelectField>
        {f.range === 'custom' ? (
          <>
            <TextField label="From" type="date" value={f.from} onChange={(e) => f.setFrom(e.target.value)} />
            <TextField label="To" type="date" value={f.to} onChange={(e) => f.setTo(e.target.value)} />
          </>
        ) : null}
        <SelectField label="Version" value={f.versionId} onChange={(e) => f.setVersionId(e.target.value)}>
          <option value="">All versions</option>
          {data?.versions.map((v) => (
            <option key={v.id} value={v.id}>
              Version {v.versionNumber}
            </option>
          ))}
        </SelectField>
        <div className="flex flex-col gap-1 pb-2">
          <Checkbox label="Include partial responses" checked={f.includePartial} onChange={(e) => f.setIncludePartial(e.target.checked)} />
          <Checkbox label="Include test responses" checked={f.includeTest} onChange={(e) => f.setIncludeTest(e.target.checked)} />
          <Checkbox
            label="Leave out low-quality responses"
            hint="Too fast, straight-lined, or with a file that contained malware."
            checked={f.excludeFlagged}
            onChange={(e) => f.setExcludeFlagged(e.target.checked)}
          />
        </div>
        <Button aria-expanded={showTools} onClick={() => setShowTools((v) => !v)}>
          Filter and compare{activeCount ? ` (${activeCount})` : ''}
        </Button>
        <div className="ml-auto flex items-center gap-3 pb-1">
          <span className="text-xs text-muted" aria-live="polite">
            {query.isFetching ? 'Updating…' : data ? `${live ? 'Live · ' : ''}Updated ${new Date(data.generatedAt).toLocaleTimeString()}` : ''}
          </span>
          <Button onClick={() => setExporting(true)}>Export</Button>
        </div>
      </div>

      {showTools ? (
        <Card title="Filter and compare">
          <div className="flex flex-col gap-5">
            <fieldset className="flex flex-col gap-2">
              <legend className="mb-1 text-sm font-semibold">Only include responses where…</legend>
              <FilterBuilder state={draft.filter} sources={sources} idPrefix="filter" onChange={(filter) => setDraft({ ...draft, filter })} />
            </fieldset>
            <fieldset className="flex flex-col gap-3">
              <legend className="mb-1 text-sm font-semibold">Compare segments side by side (up to 4)</legend>
              {draft.segments.map((segment, i) => (
                <div key={i} className="flex flex-col gap-2 rounded-lg border border-line p-3">
                  <div className="flex items-end gap-2">
                    <TextField
                      label={`Segment ${i + 1} name`}
                      className="flex-1"
                      value={segment.name}
                      onChange={(e) => setDraft({ ...draft, segments: draft.segments.map((s, j) => (j === i ? { ...s, name: e.target.value } : s)) })}
                    />
                    <Button size="sm" variant="ghost" className="mb-1" onClick={() => setDraft({ ...draft, segments: draft.segments.filter((_, j) => j !== i) })}>
                      Remove
                    </Button>
                  </div>
                  <FilterBuilder
                    state={segment.filter}
                    sources={sources}
                    idPrefix={`segment-${i}`}
                    onChange={(filter) => setDraft({ ...draft, segments: draft.segments.map((s, j) => (j === i ? { ...s, filter } : s)) })}
                  />
                </div>
              ))}
              {draft.segments.length < 4 ? (
                <Button size="sm" className="self-start" onClick={() => setDraft({ ...draft, segments: [...draft.segments, { name: '', filter: emptyFilter() }] })}>
                  + Segment
                </Button>
              ) : null}
            </fieldset>
            <div className="flex gap-2">
              <Button variant="primary" onClick={() => setApplied(draft)}>
                Apply
              </Button>
              <Button
                variant="ghost"
                onClick={() => {
                  setDraft({ filter: emptyFilter(), segments: [] });
                  setApplied({ filter: emptyFilter(), segments: [] });
                }}
              >
                Clear
              </Button>
            </div>
          </div>
        </Card>
      ) : null}

      {query.error ? <Alert tone="error">{errorMessage(query.error)}</Alert> : null}
      {!query.data ? <p className="text-sm text-muted">Loading results…</p> : null}
      {query.data?.suppressed ? (
        <Alert tone="info">
          Fewer than {query.data.minGroupSize} responses match. This survey is anonymous, so groups that small aren't shown.
        </Alert>
      ) : null}

      {data ? (
        <div className={query.isFetching && query.isPlaceholderData ? 'opacity-60 transition-opacity' : ''}>
          {filter ? <p className="mb-3 text-sm text-muted">Showing filtered results.</p> : null}
          <div className="grid grid-cols-2 gap-4 md:grid-cols-5">
            <StatTile label="Completed" value={formatNumber(data.totals.completed)} />
            <StatTile label="Started" value={formatNumber(data.totals.started)} />
            <StatTile label="Completion rate" value={formatPercent(data.totals.completionRate)} />
            <StatTile label="Average time" value={formatDuration(data.totals.avgDurationSec)} />
            <StatTile label="Median time" value={formatDuration(data.totals.medianDurationSec)} />
          </div>
          {data.totals.disqualified ? (
            <p className="mt-2 text-sm text-muted">{formatNumber(data.totals.disqualified)} screened out by logic rules (not counted as completed).</p>
          ) : null}

          {query.data?.segments.length ? (
            <div className="mt-6">
              <SegmentComparison segments={query.data.segments} names={query.data.segments.map((s) => s.name)} />
            </div>
          ) : null}

          {data.dropoff.length > 1 ? (
            <Card title="Where people stop" className="mt-6">
              <BarList
                ariaLabel="Respondents reaching each page"
                rows={data.dropoff.map((p, i) => ({
                  key: p.pageKey,
                  label: `${i + 1}. ${p.title}`,
                  count: p.reached,
                  pct: data.totals.started ? Math.round((p.reached / data.totals.started) * 1000) / 10 : 0,
                }))}
              />
              <p className="mt-3 text-xs text-muted">
                Respondents who reached each page (current version). {data.dropoff.reduce((s, p) => s + p.abandonedHere, 0)} left part-way.
              </p>
            </Card>
          ) : null}

          <div className="mt-6 flex flex-col gap-4">
            {data.questions.map((q, i) => (
              <QuestionCard key={q.questionKey} number={i + 1} q={q} surveyId={survey.id} filter={filter} />
            ))}
          </div>
          <div className="mt-6 flex flex-col gap-4">
            <CrosstabCard surveyId={survey.id} questions={data.questions} scope={scope} />
            <DropoffCard surveyId={survey.id} scope={scope} />
          </div>
        </div>
      ) : null}

      <RecentExports surveyId={survey.id} highlight={search.get('export')} />
      <ScheduledReportsCard surveyId={survey.id} canManage />
      <ExportDialog open={exporting} onClose={() => setExporting(false)} surveyId={survey.id} csvParams={f.params} scope={scope} />
    </div>
  );
}

const CATEGORICAL = [
  { color: '#2a78d6', ink: 'light' },
  { color: '#eb6834', ink: 'light' },
  { color: '#1baf7a', ink: 'light' },
  { color: '#eda100', ink: 'dark' },
  { color: '#e87ba4', ink: 'light' },
  { color: '#008300', ink: 'light' },
] as const;

function QuestionCard({ q, number, surveyId, filter }: { q: QuestionSummary; number: number; surveyId: string; filter?: ResultFilter }) {
  const [view, setView] = useState<'chart' | 'share' | 'table'>('chart');
  const [words, setWords] = useState(false);
  const openText = q.type === 'short_text' || q.type === 'long_text';
  const canShare = (q.type === 'single_choice' || q.type === 'dropdown') && q.answered > 0;
  const isText =
    q.type === 'short_text' || q.type === 'long_text' || q.type === 'email' || q.type === 'phone' || q.type === 'file_upload' || q.type === 'consent';
  return (
    <Card
      title={
        <span>
          <span className="text-muted">{number}. </span>
          {q.title}
          {q.removedInCurrentVersion ? <Badge className="ml-2">Removed in current version</Badge> : null}
        </span>
      }
      actions={
        openText && q.answered ? (
          <div role="group" aria-label="View" className="flex shrink-0 gap-1">
            <Button size="sm" variant={!words ? 'primary' : 'ghost'} aria-pressed={!words} onClick={() => setWords(false)}>
              Answers
            </Button>
            <Button size="sm" variant={words ? 'primary' : 'ghost'} aria-pressed={words} onClick={() => setWords(true)}>
              Common words
            </Button>
          </div>
        ) : !isText ? (
          <div role="group" aria-label="View" className="flex shrink-0 gap-1">
            {(['chart', ...(canShare ? ['share'] : []), 'table'] as const).map((v) => (
              <Button
                key={v}
                size="sm"
                variant={view === v ? 'primary' : 'ghost'}
                aria-pressed={view === v}
                onClick={() => setView(v as typeof view)}
              >
                {v === 'chart' ? 'Chart' : v === 'share' ? 'Share' : 'Table'}
              </Button>
            ))}
          </div>
        ) : null
      }
    >
      <p className="-mt-2 mb-4 text-xs text-muted">
        {QUESTION_TYPE_META[q.type].label} · {formatNumber(q.answered)} answered
      </p>
      {words && openText ? <WordCloud surveyId={surveyId} questionKey={q.questionKey} filter={filter} /> : <QuestionBody q={q} view={view} surveyId={surveyId} />}
      {openText && !q.removedInCurrentVersion ? <AiSummary surveyId={surveyId} questionKey={q.questionKey} answered={q.answered} /> : null}
    </Card>
  );
}

function QuestionBody({
  q,
  view,
  surveyId,
}: {
  q: QuestionSummary;
  view: 'chart' | 'share' | 'table';
  surveyId: string;
}) {
  switch (q.type) {
    case 'single_choice':
    case 'multi_choice':
    case 'dropdown':
    case 'likert': {
      const rows = q.options.map((o) => ({ key: o.key, label: o.label, count: o.count, pct: o.pct }));
      if (view === 'table')
        return (
          <DataTable
            caption={q.title}
            columns={['Option', 'Responses', '%']}
            rows={rows.map((r) => [r.label, r.count, `${r.pct}%`])}
          />
        );
      if (q.type === 'likert') {
        const colors = divergingColors(q.options.length);
        return (
          <div className="flex flex-col gap-3">
            {colors && view === 'chart' ? (
              <SegmentedBar
                ariaLabel={q.title}
                segments={q.options.map((o, i) => ({
                  key: o.key,
                  label: o.label,
                  count: o.count,
                  ...colors[i]!,
                }))}
              />
            ) : (
              <BarList ariaLabel={q.title} rows={rows} />
            )}
            {q.mean !== null ? (
              <p className="text-sm text-muted">
                Average score: <strong className="text-ink">{q.mean}</strong>
              </p>
            ) : null}
          </div>
        );
      }
      if (view === 'share') {
        const sorted = [...rows].sort((a, b) => b.count - a.count);
        const top = sorted.slice(0, 5);
        const rest = sorted.slice(5).reduce((s, r) => s + r.count, 0);
        const parts = [
          ...top,
          ...(rest ? [{ key: '__rest', label: 'All other options', count: rest, pct: 0 }] : []),
        ];
        const segments: Segment[] = parts.map((p, i) => ({
          key: p.key,
          label: p.label,
          count: p.count,
          ...CATEGORICAL[i]!,
        }));
        return <SegmentedBar ariaLabel={q.title} segments={segments} />;
      }
      return (
        <div className="flex flex-col gap-2">
          <BarList ariaLabel={q.title} rows={rows} />
          {q.type === 'multi_choice' ? (
            <p className="text-xs text-muted">
              Percentages are of people who answered; they can add up to more than 100%.
            </p>
          ) : null}
          {q.otherCount ? (
            <OtherAnswers surveyId={surveyId} questionKey={q.questionKey} count={q.otherCount} />
          ) : null}
        </div>
      );
    }
    case 'rating':
      return view === 'table' ? (
        <DataTable
          caption={q.title}
          columns={['Rating', 'Responses']}
          rows={q.distribution.map((d) => [d.value, d.count])}
        />
      ) : (
        <div className="grid gap-4 md:grid-cols-[160px_1fr]">
          <div>
            <div className="text-3xl font-semibold">{q.mean ?? '-'}</div>
            <div className="text-sm text-muted">average out of {q.scale}</div>
            <div className="mt-2 text-sm text-muted">Median {q.median ?? '-'}</div>
          </div>
          <Columns
            ariaLabel={q.title}
            data={q.distribution.map((d) => ({ label: String(d.value), count: d.count }))}
          />
        </div>
      );
    case 'nps': {
      const total = q.promoters + q.passives + q.detractors;
      if (view === 'table')
        return (
          <DataTable
            caption={q.title}
            columns={['Score', 'Responses']}
            rows={[
              ...q.distribution.map((d) => [d.value, d.count] as (string | number)[]),
              ['Detractors (0-6)', q.detractors],
              ['Passives (7-8)', q.passives],
              ['Promoters (9-10)', q.promoters],
            ]}
          />
        );
      return (
        <div className="grid gap-6 md:grid-cols-[180px_1fr]">
          <div>
            <div className="text-4xl font-semibold">{q.score ?? '-'}</div>
            <div className="text-sm text-muted">Net Promoter Score</div>
            <div className="mt-1 text-xs text-muted">
              % promoters minus % detractors, from {formatNumber(total)} answers
            </div>
          </div>
          <div className="flex flex-col gap-5">
            <SegmentedBar
              ariaLabel={`${q.title}: detractors, passives and promoters`}
              segments={[
                {
                  key: 'd',
                  label: 'Detractors (0-6)',
                  count: q.detractors,
                  color: 'var(--chart-neg-2)',
                  ink: 'light',
                },
                {
                  key: 'p',
                  label: 'Passives (7-8)',
                  count: q.passives,
                  color: 'var(--chart-neutral)',
                  ink: 'dark',
                },
                {
                  key: 'r',
                  label: 'Promoters (9-10)',
                  count: q.promoters,
                  color: 'var(--chart-pos-2)',
                  ink: 'light',
                },
              ]}
            />
            <Columns
              ariaLabel={`${q.title}: answers by score`}
              data={q.distribution.map((d) => ({ label: String(d.value), count: d.count }))}
            />
          </div>
        </div>
      );
    }
    case 'date':
      return view === 'table' ? (
        <DataTable
          caption={q.title}
          columns={['Date', 'Responses']}
          rows={q.byDay.map((d) => [d.date, d.count])}
        />
      ) : q.byDay.length ? (
        <Columns
          ariaLabel={q.title}
          data={q.byDay.map((d) => ({ label: d.date.slice(5), count: d.count }))}
        />
      ) : (
        <p className="text-sm text-muted">No answers yet.</p>
      );
    case 'matrix':
      return view === 'table' ? (
        <DataTable
          caption={q.title}
          columns={['Row', ...q.columns.map((c) => c.label), 'Answered']}
          rows={q.rows.map((r, i) => [r.label, ...q.counts[i]!, r.answered])}
        />
      ) : (
        <MatrixHeat q={q} />
      );
    case 'ranking': {
      const answered = q.answered || 1;
      return view === 'table' ? (
        <DataTable
          caption={q.title}
          columns={['Option', 'Average rank', 'Ranked first', 'Ranked']}
          rows={q.options.map((o) => [o.label, o.meanRank ?? '-', o.firstPlace, o.ranked])}
        />
      ) : (
        <div className="flex flex-col gap-2">
          <BarList
            ariaLabel={`${q.title}: options by average rank, bars show how often each was ranked first`}
            rows={q.options.map((o, i) => ({
              key: o.key,
              label: `${i + 1}. ${o.label} (avg. rank ${o.meanRank ?? '-'})`,
              count: o.firstPlace,
              pct: Math.round((o.firstPlace / answered) * 1000) / 10,
            }))}
          />
          <p className="text-xs text-muted">
            Sorted by average rank (1 is best). Bars show how often each option was ranked first.
          </p>
        </div>
      );
    }
    case 'slider':
      return view === 'table' ? (
        <DataTable
          caption={q.title}
          columns={['Range', 'Responses']}
          rows={q.histogram.map((b) => [`${b.from} to ${b.to}`, b.count])}
        />
      ) : (
        <div className="grid gap-4 md:grid-cols-[160px_1fr]">
          <div>
            <div className="text-3xl font-semibold">{q.mean ?? '-'}</div>
            <div className="text-sm text-muted">
              average ({q.min} to {q.max})
            </div>
            <div className="mt-2 text-sm text-muted">Median {q.median ?? '-'}</div>
          </div>
          <Columns ariaLabel={q.title} data={q.histogram.map((b) => ({ label: String(b.from), count: b.count }))} />
        </div>
      );
    case 'consent':
      return (
        <p className="text-sm">
          <strong className="text-2xl font-semibold">{formatNumber(q.agreed)}</strong> agreed
          {q.answered ? ` (${formatPercent(q.agreed / q.answered)} of those who answered)` : ''}.
        </p>
      );
    case 'file_upload':
      return (
        <p className="text-sm">
          {formatNumber(q.files)} {q.files === 1 ? 'response includes' : 'responses include'} files. Open a response on the{' '}
          <Link className="text-brand-600 underline" to="../responses" relative="path">
            Responses
          </Link>{' '}
          tab to download them.
        </p>
      );
    case 'short_text':
    case 'long_text':
    case 'email':
    case 'phone':
      return (
        <TextAnswers
          surveyId={surveyId}
          questionKey={q.questionKey}
          latest={q.latest}
          answered={q.answered}
        />
      );
  }
}

/** Matrix as a table shaded by row share (one light-to-mid hue, so the text stays readable). */
function MatrixHeat({ q }: { q: Extract<QuestionSummary, { type: 'matrix' }> }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full border-separate border-spacing-0.5 text-sm">
        <caption className="sr-only">{q.title}: answers per row, with the share of each row</caption>
        <thead>
          <tr>
            <th scope="col" className="sr-only">
              Row
            </th>
            {q.columns.map((c) => (
              <th key={c.key} scope="col" className="px-2 pb-1 text-center text-xs font-medium text-muted">
                {c.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {q.rows.map((r, i) => (
            <tr key={r.key}>
              <th scope="row" className="pr-3 text-left font-medium">
                {r.label}
              </th>
              {q.columns.map((c, j) => {
                const count = q.counts[i]![j]!;
                const share = r.answered ? count / r.answered : 0;
                return (
                  <td
                    key={c.key}
                    className="rounded px-2 py-2 text-center tabular"
                    style={{ background: `color-mix(in srgb, #2a78d6 ${Math.round(6 + share * 44)}%, white)` }}
                  >
                    {Math.round(share * 100)}%<span className="sr-only"> ({count})</span>
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function TextAnswers({
  surveyId,
  questionKey,
  latest,
  answered,
}: {
  surveyId: string;
  questionKey: string;
  latest: { responseId: string; text: string }[];
  answered: number;
}) {
  const [expanded, setExpanded] = useState(false);
  const all = useInfiniteQuery({
    queryKey: ['text', surveyId, questionKey],
    queryFn: ({ pageParam }) =>
      get<PageResult<{ responseId: string; text: string }>>(
        `/surveys/${surveyId}/results/questions/${questionKey}/text?limit=50${pageParam ? `&cursor=${pageParam}` : ''}`,
      ),
    initialPageParam: '',
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    enabled: expanded,
  });
  const items = expanded ? (all.data?.pages.flatMap((p) => p.data) ?? latest) : latest;
  if (!answered) return <p className="text-sm text-muted">No answers yet.</p>;
  return (
    <div>
      <ul className="flex flex-col divide-y divide-line">
        {items.map((item) => (
          <li key={item.responseId} className="whitespace-pre-wrap py-2 text-sm">
            {item.text}
          </li>
        ))}
      </ul>
      {!expanded && answered > latest.length ? (
        <Button size="sm" className="mt-2" onClick={() => setExpanded(true)}>
          Show all {formatNumber(answered)}
        </Button>
      ) : null}
      {expanded && all.hasNextPage ? (
        <Button
          size="sm"
          className="mt-2"
          busy={all.isFetchingNextPage}
          onClick={() => void all.fetchNextPage()}
        >
          Load more
        </Button>
      ) : null}
    </div>
  );
}

function OtherAnswers({ count }: { surveyId: string; questionKey: string; count: number }) {
  return (
    <p className="text-xs text-muted">
      {formatNumber(count)} chose "Other". Their own words are in the responses and the CSV export.
    </p>
  );
}
