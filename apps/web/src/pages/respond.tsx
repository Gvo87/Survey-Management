/**
 * Phase 3B: login-required surveys. The respondent app sends members here (it runs on another origin and
 * never sees the admin session). Once signed in (password or SSO, through the usual login page), this page
 * asks the API for a one-time link and sends the member back to the survey with it.
 */
import { useEffect, useState } from 'react';
import { useParams, useSearchParams } from 'react-router';
import type { RespondentHandoffResult } from '@survey/contracts';
import { ApiError, errorMessage, post } from '../api';
import { useAuth } from '../auth';
import { Alert, Button, Spinner } from '../components/ui';

export function RespondHandoffPage() {
  const { publicId = '' } = useParams();
  const [params] = useSearchParams();
  const { me, logout } = useAuth();
  const [problem, setProblem] = useState<{ message: string; notMember: boolean } | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const lang = params.get('lang');
        const result = await post<RespondentHandoffResult>('/respondent-handoff', { publicId, ...(lang ? { lang } : {}) });
        // replace(): the one-time link mustn't stay in this tab's history.
        if (!cancelled) window.location.replace(result.url);
      } catch (e) {
        if (!cancelled) setProblem({ message: errorMessage(e), notMember: e instanceof ApiError && e.code === 'not_a_member' });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [publicId, params]);

  return (
    <main className="mx-auto max-w-md px-4 py-16">
      <h1 className="mb-4 text-xl font-semibold">Opening the survey</h1>
      {problem ? (
        <div className="flex flex-col gap-3">
          <Alert tone="error">{problem.message}</Alert>
          {problem.notMember ? (
            <Button
              className="self-start"
              onClick={() => void logout().then(() => window.location.assign(`/login?next=${encodeURIComponent(location.pathname + location.search)}`))}
            >
              Sign in as someone else
            </Button>
          ) : null}
        </div>
      ) : (
        <Spinner label={`Signed in as ${me?.user.email ?? ''}. Taking you to the survey…`} />
      )}
    </main>
  );
}
