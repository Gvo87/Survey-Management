/** Comments on drafts (Phase 3A): threads anchored to the survey, a page or a question. */
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { Comment, Draft, SurveyDetail, VersionDetail, VersionSummary } from '@survey/contracts';
import { listQuestions, plainTitle, type SurveyDefinition } from '@survey/core';
import { ApiError, del, errorMessage, get, patch, post } from '../../api';
import { Alert, Badge, Button, Card, TextArea, cx } from '../../components/ui';
import { relativeTime } from '../../lib/format';
import { useSurvey } from './SurveyLayout';

/** The definition reviewers comment on: the draft, or the live version when there's no draft. */
function useReviewDefinition(survey: SurveyDetail) {
  return useQuery({
    queryKey: ['review-definition', survey.id, survey.updatedAt],
    queryFn: async (): Promise<{ definition: SurveyDefinition; label: string }> => {
      try {
        const draft = await get<Draft>(`/surveys/${survey.id}/draft`);
        return { definition: draft.definition, label: `Draft (revision ${draft.revision})` };
      } catch (e) {
        if (!(e instanceof ApiError && e.status === 404)) throw e;
      }
      const versions = await get<VersionSummary[]>(`/surveys/${survey.id}/versions`);
      const latest = versions[0];
      if (!latest) throw new Error('This survey has no content yet.');
      const version = await get<VersionDetail>(`/surveys/${survey.id}/versions/${latest.id}`);
      return { definition: version.definition, label: `Version ${version.versionNumber} (live)` };
    },
  });
}

export function CommentsPage() {
  const { survey } = useSurvey();
  const review = useReviewDefinition(survey);
  return (
    <div className="max-w-4xl">
      {review.error ? <Alert tone="error">{errorMessage(review.error)}</Alert> : null}
      {review.data ? (
        <>
          <p className="mb-4 text-sm text-muted">
            Reviewing: {review.data.label}
            {survey.pendingApproval ? ' · waiting for approval' : ''}. Comments are only visible to your team,
            never to respondents.
          </p>
          <CommentsPanel survey={survey} definition={review.data.definition} />
        </>
      ) : null}
    </div>
  );
}

interface Thread {
  root: Comment;
  replies: Comment[];
}

/** All threads grouped by where they're anchored. With `onlyAnchor`, just that question's or page's. */
export function CommentsPanel({
  survey,
  definition,
  onlyAnchor,
}: {
  survey: SurveyDetail;
  definition: SurveyDefinition;
  onlyAnchor?: string | null;
}) {
  const key = ['comments', survey.id];
  const comments = useQuery({
    queryKey: key,
    queryFn: () => get<Comment[]>(`/surveys/${survey.id}/comments`),
  });
  const [showResolved, setShowResolved] = useState(false);
  const threads = new Map<string | null, Thread[]>();
  for (const c of comments.data ?? []) {
    if (c.parentId) continue;
    const list = threads.get(c.anchorKey) ?? [];
    list.push({ root: c, replies: (comments.data ?? []).filter((r) => r.parentId === c.id) });
    threads.set(c.anchorKey, list);
  }
  const resolvedCount = (comments.data ?? []).filter((c) => !c.parentId && c.resolvedAt).length;
  const anchors: { key: string | null; label: string; level: 'survey' | 'page' | 'question' }[] = [
    { key: null, label: 'The survey as a whole', level: 'survey' },
  ];
  const questionNumber = new Map(listQuestions(definition).map((q, i) => [q.key, i + 1]));
  definition.pages.forEach((page, i) => {
    anchors.push({
      key: page.key,
      label: page.title ? `Page ${i + 1}: ${page.title}` : `Page ${i + 1}`,
      level: 'page',
    });
    for (const element of page.elements)
      if (element.kind === 'question')
        anchors.push({
          key: element.key,
          label: `Q${questionNumber.get(element.key)}. ${plainTitle(element)}`,
          level: 'question',
        });
  });
  const shown = onlyAnchor !== undefined ? anchors.filter((a) => a.key === onlyAnchor) : anchors;

  return (
    <div className="flex flex-col gap-3">
      {comments.error ? <Alert tone="error">{errorMessage(comments.error)}</Alert> : null}
      {resolvedCount ? (
        <Button
          size="sm"
          variant="ghost"
          className="self-start"
          aria-pressed={showResolved}
          onClick={() => setShowResolved((v) => !v)}
        >
          {showResolved ? 'Hide' : 'Show'} {resolvedCount} resolved thread{resolvedCount === 1 ? '' : 's'}
        </Button>
      ) : null}
      {shown.map((anchor) => (
        <AnchorSection
          key={anchor.key ?? 'survey'}
          survey={survey}
          anchor={anchor}
          threads={(threads.get(anchor.key) ?? []).filter((t) => showResolved || !t.root.resolvedAt)}
          compact={onlyAnchor !== undefined}
        />
      ))}
    </div>
  );
}

