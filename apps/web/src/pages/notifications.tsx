import { useState } from 'react';
import { Link } from 'react-router';
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { NotificationInbox, NotificationKind, NotificationPreferences } from '@survey/contracts';
import { errorMessage, get, post, put } from '../api';
import { Alert, Button, Card, EmptyState, PageHeader, cx } from '../components/ui';
import { relativeTime } from '../lib/format';

/** In-app inbox (Phase 3A). */
export function NotificationsPage() {
  const queryClient = useQueryClient();
  const [unreadOnly, setUnreadOnly] = useState(false);
  const inbox = useInfiniteQuery({
    queryKey: ['notifications', 'inbox', unreadOnly],
    queryFn: ({ pageParam }) =>
      get<NotificationInbox>(
        `/notifications?limit=20${unreadOnly ? '&unread=true' : ''}${pageParam ? `&cursor=${pageParam}` : ''}`,
      ),
    initialPageParam: '',
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
  const markRead = useMutation({
    mutationFn: (body: { ids: string[] } | { all: true }) => post('/notifications/read', body),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['notifications'] }),
  });
  const items = inbox.data?.pages.flatMap((p) => p.data) ?? [];
  const unread = inbox.data?.pages[0]?.unread ?? 0;

  return (
    <>
      <PageHeader
        title="Notifications"
        description={unread ? `${unread} unread` : 'You’re up to date.'}
        actions={
          <div className="flex gap-2">
            <Button size="sm" aria-pressed={unreadOnly} onClick={() => setUnreadOnly((v) => !v)}>
              {unreadOnly ? 'Show all' : 'Unread only'}
            </Button>
            <Button
              size="sm"
              disabled={!unread}
              busy={markRead.isPending}
              onClick={() => markRead.mutate({ all: true })}
            >
              Mark all as read
            </Button>
            <Link
              to="/settings/notifications"
              className="inline-flex h-8 items-center rounded-lg px-3 text-sm font-medium text-brand-700 hover:underline"
            >
              Preferences
            </Link>
          </div>
        }
      />
      {inbox.error ? <Alert tone="error">{errorMessage(inbox.error)}</Alert> : null}
      {inbox.isSuccess && items.length === 0 ? (
        <EmptyState title="No notifications">
          Turn on notifications for a survey in its Settings tab.
        </EmptyState>
      ) : null}
      {items.length ? (
        <ul className="divide-y divide-line overflow-hidden rounded-xl border border-line bg-white">
          {items.map((n) => (
            <li key={n.id} className={cx('flex items-start gap-3 px-4 py-3', !n.readAt && 'bg-brand-50/40')}>
              <span
                aria-hidden="true"
                className={cx(
                  'mt-1.5 h-2 w-2 shrink-0 rounded-full',
                  n.readAt ? 'bg-transparent' : 'bg-brand-600',
                )}
              />
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium">
                  {n.link ? (
                    <Link
                      to={n.link}
                      className="hover:text-brand-600"
                      onClick={() => !n.readAt && markRead.mutate({ ids: [n.id] })}
                    >
                      {n.title}
                    </Link>
                  ) : (
                    n.title
                  )}
                  {!n.readAt ? <span className="sr-only"> (unread)</span> : null}
                </p>
                {n.body ? <p className="text-sm text-muted">{n.body}</p> : null}
                <p className="mt-0.5 text-xs text-muted">{relativeTime(n.createdAt)}</p>
              </div>
              {!n.readAt ? (
                <Button size="sm" variant="ghost" onClick={() => markRead.mutate({ ids: [n.id] })}>
                  Mark read
                </Button>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
      {inbox.hasNextPage ? (
        <div className="mt-4 text-center">
          <Button onClick={() => void inbox.fetchNextPage()} busy={inbox.isFetchingNextPage}>
            Load more
          </Button>
        </div>
      ) : null}
    </>
  );
}

const KINDS: { kind: NotificationKind; label: string; hint: string }[] = [
  {
    kind: 'new_response',
    label: 'New responses',
    hint: 'Every completed response, on surveys that turn this on.',
  },
  { kind: 'nps_detractor', label: 'NPS detractors', hint: 'A score of 0 to 6.' },
  { kind: 'threshold', label: 'Response milestones', hint: 'A survey reaches a set number of responses.' },
  { kind: 'closing', label: 'Survey closed', hint: 'By hand, by its close date or by its response limit.' },
];
const CHANNELS = [
  { channel: 'in_app', label: 'In the app' },
  { channel: 'email', label: 'Email' },
] as const;

/** Which channels you accept for each kind of survey notification (Phase 3A). */
export function NotificationPreferencesPage() {
  const queryClient = useQueryClient();
  const prefs = useQuery({
    queryKey: ['notification-preferences'],
    queryFn: () => get<NotificationPreferences>('/notifications/preferences'),
  });
  const save = useMutation({
    mutationFn: (channels: NotificationPreferences['channels']) =>
      put<NotificationPreferences>('/notifications/preferences', { channels }),
    onSuccess: (data) => queryClient.setQueryData(['notification-preferences'], data),
  });
  const current = prefs.data?.channels ?? {};
  const accepts = (kind: NotificationKind, channel: 'in_app' | 'email') =>
    current[kind]?.includes(channel) ?? true;
  const toggle = (kind: NotificationKind, channel: 'in_app' | 'email') => {
    const now = (['in_app', 'email'] as const).filter((c) => accepts(kind, c));
    const next = now.includes(channel) ? now.filter((c) => c !== channel) : [...now, channel];
    save.mutate({ ...current, [kind]: next });
  };

  return (
    <>
      <PageHeader
        title="Notifications"
        description="Survey editors choose what each survey notifies about. You choose how it reaches you."
      />
      <Card className="max-w-2xl">
        <table className="w-full text-left text-sm">
          <thead>
            <tr className="text-xs uppercase tracking-wide text-muted">
              <th scope="col" className="py-2 font-medium">
                Notification
              </th>
              {CHANNELS.map((c) => (
                <th key={c.channel} scope="col" className="py-2 text-center font-medium">
                  {c.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {KINDS.map((k) => (
              <tr key={k.kind}>
                <th scope="row" className="py-3 pr-4 font-normal">
                  <span className="font-medium">{k.label}</span>
                  <span className="block text-xs text-muted">{k.hint}</span>
                </th>
                {CHANNELS.map((c) => (
                  <td key={c.channel} className="py-3 text-center">
                    <input
                      type="checkbox"
                      className="h-4 w-4 accent-brand-600"
                      aria-label={`${k.label}: ${c.label}`}
                      checked={accepts(k.kind, c.channel)}
                      disabled={!prefs.isSuccess || save.isPending}
                      onChange={() => toggle(k.kind, c.channel)}
                    />
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
        <p className="mt-3 text-xs text-muted">
          Approval requests and alerts about broken webhooks always reach you.
        </p>
        {save.error ? (
          <Alert tone="error" className="mt-3">
            {errorMessage(save.error)}
          </Alert>
        ) : null}
      </Card>
    </>
  );
}
