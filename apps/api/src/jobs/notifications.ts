/**
 * Notifications (Phase 3A): survey rules (new response, NPS detractor, threshold, closing) and system
 * notices (approvals, a disabled webhook). In-app rows and email jobs are written in one transaction
 * with a firing record keyed by (rule, event), so a retried job never notifies twice.
 */
import { and, eq, inArray } from 'drizzle-orm';
import { listQuestions } from '@survey/core';
import {
  integrations,
  newId,
  notificationFirings,
  notificationPreferences,
  notificationRules,
  notifications,
  responses,
  surveys,
  surveyVersions,
  users,
  withTenant,
  type NotificationKind,
  type Tx,
} from '@survey/db';
import type { Deps } from '../deps';
import type { DomainEvent } from '../events';
import { decryptSecret } from '../lib/crypto';
import { postJson } from '../lib/outbound';

export interface NotifyInput {
  orgId: string;
  userIds: string[];
  kind: string;
  title: string;
  body?: string;
  /** A path in the admin app, e.g. /surveys/{id}/responses/{responseId}. */
  link?: string | null;
  surveyId?: string | null;
  channels: ('email' | 'in_app')[];
}

/**
 * Notify users in the caller's transaction. Each user's preferences for the kind narrow the channels
 * (no preference: every channel). Returns how many users were notified.
 */
export async function notifyUsers(deps: Pick<Deps, 'jobs'>, tx: Tx, input: NotifyInput): Promise<number> {
  const userIds = [...new Set(input.userIds)];
  if (userIds.length === 0 || input.channels.length === 0) return 0;
  const prefs = await tx.db
    .select()
    .from(notificationPreferences)
    .where(
      and(eq(notificationPreferences.orgId, input.orgId), inArray(notificationPreferences.userId, userIds)),
    );
  let notified = 0;
  for (const userId of userIds) {
    const accepted = prefs.find((p) => p.userId === userId)?.channels[input.kind as NotificationKind];
    const channels = input.channels.filter((c) => !accepted || accepted.includes(c));
    if (channels.length === 0) continue;
    const id = newId();
    await tx.db.insert(notifications).values({
      id,
      orgId: input.orgId,
      userId,
      kind: input.kind,
      title: input.title.slice(0, 300),
      body: (input.body ?? '').slice(0, 2000),
      link: input.link ?? null,
      surveyId: input.surveyId ?? null,
      inApp: channels.includes('in_app'),
      email: channels.includes('email'),
    });
    if (channels.includes('email'))
      await deps.jobs.enqueue(tx, 'email.send', {
        type: 'notification',
        orgId: input.orgId,
        notificationId: id,
      });
    notified++;
  }
  return notified;
}

/** Everyone a survey is shared with, directly or through a team, who is still an active org member. */
export async function surveyAudience(tx: Tx, surveyId: string): Promise<string[]> {
  const { rows } = await tx.client.query<{ user_id: string }>(
    `select sc.user_id from survey_collaborators sc
       join memberships m on m.org_id = sc.org_id and m.user_id = sc.user_id
       join users u on u.id = sc.user_id and u.disabled_at is null
      where sc.survey_id = $1
     union
     select tm.user_id from survey_team_collaborators stc
       join team_members tm on tm.team_id = stc.team_id
       join memberships m on m.org_id = tm.org_id and m.user_id = tm.user_id
       join users u on u.id = tm.user_id and u.disabled_at is null
      where stc.survey_id = $1`,
    [surveyId],
  );
  return rows.map((r) => r.user_id);
}

/** Org admins (approvals, disabled webhooks). */
export async function orgAdmins(tx: Tx): Promise<string[]> {
  const { rows } = await tx.client.query<{ user_id: string }>(
    `select m.user_id from memberships m join users u on u.id = m.user_id and u.disabled_at is null
      where m.role = 'org_admin'`,
  );
  return rows.map((r) => r.user_id);
}

const RULE_KINDS: Record<DomainEvent['type'], NotificationKind[]> = {
  'response.submitted': ['new_response', 'nps_detractor', 'threshold'],
  'survey.closed': ['closing'],
  'survey.published': [],
};

const CLOSE_REASONS: Record<string, string> = {
  manual: 'It was closed by hand.',
  close_date: 'Its close date passed.',
  quota: 'It reached its response limit.',
};

/** Detractor scores (0-6) in the watched NPS questions of a response. */
async function detractorScore(
  tx: Tx,
  responseId: string,
  versionId: string,
  questionKey: string | undefined,
) {
  const [version] = await tx.db
    .select({ definition: surveyVersions.definition })
    .from(surveyVersions)
    .where(eq(surveyVersions.id, versionId));
  if (!version) return null;
  const questions = listQuestions(version.definition).filter(
    (q) => q.type === 'nps' && (!questionKey || q.key === questionKey),
  );
  if (questions.length === 0) return null;
  const { rows } = await tx.client.query<{ question_key: string; value_number: number }>(
    `select question_key, value_number from answers
      where response_id = $1 and question_key = any($2::text[]) and sub_key = '' and value_number is not null`,
    [responseId, questions.map((q) => q.key)],
  );
  const low = rows.find((r) => r.value_number <= 6);
  return low
    ? { score: low.value_number, question: questions.find((q) => q.key === low.question_key)! }
    : null;
}

