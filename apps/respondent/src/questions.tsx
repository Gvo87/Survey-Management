/**
 * Question renderers. Accessibility (WCAG 2.1 AA) rules used throughout:
 * - groups of options are <fieldset> + <legend>; single inputs have a <label>
 * - help text and errors are linked with aria-describedby; invalid fields get aria-invalid
 * - only native inputs (radio, checkbox, select, input), so keyboard and screen readers work by default
 * - required questions say so in text, not only with an asterisk
 */
import { useMemo, type ReactNode } from 'react';
import {
  orderOptions,
  otherText,
  selectedOptionKeys,
  type AnswerValue,
  type ChoiceOption,
  type Question,
} from '@survey/core';

export interface QuestionProps {
  question: Question;
  number: number;
  value: AnswerValue | undefined;
  error?: string;
  seed: string;
  onChange: (value: AnswerValue | null) => void;
}

const ids = (key: string) => ({
  field: `q-${key}`,
  help: `q-${key}-help`,
  error: `q-${key}-error`,
  extra: `q-${key}-extra`,
});

function describedBy(question: Question, error?: string, extra?: string): string | undefined {
  const i = ids(question.key);
  const parts = [question.helpText ? i.help : null, extra ?? null, error ? i.error : null].filter(Boolean);
  return parts.length ? parts.join(' ') : undefined;
}

function TitleText({ question, number }: { question: Question; number: number }) {
  return (
    <>
      <span className="q-number" aria-hidden="true">
        {number}.
      </span>{' '}
      {question.title}
      {question.required ? (
        <>
          <span className="q-required" aria-hidden="true">
            {' '}
            *
          </span>
          <span className="sr-only"> (required)</span>
        </>
      ) : null}
    </>
  );
}

function HelpAndError({ question, error }: { question: Question; error?: string }) {
  const i = ids(question.key);
  return (
    <>
      {question.helpText ? (
        <p className="q-help" id={i.help}>
          {question.helpText}
        </p>
      ) : null}
      {error ? (
        <p className="q-error" id={i.error}>
          <span aria-hidden="true">⚠ </span>
          {error}
        </p>
      ) : null}
    </>
  );
}

/** Options grouped in a fieldset (radio / checkbox based questions). */
function Group({
  question,
  number,
  error,
  extraId,
  children,
  className,
}: {
  question: Question;
  number: number;
  error?: string;
  extraId?: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <fieldset
      className={`question ${className ?? ''} ${error ? 'has-error' : ''}`}
      id={ids(question.key).field}
      aria-describedby={describedBy(question, error, extraId)}
      aria-invalid={error ? true : undefined}
    >
      <legend className="q-title">
        <TitleText question={question} number={number} />
      </legend>
      <HelpAndError question={question} error={error} />
      {children}
    </fieldset>
  );
}

/** Single input with a <label>. */
function Field({
  question,
  number,
  error,
  children,
}: {
  question: Question;
  number: number;
  error?: string;
  children: ReactNode;
}) {
  return (
    <div className={`question ${error ? 'has-error' : ''}`}>
      <label className="q-title" htmlFor={`${ids(question.key).field}-input`}>
        <TitleText question={question} number={number} />
      </label>
      <HelpAndError question={question} error={error} />
      {children}
    </div>
  );
}

function OtherInput({
  question,
  option,
  text,
  onText,
}: {
  question: Question;
  option: ChoiceOption;
  text: string;
  onText: (t: string) => void;
}) {
  return (
    <input
      className="text-input other-input"
      type="text"
      value={text}
      maxLength={1000}
      aria-label={`${option.label}, please specify`}
      aria-describedby={describedBy(question)}
      onChange={(e) => onText(e.target.value)}
      autoFocus
    />
  );
}

function SingleChoice({
  question,
  number,
  value,
  error,
  seed,
  onChange,
}: QuestionProps & { question: Extract<Question, { type: 'single_choice' }> }) {
  const options = useMemo(
    () => orderOptions(question.options, question.config.randomize, `${seed}:${question.key}`),
    [question, seed],
  );
  const selected = selectedOptionKeys(value ?? null)[0];
  const other = otherText(value ?? null) ?? '';
  const pick = (o: ChoiceOption) => onChange(o.isOther ? { option: o.key, other } : o.key);
  return (
    <Group question={question} number={number} error={error}>
      <div className="options">
        {options.map((o) => (
          <div key={o.key} className="option">
            <label className="choice">
              <input
                type="radio"
                name={question.key}
                value={o.key}
                checked={selected === o.key}
                required={question.required}
                onChange={() => pick(o)}
              />
              <span>{o.label}</span>
            </label>
            {o.isOther && selected === o.key ? (
              <OtherInput
                question={question}
                option={o}
                text={other}
                onText={(t) => onChange({ option: o.key, other: t })}
              />
            ) : null}
          </div>
        ))}
      </div>
    </Group>
  );
}

