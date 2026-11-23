import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { LiveSurvey } from './LiveSurvey';
import { MessagePage } from './Pages';
import { Preview } from './Preview';
import './styles.css';

const path = location.pathname;
const match = path.match(/^\/s\/([A-Za-z0-9]{6,20})\/?$/);

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {match ? (
      <LiveSurvey publicId={match[1]!} />
    ) : path === '/preview' ? (
      <Preview />
    ) : (
      <MessagePage title="Survey not found">
        <p>Check that the link is complete and try again.</p>
      </MessagePage>
    )}
  </StrictMode>,
);
