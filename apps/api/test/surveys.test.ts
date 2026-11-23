import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createQuestion } from '@survey/core';
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
  admin = await signup(ctx.app);
});
afterAll(async () => ctx.close());

describe('drafts', () => {
  it('requires If-Match and detects concurrent edits', async () => {
    const survey = await createSurvey(admin);
    const def = definitionWith(['short_text']);
    const noPrecondition = await admin.put(`/api/v1/surveys/${survey.id}/draft`, { definition: def });
    expect(noPrecondition.status).toBe(428);

    const first = await admin.put(
      `/api/v1/surveys/${survey.id}/draft`,
      { definition: def },
      { 'if-match': '"rev-0"' },
    );
    expect(first.status).toBe(200);
    expect(first.body.revision).toBe(1);
    expect(first.headers.etag).toBe('"rev-1"');

    // A second tab still on revision 0.
    const stale = await admin.put(
      `/api/v1/surveys/${survey.id}/draft`,
      { definition: def },
      { 'if-match': '"rev-0"' },
    );
    expect(stale.status).toBe(409);
    expect(stale.body).toMatchObject({
      code: 'revision_conflict',
      currentRevision: 1,
      updatedBy: 'Ada Admin',
    });
  });

  it('rejects malformed definitions with a path, and returns semantic issues on save', async () => {
    const survey = await createSurvey(admin);
    const bad = await admin.put(
      `/api/v1/surveys/${survey.id}/draft`,
      { definition: { pages: 'nope' } },
      { 'if-match': '"rev-0"' },
    );
    expect(bad.status).toBe(422);
    expect(bad.body.code).toBe('invalid_definition');

    const def = definitionWith(['single_choice', 'short_text'], []);
    (def.pages[0]!.elements[1] as { title: string }).title = '';
    const saved = await saveDraft(admin, survey.id, def);
    expect(saved.status).toBe(200);
    expect(saved.body.validation.errors.map((e: { code: string }) => e.code)).toEqual(['title_required']);
    expect(saved.body.validation.warnings.map((e: { code: string }) => e.code)).toEqual(['empty_page']);

    const publish = await admin.post(`/api/v1/surveys/${survey.id}/publish`, {
      revision: saved.body.revision,
    });
    expect(publish.status).toBe(422);
    expect(publish.body.code).toBe('publish_blocked');
  });

  it("can't discard the initial draft", async () => {
    const survey = await createSurvey(admin);
    const res = await admin.delete(`/api/v1/surveys/${survey.id}/draft`);
    expect(res.status).toBe(409);
  });
});

