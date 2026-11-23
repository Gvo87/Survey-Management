import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createTestContext,
  definitionWith,
  drainJobs,
  publishedSurvey,
  Respondent,
  signup,
  type TestContext,
} from './helpers';

let ctx: TestContext;
beforeAll(async () => {
  ctx = await createTestContext();
});
afterAll(async () => ctx.close());

describe('build → publish → respond → analyze', () => {
  it('works end to end through the API', async () => {
    const admin = await signup(ctx.app);
    const def = definitionWith(['nps', 'short_text']);
    const [nps, text] = def.pages[0]!.elements as { key: string }[];
    const { survey } = await publishedSurvey(admin, def);
    expect(survey.status).toBe('live');
    expect(survey.publicUrl).toContain(`/s/${survey.publicId}`);

    const respondent = new Respondent(ctx.app, survey.publicId);
    const loaded = await respondent.load();
    expect(loaded.status).toBe(200);
    expect(loaded.body.access).toEqual({ state: 'open' });

    const done = await respondent.complete({ [nps!.key]: 9, [text!.key]: 'Great service' });
    expect(done.status).toBe(200);
    expect(done.body.responseStatus).toBe('completed');

    await drainJobs(ctx);
    const summary = await admin.get(`/api/v1/surveys/${survey.id}/results/summary`);
    expect(summary.status).toBe(200);
    expect(summary.body.source).toBe('aggregate');
    expect(summary.body.totals).toMatchObject({ started: 1, completed: 1, completionRate: 1 });
    const npsSummary = summary.body.questions.find(
      (q: { questionKey: string }) => q.questionKey === nps!.key,
    );
    expect(npsSummary).toMatchObject({ type: 'nps', answered: 1, promoters: 1, score: 100 });

    const csv = await admin.get(`/api/v1/surveys/${survey.id}/export.csv`);
    expect(csv.status).toBe(200);
    expect(csv.raw).toContain('Great service');
  });
});
