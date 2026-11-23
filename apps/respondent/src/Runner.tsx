/**
 * Renders a survey page by page: validation, navigation, progress and focus management.
 * Used by the live survey and by the builder's preview, so both behave identically.
 */
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import {
  firstPageKey,
  listQuestions,
  nextPageKey,
  progress,
  validatePage,
  visibleElements,
  type AnswerValue,
  type FieldError,
  type SurveyDefinition,
} from '@survey/core';
import { QuestionView } from './questions';
import { Paragraphs } from './Pages';

export type CompleteOutcome = { ok: true } | { ok: false; errors: FieldError[] };

export interface RunnerProps {
  definition: SurveyDefinition;
  title: string;
  seed: string;
  anonymous?: boolean;
  initialAnswers?: Record<string, AnswerValue>;
  initialPageKey?: string;
  initialHistory?: string[];
  banner?: ReactNode;
  status?: ReactNode;
  busy?: boolean;
  /** Jump to a page (builder preview). */
  goto?: { pageKey: string; nonce: number };
  onChange?: (answers: Record<string, AnswerValue>, pageKey: string, history: string[]) => void;
  onPageComplete?: (answers: Record<string, AnswerValue>, pageKey: string) => void;
  onSubmit: (answers: Record<string, AnswerValue>) => Promise<CompleteOutcome>;
}