function MultiChoice({
  question,
  number,
  value,
  error,
  seed,
  onChange,
}: QuestionProps & { question: Extract<Question, { type: 'multi_choice' }> }) {
  const options = useMemo(
    () => orderOptions(question.options, question.config.randomize, `${seed}:${question.key}`),
    [question, seed],
  );
  const selected = new Set(selectedOptionKeys(value ?? null));
  const other = otherText(value ?? null) ?? '';
  const { minSelections: min, maxSelections: max } = question.config;
  const hint =
    min && max
      ? `Choose ${min} to ${max} options.`
      : min
        ? `Choose at least ${min}.`
        : max
          ? `Choose up to ${max}.`
          : null;
  const hintId = hint ? ids(question.key).extra : undefined;

  const emit = (keys: Set<string>, otherValue = other) => {
    const ordered = question.options.filter((o) => keys.has(o.key)).map((o) => o.key);
    if (ordered.length === 0) return onChange(null);
    const otherOption = question.options.find((o) => o.isOther && keys.has(o.key));
    onChange(otherOption ? { options: ordered, other: otherValue } : ordered);
  };
  const toggle = (o: ChoiceOption, checked: boolean) => {
    let next = new Set(selected);
    if (checked) {
      // "None of the above" clears everything else, and anything else clears it.
      if (o.exclusive) next = new Set();
      else for (const x of question.options) if (x.exclusive) next.delete(x.key);
      next.add(o.key);
    } else next.delete(o.key);
    emit(next);
  };

  return (
    <Group question={question} number={number} error={error} extraId={hintId}>
      {hint ? (
        <p className="q-help" id={hintId}>
          {hint}
        </p>
      ) : null}
      <div className="options">
        {options.map((o) => (
          <div key={o.key} className="option">
            <label className="choice">
              <input
                type="checkbox"
                name={question.key}
                value={o.key}
                checked={selected.has(o.key)}
                onChange={(e) => toggle(o, e.target.checked)}
              />
              <span>{o.label}</span>
            </label>
            {o.isOther && selected.has(o.key) ? (
              <OtherInput question={question} option={o} text={other} onText={(t) => emit(selected, t)} />
            ) : null}
          </div>
        ))}
      </div>
    </Group>
  );
}

function Dropdown({
  question,
  number,
  value,
  error,
  seed,
  onChange,
}: QuestionProps & { question: Extract<Question, { type: 'dropdown' }> }) {
  const options = useMemo(
    () => orderOptions(question.options, question.config.randomize, `${seed}:${question.key}`),
    [question, seed],
  );
  return (
    <Field question={question} number={number} error={error}>
      <select
        id={`${ids(question.key).field}-input`}
        className="select-input"
        value={typeof value === 'string' ? value : ''}
        required={question.required}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy(question, error)}
        onChange={(e) => onChange(e.target.value || null)}
      >
        <option value="">{question.config.placeholder || 'Select an option'}</option>
        {options.map((o) => (
          <option key={o.key} value={o.key}>
            {o.label}
          </option>
        ))}
      </select>
    </Field>
  );
}

function TextQuestion({
  question,
  number,
  value,
  error,
  onChange,
}: QuestionProps & { question: Extract<Question, { type: 'short_text' | 'long_text' | 'email' }> }) {
  const text = typeof value === 'string' ? value : '';
  const max = question.type === 'email' ? 254 : question.config.maxLength;
  const counterId = ids(question.key).extra;
  const common = {
    id: `${ids(question.key).field}-input`,
    value: text,
    maxLength: max,
    required: question.required,
    'aria-invalid': error ? true : undefined,
    'aria-describedby': describedBy(question, error, question.type === 'email' ? undefined : counterId),
    placeholder: question.config.placeholder,
  } as const;
  return (
    <Field question={question} number={number} error={error}>
      {question.type === 'long_text' ? (
        <textarea
          {...common}
          className="text-input textarea"
          rows={5}
          onChange={(e) => onChange(e.target.value)}
        />
      ) : (
        <input
          {...common}
          className="text-input"
          type={question.type === 'email' ? 'email' : 'text'}
          inputMode={question.type === 'email' ? 'email' : undefined}
          autoComplete={question.type === 'email' ? 'email' : 'off'}
          onChange={(e) => onChange(e.target.value)}
        />
      )}
      {question.type !== 'email' ? (
        <p className="q-counter" id={counterId}>
          {text.length} / {max} characters
        </p>
      ) : null}
    </Field>
  );
}

