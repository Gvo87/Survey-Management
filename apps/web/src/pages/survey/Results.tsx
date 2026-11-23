import { useMemo, useState } from 'react';
import { keepPreviousData, useInfiniteQuery, useQuery } from '@tanstack/react-query';
import type { PageResult, QuestionSummary, ResultsSummary } from '@survey/contracts';
import { QUESTION_TYPE_META } from '@survey/core';
import { errorMessage, get } from '../../api';
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
  Dialog,
  EmptyState,
  SelectField,
  TextField,
} from '../../components/ui';
import { formatDuration, formatNumber, formatPercent } from '../../lib/format';
import { useSurvey } from './SurveyLayout';

type Range = 'all' | '7' | '30' | 'custom';

export function useResultFilters() {
  const [range, setRange] = useState<Range>('all');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [versionId, setVersionId] = useState('');
  const [includePartial, setIncludePartial] = useState(false);
  const [includeTest, setIncludeTest] = useState(false);
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
    return p;
  }, [range, from, to, versionId, includePartial, includeTest]);
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
    params,
  };
}

export function ResultsPage() {
  const { survey } = useSurvey();
  const f = useResultFilters();
  const [exporting, setExporting] = useState(false);
  const query = useQuery({
    queryKey: ['results', survey.id, f.params.toString()],
    queryFn: () => get<ResultsSummary>(`/surveys/${survey.id}/results/summary?${f.params}`),
    refetchInterval: 15_000,
    placeholderData: keepPreviousData,
  });
  const data = query.data;

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
          <Checkbox
            label="Include partial responses"
            checked={f.includePartial}
            onChange={(e) => f.setIncludePartial(e.target.checked)}
          />
          <Checkbox
            label="Include test responses"
            checked={f.includeTest}
            onChange={(e) => f.setIncludeTest(e.target.checked)}
          />
        </div>
        <div className="ml-auto flex items-center gap-3 pb-1">
          <span className="text-xs text-muted" aria-live="polite">
            {query.isFetching
              ? 'Updating…'
              : data
                ? `Updated ${new Date(data.generatedAt).toLocaleTimeString()}`
                : ''}
          </span>
          <Button onClick={() => setExporting(true)}>Export CSV</Button>
        </div>
      </div>

      {query.error ? <Alert tone="error">{errorMessage(query.error)}</Alert> : null}
      {!data ? <p className="text-sm text-muted">Loading results…</p> : null}

      {data ? (
        <div className={query.isFetching && query.isPlaceholderData ? 'opacity-60 transition-opacity' : ''}>
          <div className="grid grid-cols-2 gap-4 md:grid-cols-5">
            <StatTile label="Completed" value={formatNumber(data.totals.completed)} />
            <StatTile label="Started" value={formatNumber(data.totals.started)} />
            <StatTile label="Completion rate" value={formatPercent(data.totals.completionRate)} />
            <StatTile label="Average time" value={formatDuration(data.totals.avgDurationSec)} />
            <StatTile label="Median time" value={formatDuration(data.totals.medianDurationSec)} />
          </div>

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
                Respondents who reached each page (current version).{' '}
                {data.dropoff.reduce((s, p) => s + p.abandonedHere, 0)} left part-way.
              </p>
            </Card>
          ) : null}

          <div className="mt-6 flex flex-col gap-4">
            {data.questions.map((q, i) => (
              <QuestionCard key={q.questionKey} number={i + 1} q={q} surveyId={survey.id} />
            ))}
          </div>
        </div>
      ) : null}

      <ExportDialog
        open={exporting}
        onClose={() => setExporting(false)}
        surveyId={survey.id}
        filters={f.params}
      />
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

function QuestionCard({ q, number, surveyId }: { q: QuestionSummary; number: number; surveyId: string }) {
  const [view, setView] = useState<'chart' | 'share' | 'table'>('chart');
  const canShare = (q.type === 'single_choice' || q.type === 'dropdown') && q.answered > 0;
  const isText = q.type === 'short_text' || q.type === 'long_text' || q.type === 'email';
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
        !isText ? (
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
      <QuestionBody q={q} view={view} surveyId={surveyId} />
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
    case 'short_text':
    case 'long_text':
    case 'email':
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

function ExportDialog({
  open,
  onClose,
  surveyId,
  filters,
}: {
  open: boolean;
  onClose: () => void;
  surveyId: string;
  filters: URLSearchParams;
}) {
  const [layout, setLayout] = useState<'compact' | 'expanded'>('compact');
  const [all, setAll] = useState(false);
  const params = new URLSearchParams(filters);
  params.delete('includePartial');
  params.set('layout', layout);
  params.set('status', all ? 'all' : 'completed');
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Export responses"
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <a
            href={`/api/v1/surveys/${surveyId}/export.csv?${params}`}
            download
            onClick={() => setTimeout(onClose, 300)}
            className="inline-flex h-10 items-center rounded-lg bg-brand-600 px-4 text-sm font-medium text-white hover:bg-brand-700"
          >
            Download CSV
          </a>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <p className="text-sm text-muted">
          Uses the date, version and test filters currently applied to the results. Opens in Excel and Google
          Sheets.
        </p>
        <SelectField
          label="Layout"
          value={layout}
          onChange={(e) => setLayout(e.target.value as 'compact' | 'expanded')}
        >
          <option value="compact">Compact: one column per question</option>
          <option value="expanded">Expanded: one 0/1 column per multiple-choice option</option>
        </SelectField>
        <Checkbox
          label="Include partial (unfinished) responses"
          checked={all}
          onChange={(e) => setAll(e.target.checked)}
        />
      </div>
    </Dialog>
  );
}