export function Runner(props: RunnerProps) {
  const { definition } = props;
  const [answers, setAnswers] = useState<Record<string, AnswerValue>>(props.initialAnswers ?? {});
  const [pageKey, setPageKey] = useState(props.initialPageKey ?? firstPageKey(definition));
  const [history, setHistory] = useState<string[]>(props.initialHistory ?? []);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [announcement, setAnnouncement] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const focusTarget = useRef<'heading' | 'error' | null>(null);

  // The definition can change under us (builder preview): fall back to the first page.
  const page = definition.pages.find((p) => p.key === pageKey) ?? definition.pages[0]!;
  useEffect(() => {
    if (page.key !== pageKey) setPageKey(page.key);
  }, [page.key, pageKey]);

  useEffect(() => {
    if (props.goto && definition.pages.some((p) => p.key === props.goto!.pageKey)) {
      setPageKey(props.goto.pageKey);
      setErrors({});
    }
  }, [props.goto?.nonce]); // eslint-disable-line react-hooks/exhaustive-deps

  useLayoutEffect(() => {
    if (focusTarget.current === 'heading') {
      headingRef.current?.focus();
      window.scrollTo({ top: 0 });
    } else if (focusTarget.current === 'error') {
      const first = Object.keys(errors)[0];
      const el = first
        ? (document.getElementById(`q-${first}`) ?? document.getElementById(`q-${first}-input`))
        : null;
      const input = el?.matches('input, select, textarea')
        ? el
        : el?.querySelector<HTMLElement>('input, select, textarea');
      (input ?? el)?.focus();
      el?.scrollIntoView({ block: 'center' });
    }
    focusTarget.current = null;
  });

  const { index, total, percent } = progress(definition, page.key);
  const next = nextPageKey(definition, page.key, answers);
  const isLast = next === null;
  const questionNumbers = new Map(listQuestions(definition).map((q, i) => [q.key, i + 1]));

  const setAnswer = (key: string, value: AnswerValue | null) => {
    const updated = { ...answers };
    if (value === null) delete updated[key];
    else updated[key] = value;
    setAnswers(updated);
    if (errors[key]) setErrors(({ [key]: _, ...rest }) => rest);
    props.onChange?.(updated, page.key, history);
  };

  const showErrors = (list: FieldError[]) => {
    const map = Object.fromEntries(list.map((e) => [e.questionKey, e.message]));
    setErrors(map);
    setAnnouncement(
      `${list.length} ${list.length === 1 ? 'question needs' : 'questions need'} your attention.`,
    );
    focusTarget.current = 'error';
  };

  const goTo = (key: string, newHistory: string[]) => {
    setPageKey(key);
    setHistory(newHistory);
    setErrors({});
    const p = progress(definition, key);
    setAnnouncement(`Page ${p.index + 1} of ${p.total}`);
    focusTarget.current = 'heading';
    props.onChange?.(answers, key, newHistory);
  };

  const onNext = async (event: React.FormEvent) => {
    event.preventDefault();
    if (submitting || props.busy) return;
    const pageErrors = validatePage(definition, page.key, answers);
    if (pageErrors.length) return showErrors(pageErrors);
    if (!isLast) {
      props.onPageComplete?.(answers, next!);
      goTo(next!, [...history, page.key]);
      return;
    }
    setSubmitting(true);
    try {
      const outcome = await props.onSubmit(answers);
      if (!outcome.ok) {
        const firstPage = outcome.errors[0]?.pageKey;
        if (firstPage && firstPage !== page.key && definition.pages.some((p) => p.key === firstPage))
          setPageKey(firstPage);
        showErrors(outcome.errors);
      }
    } finally {
      setSubmitting(false);
    }
  };

  const onBack = () => {
    const previous = history.at(-1);
    if (previous) goTo(previous, history.slice(0, -1));
  };

  const errorList = Object.entries(errors);
  const pageTitle = page.title?.trim() || (total > 1 ? `Page ${index + 1} of ${total}` : '');

  return (
    <main className="survey">
      {props.banner}
      <header className="survey-header">
        <h1 className="survey-title">{props.title}</h1>
        {props.anonymous ? (
          <p className="anonymous-note">This survey is anonymous. Your answers aren't linked to you.</p>
        ) : null}
        {definition.settings.showProgressBar && total > 1 ? (
          <div className="progress">
            <div
              className="progress-bar"
              role="progressbar"
              aria-label="Survey progress"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={percent}
              aria-valuetext={`Page ${index + 1} of ${total}`}
            >
              <div className="progress-fill" style={{ width: `${Math.max(percent, 4)}%` }} />
            </div>
            <span className="progress-text">
              Page {index + 1} of {total}
            </span>
          </div>
        ) : null}
      </header>

      <form className="page" onSubmit={onNext} noValidate>
        <h2 className={pageTitle ? 'page-title' : 'sr-only'} ref={headingRef} tabIndex={-1}>
          {pageTitle || props.title}
        </h2>
        {page.description ? <Paragraphs text={page.description} className="page-description" /> : null}

        {errorList.length > 0 ? (
          <div className="error-summary" role="alert">
            <p>
              <strong>
                Please check {errorList.length === 1 ? 'this answer' : `these ${errorList.length} answers`}:
              </strong>
            </p>
            <ul>
              {errorList.map(([key, message]) => (
                <li key={key}>
                  <a href={`#q-${key}`}>
                    Question {questionNumbers.get(key)}: {message}
                  </a>
                </li>
              ))}
            </ul>
          </div>
        ) : null}

        {visibleElements(page, answers).map((element) =>
          element.kind === 'text' ? (
            <Paragraphs key={element.key} text={element.body} className="text-block" />
          ) : (
            <QuestionView
              key={element.key}
              question={element}
              number={questionNumbers.get(element.key) ?? 0}
              value={answers[element.key]}
              error={errors[element.key]}
              seed={props.seed}
              onChange={(v) => setAnswer(element.key, v)}
            />
          ),
        )}

        <div className="nav">
          {definition.settings.allowBack && history.length > 0 ? (
            <button type="button" className="button secondary" onClick={onBack} disabled={submitting}>
              Back
            </button>
          ) : (
            <span />
          )}
          <button type="submit" className="button primary" disabled={submitting || props.busy}>
            {isLast ? (submitting ? 'Submitting…' : 'Submit') : 'Next'}
          </button>
        </div>
        {props.status ? <div className="status">{props.status}</div> : null}
      </form>
      <div className="sr-only" aria-live="polite" aria-atomic="true">
        {announcement}
      </div>
    </main>
  );
}
