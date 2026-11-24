/**
 * Renders a survey page by page: logic, piping, validation, navigation, progress and focus.
 * Used by the live survey and by the builder's preview, so both behave identically.
 *
 * Logic (Phase 2A) comes from @survey/core, the same code the server runs on completion:
 * - conditions are evaluated on the answers along the respondent's path (`pathAnswers`), so an
 *   answer on a page they skipped never shows or hides anything;
 * - "Next" follows the page rules (`nextStep`); a rule that ends or disqualifies turns the button
 *   into "Submit", and the server decides the outcome.
 */
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  firstPageKey,
  listQuestions,
  nextStep,
  pathAnswers,
  pipe,
  progress,
  QUESTION_TYPE_META,
  validatePage,
  visibleElements,
  format,
  UI_STRINGS,
  type AnswerValue,
  type FieldError,
  type Question,
  type SurveyDefinition,
  type UiStrings,
} from '@survey/core';
import { preloadExtraQuestions, QuestionView } from './questions';
import { Paragraphs } from './Pages';
import { UiContext } from './ui';

export type CompleteOutcome = { ok: true } | { ok: false; errors: FieldError[] };

export interface RunnerProps {
  definition: SurveyDefinition;
  title: string;
  seed: string;
  anonymous?: boolean;
  /** Hidden fields (URL parameters): conditions and piping can use them. */
  hidden?: Record<string, string>;
  /** Contact fields from a personal campaign link, for {{contact.…}} piping. */
  contact?: Record<string, string> | null;
  /** Shown under the navigation (e.g. "Email me a link to finish later"). */
  footer?: ReactNode;
  logoUrl?: string | null;
  initialAnswers?: Record<string, AnswerValue>;
  initialPageKey?: string;
  initialHistory?: string[];
  banner?: ReactNode;
  status?: ReactNode;
  /** Shown above the navigation buttons (the CAPTCHA, while a response hasn't started). */
  beforeNav?: ReactNode;
  busy?: boolean;
  /** Jump to a page (builder preview). */
  goto?: { pageKey: string; nonce: number };
  onChange?: (answers: Record<string, AnswerValue>, pageKey: string, history: string[]) => void;
  onPageComplete?: (answers: Record<string, AnswerValue>, pageKey: string) => void;
  onSubmit: (answers: Record<string, AnswerValue>) => Promise<CompleteOutcome>;
  /** Phase 3B: buttons and messages in the survey's language (English by default). */
  ui?: UiStrings;
  /** Phase 3B: shown in the header (the language picker). */
  headerExtra?: ReactNode;
}

