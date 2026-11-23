/**
 * Live preview: the real respondent app in an iframe, fed the draft over postMessage, so the
 * preview is exactly what respondents get (same renderer, same validation).
 */
import { useEffect, useRef } from 'react';
import type { SurveyDefinition, ThemeTokens } from '@survey/core';
import { cx } from '../../../components/ui';

export const RESPONDENT_URL =
  (import.meta.env.VITE_RESPONDENT_URL as string | undefined) ?? 'http://localhost:5174';
const RESPONDENT_ORIGIN = new URL(RESPONDENT_URL).origin;

export interface PreviewTheme {
  tokens: ThemeTokens;
  logoUrl: string | null;
}

export function PreviewFrame({
  definition,
  title,
  pageKey,
  device,
  theme = null,
}: {
  definition: SurveyDefinition;
  title: string;
  pageKey: string | null;
  device: 'desktop' | 'mobile';
  theme?: PreviewTheme | null;
}) {
  const frame = useRef<HTMLIFrameElement>(null);
  const latest = useRef({ definition, title, theme });
  latest.current = { definition, title, theme };
  const ready = useRef(false);

  const send = (message: object) => frame.current?.contentWindow?.postMessage(message, RESPONDENT_ORIGIN);

  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      if (event.origin !== RESPONDENT_ORIGIN || event.source !== frame.current?.contentWindow) return;
      if ((event.data as { type?: string })?.type === 'preview:ready') {
        ready.current = true;
        send({ type: 'preview:definition', ...latest.current });
      }
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, []);

  // Debounced so typing doesn't re-render the preview on every keystroke (still well under 1 s).
  useEffect(() => {
    if (!ready.current) return;
    const t = window.setTimeout(() => send({ type: 'preview:definition', definition, title, theme }), 150);
    return () => window.clearTimeout(t);
  }, [definition, title, theme]);

  useEffect(() => {
    if (ready.current && pageKey) send({ type: 'preview:goto', pageKey });
  }, [pageKey]);

  return (
    <div className="flex h-full justify-center overflow-hidden rounded-xl border border-line bg-gray-100">
      <iframe
        ref={frame}
        src={`${RESPONDENT_URL}/preview`}
        title={`Respondent preview (${device})`}
        className={cx('h-full bg-white', device === 'mobile' ? 'w-[390px] border-x border-line' : 'w-full')}
      />
    </div>
  );
}
