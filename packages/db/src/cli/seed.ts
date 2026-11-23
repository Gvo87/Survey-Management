/**
 * Development seed. RESETS ALL DATA, then creates:
 *
 *   Org "Acme Research"
 *     admin@acme.test     org_admin (also a creator in Globex, to demo org switching)
 *     creator@acme.test   creator
 *     analyst@acme.test   analyst (view access to the NPS survey)
 *   Org "Globex"
 *     admin@globex.test   org_admin
 *   super@survey.local    super admin with no org membership (has no access to org data)
 *
 *   Password for every seeded account (development only): survey-demo-2026
 *
 * `--large` also adds a 50,000-response survey to Acme for performance checks.
 */
import { hash } from '@node-rs/argon2';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import {
  createDefinition,
  createOption,
  createQuestion,
  listQuestions,
  type AnswerValue,
  type Question,
  type SurveyDefinition,
} from '@survey/core';
import { toCells } from '../answers';
import { rebuildSurveyAggregates } from '../aggregates';
import { createPool } from '../client';
import { DEV_PASSWORD } from '../dev-credentials';
import { loadRootEnv, requireEnv } from '../env';
import { newId, newPublicId, newToken, sha256 } from '../ids';
import {
  answers as answersTable,
  auditLogs,
  distributions,
  memberships,
  organizations,
  responses,
  surveyCollaborators,
  surveys,
  surveyVersions,
  tables,
  users,
} from '../schema';

loadRootEnv();
if (process.env.NODE_ENV === 'production') {
  console.error('Refusing to seed a production database.');
  process.exit(1);
}
const large = process.argv.includes('--large');
const pool = createPool(requireEnv('DATABASE_OWNER_URL'), 4);
const db = drizzle({ client: pool, schema: tables });

