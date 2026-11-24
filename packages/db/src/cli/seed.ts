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
 * Phase 2A: an Acme brand theme (org default), four global templates, a question-bank entry and a
 * "Product research" survey that uses logic, matrix, ranking, slider, consent and phone questions.
 *
 * Phase 2B: 30 contacts in a "Q4 customers" list (two unsubscribed, one bounced), a draft email
 * campaign for the NPS survey (send it and watch Mailpit), and tags and a note on NPS responses.
 *
 * Phase 3B: the NPS survey in French (complete) and Arabic (partial, right to left), a two-year
 * retention default for Acme (one year on the event survey), a members-only "Team retro" survey,
 * acme.test as a verified SSO domain, and usage counters for everything seeded.
 *
 * `--large` also adds a 50,000-response survey to Acme for performance checks.
 */
import { hash } from '@node-rs/argon2';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import {
  bankQuestion,
  checkCompletion,
  cleanTranslation,
  translatableStrings,
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
  campaigns,
  comments,
  contactListMembers,
  contactLists,
  contacts,
  distributions,
  folders,
  notificationRules,
  responseNotes,
  responseTags,
  tags,
  globalTemplates,
  memberships,
  organizations,
  questionBankItems,
  themes,
  responses,
  ssoDomains,
  surveyCollaborators,
  surveyTeamCollaborators,
  surveys,
  surveyVersions,
  tables,
  teamMembers,
  teams as teamsTable,
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

// Phase 2A: logic and the new question types.
const role = choice('single_choice', 'What best describes your role?', ['Product manager', 'Engineer', 'Designer', 'Student']);
const tools = choice('multi_choice', 'Which parts of Acme do you use?', ['Web app', 'Mobile app', 'API']);
if (tools.type === 'multi_choice') tools.options.push(createOption('None of these', { exclusive: true }));
const consent = createQuestion('consent', 'Research consent');
const satisfaction = createQuestion('matrix', 'How satisfied are you with…');
if (satisfaction.type === 'matrix') satisfaction.rows = ['Speed', 'Reliability', 'Design', 'Documentation'].map((l) => createOption(l));
const priorities = createQuestion('ranking', 'Rank what matters most to you');
if (priorities.type === 'ranking') priorities.options = ['Price', 'Speed', 'Support', 'Integrations'].map((l) => createOption(l));
const budgetBase = createQuestion('slider', 'Monthly tooling budget');
const budget = budgetBase.type === 'slider' ? { ...budgetBase, config: { min: 0, max: 1000, step: 50, unit: '$', minLabel: 'None', maxLabel: '$1,000+' } } : budgetBase;
const slowWhy = q(createQuestion('long_text', 'What makes Acme feel slow for you?'), {
  visibleIf: { source: { question: satisfaction.key, sub: satisfaction.type === 'matrix' ? satisfaction.rows[0]!.key : '' }, op: 'eq', value: 'options' in satisfaction ? satisfaction.options[0]!.key : '' },
});
const phone = createQuestion('phone', 'Phone number, if we may call you');
const optionKey = (question: Question, i: number) => ('options' in question ? question.options[i]!.key : '');
const researchSurvey = definition(
  [
    { title: 'About you', elements: [role, tools, consent] },
    { title: 'Your experience', elements: [satisfaction, priorities, budget] },
    { title: 'Anything else, {{q.' + role.key + '|friend}}?', elements: [slowWhy, phone] },
  ],
  {
    hiddenFields: [{ key: 'source', nonIdentifying: true }],
    logic: [
      { id: 'r_seedrule01', afterPage: 'p_seed0000', when: { source: { question: role.key }, op: 'eq', value: optionKey(role, 3) }, then: { disqualify: true } },
      { id: 'r_seedrule02', afterPage: 'p_seed0000', when: { source: { question: tools.key }, op: 'contains_any', value: [optionKey(tools, 3)] }, then: { end: true } },
    ],
  },
);
researchSurvey.settings.thankYou = { title: 'Thanks, {{q.' + role.key + '|friend}}!', body: 'We read every answer.' };
researchSurvey.settings.disqualified = { title: 'Thanks for your interest', body: 'This study is for working professionals, so we have all we need for now.' };

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
      if (question.config.mode === 'time') return pick(['09:30', '13:00', '16:45']);
      if (question.config.mode === 'datetime') return pick(['2026-10-14T09:30', '2026-10-15T13:00']);
      return pick(['2026-10-14', '2026-10-15']);
    case 'matrix':
      return Object.fromEntries(
        question.rows.map((row) => {
          const i = Math.max(0, Math.min(question.options.length - 1, Math.round(mood * 3 + (random() - 0.5) * 2)));
          return [row.key, question.config.multiplePerRow ? [question.options[i]!.key] : question.options[i]!.key];
        }),
      );
    case 'ranking': {
      const keys = question.options.map((o) => o.key);
      for (let i = keys.length - 1; i > 0; i--) {
        const j = Math.floor(random() * (i + 1));
        [keys[i], keys[j]] = [keys[j]!, keys[i]!];
      }
      return keys.slice(0, question.config.rankCount ?? keys.length);
    }
    case 'slider': {
      const { min, max, step } = question.config;
      return Math.min(max, min + Math.round((mood * (max - min) * random() * 1.6) / step) * step);
    }
    case 'consent':
      return true;
    case 'phone':
      return random() < 0.3 ? `+1415555${String(Math.floor(random() * 10000)).padStart(4, '0')}` : null;
    default:
      return null;
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
      const hidden = responseRows.at(-1)!.hiddenFields!;
      const raw: Record<string, AnswerValue> = {};
      for (const question of answered) {
        const value = answerFor(question, mood);
        if (value !== null) raw[question.key] = value;
      }
      // Run the real completion logic so seeded answers respect conditions and skip rules.
      const result = partial ? null : checkCompletion(def, raw, hidden);
      const values = result ? result.answers : raw;
      if (result?.outcome === 'disqualified') responseRows.at(-1)!.status = 'disqualified';
      else if (!partial) completed++;
      for (const question of answered) {
        const value = values[question.key];
        if (value === undefined || value === null) continue;
        for (const cell of toCells(question, value as AnswerValue))
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
const npsSurveyId = await seedSurvey({
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
const eventSurveyId = await seedSurvey({
  orgId: acme,
  ownerId: acmeCreator.id,
  title: 'Event feedback – DevDays 2026',
  status: 'closed',
  versions: [eventV1, eventV2],
  responses: 500,
});
const websiteSurveyId = await seedSurvey({
  orgId: acme,
  ownerId: acmeCreator.id,
  title: 'Website feedback (draft)',
  status: 'draft',
  versions: [npsSurvey],
  responses: 0,
});
const researchSurveyId = await seedSurvey({
  orgId: acme,
  ownerId: acmeAdmin.id,
  title: 'Product research – logic demo',
  status: 'live',
  versions: [researchSurvey],
  responses: 300,
  hidden: () => ({ source: pick(['newsletter', 'in-app', 'panel']) }),
});

// Phase 2A: an org default theme, global templates and a question-bank entry.
await db.insert(themes).values({
  id: newId(),
  orgId: acme,
  name: 'Acme brand',
  tokens: { primary: '#0f6b5c', background: '#f3f7f6', surface: '#ffffff', text: '#14201d', font: 'humanist', radius: 'large' },
  isDefault: true,
  createdBy: acmeAdmin.id,
});
await db.insert(globalTemplates).values([
  { id: newId(), name: 'Net Promoter Score', category: 'Customer', description: 'NPS with a follow-up reason, plan and usage questions.', definition: npsSurvey },
  { id: newId(), name: 'Employee pulse', category: 'Employee', description: 'Short Likert check-in on tools, workload and recognition.', definition: pulseSurvey },
  { id: newId(), name: 'Event feedback', category: 'Events', description: 'Overall rating, favourite session and suggestions.', definition: eventV2 },
  { id: newId(), name: 'Product research', category: 'Research', description: 'Screener with skip logic, a satisfaction matrix, ranking and budget slider.', definition: researchSurvey },
]);
await db.insert(questionBankItems).values({
  id: newId(),
  orgId: acme,
  question: bankQuestion(q(createQuestion('nps', 'How likely are you to recommend Acme to a friend or colleague?'), { required: true })),
  tags: ['nps', 'standard'],
  createdBy: acmeAdmin.id,
});

// Phase 2B: contacts, a draft campaign, tags and a note.
{
  const FIRST = ['Ava', 'Ben', 'Chloe', 'Dan', 'Elif', 'Femi', 'Grace', 'Hugo', 'Ines', 'Jon', 'Kai', 'Lena', 'Mo', 'Nia', 'Omar'];
  const LAST = ['Adams', 'Brown', 'Costa', 'Diaz', 'Evans', 'Fischer'];
  const listId = newId();
  await db.insert(contactLists).values({ id: listId, orgId: acme, name: 'Q4 customers', createdBy: acmeAdmin.id });
  const people = Array.from({ length: 30 }, (_, i) => ({
    id: newId(),
    orgId: acme,
    email: `customer${i + 1}@example.com`,
    firstName: FIRST[i % FIRST.length]!,
    lastName: LAST[i % LAST.length]!,
    attributes: { plan: pick(['free', 'team', 'business']), region: pick(['EMEA', 'Americas', 'APAC']) },
    unsubscribedAt: i === 3 || i === 17 ? new Date() : null,
    bouncedAt: i === 9 ? new Date() : null,
  }));
  await db.insert(contacts).values(people);
  await db.insert(contactListMembers).values(people.map((c) => ({ orgId: acme, listId, contactId: c.id })));

  const distributionId = newId();
  await db.insert(distributions).values({
    id: distributionId,
    orgId: acme,
    surveyId: npsSurveyId,
    channel: 'email',
    name: 'Email: Q4 NPS invitation',
    token: newToken(9),
    createdBy: acmeCreator.id,
  });
  await db.insert(campaigns).values({
    id: newId(),
    orgId: acme,
    surveyId: npsSurveyId,
    distributionId,
    listId,
    name: 'Q4 NPS invitation',
    subject: 'How likely are you to recommend Acme, {{contact.first_name|there}}?',
    body: 'Hi {{contact.first_name|there}},\n\nTwo minutes of your time would help us a lot:\n\n{{survey.link}}\n\nThanks,\nThe Acme team',
    reminderAfterDays: 3,
    reminderMax: 1,
    createdBy: acmeCreator.id,
  });

  // Tag a few detractors for follow-up, with a note on one of them.
  const { rows: detractors } = await pool.query<{ response_id: string }>(
    `select distinct a.response_id from answers a join responses r on r.id = a.response_id
      where a.survey_id = $1 and r.status = 'completed' and a.value_number <= 4 limit 5`,
    [npsSurveyId],
  );
  const followUp = newId();
  await db.insert(tags).values([
    { id: followUp, orgId: acme, surveyId: npsSurveyId, name: 'Follow up' },
    { id: newId(), orgId: acme, surveyId: npsSurveyId, name: 'Pricing' },
  ]);
  if (detractors.length) {
    await db.insert(responseTags).values(detractors.map((d) => ({ orgId: acme, responseId: d.response_id, tagId: followUp })));
    await db.insert(responseNotes).values({
      id: newId(),
      orgId: acme,
      responseId: detractors[0]!.response_id,
      authorId: acmeAnalyst.id,
      body: 'Called the customer: billing confusion after the plan change. Sent a refund.',
    });
  }
}

// Phase 3A: a folder, a team with a shared survey, a notification rule and a review comment.
{
  const research = newId();
  await db.insert(folders).values([
    { id: research, orgId: acme, name: 'Customer research', createdBy: acmeAdmin.id },
    { id: newId(), orgId: acme, parentId: research, name: '2026', createdBy: acmeAdmin.id },
  ]);
  await db.update(surveys).set({ folderId: research }).where(eq(surveys.id, npsSurveyId));
  await db.update(surveys).set({ folderId: research }).where(eq(surveys.id, researchSurveyId));

  const insights = newId();
  await db.insert(teamsTable).values({ id: insights, orgId: acme, name: 'Insights' });
  await db.insert(teamMembers).values([
    { orgId: acme, teamId: insights, userId: acmeCreator.id },
    { orgId: acme, teamId: insights, userId: acmeAnalyst.id },
  ]);
  await db.insert(surveyTeamCollaborators).values({
    orgId: acme,
    surveyId: researchSurveyId,
    teamId: insights,
    role: 'viewer',
    addedBy: acmeAdmin.id,
  });

  await db.insert(notificationRules).values({
    id: newId(),
    orgId: acme,
    surveyId: npsSurveyId,
    kind: 'nps_detractor',
    config: {},
    channels: ['in_app'],
    createdBy: acmeCreator.id,
  });

  const firstQuestion = listQuestions(npsSurvey)[0]!;
  await db.insert(comments).values({
    id: newId(),
    orgId: acme,
    surveyId: websiteSurveyId,
    anchorKey: firstQuestion.key,
    authorId: acmeAdmin.id,
    body: 'Can we say "our website" instead of "Acme" here? This one goes to site visitors.',
  });
}

// Phase 3B: languages, retention, a members-only survey and a verified SSO domain.
{
  const FRENCH: Record<string, string> = {
    'Customer NPS – Q4 2026': 'NPS clients – T4 2026',
    'Your experience': 'Votre expérience',
    'How likely are you to recommend Acme to a friend or colleague?': 'Quelle est la probabilité que vous recommandiez Acme à un ami ou à un collègue ?',
    'What is the main reason for your score?': 'Quelle est la principale raison de votre note ?',
    'Optional, but it really helps us.': 'Facultatif, mais cela nous aide beaucoup.',
    'About you': 'À propos de vous',
    'Which plan are you on?': 'Quelle formule utilisez-vous ?',
    Free: 'Gratuite',
    Team: 'Équipe',
    Business: 'Business',
    Enterprise: 'Entreprise',
    'What do you use Acme for?': 'Pour quoi utilisez-vous Acme ?',
    'Customer feedback': 'Avis clients',
    'Market research': 'Études de marché',
    'Employee surveys': 'Enquêtes auprès des salariés',
    Events: 'Événements',
    Other: 'Autre',
    'How would you rate our support?': 'Comment évaluez-vous notre support ?',
    'Not at all likely': 'Pas du tout probable',
    'Extremely likely': 'Très probable',
    'Thank you!': 'Merci !',
    'Your response has been recorded.': 'Votre réponse a bien été enregistrée.',
    Next: 'Suivant',
    Back: 'Retour',
    Submit: 'Envoyer',
    'Submitting…': 'Envoi…',
    required: 'obligatoire',
    'This question is required.': 'Cette question est obligatoire.',
    'Please check these answers:': 'Vérifiez ces réponses :',
    'Page {n} of {total}': 'Page {n} sur {total}',
    'Select an option': 'Choisissez une option',
    Language: 'Langue',
    "This survey is anonymous. Your answers aren't linked to you.": 'Ce questionnaire est anonyme. Vos réponses ne sont pas liées à vous.',
  };
  const ARABIC: Record<string, string> = {
    'Customer NPS – Q4 2026': 'مؤشر صافي الترويج للعملاء – الربع الرابع 2026',
    'Your experience': 'تجربتك',
    'How likely are you to recommend Acme to a friend or colleague?': 'ما مدى احتمال أن توصي بـ Acme لصديق أو زميل؟',
    'What is the main reason for your score?': 'ما السبب الرئيسي لتقييمك؟',
    'About you': 'عنك',
    Next: 'التالي',
    Back: 'السابق',
    Submit: 'إرسال',
    Language: 'اللغة',
    'Page {n} of {total}': 'الصفحة {n} من {total}',
  };
  const translate = (dictionary: Record<string, string>) =>
    cleanTranslation(
      npsSurvey,
      Object.fromEntries(translatableStrings(npsSurvey, 'Customer NPS – Q4 2026').flatMap((t) => (dictionary[t.source] ? [[t.key, dictionary[t.source]!]] : []))),
      'Customer NPS – Q4 2026',
    );
  const [nps] = await db.select({ versionId: surveys.currentVersionId }).from(surveys).where(eqId(npsSurveyId));
  await db.update(surveyVersions).set({ translations: { fr: translate(FRENCH), ar: translate(ARABIC) } }).where(eq(surveyVersions.id, nps!.versionId!));

  await db
    .update(organizations)
    .set({ settings: { retention: { responsesDays: 730 }, ai: { enabled: false }, sso: { enforced: false } } })
    .where(eq(organizations.id, acme));
  await db.update(surveys).set({ retentionDays: 365 }).where(eqId(eventSurveyId));

  const retroId = await seedSurvey({
    orgId: acme,
    ownerId: acmeAdmin.id,
    title: 'Team retro (members only)',
    status: 'live',
    versions: [
      definition([
        {
          title: 'Looking back',
          elements: [
            q(createQuestion('rating', 'How did this quarter go for you?'), { required: true }),
            createQuestion('long_text', 'What should we keep doing?'),
            createQuestion('long_text', 'What should we change?'),
          ],
        },
      ]),
    ],
    responses: 0,
  });
  await db.update(surveys).set({ access: { closesAt: null, quota: null, onePerBrowser: false, requireLogin: true } }).where(eqId(retroId));

  await db.insert(ssoDomains).values({ orgId: acme, domain: 'acme.test', verificationToken: newToken(16), verifiedAt: new Date() });
}

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

// Phase 3B: usage counters for what was seeded (the app counts as things happen).
await pool.query(`
  insert into org_usage_monthly (org_id, month, responses)
    select org_id, date_trunc('month', completed_at at time zone 'UTC')::date, count(*)
      from responses where status = 'completed' and not is_test and completed_at is not null group by 1, 2
  on conflict (org_id, month) do update set responses = excluded.responses;
  insert into org_usage_monthly (org_id, month, surveys_published)
    select org_id, date_trunc('month', published_at at time zone 'UTC')::date, count(*)
      from survey_versions where status = 'published' and published_at is not null group by 1, 2
  on conflict (org_id, month) do update set surveys_published = excluded.surveys_published;
`);

await pool.end();
console.log(`[seed] done in ${((Date.now() - started) / 1000).toFixed(1)}s`);
console.log(
  `[seed] log in at http://localhost:5173 as admin@acme.test, creator@acme.test, analyst@acme.test or admin@globex.test (password: see packages/db/src/cli/seed.ts)`,
);
