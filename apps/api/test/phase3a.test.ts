/**
 * Phase 3A through the API: folders and teams, comments on drafts, approvals before publishing, the
 * audit-log viewer, notification rules, API keys with scopes, rate limits and idempotency keys, the
 * OpenAPI document and a client generated from it, outgoing webhooks (signing, retries, redelivery,
 * auto-disable, SSRF) and integrations (Slack, HubSpot and Google Sheets contracts).
 */
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Validator } from '@seriousme/openapi-schema-validator';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { SurveyDefinition } from '@survey/core';
import { verifyWebhook } from '../../../docs/examples/verify-webhook.mjs';
import { PUBLIC_ROUTES } from '../src/auth/api-keys';
import type { DomainEvent } from '../src/events';
import { deliverWebhook, RETRY_DELAYS_SEC } from '../src/jobs/events';
import {
  googleSheetsConnector,
  hubspotConnector,
  syncResponse,
  type ResponseRecord,
} from '../src/integrations/connectors';
import { isPrivateAddress, postJson } from '../src/lib/outbound';
import {
  addMember,
  createSurvey,
  createTestContext,
  definitionWith,
  drainJobs,
  publishedSurvey,
  Respondent,
  saveDraft,
  signup,
  type Client,
  type TestContext,
} from './helpers';

let ctx: TestContext;
let admin: Client;

beforeAll(async () => {
  ctx = await createTestContext();
  admin = await signup(ctx.app, { orgName: 'Phase 3A org' });
}, 60_000);
afterAll(async () => ctx.close());

// ── Helpers ────────────────────────────────────────────────────────────────
interface Received {
  url: string;
  headers: IncomingHttpHeaders;
  body: string;
}

