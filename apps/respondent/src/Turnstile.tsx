/**
 * Cloudflare Turnstile, loaded only for surveys that require a CAPTCHA. Tokens are single-use and
 * expire after a few minutes, so the parent can reset the widget (new `resetKey`) after a failure.
 */
import { useEffect, useRef, useState } from 'react';

interface TurnstileApi {
  render(el: HTMLElement, options: Record<string, unknown>): string;
  remove(id: string): void;
}
declare global {
  interface Window {
    turnstile?: TurnstileApi;
  }
}

const SCRIPT = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
let loading: Promise<void> | null = null;
function loadScript(): Promise<void> {
  loading ??= new Promise<void>((resolve, reject) => {
    const script = document.createElement('script');
    script.src = SCRIPT;
    script.async = true;
    script.onload = () => resolve();
    script.onerror = () => {
      loading = null;
      reject(new Error('Turnstile failed to load'));
    };
    document.head.appendChild(script);
  });
  return loading;
}

export function Turnstile({ siteKey, resetKey, onToken }: { siteKey: string; resetKey: number; onToken: (token: string | null) => void }) {
  const container = useRef<HTMLDivElement>(null);
  const callback = useRef(onToken);
  callback.current = onToken;
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let id: string | undefined;
    let cancelled = false;
    setFailed(false);
    loadScript()
      .then(() => {
        if (cancelled || !container.current || !window.turnstile) return;
        id = window.turnstile.render(container.current, {
          sitekey: siteKey,
          callback: (token: string) => callback.current(token),
          'expired-callback': () => callback.current(null),
          'error-callback': () => callback.current(null),
          language: 'auto',
        });
      })
      .catch(() => !cancelled && setFailed(true));
    return () => {
      cancelled = true;
      if (id && window.turnstile) window.turnstile.remove(id);
    };
  }, [siteKey, resetKey]);

  return (
    <div className="captcha">
      <p className="q-help">Before your answers are sent, please confirm you're a person.</p>
      <div ref={container} />
      {failed ? (
        <p className="q-error" role="alert">
          The check couldn't load. Check your connection, then reload the page.
        </p>
      ) : null}
    </div>
  );
}
