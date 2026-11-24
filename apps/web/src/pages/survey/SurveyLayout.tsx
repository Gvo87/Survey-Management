import { createContext, useContext } from 'react';
import { Link, NavLink, Outlet, useParams } from 'react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { SurveyDetail } from '@survey/contracts';
import { errorMessage, get } from '../../api';
import { Alert, CopyButton, StatusBadge, cx } from '../../components/ui';

interface SurveyContextValue {
  survey: SurveyDetail;
  canEdit: boolean;
  refresh: () => void;
}

const SurveyContext = createContext<SurveyContextValue | null>(null);

export function useSurvey(): SurveyContextValue {
  const ctx = useContext(SurveyContext);
  if (!ctx) throw new Error('useSurvey outside SurveyLayout');
  return ctx;
}

export const surveyKey = (id: string) => ['survey', id] as const;

export function SurveyLayout() {
  const { id = '' } = useParams();
  const queryClient = useQueryClient();
  const query = useQuery({ queryKey: surveyKey(id), queryFn: () => get<SurveyDetail>(`/surveys/${id}`) });

  if (query.error) return <Alert tone="error">{errorMessage(query.error)}</Alert>;
  if (!query.data) return <p className="text-sm text-muted">Loading…</p>;

  const survey = query.data;
  const canEdit = survey.myRole !== 'viewer';
  const refresh = () => void queryClient.invalidateQueries({ queryKey: surveyKey(id) });
  const tab = ({ isActive }: { isActive: boolean }) =>
    cx(
      'border-b-2 px-1 pb-3 text-sm font-medium',
      isActive ? 'border-brand-600 text-brand-700' : 'border-transparent text-muted hover:text-ink',
    );

  return (
    <SurveyContext.Provider value={{ survey, canEdit, refresh }}>
      <div className="mb-4">
        <Link to="/surveys" className="text-sm text-muted hover:text-ink">
          ← All surveys
        </Link>
        <div className="mt-2 flex flex-wrap items-center gap-3">
          <h1 className="text-2xl font-semibold">{survey.title}</h1>
          <StatusBadge status={survey.status} />
          {survey.anonymous ? (
            <span className="rounded-full bg-violet-100 px-2.5 py-0.5 text-xs font-medium text-violet-800">
              Anonymous
            </span>
          ) : null}
          {survey.publicUrl ? (
            <span className="ml-auto flex items-center gap-2 text-sm">
              <a
                href={survey.publicUrl}
                target="_blank"
                rel="noreferrer"
                className="max-w-xs truncate text-brand-600 underline"
              >
                {survey.publicUrl.replace(/^https?:\/\//, '')}
              </a>
              <CopyButton text={survey.publicUrl} label="Copy link" />
            </span>
          ) : null}
        </div>
      </div>
      <nav aria-label="Survey sections" className="mb-6 flex gap-6 border-b border-line">
        {canEdit ? (
          <NavLink to="edit" className={tab}>
            Build
          </NavLink>
        ) : null}
        {canEdit ? (
          <NavLink to="distribute" className={tab}>
            Distribute
          </NavLink>
        ) : null}
        <NavLink to="results" className={tab}>
          Results
        </NavLink>
        <NavLink to="responses" className={tab}>
          Responses
        </NavLink>
        <NavLink to="comments" className={tab}>
          Comments
        </NavLink>
        <NavLink to="settings" className={tab}>
          Settings
        </NavLink>
      </nav>
      <Outlet />
    </SurveyContext.Provider>
  );
}