function AnchorSection({
  survey,
  anchor,
  threads,
  compact,
}: {
  survey: SurveyDetail;
  anchor: { key: string | null; label: string; level: 'survey' | 'page' | 'question' };
  threads: Thread[];
  compact: boolean;
}) {
  const queryClient = useQueryClient();
  const [writing, setWriting] = useState(compact);
  const [body, setBody] = useState('');
  const add = useMutation({
    mutationFn: () => post<Comment>(`/surveys/${survey.id}/comments`, { body, anchorKey: anchor.key }),
    onSuccess: () => {
      setBody('');
      setWriting(compact);
      void queryClient.invalidateQueries({ queryKey: ['comments', survey.id] });
    },
  });
  const content = (
    <>
      {threads.map((t) => (
        <ThreadView key={t.root.id} survey={survey} thread={t} />
      ))}
      {writing ? (
        <form
          className="flex flex-col gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            add.mutate();
          }}
        >
          <TextArea
            label={`Comment on ${anchor.level === 'survey' ? 'the survey' : `this ${anchor.level}`}`}
            rows={2}
            value={body}
            onChange={(e) => setBody(e.target.value)}
            maxLength={5000}
          />
          {add.error ? <Alert tone="error">{errorMessage(add.error)}</Alert> : null}
          <div className="flex gap-2">
            <Button type="submit" size="sm" variant="primary" busy={add.isPending} disabled={!body.trim()}>
              Comment
            </Button>
            {!compact ? (
              <Button size="sm" onClick={() => setWriting(false)}>
                Cancel
              </Button>
            ) : null}
          </div>
        </form>
      ) : (
        <Button size="sm" variant="ghost" className="self-start" onClick={() => setWriting(true)}>
          Add a comment
        </Button>
      )}
    </>
  );
  if (compact) return <div className="flex flex-col gap-3">{content}</div>;
  return (
    <Card className={cx(anchor.level === 'question' && 'ml-4', threads.length === 0 && 'opacity-90')}>
      <div className="mb-2 flex items-center gap-2">
        <h3 className={cx('text-sm', anchor.level === 'question' ? 'font-medium' : 'font-semibold')}>
          {anchor.label}
        </h3>
        {threads.length ? <Badge>{threads.length}</Badge> : null}
      </div>
      <div className="flex flex-col gap-3">{content}</div>
    </Card>
  );
}

function ThreadView({ survey, thread }: { survey: SurveyDetail; thread: Thread }) {
  const queryClient = useQueryClient();
  const [reply, setReply] = useState('');
  const [replying, setReplying] = useState(false);
  const reload = () => void queryClient.invalidateQueries({ queryKey: ['comments', survey.id] });
  const send = useMutation({
    mutationFn: () => post(`/surveys/${survey.id}/comments`, { body: reply, parentId: thread.root.id }),
    onSuccess: () => {
      setReply('');
      setReplying(false);
      reload();
    },
  });
  const resolve = useMutation({
    mutationFn: (resolved: boolean) =>
      patch(`/surveys/${survey.id}/comments/${thread.root.id}`, { resolved }),
    onSuccess: reload,
  });
  const remove = useMutation({
    mutationFn: (id: string) => del(`/surveys/${survey.id}/comments/${id}`),
    onSuccess: reload,
  });
  const canResolve = survey.myRole !== 'viewer' || thread.root.mine;
  const error = send.error ?? resolve.error ?? remove.error;

  return (
    <div className={cx('rounded-lg border border-line p-3', thread.root.resolvedAt && 'bg-gray-50')}>
      {[thread.root, ...thread.replies].map((c, i) => (
        <div key={c.id} className={cx(i > 0 && 'mt-3 border-l-2 border-line pl-3')}>
          <p className="text-xs text-muted">
            <span className="font-medium text-ink">{c.author?.name ?? 'Former member'}</span> ·{' '}
            {relativeTime(c.createdAt)}
            {c.editedAt ? ' · edited' : ''}
          </p>
          <p className="whitespace-pre-wrap text-sm">{c.body}</p>
          {c.mine || survey.myRole === 'owner' ? (
            <button
              type="button"
              className="text-xs text-muted hover:text-red-700"
              onClick={() => remove.mutate(c.id)}
            >
              Delete
            </button>
          ) : null}
        </div>
      ))}
      {error ? (
        <Alert tone="error" className="mt-2">
          {errorMessage(error)}
        </Alert>
      ) : null}
      {replying ? (
        <form
          className="mt-3 flex flex-col gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            send.mutate();
          }}
        >
          <TextArea
            label="Reply"
            rows={2}
            value={reply}
            onChange={(e) => setReply(e.target.value)}
            maxLength={5000}
          />
          <div className="flex gap-2">
            <Button type="submit" size="sm" variant="primary" busy={send.isPending} disabled={!reply.trim()}>
              Reply
            </Button>
            <Button size="sm" onClick={() => setReplying(false)}>
              Cancel
            </Button>
          </div>
        </form>
      ) : (
        <div className="mt-2 flex gap-2">
          <Button size="sm" variant="ghost" onClick={() => setReplying(true)}>
            Reply
          </Button>
          {canResolve ? (
            <Button
              size="sm"
              variant="ghost"
              busy={resolve.isPending}
              onClick={() => resolve.mutate(!thread.root.resolvedAt)}
            >
              {thread.root.resolvedAt ? 'Reopen' : 'Resolve'}
            </Button>
          ) : null}
          {thread.root.resolvedAt ? (
            <span className="self-center text-xs text-muted">
              Resolved {relativeTime(thread.root.resolvedAt)}
            </span>
          ) : null}
        </div>
      )}
    </div>
  );
}
