# Survey Management System: Design Docs

**Status:** approved on 2026-11-23 with the default answers to the open questions. **Phases 1, 2A, 2B and 3A are
implemented**; see [phase-1-status.md](phase-1-status.md), [phase-2a-status.md](phase-2a-status.md),
[phase-2b-status.md](phase-2b-status.md) and [phase-3a-status.md](phase-3a-status.md) for each acceptance
criterion and its evidence. Phase 3B is next.

| # | Document | Contents |
|---|---|---|
| 1 | [Architecture](01-architecture.md) | Stack and why, components, data flows, auth and RBAC, tenant isolation, security, performance, observability, testing, deployment |
| 2 | [Data model](02-data-model.md) | ERDs, survey definition schema, versioning, how each answer type is stored, SQL schema, anonymous mode, row-level security, growth |
| 3 | [API design](03-api-design.md) | Conventions, every endpoint with phase tags, request and response shapes, respondent protocol, webhooks |
| 4 | [Roadmap and acceptance criteria](04-roadmap.md) | Phases 1, 2A, 2B, 3A and 3B, scope, build order, checklists |
| 5 | [Risks and flags](05-risks.md) | Conflicts in the requirements, risks, expensive items |
| - | [Phase 1 status](phase-1-status.md) | Every Phase 1 acceptance criterion: verified, partly verified, or open |
| - | [Phase 2A status](phase-2a-status.md) | Every Phase 2A acceptance criterion, plus where the build deviates from the design |
| - | [Phase 2B status](phase-2b-status.md) | Every Phase 2B acceptance criterion, plus where the build deviates from the design |
| - | [Phase 3A status](phase-3a-status.md) | Every Phase 3A acceptance criterion, plus where the build deviates from the design |
| - | [Public API and webhooks](public-api.md) | API keys, scopes, rate limits, idempotency, webhook signatures, retries and a sample verifier |
| - | [Accessibility record](a11y-p1.md) | Automated WCAG checks done; manual screen-reader checklist |

## Key decisions

1. **Modular monolith** in TypeScript: one API process and one worker process from the same codebase, PostgreSQL,
   and Redis for ephemeral data only.
2. **One survey engine** (`packages/survey-core`) runs in the builder preview, the respondent's browser and the
   server, so logic and validation can't drift apart.
3. **Survey content is an immutable JSON document per version.** Drafts are edited. Publishing freezes them.
   Responses point at the exact version they answered.
4. **Answers are stored one row per answer "cell" with typed columns**, so filters, segments and cross-tabs are
   indexed SQL rather than JSON scans.
5. **Postgres is the durability point for submissions.** The respondent's browser retries using a secret
   idempotency key. Side effects are jobs enqueued in the same transaction (pg-boss).
6. **Tenant isolation is enforced by the database** (row-level security that fails closed), plus scoped
   repositories and cross-tenant tests.
7. **Pre-aggregated counts** serve unfiltered dashboards. Filtered views use live indexed SQL with a cache.

## Assumptions

The brief's placeholders weren't filled in, so these are my defaults. Each can be changed.

| # | Assumption |
|---|---|
| A1 | **Multi-tenant SaaS** (shared database, `org_id` + RLS) with self-serve signup. Signup can be switched to invite-only. |
| A2 | **Scale:** about 500 surveys/month platform-wide, up to 50 k responses per survey, most surveys far smaller. Peak about 100 submissions/s during an email blast. |
| A3 | **Stack:** as recommended in [architecture §1.2](01-architecture.md#12-recommended-stack). |
| A4 | **Hosting:** AWS for production. Phase 1 runs locally with Docker. No infrastructure-as-code in Phase 1. |
| A5 | **No billing provider.** Organizations have a `plan` and plan limits only. |
| A6 | The admin UI is English-only. Survey *content* becomes multilingual in Phase 3. |
| A7 | Browser support: the last 2 versions of evergreen browsers, iOS Safari 16+. |
| A8 | Single region. No data-residency requirement. |
| A9 | Primary users: marketing, HR, product research, customer success. HR use implies confidential surveys, so analysts only see surveys shared with them. |
| A10 | Email is sent from a platform domain with the org's name as the display name. Custom sending domains come later. |

## Open questions

Q1, Q2, Q3, Q7 and Q8 were answered with the defaults on 2026-11-23. The rest are still open.

**Answered (defaults accepted):**

- **Q1 Tenancy:** multi-tenant SaaS (assumed) or an internal tool for one company? Changes signup, super admin and
  billing scope.
- **Q2 Stack:** is TypeScript end-to-end (React, Fastify, PostgreSQL, Drizzle, pg-boss, Redis) right for your
  team? Existing team expertise should outweigh my preference.
- **Q3 Scale:** do the A2 numbers hold? If you expect the upper end from day one, I'll partition `answers` from
  the start.
- **Q7 Quotas and close dates:** let respondents already in progress finish (default), or cut them off strictly?
- **Q8 Analyst visibility:** analysts see only surveys shared with them (default), or every org survey read-only?

**Needed before later phases** (Q5 and Q10 affect Phase 3B only; 3A needed none):

- **Q4 Infrastructure:** when should production infrastructure as code (Terraform or CDK) land, and is AWS right?
- **Q5 Login-required respondents:** who logs in? Org members (cheap: reuse login or SSO) or external people
  (expensive: magic-link identity)?
- **Q6 Billing:** out of scope for all three phases?
- **Q9 Phase 2 split:** OK to split Phase 2 into 2A (builder power) then 2B (email, embed, advanced analytics)?
  Or swap the order?
- **Q10 AI provider:** Anthropic Claude via API for Phase 3 summaries, opt-in per org?
