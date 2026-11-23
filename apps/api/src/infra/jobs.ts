import PgBoss from 'pg-boss';
import type { QueueName, Tx } from '@survey/db';
import type { DomainEvent } from '../events';

export type EmailJob =
  | { type: 'verify_email'; userId: string }
  | { type: 'password_reset'; userId: string }
  | { type: 'invitation'; orgId: string; invitationId: string }
  /** Phase 3A: a notification that a user receives by email. */
  | { type: 'notification'; orgId: string; notificationId: string };

export interface JobPayloads {
  'email.send': EmailJob;
  'aggregates.response-completed': { orgId: string; surveyId: string; responseId: string };
  'aggregates.rebuild': { orgId: string; surveyId: string };
  'aggregates.nightly': Record<string, never>;
  'surveys.close-expired': Record<string, never>;
  'sessions.cleanup': Record<string, never>;
  'files.scan': { orgId: string; fileId: string };
  'files.delete-objects': { keys: string[] };
  'contacts.import': { orgId: string; importId: string };
  /** `scheduledAt` guards against a rescheduled or cancelled campaign's stale job. */
  'campaigns.start': { orgId: string; campaignId: string; scheduledAt: string };
  'campaigns.send': { orgId: string; campaignId: string };
  'campaigns.reminders': Record<string, never>;
  'exports.generate': { orgId: string; exportId: string };
  'exports.cleanup': Record<string, never>;
  'reports.tick': Record<string, never>;
  /** Phase 3A: fan an event out to webhooks and notification rules. */
  'events.dispatch': DomainEvent;
  /** `manual`: a redelivery or test, one attempt and no retries. */
  'webhooks.deliver': { orgId: string; deliveryId: string; manual?: boolean };
  'integrations.slack': { orgId: string; text: string };
  'platform.cleanup': Record<string, never>;
}

/**
 * Thin wrapper over pg-boss. `enqueue(tx, …)` writes the job through the caller's transaction,
 * so the job exists if and only if the data that triggered it was committed.
 */
export class Jobs {
  private constructor(readonly boss: PgBoss) {}

  static async start(connectionString: string, opts: { worker: boolean }): Promise<Jobs> {
    const boss = new PgBoss({
      connectionString,
      migrate: false, // schema and queues are installed by `pnpm db:migrate` as the owner role
      schedule: opts.worker,
      supervise: opts.worker,
      max: opts.worker ? 5 : 3,
    });
    boss.on('error', (error) => console.error('[jobs]', error));
    await boss.start();
    return new Jobs(boss);
  }

  async enqueue<Q extends QueueName>(tx: Tx | null, name: Q, data: JobPayloads[Q], options: { startAfter?: Date } = {}): Promise<void> {
    const db = tx
      ? { executeSql: (text: string, values: unknown[]) => tx.client.query(text, values) }
      : undefined;
    await this.boss.send(name, data as object, { ...options, ...(db ? { db } : {}) });
  }

  async stop(): Promise<void> {
    await this.boss.stop({ graceful: true, wait: true, timeout: 10_000 });
  }
}
