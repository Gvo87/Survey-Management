/** Integrations (Phase 3A): Slack for notifications; HubSpot and Google Sheets configuration (stubs). */
import { and, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import {
  GoogleSheetsIntegrationRequest,
  HubspotIntegrationRequest,
  INTEGRATION_KINDS,
  SlackIntegrationRequest,
  type Integration,
  type IntegrationKind,
} from '@survey/contracts';
import { integrations, withTenant } from '@survey/db';
import type { Deps } from '../deps';
import { audit } from '../audit';
import { requireOrg } from '../auth/context';
import { googleSheetsConnector, hubspotConnector } from '../integrations/connectors';
import { decryptSecret, encryptSecret } from '../lib/crypto';
import { notFound, unprocessable } from '../lib/errors';
import { checkOutboundUrl, postJson } from '../lib/outbound';
import { parse } from '../lib/validate';
import type { SlackConfig } from '../jobs/notifications';

const STUBS: IntegrationKind[] = ['hubspot', 'google_sheets'];

export function registerIntegrationRoutes(app: FastifyInstance, deps: Deps): void {
  const { pool, config } = deps;

  async function list(orgId: string): Promise<Integration[]> {
    const rows = await withTenant(pool, orgId, (tx) => tx.db.select().from(integrations));
    return INTEGRATION_KINDS.map((kind) => {
      const row = rows.find((r) => r.kind === kind);
      return {
        kind,
        connected: Boolean(row),
        status: row?.status ?? null,
        summary: row?.summary ?? {},
        lastError: row?.lastError ?? null,
        updatedAt: row?.updatedAt.toISOString() ?? null,
        stub: STUBS.includes(kind),
      };
    });
  }

  async function save(
    req: { ip: string },
    auth: { orgId: string; userId: string },
    kind: IntegrationKind,
    secretConfig: object,
    summary: Record<string, string>,
  ) {
    await withTenant(pool, auth.orgId, async (tx) => {
      const values = {
        configEnc: encryptSecret(config.encryptionKey, JSON.stringify(secretConfig)),
        summary,
        status: 'connected' as const,
        lastError: null,
        updatedBy: auth.userId,
        updatedAt: new Date(),
      };
      await tx.db
        .insert(integrations)
        .values({ orgId: auth.orgId, kind, ...values })
        .onConflictDoUpdate({ target: [integrations.orgId, integrations.kind], set: values });
      await audit(tx, {
        orgId: auth.orgId,
        actorId: auth.userId,
        action: 'integration.connected',
        metadata: { kind },
        ip: req.ip,
      });
    });
  }

  app.get('/api/v1/integrations', async (req) => {
    const auth = requireOrg(req, 'org.update');
    return list(auth.orgId);
  });

  app.put('/api/v1/integrations/slack', async (req) => {
    const auth = requireOrg(req, 'org.update');
    const body = parse(SlackIntegrationRequest, req.body);
    const problem = checkOutboundUrl(body.webhookUrl, config.allowPrivateUrls);
    if (problem) throw unprocessable('invalid_url', problem);
    if (!config.allowPrivateUrls && !body.webhookUrl.startsWith('https://hooks.slack.com/'))
      throw unprocessable(
        'invalid_url',
        'Use the incoming webhook URL Slack gives you (https://hooks.slack.com/…).',
      );
    const slack: SlackConfig = {
      webhookUrl: body.webhookUrl,
      ...(body.channelName ? { channelName: body.channelName } : {}),
    };
    await save(req, auth, 'slack', slack, { channel: body.channelName || 'the webhook’s channel' });
    return list(auth.orgId);
  });

  app.put('/api/v1/integrations/hubspot', async (req) => {
    const auth = requireOrg(req, 'org.update');
    const body = parse(HubspotIntegrationRequest, req.body);
    await save(req, auth, 'hubspot', body, hubspotConnector.summary(body));
    return list(auth.orgId);
  });

  app.put('/api/v1/integrations/google_sheets', async (req) => {
    const auth = requireOrg(req, 'org.update');
    const body = parse(GoogleSheetsIntegrationRequest, req.body);
    await save(req, auth, 'google_sheets', body, googleSheetsConnector.summary(body));
    return list(auth.orgId);
  });

  app.delete<{ Params: { kind: string } }>('/api/v1/integrations/:kind', async (req) => {
    const auth = requireOrg(req, 'org.update');
    const kind = req.params.kind as IntegrationKind;
    if (!INTEGRATION_KINDS.includes(kind)) throw notFound('Integration');
    await withTenant(pool, auth.orgId, async (tx) => {
      const removed = await tx.db
        .delete(integrations)
        .where(and(eq(integrations.orgId, auth.orgId), eq(integrations.kind, kind)))
        .returning({ kind: integrations.kind });
      if (removed.length === 0) throw notFound('Integration');
      await audit(tx, {
        orgId: auth.orgId,
        actorId: auth.userId,
        action: 'integration.disconnected',
        metadata: { kind },
        ip: req.ip,
      });
    });
    return list(auth.orgId);
  });

  /** Post a test message to Slack now. */
  app.post('/api/v1/integrations/slack/test', async (req) => {
    const auth = requireOrg(req, 'org.update');
    const [row] = await withTenant(pool, auth.orgId, (tx) =>
      tx.db
        .select()
        .from(integrations)
        .where(and(eq(integrations.orgId, auth.orgId), eq(integrations.kind, 'slack'))),
    );
    if (!row) throw notFound('Slack integration');
    const slack = JSON.parse(decryptSecret(config.encryptionKey, row.configEnc)) as SlackConfig;
    try {
      const res = await postJson(
        slack.webhookUrl,
        JSON.stringify({ text: 'Survey Platform is connected: survey notifications will appear here.' }),
        { allowPrivate: config.allowPrivateUrls },
      );
      const ok = res.status >= 200 && res.status < 300;
      return { ok, httpStatus: res.status, error: ok ? null : `Slack answered ${res.status}` };
    } catch (error) {
      return { ok: false, httpStatus: null, error: (error as Error).message };
    }
  });
}