describe('versioning', () => {
  it('keeps serving v1 while v2 is drafted, and in-flight respondents finish on v1', async () => {
    const def = definitionWith(['short_text', 'nps']);
    const [text, nps] = def.pages[0]!.elements as { key: string }[];
    const { survey, versionId: v1 } = await publishedSurvey(admin, def);
    expect(survey.currentVersionNumber).toBe(1);

    // Respondent starts on v1 and saves a page.
    const early = new Respondent(ctx.app, survey.publicId);
    expect((await early.save({ [text!.key]: 'started on v1' })).status).toBe(200);

    // Edit the live survey: creating a draft is idempotent and copies v1.
    const d1 = await admin.post(`/api/v1/surveys/${survey.id}/draft`);
    expect(d1.status).toBe(201);
    const d2 = await admin.post(`/api/v1/surveys/${survey.id}/draft`);
    expect(d2.status).toBe(200);
    expect(d2.body.versionId).toBe(d1.body.versionId);
    expect(d1.body.basedOnVersionNumber).toBe(1);

    // v2: drop the text question, add a rating.
    const v2def = structuredClone(def);
    v2def.pages[0]!.elements = [v2def.pages[0]!.elements[1]!, createQuestion('rating', 'Rate us')];
    const saved = await saveDraft(admin, survey.id, v2def);
    expect((await new Respondent(ctx.app, survey.publicId).load()).body.version.id).toBe(v1);

    const pub = await admin.post(`/api/v1/surveys/${survey.id}/publish`, { revision: saved.body.revision });
    expect(pub.status).toBe(200);
    expect(pub.body.version.versionNumber).toBe(2);

    // New respondents get v2; the early respondent resumes and completes on v1.
    expect((await new Respondent(ctx.app, survey.publicId).load()).body.version.id).toBe(pub.body.version.id);
    const resumed = await early.load();
    expect(resumed.body.version.id).toBe(v1);
    expect(resumed.body.resume.answers).toEqual({ [text!.key]: 'started on v1' });
    expect((await early.complete({ [text!.key]: 'started on v1', [nps!.key]: 7 })).status).toBe(200);

    const list = await admin.get(`/api/v1/surveys/${survey.id}/responses`);
    expect(list.body.data[0].versionNumber).toBe(1);

    // Results combine versions; the removed question keeps its v1 answers.
    await drainJobs(ctx);
    const summary = await admin.get(`/api/v1/surveys/${survey.id}/results/summary`);
    const removed = summary.body.questions.find((q: { questionKey: string }) => q.questionKey === text!.key);
    expect(removed).toMatchObject({ removedInCurrentVersion: true, answered: 1 });
    expect(summary.body.versions.map((v: { versionNumber: number }) => v.versionNumber)).toEqual([2, 1]);
  });

  it('starting with a stale version after a publish asks the client to reload', async () => {
    const def = definitionWith(['short_text']);
    const { survey, versionId: v1 } = await publishedSurvey(admin, def);
    await admin.post(`/api/v1/surveys/${survey.id}/draft`);
    const saved = await saveDraft(admin, survey.id, definitionWith(['nps']));
    await admin.post(`/api/v1/surveys/${survey.id}/publish`, { revision: saved.body.revision });
    const late = new Respondent(ctx.app, survey.publicId);
    const res = await late.save({}, { start: { versionId: v1 } });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('version_changed');
  });

  it('forbids changing a published question type under the same key', async () => {
    const def = definitionWith(['short_text']);
    const { survey } = await publishedSurvey(admin, def);
    await admin.post(`/api/v1/surveys/${survey.id}/draft`);
    const changed = structuredClone(def);
    Object.assign(changed.pages[0]!.elements[0]!, { type: 'long_text' });
    const saved = await saveDraft(admin, survey.id, changed);
    expect(saved.body.validation.errors[0].code).toBe('question_type_changed');
  });

  it('published versions are immutable at the database level', async () => {
    const { versionId } = await publishedSurvey(admin, definitionWith(['short_text']));
    await expect(
      ctx.owner.query(`update survey_versions set definition = '{}'::jsonb where id = $1`, [versionId]),
    ).rejects.toThrow(/immutable/);
  });

  it('discards a draft of a published survey', async () => {
    const { survey } = await publishedSurvey(admin, definitionWith(['short_text']));
    await admin.post(`/api/v1/surveys/${survey.id}/draft`);
    expect((await admin.delete(`/api/v1/surveys/${survey.id}/draft`)).status).toBe(204);
    expect((await admin.get(`/api/v1/surveys/${survey.id}/draft`)).status).toBe(404);
    expect((await admin.get(`/api/v1/surveys/${survey.id}`)).body.hasDraft).toBe(false);
  });
});

