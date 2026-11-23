/**
 * Table-driven check of the permission matrix in docs/01-architecture.md §1.5.
 * Every (role × action) pair runs against a fresh survey so actions can't affect each other.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { effectiveSurveyRole, maxSurveyRole, SURVEY_CAPABILITIES } from '../src/auth/permissions';
import {
  addMember,
  Client,
  createSurvey,
  createTestContext,
  definitionWith,
  publishedSurvey,
  Respondent,
  signup,
  type TestContext,
} from './helpers';

describe('effectiveSurveyRole (unit)', () => {
  it.each([
    ['org_admin', null, 'owner'],
    ['org_admin', 'viewer', 'owner'],
    ['creator', null, null],
    ['creator', 'editor', 'editor'],
    ['creator', 'owner', 'owner'],
    ['analyst', 'viewer', 'viewer'],
    ['analyst', 'editor', 'viewer'],
    ['analyst', 'owner', 'viewer'],
    ['analyst', null, null],
  ] as const)('%s shared as %s → %s', (orgRole, shared, expected) => {
    expect(effectiveSurveyRole(orgRole, shared)).toBe(expected);
  });

  it('caps analysts at viewer', () => {
    expect(maxSurveyRole('analyst')).toBe('viewer');
    expect(maxSurveyRole('creator')).toBe('owner');
  });

  it('viewer capabilities are a subset of editor, editor of owner', () => {
    for (const c of SURVEY_CAPABILITIES.viewer) expect(SURVEY_CAPABILITIES.editor).toContain(c);
    for (const c of SURVEY_CAPABILITIES.editor) expect(SURVEY_CAPABILITIES.owner).toContain(c);
  });
});

type Role = 'admin' | 'owner' | 'editor' | 'viewer' | 'outsider' | 'unsharedAnalyst';
const ROLES: Role[] = ['admin', 'owner', 'editor', 'viewer', 'outsider', 'unsharedAnalyst'];

let ctx: TestContext;
let users: Record<Role, Client>;

beforeAll(async () => {
  ctx = await createTestContext();
  const admin = await signup(ctx.app);
  users = {
    admin,
    owner: await addMember(ctx, admin, 'creator', 'Owner'),
    editor: await addMember(ctx, admin, 'creator', 'Editor'),
    viewer: await addMember(ctx, admin, 'analyst', 'Viewer'),
    outsider: await addMember(ctx, admin, 'creator', 'Outsider'),
    unsharedAnalyst: await addMember(ctx, admin, 'analyst', 'Unshared'),
  };
}, 60_000);
afterAll(async () => ctx.close());

/** A published survey owned by `owner`, shared with editor (editor) and viewer (viewer), with one response. */
async function fixture() {
  const def = definitionWith(['short_text']);
  const { survey } = await publishedSurvey(users.owner, def);
  await users.owner.put(`/api/v1/surveys/${survey.id}/collaborators/${users.editor.userId}`, {
    role: 'editor',
  });
  await users.owner.put(`/api/v1/surveys/${survey.id}/collaborators/${users.viewer.userId}`, {
    role: 'viewer',
  });
  const key = (def.pages[0]!.elements[0] as { key: string }).key;
  await new Respondent(ctx.app, survey.publicId).complete({ [key]: 'hello' });
  const responses = await users.owner.get(`/api/v1/surveys/${survey.id}/responses`);
  return { surveyId: survey.id as string, responseId: responses.body.data[0].id as string };
}

type Action = (c: Client, f: { surveyId: string; responseId: string }) => Promise<{ status: number }>;
const Y = 'allowed' as const;
const F = 'forbidden' as const; // can see the survey, lacks the capability → 403
const H = 'hidden' as const; // can't see the survey → 404

