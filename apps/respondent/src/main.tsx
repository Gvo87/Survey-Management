import { lazy, StrictMode, Suspense } from 'react';
import { createRoot } from 'react-dom/client';
import { LiveSurvey } from './LiveSurvey';
import { Loading, MessagePage } from './Pages';
import './styles.css';

// The builder preview is only ever opened from the admin app: keep it out of the respondent bundle.
const Preview = lazy(() => import('./Preview').then((m) => ({ default: m.Preview })));

const path = location.pathname;
const match = path.match(/^\/s\/([A-Za-z0-9]{6,20})\/?$/);

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {match ? (
      <LiveSurvey publicId={match[1]!} />
    ) : path === '/preview' ? (
      <Suspense fallback={<Loading />}>
        <Preview />
      </Suspense>
    ) : (
      <MessagePage title="Survey not found">
        <p>Check that the link is complete and try again.</p>
      </MessagePage>
    )}
  </StrictMode>,
);