describe('lifecycle', () => {
  it('close, reopen, archive and delete control the public link', async () => {
    const { survey } = await publishedSurvey(admin, definitionWith(['short_text']));
    const visitor = () => new Respondent(ctx.app, survey.publicId).load();

    expect((await admin.post(`/api/v1/surveys/${survey.id}/close`)).body).toMatchObject({
      status: 'closed',
      closedReason: 'manual',
    });
    expect((await visitor()).body.access.state).toBe('closed');
    expect((await admin.post(`/api/v1/surveys/${survey.id}/reopen`)).body.status).toBe('live');
    expect((await visitor()).body.access.state).toBe('open');
    expect((await admin.post(`/api/v1/surveys/${survey.id}/archive`)).body.status).toBe('archived');
    expect((await visitor()).body.access.state).toBe('closed');
    expect((await admin.post(`/api/v1/surveys/${survey.id}/reopen`)).body.status).toBe('live');

    expect((await admin.delete(`/api/v1/surveys/${survey.id}`)).status).toBe(204);
    expect((await visitor()).status).toBe(404);
    expect((await admin.get(`/api/v1/surveys/${survey.id}`)).status).toBe(404);
  });

  it('a past close date closes the survey even before the scheduled job runs', async () => {
    const { survey } = await publishedSurvey(admin, definitionWith(['short_text']));
    await admin.patch(`/api/v1/surveys/${survey.id}`, {
      access: { closesAt: new Date(Date.now() - 60_000).toISOString() },
    });
    expect((await new Respondent(ctx.app, survey.publicId).load()).body.access.state).toBe('closed');
    expect((await admin.get(`/api/v1/surveys/${survey.id}`)).body).toMatchObject({
      status: 'closed',
      closedReason: 'close_date',
    });
    const reopen = await admin.post(`/api/v1/surveys/${survey.id}/reopen`);
    expect(reopen.status).toBe(409);
    expect(reopen.body.code).toBe('close_date_passed');
  });

  it('a never-published survey has no public page', async () => {
    const survey = await createSurvey(admin);
    expect(survey.publicUrl).toBeNull();
    expect((await new Respondent(ctx.app, survey.publicId).load()).status).toBe(404);
  });

  it('duplicates a survey as a new draft with its own public id', async () => {
    const { survey } = await publishedSurvey(admin, definitionWith(['short_text', 'nps']), 'Original');
    const copy = await admin.post(`/api/v1/surveys/${survey.id}/duplicate`, {});
    expect(copy.status).toBe(201);
    expect(copy.body).toMatchObject({
      title: 'Copy of Original',
      status: 'draft',
      currentVersionNumber: null,
      hasDraft: true,
    });
    expect(copy.body.publicId).not.toBe(survey.publicId);
    const draft = await admin.get(`/api/v1/surveys/${copy.body.id}/draft`);
    expect(draft.body.definition.pages[0].elements).toHaveLength(2);
  });

  it('locks anonymity once responses exist', async () => {
    const def = definitionWith(['short_text']);
    const { survey } = await publishedSurvey(admin, def);
    expect((await admin.patch(`/api/v1/surveys/${survey.id}`, { anonymous: true })).status).toBe(200);
    await new Respondent(ctx.app, survey.publicId).save({});
    const res = await admin.patch(`/api/v1/surveys/${survey.id}`, { anonymous: false });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('anonymous_locked');
  });

  it('blocks publishing identifying questions in anonymous surveys', async () => {
    const survey = await createSurvey(admin);
    await admin.patch(`/api/v1/surveys/${survey.id}`, { anonymous: true });
    const saved = await saveDraft(admin, survey.id, definitionWith(['email']));
    const res = await admin.post(`/api/v1/surveys/${survey.id}/publish`, { revision: saved.body.revision });
    expect(res.status).toBe(422);
    expect(res.body.errors[0].code).toBe('identifying_question_in_anonymous');
  });
});

describe('sharing and ownership', () => {
  it('manages collaborators and transfers ownership', async () => {
    const creator = await addMember(ctx, admin, 'creator', 'Carl');
    const analyst = await addMember(ctx, admin, 'analyst', 'Anya');
    const survey = await createSurvey(creator, 'Shared');

    expect(
      (await creator.put(`/api/v1/surveys/${survey.id}/collaborators/${analyst.userId}`, { role: 'viewer' }))
        .status,
    ).toBe(200);
    expect(
      (await creator.put(`/api/v1/surveys/${survey.id}/collaborators/${analyst.userId}`, { role: 'owner' }))
        .status,
    ).toBe(422);
    expect(
      (await creator.delete(`/api/v1/surveys/${survey.id}/collaborators/${creator.userId}`)).status,
    ).toBe(409);

    const toAnalyst = await creator.post(`/api/v1/surveys/${survey.id}/transfer`, { userId: analyst.userId });
    expect(toAnalyst.status).toBe(422);
    const toAdmin = await creator.post(`/api/v1/surveys/${survey.id}/transfer`, { userId: admin.userId });
    expect(toAdmin.status).toBe(200);
    expect(toAdmin.body.owner.id).toBe(admin.userId);

    const collaborators = await admin.get(`/api/v1/surveys/${survey.id}/collaborators`);
    expect(
      collaborators.body.map((c: { user: { name: string }; role: string }) => [c.user.name, c.role]),
    ).toEqual([
      ['Ada Admin', 'owner'],
      ['Carl', 'editor'],
      ['Anya', 'viewer'],
    ]);
    expect((await creator.delete(`/api/v1/surveys/${survey.id}`)).status).toBe(403); // editors can't delete
  });
});

describe('audit trail', () => {
  it('records survey lifecycle events', async () => {
    const { survey } = await publishedSurvey(admin, definitionWith(['short_text']));
    await admin.post(`/api/v1/surveys/${survey.id}/close`);
    const { rows } = await ctx.owner.query(
      `select action, actor_id from audit_logs where entity_id = $1 order by id`,
      [survey.id],
    );
    expect(rows.map((r) => r.action)).toEqual(['survey.created', 'survey.published', 'survey.closed']);
    expect(rows.every((r) => r.actor_id === admin.userId)).toBe(true);
  });
});
