/** Job queue names. Queues are created by the migration step (as the DB owner), never by the app. */
export const QUEUES = {
  emailSend: 'email.send',
  responseCompleted: 'aggregates.response-completed',
  rebuildAggregates: 'aggregates.rebuild',
  nightlyAggregates: 'aggregates.nightly',
  closeExpiredSurveys: 'surveys.close-expired',
  cleanupSessions: 'sessions.cleanup',
} as const;

export type QueueName = (typeof QUEUES)[keyof typeof QUEUES];
export const ALL_QUEUES: QueueName[] = Object.values(QUEUES);
