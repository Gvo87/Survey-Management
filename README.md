# Survey Management System

A multi-tenant platform for building, publishing and analysing surveys. **Phase 1 (MVP), Phase 2A (builder
power), Phase 2B (reach and insight), Phase 3A (collaboration and platform API) and Phase 3B (global and governed)
are implemented:**

- authentication, organizations and role-based access
- a drag-and-drop builder with 16 question types and live preview
- conditional logic (show/hide, skip, end, screen out; AND/OR/NOT), piping, and a logic map
- themes, templates, a question bank, file uploads with malware scanning
- password protection, open and close dates, CAPTCHA, response-quality flags
- versioned publishing and public links with QR codes, and an embed snippet (inline or popup)
- contacts with CSV import, and email campaigns with personal links, scheduling, reminders and unsubscribe
- a fast, accessible respondent app that never loses answers
- results with filters, segments, cross-tabs, drop-off and word clouds, updated live
- a response viewer with search, tags, notes and bulk delete; CSV, Excel and PDF exports, and scheduled reports
- folders and teams, comments on drafts, and approval before publishing
- notifications in the app, by email and in Slack (new responses, NPS detractors, milestones, closing)
- an audit-log viewer with CSV export
- a public REST API with scoped API keys, idempotency keys and an OpenAPI document, and signed webhooks with retries
- surveys in several languages (browser detection, a language picker, right-to-left scripts, CSV import and export)
- AI summaries of open answers (themes, sentiment, sample answers), opt-in per organization, through OpenAI
- single sign-on with SAML or OpenID Connect, just-in-time provisioning and optional enforcement
- surveys that only signed-in members of the organization can answer, once each
- retention policies, usage metrics, subject export and erasure (GDPR/CCPA), and a platform console for super admins

Design documents live in [`docs/`](docs/README.md): architecture, data model, API, roadmap, risks. Progress against
the acceptance criteria is tracked in [`docs/phase-1-status.md`](docs/phase-1-status.md),
[`docs/phase-2a-status.md`](docs/phase-2a-status.md), [`docs/phase-2b-status.md`](docs/phase-2b-status.md) and
[`docs/phase-3a-status.md`](docs/phase-3a-status.md) and [`docs/phase-3b-status.md`](docs/phase-3b-status.md).
Developers integrating with the platform start at
[`docs/public-api.md`](docs/public-api.md).

## Quick start

**You need:**

- Node.js 22.12+ (24 recommended)
- Docker Desktop, running
- pnpm 10, which ships with Node via corepack

**macOS / Linux:**

```sh
corepack enable                # provides `pnpm` (or: npm install -g pnpm@10)
cp .env.example .env
docker compose up -d           # Postgres 17, Redis 7, Mailpit, S3 (SeaweedFS)
pnpm install
pnpm db:migrate
pnpm db:seed                   # demo data; resets the database
pnpm dev                       # API + worker, admin app, respondent app
```

**Windows (PowerShell):** the same commands, but copy the env file with `Copy-Item .env.example .env`.
If `corepack enable` fails with a permissions error, run `npm install -g pnpm@10` instead.

| What | URL |
|---|---|
| Admin app | http://localhost:5173 |
| Respondent app | http://localhost:5174/s/{publicId} |
| API | http://localhost:3000 (`/healthz`, `/readyz`) |
| Mailpit (catches every email in development, including campaigns) | http://localhost:8025 |
| S3-compatible storage (uploads, logos) | http://localhost:8333 |

**Malware scanning (optional locally):** uploads are only downloadable after a scan. In development
`MALWARE_SCANNER=disabled` marks them clean without scanning. To scan for real, start ClamAV (the first start
downloads virus signatures, a few minutes) and set `MALWARE_SCANNER=clamav`:

```sh
docker compose --profile scan up -d clamav
```

### Demo accounts (development only)

`pnpm db:seed` creates these accounts. All of them use the password `survey-demo-2026`.

| Email | Role |
|---|---|
| `admin@acme.test` | Admin of *Acme Research*. Also a creator in *Globex*, to try the org switcher. |
| `creator@acme.test` | Creator in Acme (owns the NPS and event surveys) |
| `analyst@acme.test` | Analyst in Acme (view access to the NPS survey only) |
| `admin@globex.test` | Admin of *Globex* |
| `super@survey.local` | Platform super admin with no org membership: the *Platform* console shows every org's size and usage, but no survey data |

