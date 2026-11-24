/**
 * A live survey at /s/{publicId}.
 *
 * Reliability (docs/01-architecture.md §1.4b): answers are written to localStorage on every
 * change; every page sends the full answer snapshot with an increasing `seq`; failed sends are
 * retried with backoff until the server acknowledges them. The response key makes every retry
 * idempotent.
 *
 * Phase 2A: password gate, "opens on" page, CAPTCHA before the first save, themes, file uploads,
 * screen-out (disqualified) endings and redirects after completion.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import type { RespondentSurvey } from '@survey/contracts';
import { firstPageKey, type AnswerValue, type SurveyDefinition } from '@survey/core';
import { ApiError, completeResponse, emailResumeLink, loadSurvey, readMemberResponseKey, removeFile, saveResponse, signIn, unlock, uploadFile } from './api';
import { Loading, MessagePage, Paragraphs } from './Pages';
import { Runner, type CompleteOutcome } from './Runner';
import { clearState, isDone, markDone, newResponseKey, readState, writeState, type LocalState } from './storage';
import { applyTheme } from './theme';
import { Turnstile } from './Turnstile';
import { UploadContext, type Uploader } from './uploads';

type Phase =
  | { kind: 'loading' }
  | { kind: 'running'; survey: RespondentSurvey; definition: SurveyDefinition; state: LocalState; hidden: Record<string, string> }
  | { kind: 'thanks'; title: string; body: string; redirectUrl: string | null; screenedOut: boolean }
  | { kind: 'closed'; message: string }
  | { kind: 'not_yet_open'; opensAt: string }
  | { kind: 'locked'; title: string }
  | { kind: 'already' }
  | { kind: 'already_campaign' }
  | { kind: 'not_found' }
  | { kind: 'reload' }
  | { kind: 'login'; title: string; loginUrl: string; expired: boolean }
  | { kind: 'error'; message: string };

const backoff = (attempt: number) => Math.min(30_000, 1000 * 2 ** attempt) * (0.75 + Math.random() * 0.5);

/** The hidden fields the server will store: link presets win over URL parameters; anonymous surveys keep only non-identifying ones. */
function effectiveHiddenFields(definition: SurveyDefinition, anonymous: boolean, fromUrl: Record<string, string>, preset: Record<string, string>) {
  const out: Record<string, string> = {};
  for (const field of definition.hiddenFields) {
    if (anonymous && !field.nonIdentifying) continue;
    const value = preset[field.key] ?? fromUrl[field.key];
    if (value) out[field.key] = value.slice(0, 500);
  }
  return out;
}