const MATRIX: [name: string, action: Action, expected: Record<Role, typeof Y | typeof F | typeof H>][] = [
  [
    'survey.view',
    (c, f) => c.get(`/api/v1/surveys/${f.surveyId}`),
    { admin: Y, owner: Y, editor: Y, viewer: Y, outsider: H, unsharedAnalyst: H },
  ],
  [
    'survey.edit',
    (c, f) => c.patch(`/api/v1/surveys/${f.surveyId}`, { title: 'Renamed' }),
    { admin: Y, owner: Y, editor: Y, viewer: F, outsider: H, unsharedAnalyst: H },
  ],
  [
    'survey.edit (draft)',
    (c, f) => c.post(`/api/v1/surveys/${f.surveyId}/draft`),
    { admin: Y, owner: Y, editor: Y, viewer: F, outsider: H, unsharedAnalyst: H },
  ],
  [
    'survey.publish',
    (c, f) => c.post(`/api/v1/surveys/${f.surveyId}/publish`, { revision: 0 }),
    { admin: Y, owner: Y, editor: Y, viewer: F, outsider: H, unsharedAnalyst: H },
  ],
  [
    'survey.distribute',
    (c, f) => c.post(`/api/v1/surveys/${f.surveyId}/distributions`, { channel: 'link', name: 'X' }),
    { admin: Y, owner: Y, editor: Y, viewer: F, outsider: H, unsharedAnalyst: H },
  ],
  [
    'survey.close',
    (c, f) => c.post(`/api/v1/surveys/${f.surveyId}/close`),
    { admin: Y, owner: Y, editor: Y, viewer: F, outsider: H, unsharedAnalyst: H },
  ],
  [
    'survey.share',
    (c, f) =>
      c.put(`/api/v1/surveys/${f.surveyId}/collaborators/${users.unsharedAnalyst.userId}`, {
        role: 'viewer',
      }),
    { admin: Y, owner: Y, editor: F, viewer: F, outsider: H, unsharedAnalyst: H },
  ],
  [
    'survey.transfer',
    (c, f) => c.post(`/api/v1/surveys/${f.surveyId}/transfer`, { userId: users.admin.userId }),
    { admin: Y, owner: Y, editor: F, viewer: F, outsider: H, unsharedAnalyst: H },
  ],
  [
    'survey.delete',
    (c, f) => c.delete(`/api/v1/surveys/${f.surveyId}`),
    { admin: Y, owner: Y, editor: F, viewer: F, outsider: H, unsharedAnalyst: H },
  ],
  [
    'responses.view',
    (c, f) => c.get(`/api/v1/surveys/${f.surveyId}/results/summary`),
    { admin: Y, owner: Y, editor: Y, viewer: Y, outsider: H, unsharedAnalyst: H },
  ],
  [
    'responses.view (detail)',
    (c, f) => c.get(`/api/v1/surveys/${f.surveyId}/responses/${f.responseId}`),
    { admin: Y, owner: Y, editor: Y, viewer: Y, outsider: H, unsharedAnalyst: H },
  ],
  [
    'responses.export',
    (c, f) => c.get(`/api/v1/surveys/${f.surveyId}/export.csv`),
    { admin: Y, owner: Y, editor: Y, viewer: Y, outsider: H, unsharedAnalyst: H },
  ],
  [
    'responses.delete',
    (c, f) => c.delete(`/api/v1/surveys/${f.surveyId}/responses/${f.responseId}`),
    { admin: Y, owner: Y, editor: Y, viewer: F, outsider: H, unsharedAnalyst: H },
  ],
];

const cases = MATRIX.flatMap(([name, action, expected]) =>
  ROLES.map((role) => [name, role, action, expected[role]] as const),
);

describe('survey permission matrix (integration)', () => {
  it.each(cases)('%s as %s', async (_name, role, action, expected) => {
    const f = await fixture();
    const res = await action(users[role], f);
    if (expected === Y) expect([401, 403, 404]).not.toContain(res.status);
    if (expected === F) expect(res.status).toBe(403);
    if (expected === H) expect(res.status).toBe(404);
  });
});

describe('org-level capabilities', () => {
  it('analysts cannot create surveys; creators and admins can', async () => {
    expect((await users.unsharedAnalyst.post('/api/v1/surveys', { title: 'x' })).status).toBe(403);
    expect((await users.outsider.post('/api/v1/surveys', { title: 'x' })).status).toBe(201);
    expect((await users.admin.post('/api/v1/surveys', { title: 'x' })).status).toBe(201);
  });

  it('analysts can only be given view access', async () => {
    const survey = await createSurvey(users.owner);
    const res = await users.owner.put(
      `/api/v1/surveys/${survey.id}/collaborators/${users.unsharedAnalyst.userId}`,
      { role: 'editor' },
    );
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('role_exceeds_org_role');
  });

  it('lists only surveys a creator owns or was shared, but everything for admins', async () => {
    const { surveyId } = await fixture();
    const titles = async (c: Client) =>
      (await c.get('/api/v1/surveys?limit=100')).body.data.map((s: { id: string }) => s.id);
    expect(await titles(users.editor)).toContain(surveyId);
    expect(await titles(users.viewer)).toContain(surveyId);
    expect(await titles(users.admin)).toContain(surveyId);
    expect(await titles(users.outsider)).not.toContain(surveyId);
    expect(await titles(users.unsharedAnalyst)).not.toContain(surveyId);
  });
});
