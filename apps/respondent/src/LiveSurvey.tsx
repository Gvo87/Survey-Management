/**
 * A live survey at /s/{publicId}.
 *
 * Reliability (docs/01-architecture.md §1.4b): answers are written to localStorage on every
 * change; every page sends the full answer snapshot with an increasing `seq`; failed sends are
 * retried with backoff until the server acknowledges them. The response key makes every retry
 * idempotent.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { CompleteResult, RespondentSurvey } from '@survey/contracts';
import { firstPageKey, type AnswerValue, type SurveyDefinition } from '@survey/core';
import { ApiError, completeResponse, loadSurvey, saveResponse } from './api';
import { Loading, MessagePage, Paragraphs } from './Pages';
import { Runner, type CompleteOutcome } from './Runner';
import {
  clearState,
  isDone,
  markDone,
  newResponseKey,
  readState,
  writeState,
  type LocalState,
} from './storage';

type Phase =
  | { kind: 'loading' }
  | { kind: 'running'; survey: RespondentSurvey; definition: SurveyDefinition; state: LocalState }
  | { kind: 'thanks'; title: string; body: string }
  | { kind: 'closed'; message: string }
  | { kind: 'already' }
  | { kind: 'not_found' }
  | { kind: 'reload' }
  | { kind: 'error'; message: string };

const backoff = (attempt: number) => Math.min(30_000, 1000 * 2 ** attempt) * (0.75 + Math.random() * 0.5);

export function LiveSurvey({ publicId }: { publicId: string }) {
  const [phase, setPhase] = useState<Phase>({ kind: 'loading' });
  const params = useMemo(() => new URLSearchParams(location.search), []);

  const load = useCallback(async () => {
    setPhase({ kind: 'loading' });
    let local = readState(publicId);
    let data: RespondentSurvey;
    try {
      data = await loadSurvey(publicId, local?.key ?? null, params.get('d'));
    } catch (error) {
      if (error instanceof ApiError && error.status === 404) return setPhase({ kind: 'not_found' });
      return setPhase({
        kind: 'error',
        message: "We couldn't load this survey. Check your connection and try again.",
      });
    }
    document.title = data.survey.title;
    if (data.resume?.status === 'completed' || data.resume?.status === 'disqualified') {
      clearState(publicId);
      markDone(publicId);
      return setPhase({ kind: 'already' });
    }
    if (data.access.state !== 'open' || !data.version)
      return setPhase({
        kind: 'closed',
        message: data.access.state === 'closed' ? data.access.message : 'This survey is closed.',
      });
    if (!data.resume && data.survey.onePerBrowser && isDone(publicId)) return setPhase({ kind: 'already' });

    const definition = data.version.definition;
    document.documentElement.lang = definition.defaultLocale;
    // Local state from an older version the server never saw: start over on the current one.
    if (local && local.versionId !== data.version.id && !data.resume) local = null;
    if (!local) {
      const hiddenFields: Record<string, string> = {};
      for (const field of definition.hiddenFields) {
        const value = params.get(field.key);
        if (value) hiddenFields[field.key] = value.slice(0, 500);
      }
      local = {
        key: newResponseKey(),
        versionId: data.version.id,
        seq: 0,
        ackedSeq: 0,
        answers: {},
        pageKey: firstPageKey(definition),
        history: [],
        start: {
          ...(params.get('d') ? { distributionToken: params.get('d')! } : {}),
          ...(params.get('test') ? { testToken: params.get('test')! } : {}),
          hiddenFields,
          locale: (navigator.language || 'en').slice(0, 10),
        },
      };
    }
    // The server is ahead (e.g. local storage was cleared): trust it.
    if (data.resume && data.resume.seq > local.seq) {
      local = {
        ...local,
        seq: data.resume.seq,
        ackedSeq: data.resume.seq,
        answers: data.resume.answers,
        pageKey: data.resume.currentPageKey ?? local.pageKey,
        history: [],
      };
    }
    writeState(publicId, local);
    setPhase({ kind: 'running', survey: data, definition, state: local });
  }, [publicId, params]);

  useEffect(() => {
    void load();
  }, [load]);

  switch (phase.kind) {
    case 'loading':
      return <Loading />;
    case 'running':
      return <RunningSurvey publicId={publicId} phase={phase} onPhase={setPhase} />;
    case 'thanks':
      return (
        <MessagePage title={phase.title} icon="✓">
          <Paragraphs text={phase.body} />
        </MessagePage>
      );
    case 'already':
      return (
        <MessagePage title="You've already responded" icon="✓">
          <p>Thank you, we have your answers.</p>
        </MessagePage>
      );
    case 'closed':
      return (
        <MessagePage title="This survey is closed">
          <p>{phase.message}</p>
        </MessagePage>
      );
    case 'not_found':
      return (
        <MessagePage title="Survey not found">
          <p>Check that the link is complete and try again.</p>
        </MessagePage>
      );
    case 'reload':
      return (
        <MessagePage title="This survey was just updated">
          <p>Please reload to continue with the latest version.</p>
          <button className="button primary" onClick={() => location.reload()}>
            Reload
          </button>
        </MessagePage>
      );
    case 'error':
      return (
        <MessagePage title="Something went wrong">
          <p>{phase.message}</p>
          <button className="button primary" onClick={() => void load()}>
            Try again
          </button>
        </MessagePage>
      );
  }
}

function RunningSurvey({
  publicId,
  phase,
  onPhase,
}: {
  publicId: string;
  phase: Extract<Phase, { kind: 'running' }>;
  onPhase: (phase: Phase) => void;
}) {
  const state = useRef<LocalState>(phase.state);
  const [offline, setOffline] = useState(false);
  const [submitStatus, setSubmitStatus] = useState<string | null>(null);
  const sending = useRef(false);
  const retryTimer = useRef<number | undefined>(undefined);
  const attempt = useRef(0);
  const stopped = useRef(false);

  const persist = (patch: Partial<LocalState>) => {
    state.current = { ...state.current, ...patch };
    writeState(publicId, state.current);
  };

  const body = () => ({
    seq: state.current.seq,
    start: { versionId: state.current.versionId, ...state.current.start },
    answers: state.current.answers,
    currentPageKey: state.current.pageKey,
  });

  /** Send the latest snapshot if the server hasn't acknowledged it yet. */
  const flush = useCallback(async () => {
    if (sending.current || stopped.current || state.current.ackedSeq >= state.current.seq) return;
    sending.current = true;
    const seq = state.current.seq;
    try {
      await saveResponse(publicId, state.current.key, body());
      persist({ ackedSeq: Math.max(state.current.ackedSeq, seq) });
      attempt.current = 0;
      setOffline(false);
    } catch (error) {
      if (error instanceof ApiError && !error.retryable) {
        const code = error.problem?.code;
        if (code === 'already_completed') return;
        if (code === 'version_changed') return onPhase({ kind: 'reload' });
        if (error.status === 410)
          return onPhase({ kind: 'closed', message: error.problem?.title ?? 'This survey is closed.' });
        return; // validation problems surface on submit
      }
      setOffline(true);
      window.clearTimeout(retryTimer.current);
      retryTimer.current = window.setTimeout(() => void flush(), backoff(attempt.current++));
    } finally {
      sending.current = false;
    }
    if (state.current.ackedSeq < state.current.seq) void flush(); // a newer snapshot arrived meanwhile
  }, [publicId]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    void flush(); // anything left from a previous visit
    const online = () => void flush();
    const hidden = () => document.visibilityState === 'hidden' && void flush();
    window.addEventListener('online', online);
    document.addEventListener('visibilitychange', hidden);
    return () => {
      window.removeEventListener('online', online);
      document.removeEventListener('visibilitychange', hidden);
      window.clearTimeout(retryTimer.current);
    };
  }, [flush]);

  const onChange = (answers: Record<string, AnswerValue>, pageKey: string, history: string[]) =>
    persist({ answers, pageKey, history });

  const onPageComplete = (answers: Record<string, AnswerValue>, nextPage: string) => {
    persist({ answers, pageKey: nextPage, seq: state.current.seq + 1 });
    void flush();
  };

  const onSubmit = async (answers: Record<string, AnswerValue>): Promise<CompleteOutcome> => {
    persist({ answers, seq: state.current.seq + 1 });
    window.clearTimeout(retryTimer.current);
    for (let tries = 0; ; tries++) {
      try {
        const result: CompleteResult = await completeResponse(publicId, state.current.key, body());
        stopped.current = true;
        clearState(publicId);
        markDone(publicId);
        onPhase({ kind: 'thanks', ...result.thankYou });
        return { ok: true };
      } catch (error) {
        if (error instanceof ApiError && !error.retryable) {
          setSubmitStatus(null);
          const problem = error.problem;
          if (error.status === 422 && problem?.errors) {
            return {
              ok: false,
              errors: problem.errors.map((e) => ({
                questionKey: e.path,
                pageKey: e.pageKey ?? '',
                code: 'required',
                message: e.message,
              })),
            };
          }
          if (problem?.code === 'version_changed') onPhase({ kind: 'reload' });
          else if (error.status === 410)
            onPhase({ kind: 'closed', message: problem?.title ?? 'This survey is closed.' });
          else onPhase({ kind: 'error', message: problem?.title ?? 'Your response could not be submitted.' });
          return { ok: true };
        }
        setSubmitStatus(
          "We can't reach the server. Your answers are saved on this device and we'll keep trying. Please keep this page open.",
        );
        await new Promise((r) => setTimeout(r, backoff(Math.min(tries, 5))));
      }
    }
  };

  const status =
    submitStatus ??
    (offline
      ? "You're offline. Your answers are saved on this device and will be sent when you reconnect."
      : null);

  return (
    <Runner
      definition={phase.definition}
      title={phase.survey.survey.title}
      anonymous={phase.survey.survey.anonymous}
      seed={phase.state.key}
      initialAnswers={phase.state.answers}
      initialPageKey={phase.state.pageKey}
      initialHistory={phase.state.history}
      onChange={onChange}
      onPageComplete={onPageComplete}
      onSubmit={onSubmit}
      status={status ? <p role="status">{status}</p> : null}
    />
  );
}