export function LiveSurvey({ publicId }: { publicId: string }) {
  const [phase, setPhase] = useState<Phase>({ kind: 'loading' });
  const params = useMemo(() => new URLSearchParams(location.search), []);

  const load = useCallback(async () => {
    setPhase({ kind: 'loading' });
    let local = readState(publicId);
    // Phase 3B: back from signing in on the admin app (#rt=…, one-time). The member's response key is the
    // same on every device, so it replaces any other response this browser started.
    const handoff = /^#rt=([A-Za-z0-9_.-]{20,1000})$/.exec(location.hash)?.[1] ?? null;
    let loginExpired = false;
    if (handoff) {
      history.replaceState(null, '', location.pathname + location.search);
      try {
        await signIn(publicId, handoff);
      } catch {
        loginExpired = true;
      }
    }
    const memberKey = readMemberResponseKey(publicId);
    if (memberKey && local?.key !== memberKey) local = null;
    // A personal campaign link (?t=) or an emailed resume link (#k=) decide which response this is.
    const recipientToken = /^[A-Za-z0-9_-]{32}$/.test(params.get('t') ?? '') ? params.get('t') : null;
    const fragmentKey = /^#k=([A-Za-z0-9_-]{22,128})$/.exec(location.hash)?.[1] ?? null;
    if (fragmentKey) history.replaceState(null, '', location.pathname + location.search);
    if (fragmentKey && local?.key !== fragmentKey) local = null;
    let key = memberKey ?? fragmentKey ?? recipientToken ?? local?.key ?? null;
    let data: RespondentSurvey;
    const lang = params.get('lang');
    try {
      data = await loadSurvey(publicId, key, params.get('d'), recipientToken, lang);
      // Anonymous surveys never use the personal token as the response key: look up this browser's own.
      if (data.survey.anonymous && recipientToken && !fragmentKey && local && key !== local.key) {
        key = local.key;
        data = await loadSurvey(publicId, key, params.get('d'), recipientToken, lang);
      }
    } catch (error) {
      if (error instanceof ApiError && error.status === 404) return setPhase({ kind: 'not_found' });
      return setPhase({ kind: 'error', message: "We couldn't load this survey. Check your connection and try again." });
    }
    document.title = data.survey.title;
    // Phase 3B: the served language, mirrored for right-to-left scripts.
    document.documentElement.lang = data.language.locale;
    document.documentElement.dir = data.language.dir;
    applyTheme(data.theme?.tokens ?? null);
    if (data.resume?.status === 'completed' || data.resume?.status === 'disqualified') {
      clearState(publicId);
      markDone(publicId);
      return setPhase({ kind: 'already' });
    }
    if (data.access.state === 'already_responded') {
      clearState(publicId);
      return setPhase({ kind: 'already_campaign' });
    }
    if (data.access.state === 'password_required') return setPhase({ kind: 'locked', title: data.survey.title });
    if (data.access.state === 'login_required')
      return setPhase({ kind: 'login', title: data.survey.title, loginUrl: data.access.loginUrl, expired: loginExpired });
    if (data.access.state === 'not_yet_open') return setPhase({ kind: 'not_yet_open', opensAt: data.access.opensAt });
    if (data.access.state !== 'open' || !data.version)
      return setPhase({ kind: 'closed', message: data.access.state === 'closed' ? data.access.message : 'This survey is closed.' });
    if (!data.resume && data.survey.onePerBrowser && isDone(publicId)) return setPhase({ kind: 'already' });

    const definition = data.version.definition;
    // Local state from an older version the server never saw: start over on the current one.
    if (local && local.versionId !== data.version.id && !data.resume) local = null;
    // Non-anonymous campaign links: the personal token is the response key, so the same link resumes on any device.
    const preferredKey = fragmentKey ?? (recipientToken && !data.survey.anonymous ? recipientToken : null);
    if (local && preferredKey && local.key !== preferredKey) local = null;
    if (!local) {
      const fromUrl: Record<string, string> = {};
      for (const field of definition.hiddenFields) {
        const value = params.get(field.key);
        if (value) fromUrl[field.key] = value.slice(0, 500);
      }
      const hiddenFields = effectiveHiddenFields(definition, data.survey.anonymous, fromUrl, data.presetHiddenFields);
      local = {
        key: memberKey ?? preferredKey ?? newResponseKey(),
        versionId: data.version.id,
        seq: 0,
        ackedSeq: 0,
        answers: {},
        pageKey: firstPageKey(definition, { answers: {}, hidden: hiddenFields }),
        history: [],
        start: {
          ...(params.get('d') ? { distributionToken: params.get('d')! } : {}),
          ...(params.get('test') ? { testToken: params.get('test')! } : {}),
          ...(recipientToken ? { recipientToken } : {}),
          hiddenFields,
          locale: data.language.locale,
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
    // Logic uses what the server stored for an existing response, so both sides agree.
    const hidden = data.resume ? data.resume.hiddenFields : local.start.hiddenFields;
    setPhase({ kind: 'running', survey: data, definition, state: local, hidden });
  }, [publicId, params]);

  useEffect(() => {
    void load();
  }, [load]);

  switch (phase.kind) {
    case 'loading':
      return <Loading />;
    case 'running':
      return (
        <RunningSurvey
          publicId={publicId}
          phase={phase}
          onPhase={setPhase}
          onReload={() => void load()}
          onLanguage={(locale) => {
            // Answers are kept (they're keyed, not worded): only the text changes.
            params.set('lang', locale);
            history.replaceState(null, '', `${location.pathname}?${params}${location.hash}`);
            void load();
          }}
        />
      );
    case 'thanks':
      return <ThankYou {...phase} />;
    case 'locked':
      return <PasswordGate publicId={publicId} title={phase.title} onUnlocked={() => void load()} />;
    case 'login':
      return (
        <MessagePage title={phase.title}>
          <p>{phase.expired ? 'That sign-in link has expired. Sign in again to continue.' : 'This survey is for members of the organization that runs it. Sign in to answer.'}</p>
          <p>
            <a className="button primary" href={phase.loginUrl} target={document.documentElement.dataset.embed ? '_blank' : undefined} rel="noopener">
              Sign in to continue
            </a>
          </p>
        </MessagePage>
      );
    case 'not_yet_open':
      return (
        <MessagePage title="This survey isn't open yet">
          <p>
            It opens on{' '}
            {new Intl.DateTimeFormat(undefined, { dateStyle: 'full', timeStyle: 'short' }).format(new Date(phase.opensAt))}. Please come back
            then.
          </p>
        </MessagePage>
      );
    case 'already':
      return (
        <MessagePage title="You've already responded" icon="✓">
          <p>Thank you, we have your answers.</p>
        </MessagePage>
      );
    case 'already_campaign':
      return (
        <MessagePage title="You've already responded" icon="✓">
          <p>This personal link has already been used to answer the survey. Thank you!</p>
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

/** "Finish later": email a link that resumes this response on any device. */
function ResumeByEmail({ send }: { send: (email: string) => Promise<void> }) {
  const [open, setOpen] = useState(false);
  const [email, setEmail] = useState('');
  const [state, setState] = useState<'idle' | 'sending' | 'sent' | 'error'>('idle');
  const [message, setMessage] = useState('');
  if (!open)
    return (
      <p className="resume-later">
        <button type="button" className="link-button" onClick={() => setOpen(true)}>
          Finish later? Email me a link
        </button>
      </p>
    );
  return (
    <form
      className="resume-later"
      noValidate
      onSubmit={async (e) => {
        e.preventDefault();
        if (!/^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/.test(email.trim())) {
          setState('error');
          setMessage('Enter a valid email address, like name@example.com.');
          return;
        }
        setState('sending');
        try {
          await send(email.trim());
          setState('sent');
          setMessage('Sent. Open the link in the email to pick up where you left off, on any device.');
        } catch (error) {
          setState('error');
          setMessage(error instanceof ApiError && error.problem ? error.problem.title : (error as Error).message || "We couldn't send the email. Try again.");
        }
      }}
    >
      <label className="q-title" htmlFor="resume-email">
        Email me a link to finish later
      </label>
      <p className="q-help" id="resume-email-help">
        We only use this address to send the link. Anyone with the link can see your answers.
      </p>
      <div className="resume-row">
        <input
          id="resume-email"
          className="text-input"
          type="email"
          autoComplete="email"
          value={email}
          aria-describedby="resume-email-help resume-email-status"
          aria-invalid={state === 'error' ? true : undefined}
          onChange={(e) => setEmail(e.target.value)}
        />
        <button type="submit" className="button secondary" disabled={state === 'sending'}>
          {state === 'sending' ? 'Sending…' : 'Send link'}
        </button>
      </div>
      <p id="resume-email-status" className={state === 'error' ? 'q-error' : 'q-help'} role="status">
        {message}
      </p>
    </form>
  );
}

function ThankYou({ title, body, redirectUrl, screenedOut }: { title: string; body: string; redirectUrl: string | null; screenedOut: boolean }) {
  // Redirect straight away (no countdown to race against); the page stays as a fallback.
  useEffect(() => {
    if (redirectUrl) location.replace(redirectUrl);
  }, [redirectUrl]);
  return (
    <MessagePage title={title} icon={screenedOut ? undefined : '✓'}>
      <Paragraphs text={body} />
      {redirectUrl ? (
        <p>
          <a href={redirectUrl}>Continue</a>
        </p>
      ) : null}
    </MessagePage>
  );
}

function PasswordGate({ publicId, title, onUnlocked }: { publicId: string; title: string; onUnlocked: () => void }) {
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!password) return setError('Enter the password.');
    setBusy(true);
    setError(null);
    try {
      await unlock(publicId, password);
      onUnlocked();
    } catch (e) {
      const problem = e instanceof ApiError ? e.problem : null;
      setError(
        problem?.code === 'wrong_password'
          ? "That password isn't right. Check it and try again."
          : e instanceof ApiError && e.status === 429
            ? 'Too many attempts. Wait a few minutes and try again.'
            : "We couldn't check the password. Check your connection and try again.",
      );
    } finally {
      setBusy(false);
    }
  };
  return (
    <MessagePage title={title}>
      <form className="password-gate" onSubmit={submit} noValidate>
        <p>This survey is password protected.</p>
        <label className="q-title" htmlFor="survey-password">
          Password
        </label>
        {error ? (
          <p className="q-error" id="survey-password-error" role="alert">
            <span aria-hidden="true">⚠ </span>
            {error}
          </p>
        ) : null}
        <input
          id="survey-password"
          className="text-input"
          type="password"
          autoComplete="off"
          value={password}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? 'survey-password-error' : undefined}
          onChange={(e) => setPassword(e.target.value)}
        />
        <div className="nav">
          <span />
          <button type="submit" className="button primary" disabled={busy}>
            {busy ? 'Checking…' : 'Continue'}
          </button>
        </div>
      </form>
    </MessagePage>
  );
}

/** Phase 3B: shown when the survey has more than one language. Names come from the browser (Intl). */
function LanguagePicker({ survey, onPick }: { survey: RespondentSurvey; onPick: (locale: string) => void }) {
  const { available, locale, ui } = survey.language;
  if (available.length < 2) return null;
  const name = (code: string) => {
    try {
      return new Intl.DisplayNames([code], { type: 'language' }).of(code) ?? code;
    } catch {
      return code;
    }
  };
  return (
    <div className="language-picker">
      <label htmlFor="survey-language">{ui.language}</label>
      <select id="survey-language" className="select-input" value={locale} onChange={(e) => onPick(e.target.value)}>
        {available.map((code) => (
          <option key={code} value={code} lang={code}>
            {name(code)}
          </option>
        ))}
      </select>
    </div>
  );
}

function RunningSurvey({
  publicId,
  phase,
  onPhase,
  onReload,
  onLanguage,
}: {
  publicId: string;
  phase: Extract<Phase, { kind: 'running' }>;
  onPhase: (phase: Phase) => void;
  onReload: () => void;
  onLanguage: (locale: string) => void;
}) {
  const state = useRef<LocalState>(phase.state);
  const [offline, setOffline] = useState(false);
  const [submitStatus, setSubmitStatus] = useState<string | null>(null);
  const sending = useRef(false);
  const retryTimer = useRef<number | undefined>(undefined);
  const attempt = useRef(0);
  const stopped = useRef(false);

  // CAPTCHA: needed until the server has the response (the first save carries the token).
  const siteKey = phase.survey.captchaSiteKey;
  const [captchaToken, setCaptchaToken] = useState<string | null>(null);
  const [captchaReset, setCaptchaReset] = useState(0);
  const [started, setStarted] = useState(phase.state.ackedSeq > 0 || phase.survey.resume !== null);
  const needsCaptcha = Boolean(siteKey) && !started;
  const token = useRef<string | null>(null);
  token.current = captchaToken;
  const waiters = useRef<(() => void)[]>([]);

  const persist = (patch: Partial<LocalState>) => {
    state.current = { ...state.current, ...patch };
    writeState(publicId, state.current);
  };

  const body = () => ({
    seq: state.current.seq,
    start: {
      versionId: state.current.versionId,
      ...state.current.start,
      ...(token.current && state.current.ackedSeq === 0 ? { captchaToken: token.current } : {}),
    },
    answers: state.current.answers,
    currentPageKey: state.current.pageKey,
    locale: phase.survey.language.locale,
  });

  const acknowledged = (seq: number) => {
    persist({ ackedSeq: Math.max(state.current.ackedSeq, seq) });
    setStarted(true);
    for (const resolve of waiters.current.splice(0)) resolve();
  };

  /** Send the latest snapshot if the server hasn't acknowledged it yet. */
  const flush = useCallback(async () => {
    if (sending.current || stopped.current || state.current.ackedSeq >= state.current.seq) return;
    // A new response can't start without a CAPTCHA token; it's sent as soon as there is one.
    if (siteKey && state.current.ackedSeq === 0 && !token.current) return;
    sending.current = true;
    const seq = state.current.seq;
    try {
      await saveResponse(publicId, state.current.key, body());
      acknowledged(seq);
      attempt.current = 0;
      setOffline(false);
    } catch (error) {
      if (error instanceof ApiError && !error.retryable) {
        const code = error.problem?.code;
        if (code === 'already_completed') return;
        if (code === 'already_responded') return onPhase({ kind: 'already_campaign' });
        if (code === 'version_changed') return onPhase({ kind: 'reload' });
        if (code === 'captcha_failed') {
          // Tokens are single-use and expire: get a fresh one.
          setCaptchaToken(null);
          setCaptchaReset((n) => n + 1);
          return;
        }
        if (code === 'password_required') return onPhase({ kind: 'locked', title: phase.survey.survey.title });
        if (code === 'login_required') return void onReload();
        if (error.status === 410) return onPhase({ kind: 'closed', message: error.problem?.title ?? 'This survey is closed.' });
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

  // A token arriving releases any save that was waiting for it.
  useEffect(() => {
    if (captchaToken) void flush();
  }, [captchaToken, flush]);

  /** Make sure the server has the response (uploads need it). */
  const ensureStarted = async () => {
    if (state.current.ackedSeq > 0) return;
    if (siteKey && !token.current) throw new Error('Please complete the “confirm you’re a person” check first, then add the file again.');
    if (state.current.seq === 0) persist({ seq: 1 });
    const done = new Promise<void>((resolve) => waiters.current.push(resolve));
    void flush();
    await Promise.race([done, new Promise((_, reject) => setTimeout(() => reject(new Error('We couldn’t reach the server. Try again.')), 20_000))]);
  };

  const uploader = useMemo<Uploader>(
    () => ({
      async upload(questionKey, file) {
        await ensureStarted();
        try {
          const uploaded = await uploadFile(publicId, state.current.key, questionKey, file);
          persist({ files: { ...state.current.files, [uploaded.fileId]: { name: uploaded.filename, size: uploaded.size } } });
          return { fileId: uploaded.fileId, name: uploaded.filename, size: uploaded.size };
        } catch (error) {
          if (error instanceof ApiError && error.problem) throw new Error(error.problem.title);
          throw new Error(`"${file.name}" couldn't be uploaded. Check your connection and try again.`);
        }
      },
      async remove(fileId) {
        await removeFile(publicId, state.current.key, fileId);
      },
      info: (fileId) => state.current.files?.[fileId],
    }),
    [publicId], // eslint-disable-line react-hooks/exhaustive-deps
  );

  const onChange = (answers: Record<string, AnswerValue>, pageKey: string, history: string[]) => persist({ answers, pageKey, history });

  const onPageComplete = (answers: Record<string, AnswerValue>, nextPage: string) => {
    persist({ answers, pageKey: nextPage, seq: state.current.seq + 1 });
    void flush();
  };

  const onSubmit = async (answers: Record<string, AnswerValue>): Promise<CompleteOutcome> => {
    if (needsCaptcha && !token.current) {
      setSubmitStatus('Please complete the check above, then submit again.');
      return { ok: true };
    }
    persist({ answers, seq: state.current.seq + 1 });
    window.clearTimeout(retryTimer.current);
    for (let tries = 0; ; tries++) {
      try {
        const result = await completeResponse(publicId, state.current.key, body());
        stopped.current = true;
        clearState(publicId);
        markDone(publicId);
        if (document.documentElement.dataset.embed) window.parent.postMessage({ type: 'survey:completed' }, '*');
        onPhase({ kind: 'thanks', ...result.thankYou, redirectUrl: result.redirectUrl, screenedOut: result.responseStatus === 'disqualified' });
        return { ok: true };
      } catch (error) {
        if (error instanceof ApiError && !error.retryable) {
          setSubmitStatus(null);
          const problem = error.problem;
          if (error.status === 422 && problem?.errors) {
            return {
              ok: false,
              errors: problem.errors.map((e) => ({ questionKey: e.path, pageKey: e.pageKey ?? '', code: 'required', message: e.message })),
            };
          }
          if (problem?.code === 'captcha_failed') {
            setCaptchaToken(null);
            setCaptchaReset((n) => n + 1);
            setSubmitStatus('Please complete the check above again, then submit.');
            return { ok: true };
          }
          if (problem?.code === 'already_responded') onPhase({ kind: 'already_campaign' });
          else if (problem?.code === 'version_changed') onPhase({ kind: 'reload' });
          else if (problem?.code === 'password_required') onPhase({ kind: 'locked', title: phase.survey.survey.title });
          else if (error.status === 410) onPhase({ kind: 'closed', message: problem?.title ?? 'This survey is closed.' });
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
    submitStatus ?? (offline ? "You're offline. Your answers are saved on this device and will be sent when you reconnect." : null);

  return (
    <UploadContext.Provider value={uploader}>
      <Runner
        definition={phase.definition}
        title={phase.survey.survey.title}
        anonymous={phase.survey.survey.anonymous}
        hidden={phase.hidden}
        contact={phase.survey.contact}
        logoUrl={phase.survey.theme?.logoUrl}
        footer={
          phase.survey.survey.anonymous ? null : (
            <ResumeByEmail
              send={async (email) => {
                await ensureStarted();
                await emailResumeLink(publicId, state.current.key, email);
              }}
            />
          )
        }
        seed={phase.state.key}
        initialAnswers={phase.state.answers}
        initialPageKey={phase.state.pageKey}
        initialHistory={phase.state.history}
        onChange={onChange}
        onPageComplete={onPageComplete}
        onSubmit={onSubmit}
        ui={phase.survey.language.ui}
        headerExtra={<LanguagePicker survey={phase.survey} onPick={onLanguage} />}
        beforeNav={needsCaptcha && siteKey ? <Turnstile siteKey={siteKey} resetKey={captchaReset} onToken={setCaptchaToken} /> : null}
        status={status ? <p role="status">{status}</p> : null}
      />
    </UploadContext.Provider>
  );
}
