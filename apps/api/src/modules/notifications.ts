/**
 * Notifications (Phase 3A): the in-app inbox, each user's channel preferences, and per-survey rules.
 * Rules are evaluated by the worker when events arrive (jobs/notifications.ts).
 */
import { and, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import {
  MarkNotificationsReadRequest,
  NotificationPreferencesSchema,
  NotificationsQuery,
  SaveNotificationRulesRequest,
  type NotificationInbox,
  type NotificationPreferences,
  type NotificationRule,
} from '@survey/contracts';
import { listQuestions } from '@survey/core';
import {
  integrations,
  newId,
  notificationPreferences,
  notificationRules,
  notifications,
  surveyVersions,
  withTenant,
  type Tx,
} from '@survey/db';
import type { Deps } from '../deps';
import { audit } from '../audit';
import { requireOrg } from '../auth/context';
import { decodeCursor, encodeCursor } from '../lib/misc';
import { unprocessable } from '../lib/errors';
import { parse } from '../lib/validate';
import { findDraft, loadSurvey } from './surveys';

async function listRules(tx: Tx, surveyId: string): Promise<NotificationRule[]> {
  const rows = await tx.db
    .select()
    .from(notificationRules)
    .where(eq(notificationRules.surveyId, surveyId))
    .orderBy(notificationRules.createdAt);
  return rows.map((r) => ({ id: r.id, kind: r.kind, config: r.config, channels: r.channels }));
}

const sameConfig = (a: object, b: object) =>
  JSON.stringify(a, Object.keys(a).sort()) === JSON.stringify(b, Object.keys(b).sort());

export function registerNotificationRoutes(app: FastifyInstance, deps: Deps): void {
  const { pool } = deps;

  // ── Inbox ──────────────────────────────────────────────────────────
  app.get('/api/v1/notifications', async (req): Promise<NotificationInbox> => {
    const auth = requireOrg(req);
    const query = parse(NotificationsQuery, req.query);
    return withTenant(pool, auth.orgId, async (tx) => {
      const mine = and(eq(notifications.userId, auth.userId), eq(notifications.inApp, true));
      const conditions = [mine];
      if (query.unread) conditions.push(isNull(notifications.readAt));
      const cursor = decodeCursor(query.cursor, 2);
      if (cursor)
        conditions.push(
          sql`(${notifications.createdAt}, ${notifications.id}) < (${cursor[0]}::timestamptz, ${cursor[1]}::uuid)`,
        );
      const rows = await tx.db
        .select()
        .from(notifications)
        .where(and(...conditions))
        .orderBy(desc(notifications.createdAt), desc(notifications.id))
        .limit(query.limit + 1);
      const [unread] = await tx.db
        .select({ n: sql<number>`count(*)::int` })
        .from(notifications)
        .where(and(mine, isNull(notifications.readAt)));
      const page = rows.slice(0, query.limit);
      const last = page.at(-1);
      return {
        data: page.map((n) => ({
          id: n.id,
          kind: n.kind,
          title: n.title,
          body: n.body,
          link: n.link,
          createdAt: n.createdAt.toISOString(),
          readAt: n.readAt?.toISOString() ?? null,
        })),
        nextCursor:
          rows.length > query.limit && last ? encodeCursor([last.createdAt.toISOString(), last.id]) : null,
        unread: unread?.n ?? 0,
      };
    });
  });

  app.post('/api/v1/notifications/read', async (req, reply) => {
    const auth = requireOrg(req);
    const body = parse(MarkNotificationsReadRequest, req.body);
    await withTenant(pool, auth.orgId, (tx) =>
      tx.db
        .update(notifications)
        .set({ readAt: new Date() })
        .where(
          and(
            eq(notifications.userId, auth.userId),
            isNull(notifications.readAt),
            body.ids ? inArray(notifications.id, body.ids) : undefined,
          ),
        ),
    );
    return reply.code(204).send();
  });

  // ── Preferences ────────────────────────────────────────────────────
  app.get('/api/v1/notifications/preferences', async (req): Promise<NotificationPreferences> => {
    const auth = requireOrg(req);
    return withTenant(pool, auth.orgId, async (tx) => {
      const [row] = await tx.db
        .select()
        .from(notificationPreferences)
        .where(
          and(eq(notificationPreferences.orgId, auth.orgId), eq(notificationPreferences.userId, auth.userId)),
        );
      return { channels: row?.channels ?? {} };
    });
  });

  app.put('/api/v1/notifications/preferences', async (req): Promise<NotificationPreferences> => {
    const auth = requireOrg(req);
    const body = parse(NotificationPreferencesSchema, req.body);
    return withTenant(pool, auth.orgId, async (tx) => {
      await tx.db
        .insert(notificationPreferences)
        .values({ orgId: auth.orgId, userId: auth.userId, channels: body.channels })
        .onConflictDoUpdate({
          target: [notificationPreferences.orgId, notificationPreferences.userId],
          set: { channels: body.channels, updatedAt: new Date() },
        });
      return { channels: body.channels };
    });
  });

  // ── Survey rules ───────────────────────────────────────────────────
  app.get<{ Params: { id: string } }>('/api/v1/surveys/:id/notification-rules', async (req) => {
    const auth = requireOrg(req);
    return withTenant(pool, auth.orgId, async (tx) => {
      const { survey } = await loadSurvey(tx, auth, req.params.id, 'survey.view');
      return listRules(tx, survey.id);
    });
  });

  /**
   * Replace a survey's rules. A rule that keeps its kind and settings keeps its identity, so a
   * threshold that already fired doesn't fire again just because the list was saved.
   */
  app.put<{ Params: { id: string } }>('/api/v1/surveys/:id/notification-rules', async (req) => {
    const auth = requireOrg(req);
    const { rules } = parse(SaveNotificationRulesRequest, req.body);
    return withTenant(pool, auth.orgId, async (tx) => {
      const { survey } = await loadSurvey(tx, auth, req.params.id, 'survey.edit');
      const definition =
        (await findDraft(tx, survey.id))?.definition ??
        (survey.currentVersionId
          ? (
              await tx.db.select().from(surveyVersions).where(eq(surveyVersions.id, survey.currentVersionId))
            )[0]?.definition
          : undefined);
      const npsKeys = new Set(
        definition
          ? listQuestions(definition)
              .filter((q) => q.type === 'nps')
              .map((q) => q.key)
          : [],
      );
      const [slack] = await tx.db
        .select({ kind: integrations.kind })
        .from(integrations)
        .where(and(eq(integrations.orgId, auth.orgId), eq(integrations.kind, 'slack')));
      rules.forEach((rule, i) => {
        if (rule.kind === 'threshold' && !rule.config.count)
          throw unprocessable('invalid_rule', `Rule ${i + 1}: choose how many responses trigger it.`);
        if (rule.kind === 'nps_detractor' && rule.config.questionKey && !npsKeys.has(rule.config.questionKey))
          throw unprocessable('invalid_rule', `Rule ${i + 1}: that isn't an NPS question in this survey.`);
        if (rule.channels.includes('slack') && !slack)
          throw unprocessable(
            'slack_not_connected',
            'Connect Slack in Integrations before sending notifications there.',
          );
      });

      const existing = await tx.db
        .select()
        .from(notificationRules)
        .where(eq(notificationRules.surveyId, survey.id));
      const kept = new Set<string>();
      for (const rule of rules) {
        const config = {
          ...(rule.config.questionKey ? { questionKey: rule.config.questionKey } : {}),
          ...(rule.config.count ? { count: rule.config.count } : {}),
        };
        const match = existing.find(
          (e) => !kept.has(e.id) && e.kind === rule.kind && sameConfig(e.config, config),
        );
        const channels = [...new Set(rule.channels)];
        if (match) {
          kept.add(match.id);
          await tx.db.update(notificationRules).set({ channels }).where(eq(notificationRules.id, match.id));
        } else {
          const id = newId();
          kept.add(id);
          await tx.db
            .insert(notificationRules)
            .values({
              id,
              orgId: auth.orgId,
              surveyId: survey.id,
              kind: rule.kind,
              config,
              channels,
              createdBy: auth.userId,
            });
        }
      }
      const stale = existing.filter((e) => !kept.has(e.id)).map((e) => e.id);
      if (stale.length) await tx.db.delete(notificationRules).where(inArray(notificationRules.id, stale));
      await audit(tx, {
        orgId: auth.orgId,
        actorId: auth.userId,
        action: 'survey.notification_rules_changed',
        entityType: 'survey',
        entityId: survey.id,
        metadata: { count: rules.length },
        ip: req.ip,
      });
      return listRules(tx, survey.id);
    });
  });
}
