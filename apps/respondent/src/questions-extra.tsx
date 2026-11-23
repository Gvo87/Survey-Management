/**
 * Phase 2A question types, in their own chunk so surveys that don't use them never download it.
 * Same accessibility rules as questions.tsx: native inputs only, groups have names, help and errors
 * are linked with aria-describedby.
 */
import { useContext, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { FILE_CATEGORY_MIME, orderOptions, type FileCategory, type Question } from '@survey/core';
import { Paragraphs } from './Pages';
import { describedBy, Field, Group, HelpAndError, ids, TitleText, type QuestionProps } from './questions';
import { UploadContext } from './uploads';

type Of<T extends Question['type']> = QuestionProps & { question: Extract<Question, { type: T }> };

// ── Matrix: a grid on wide screens, one block per row below 600px (CSS) ──────
function Matrix({ question, number, value, error, seed, onChange }: Of<'matrix'>) {
  const rows = useMemo(
    () => orderOptions(question.rows, question.config.randomizeRows, `${seed}:${question.key}:rows`),
    [question, seed],
  );
  const multiple = question.config.multiplePerRow;
  const current = (value && typeof value === 'object' && !Array.isArray(value) ? value : {}) as Record<string, string | string[]>;

  const set = (row: string, col: string, checked: boolean) => {
    const next = { ...current };
    if (multiple) {
      const chosen = new Set(Array.isArray(next[row]) ? (next[row] as string[]) : []);
      if (checked) chosen.add(col);
      else chosen.delete(col);
      const ordered = question.options.filter((o) => chosen.has(o.key)).map((o) => o.key);
      if (ordered.length) next[row] = ordered;
      else delete next[row];
    } else next[row] = col;
    onChange(Object.keys(next).length ? next : null);
  };

  return (
    <Group question={question} number={number} error={error} className="matrix-question">
      <div className="matrix" style={{ '--cols': question.options.length } as CSSProperties}>
        <div className="matrix-head" aria-hidden="true">
          <span />
          {question.options.map((c) => (
            <span key={c.key}>{c.label}</span>
          ))}
        </div>
        {rows.map((row) => {
          const labelId = `${ids(question.key).field}-row-${row.key}`;
          const cell = current[row.key];
          return (
            <div key={row.key} className="matrix-row" role={multiple ? 'group' : 'radiogroup'} aria-labelledby={labelId}>
              <span className="matrix-row-label" id={labelId}>
                {row.label}
              </span>
              {question.options.map((col) => (
                <label key={col.key} className="matrix-cell">
                  <input
                    type={multiple ? 'checkbox' : 'radio'}
                    name={`${question.key}-${row.key}`}
                    value={col.key}
                    checked={multiple ? Array.isArray(cell) && cell.includes(col.key) : cell === col.key}
                    onChange={(e) => set(row.key, col.key, e.target.checked)}
                  />
                  <span className="matrix-cell-label">{col.label}</span>
                </label>
              ))}
            </div>
          );
        })}
      </div>
    </Group>
  );
}

// ── Ranking: a rank picker per option (works with keyboard, touch and screen readers) ──
function Ranking({ question, number, value, error, seed, onChange }: Of<'ranking'>) {
  const options = useMemo(
    () => orderOptions(question.options, question.config.randomize, `${seed}:${question.key}`),
    [question, seed],
  );
  const needed = Math.min(question.config.rankCount ?? options.length, options.length);
  const fromValue = () =>
    Object.fromEntries((Array.isArray(value) ? (value as string[]) : []).map((key, i) => [key, i + 1])) as Record<string, number>;
  // Local ranks can have gaps while the respondent is choosing; the answer is the ranked keys in order.
  const [ranks, setRanks] = useState<Record<string, number>>(fromValue);
  const hintId = ids(question.key).extra;

  const choose = (key: string, rank: number | null) => {
    const next = { ...ranks };
    const previous = next[key];
    delete next[key];
    if (rank !== null) {
      // Taking a rank someone else has swaps them.
      const holder = Object.keys(next).find((k) => next[k] === rank);
      if (holder) {
        if (previous) next[holder] = previous;
        else delete next[holder];
      }
      next[key] = rank;
    }
    setRanks(next);
    const ordered = Object.keys(next).sort((a, b) => next[a]! - next[b]!);
    onChange(ordered.length ? ordered : null);
  };

  return (
    <Group question={question} number={number} error={error} extraId={hintId} className="ranking-question">
      <p className="q-help" id={hintId}>
        {needed === options.length ? 'Rank every option. 1 is your top choice.' : `Rank your top ${needed}. 1 is your top choice.`}
      </p>
      <ol className="ranking">
        {options.map((o) => {
          const selectId = `${ids(question.key).field}-${o.key}`;
          return (
            <li key={o.key} className={`ranking-item ${ranks[o.key] ? 'ranked' : ''}`}>
              <select
                id={selectId}
                className="select-input rank-select"
                value={ranks[o.key] ?? ''}
                aria-describedby={describedBy(question, error, hintId)}
                onChange={(e) => choose(o.key, e.target.value ? Number(e.target.value) : null)}
              >
                <option value="">–</option>
                {Array.from({ length: needed }, (_, i) => (
                  <option key={i} value={i + 1}>
                    {i + 1}
                  </option>
                ))}
              </select>
              <label htmlFor={selectId}>
                {o.label}
                <span className="sr-only">, rank</span>
              </label>
            </li>
          );
        })}
      </ol>
    </Group>
  );
}

// ── Slider ───────────────────────────────────────────────────────────────────
function formatWithUnit(n: number, unit?: string): string {
  const text = n.toLocaleString();
  if (!unit) return text;
  return /^[$€£¥₹]$/.test(unit) ? `${unit}${text}` : `${text} ${unit}`;
}

function Slider({ question, number, value, error, onChange }: Of<'slider'>) {
  const { min, max, step, unit, minLabel, maxLabel } = question.config;
  const current = typeof value === 'number' ? value : null;
  const middle = min + Math.round((max - min) / 2 / step) * step;
  const id = `${ids(question.key).field}-input`;
  const labelsId = ids(question.key).extra;
  return (
    <Field question={question} number={number} error={error}>
      <div className={`slider ${current === null ? 'unset' : ''}`}>
        <input
          id={id}
          type="range"
          min={min}
          max={max}
          step={step}
          value={current ?? middle}
          aria-valuetext={current === null ? 'Not answered' : formatWithUnit(current, unit)}
          aria-invalid={error ? true : undefined}
          aria-describedby={describedBy(question, error, minLabel || maxLabel ? labelsId : undefined)}
          onChange={(e) => onChange(Number(e.target.value))}
          // Clicking the thumb where it already is still counts as an answer.
          onPointerUp={(e) => current === null && onChange(Number(e.currentTarget.value))}
        />
        <output htmlFor={id} className="slider-value">
          {current === null ? 'Not answered yet' : formatWithUnit(current, unit)}
        </output>
      </div>
      <div className="scale-labels" id={labelsId}>
        <span>{minLabel ? `${formatWithUnit(min, unit)} = ${minLabel}` : formatWithUnit(min, unit)}</span>
        <span>{maxLabel ? `${formatWithUnit(max, unit)} = ${maxLabel}` : formatWithUnit(max, unit)}</span>
      </div>
      {current !== null && !question.required ? (
        <button type="button" className="link-button" onClick={() => onChange(null)}>
          Clear answer
        </button>
      ) : null}
    </Field>
  );
}

// ── Phone ────────────────────────────────────────────────────────────────────
function Phone({ question, number, value, error, onChange }: Of<'phone'>) {
  const hintId = ids(question.key).extra;
  return (
    <Field question={question} number={number} error={error}>
      <p className="q-help" id={hintId}>
        Include the country code, for example +44 20 7946 0958.
      </p>
      <input
        id={`${ids(question.key).field}-input`}
        className="text-input"
        type="tel"
        inputMode="tel"
        autoComplete="tel"
        maxLength={30}
        value={typeof value === 'string' ? value : ''}
        required={question.required}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy(question, error, hintId)}
        onChange={(e) => onChange(e.target.value || null)}
      />
    </Field>
  );
}