export async function evaluateNotificationRules(deps: Deps, event: DomainEvent): Promise<void> {
  const kinds = RULE_KINDS[event.type];
  if (kinds.length === 0) return;
  await withTenant(deps.pool, event.orgId, async (tx) => {
    const rules = await tx.db
      .select()
      .from(notificationRules)
      .where(and(eq(notificationRules.surveyId, event.surveyId), inArray(notificationRules.kind, kinds)));
    if (rules.length === 0) return;
    const [survey] = await tx.db.select().from(surveys).where(eq(surveys.id, event.surveyId));
    if (!survey || survey.deletedAt) return;
    const [response] = event.responseId
      ? await tx.db.select().from(responses).where(eq(responses.id, event.responseId))
      : [];
    const responseLink = response
      ? `/surveys/${survey.id}/responses/${response.id}`
      : `/surveys/${survey.id}/results`;

    for (const rule of rules) {
      let message: { title: string; body: string; link: string } | null = null;
      if (rule.kind === 'new_response' && response?.status === 'completed') {
        message = {
          title: `New response to "${survey.title}"`,
          body: 'A respondent completed the survey.',
          link: responseLink,
        };
      } else if (rule.kind === 'nps_detractor' && response?.status === 'completed') {
        const low = await detractorScore(tx, response.id, response.versionId, rule.config.questionKey);
        if (low)
          message = {
            title: `Detractor response to "${survey.title}"`,
            body: `Someone answered ${low.score} out of 10 to "${low.question.title}".`,
            link: responseLink,
          };
      } else if (
        rule.kind === 'threshold' &&
        rule.config.count &&
        survey.completedCount >= rule.config.count
      ) {
        message = {
          title: `"${survey.title}" reached ${rule.config.count} responses`,
          body: `It now has ${survey.completedCount} completed responses.`,
          link: `/surveys/${survey.id}/results`,
        };
      } else if (rule.kind === 'closing') {
        message = {
          title: `"${survey.title}" closed`,
          body: CLOSE_REASONS[event.reason ?? ''] ?? 'It no longer accepts responses.',
          link: `/surveys/${survey.id}/results`,
        };
      }
      if (!message) continue;

      // A threshold fires once per rule; everything else once per event.
      const fired = await tx.db
        .insert(notificationFirings)
        .values({
          orgId: event.orgId,
          ruleId: rule.id,
          eventId: rule.kind === 'threshold' ? 'threshold' : event.id,
        })
        .onConflictDoNothing()
        .returning({ ruleId: notificationFirings.ruleId });
      if (fired.length === 0) continue;

      const personal = rule.channels.filter((c): c is 'email' | 'in_app' => c !== 'slack');
      if (personal.length)
        await notifyUsers(deps, tx, {
          orgId: event.orgId,
          userIds: await surveyAudience(tx, survey.id),
          kind: rule.kind,
          ...message,
          surveyId: survey.id,
          channels: personal,
        });
      if (rule.channels.includes('slack'))
        await deps.jobs.enqueue(tx, 'integrations.slack', {
          orgId: event.orgId,
          text: `*${message.title}*\n${message.body}\n<${deps.config.appUrl}${message.link}|Open in Survey Platform>`,
        });
    }
  });
}

/**
 * Email one notification. The email is sent inside the transaction that marks it sent, so a failed
 * send is retried and a sent one isn't sent again.
 */
export async function sendNotificationEmail(
  deps: Deps,
  job: { orgId: string; notificationId: string },
): Promise<void> {
  await withTenant(deps.pool, job.orgId, async (tx) => {
    const [row] = await tx.db
      .select({ n: notifications, email: users.email, name: users.name })
      .from(notifications)
      .innerJoin(users, eq(users.id, notifications.userId))
      .where(eq(notifications.id, job.notificationId))
      .for('update', { of: notifications });
    if (!row || !row.n.email || row.n.emailedAt) return;
    const link = row.n.link ? `\n\nOpen it: ${deps.config.appUrl}${row.n.link}` : '';
    await deps.mailer.send({
      to: row.email,
      subject: row.n.title.slice(0, 200),
      text: `Hi ${row.name},\n\n${row.n.body}${link}\n\nChange which notifications you get by email: ${deps.config.appUrl}/settings/notifications\n`,
    });
    await tx.db.update(notifications).set({ emailedAt: new Date() }).where(eq(notifications.id, row.n.id));
  });
}

export interface SlackConfig {
  webhookUrl: string;
  channelName?: string;
}

/** Post to the org's Slack incoming webhook. Failures are recorded on the integration and retried. */
export async function postToSlack(deps: Deps, job: { orgId: string; text: string }): Promise<void> {
  const [row] = await withTenant(deps.pool, job.orgId, (tx) =>
    tx.db
      .select()
      .from(integrations)
      .where(and(eq(integrations.orgId, job.orgId), eq(integrations.kind, 'slack'))),
  );
  if (!row) return;
  const config = JSON.parse(decryptSecret(deps.config.encryptionKey, row.configEnc)) as SlackConfig;
  let failure: string | null = null;
  try {
    const res = await postJson(config.webhookUrl, JSON.stringify({ text: job.text }), {
      allowPrivate: deps.config.allowPrivateUrls,
    });
    if (res.status < 200 || res.status >= 300)
      failure = `Slack answered ${res.status}: ${res.body.slice(0, 200)}`;
  } catch (error) {
    failure = (error as Error).message;
  }
  await withTenant(deps.pool, job.orgId, (tx) =>
    tx.db
      .update(integrations)
      .set({ status: failure ? 'error' : 'connected', lastError: failure })
      .where(and(eq(integrations.orgId, job.orgId), eq(integrations.kind, 'slack'))),
  );
  if (failure) throw new Error(failure);
}
