import { useState } from 'react';
import { Link } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { ApprovalRequest, ApprovalStatus } from '@survey/contracts';
import { errorMessage, get, post } from '../api';
import { useAuth } from '../auth';
import { Alert, Badge, Button, Card, Dialog, EmptyState, PageHeader, TextArea } from '../components/ui';
import { relativeTime } from '../lib/format';

const STATUS: Record<ApprovalStatus, { label: string; className: string }> = {
  pending: { label: 'Waiting', className: 'bg-amber-100 text-amber-900' },
  approved: { label: 'Approved', className: 'bg-green-100 text-green-800' },
  rejected: { label: 'Rejected', className: 'bg-red-100 text-red-800' },
  superseded: { label: 'Out of date', className: 'bg-gray-100 text-gray-700' },
  cancelled: { label: 'Withdrawn', className: 'bg-gray-100 text-gray-700' },
};

/** Approval requests (Phase 3A): approvers decide here; authors follow their requests. */
export function ApprovalsPage() {
  const { me } = useAuth();
  const queryClient = useQueryClient();
  const [filter, setFilter] = useState<'pending' | 'all'>('pending');
  const requests = useQuery({
    queryKey: ['approvals', filter],
    queryFn: () =>
      get<ApprovalRequest[]>(`/approval-requests${filter === 'pending' ? '?status=pending' : ''}`),
  });
  const [deciding, setDeciding] = useState<{ request: ApprovalRequest; action: 'approve' | 'reject' } | null>(
    null,
  );
  const [note, setNote] = useState('');
  const decide = useMutation({
    mutationFn: () =>
      post<ApprovalRequest>(
        `/approval-requests/${deciding!.request.id}/${deciding!.action}`,
        note ? { note } : {},
      ),
    onSuccess: () => {
      setDeciding(null);
      setNote('');
      void queryClient.invalidateQueries({ queryKey: ['approvals'] });
      void queryClient.invalidateQueries({ queryKey: ['surveys'] });
    },
  });
  const cancel = useMutation({
    mutationFn: (id: string) => post(`/approval-requests/${id}/cancel`),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['approvals'] }),
  });

  const list = requests.data ?? [];
  return (
    <>
      <PageHeader
        title="Approvals"
        description="When your organization requires approval, publishing sends the exact draft for review. Any edit makes a waiting request out of date."
        actions={
          <div className="flex gap-1" role="group" aria-label="Show">
            <Button
              size="sm"
              variant={filter === 'pending' ? 'primary' : 'secondary'}
              aria-pressed={filter === 'pending'}
              onClick={() => setFilter('pending')}
            >
              Waiting
            </Button>
            <Button
              size="sm"
              variant={filter === 'all' ? 'primary' : 'secondary'}
              aria-pressed={filter === 'all'}
              onClick={() => setFilter('all')}
            >
              All
            </Button>
          </div>
        }
      />
      {requests.error ? <Alert tone="error">{errorMessage(requests.error)}</Alert> : null}
      {cancel.error ? <Alert tone="error">{errorMessage(cancel.error)}</Alert> : null}
      {requests.isSuccess && list.length === 0 ? (
        <EmptyState
          title={filter === 'pending' ? 'Nothing waiting for approval' : 'No approval requests yet'}
        />
      ) : null}
      <div className="flex flex-col gap-3">
        {list.map((r) => (
          <Card key={r.id}>
            <div className="flex flex-wrap items-start gap-3">
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <Link
                    to={`/surveys/${r.survey.id}/comments`}
                    className="font-medium text-ink hover:text-brand-600"
                  >
                    {r.survey.title}
                  </Link>
                  <Badge className={STATUS[r.status].className}>{STATUS[r.status].label}</Badge>
                </div>
                <p className="mt-1 text-sm text-muted">
                  Requested by {r.requestedBy.name} {relativeTime(r.createdAt)} · draft revision {r.revision}
                </p>
                {r.requestNote ? <p className="mt-2 text-sm">“{r.requestNote}”</p> : null}
                {r.decidedBy ? (
                  <p className="mt-2 text-sm text-muted">
                    {STATUS[r.status].label} by {r.decidedBy.name}
                    {r.decidedAt ? ` ${relativeTime(r.decidedAt)}` : ''}
                    {r.decisionNote ? `: “${r.decisionNote}”` : ''}
                  </p>
                ) : null}
              </div>
              <div className="flex flex-wrap gap-2">
                <Link
                  to={`/surveys/${r.survey.id}/comments`}
                  className="inline-flex h-8 items-center rounded-lg border border-line px-3 text-sm font-medium hover:bg-gray-50"
                >
                  Review and comment
                </Link>
                {r.canDecide ? (
                  <>
                    <Button
                      size="sm"
                      variant="primary"
                      onClick={() => setDeciding({ request: r, action: 'approve' })}
                    >
                      Approve and publish
                    </Button>
                    <Button size="sm" onClick={() => setDeciding({ request: r, action: 'reject' })}>
                      Reject
                    </Button>
                  </>
                ) : null}
                {r.status === 'pending' && r.requestedBy.id === me?.user.id ? (
                  <Button
                    size="sm"
                    variant="ghost"
                    busy={cancel.isPending}
                    onClick={() => cancel.mutate(r.id)}
                  >
                    Withdraw
                  </Button>
                ) : null}
              </div>
            </div>
          </Card>
        ))}
      </div>
      <Dialog
        open={deciding !== null}
        onClose={() => setDeciding(null)}
        title={
          deciding?.action === 'approve'
            ? `Approve "${deciding.request.survey.title}"?`
            : `Reject "${deciding?.request.survey.title}"?`
        }
        footer={
          <>
            <Button onClick={() => setDeciding(null)}>Cancel</Button>
            <Button
              variant={deciding?.action === 'approve' ? 'primary' : 'danger'}
              busy={decide.isPending}
              onClick={() => decide.mutate()}
            >
              {deciding?.action === 'approve' ? 'Approve and publish' : 'Reject'}
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-3">
          <p className="text-sm">
            {deciding?.action === 'approve'
              ? 'The reviewed revision goes live immediately. If the draft changed since the request, approving is refused.'
              : 'The author is told, with your note. The draft stays as it is.'}
          </p>
          <TextArea
            label="Note for the author (optional)"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            maxLength={1000}
          />
          {decide.error ? <Alert tone="error">{errorMessage(decide.error)}</Alert> : null}
        </div>
      </Dialog>
    </>
  );
}
