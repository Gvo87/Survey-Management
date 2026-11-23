/**
 * Unsubscribe page for campaign emails (/u/{token}). No login: the personal token in the link is
 * the credential. Asking for a click (rather than unsubscribing on page load) stops link scanners
 * in mail systems from unsubscribing people by accident; mail clients use the one-click POST.
 */
import { useEffect, useState } from 'react';
import { ApiError, getUnsubscribe, postUnsubscribe } from './api';
import { Loading, MessagePage } from './Pages';

export function Unsubscribe({ token }: { token: string }) {
  const [info, setInfo] = useState<{ orgName: string; email: string; unsubscribed: boolean } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    document.title = 'Unsubscribe';
    getUnsubscribe(token)
      .then(setInfo)
      .catch((e) => setError(e instanceof ApiError && e.status === 404 ? 'This unsubscribe link is not valid.' : "We couldn't load this page. Try again."));
  }, [token]);

  if (error)
    return (
      <MessagePage title="Unsubscribe">
        <p>{error}</p>
      </MessagePage>
    );
  if (!info) return <Loading />;
  if (info.unsubscribed)
    return (
      <MessagePage title="You're unsubscribed" icon="✓">
        <p>
          {info.email} won't receive survey invitations from {info.orgName} any more.
        </p>
      </MessagePage>
    );
  return (
    <MessagePage title="Unsubscribe">
      <p>
        Stop survey invitations from {info.orgName} to {info.email}?
      </p>
      <div className="unsubscribe-actions">
        <button
          type="button"
          className="button primary"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            try {
              await postUnsubscribe(token);
              setInfo({ ...info, unsubscribed: true });
            } catch {
              setError("We couldn't unsubscribe you. Try again.");
            } finally {
              setBusy(false);
            }
          }}
        >
          {busy ? 'Unsubscribing…' : 'Unsubscribe'}
        </button>
      </div>
    </MessagePage>
  );
}