export function Runner(props: RunnerProps) {
  const { definition, hidden } = props;
  const ui = props.ui ?? UI_STRINGS;
  const [answers, setAnswers] = useState<Record<string, AnswerValue>>(props.initialAnswers ?? {});
  const [pageKey, setPageKey] = useState(props.initialPageKey ?? firstPageKey(definition, { answers: {}, hidden }));
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

  // Start fetching the widgets for Phase 2A question types as soon as the survey uses one.
  useEffect(() => {
    if (listQuestions(definition).some((q) => QUESTION_TYPE_META[q.type].phase !== 1)) preloadExtraQuestions();
  }, [definition]);

  useLayoutEffect(() => {
    if (focusTarget.current === 'heading') {
      headingRef.current?.focus();
      window.scrollTo({ top: 0 });
    } else if (focusTarget.current === 'error') {
      const first = Object.keys(errors)[0];
      const el = first ? (document.getElementById(`q-${first}`) ?? document.getElementById(`q-${first}-input`)) : null;
      const input = el?.matches('input, select, textarea') ? el : el?.querySelector<HTMLElement>('input, select, textarea, button');
      (input ?? el)?.focus();
      el?.scrollIntoView({ block: 'center' });
    }
    focusTarget.current = null;
  });

  // Logic sees only the answers on the respondent's path to this page, plus this page's.
  const ctx = useMemo(
    () => ({ answers: pathAnswers(definition, answers, page.key, hidden), hidden }),
    [definition, answers, page.key, hidden],
  );
  const piped = (text: string) => pipe(text, { def: definition, answers: ctx.answers, hidden, contact: props.contact ?? undefined });
  const { index, total, percent } = progress(definition, page.key);
  const step = nextStep(definition, page.key, ctx);
  const isLast = step.kind !== 'page';
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
    // "Required" is the common case and is translatable; other messages come from @survey/core in English.
    const map = Object.fromEntries(list.map((e) => [e.questionKey, e.code === 'required' && e.message === UI_STRINGS.requiredError ? ui.requiredError : e.message]));
    setErrors(map);
    setAnnouncement(`${ui.errorSummary} ${list.length}`);
    focusTarget.current = 'error';
  };

  const goTo = (key: string, newHistory: string[]) => {
    setPageKey(key);
    setHistory(newHistory);
    setErrors({});
    const p = progress(definition, key);
    setAnnouncement(format(ui.pageOf, { n: p.index + 1, total: p.total }));
    focusTarget.current = 'heading';
    props.onChange?.(answers, key, newHistory);
  };

  const onNext = async (event: React.FormEvent) => {
    event.preventDefault();
    if (submitting || props.busy) return;
    const pageErrors = validatePage(definition, page.key, answers, hidden);
    if (pageErrors.length) return showErrors(pageErrors);
    if (step.kind === 'page') {
      props.onPageComplete?.(answers, step.pageKey);
      goTo(step.pageKey, [...history, page.key]);
      return;
    }
    setSubmitting(true);
    try {
      const outcome = await props.onSubmit(answers);
      if (!outcome.ok) {
        const firstPage = outcome.errors[0]?.pageKey;
        if (firstPage && firstPage !== page.key && definition.pages.some((p) => p.key === firstPage)) setPageKey(firstPage);
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
  const pageOf = format(ui.pageOf, { n: index + 1, total });
  const pageTitle = page.title?.trim() ? piped(page.title) : total > 1 ? pageOf : '';
  const pipedQuestion = (q: Question): Question =>
    q.title.includes('{{') || q.helpText?.includes('{{')
      ? { ...q, title: piped(q.title), ...(q.helpText ? { helpText: piped(q.helpText) } : {}) }
      : q;

  return (
    <UiContext.Provider value={ui}>
    <main className="survey">
      {props.banner}
      <header className="survey-header">
        {props.headerExtra}
        {props.logoUrl ? <img className="survey-logo" src={props.logoUrl} alt="" /> : null}
        <h1 className="survey-title">{props.title}</h1>
        {props.anonymous ? <p className="anonymous-note">{ui.anonymousNote}</p> : null}
        {definition.settings.showProgressBar && total > 1 ? (
          <div className="progress">
            <div
              className="progress-bar"
              role="progressbar"
              aria-label="Survey progress"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={percent}
              aria-valuetext={pageOf}
            >
              <div className="progress-fill" style={{ width: `${Math.max(percent, 4)}%` }} />
            </div>
            <span className="progress-text">{pageOf}</span>
          </div>
        ) : null}
      </header>

      <form className="page" onSubmit={onNext} noValidate>
        <h2 className={pageTitle ? 'page-title' : 'sr-only'} ref={headingRef} tabIndex={-1}>
          {pageTitle || props.title}
        </h2>
        {page.description ? <Paragraphs text={piped(page.description)} className="page-description" /> : null}

        {errorList.length > 0 ? (
          <div className="error-summary" role="alert">
            <p>
              <strong>{ui.errorSummary}</strong>
            </p>
            <ul>
              {errorList.map(([key, message]) => (
                <li key={key}>
                  <a href={`#q-${key}`}>
                    {questionNumbers.get(key)}. {message}
                  </a>
                </li>
              ))}
            </ul>
          </div>
        ) : null}

        {visibleElements(definition, page, ctx).map((element) =>
          element.kind === 'text' ? (
            <Paragraphs key={element.key} text={piped(element.body)} className="text-block" />
          ) : (
            <QuestionView
              key={element.key}
              question={pipedQuestion(element)}
              number={questionNumbers.get(element.key) ?? 0}
              value={answers[element.key]}
              error={errors[element.key]}
              seed={props.seed}
              onChange={(v) => setAnswer(element.key, v)}
            />
          ),
        )}

        {props.beforeNav}
        <div className="nav">
          {definition.settings.allowBack && history.length > 0 ? (
            <button type="button" className="button secondary" onClick={onBack} disabled={submitting}>
              {ui.back}
            </button>
          ) : (
            <span />
          )}
          <button type="submit" className="button primary" disabled={submitting || props.busy}>
            {isLast ? (submitting ? ui.submitting : ui.submit) : ui.next}
          </button>
        </div>
        {props.status ? <div className="status">{props.status}</div> : null}
      </form>
      {props.footer}
      <div className="sr-only" aria-live="polite" aria-atomic="true">
        {announcement}
      </div>
    </main>
    </UiContext.Provider>
  );
}
