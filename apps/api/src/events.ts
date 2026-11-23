/**
 * Domain events (Phase 3A). An event is queued in the transaction that caused it, so it exists if and
 * only if the change committed. The worker then fans it out to webhooks and notification rules
 * (jobs/events.ts). Event ids are stable across job retries, which is what makes both idempotent.
 */
import { newId, type Tx } from '@survey/db';
import type { Deps } from './deps';

export type DomainEventType = 'response.submitted' | 'survey.published' | 'survey.closed';

export interface DomainEvent {
  /** `evt_…`, sent to webhook receivers as Survey-Webhook-Id. */
  id: string;
  type: DomainEventType;
  orgId: string;
  surveyId: string;
  occurredAt: string;
  responseId?: string;
  versionId?: string;
  /** survey.closed: manual, close_date or quota. */
  reason?: string;
}

export const newEventId = (): string => `evt_${newId().replace(/-/g, '')}`;

export async function emitEvent(
  deps: Pick<Deps, 'jobs'>,
  tx: Tx | null,
  event: Omit<DomainEvent, 'id' | 'occurredAt'>,
): Promise<void> {
  await deps.jobs.enqueue(tx, 'events.dispatch', {
    ...event,
    id: newEventId(),
    occurredAt: new Date().toISOString(),
  });
}
