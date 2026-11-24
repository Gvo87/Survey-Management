/** Job queue names. Queues are created by the migration step (as the DB owner), never by the app. */
export const QUEUES = {
  emailSend: 'email.send',
  responseCompleted: 'aggregates.response-completed',
  rebuildAggregates: 'aggregates.rebuild',
  nightlyAggregates: 'aggregates.nightly',
  closeExpiredSurveys: 'surveys.close-expired',
  cleanupSessions: 'sessions.cleanup',
  scanFile: 'files.scan',
  deleteObjects: 'files.delete-objects',
  importContacts: 'contacts.import',
  startCampaign: 'campaigns.start',
  sendCampaign: 'campaigns.send',
  campaignReminders: 'campaigns.reminders',
  generateExport: 'exports.generate',
  cleanupExports: 'exports.cleanup',
  scheduledReportsTick: 'reports.tick',
  dispatchEvent: 'events.dispatch',
  deliverWebhook: 'webhooks.deliver',
  postToSlack: 'integrations.slack',
  cleanupPlatform: 'platform.cleanup',
  // Phase 3B
  generateInsight: 'insights.generate',
  retentionPurge: 'retention.purge',
  processPrivacyRequest: 'privacy.process',
} as const;

export type QueueName = (typeof QUEUES)[keyof typeof QUEUES];
export const ALL_QUEUES: QueueName[] = Object.values(QUEUES);