/** A local HTTP endpoint that records what it receives and answers with `status`. */
async function receiver() {
  const received: Received[] = [];
  const state = { status: 200 };
  const server: Server = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk: Buffer) => (body += chunk.toString('utf8')));
    req.on('end', () => {
      received.push({ url: req.url ?? '', headers: req.headers, body });
      res.writeHead(state.status, { 'content-type': 'application/json' });
      res.end('{"ok":true}');
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    base: `http://127.0.0.1:${port}`,
    url: `http://127.0.0.1:${port}/hook`,
    received,
    state,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

/** Call the API with an API key (no cookie, no CSRF token). */
async function withKey(
  key: string,
  method: string,
  url: string,
  body?: unknown,
  headers: Record<string, string> = {},
) {
  const res = await ctx.app.inject({
    method: method as 'GET',
    url,
    headers: {
      authorization: `Bearer ${key}`,
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...headers,
    },
    ...(body !== undefined ? { payload: JSON.stringify(body) } : {}),
  });
  const json = String(res.headers['content-type'] ?? '').includes('json') ? res.json() : undefined;
  return { status: res.statusCode, body: json, headers: res.headers, raw: res.body };
}

async function createKey(client: Client, scopes: string[], name = 'Integration') {
  const res = await client.post('/api/v1/api-keys', { name, scopes });
  expect(res.status).toBe(201);
  return res.body as { id: string; key: string; prefix: string };
}

const keyOf = (def: SurveyDefinition, page = 0, index = 0) => {
  const element = def.pages[page]!.elements[index]!;
  return element.key;
};

// ── Folders and teams ──────────────────────────────────────────────────────
describe('folders', () => {
  it('nests three levels at most, refuses cycles and duplicate names, and files surveys', async () => {
    const a = await admin.post('/api/v1/folders', { name: 'Research' });
    expect(a.status).toBe(201);
    const b = await admin.post('/api/v1/folders', { name: 'Customers', parentId: a.body.id });
    const c = await admin.post('/api/v1/folders', { name: '2026', parentId: b.body.id });
    expect(c.body.depth).toBe(3);
    const d = await admin.post('/api/v1/folders', { name: 'Too deep', parentId: c.body.id });
    expect(d.status).toBe(422);
    expect(d.body.code).toBe('too_deep');
    expect((await admin.post('/api/v1/folders', { name: 'customers', parentId: a.body.id })).body.code).toBe(
      'folder_exists',
    );
    // A folder can't move into its own subtree, nor below a level that would make four.
    expect((await admin.patch(`/api/v1/folders/${a.body.id}`, { parentId: c.body.id })).body.code).toBe(
      'invalid_parent',
    );
    const top = await admin.post('/api/v1/folders', { name: 'Archive' });
    expect((await admin.patch(`/api/v1/folders/${a.body.id}`, { parentId: top.body.id })).body.code).toBe(
      'too_deep',
    );
    expect((await admin.patch(`/api/v1/folders/${c.body.id}`, { parentId: top.body.id })).status).toBe(200);

    const survey = await createSurvey(admin, 'Filed survey');
    expect((await admin.patch(`/api/v1/surveys/${survey.id}`, { folderId: b.body.id })).body.folderId).toBe(
      b.body.id,
    );
    const inFolder = await admin.get(`/api/v1/surveys?folderId=${b.body.id}`);
    expect(inFolder.body.data.map((s: { id: string }) => s.id)).toEqual([survey.id]);
    const outside = await admin.get('/api/v1/surveys?folderId=none');
    expect(outside.body.data.some((s: { id: string }) => s.id === survey.id)).toBe(false);
    const counted = (await admin.get('/api/v1/folders')).body.find((f: { id: string }) => f.id === b.body.id);
    expect(counted.surveyCount).toBe(1);

    // A creator sees the tree but only counts surveys they can see; an analyst can't change it.
    const creator = await addMember(ctx, admin, 'creator', 'Folder creator');
    expect(
      (await creator.get('/api/v1/folders')).body.find((f: { id: string }) => f.id === b.body.id).surveyCount,
    ).toBe(0);
    const analyst = await addMember(ctx, admin, 'analyst', 'Folder analyst');
    expect((await analyst.post('/api/v1/folders', { name: 'Nope' })).status).toBe(403);

    // Deleting a folder moves its surveys and subfolders up a level.
    expect((await admin.delete(`/api/v1/folders/${b.body.id}`)).status).toBe(204);
    expect((await admin.get(`/api/v1/surveys/${survey.id}`)).body.folderId).toBe(a.body.id);
  });
});

describe('teams', () => {
  it('shares a survey with a team; each member gets the team role capped by their org role', async () => {
    const creator = await addMember(ctx, admin, 'creator', 'Team creator');
    const analyst = await addMember(ctx, admin, 'analyst', 'Team analyst');
    const outsider = await addMember(ctx, admin, 'creator', 'Not in team');
    const team = await admin.post('/api/v1/org/teams', { name: 'Research team' });
    expect(team.status).toBe(201);
    const members = await admin.put(`/api/v1/org/teams/${team.body.id}/members`, {
      userIds: [creator.userId, analyst.userId],
    });
    expect(members.body.members).toHaveLength(2);
    expect((await creator.post('/api/v1/org/teams', { name: 'Mine' })).status).toBe(403);

    const survey = await createSurvey(admin, 'Team survey');
    expect((await creator.get(`/api/v1/surveys/${survey.id}`)).status).toBe(404);
    const shared = await admin.put(`/api/v1/surveys/${survey.id}/teams/${team.body.id}`, { role: 'editor' });
    expect(shared.body).toEqual([
      { team: { id: team.body.id, name: 'Research team', memberCount: 2 }, role: 'editor' },
    ]);

    expect((await creator.get(`/api/v1/surveys/${survey.id}`)).body.myRole).toBe('editor');
    expect(
      (await creator.get('/api/v1/surveys')).body.data.some((s: { id: string }) => s.id === survey.id),
    ).toBe(true);
    expect((await saveDraft(creator, survey.id, definitionWith(['short_text']))).status).toBe(200);
    // Analysts stay viewers whatever the team role.
    expect((await analyst.get(`/api/v1/surveys/${survey.id}`)).body.myRole).toBe('viewer');
    expect((await saveDraft(analyst, survey.id, definitionWith(['short_text']))).status).toBe(403);
    expect((await outsider.get(`/api/v1/surveys/${survey.id}`)).status).toBe(404);

    expect((await admin.delete(`/api/v1/surveys/${survey.id}/teams/${team.body.id}`)).status).toBe(204);
    expect((await creator.get(`/api/v1/surveys/${survey.id}`)).status).toBe(404);
  });
});

// ── Comments ───────────────────────────────────────────────────────────────
describe('comments on drafts', () => {
  it('anchors to a question, threads, resolves, and never reaches respondents', async () => {
    const viewer = await addMember(ctx, admin, 'analyst', 'Commenting viewer');
    const other = await addMember(ctx, admin, 'analyst', 'Other viewer');
    const definition = definitionWith(['short_text', 'nps']);
    const { survey } = await publishedSurvey(admin, definition, 'Commented survey');
    for (const person of [viewer, other])
      await admin.put(`/api/v1/surveys/${survey.id}/collaborators/${person.userId}`, { role: 'viewer' });
    const q = keyOf(definition);

    const root = await viewer.post(`/api/v1/surveys/${survey.id}/comments`, {
      body: 'SECRET-REVIEW-NOTE: reword this',
      anchorKey: q,
    });
    expect(root.status).toBe(201);
    expect(root.body).toMatchObject({ anchorKey: q, parentId: null, mine: true });
    const reply = await admin.post(`/api/v1/surveys/${survey.id}/comments`, {
      body: 'Done',
      parentId: root.body.id,
    });
    expect(reply.body).toMatchObject({ anchorKey: q, parentId: root.body.id });
    // A reply to a reply joins the same thread.
    const nested = await viewer.post(`/api/v1/surveys/${survey.id}/comments`, {
      body: 'Thanks',
      parentId: reply.body.id,
    });
    expect(nested.body.parentId).toBe(root.body.id);
    expect(
      (await viewer.post(`/api/v1/surveys/${survey.id}/comments`, { body: 'x', anchorKey: 'q_missing' })).body
        .code,
    ).toBe('invalid_anchor');

    // Only the author edits; the author or an editor resolves.
    expect(
      (await other.patch(`/api/v1/surveys/${survey.id}/comments/${root.body.id}`, { body: 'hijack' })).status,
    ).toBe(403);
    expect(
      (await other.patch(`/api/v1/surveys/${survey.id}/comments/${root.body.id}`, { resolved: true })).status,
    ).toBe(403);
    const resolved = await admin.patch(`/api/v1/surveys/${survey.id}/comments/${reply.body.id}`, {
      resolved: true,
    });
    expect(resolved.status).toBe(200);
    const list = await viewer.get(`/api/v1/surveys/${survey.id}/comments`);
    expect(list.body).toHaveLength(3);
    expect(list.body.find((c: { id: string }) => c.id === root.body.id).resolvedAt).not.toBeNull();

    const respondentView = await new Respondent(ctx.app, survey.publicId).load();
    expect(JSON.stringify(respondentView.body)).not.toContain('SECRET-REVIEW-NOTE');

    const elsewhere = await signup(ctx.app, { orgName: 'Other org' });
    expect((await elsewhere.get(`/api/v1/surveys/${survey.id}/comments`)).status).toBe(404);
  });
});

// ── Approvals ──────────────────────────────────────────────────────────────
describe('approval before publishing', () => {
  it('creates a request, refuses self-approval, publishes exactly the reviewed revision', async () => {
    const org = await signup(ctx.app, { orgName: 'Approvals org' });
    const author = await addMember(ctx, org, 'creator', 'Author');
    const reviewer = await addMember(ctx, org, 'creator', 'Reviewer');
    const analyst = await addMember(ctx, org, 'analyst', 'Analyst');
    expect((await org.patch('/api/v1/org', { approverIds: [analyst.userId] })).body.code).toBe(
      'invalid_approvers',
    );
    const settings = await org.patch('/api/v1/org', {
      approvalRequired: true,
      approverIds: [reviewer.userId],
    });
    expect(settings.body).toMatchObject({ approvalRequired: true, approverIds: [reviewer.userId] });

    const survey = await createSurvey(author, 'Needs approval');
    const saved = await saveDraft(author, survey.id, definitionWith(['short_text']));
    const asked = await author.post(`/api/v1/surveys/${survey.id}/publish`, {
      revision: saved.body.revision,
      note: 'Ready',
    });
    expect(asked.status).toBe(202);
    expect(asked.body.approvalRequest).toMatchObject({
      status: 'pending',
      revision: saved.body.revision,
      requestNote: 'Ready',
      canDecide: false,
    });
    expect((await author.get(`/api/v1/surveys/${survey.id}`)).body).toMatchObject({
      status: 'draft',
      pendingApproval: true,
    });
    const requestId = asked.body.approvalRequest.id;
    expect((await author.post(`/api/v1/approval-requests/${requestId}/approve`, {})).body.code).toBe(
      'self_approval',
    );
    // The designated approver needs to see the survey to review it.
    expect((await reviewer.post(`/api/v1/approval-requests/${requestId}/approve`, {})).status).toBe(404);
    await author.put(`/api/v1/surveys/${survey.id}/collaborators/${reviewer.userId}`, { role: 'viewer' });
    // Approvers are told.
    await drainJobs(ctx);
    expect((await reviewer.get('/api/v1/notifications')).body.data[0].title).toContain(
      'waiting for approval',
    );

    const approved = await reviewer.post(`/api/v1/approval-requests/${requestId}/approve`, {
      note: 'Looks good',
    });
    expect(approved.status).toBe(200);
    expect(approved.body).toMatchObject({
      status: 'approved',
      decisionNote: 'Looks good',
      decidedBy: { id: reviewer.userId },
    });
    const live = (await author.get(`/api/v1/surveys/${survey.id}`)).body;
    expect(live).toMatchObject({ status: 'live', currentVersionNumber: 1, pendingApproval: false });
    const versions = await author.get(`/api/v1/surveys/${survey.id}/versions`);
    expect(versions.body[0].publishedBy).toBe('Author');

    // An edit after asking supersedes the request: approving it is refused.
    await author.post(`/api/v1/surveys/${survey.id}/draft`);
    const v2 = await saveDraft(author, survey.id, definitionWith(['short_text', 'nps']));
    const second = await author.post(`/api/v1/surveys/${survey.id}/publish`, { revision: v2.body.revision });
    const v2b = await saveDraft(author, survey.id, definitionWith(['short_text', 'nps', 'email']));
    expect(v2b.status).toBe(200);
    const stale = await org.post(`/api/v1/approval-requests/${second.body.approvalRequest.id}/approve`, {});
    expect(stale.status).toBe(409);
    expect(stale.body.code).toBe('not_pending');
    const third = await author.post(`/api/v1/surveys/${survey.id}/publish`, { revision: v2b.body.revision });
    const rejected = await org.post(`/api/v1/approval-requests/${third.body.approvalRequest.id}/reject`, {
      note: 'Not yet',
    });
    expect(rejected.body.status).toBe('rejected');
    expect((await author.get(`/api/v1/surveys/${survey.id}`)).body.currentVersionNumber).toBe(1);
    const history = await org.get(`/api/v1/approval-requests?surveyId=${survey.id}`);
    expect(history.body.map((r: { status: string }) => r.status)).toEqual([
      'rejected',
      'superseded',
      'approved',
    ]);

    // Audit trail of the decision and the publish.
    const audit = await org.get(`/api/v1/audit-logs?entityId=${survey.id}`);
    const actions = audit.body.data.map((e: { action: string }) => e.action);
    expect(actions).toEqual(
      expect.arrayContaining([
        'survey.approval_requested',
        'survey.approval_approved',
        'survey.published',
        'survey.approval_rejected',
      ]),
    );
  });
});

// ── Audit log viewer ───────────────────────────────────────────────────────
describe('audit log viewer', () => {
  it('filters by actor, action, entity and date, exports CSV, and is append-only for the app', async () => {
    const creator = await addMember(ctx, admin, 'creator', 'Audited creator');
    const survey = await createSurvey(creator, 'Audited survey');
    const byActor = await admin.get(`/api/v1/audit-logs?actorId=${creator.userId}`);
    expect(byActor.body.data.every((e: { actor: { id: string } }) => e.actor.id === creator.userId)).toBe(
      true,
    );
    expect(byActor.body.data[0]).toMatchObject({
      action: 'survey.created',
      entityId: survey.id,
      actor: { type: 'user', name: 'Audited creator' },
    });
    // A prefix matches a family of actions.
    const surveyActions = await admin.get('/api/v1/audit-logs?action=survey&limit=100');
    expect(surveyActions.body.data.every((e: { action: string }) => e.action.startsWith('survey.'))).toBe(
      true,
    );
    const future = await admin.get(
      `/api/v1/audit-logs?from=${encodeURIComponent(new Date(Date.now() + 3600_000).toISOString())}`,
    );
    expect(future.body.data).toEqual([]);
    const page = await admin.get('/api/v1/audit-logs?limit=2');
    const next = await admin.get(`/api/v1/audit-logs?limit=2&cursor=${page.body.nextCursor}`);
    expect(next.body.data[0].id).toBeLessThan(page.body.data[1].id);

    const csv = await admin.get(`/api/v1/audit-logs/export.csv?entityId=${survey.id}`);
    expect(csv.status).toBe(200);
    expect(csv.headers['content-type']).toContain('text/csv');
    expect(csv.raw).toContain('id,time,action,actor_type');
    expect(csv.raw).toContain('survey.created');
    expect((await admin.get('/api/v1/audit-logs?action=audit_logs.exported')).body.data).toHaveLength(1);
    expect((await creator.get('/api/v1/audit-logs')).status).toBe(403);

    // The app's database role can read and add audit rows, never change or delete them.
    for (const statement of [
      'update audit_logs set action = $1',
      'delete from audit_logs where action <> $1',
    ]) {
      const client = await ctx.deps.pool.connect();
      try {
        await client.query('begin');
        await client.query(`select set_config('app.org_id', $1, true)`, [admin.orgId]);
        await expect(client.query(statement, ['tampered'])).rejects.toMatchObject({ code: '42501' });
      } finally {
        await client.query('rollback');
        client.release();
      }
    }
  });
});

// ── Notifications ──────────────────────────────────────────────────────────
describe('notification rules', () => {
  it('fire once per event on the chosen channels and respect each user’s preferences', async () => {
    const slack = await receiver();
    ctx.deps.config.allowPrivateUrls = true;
    try {
      const org = await signup(ctx.app, { orgName: 'Notify org' });
      const watcher = await addMember(ctx, org, 'analyst', 'Watcher');
      expect(
        (await org.put('/api/v1/integrations/slack', { webhookUrl: slack.url, channelName: '#surveys' }))
          .status,
      ).toBe(200);
      const definition = definitionWith(['nps', 'short_text']);
      const { survey } = await publishedSurvey(org, definition, 'Watched survey');
      await org.put(`/api/v1/surveys/${survey.id}/collaborators/${watcher.userId}`, { role: 'viewer' });
      const nps = keyOf(definition);

      expect(
        (
          await org.put(`/api/v1/surveys/${survey.id}/notification-rules`, {
            rules: [{ kind: 'threshold', config: {}, channels: ['in_app'] }],
          })
        ).body.code,
      ).toBe('invalid_rule');
      const rules = await org.put(`/api/v1/surveys/${survey.id}/notification-rules`, {
        rules: [
          { kind: 'new_response', channels: ['in_app', 'email', 'slack'] },
          { kind: 'nps_detractor', config: { questionKey: nps }, channels: ['in_app', 'email', 'slack'] },
          { kind: 'threshold', config: { count: 2 }, channels: ['in_app'] },
          { kind: 'closing', channels: ['in_app', 'slack'] },
        ],
      });
      expect(rules.status).toBe(200);
      // The watcher only wants new responses in the app, not by email.
      await watcher.put('/api/v1/notifications/preferences', { channels: { new_response: ['in_app'] } });
      ctx.deps.mailer.outbox.length = 0;

      await new Respondent(ctx.app, survey.publicId).complete({ [nps]: 3 });
      await drainJobs(ctx);
      const titles = async (c: Client) =>
        (await c.get('/api/v1/notifications')).body.data.map((n: { title: string }) => n.title);
      const expected = [`New response to "Watched survey"`, `Detractor response to "Watched survey"`];
      expect((await titles(org)).sort()).toEqual([...expected].sort());
      expect((await titles(watcher)).sort()).toEqual([...expected].sort());
      const emails = ctx.deps.mailer.outbox.map((m) => `${m.to}|${m.subject}`);
      expect(emails.filter((e) => e.startsWith(watcher.email))).toEqual([
        `${watcher.email}|Detractor response to "Watched survey"`,
      ]);
      expect(emails.filter((e) => !e.startsWith(watcher.email))).toHaveLength(2);

      await new Respondent(ctx.app, survey.publicId).complete({ [nps]: 10 });
      await new Respondent(ctx.app, survey.publicId).complete({ [nps]: 9 });
      await drainJobs(ctx);
      const all = (await org.get('/api/v1/notifications?limit=50')).body;
      expect(all.data.filter((n: { title: string }) => n.title.includes('reached 2 responses'))).toHaveLength(
        1,
      );
      expect(all.data.filter((n: { title: string }) => n.title.startsWith('New response'))).toHaveLength(3);
      expect(all.data.filter((n: { title: string }) => n.title.startsWith('Detractor'))).toHaveLength(1);

      // The same event dispatched again (a retried job) notifies nobody twice.
      const before = all.data.length;
      const event: DomainEvent = {
        id: 'evt_replayed0000000000000000000000',
        type: 'survey.closed',
        orgId: org.orgId,
        surveyId: survey.id,
        occurredAt: new Date().toISOString(),
        reason: 'manual',
      };
      await ctx.handlers['events.dispatch'](event);
      await ctx.handlers['events.dispatch'](event);
      await drainJobs(ctx);
      const after = (await org.get('/api/v1/notifications?limit=50')).body;
      expect(after.data.length).toBe(before + 1);
      expect(after.data[0].title).toBe('"Watched survey" closed');
      // Slack got each new response, the detractor and the close (once each).
      const slackTexts = slack.received.map((r) => JSON.parse(r.body).text as string);
      expect(slackTexts.filter((t) => t.startsWith('*New response to'))).toHaveLength(3);
      expect(slackTexts.filter((t) => t.startsWith('*Detractor response to'))).toHaveLength(1);
      expect(slackTexts.filter((t) => t.startsWith('*"Watched survey" closed'))).toHaveLength(1);
      expect(slackTexts).toHaveLength(5);

      expect(after.unread).toBeGreaterThan(0);
      expect((await org.post('/api/v1/notifications/read', { all: true })).status).toBe(204);
      expect((await org.get('/api/v1/notifications')).body.unread).toBe(0);
      // Saving the same rules again keeps their identity, so the threshold doesn't fire twice.
      const again = await org.put(`/api/v1/surveys/${survey.id}/notification-rules`, {
        rules: rules.body.map(({ id: _, ...r }: { id: string }) => r),
      });
      expect(again.body.map((r: { id: string }) => r.id)).toEqual(
        rules.body.map((r: { id: string }) => r.id),
      );
    } finally {
      ctx.deps.config.allowPrivateUrls = false;
      await slack.close();
    }
  });
});

// ── API keys ───────────────────────────────────────────────────────────────
describe('API keys', () => {
  it('are shown once, stored hashed, scoped, rate limited and revocable', async () => {
    const reader = await createKey(admin, ['surveys:read'], 'Reader');
    expect(reader.key).toMatch(/^sk_live_[A-Za-z0-9_-]{32}$/);
    const { rows } = await ctx.owner.query(`select prefix, key_hash from api_keys where id = $1`, [
      reader.id,
    ]);
    expect(rows[0].prefix).toBe(reader.key.slice(0, 12));
    expect(Buffer.from(rows[0].key_hash).toString('utf8')).not.toContain(reader.key);
    expect(JSON.stringify((await admin.get('/api/v1/api-keys')).body)).not.toContain(reader.key);

    const list = await withKey(reader.key, 'GET', '/api/v1/surveys');
    expect(list.status).toBe(200);
    expect(list.headers['ratelimit-limit']).toBe('600');
    expect(Number(list.headers['ratelimit-remaining'])).toBeLessThan(600);
    const write = await withKey(reader.key, 'POST', '/api/v1/surveys', { title: 'Nope' });
    expect(write.status).toBe(403);
    expect(write.body).toMatchObject({ code: 'insufficient_scope', requiredScope: 'surveys:write' });
    expect((await withKey(reader.key, 'GET', '/api/v1/org/members')).body.code).toBe(
      'not_available_with_api_key',
    );
    expect((await withKey(reader.key, 'GET', '/api/v1/api-keys')).body.code).toBe(
      'not_available_with_api_key',
    );

    // Writes need no CSRF token, and the audit log names the key.
    const writer = await createKey(admin, ['surveys:read', 'surveys:write'], 'Writer');
    const created = await withKey(writer.key, 'POST', '/api/v1/surveys', { title: 'Made by a key' });
    expect(created.status).toBe(201);
    const entry = (await admin.get(`/api/v1/audit-logs?entityId=${created.body.id}`)).body.data[0];
    expect(entry.actor).toEqual({ type: 'api_key', id: writer.id, name: 'Writer' });
    expect(entry.metadata.keyCreatedBy).toBe(admin.userId);

    // Another org's survey stays invisible.
    const other = await signup(ctx.app, { orgName: 'Key-less org' });
    const theirs = await createSurvey(other, 'Theirs');
    expect((await withKey(writer.key, 'GET', `/api/v1/surveys/${theirs.id}`)).status).toBe(404);

    // Rate limit.
    ctx.deps.config.apiKeyRequestsPerMinute = 3;
    try {
      const limited = await createKey(admin, ['surveys:read'], 'Limited');
      for (let i = 0; i < 3; i++)
        expect((await withKey(limited.key, 'GET', '/api/v1/surveys')).status).toBe(200);
      const over = await withKey(limited.key, 'GET', '/api/v1/surveys');
      expect(over.status).toBe(429);
      expect(Number(over.headers['retry-after'])).toBeGreaterThan(0);
    } finally {
      ctx.deps.config.apiKeyRequestsPerMinute = 600;
    }

    // Revoked, expired, and keys whose creator is no longer an admin stop working.
    expect((await admin.delete(`/api/v1/api-keys/${reader.id}`)).status).toBe(204);
    expect((await withKey(reader.key, 'GET', '/api/v1/surveys')).status).toBe(401);
    await ctx.owner.query(`update api_keys set expires_at = now() - interval '1 minute' where id = $1`, [
      writer.id,
    ]);
    expect((await withKey(writer.key, 'GET', '/api/v1/surveys')).body.title).toContain('expired');
    const secondAdmin = await addMember(ctx, admin, 'org_admin', 'Second admin');
    const theirKey = await createKey(secondAdmin, ['surveys:read']);
    expect((await withKey(theirKey.key, 'GET', '/api/v1/surveys')).status).toBe(200);
    await admin.patch(`/api/v1/org/members/${secondAdmin.userId}`, { role: 'creator' });
    expect((await withKey(theirKey.key, 'GET', '/api/v1/surveys')).status).toBe(401);
    expect((await withKey('sk_live_not-a-real-key-000000000000000', 'GET', '/api/v1/surveys')).status).toBe(
      401,
    );
    // Only admins manage keys.
    expect((await secondAdmin.post('/api/v1/api-keys', { name: 'x', scopes: ['surveys:read'] })).status).toBe(
      403,
    );
  });

  it('replays a POST with the same Idempotency-Key instead of running it twice', async () => {
    const key = await createKey(admin, ['surveys:read', 'surveys:write'], 'Idempotent');
    const first = await withKey(
      key.key,
      'POST',
      '/api/v1/surveys',
      { title: 'Exactly once' },
      { 'idempotency-key': 'order-42' },
    );
    const second = await withKey(
      key.key,
      'POST',
      '/api/v1/surveys',
      { title: 'Exactly once' },
      { 'idempotency-key': 'order-42' },
    );
    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(second.body.id).toBe(first.body.id);
    expect(second.headers['idempotent-replayed']).toBe('true');
    const { rows } = await ctx.owner.query(
      `select count(*)::int as n from surveys where title = 'Exactly once'`,
    );
    expect(rows[0].n).toBe(1);
    const changed = await withKey(
      key.key,
      'POST',
      '/api/v1/surveys',
      { title: 'Something else' },
      { 'idempotency-key': 'order-42' },
    );
    expect(changed.status).toBe(422);
    expect(changed.body.code).toBe('idempotency_key_reused');
    // Keys are per caller: the same value from someone else is a new request.
    const viaSession = await admin.post(
      '/api/v1/surveys',
      { title: 'Exactly once' },
      { 'idempotency-key': 'order-42' },
    );
    expect(viaSession.body.id).not.toBe(first.body.id);
  });
});

// ── OpenAPI ────────────────────────────────────────────────────────────────
describe('OpenAPI document', () => {
  it('validates as OpenAPI 3.1 and covers exactly the registered public routes', async () => {
    const res = await ctx.app.inject({ method: 'GET', url: '/api/v1/openapi.json' });
    expect(res.statusCode).toBe(200);
    const doc = res.json();
    const result = await new Validator().validate(doc);
    expect(result.errors ?? []).toEqual([]);
    expect(result.valid).toBe(true);
    for (const route of Object.keys(PUBLIC_ROUTES)) {
      const [method, url] = route.split(' ') as [string, string];
      expect(ctx.app.hasRoute({ method: method as 'GET', url }), route).toBe(true);
      expect(doc.paths[url.replace(/:(\w+)/g, '{$1}')][method.toLowerCase()]).toBeDefined();
    }
    expect(Object.keys(doc.webhooks)).toEqual(['response.submitted', 'survey.published', 'survey.closed']);
  });

  it('drives a smoke test through a client generated from the document', async () => {
    const doc = (await ctx.app.inject({ method: 'GET', url: '/api/v1/openapi.json' })).json() as {
      paths: Record<
        string,
        Record<string, { operationId: string; parameters: { name: string; in: string }[] }>
      >;
    };
    const key = await createKey(
      admin,
      ['surveys:read', 'surveys:write', 'responses:read', 'webhooks:manage'],
      'Generated client',
    );
    type Args = {
      params?: Record<string, string>;
      query?: Record<string, string>;
      body?: unknown;
      headers?: Record<string, string>;
    };
    // Generate one method per operationId: path parameters, query string, JSON body, bearer auth.
    const client: Record<string, (args?: Args) => ReturnType<typeof withKey>> = {};
    for (const [path, operations] of Object.entries(doc.paths))
      for (const [method, operation] of Object.entries(operations))
        client[operation.operationId] = (args = {}) => {
          const url = path.replace(/\{(\w+)\}/g, (_, name: string) =>
            encodeURIComponent(args.params?.[name] ?? ''),
          );
          const query = args.query ? `?${new URLSearchParams(args.query)}` : '';
          return withKey(key.key, method.toUpperCase(), `${url}${query}`, args.body, args.headers);
        };

    const created = await client.createSurvey!({
      body: { title: 'Generated' },
      headers: { 'idempotency-key': 'gen-1' },
    });
    expect(created.status).toBe(201);
    const id = created.body.id as string;
    const draft = await client.getDraft!({ params: { id } });
    const definition = definitionWith(['short_text']);
    const saved = await client.saveDraft!({
      params: { id },
      body: { definition },
      headers: { 'if-match': draft.headers.etag as string },
    });
    expect(saved.status).toBe(200);
    const published = await client.publishSurvey!({
      params: { id },
      body: { revision: saved.body.revision },
    });
    expect(published.status).toBe(200);
    expect((await client.getSurvey!({ params: { id } })).body.status).toBe('live');
    expect(
      (await client.listSurveys!({ query: { status: 'live' } })).body.data.some(
        (s: { id: string }) => s.id === id,
      ),
    ).toBe(true);
    await new Respondent(ctx.app, created.body.publicId).complete({ [keyOf(definition)]: 'Hello' });
    expect((await client.listResponses!({ params: { id } })).body.data).toHaveLength(1);
    expect((await client.listWebhooks!()).status).toBe(200);
    expect(
      (await client.deleteResponse!({ params: { id, responseId: '00000000-0000-0000-0000-000000000000' } }))
        .body.code,
    ).toBe('insufficient_scope');
  });
});

// ── Webhooks ───────────────────────────────────────────────────────────────
describe('webhooks', () => {
  it('refuses private, loopback and metadata addresses (SSRF)', async () => {
    ctx.deps.config.allowPrivateUrls = false;
    for (const url of [
      'http://127.0.0.1:8080/hook',
      'http://localhost/hook',
      'http://169.254.169.254/latest',
      'http://[::1]/x',
      'http://10.1.2.3/x',
      'http://192.168.1.1/x',
      'ftp://example.com/x',
      'https://user:pass@example.com/x',
    ]) {
      const res = await admin.post('/api/v1/webhooks', { url, events: ['response.submitted'] });
      expect(res.status, url).toBe(422);
    }
    for (const address of [
      '127.0.0.1',
      '10.0.0.8',
      '172.16.4.1',
      '192.168.0.1',
      '169.254.169.254',
      '100.64.0.1',
      '0.0.0.0',
      '::1',
      'fd00::1',
      'fe80::1',
      '::ffff:127.0.0.1',
      '::ffff:10.0.0.1',
    ])
      expect(isPrivateAddress(address), address).toBe(true);
    for (const address of ['93.184.216.34', '1.1.1.1', '2606:4700:4700::1111'])
      expect(isPrivateAddress(address), address).toBe(false);
    // Checked again when sending, for an address written as an IPv4-mapped IPv6 literal.
    await expect(postJson('http://[::ffff:7f00:1]/x', '{}', { allowPrivate: false })).rejects.toMatchObject({
      code: 'blocked_address',
    });
  });

  it('signs deliveries, retries on schedule, redelivers, and disables a failing endpoint', async () => {
    const endpoint = await receiver();
    ctx.deps.config.allowPrivateUrls = true;
    try {
      const org = await signup(ctx.app, { orgName: 'Webhook org' });
      const definition = definitionWith(['short_text', 'nps']);
      const { survey } = await publishedSurvey(org, definition, 'Hooked survey');
      const { survey: ignored } = await publishedSurvey(org, definitionWith(['short_text']), 'Not hooked');
      const hook = await org.post('/api/v1/webhooks', {
        url: endpoint.url,
        events: ['response.submitted', 'survey.closed'],
        surveyIds: [survey.id],
        description: 'CRM sync',
      });
      expect(hook.status).toBe(201);
      const secret = hook.body.secret as string;
      expect(secret).toMatch(/^whsec_/);
      expect(JSON.stringify((await org.get(`/api/v1/webhooks/${hook.body.id}`)).body)).not.toContain(secret);
      const { rows } = await ctx.owner.query('select secret_enc from webhooks where id = $1', [hook.body.id]);
      expect(rows[0].secret_enc).not.toContain(secret);

      // Delivered, signed and verifiable with the sample verifier from the docs.
      await new Respondent(ctx.app, survey.publicId).complete({
        [keyOf(definition)]: 'Great',
        [keyOf(definition, 0, 1)]: 9,
      });
      await new Respondent(ctx.app, ignored.publicId).complete({});
      await drainJobs(ctx);
      expect(endpoint.received).toHaveLength(1);
      const first = endpoint.received[0]!;
      expect(verifyWebhook(secret, first.headers, first.body)).toBe(true);
      expect(verifyWebhook('whsec_wrong', first.headers, first.body)).toBe(false);
      expect(verifyWebhook(secret, first.headers, first.body.replace('Great', 'Grate'))).toBe(false);
      const payload = JSON.parse(first.body);
      expect(payload).toMatchObject({
        type: 'response.submitted',
        data: { surveyId: survey.id, status: 'completed', versionNumber: 1 },
      });
      expect(first.headers['survey-webhook-id']).toBe(payload.id);
      expect(payload.data.answers.map((a: { display: string }) => a.display)).toEqual(['Great', '9']);

      // Failures retry after 1 m, 5 m, 30 m, 2 h, 6 h, 12 h and 24 h, then the delivery fails.
      endpoint.state.status = 500;
      await new Respondent(ctx.app, survey.publicId).complete({ [keyOf(definition)]: 'Retry me' });
      await drainJobs(ctx);
      const failing = (await org.get(`/api/v1/webhooks/${hook.body.id}/deliveries?status=pending`)).body
        .data[0];
      expect(failing).toMatchObject({ attempts: 1, httpStatus: 500, status: 'pending' });
      const gaps: number[] = [];
      for (let attempt = 1; attempt <= RETRY_DELAYS_SEC.length; attempt++) {
        const { rows: before } = await ctx.owner.query(
          'select next_attempt_at from webhook_deliveries where id = $1',
          [failing.id],
        );
        const { rows: last } = await ctx.owner.query(
          'select max(created_at) as at from webhook_attempts where delivery_id = $1',
          [failing.id],
        );
        gaps.push(Math.round((before[0].next_attempt_at.getTime() - last[0].at.getTime()) / 1000));
        await deliverWebhook(ctx.deps, { orgId: org.orgId, deliveryId: failing.id });
      }
      gaps.forEach((gap, i) => expect(Math.abs(gap - RETRY_DELAYS_SEC[i]!)).toBeLessThanOrEqual(2));
      const detail = (await org.get(`/api/v1/webhooks/${hook.body.id}/deliveries/${failing.id}`)).body;
      expect(detail).toMatchObject({ status: 'failed', attempts: 8, nextAttemptAt: null });
      expect(detail.attemptLog.map((a: { attempt: number }) => a.attempt)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
      expect(new Set(endpoint.received.slice(1).map((r) => r.headers['survey-webhook-id'])).size).toBe(1);
      expect((await org.get(`/api/v1/webhooks/${hook.body.id}`)).body.consecutiveFailures).toBe(1);

      // Redeliver once the endpoint works again: one manual attempt, same event id.
      endpoint.state.status = 200;
      expect(
        (await org.post(`/api/v1/webhooks/${hook.body.id}/deliveries/${failing.id}/redeliver`)).status,
      ).toBe(202);
      await drainJobs(ctx);
      const redelivered = (await org.get(`/api/v1/webhooks/${hook.body.id}/deliveries/${failing.id}`)).body;
      expect(redelivered.status).toBe('succeeded');
      expect(redelivered.attemptLog.at(-1)).toMatchObject({ attempt: 9, manual: true, httpStatus: 200 });

      // Test ping.
      const ping = await org.post(`/api/v1/webhooks/${hook.body.id}/test`);
      expect(ping.body).toMatchObject({ httpStatus: 200, error: null });
      expect(JSON.parse(endpoint.received.at(-1)!.body).type).toBe('ping');

      // Rotation: both secrets verify for 24 hours.
      const rotated = await org.post(`/api/v1/webhooks/${hook.body.id}/rotate-secret`);
      await org.post(`/api/v1/surveys/${survey.id}/close`);
      await drainJobs(ctx);
      const closed = endpoint.received.at(-1)!;
      expect(JSON.parse(closed.body)).toMatchObject({ type: 'survey.closed', data: { reason: 'manual' } });
      expect(String(closed.headers['survey-webhook-signature']).split(' ')).toHaveLength(2);
      expect(verifyWebhook(rotated.body.secret, closed.headers, closed.body)).toBe(true);
      expect(verifyWebhook(secret, closed.headers, closed.body)).toBe(true);
      await org.post(`/api/v1/surveys/${survey.id}/reopen`);

      // 50 events in a row that fail every attempt disable the endpoint and tell the admins.
      await ctx.owner.query('update webhooks set consecutive_failures = 49 where id = $1', [hook.body.id]);
      endpoint.state.status = 503;
      await new Respondent(ctx.app, survey.publicId).complete({ [keyOf(definition)]: 'Last straw' });
      await drainJobs(ctx);
      const last = (await org.get(`/api/v1/webhooks/${hook.body.id}/deliveries?status=pending`)).body.data[0];
      for (let i = 0; i < RETRY_DELAYS_SEC.length; i++)
        await deliverWebhook(ctx.deps, { orgId: org.orgId, deliveryId: last.id });
      const disabled = (await org.get(`/api/v1/webhooks/${hook.body.id}`)).body;
      expect(disabled).toMatchObject({ active: false, consecutiveFailures: 50 });
      expect(disabled.disabledReason).toContain('50 events');
      await drainJobs(ctx);
      expect((await org.get('/api/v1/notifications')).body.data[0].title).toBe(
        'A webhook endpoint was disabled',
      );
      // Nothing is sent while disabled; re-enabling resets the count.
      const sent = endpoint.received.length;
      await new Respondent(ctx.app, survey.publicId).complete({ [keyOf(definition)]: 'While disabled' });
      await drainJobs(ctx);
      expect(endpoint.received.length).toBe(sent);
      expect((await org.patch(`/api/v1/webhooks/${hook.body.id}`, { active: true })).body).toMatchObject({
        active: true,
        consecutiveFailures: 0,
        disabledReason: null,
      });

      // An event dispatched twice (job retry) creates one delivery.
      const event: DomainEvent = {
        id: 'evt_dup000000000000000000000000000',
        type: 'survey.closed',
        orgId: org.orgId,
        surveyId: survey.id,
        occurredAt: new Date().toISOString(),
        reason: 'quota',
      };
      await ctx.handlers['events.dispatch'](event);
      await ctx.handlers['events.dispatch'](event);
      const { rows: dupes } = await ctx.owner.query(
        'select count(*)::int as n from webhook_deliveries where event_id = $1',
        [event.id],
      );
      expect(dupes[0].n).toBe(1);

      // The public API can manage webhooks with the webhooks:manage scope.
      const key = await createKey(org, ['webhooks:manage']);
      expect(
        (await withKey(key.key, 'GET', `/api/v1/webhooks/${hook.body.id}/deliveries`)).body.data.length,
      ).toBeGreaterThan(3);
    } finally {
      ctx.deps.config.allowPrivateUrls = false;
      await endpoint.close();
    }
  });

  it('sends nothing an anonymous survey does not store', async () => {
    const endpoint = await receiver();
    ctx.deps.config.allowPrivateUrls = true;
    try {
      const org = await signup(ctx.app, { orgName: 'Anonymous hooks' });
      const definition = definitionWith(['short_text']);
      const survey = await createSurvey(org, 'Anonymous');
      await org.patch(`/api/v1/surveys/${survey.id}`, { anonymous: true });
      const saved = await saveDraft(org, survey.id, definition);
      await org.post(`/api/v1/surveys/${survey.id}/publish`, { revision: saved.body.revision });
      await org.post('/api/v1/webhooks', { url: endpoint.url, events: ['response.submitted'] });
      await new Respondent(ctx.app, survey.publicId, { ip: '203.0.113.9' }).complete({
        [keyOf(definition)]: 'Hi',
      });
      await drainJobs(ctx);
      const payload = JSON.parse(endpoint.received[0]!.body);
      expect(new Date(payload.data.completedAt).getUTCMinutes()).toBe(0);
      expect(JSON.stringify(payload)).not.toMatch(/203\.0\.113|recipient|contact|email/i);
    } finally {
      ctx.deps.config.allowPrivateUrls = false;
      await endpoint.close();
    }
  });
});

// ── Integrations ───────────────────────────────────────────────────────────
describe('integrations', () => {
  it('connects Slack (with a test message) and keeps tokens encrypted', async () => {
    const slack = await receiver();
    try {
      ctx.deps.config.allowPrivateUrls = false;
      expect(
        (await admin.put('/api/v1/integrations/slack', { webhookUrl: 'https://example.com/hook' })).body.code,
      ).toBe('invalid_url');
      ctx.deps.config.allowPrivateUrls = true;
      const saved = await admin.put('/api/v1/integrations/slack', {
        webhookUrl: slack.url,
        channelName: '#research',
      });
      expect(saved.body.find((i: { kind: string }) => i.kind === 'slack')).toMatchObject({
        connected: true,
        stub: false,
        summary: { channel: '#research' },
      });
      const test = await admin.post('/api/v1/integrations/slack/test');
      expect(test.body).toMatchObject({ ok: true, httpStatus: 200 });
      expect(JSON.parse(slack.received[0]!.body).text).toContain('connected');

      const hubspot = await admin.put('/api/v1/integrations/hubspot', {
        accessToken: 'pat-na1-secret-token-1234',
      });
      expect(hubspot.body.find((i: { kind: string }) => i.kind === 'hubspot')).toMatchObject({
        connected: true,
        stub: true,
        summary: { token: '…1234' },
      });
      const { rows } = await ctx.owner.query(`select config_enc from integrations where kind = 'hubspot'`);
      expect(rows[0].config_enc).not.toContain('secret-token');
      expect(
        (await admin.delete('/api/v1/integrations/hubspot')).body.find(
          (i: { kind: string }) => i.kind === 'hubspot',
        ).connected,
      ).toBe(false);
    } finally {
      ctx.deps.config.allowPrivateUrls = false;
      await slack.close();
    }
  });

  it('HubSpot and Google Sheets connectors send the documented requests (contract tests against mocks)', async () => {
    const mock = await receiver();
    const record: ResponseRecord = {
      surveyId: 's-1',
      surveyTitle: 'NPS',
      responseId: 'r-1',
      completedAt: '2026-11-23T10:00:00.000Z',
      hiddenFields: {},
      answers: [
        { questionKey: 'q_score', title: 'Score', type: 'nps', display: '9' },
        { questionKey: 'q_email', title: 'Email', type: 'email', display: 'Ada@Example.com' },
        { questionKey: 'q_note', title: 'Note', type: 'long_text', display: '=SUM(A1)' },
      ],
    };
    const send = async (call: { url: string; headers: Record<string, string>; body: unknown }) => {
      const res = await fetch(call.url, {
        method: 'POST',
        headers: call.headers,
        body: JSON.stringify(call.body),
      });
      return { status: res.status };
    };
    try {
      expect(
        await syncResponse(hubspotConnector, { accessToken: 'pat-token' }, record, send, mock.base),
      ).toEqual({ calls: 1 });
      const hub = mock.received[0]!;
      expect(hub.url).toBe('/crm/v3/objects/contacts/batch/upsert');
      expect(hub.headers.authorization).toBe('Bearer pat-token');
      expect(JSON.parse(hub.body)).toEqual({
        inputs: [
          {
            idProperty: 'email',
            id: 'ada@example.com',
            properties: {
              email: 'ada@example.com',
              survey_last_response_id: 'r-1',
              survey_last_survey: 'NPS',
              survey_last_response_at: record.completedAt,
            },
          },
        ],
      });
      // No email answer: nothing to send.
      expect(
        await syncResponse(
          hubspotConnector,
          { accessToken: 't' },
          { ...record, answers: record.answers.slice(0, 1) },
          send,
          mock.base,
        ),
      ).toEqual({ calls: 0 });

      await syncResponse(
        googleSheetsConnector,
        { spreadsheetId: 'sheet-123456', sheetName: 'Responses', accessToken: 'ya29.token' },
        record,
        send,
        mock.base,
      );
      const sheet = mock.received[1]!;
      expect(sheet.url).toBe(
        '/v4/spreadsheets/sheet-123456/values/Responses!A1:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS',
      );
      expect(JSON.parse(sheet.body)).toEqual({
        majorDimension: 'ROWS',
        values: [['r-1', record.completedAt, '9', 'Ada@Example.com', '=SUM(A1)']],
      });

      mock.state.status = 401;
      await expect(
        syncResponse(
          googleSheetsConnector,
          { spreadsheetId: 'sheet-123456', sheetName: 'R', accessToken: 'x' },
          record,
          send,
          mock.base,
        ),
      ).rejects.toThrow('google_sheets answered 401');
    } finally {
      await mock.close();
    }
  });
});