The seed creates three surveys with about 500 responses each: an NPS survey, an anonymous employee pulse, and an
event survey with two versions. It also creates a draft survey and a *Product research* survey (300 responses) that
uses logic and the Phase 2A question types, an *Acme brand* theme set as Acme's default, four global templates and a
question-bank entry. For Phase 2B it adds 30 contacts in a *Q4 customers* list and a draft campaign for the NPS
survey (send it from the survey's Distribute tab and watch Mailpit), plus tags and a note on NPS responses. For Phase
3A it files two surveys in a *Customer research* folder, adds an *Insights* team that can view the product research
survey, an NPS-detractor notification rule and a review comment on the draft survey. For Phase 3B the NPS survey
gets French (complete) and Arabic (partial, right to left) translations, Acme keeps responses for two years (the
event survey for one), *Team retro (members only)* asks respondents to sign in, `acme.test` is a verified SSO domain,
and usage counters reflect the seeded data. AI summaries need a provider: set `AI_PROVIDER=fake` in `.env` for a
deterministic stand-in, or `OPENAI_API_KEY` for OpenAI, then turn them on in Settings → General.
`pnpm db:seed:large` adds a 50,000-response survey for performance checks.

## Scripts

| Command | What it does |
|---|---|
| `pnpm dev` | Runs the API and worker (hot reload), the admin app and the respondent app |
| `pnpm verify` | Lint, typecheck, unit and integration tests, respondent bundle budget. Run before every PR. |
| `pnpm test:unit` | `survey-core` engine tests (no database needed) |
| `pnpm test:integration` | API tests against a real Postgres (`survey_test`) and Redis (db 15) |
| `pnpm test:e2e` | Playwright: build → publish → respond → analyze, resume, offline retry, logic (shared vectors), piping XSS, uploads, themes, embed on a strict-CSP page, a campaign through Mailpit, live results, languages and right to left, AI summaries, SSO against a mock identity provider, members-only surveys, accessibility (axe). First run `pnpm --filter @survey/e2e install-browsers`. Playwright starts the API with `AI_PROVIDER=fake SSO_DOMAIN_VERIFICATION=auto`; if you run `pnpm dev` yourself first, set those two variables. |
| `pnpm perf:results` | Analytics latency (including filters and segments) and a 50k-response XLSX export on the 50k seed. Writes `perf/results-summary.md`. |
| `pnpm --filter @survey/e2e lighthouse` | Respondent load time (LCP) on simulated slow 4G. Writes `perf/lighthouse-respondent.md`. Needs the API running. |
| `pnpm db:migrate` / `pnpm db:reset` | Apply migrations / drop everything and re-migrate (development only) |
| `pnpm build` | Production builds (API and worker bundles, both frontends) |

## Project structure

```
apps/
  api/          Fastify API (src/main.ts) and background worker (src/worker.ts), same codebase
  web/          Admin app: React, TanStack Query, Tailwind, dnd-kit
  respondent/   Respondent app and builder preview (small React bundle, ≤ 100 KB gz)
packages/
  survey-core/  Survey schema, validation, navigation. Shared by builder, respondent and API.
  contracts/    API request schemas (Zod) and response types
  db/           SQL migrations (incl. row-level security), Drizzle schema, tenant transactions, seed
e2e/            Playwright tests and the Lighthouse check
docs/           Design docs, acceptance status, accessibility record
perf/           Committed performance reports
```

## How it's built (short version)

- **One survey engine.** `@survey/core` validates answers, evaluates logic and walks pages in the builder preview,
  the respondent's browser and the server. The server never trusts the client: on completion it replays the logic,
  discards answers to questions the respondent shouldn't have seen, and re-checks every answer. Shared test vectors
  (`packages/survey-core/test-vectors/`) run in all three places.
- **Email campaigns.** Each recipient's link token is an HMAC of the recipient id (only its hash is stored). The
  worker claims a batch before sending, so a retry can't email anyone twice, and respects a per-org daily limit.
  Bounces and complaints from SES (via SNS, signature-checked) suppress an address for every org.
- **Analytics filters** use the same AND / OR / NOT grammar as survey logic, compiled to parameterised SQL.
  Anonymous surveys never show a filtered group smaller than 5. Dashboards update live over Server-Sent Events.
- **Uploads.** Files go through the API, which checks the real type from the bytes and the size before storing them
  in S3. Nothing is downloadable until ClamAV says it's clean; infected files are quarantined and the response is
  flagged.
- **Versioning.** Survey content is an immutable JSON document per version (the database refuses edits to a
  published version). Responses keep their version.
- **Languages.** Translations are stored per version, next to the definition, keyed by question and option keys,
  so logic and piping are the same in every language. The API serves the survey already translated (from `?lang=` or
  the browser's `Accept-Language`), and the respondent app mirrors for right-to-left scripts with CSS logical
  properties: the bundle grew by under 1 KB.
- **Single sign-on.** OpenID Connect (code flow with PKCE) and SAML 2.0, self-hosted (openid-client, node-saml).
  Organizations prove they own an email domain with a DNS TXT record; only verified domains can sign in or be
  enforced, so a misconfigured or malicious identity provider can't sign in as someone else.
- **Members-only surveys.** The respondent site never sees the admin session cookie. A signed-in member gets a
  two-minute, single-use token in the URL fragment, which the respondent app trades for a respondent token.
- **AI summaries.** Behind a small provider interface (OpenAI, or a deterministic fake). Emails and phone numbers
  are removed before sending, themes can only cite answers that were sent, and each org has a monthly token cap.
- **Webhooks and the public API.** Events are queued in the transaction that caused them and fanned out by the
  worker, keyed by event id so retries never duplicate. Deliveries are signed (HMAC-SHA256), retried for 48 hours,
  logged per attempt, and only sent to public addresses. API keys are hashed, scoped and rate limited.
- **Tenant isolation in the database.** The API connects as `survey_app`, a role without `BYPASSRLS`. Every
  request runs in a transaction scoped to one org, and Postgres row-level security fails closed.
- **Submissions are never lost.**
  - The respondent app keeps answers in `localStorage` and retries with backoff.
  - A secret response key makes every save and completion idempotent.
  - Follow-up jobs (aggregation, emails) are enqueued in the same transaction as the data (pg-boss).
- **Fast analytics.** Unfiltered dashboards read pre-aggregated counts; filtered views run one SQL pass. On 50k
  responses that's about 70 ms and 210 ms at p95.
- **Privacy.**
  - Anonymous surveys store no identifiers and hour-precision timestamps.
  - Respondent IPs are never stored (only salted hashes in Redis, for rate limiting).
  - Logs never contain answers, emails or tokens.

See [`docs/01-architecture.md`](docs/01-architecture.md) for the full picture.

## Configuration

Every variable is documented in [`.env.example`](.env.example). For production:

- Set `COOKIE_SECURE=true`. The API refuses to start in production without it.
- Use a long random `SESSION_SECRET`.
- Set `TRUST_PROXY=true` behind a load balancer.
- Set `APP_URL` and `RESPONDENT_URL` to the public origins.
- Set `SENTRY_DSN` if you want error tracking.
- Point `S3_*` at your bucket (any S3-compatible store) and run ClamAV: the API refuses to start in production
  unless `MALWARE_SCANNER=clamav`.
- Send email through SES: point `SMTP_URL` at the SES SMTP endpoint, subscribe an HTTPS endpoint
  (`<api>/api/v1/webhooks/ses`) to the SNS topic receiving bounce and complaint notifications, and list that topic
  in `SES_SNS_TOPIC_ARNS`. `EMAILS_PER_ORG_PER_DAY` caps campaign volume per organization.
- Serve `embed.js` from the respondent origin with a short cache (it's a stable URL), and allow survey pages to be
  framed (no `X-Frame-Options: DENY` on `/s/*`).
- Set `TURNSTILE_SITE_KEY` and `TURNSTILE_SECRET_KEY` from Cloudflare if surveys use the CAPTCHA option (the
  `.env.example` values are Cloudflare's always-pass test keys). The respondent app loads the widget from
  `challenges.cloudflare.com`, so allow it in any Content-Security-Policy.
- Run migrations as the database owner (superuser or `BYPASSRLS`, because of the narrow `SECURITY DEFINER`
  functions). Run the API and worker as `survey_app`.
- Set `DATA_ENCRYPTION_KEY` (32+ random characters). It encrypts webhook signing secrets and integration tokens; the
  API refuses to start in production without it, and changing it makes stored secrets unreadable. Leave
  `ALLOW_PRIVATE_WEBHOOK_URLS` unset: outgoing webhooks and Slack calls are then checked against private networks.
- AI summaries (optional): set `OPENAI_API_KEY` (and `OPENAI_MODEL` to change the default, `gpt-6-luna`).
  `AI_MONTHLY_TOKEN_CAP` is the default allowance per org; super admins can change it per org. Response text is sent
  to OpenAI, a third-party processor: cover it in your data processing agreements. Without a key the feature is
  shown as unavailable.
- Single sign-on: register `<app>/api/v1/auth/sso/oidc/callback` with OIDC providers; SAML providers get the ACS URL
  and entity ID shown on the settings page. Leave `SSO_DOMAIN_VERIFICATION` unset (DNS TXT verification).
- Retention purges run nightly in the worker (02:20 UTC).

Deploy `apps/api/dist` (two processes: `node dist/main.js` and `node dist/worker.js`) after
`pnpm install --prod`. Serve `apps/web/dist` and `apps/respondent/dist` as static files, with `/api/*` and `/r/*`
routed to the API on the same origins.

## Troubleshooting

- **`pnpm: command not found`:** run `corepack enable`, or `npm install -g pnpm@10`.
- **Database connection refused:** start Docker Desktop, then run `docker compose up -d`.
- **Port 5432 already in use:** set `POSTGRES_PORT=5433` (or another free port) for `docker compose` and update the
  URLs in `.env`.
- **The respondent app or builder preview shows development React warnings:** don't set `NODE_ENV` in `.env`.
  Vite reads that file.
- **Uploads fail with a storage error:** check the `s3` container is running (`docker compose ps`). The API creates
  the bucket on start when `S3_CREATE_BUCKET=true`.
- **Uploaded files stay "Checking for malware…":** the worker isn't running (it runs with `pnpm dev`), or
  `MALWARE_SCANNER=clamav` is set but ClamAV is still starting.
- **"AI summaries aren't available":** set `AI_PROVIDER=fake` (development) or `OPENAI_API_KEY`, then restart the API
  and worker.
- **SSO domains stay "Not verified" locally:** there is no DNS for test domains. Set `SSO_DOMAIN_VERIFICATION=auto`
  (development only) and add the domain again.