// ── File upload ──────────────────────────────────────────────────────────────
const CATEGORY_NAMES: Record<FileCategory, string> = {
  image: 'images (PNG, JPEG, WebP, GIF)',
  pdf: 'PDF',
  document: 'Word or OpenDocument text',
  spreadsheet: 'Excel or CSV',
  text: 'plain text',
};
const CATEGORY_EXTENSIONS: Record<FileCategory, string[]> = {
  image: ['.png', '.jpg', '.jpeg', '.webp', '.gif'],
  pdf: ['.pdf'],
  document: ['.docx', '.odt'],
  spreadsheet: ['.xlsx', '.csv'],
  text: ['.txt'],
};

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function FileUpload({ question, number, value, error, onChange }: Of<'file_upload'>) {
  const uploader = useContext(UploadContext);
  const fileIds = Array.isArray(value) ? (value as string[]) : [];
  const [uploading, setUploading] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);
  // Uploads are async: always report against the latest answers, not those of the first render.
  const latest = useRef({ onChange, fileIds });
  useEffect(() => {
    latest.current = { onChange, fileIds };
  });
  const { maxFiles, maxSizeMb, allowedTypes } = question.config;
  const accept = allowedTypes.flatMap((c) => [...FILE_CATEGORY_MIME[c], ...CATEGORY_EXTENSIONS[c]]).join(',');
  const hintId = ids(question.key).extra;
  const full = fileIds.length >= maxFiles;

  const add = async (list: FileList | null) => {
    if (!list?.length || !uploader) return;
    setProblem(null);
    const room = maxFiles - latest.current.fileIds.length;
    const chosen = [...list];
    if (chosen.length > room) setProblem(`You can add ${room} more file${room === 1 ? '' : 's'}.`);
    for (const file of chosen.slice(0, room)) {
      if (file.size > maxSizeMb * 1024 * 1024) {
        setProblem(`"${file.name}" is larger than ${maxSizeMb} MB.`);
        continue;
      }
      setUploading(file.name);
      try {
        const uploaded = await uploader.upload(question.key, file);
        latest.current.onChange([...latest.current.fileIds, uploaded.fileId]);
      } catch (e) {
        setProblem(e instanceof Error && e.message ? e.message : `"${file.name}" couldn't be uploaded. Try again.`);
      }
    }
    setUploading(null);
    if (input.current) input.current.value = '';
  };

  const remove = async (fileId: string) => {
    const rest = fileIds.filter((id) => id !== fileId);
    onChange(rest.length ? rest : null);
    // The server also deletes unreferenced uploads on completion, so a failure here is harmless.
    await uploader?.remove(fileId).catch(() => {});
    input.current?.focus();
  };

  return (
    <Field question={question} number={number} error={error}>
      <p className="q-help" id={hintId}>
        {maxFiles === 1 ? 'One file' : `Up to ${maxFiles} files`}, {maxSizeMb} MB each. Accepted: {allowedTypes.map((c) => CATEGORY_NAMES[c]).join(', ')}.
      </p>
      {fileIds.length ? (
        <ul className="file-list" aria-label="Uploaded files">
          {fileIds.map((id) => {
            const info = uploader?.info(id);
            const name = info?.name ?? 'Uploaded file';
            return (
              <li key={id} className="file-item">
                <span className="file-name">{name}</span>
                {info ? <span className="file-size">{formatSize(info.size)}</span> : null}
                <button type="button" className="link-button" onClick={() => void remove(id)}>
                  Remove<span className="sr-only"> {name}</span>
                </button>
              </li>
            );
          })}
        </ul>
      ) : null}
      <input
        ref={input}
        id={`${ids(question.key).field}-input`}
        className="file-input"
        type="file"
        accept={accept}
        multiple={maxFiles - fileIds.length > 1}
        disabled={full || uploading !== null || !uploader}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy(question, error, hintId)}
        onChange={(e) => void add(e.target.files)}
      />
      <p className="file-status" role="status">
        {uploading ? `Uploading ${uploading}…` : full ? `You've added the maximum of ${maxFiles} file${maxFiles === 1 ? '' : 's'}.` : ''}
      </p>
      {problem ? (
        <p className="q-error" role="alert">
          <span aria-hidden="true">⚠ </span>
          {problem}
        </p>
      ) : null}
    </Field>
  );
}