// Deterministic randomness so every seed looks the same.
let state = 42;
const random = () => {
  state = (state + 0x6d2b79f5) | 0;
  let t = Math.imul(state ^ (state >>> 15), 1 | state);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const pick = <T>(items: readonly T[], weights?: readonly number[]): T => {
  if (!weights) return items[Math.floor(random() * items.length)]!;
  const total = weights.reduce((a, b) => a + b, 0);
  let r = random() * total;
  for (let i = 0; i < items.length; i++) if ((r -= weights[i]!) <= 0) return items[i]!;
  return items.at(-1)!;
};

// ── Survey definitions ─────────────────────────────────────────────
function q<T extends Question>(question: T, patch: Partial<T>): T {
  return { ...question, ...patch };
}
function choice(
  type: 'single_choice' | 'multi_choice' | 'dropdown',
  title: string,
  labels: string[],
  other = false,
): Question {
  const base = createQuestion(type, title) as Extract<Question, { options: unknown }>;
  return {
    ...base,
    options: [
      ...labels.map((l) => createOption(l)),
      ...(other ? [createOption('Other', { isOther: true })] : []),
    ],
  } as Question;
}
function definition(
  pages: { title?: string; elements: Question[] }[],
  extra: Partial<SurveyDefinition> = {},
): SurveyDefinition {
  const def = createDefinition();
  def.pages = pages.map((p, i) => ({
    key: `p_seed${String(i).padStart(4, '0')}`,
    ...(p.title ? { title: p.title } : {}),
    elements: p.elements,
  }));
  return { ...def, ...extra };
}

const npsSurvey = definition(
  [
    {
      title: 'Your experience',
      elements: [
        q(createQuestion('nps', 'How likely are you to recommend Acme to a friend or colleague?'), {
          required: true,
        }),
        q(createQuestion('long_text', 'What is the main reason for your score?'), {
          helpText: 'Optional, but it really helps us.',
        }),
      ],
    },
    {
      title: 'About you',
      elements: [
        q(choice('single_choice', 'Which plan are you on?', ['Free', 'Team', 'Business', 'Enterprise']), {
          required: true,
        }),
        choice(
          'multi_choice',
          'What do you use Acme for?',
          ['Customer feedback', 'Market research', 'Employee surveys', 'Events'],
          true,
        ),
        q(createQuestion('rating', 'How would you rate our support?'), {}),
      ],
    },
  ],
  { hiddenFields: [{ key: 'source', nonIdentifying: true }] },
);

const likert = (title: string) => createQuestion('likert', title);
const pulseSurvey = definition(
  [
    {
      title: 'How things are going',
      elements: [
        likert('I have the tools I need to do my job well.'),
        likert('My workload is manageable.'),
        likert('I feel recognised for my work.'),
        q(createQuestion('nps', 'How likely are you to recommend working here to a friend?'), {
          required: true,
        }),
      ],
    },
    {
      title: 'Anything else?',
      elements: [createQuestion('long_text', 'What one thing would make the biggest difference for you?')],
    },
  ],
  { hiddenFields: [{ key: 'team', nonIdentifying: true, label: 'Team' }] },
);

const eventV1 = definition([
  {
    elements: [
      q(createQuestion('rating', 'Overall, how would you rate DevDays 2026?'), { required: true }),
      choice('dropdown', 'Which session did you enjoy most?', [
        'Keynote',
        'Scaling Postgres',
        'Accessible forms',
        'Design systems',
      ]),
      createQuestion('long_text', 'What should we change next year?'),
    ],
  },
]);
const eventV2: SurveyDefinition = structuredClone(eventV1);
eventV2.pages[0]!.elements.push(
  createQuestion('date', 'Which day did you attend?'),
  createQuestion('email', 'Email (if you would like a reply)'),
);

const onboardingSurvey = definition([
  {
    elements: [
      q(createQuestion('rating', 'How easy was it to get started?'), { required: true }),
      createQuestion('short_text', 'Which feature did you try first?'),
    ],
  },
]);

// ── Answer generation ──────────────────────────────────────────────
const COMMENTS = [
  'Great product, the reporting saves me hours every week.',
  'Support was quick and friendly.',
  'Pricing is a bit high for small teams.',
  'The survey builder is intuitive.',
  'Exports to Excel could be faster.',
  'I wish there were more templates.',
  'Works well on mobile, our customers like it.',
  'Onboarding took longer than expected.',
  'Love the NPS dashboard!',
  'Sometimes the page loads slowly.',
];

function answerFor(question: Question, mood: number): AnswerValue | null {
  switch (question.type) {
    case 'nps':
      return Math.max(0, Math.min(10, Math.round(mood * 10 + (random() - 0.5) * 4)));
    case 'rating':
      return Math.max(
        1,
        Math.min(
          question.config.scale,
          Math.round(mood * (question.config.scale - 1) + 1 + (random() - 0.5) * 2),
        ),
      );
    case 'likert': {
      const i = Math.max(
        0,
        Math.min(question.options.length - 1, Math.round(mood * 4 + (random() - 0.5) * 2)),
      );
      return question.options[i]!.key;
    }
    case 'single_choice':
    case 'dropdown':
      return pick(
        question.options.filter((o) => !o.isOther),
        [5, 3, 2, 1, 1, 1].slice(0, question.options.length),
      ).key;
    case 'multi_choice': {
      const chosen = question.options.filter((o) => !o.isOther && random() < 0.45).map((o) => o.key);
      if (random() < 0.08) {
        const other = question.options.find((o) => o.isOther);
        if (other)
          return {
            options: [...(chosen.length ? chosen : []), other.key],
            other: pick(['Product research', 'Training', 'Investor updates']),
          };
      }
      return chosen.length ? chosen : [question.options[0]!.key];
    }
    case 'long_text':
    case 'short_text':
      return random() < 0.55 ? pick(COMMENTS) : null;
    case 'email':
      return random() < 0.3 ? `attendee${Math.floor(random() * 10000)}@example.com` : null;
    case 'date':
      return pick(['2026-10-14', '2026-10-15']);
  }
}

interface SeedSurvey {
  orgId: string;
  ownerId: string;
  title: string;
  anonymous?: boolean;
  status: 'live' | 'closed' | 'draft';
  versions: SurveyDefinition[];
  responses: number;
  hidden?: () => Record<string, string>;
  share?: { userId: string; role: 'editor' | 'viewer' }[];
  namedLink?: { name: string; preset: Record<string, string>; share: number };
}

const DAY = 86_400_000;
const toHour = (d: Date) => new Date(Math.floor(d.getTime() / 3_600_000) * 3_600_000);

async function seedSurvey(spec: SeedSurvey): Promise<string> {
  const surveyId = newId();
  const now = Date.now();
  await db.insert(surveys).values({
    id: surveyId,
    orgId: spec.orgId,
    title: spec.title,
    publicId: newPublicId(),
    status: spec.status,
    anonymous: spec.anonymous ?? false,
    createdBy: spec.ownerId,
    createdAt: new Date(now - 40 * DAY),
    ...(spec.status === 'closed' ? { closedReason: 'manual' as const, closedAt: new Date(now - DAY) } : {}),
  });
  await db
    .insert(surveyCollaborators)
    .values([
      { orgId: spec.orgId, surveyId, userId: spec.ownerId, role: 'owner' },
      ...(spec.share ?? []).map((s) => ({ orgId: spec.orgId, surveyId, userId: s.userId, role: s.role })),
    ]);

  const versionIds: string[] = [];
  for (const [i, def] of spec.versions.entries()) {
    const id = newId();
    versionIds.push(id);
    const published = spec.status !== 'draft';
    await db.insert(surveyVersions).values({
      id,
      orgId: spec.orgId,
      surveyId,
      versionNumber: i + 1,
      status: published ? 'published' : 'draft',
      definition: def,
      createdBy: spec.ownerId,
      ...(published ? { publishedBy: spec.ownerId, publishedAt: new Date(now - (35 - i * 10) * DAY) } : {}),
    });
  }
  if (spec.status !== 'draft')
    await db
      .update(surveys)
      .set({ currentVersionId: versionIds.at(-1)! })
      .where(eqId(surveyId));

  const defaultLink = newId();
  const links = [
    {
      id: defaultLink,
      orgId: spec.orgId,
      surveyId,
      channel: 'link' as const,
      name: 'Default link',
      token: newToken(9),
      isDefault: true,
      createdBy: spec.ownerId,
    },
  ];
  let namedLink: string | null = null;
  if (spec.namedLink) {
    namedLink = newId();
    links.push({
      id: namedLink,
      orgId: spec.orgId,
      surveyId,
      channel: 'link',
      name: spec.namedLink.name,
      token: newToken(9),
      isDefault: false,
      createdBy: spec.ownerId,
      presetHiddenFields: spec.namedLink.preset,
    } as never);
  }
  await db.insert(distributions).values(links);
  await db
    .insert(auditLogs)
    .values([
      {
        orgId: spec.orgId,
        actorType: 'user',
        actorId: spec.ownerId,
        action: 'survey.created',
        entityType: 'survey',
        entityId: surveyId,
      },
      ...(spec.status !== 'draft'
        ? [
            {
              orgId: spec.orgId,
              actorType: 'user' as const,
              actorId: spec.ownerId,
              action: 'survey.published',
              entityType: 'survey',
              entityId: surveyId,
            },
          ]
        : []),
    ]);

  if (spec.status === 'draft' || spec.responses === 0) return surveyId;

  // Responses: spread over the last 30 days, ~12% abandoned part-way.
  let completed = 0;
  const batchSize = 2000;
  for (let offset = 0; offset < spec.responses; offset += batchSize) {
    const responseRows: (typeof responses.$inferInsert)[] = [];
    const answerRows: (typeof answersTable.$inferInsert)[] = [];
    for (let i = offset; i < Math.min(spec.responses, offset + batchSize); i++) {
      const versionIndex =
        spec.versions.length > 1 && i < spec.responses * 0.4 ? 0 : spec.versions.length - 1;
      const def = spec.versions[versionIndex]!;
      const id = newId();
      const startedAt = new Date(now - random() * 30 * DAY);
      const partial = random() < 0.12;
      const duration = Math.round(40_000 + random() * 400_000);
      const viaNamed = namedLink && spec.namedLink && random() < spec.namedLink.share;
      const mood = Math.min(1, Math.max(0, 0.68 + (random() - 0.5) * 0.9));
      const questions = listQuestions(def);
      const answered = partial
        ? def.pages[0]!.elements.filter((e): e is Question => e.kind === 'question')
        : questions;
      const anon = spec.anonymous ?? false;
      responseRows.push({
        id,
        orgId: spec.orgId,
        surveyId,
        versionId: versionIds[versionIndex]!,
        distributionId: viaNamed ? namedLink : defaultLink,
        responseKeyHash: sha256(newToken(16)),
        status: partial ? 'in_progress' : 'completed',
        locale: 'en',
        hiddenFields: { ...(spec.hidden?.() ?? {}), ...(viaNamed ? spec.namedLink!.preset : {}) },
        deviceType: pick(['desktop', 'mobile', 'tablet'] as const, [55, 40, 5]),
        startedAt: anon ? toHour(startedAt) : startedAt,
        lastActivityAt: anon ? toHour(startedAt) : startedAt,
        completedAt: partial
          ? null
          : anon
            ? toHour(new Date(startedAt.getTime() + duration))
            : new Date(startedAt.getTime() + duration),
        durationMs: partial ? null : duration,
        currentPageKey: partial ? def.pages[0]!.key : def.pages.at(-1)!.key,
        furthestPageKey: partial ? def.pages[0]!.key : def.pages.at(-1)!.key,
      });
      if (!partial) completed++;
      for (const question of answered) {
        const value = answerFor(question, mood);
        if (value === null) continue;
        for (const cell of toCells(question, value))
          answerRows.push({ ...cell, valueJson: null, orgId: spec.orgId, surveyId, responseId: id });
      }
    }
    await db.insert(responses).values(responseRows);
    for (let i = 0; i < answerRows.length; i += 5000)
      await db.insert(answersTable).values(answerRows.slice(i, i + 5000));
  }

  await db.update(surveys).set({ completedCount: completed }).where(eqId(surveyId));
  const client = await pool.connect();
  try {
    // The seed starts with TRUNCATE, which leaves the planner believing these tables are empty.
    // Without fresh statistics it picks a nested loop and the rebuild takes minutes instead of a second.
    await client.query('analyze responses, answers');
    await rebuildSurveyAggregates(client, surveyId);
  } finally {
    client.release();
  }
  return surveyId;
}

const eqId = (id: string) => eq(surveys.id, id);

// ── Run ────────────────────────────────────────────────────────────
const started = Date.now();
const { rows } = await pool.query<{ tablename: string }>(
  `select tablename from pg_tables where schemaname = 'public' and tablename <> 'schema_migrations'`,
);
await pool.query(`truncate ${rows.map((r) => `"${r.tablename}"`).join(', ')} cascade`);
await pool.query('delete from pgboss.job').catch(() => {});

const passwordHash = await hash(DEV_PASSWORD);
const verified = new Date();
const user = (email: string, name: string, extra = {}) => ({
  id: newId(),
  email,
  name,
  passwordHash,
  emailVerifiedAt: verified,
  ...extra,
});
const acmeAdmin = user('admin@acme.test', 'Ada Admin');
const acmeCreator = user('creator@acme.test', 'Chris Creator');
const acmeAnalyst = user('analyst@acme.test', 'Ana Analyst');
const globexAdmin = user('admin@globex.test', 'Gus Globex');
const superAdmin = user('super@survey.local', 'Sam Super', { isSuperAdmin: true });
await db.insert(users).values([acmeAdmin, acmeCreator, acmeAnalyst, globexAdmin, superAdmin]);

const acme = newId();
const globex = newId();
await db.insert(organizations).values([
  { id: acme, name: 'Acme Research', slug: 'acme-research', plan: 'business' },
  { id: globex, name: 'Globex', slug: 'globex', plan: 'free' },
]);
await db.insert(memberships).values([
  { orgId: acme, userId: acmeAdmin.id, role: 'org_admin' },
  { orgId: acme, userId: acmeCreator.id, role: 'creator' },
  { orgId: acme, userId: acmeAnalyst.id, role: 'analyst' },
  { orgId: globex, userId: globexAdmin.id, role: 'org_admin' },
  { orgId: globex, userId: acmeAdmin.id, role: 'creator' },
]);

const teams = ['Engineering', 'Sales', 'Support', 'Marketing', 'Finance'];
await seedSurvey({
  orgId: acme,
  ownerId: acmeCreator.id,
  title: 'Customer NPS – Q4 2026',
  status: 'live',
  versions: [npsSurvey],
  responses: 500,
  share: [{ userId: acmeAnalyst.id, role: 'viewer' }],
  namedLink: { name: 'November newsletter', preset: { source: 'newsletter' }, share: 0.3 },
});
await seedSurvey({
  orgId: acme,
  ownerId: acmeAdmin.id,
  title: 'Employee pulse – November',
  anonymous: true,
  status: 'live',
  versions: [pulseSurvey],
  responses: 500,
  hidden: () => ({ team: pick(teams) }),
});
await seedSurvey({
  orgId: acme,
  ownerId: acmeCreator.id,
  title: 'Event feedback – DevDays 2026',
  status: 'closed',
  versions: [eventV1, eventV2],
  responses: 500,
});
await seedSurvey({
  orgId: acme,
  ownerId: acmeCreator.id,
  title: 'Website feedback (draft)',
  status: 'draft',
  versions: [npsSurvey],
  responses: 0,
});
await seedSurvey({
  orgId: globex,
  ownerId: globexAdmin.id,
  title: 'Onboarding survey',
  status: 'live',
  versions: [onboardingSurvey],
  responses: 50,
});

if (large) {
  console.log('[seed] generating 50,000 responses…');
  await seedSurvey({
    orgId: acme,
    ownerId: acmeAdmin.id,
    title: 'Large survey (50k responses)',
    status: 'live',
    versions: [npsSurvey],
    responses: 50_000,
  });
}

await pool.end();
console.log(`[seed] done in ${((Date.now() - started) / 1000).toFixed(1)}s`);
console.log(
  `[seed] log in at http://localhost:5173 as admin@acme.test, creator@acme.test, analyst@acme.test or admin@globex.test (password: see packages/db/src/cli/seed.ts)`,
);
