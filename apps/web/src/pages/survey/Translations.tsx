/**
 * Phase 3B: translations. Pick the draft or the live version, add languages, translate string by string or
 * through a CSV file, and see what's missing. Edits to the live version reach respondents straight away
 * (text only: structure and logic stay as published) and are audit-logged.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { Draft, ImportTranslationResult, TranslationDetail, TranslationsOverview, VersionSummary } from '@survey/contracts';
import { ApiError, del, errorMessage, get, post, put } from '../../api';
import { Alert, Badge, Button, Card, ConfirmDialog, EmptyState, SelectField, TextField, cx } from '../../components/ui';
import { COMMON_LANGUAGES, dirOf, languageName } from '../../lib/languages';
import { useSurvey } from './SurveyLayout';

export function TranslationsPage() {
  const { survey, canEdit } = useSurvey();
  const draft = useQuery({ queryKey: ['draft', survey.id, 'meta'], queryFn: () => get<Draft>(`/surveys/${survey.id}/draft`), enabled: survey.hasDraft });
  const versions = useQuery({
    queryKey: ['versions', survey.id],
    queryFn: () => get<VersionSummary[]>(`/surveys/${survey.id}/versions`),
    enabled: survey.currentVersionNumber !== null,
  });
  const options = useMemo(() => {
    const out: { id: string; label: string; live: boolean }[] = [];
    if (draft.data) out.push({ id: draft.data.versionId, label: survey.currentVersionNumber ? 'Draft (next version)' : 'Draft', live: false });
    const live = versions.data?.[0];
    if (live) out.push({ id: live.id, label: `Live version ${live.versionNumber}`, live: true });
    return out;
  }, [draft.data, versions.data, survey.currentVersionNumber]);
  const [versionId, setVersionId] = useState<string | null>(null);
  const selected = options.find((o) => o.id === versionId) ?? options[0];

  if (!selected) return <p className="text-sm text-muted">Loading…</p>;
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-end gap-4">
        <div>
          <h2 className="text-lg font-semibold">Translations</h2>
          <p className="text-sm text-muted">Respondents get their browser's language when the survey has it, or can pick one. Logic and piping work in every language.</p>
        </div>
        {options.length > 1 ? (
          <SelectField label="Version" className="ml-auto w-56" value={selected.id} onChange={(e) => setVersionId(e.target.value)}>
            {options.map((o) => (
              <option key={o.id} value={o.id}>
                {o.label}
              </option>
            ))}
          </SelectField>
        ) : null}
      </div>
      {selected.live && canEdit ? (
        <Alert tone="info">
          You're editing the live version. Saved text reaches respondents straight away and is recorded in the audit log. New drafts start from these
          translations.
        </Alert>
      ) : null}
      <VersionTranslations key={selected.id} versionId={selected.id} live={selected.live} />
    </div>
  );
}

function VersionTranslations({ versionId, live }: { versionId: string; live: boolean }) {
  const { survey, canEdit } = useSurvey();
  const queryClient = useQueryClient();
  const base = `/surveys/${survey.id}/versions/${versionId}/translations`;
  const overview = useQuery({ queryKey: ['translations', versionId], queryFn: () => get<TranslationsOverview>(base) });
  const [locale, setLocale] = useState<string | null>(null);
  const [adding, setAdding] = useState('');
  const [custom, setCustom] = useState('');
  const [error, setError] = useState<string | null>(null);
  const reload = () => void queryClient.invalidateQueries({ queryKey: ['translations', versionId] });

  const add = useMutation({
    mutationFn: (code: string) => put<TranslationDetail>(`${base}/${code}`, { strings: {} }),
    onSuccess: (detail) => {
      setAdding('');
      setCustom('');
      setError(null);
      setLocale(detail.locale);
      reload();
    },
    onError: (e) => setError(errorMessage(e)),
  });

  if (overview.error) return <Alert tone="error">{errorMessage(overview.error)}</Alert>;
  if (!overview.data) return <p className="text-sm text-muted">Loading…</p>;
  const data = overview.data;
  const current = locale && data.languages.some((l) => l.locale === locale) ? locale : (data.languages[0]?.locale ?? null);
  const taken = new Set([data.defaultLocale, ...data.languages.map((l) => l.locale)]);

  return (
    <div className="grid gap-6 lg:grid-cols-[260px_1fr]">
      <div className="flex flex-col gap-4">
        <Card title="Languages">
          <p className="mb-3 text-sm">
            <span className="font-medium">{languageName(data.defaultLocale)}</span> <span className="text-muted">(survey language)</span>
          </p>
          {data.languages.length === 0 ? <p className="text-sm text-muted">No translations yet.</p> : null}
          <ul className="flex flex-col gap-1" aria-label="Translations">
            {data.languages.map((l) => (
              <li key={l.locale}>
                <button
                  type="button"
                  aria-current={l.locale === current ? 'true' : undefined}
                  onClick={() => setLocale(l.locale)}
                  className={cx(
                    'flex w-full items-center justify-between gap-2 rounded-md px-2 py-1.5 text-start text-sm',
                    l.locale === current ? 'bg-brand-50 font-medium text-brand-700' : 'hover:bg-gray-100',
                  )}
                >
                  <span>
                    {languageName(l.locale)} <span className="text-xs text-muted">{l.locale}</span>
                  </span>
                  {l.missing ? (
                    <Badge className="bg-amber-100 text-amber-900">{l.missing} missing</Badge>
                  ) : (
                    <Badge className="bg-green-100 text-green-800">Complete</Badge>
                  )}
                </button>
              </li>
            ))}
          </ul>
        </Card>
        {canEdit ? (
          <Card title="Add a language">
            <form
              className="flex flex-col gap-3"
              onSubmit={(e) => {
                e.preventDefault();
                const code = (adding === 'other' ? custom.trim() : adding) || '';
                if (code) add.mutate(code);
              }}
            >
              <SelectField label="Language" value={adding} onChange={(e) => setAdding(e.target.value)}>
                <option value="">Choose…</option>
                {COMMON_LANGUAGES.filter((c) => !taken.has(c)).map((c) => (
                  <option key={c} value={c}>
                    {languageName(c)} ({c})
                  </option>
                ))}
                <option value="other">Another language code…</option>
              </SelectField>
              {adding === 'other' ? (
                <TextField label="Language code" hint="Like ca, sw or es-MX." value={custom} onChange={(e) => setCustom(e.target.value)} />
              ) : null}
              {error ? <Alert tone="error">{error}</Alert> : null}
              <Button type="submit" variant="primary" busy={add.isPending} disabled={!adding || (adding === 'other' && !custom.trim())}>
                Add language
              </Button>
            </form>
          </Card>
        ) : null}
      </div>
      {current ? (
        <LanguageEditor key={current} base={base} locale={current} overview={data} live={live} onChanged={reload} onRemoved={() => setLocale(null)} />
      ) : (
        <EmptyState title="Add a language to start translating">
          Each language gets every question, option, page and button. Strings you leave empty show in {languageName(data.defaultLocale)}.
        </EmptyState>
      )}
    </div>
  );
}

function LanguageEditor({
  base,
  locale,
  overview,
  live,
  onChanged,
  onRemoved,
}: {
  base: string;
  locale: string;
  overview: TranslationsOverview;
  live: boolean;
  onChanged: () => void;
  onRemoved: () => void;
}) {
  const { survey, canEdit } = useSurvey();
  const detail = useQuery({ queryKey: ['translation', base, locale], queryFn: () => get<TranslationDetail>(`${base}/${locale}`) });
  const [strings, setStrings] = useState<Record<string, string> | null>(null);
  const [onlyMissing, setOnlyMissing] = useState(false);
  const [notice, setNotice] = useState<{ tone: 'success' | 'error' | 'warning'; text: string } | null>(null);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (detail.data && strings === null) setStrings(detail.data.strings);
  }, [detail.data, strings]);

  const save = useMutation({
    mutationFn: () => put<TranslationDetail>(`${base}/${locale}`, { strings: strings ?? {} }),
    onSuccess: (saved) => {
      setStrings(saved.strings);
      setNotice({ tone: 'success', text: live ? 'Saved. Respondents see the new text now.' : 'Saved.' });
      onChanged();
      void detail.refetch();
    },
    onError: (e) => setNotice({ tone: 'error', text: errorMessage(e) }),
  });
  const importCsv = useMutation({
    mutationFn: async (file: File) => post<ImportTranslationResult>(`${base}/${locale}/import`, { csv: await file.text() }),
    onSuccess: (result) => {
      setStrings(result.translation.strings);
      setNotice({
        tone: result.unknownKeys.length ? 'warning' : 'success',
        text: `Imported ${result.imported} string${result.imported === 1 ? '' : 's'}.${result.unknownKeys.length ? ` ${result.unknownKeys.length} rows didn't match this version and were skipped.` : ''}`,
      });
      onChanged();
      void detail.refetch();
    },
    onError: (e) => setNotice({ tone: 'error', text: e instanceof ApiError ? e.message : errorMessage(e) }),
  });
  const remove = useMutation({
    mutationFn: () => del(`${base}/${locale}`),
    onSuccess: () => {
      setConfirmRemove(false);
      onRemoved();
      onChanged();
    },
  });

  if (!detail.data || !strings) return <p className="text-sm text-muted">Loading…</p>;
  const dir = dirOf(locale);
  const mismatched = new Set(detail.data.tokenMismatches);
  const dirty = JSON.stringify(strings) !== JSON.stringify(detail.data.strings);
  const rows = overview.strings.filter((s) => !onlyMissing || !strings[s.key]?.trim());
  const missing = overview.strings.filter((s) => !strings[s.key]?.trim()).length;

  return (
    <Card
      title={`${languageName(locale)} (${locale})${dir === 'rtl' ? ' · right to left' : ''}`}
      actions={
        <div className="flex flex-wrap gap-2">
          <a className="inline-flex h-8 items-center rounded-lg border border-line bg-white px-3 text-sm font-medium hover:bg-gray-50" href={`/api/v1${base}/${locale}/export.csv`}>
            Export CSV
          </a>
          {canEdit ? (
            <>
              <Button size="sm" onClick={() => fileRef.current?.click()} busy={importCsv.isPending}>
                Import CSV
              </Button>
              <input
                ref={fileRef}
                type="file"
                accept=".csv,text/csv"
                className="sr-only"
                aria-label={`Import ${languageName(locale)} translations from a CSV file`}
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  e.target.value = '';
                  if (file) importCsv.mutate(file);
                }}
              />
            </>
          ) : null}
          {survey.publicUrl && live ? (
            <a className="inline-flex h-8 items-center px-2 text-sm text-brand-600 underline" href={`${survey.publicUrl}?lang=${locale}`} target="_blank" rel="noreferrer">
              Open survey in {languageName(locale)}
            </a>
          ) : null}
        </div>
      }
    >
      <div className="mb-3 flex flex-wrap items-center gap-3 text-sm">
        <span>
          {overview.strings.length - missing} of {overview.strings.length} translated
        </span>
        {detail.data.tokenMismatches.length ? (
          <Badge className="bg-amber-100 text-amber-900">{detail.data.tokenMismatches.length} with different piping</Badge>
        ) : null}
        <label className="ml-auto flex items-center gap-2">
          <input type="checkbox" className="accent-brand-600" checked={onlyMissing} onChange={(e) => setOnlyMissing(e.target.checked)} />
          Show only missing
        </label>
      </div>
      {notice ? (
        <Alert tone={notice.tone} className="mb-3">
          {notice.text}
        </Alert>
      ) : null}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          setNotice(null);
          save.mutate();
        }}
      >
        <ol className="flex flex-col divide-y divide-line">
          {rows.map((s) => {
            const value = strings[s.key] ?? '';
            const id = `tr-${s.key.replace(/[^A-Za-z0-9_-]/g, '-')}`;
            const isMissing = !value.trim();
            return (
              <li key={s.key} className={cx('grid gap-2 py-3 md:grid-cols-2', isMissing && 'border-s-4 border-s-amber-400 ps-3')}>
                <div>
                  <p className="text-xs text-muted">{s.context}</p>
                  <p className="whitespace-pre-wrap text-sm" lang={overview.defaultLocale} dir="auto">
                    {s.source}
                  </p>
                </div>
                <div>
                  <label htmlFor={id} className="sr-only">
                    {languageName(locale)} for {s.context}: {s.source.slice(0, 80)}
                  </label>
                  {s.long ? (
                    <textarea
                      id={id}
                      lang={locale}
                      dir={dir}
                      rows={3}
                      readOnly={!canEdit}
                      className="w-full rounded-lg border border-line bg-white px-3 py-2 text-sm"
                      value={value}
                      aria-describedby={mismatched.has(s.key) ? `${id}-warn` : undefined}
                      onChange={(e) => setStrings({ ...strings, [s.key]: e.target.value })}
                    />
                  ) : (
                    <input
                      id={id}
                      lang={locale}
                      dir={dir}
                      readOnly={!canEdit}
                      className="w-full rounded-lg border border-line bg-white px-3 py-2 text-sm"
                      value={value}
                      aria-describedby={mismatched.has(s.key) ? `${id}-warn` : undefined}
                      onChange={(e) => setStrings({ ...strings, [s.key]: e.target.value })}
                    />
                  )}
                  {isMissing ? <p className="mt-1 text-xs text-amber-900">Missing: respondents see the {languageName(overview.defaultLocale)} text.</p> : null}
                  {mismatched.has(s.key) ? (
                    <p id={`${id}-warn`} className="mt-1 text-xs text-amber-900">
                      Uses different piping (&#123;&#123;…&#125;&#125;) than the original. Keep the same placeholders.
                    </p>
                  ) : null}
                </div>
              </li>
            );
          })}
        </ol>
        {canEdit ? (
          <div className="sticky bottom-0 mt-3 flex flex-wrap gap-3 border-t border-line bg-white py-3">
            <Button type="submit" variant="primary" busy={save.isPending} disabled={!dirty}>
              Save {languageName(locale)}
            </Button>
            <Button variant="danger" className="ml-auto" onClick={() => setConfirmRemove(true)}>
              Remove language
            </Button>
          </div>
        ) : null}
      </form>
      <ConfirmDialog
        open={confirmRemove}
        title={`Remove ${languageName(locale)}?`}
        message={live ? 'Respondents will no longer be offered this language. Its translations are deleted.' : 'Its translations are deleted from this draft.'}
        confirmLabel="Remove"
        danger
        busy={remove.isPending}
        onCancel={() => setConfirmRemove(false)}
        onConfirm={() => remove.mutate()}
      />
    </Card>
  );
}