// ── Consent ──────────────────────────────────────────────────────────────────
function Consent({ question, number, value, error, onChange }: Of<'consent'>) {
  const i = ids(question.key);
  const statementId = `${i.field}-statement`;
  const link = question.config.linkUrl && /^https?:\/\//i.test(question.config.linkUrl) ? question.config.linkUrl : null;
  return (
    <div className={`question consent ${error ? 'has-error' : ''}`} id={i.field}>
      <p className="q-title">
        <TitleText question={question} number={number} />
      </p>
      <HelpAndError question={question} error={error} />
      <div id={statementId} className="consent-statement">
        <Paragraphs text={question.config.statement} />
        {link ? (
          <p>
            <a href={link} target="_blank" rel="noopener noreferrer">
              {question.config.linkLabel || 'Read the full notice'}
              <span className="sr-only"> (opens in a new tab)</span>
            </a>
          </p>
        ) : null}
      </div>
      <label className="choice consent-choice">
        <input
          id={`${i.field}-input`}
          type="checkbox"
          checked={value === true}
          required={question.required}
          aria-invalid={error ? true : undefined}
          aria-describedby={[statementId, error ? i.error : null].filter(Boolean).join(' ')}
          onChange={(e) => onChange(e.target.checked ? true : null)}
        />
        <span>I agree</span>
      </label>
    </div>
  );
}

export default function ExtraQuestion(props: QuestionProps) {
  const { question } = props;
  switch (question.type) {
    case 'matrix':
      return <Matrix {...props} question={question} />;
    case 'ranking':
      return <Ranking {...props} question={question} />;
    case 'slider':
      return <Slider {...props} question={question} />;
    case 'phone':
      return <Phone {...props} question={question} />;
    case 'file_upload':
      return <FileUpload {...props} question={question} />;
    case 'consent':
      return <Consent {...props} question={question} />;
    default:
      return null;
  }
}
