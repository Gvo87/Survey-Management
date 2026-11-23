import { lazy, StrictMode, Suspense } from 'react';
import { createRoot } from 'react-dom/client';
import { LiveSurvey } from './LiveSurvey';
import { Loading, MessagePage } from './Pages';
import './styles.css';

// The builder preview is only ever opened from the admin app: keep it out of the respondent bundle.
const Preview = lazy(() => import('./Preview').then((m) => ({ default: m.Preview })));
const Unsubscribe = lazy(() => import('./Unsubscribe').then((m) => ({ default: m.Unsubscribe })));

const path = location.pathname;
const match = path.match(/^\/s\/([A-Za-z0-9]{6,20})\/?$/);
const unsubscribe = path.match(/^\/u\/([A-Za-z0-9_-]{32})\/?$/);

// Embedded (embed.js): compact layout, and tell the host page how tall the survey is.
if (match && new URLSearchParams(location.search).get('embed') === '1' && window.parent !== window) {
  document.documentElement.dataset.embed = 'true';
  let last = 0;
  // The body's own height (the document's never drops below the frame's viewport, so it can't shrink).
  new ResizeObserver(() => {
    const height = Math.ceil(document.body.getBoundingClientRect().height);
    if (height !== last) window.parent.postMessage({ type: 'survey:resize', height: (last = height) }, '*');
  }).observe(document.body);
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {match ? (
      <LiveSurvey publicId={match[1]!} />
    ) : path === '/preview' ? (
      <Suspense fallback={<Loading />}>
        <Preview />
      </Suspense>
    ) : unsubscribe ? (
      <Suspense fallback={<Loading />}>
        <Unsubscribe token={unsubscribe[1]!} />
      </Suspense>
    ) : (
      <MessagePage title="Survey not found">
        <p>Check that the link is complete and try again.</p>
      </MessagePage>
    )}
  </StrictMode>,
);