function Scale({
  question,
  number,
  value,
  error,
  onChange,
  points,
  labels,
  kind,
}: QuestionProps & {
  points: { value: number | string; label: string; srLabel: string }[];
  labels?: [string | undefined, string | undefined];
  kind: 'rating-stars' | 'rating-numbers' | 'nps' | 'likert';
}) {
  const labelId = labels && (labels[0] || labels[1]) ? ids(question.key).extra : undefined;
  const current =
    kind === 'likert' ? (typeof value === 'string' ? value : null) : typeof value === 'number' ? value : null;
  return (
    <Group
      question={question}
      number={number}
      error={error}
      extraId={labelId}
      className={`scale-question ${kind}`}
    >
      <div className="scale" data-selected={current ?? ''}>
        {points.map((p) => {
          const active =
            kind === 'rating-stars' && typeof current === 'number' && typeof p.value === 'number'
              ? p.value <= current
              : current === p.value;
          return (
            <label key={String(p.value)} className={`scale-point ${active ? 'active' : ''}`}>
              <input
                type="radio"
                className="sr-only-input"
                name={question.key}
                value={String(p.value)}
                checked={current === p.value}
                required={question.required}
                onChange={() => onChange(p.value)}
              />
              <span className="scale-face" aria-hidden="true">
                {p.label}
              </span>
              <span className="sr-only">{p.srLabel}</span>
            </label>
          );
        })}
      </div>
      {labelId ? (
        <div className="scale-labels" id={labelId}>
          <span>{labels![0] ? `${kind === 'nps' ? '0' : '1'} = ${labels![0]}` : ''}</span>
          <span>{labels![1] ? `${points.at(-1)!.value} = ${labels![1]}` : ''}</span>
        </div>
      ) : null}
    </Group>
  );
}

function DateQuestion({
  question,
  number,
  value,
  error,
  onChange,
}: QuestionProps & { question: Extract<Question, { type: 'date' }> }) {
  return (
    <Field question={question} number={number} error={error}>
      <input
        id={`${ids(question.key).field}-input`}
        className="text-input date-input"
        type="date"
        value={typeof value === 'string' ? value : ''}
        min={question.config.minDate}
        max={question.config.maxDate}
        required={question.required}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy(question, error)}
        onChange={(e) => onChange(e.target.value || null)}
      />
    </Field>
  );
}

export function QuestionView(props: QuestionProps) {
  const { question } = props;
  switch (question.type) {
    case 'single_choice':
      return <SingleChoice {...props} question={question} />;
    case 'multi_choice':
      return <MultiChoice {...props} question={question} />;
    case 'dropdown':
      return <Dropdown {...props} question={question} />;
    case 'short_text':
    case 'long_text':
    case 'email':
      return <TextQuestion {...props} question={question} />;
    case 'date':
      return <DateQuestion {...props} question={question} />;
    case 'rating': {
      const stars = question.config.icon === 'star';
      const points = Array.from({ length: question.config.scale }, (_, i) => ({
        value: i + 1,
        label: stars ? '★' : String(i + 1),
        srLabel: stars
          ? `${i + 1} of ${question.config.scale} stars`
          : `${i + 1} of ${question.config.scale}`,
      }));
      return (
        <Scale
          {...props}
          points={points}
          kind={stars ? 'rating-stars' : 'rating-numbers'}
          labels={[question.config.lowLabel, question.config.highLabel]}
        />
      );
    }
    case 'nps': {
      const points = Array.from({ length: 11 }, (_, i) => ({
        value: i,
        label: String(i),
        srLabel: String(i),
      }));
      return (
        <Scale
          {...props}
          points={points}
          kind="nps"
          labels={[question.config.lowLabel, question.config.highLabel]}
        />
      );
    }
    case 'likert': {
      const points = question.options.map((o) => ({ value: o.key, label: o.label, srLabel: o.label }));
      return <Scale {...props} points={points} kind="likert" />;
    }
  }
}
