/**
 * Draft state with autosave. Edits apply locally at once and are saved (debounced) with the
 * draft revision in If-Match; a 409 means someone else saved in between, and the user chooses
 * to load their version or overwrite it.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { Draft, DraftValidation, SaveDraftResult } from '@survey/contracts';
import { validateDefinition, type Issue, type SurveyDefinition } from '@survey/core';
import { ApiError, del, get, post, put } from '../../../api';

export type SaveState = 'saved' | 'unsaved' | 'saving' | 'offline' | 'error' | 'conflict';

export interface Conflict {
  updatedBy: string | null;
  updatedAt: string | null;
}

const SAVE_DELAY_MS = 800;

export function useDraft(surveyId: string, anonymous: boolean) {
  const queryClient = useQueryClient();
  const queryKey = useMemo(() => ['draft', surveyId], [surveyId]);
  const draftQuery = useQuery({
    queryKey,
    queryFn: () =>
      get<Draft>(`/surveys/${surveyId}/draft`).catch((e) => {
        if (e instanceof ApiError && e.status === 404) return null;
        throw e;
      }),
    staleTime: Infinity,
    refetchOnWindowFocus: false,
  });

  const [definition, setDefinition] = useState<SurveyDefinition | null>(null);
  const [saveState, setSaveState] = useState<SaveState>('saved');
  const [serverValidation, setServerValidation] = useState<DraftValidation | null>(null);
  const [conflict, setConflict] = useState<Conflict | null>(null);
  const latest = useRef<SurveyDefinition | null>(null);
  const revision = useRef(0);
  const dirty = useRef(false);
  const saving = useRef<Promise<void> | null>(null);
  const timer = useRef<number | undefined>(undefined);
  const blocked = useRef(false);

  // Adopt the server draft whenever it (re)loads.
  useEffect(() => {
    const draft = draftQuery.data;
    if (!draft) {
      if (draftQuery.data === null) setDefinition(null);
      return;
    }
    latest.current = draft.definition;
    revision.current = draft.revision;
    dirty.current = false;
    blocked.current = false;
    setDefinition(draft.definition);
    setServerValidation(draft.validation);
    setSaveState('saved');
    setConflict(null);
  }, [draftQuery.data]);

  const save = useCallback(async (): Promise<void> => {
    if (saving.current) return saving.current;
    if (!dirty.current || blocked.current || !latest.current) return;
    const run = (async () => {
      dirty.current = false;
      setSaveState('saving');
      try {
        const result = await put<SaveDraftResult>(
          `/surveys/${surveyId}/draft`,
          { definition: latest.current },
          { 'If-Match': `"rev-${revision.current}"` },
        );
        revision.current = result.revision;
        setServerValidation(result.validation);
        setSaveState(dirty.current ? 'unsaved' : 'saved');
      } catch (error) {
        dirty.current = true;
        if (error instanceof ApiError && error.code === 'revision_conflict') {
          blocked.current = true;
          setConflict({
            updatedBy: (error.problem?.updatedBy as string | null) ?? null,
            updatedAt: (error.problem?.updatedAt as string | null) ?? null,
          });
          setSaveState('conflict');
        } else if (error instanceof ApiError && (error.status === 0 || error.status >= 500)) {
          setSaveState('offline');
          window.clearTimeout(timer.current);
          timer.current = window.setTimeout(() => void save(), 3000);
        } else {
          blocked.current = true;
          setSaveState('error');
        }
      }
    })();
    saving.current = run;
    await run;
    saving.current = null;
    if (dirty.current && !blocked.current) {
      window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => void save(), SAVE_DELAY_MS);
    }
  }, [surveyId]);

  const update = useCallback(
    (fn: (def: SurveyDefinition) => SurveyDefinition) => {
      if (!latest.current) return;
      const next = fn(latest.current);
      if (next === latest.current) return;
      latest.current = next;
      dirty.current = true;
      setDefinition(next);
      if (!blocked.current) setSaveState('unsaved');
      window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => void save(), SAVE_DELAY_MS);
    },
    [save],
  );

  /** Save now and wait (before publishing). Returns false if the draft can't be saved. */
  const flush = useCallback(async (): Promise<boolean> => {
    window.clearTimeout(timer.current);
    for (let i = 0; i < 20 && (dirty.current || saving.current); i++) {
      if (blocked.current) return false;
      await (saving.current ?? save());
    }
    return !dirty.current && !blocked.current;
  }, [save]);

  const resolveConflict = useCallback(
    async (mode: 'theirs' | 'mine') => {
      const fresh = await get<Draft>(`/surveys/${surveyId}/draft`);
      if (mode === 'theirs') {
        queryClient.setQueryData(queryKey, fresh);
        return;
      }
      revision.current = fresh.revision;
      blocked.current = false;
      dirty.current = true;
      setConflict(null);
      await save();
    },
    [queryClient, queryKey, save, surveyId],
  );

  const createDraft = useCallback(async () => {
    queryClient.setQueryData(queryKey, await post<Draft>(`/surveys/${surveyId}/draft`));
  }, [queryClient, queryKey, surveyId]);

  const discardDraft = useCallback(async () => {
    await del(`/surveys/${surveyId}/draft`);
    queryClient.setQueryData(queryKey, null);
  }, [queryClient, queryKey, surveyId]);

  const markPublished = useCallback(() => queryClient.setQueryData(queryKey, null), [queryClient, queryKey]);

  // Warn before leaving with unsaved changes.
  useEffect(() => {
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      if (dirty.current || saving.current) e.preventDefault();
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => {
      window.removeEventListener('beforeunload', onBeforeUnload);
      window.clearTimeout(timer.current);
      if (dirty.current && !blocked.current) void save(); // save on navigating away inside the app
    };
  }, [save]);

  // Instant local validation, plus checks only the server can do (e.g. type changes vs. published versions).
  const issues: Issue[] = useMemo(() => {
    if (!definition) return [];
    const local = validateDefinition(definition, { anonymous });
    const localCodes = new Set(local.map((i) => `${i.code}:${i.path}`));
    const serverOnly = [...(serverValidation?.errors ?? []), ...(serverValidation?.warnings ?? [])].filter(
      (i) => !localCodes.has(`${i.code}:${i.path}`) && ['question_type_changed'].includes(i.code),
    );
    return [...local, ...serverOnly];
  }, [definition, serverValidation, anonymous]);

  return {
    loading: draftQuery.isPending,
    error: draftQuery.error,
    draft: draftQuery.data ?? null,
    definition,
    update,
    saveState,
    issues,
    conflict,
    resolveConflict,
    flush,
    revision: () => revision.current,
    createDraft,
    discardDraft,
    markPublished,
  };
}
