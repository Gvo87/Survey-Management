/**
 * Builder preview at /preview. The admin app embeds this page in an iframe and posts the draft
 * definition to it, so the preview runs exactly the code respondents run. Nothing is saved:
 * uploads stay in memory and completion runs the shared engine locally.
 */
import { useEffect, useMemo, useState } from 'react';
import { checkCompletion, completionRedirect, pipe, type SurveyDefinition, type ThemeTokens } from '@survey/core';
import { MessagePage, Paragraphs } from './Pages';
import { Runner } from './Runner';
import { applyTheme } from './theme';
import { previewUploader, UploadContext } from './uploads';

type Message =
  | {
      type: 'preview:definition';
      definition: SurveyDefinition;
      title: string;
      theme?: { tokens: ThemeTokens; logoUrl: string | null } | null;
      hidden?: Record<string, string>;
    }
  | { type: 'preview:goto'; pageKey: string };

const ADMIN_ORIGIN = import.meta.env.VITE_ADMIN_ORIGIN ?? 'http://localhost:5173';

interface Ending {
  title: string;
  body: string;
  note: string | null;
}

export function Preview() {
  const [survey, setSurvey] = useState<Extract<Message, { type: 'preview:definition' }> | null>(null);
  const [run, setRun] = useState(0);
  const [goto, setGoto] = useState<{ pageKey: string; nonce: number } | undefined>();
  const [ending, setEnding] = useState<Ending | null>(null);
  const uploader = useMemo(() => previewUploader(), []);

  useEffect(() => {
    const onMessage = (event: MessageEvent<Message>) => {
      if (event.origin !== ADMIN_ORIGIN || typeof event.data !== 'object' || !event.data) return;
      if (event.data.type === 'preview:definition') {
        setSurvey(event.data);
        applyTheme(event.data.theme?.tokens ?? null);
      }
      if (event.data.type === 'preview:goto') {
        setEnding(null);
        setGoto({ pageKey: event.data.pageKey, nonce: Date.now() });
      }
    };
    window.addEventListener('message', onMessage);
    window.parent?.postMessage({ type: 'preview:ready' }, ADMIN_ORIGIN);
    return () => window.removeEventListener('message', onMessage);
  }, []);

  if (!survey)
    return (
      <MessagePage title="Preview">
        <p>Waiting for the builder…</p>
      </MessagePage>
    );

  const restart = () => {
    setEnding(null);
    setRun((n) => n + 1);
  };
  const banner = (
    <div className="preview-banner" role="note">
      <span>Preview: answers aren't saved.</span>
      <button type="button" className="link-button" onClick={restart}>
        Restart
      </button>
    </div>
  );

  if (ending)
    return (
      <>
        <main className="survey">{banner}</main>
        <MessagePage title={ending.title} icon="✓">
          <Paragraphs text={ending.body} />
          {ending.note ? <p className="preview-note">{ending.note}</p> : null}
        </MessagePage>
      </>
    );

  if (survey.definition.pages.every((p) => p.elements.length === 0))
    return (
      <MessagePage title={survey.title}>
        <p>Add a question to see it here.</p>
      </MessagePage>
    );

  const hidden = survey.hidden ?? {};
  return (
    <UploadContext.Provider value={uploader}>
      <Runner
        key={run}
        definition={survey.definition}
        title={survey.title}
        hidden={hidden}
        logoUrl={survey.theme?.logoUrl}
        seed="preview"
        banner={banner}
        goto={goto}
        onSubmit={async (answers) => {
          const def = survey.definition;
          const result = checkCompletion(def, answers, hidden);
          if (!result.ok) return { ok: false, errors: result.errors };
          const ctx = { def, answers: result.answers, hidden };
          const screen =
            result.outcome === 'disqualified'
              ? (def.settings.disqualified ?? { title: 'Thank you for your time', body: "Unfortunately you don't qualify for this survey." })
              : def.settings.thankYou;
          const redirect = result.outcome === 'completed' ? completionRedirect(ctx) : null;
          setEnding({
            title: pipe(screen.title, ctx),
            body: pipe(screen.body, ctx),
            note:
              result.outcome === 'disqualified'
                ? 'Preview: this respondent was screened out by a logic rule.'
                : redirect
                  ? `Preview: respondents are sent to ${redirect}`
                  : null,
          });
          return { ok: true };
        }}
      />
    </UploadContext.Provider>
  );
}
