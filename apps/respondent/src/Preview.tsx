/**
 * Builder preview at /preview. The admin app embeds this page in an iframe and posts the draft
 * definition to it, so the preview runs exactly the code respondents run. Nothing is saved.
 */
import { useEffect, useState } from 'react';
import { checkCompletion, type SurveyDefinition } from '@survey/core';
import { MessagePage, Paragraphs } from './Pages';
import { Runner } from './Runner';

type Message =
  | { type: 'preview:definition'; definition: SurveyDefinition; title: string }
  | { type: 'preview:goto'; pageKey: string };

const ADMIN_ORIGIN = import.meta.env.VITE_ADMIN_ORIGIN ?? 'http://localhost:5173';

export function Preview() {
  const [survey, setSurvey] = useState<{ definition: SurveyDefinition; title: string } | null>(null);
  const [run, setRun] = useState(0);
  const [goto, setGoto] = useState<{ pageKey: string; nonce: number } | undefined>();
  const [thanks, setThanks] = useState<{ title: string; body: string } | null>(null);

  useEffect(() => {
    const onMessage = (event: MessageEvent<Message>) => {
      if (event.origin !== ADMIN_ORIGIN || typeof event.data !== 'object' || !event.data) return;
      if (event.data.type === 'preview:definition')
        setSurvey({ definition: event.data.definition, title: event.data.title });
      if (event.data.type === 'preview:goto') {
        setThanks(null);
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
    setThanks(null);
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

  if (thanks)
    return (
      <>
        <main className="survey">{banner}</main>
        <MessagePage title={thanks.title} icon="✓">
          <Paragraphs text={thanks.body} />
        </MessagePage>
      </>
    );

  if (survey.definition.pages.every((p) => p.elements.length === 0))
    return (
      <MessagePage title={survey.title}>
        <p>Add a question to see it here.</p>
      </MessagePage>
    );

  return (
    <Runner
      key={run}
      definition={survey.definition}
      title={survey.title}
      seed="preview"
      banner={banner}
      goto={goto}
      onSubmit={async (answers) => {
        const result = checkCompletion(survey.definition, answers);
        if (!result.ok) return { ok: false, errors: result.errors };
        setThanks(survey.definition.settings.thankYou);
        return { ok: true };
      }}
    />
  );
}
