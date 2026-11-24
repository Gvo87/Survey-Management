# 3. API Design

> Status: draft for approval. Phase tags: **P1**, **P2**, **P3**. 🔑 = also part of the public, API-key-accessible
> surface (P3). Everything else is used by the admin app only.

## 3.1 Conventions

| Topic | Convention |
|---|---|
| Surfaces | `/api/v1/*`: authenticated (admin app with cookie session, or API key). `/r/v1/*`: public respondent endpoints, rate-limited separately, never use cookies. |
| Format | JSON, `camelCase`, ISO 8601 UTC timestamps, UUID strings for IDs. |
| Auth | Cookie session + `X-CSRF-Token` header on unsafe methods. Or `Authorization: Bearer sk_…` (P3, no CSRF). |
| Tenant | The active org comes from the session (`POST /auth/switch-org`) or from the API key. It's never taken from the URL, so a request can't name another tenant. The admin app also sends `X-Org-Id` with the org it expects. A mismatch returns `409 org_mismatch`, which protects against multi-tab confusion. |
| Pagination | Cursor-based: `?limit=25&cursor=…` returns `{ data: T[], nextCursor: string \| null }`. Max `limit` is 100. |
| Errors | RFC 9457 `application/problem+json`, see below. Stable machine-readable `code`. |
| Concurrency | Drafts use `ETag` / `If-Match` with the draft `revision`. A mismatch returns `409`. |
| Idempotency | Respondent writes: secret response key + `seq` (§3.6). Public API POSTs accept an `Idempotency-Key` header (P3). |
| Rate limits | `RateLimit-Limit`, `RateLimit-Remaining`, `RateLimit-Reset` headers. `429` with `Retry-After`. |
| Versioning | Major version in the path. Within `v1`, changes are additive only. |
| Docs | OpenAPI 3.1 generated from the Zod contracts in `packages/contracts`. Internal docs at `/api/docs` from P1. Public, curated docs from P3. |

```ts
// Error body (RFC 9457)
type Problem = {
  type: string;            // URL to the error docs
  title: string;
  status: number;
  code: string;            // 'validation_failed' | 'revision_conflict' | 'forbidden' | …
  detail?: string;
  errors?: { path: string; code: string; message: string }[];
  requestId: string;
};

// Shared types
type OrgRole = 'org_admin' | 'creator' | 'analyst';
type SurveyRole = 'owner' | 'editor' | 'viewer';
type SurveyStatus = 'draft' | 'live' | 'closed' | 'archived';
type AnswerValue = string | number | boolean | string[] | Record<string, string | string[]>
                 | { option: string; other: string };
```

## 3.2 Auth and account

| Method | Path | Phase | Request → Response |
|---|---|---|---|
| POST | `/api/v1/auth/signup` | P1 | `{ name, email, password, orgName }` → `201 Me`. Creates org + `org_admin` membership and sends a verification email. Can be switched to invite-only by env flag. |
| POST | `/api/v1/auth/login` | P1 | `{ email, password }` → `200 Me` + `Set-Cookie`. Generic error message (no user enumeration). Rate-limited. |
| POST | `/api/v1/auth/logout` | P1 | → `204` |
| GET | `/api/v1/auth/me` | P1 | → `Me` |
| GET | `/api/v1/auth/csrf` | P1 | → `{ csrfToken }` |
| POST | `/api/v1/auth/switch-org` | P1 | `{ orgId }` → `Me` |
| POST | `/api/v1/auth/verify-email` | P1 | `{ token }` → `204` |
| POST | `/api/v1/auth/password/forgot` | P1 | `{ email }` → always `202` |
| POST | `/api/v1/auth/password/reset` | P1 | `{ token, password }` → `204`. Revokes the user's other sessions. |
| GET | `/api/v1/auth/sso/{orgSlug}/start` | P3 | → `302` to the identity provider |
| POST | `/api/v1/auth/sso/callback` | P3 | SAML/OIDC callback → `302` to the app |

```ts
type Me = {
  user: { id: string; email: string; name: string; isSuperAdmin: boolean; emailVerified: boolean };
  activeOrg: { id: string; name: string; slug: string; role: OrgRole } | null;
  memberships: { orgId: string; orgName: string; role: OrgRole }[];
};
```

## 3.3 Organization, members, administration

| Method | Path | Phase | Request → Response |
|---|---|---|---|
| GET | `/api/v1/org` | P1 | → `{ id, name, slug, plan, settings }` |
| PATCH | `/api/v1/org` | P1+ | `{ name }`. P2: `branding`, `defaultThemeId`. P3: `retention`, `approvalRequired`, `sso`. Org admin only. |
| GET | `/api/v1/org/members` | P1 | → `Page<{ userId, name, email, role, joinedAt, lastLoginAt }>` |
| PATCH | `/api/v1/org/members/{userId}` | P1 | `{ role }` → member. Demoting the last `org_admin` returns `409 last_admin`. |
| DELETE | `/api/v1/org/members/{userId}?transferTo={userId}` | P1 | → `204`. Surveys they own move to `transferTo` (default: the caller). |
| GET | `/api/v1/org/invitations` | P1 | → `Page<Invitation>` |
| POST | `/api/v1/org/invitations` | P1 | `{ email, role }` → `201 Invitation` (sends email) |
| DELETE | `/api/v1/org/invitations/{id}` | P1 | → `204` (revoke) |
| GET | `/api/v1/invitations/{token}` | P1 | Public → `{ orgName, email, role, userExists }` |
| POST | `/api/v1/invitations/{token}/accept` | P1 | New user: `{ name, password }`. Existing user: their session. → `Me` |
| GET/POST/PATCH/DELETE | `/api/v1/org/teams[/{id}][/members]` | P3 | Teams, used for survey sharing |
| GET | `/api/v1/org/usage?from&to` | P3 | → `{ responses, surveysPublished, emailsSent, aiTokens, byMonth[] }` |
| GET | `/api/v1/audit-logs?action&actorId&entityType&entityId&from&to` | P3 | → `Page<AuditEntry>` (org admin) |
| POST | `/api/v1/privacy/requests` | P3 | `{ subjectEmail, kind: 'export' \| 'erase' }` → `202 { id }` |
| GET | `/api/v1/privacy/requests/{id}` | P3 | → `{ status, downloadUrl? }` |
| GET | `/api/v1/admin/orgs` · `PATCH /api/v1/admin/orgs/{id}` | P3 | Super admin: list orgs, suspend, change plan |
| GET/POST/PATCH/DELETE | `/api/v1/admin/templates[/{id}]` | P2 | Super admin: global templates |

## 3.4 Surveys, drafts, versions

| Method | Path | Phase | Request → Response |
|---|---|---|---|
| GET | `/api/v1/surveys?status&q&folderId&cursor` 🔑 | P1 | → `Page<SurveySummary>` (`folderId` from P3) |
| POST | `/api/v1/surveys` 🔑 | P1 | `{ title, fromTemplateId? (P2), folderId? (P3) }` → `201 SurveyDetail` with an empty draft |
| GET | `/api/v1/surveys/{id}` 🔑 | P1 | → `SurveyDetail` |
| PATCH | `/api/v1/surveys/{id}` | P1 | `{ title?, anonymous?, access?, themeId? (P2), folderId? (P3) }` → `SurveyDetail` |
| DELETE | `/api/v1/surveys/{id}` | P1 | → `204` (soft delete, owner only) |
| POST | `/api/v1/surveys/{id}/duplicate` | P1 | `{ title? }` → `201 SurveyDetail` (copies the latest definition as a new draft) |
| POST | `/api/v1/surveys/{id}/close` · `/reopen` · `/archive` 🔑 | P1 | → `SurveyDetail` |
| GET | `/api/v1/surveys/{id}/draft` | P1 | → `Draft`, `ETag: "rev-N"`. `404` if there's no draft. |
| POST | `/api/v1/surveys/{id}/draft` | P1 | → `201 Draft` copied from the current version. Returns `200` with the existing draft if there already is one. |
| PUT | `/api/v1/surveys/{id}/draft` | P1 | `If-Match: "rev-N"`, `{ definition }` → `200 { revision, validation }` · `409 revision_conflict` · `422 invalid_definition` |
| DELETE | `/api/v1/surveys/{id}/draft` | P1 | → `204` (only when a published version exists) |
| POST | `/api/v1/surveys/{id}/publish` 🔑 | P1 | `{ revision }` → `200 { version, survey, publicUrl }` · `422` with errors. P3 with approvals on: `202 { approvalRequest }`. |
| GET | `/api/v1/surveys/{id}/versions` 🔑 | P1 | → `{ id, versionNumber, publishedAt, publishedBy, responseCount }[]` |
| GET | `/api/v1/surveys/{id}/versions/{versionId}` 🔑 | P1 | → `{ …, definition }` |
| GET | `/api/v1/surveys/{id}/collaborators` | P1 | → `{ user: {id,name,email}, role }[]` (P3: also teams) |
| PUT | `/api/v1/surveys/{id}/collaborators/{userId}` | P1 | `{ role }` → collaborator. Capped by org role: an analyst can be at most `viewer` (`422 role_exceeds_org_role`). |
| DELETE | `/api/v1/surveys/{id}/collaborators/{userId}` | P1 | → `204`. The owner can't be removed; transfer ownership first. |
| POST | `/api/v1/surveys/{id}/transfer` | P1 | `{ userId }` → `SurveyDetail` |
| POST | `/api/v1/surveys/{id}/save-as-template` | P2 | `{ name, category }` → `201 Template` |
| GET | `/api/v1/templates?category` | P2 | → org and global templates |
| GET/POST/PATCH/DELETE | `/api/v1/question-bank[/{id}]` | P2 | `{ question, tags }` |
| GET/POST/PATCH/DELETE | `/api/v1/themes[/{id}]` | P2 | `{ name, tokens, logoFileId }` |
| GET/PUT | `/api/v1/surveys/{id}/versions/{versionId}/translations/{locale}` | P3 | `{ strings: Record<textKey, string> }`, plus `GET …/translations/{locale}/missing` |
| GET/POST/PATCH | `/api/v1/surveys/{id}/comments[/{commentId}]` | P3 | `{ body, anchorKey?, parentId? }`, `{ resolved }` |
| POST | `/api/v1/approval-requests/{id}/approve` · `/reject` | P3 | `{ note? }` |
| GET/POST/PATCH/DELETE | `/api/v1/folders[/{id}]` | P3 | `{ name, parentId? }` |

```ts
type SurveySummary = {
  id: string; publicId: string; title: string; status: SurveyStatus;
  myRole: SurveyRole; owner: { id: string; name: string };
  completedCount: number; currentVersionNumber: number | null; hasDraft: boolean;
  publicUrl: string | null; updatedAt: string;
};
type SurveyDetail = SurveySummary & {
  anonymous: boolean;
  access: {
    closesAt: string | null;
    quota: number | null;
    onePerBrowser: boolean;
    opensAt?: string | null;            // P2
    passwordEnabled?: boolean;          // P2; the password is write-only via PATCH { access: { password } }
    onePerRecipient?: boolean;          // P2
  };
  closedReason: 'manual' | 'close_date' | 'quota' | null;
  createdAt: string;
};
type Draft = {
  versionId: string; revision: number; basedOnVersionNumber: number | null;
  definition: SurveyDefinition;                 // see data model §2.3
  validation: { errors: Issue[]; warnings: Issue[] };
};
type Issue = { path: string; code: string; message: string };   // path e.g. "pages[1].elements[3].options"
```

## 3.5 Distribution and contacts

| Method | Path | Phase | Request → Response |
|---|---|---|---|
| GET | `/api/v1/surveys/{id}/distributions` | P1 | → `Distribution[]` |
| POST | `/api/v1/surveys/{id}/distributions` | P1 | `{ channel: 'link', name, presetHiddenFields? }` → `201 Distribution`. P2: `channel: 'embed'` with `config: { mode: 'inline' \| 'popup', trigger? }`. |
| PATCH / DELETE | `/api/v1/distributions/{id}` | P1 | `{ name?, presetHiddenFields?, disabled? }` |
| GET/POST/PATCH/DELETE | `/api/v1/contacts[/{id}]` 🔑 | P2 | `{ email, firstName?, lastName?, attributes? }` |
| POST | `/api/v1/contacts/imports` 🔑 | P2 | multipart CSV + `{ listId?, columnMapping }` → `202 { importId }` |
| GET | `/api/v1/contacts/imports/{id}` 🔑 | P2 | → `{ status, total, imported, skipped, errors[] }` |
| GET/POST/PATCH/DELETE | `/api/v1/contact-lists[/{id}]`, `POST …/{id}/members` 🔑 | P2 | lists and membership |
| POST | `/api/v1/surveys/{id}/campaigns` | P2 | `{ listId, subject, body, scheduledAt?, reminders?: { afterDays, max } }` → `201 Campaign` |
| GET / PATCH | `/api/v1/campaigns/{id}` | P2 | PATCH only while `scheduled` |
| POST | `/api/v1/campaigns/{id}/send` · `/cancel` | P2 | → `Campaign` |
| GET | `/api/v1/campaigns/{id}/recipients?status&cursor` | P2 | → `Page<{ contact, status, sentAt, remindersSent, respondedAt }>` |

```ts
type Distribution = {
  id: string; channel: 'link' | 'embed' | 'email'; name: string; isDefault: boolean;
  url: string;                                   // https://s.example.com/s/{publicId}?d={token}
  presetHiddenFields: Record<string, string>;
  embedSnippet?: string;                         // P2
  responseCount: number; disabledAt: string | null;
};
```

QR codes are generated **client-side** from `url` (SVG or PNG download), so there's no endpoint for them.

## 3.6 Respondent API (`/r/v1`, public)

The respondent's browser generates a **secret response key** (128-bit random, base64url) when it starts a survey.
The key does three jobs at once:

1. **Idempotency:** the server stores `sha256(key)`, unique per survey.
2. **Resume credential:** it's kept in localStorage. Phase 2 adds an emailed resume link.
3. **Authorization** for all later calls about that response.

The key travels in the `X-Response-Key` header, never in a URL, so it doesn't end up in access logs. `seq`
increases with each save, and the server ignores a save whose `seq` isn't newer than the last one applied. So
retries and out-of-order deliveries are safe.

| Method | Path | Phase | Request → Response |
|---|---|---|---|
| GET | `/r/v1/s/{publicId}?d={distToken}&lang={locale}` | P1 | → `RespondentSurvey` (`lang` from P3) |
| PUT | `/r/v1/s/{publicId}/response` | P1 | `SaveRequest` → `200 { applied, seq }` |
| GET | `/r/v1/s/{publicId}/response` | P1 | → `{ versionId, status, currentPageKey, seq, answers }` (resume) |
| POST | `/r/v1/s/{publicId}/response/complete` | P1 | `SaveRequest` → `200 CompleteResult` · `422` |
| POST | `/r/v1/s/{publicId}/unlock` | P2 | `{ password }` → `{ accessToken }` (short-lived, sent as `X-Access-Token`) |
| POST | `/r/v1/s/{publicId}/uploads?questionKey=` | P2A | `multipart/form-data` with one file → `{ fileId, filename, size, mime }`. Built differently from the design: see §3.10 |
| POST | `/r/v1/s/{publicId}/response/resume-link` | P2 | `{ email }` → `202` (not available in anonymous mode) |
| GET/POST | `/r/v1/unsubscribe/{token}` | P2 | confirmation page / unsubscribe |

```ts
type RespondentSurvey = {
  survey: { publicId: string; title: string; anonymous: boolean };
  access:
    | { state: 'open' }
    | { state: 'closed'; message: string }
    | { state: 'not_yet_open'; opensAt: string }     // P2
    | { state: 'password_required' }                 // P2
    | { state: 'already_responded' };                // P2, recipient token already used
  version: { id: string; definition: SurveyDefinition } | null;  // null unless state is 'open'
  theme: Theme | null;                                           // P2
};

type SaveRequest = {
  seq: number;
  start?: {                                   // required on the first save only
    versionId: string;
    distributionToken?: string;
    recipientToken?: string;                  // P2
    hiddenFields?: Record<string, string>;    // undeclared keys are dropped
    locale: string;
  };
  answers: { questionKey: string; subKey?: string; value: AnswerValue | null }[];  // null clears an answer
  currentPageKey: string;
  hp?: string;                                // honeypot: must be empty
  captchaToken?: string;                      // P2 when CAPTCHA is enabled
};

type CompleteResult = {
  responseStatus: 'completed' | 'disqualified';
  thankYou: { title: string; body: string };
  redirectUrl?: string;                       // P2; hidden fields can be appended
};
```

Behaviour notes:

- **First save on a closed survey, over quota, or before the open date** → `410 { code: 'survey_closed' | 'quota_reached' | 'not_yet_open' }`.
  A respondent who already started can still finish (see open question Q7).
- **Complete** re-runs the logic engine on every stored answer. Answers to questions that ended up hidden are
  deleted. Missing required answers return `422` with `errors[].path = questionKey` and the `pageKey` to send the
  respondent back to. Repeating a completed call returns the same `200`.
- **Saves after completion** → `409 already_completed`.
- **Honeypot filled** → `200` that looks normal, and nothing is stored.
- **Rate limits (defaults):** 20 new responses / min / IP hash / survey, 120 saves / min / response key,
  plus a per-survey global ceiling that triggers CAPTCHA (P2) instead of rejecting.
- **Caching:** `GET /r/v1/s/{publicId}` is `Cache-Control: public, max-age=30`. The definition for a given version
  is cached in Redis indefinitely (versions are immutable).

## 3.7 Results, responses, exports

| Method | Path | Phase | Request → Response |
|---|---|---|---|
| GET | `/api/v1/surveys/{id}/results/summary?from&to&versionId&includePartial&includeTest` | P1 | → `ResultsSummary` |
| POST | `/api/v1/surveys/{id}/results/query` | P2 | `{ filter?: ResultFilter, segments?: { name, filter }[] }` → `ResultsSummary` (or one per segment) |
| POST | `/api/v1/surveys/{id}/results/crosstab` | P2 | `{ rows: { questionKey, subKey? }, columns: { questionKey, subKey? }, filter? }` → `{ rows[], columns[], counts: number[][], rowPct, colPct, chiSquare: { value, df, p } }` |
| GET | `/api/v1/surveys/{id}/results/questions/{questionKey}/text?cursor` | P1 | → `Page<{ responseId, text, completedAt }>` |
| GET | `/api/v1/surveys/{id}/results/questions/{questionKey}/terms` | P2 | → `{ terms: { term, count }[] }` (word cloud, stop-words removed) |
| GET | `/api/v1/surveys/{id}/live` | P2 | Server-Sent Events: `{ type: 'response.completed', completedCount }` |
| GET | `/api/v1/surveys/{id}/responses?status&from&to&cursor` 🔑 | P1 | → `Page<ResponseSummary>`. P2 adds `q` (full-text), `tag`, `filter`. 🔑 adds `updatedSince` for sync. |
| GET | `/api/v1/surveys/{id}/responses/{responseId}` 🔑 | P1 | → `ResponseDetail` |
| DELETE | `/api/v1/surveys/{id}/responses/{responseId}` 🔑 | P1 | → `204` (hard delete, audited, aggregates repaired) |
| POST | `/api/v1/surveys/{id}/responses/bulk-delete` | P2 | `{ ids } \| { filter }` → `202 { jobId }` |
| PUT / DELETE | `/api/v1/responses/{id}/tags/{tagId}` | P2 | tagging |
| POST / DELETE | `/api/v1/responses/{id}/notes[/{noteId}]` | P2 | `{ body }` |
| GET | `/api/v1/surveys/{id}/export.csv?from&to&versionId&status&layout=compact\|expanded` | P1 | streamed `text/csv` (UTF-8 BOM). Audited. |
| POST | `/api/v1/surveys/{id}/exports` | P2 | `{ format: 'csv' \| 'xlsx' \| 'pdf', filter?, layout? }` → `202 { exportId }` |
| GET | `/api/v1/exports/{id}` | P2 | → `{ status, downloadUrl?, expiresAt? }` (signed URL valid 15 min) |
| GET/POST/PATCH/DELETE | `/api/v1/surveys/{id}/scheduled-reports[/{id}]` | P2 | `{ cron, timezone, recipients, format, filter? }` |
| POST | `/api/v1/surveys/{id}/insights/text` | P3 | `{ questionKey, filter? }` → `202 { insightId }` |
| GET | `/api/v1/insights/{id}` | P3 | → `TextInsight` |

```ts
type ResultsSummary = {
  totals: {
    started: number; completed: number; disqualified: number;
    completionRate: number;                   // completed / started
    avgDurationSec: number | null; medianDurationSec: number | null;
  };
  dropoff: { pageKey: string; title: string; reached: number; abandonedHere: number }[];   // P2 adds per question
  questions: QuestionSummary[];
  generatedAt: string;
  source: 'aggregate' | 'live';               // pre-aggregated vs computed for a filter
};

type QuestionSummary = { questionKey: string; title: string; answered: number; removedInCurrentVersion: boolean } & (
  | { type: 'single_choice' | 'multi_choice' | 'dropdown' | 'likert';
      options: { key: string; label: string; count: number; pct: number }[]; otherCount: number; mean?: number }
  | { type: 'rating' | 'slider'; mean: number; median: number; distribution: { value: number; count: number }[] }
  | { type: 'nps'; score: number; promoters: number; passives: number; detractors: number;
      distribution: { value: number; count: number }[] }
  | { type: 'short_text' | 'long_text' | 'email' | 'phone'; latest: { responseId: string; text: string }[] }
  | { type: 'date'; byDay: { date: string; count: number }[] }
  | { type: 'matrix'; rows: { key: string; label: string }[]; columns: { key: string; label: string }[];
      counts: number[][] }                                      // P2, heatmap
  | { type: 'ranking'; options: { key: string; label: string; meanRank: number; firstPlace: number }[] }  // P2
  | { type: 'file_upload'; files: number }                      // P2
);

// Filters reuse the survey-logic condition grammar (data model §2.3) plus response fields.
type ResultFilter =
  | { all: ResultFilter[] } | { any: ResultFilter[] } | { not: ResultFilter }
  | { question: string; sub?: string; op: Operator; value?: unknown }
  | { hidden: string; op: 'eq' | 'in' | 'answered'; value?: string | string[] }
  | { field: 'status' | 'startedAt' | 'completedAt' | 'versionId' | 'distributionId' | 'deviceType' | 'tag';
      op: 'eq' | 'in' | 'gte' | 'lte' | 'between'; value: unknown };

type ResponseSummary = {
  id: string; status: 'in_progress' | 'completed' | 'disqualified';
  startedAt: string; completedAt: string | null; durationSec: number | null;
  versionNumber: number; distributionName: string | null; deviceType: string | null;
  preview: string;                             // first text answer, truncated
  tags?: string[];                             // P2
};
type ResponseDetail = ResponseSummary & {
  hiddenFields: Record<string, string>;
  answers: { questionKey: string; title: string; type: string; value: AnswerValue; display: string }[];
  notes?: { id: string; author: string; body: string; createdAt: string }[];   // P2
};

type TextInsight = {                           // P3
  status: 'pending' | 'ready' | 'failed';
  aiGenerated: true;                           // the UI must label this as AI-generated
  model: string; generatedAt: string; basedOnResponses: number;
  themes: { label: string; description: string; count: number; sampleResponseIds: string[] }[];
  sentiment: { positive: number; neutral: number; negative: number };
};
```

**CSV layout:** one row per response. Fixed columns come first: `response_id, status, started_at, completed_at,
duration_sec, version, distribution, device_type`, then hidden fields. Then one column per question, covering the
union of all versions in range, ordered as in the newest version:

- `compact` layout: choice labels joined with `; `
- `expanded` layout: one 0/1 column per option
- Matrix: one column per row. Ranking: one column per option.
- "Other" text gets its own column.

Cells beginning with `= + - @` are prefixed with `'` to stop formula injection.

## 3.8 Webhooks, API keys, notifications, integrations (P3)

| Method | Path | Request → Response |
|---|---|---|
| GET/POST | `/api/v1/webhooks` 🔑 | `{ url, events: ('response.submitted' \| 'survey.published' \| 'survey.closed')[], surveyIds?, description? }` → `201 { id, …, secret }`. The secret is shown once. |
| PATCH / DELETE | `/api/v1/webhooks/{id}` 🔑 | `{ url?, events?, active? }` |
| POST | `/api/v1/webhooks/{id}/rotate-secret` 🔑 | → `{ secret }`. The old secret stays valid for 24 h. |
| POST | `/api/v1/webhooks/{id}/test` 🔑 | → `{ deliveryId, httpStatus, durationMs }` |
| GET | `/api/v1/webhooks/{id}/deliveries?status&cursor` 🔑 | → `Page<{ id, eventType, attempt, httpStatus, status, createdAt, nextAttemptAt }>` |
| POST | `/api/v1/webhooks/{id}/deliveries/{deliveryId}/redeliver` 🔑 | → `202` |
| GET/POST/DELETE | `/api/v1/api-keys[/{id}]` | `{ name, scopes, expiresAt? }` → `201 { id, key }`. The key is shown once, e.g. `sk_live_…`. |
| GET / POST | `/api/v1/notifications`, `/api/v1/notifications/read` | in-app inbox, mark as read |
| GET/PUT | `/api/v1/surveys/{id}/notification-rules` | `[{ kind: 'new_response' \| 'nps_detractor' \| 'threshold' \| 'closing', config, channels: ('email' \| 'in_app' \| 'slack')[] }]` |
| GET/PUT/DELETE | `/api/v1/integrations/{kind}` | `slack` \| `hubspot` \| `google_sheets`. OAuth connect/callback stubs + config. |

**Webhook delivery contract**

```http
POST {customer url}
Content-Type: application/json
Survey-Webhook-Id: evt_01JD…           # stable across retries, so receivers can dedupe
Survey-Webhook-Timestamp: 1795430400
Survey-Webhook-Signature: v1=5f2b…     # hex(HMAC_SHA256(secret, timestamp + "." + rawBody))

{
  "id": "evt_01JD…",
  "type": "response.submitted",
  "createdAt": "2026-11-23T10:00:00Z",
  "data": {
    "surveyId": "…", "responseId": "…", "versionNumber": 3, "completedAt": "…",
    "hiddenFields": { "customer_id": "C-981" },
    "answers": [ { "questionKey": "q_7Hk2", "title": "How likely…", "type": "nps", "value": 9, "display": "9" } ]
  }
}
```

- **Success:** any `2xx` within 10 s.
- **Retries:** after 1 m, 5 m, 30 m, 2 h, 6 h, 12 h and 24 h. Then the delivery is marked `failed` and can be redelivered manually.
- **Auto-disable:** after 50 consecutive failed events. Org admins are notified.
- **Receivers** should reject timestamps older than 5 minutes (replay protection).
- **Anonymous surveys:** payloads never include anything the database doesn't store.

**API key scopes:** `surveys:read`, `surveys:write`, `responses:read`, `responses:delete`, `contacts:read`,
`contacts:write`, `webhooks:manage`. Default limit: 600 requests/min per key.

## 3.9 Implemented in Phase 1 (differences in detail)

The contracts in `packages/contracts/src/index.ts` are authoritative. Differences from the sections above:

- **`GET /r/v1/s/{publicId}`** also accepts `X-Response-Key`. When it matches a response, the reply includes
  `resume` (status, page, answers) and that response's own version definition, so resuming takes one request.
  Responses carry `Cache-Control: no-store` rather than a public max-age, because they can contain resume data.
  Published definitions are cached in Redis instead.
- **Saves are full snapshots:** every `PUT …/response` and `…/complete` carries every answer so far with a new `seq`.
  A lost or out-of-order save can therefore never drop an earlier page.
- **Multi-choice with "Other"** is `{ options: string[], other: string }`, alongside `{ option, other }` for single choice.
- **`Me`** includes `csrfToken`, so the app needs no separate `GET /auth/csrf` call (the endpoint exists too).
- **Hidden fields:** link presets win over URL parameters, so attribution can't be changed by editing the URL.
- **Email jobs carry IDs only.** The worker creates the secret token when it sends the email, so raw tokens never
  sit in the job table. As a result, `POST /org/invitations` doesn't return the invitation link: it arrives by email.
- **Not built in Phase 1:** the OpenAPI document (`/api/docs`). It's generated from the same Zod contracts when the
  public API arrives in Phase 3.

## 3.10 Phase 2A additions (as built)

**Respondent API**

| Method | Path | Notes |
|---|---|---|
| GET | `/r/v1/s/{publicId}` | Adds `access.state` values `not_yet_open` (with `opensAt`) and `password_required` (no definition is returned), `theme`, `captchaSiteKey` and `presetHiddenFields` (link presets, so the browser evaluates logic on the same hidden fields as the server). `resume` includes the stored `hiddenFields`. |
| POST | `/r/v1/s/{publicId}/unlock` | `{ password }` → `{ accessToken }`, sent back as `X-Access-Token`. Stateless HMAC token, 12 h, invalid as soon as the password changes. 10 attempts per 5 minutes per IP. |
| PUT/POST | `…/response`, `…/response/complete` | The first save of a new response needs `start.captchaToken` when the survey has CAPTCHA on, and a valid access token when it has a password. Completion replays the logic: answers on skipped pages or hidden questions are discarded; the outcome is `completed` or `disqualified`; the end screen is piped and may carry a `redirectUrl`. |
| POST / DELETE | `/r/v1/s/{publicId}/uploads`, `…/uploads/{fileId}` | Upload through the API (multipart), remove an upload. The response must exist; anonymous surveys refuse uploads (also enforced by a database trigger). |
| GET | `/r/v1/assets/{fileId}` | Theme logos, only once scanned clean. |

**Admin API**

| Method | Path | Notes |
|---|---|---|
| GET / POST / PUT / DELETE | `/api/v1/themes`, `/api/v1/themes/{id}` | `org.update`. `422 contrast_too_low` when colours fail WCAG AA. One default per org. |
| POST | `/api/v1/themes/logo` | PNG, JPEG, WebP or GIF up to 1 MB (SVG refused: it can carry scripts). |
| GET | `/api/v1/templates`, `/api/v1/templates/{kind}/{id}` | Global templates and this org's template surveys. |
| POST | `/api/v1/surveys` | `fromTemplate: { kind, id }` copies a template with fresh keys (references in logic and piping are remapped). |
| POST | `/api/v1/surveys/{id}/save-as-template` | Copies the latest draft (or live version) into a template survey. Templates are hidden from the survey list and can't be published (`409 template_not_publishable`). |
| POST / DELETE | `/api/v1/admin/templates` | Super admins manage global templates. |
| GET / POST / DELETE | `/api/v1/question-bank` | Questions are stored with fresh keys and without display logic. Only the author or an admin removes one. |
| PATCH | `/api/v1/surveys/{id}` | `access.password` (write-only: string sets, `null` removes; reads show `passwordEnabled`), `access.opensAt`, `access.captcha`, `themeId`. |
| GET | `/api/v1/files/{id}` | Downloads an upload (`responses.view`). `409 scan_pending`, `403 file_quarantined`, `409 scan_failed`. Every download is audited. Served with `Content-Disposition: attachment` and a sandbox CSP. |
| GET | `…/responses?flag=`, `…/results/summary?excludeFlagged=`, `…/export.csv?excludeFlagged=` | Quality flags: `too_fast`, `straight_lined`, `malware`. |

**Deviation: uploads go through the API, not to S3 with presigned URLs.** The design had the browser upload
straight to S3. As built, the API receives the file, checks its real type from the first bytes (`file-type`; a
renamed `.exe` is refused) and its size, then stores it and enqueues the scan. Trade-off: upload bandwidth passes
through the API (limited to 25 MB per file, 30 uploads per response per hour), in exchange for one simple path where
nothing unchecked ever lands in the bucket. Revisit if uploads get large or frequent.

## 3.11 Phase 2B additions (as built)

**Respondent API**

| Method | Path | Notes |
|---|---|---|
| GET | `/r/v1/s/{publicId}?t={token}` | A personal campaign link. Adds `contact` (fields for `{{contact.…}}` piping, never in anonymous surveys) and the `already_responded` access state. |
| PUT/POST | `…/response`, `…/response/complete` | `start.recipientToken` links a non-anonymous response to its recipient (one per recipient, `409 already_responded`). Completion marks the recipient `responded`. |
| POST | `/r/v1/s/{publicId}/response/resume-link` | `{ email }` → `202`. Emails `…/s/{publicId}#k={responseKey}`; the key is in the fragment, which browsers never send to servers. Not for anonymous surveys; 3 per response per hour. |
| GET / POST | `/r/v1/unsubscribe/{token}` | No login. `POST` also accepts the RFC 8058 one-click form body. |

**Admin API** (contacts and campaigns need the `contacts.manage` org capability: admins and creators)

| Method | Path | Notes |
|---|---|---|
| GET/POST/PATCH/DELETE | `/api/v1/contacts[/{id}]`, `GET /api/v1/contacts/attributes` | `?q&listId&status&cursor`. Delete is a hard delete. |
| GET/POST/PATCH/DELETE | `/api/v1/contact-lists[/{id}]`, `POST …/{id}/members`, `POST …/{id}/members/remove` | |
| POST | `/api/v1/contacts/imports` | Multipart: fields `mapping` (JSON), `listId` or `newListName`, then the CSV (20 MB) → `202 ContactImport`. |
| GET | `/api/v1/contacts/imports[/{id}]`, `…/{id}/errors.csv` | Progress and the error report. |
| GET/POST | `/api/v1/surveys/{id}/campaigns` | Unknown merge tags are rejected when saving. |
| GET/PATCH/DELETE | `/api/v1/campaigns/{id}` | Edit only while draft or scheduled; delete only drafts. |
| POST | `/api/v1/campaigns/{id}/send`, `…/cancel` | `{ scheduledAt?: 'YYYY-MM-DDTHH:mm', timezone }`. The survey must be live. |
| GET | `/api/v1/campaigns/{id}/recipients` | `?status&cursor`. |
| POST | `/api/v1/webhooks/ses` | SNS notifications (signature-verified, topic allow-list). Disabled unless `SES_SNS_TOPIC_ARNS` is set. |
| POST | `/api/v1/surveys/{id}/results/query` | `{ from?, to?, versionId?, includePartial, includeTest, excludeFlagged, filter?, segments?: { name, filter }[] (≤ 4) }` → `{ overall, suppressed, segments[], minGroupSize }`. |
| POST | `/api/v1/surveys/{id}/results/crosstab` | `{ …scope, rows: { questionKey, subKey? }, columns: … }` → counts, row/column %, chi-square (single-answer questions only) and warnings. |
| POST | `/api/v1/surveys/{id}/results/dropoff` | Per question: answered, and in-progress responses whose last answer it was. |
| GET | `/api/v1/surveys/{id}/results/questions/{key}/terms` | Word frequencies (stop words removed), `?filter=` (JSON). |
| GET | `/api/v1/surveys/{id}/live` | Server-Sent Events: `ready`, then `update` `{ type: 'response.completed', completedCount }`. |
| GET | `/api/v1/surveys/{id}/responses` | Adds `q` (full text), `tag`, `filter` (JSON) and, on the first page, `total`. |
| GET/POST/DELETE | `/api/v1/surveys/{id}/tags[/{tagId}]` | Deleting a tag needs `responses.delete`. |
| PUT/DELETE | `/api/v1/surveys/{id}/responses/{rid}/tags/{tagId}` | |
| POST/DELETE | `/api/v1/surveys/{id}/responses/{rid}/notes[/{noteId}]` | Notes are deleted by their author or an admin. |
| POST | `/api/v1/surveys/{id}/responses/bulk-delete` | `{ ids } \| { scope }` plus `expectedCount` (`409 selection_changed` if it differs). Synchronous; rebuilds aggregates; audited. |
| POST/GET | `/api/v1/surveys/{id}/exports`, `GET /api/v1/exports/{id}`, `…/download` | CSV, XLSX or PDF, generated by the worker, kept 7 days, downloads audited. |
| GET/POST, PUT/DELETE | `/api/v1/surveys/{id}/scheduled-reports`, `/api/v1/scheduled-reports/{id}` | `{ name, frequency, day, hour, timezone, format, options, recipientIds, active }`. Recipients must be members who can see the responses. |

**Filters** follow §3.7's `ResultFilter` with these operators: answers use the logic operators of their kind;
hidden fields `eq, neq, in, not_in, text_contains, answered, not_answered` (case-insensitive); fields `status`,
`deviceType`, `versionId`, `distributionId`, `tag` take `eq, neq, in, not_in`; `startedAt` and `completedAt` take
`gte, lte, between`.

Where the build differs from §3.5–3.7 is listed in [phase-2b-status.md](phase-2b-status.md).

## 3.12 Phase 3A additions (as built)

**Public API.** `Authorization: Bearer sk_live_…` works on exactly the routes marked 🔑 (plus draft read/write, the
results summary and contact lists), listed in `apps/api/src/auth/api-keys.ts`. Any other route answers
`403 not_available_with_api_key`; a missing scope answers `403 insufficient_scope` with `requiredScope`. The curated
OpenAPI 3.1 document is at `GET /api/v1/openapi.json` (no auth). Guide: [public-api.md](public-api.md).

| Method | Path | Notes |
|---|---|---|
| GET/POST/DELETE | `/api/v1/api-keys[/{id}]` | Org admins, cookie session only. `{ name, scopes, expiresAt? }` → `201 { …, key }` (shown once). Delete revokes. |
| any POST | `Idempotency-Key: <1–255 printable ASCII>` | Same key and body within 24 h → the first response with `Idempotent-Replayed: true`. Same key, different body → `422 idempotency_key_reused`. Still running → `409 idempotency_in_progress`. Keys are per caller (API key or user). |
| GET/POST, GET/PATCH/DELETE | `/api/v1/webhooks`, `/api/v1/webhooks/{id}` | As §3.8. `PATCH { active: true }` re-enables and resets the failure count. |
| POST | `/api/v1/webhooks/{id}/rotate-secret`, `…/test` | Test sends a `ping` event now and returns `{ deliveryId, httpStatus, durationMs, error }`. |
| GET | `/api/v1/webhooks/{id}/deliveries[/{deliveryId}]` | The detail adds `payload` and `attemptLog[]`. |
| POST | `/api/v1/webhooks/{id}/deliveries/{deliveryId}/redeliver` | `202`. One manual attempt with the same event id; `409 delivery_pending` while automatic retries continue. |
| GET/POST, PATCH/DELETE | `/api/v1/folders`, `/api/v1/folders/{id}` | `{ name, parentId? }`, at most 3 levels (`422 too_deep`). Delete moves contents up a level. |
| GET/POST, PATCH/DELETE, PUT | `/api/v1/org/teams[/{id}]`, `/api/v1/org/teams/{id}/members` | `{ name }`, `{ userIds }` (replaces). Admins manage; everyone can list. |
| GET, PUT/DELETE | `/api/v1/surveys/{id}/teams`, `/api/v1/surveys/{id}/teams/{teamId}` | `{ role: 'editor' \| 'viewer' }` (`survey.share`). |
| GET/POST, PATCH/DELETE | `/api/v1/surveys/{id}/comments`, `…/comments/{commentId}` | `{ body, anchorKey?, parentId? }`; `{ body?, resolved? }`. Replies join the thread's first comment. |
| GET | `/api/v1/approval-requests` | `?status&surveyId`. Only requests for surveys the caller can see. |
| POST | `/api/v1/approval-requests/{id}/approve` · `/reject` · `/cancel` | `{ note? }`. `403 self_approval`, `403 not_an_approver`, `409 not_pending`, `409 approval_stale`. |
| PATCH | `/api/v1/org` | Adds `approvalRequired` and `approverIds` (admins or creators). |
| GET, POST | `/api/v1/notifications`, `/api/v1/notifications/read` | `?unread&cursor` → `{ data, nextCursor, unread }`; `{ ids } \| { all: true }`. |
| GET/PUT | `/api/v1/notifications/preferences` | `{ channels: { [kind]: ('email' \| 'in_app')[] } }`. |
| GET/PUT | `/api/v1/surveys/{id}/notification-rules` | `{ rules: [{ kind, config: { questionKey?, count? }, channels }] }`. Unchanged rules keep their id. |
| GET, PUT, DELETE | `/api/v1/integrations`, `/api/v1/integrations/{slack\|hubspot\|google_sheets}` | Secrets are encrypted at rest and never returned. HubSpot and Google Sheets are stubs (saved, not synced). |
| POST | `/api/v1/integrations/slack/test` | Posts a test message. |
| GET | `/api/v1/audit-logs`, `/api/v1/audit-logs/export.csv` | `?action` (exact or a prefix such as `survey`) `&actorId&entityType&entityId&from&to&cursor`. Export: up to 50,000 rows, audited. |

Where the build differs from §3.8 is listed in [phase-3a-status.md](phase-3a-status.md).

## 3.13 Phase 3B additions (as built)

**Languages.** Translations are flat maps from a text key to a string, per language, stored with each version
(`survey_versions.translations`). Keys name a place, not a position: `survey.title`, `page.{key}.title`,
`{questionKey}.title`, `{questionKey}.help`, `{questionKey}.option.{optionKey}`, `{questionKey}.row.{rowKey}`,
`{questionKey}.{placeholder|lowLabel|highLabel|minLabel|maxLabel|unit|statement|linkLabel|patternMessage}`,
`{textBlockKey}.body`, `thankYou.title|body`, `disqualified.title|body`, and `ui.{next|back|submit|…}` for the
respondent app's buttons and messages.

| Method | Path | Notes |
|---|---|---|
| GET | `/api/v1/surveys/{id}/versions/{versionId}/translations` | → `{ versionId, versionNumber, status, defaultLocale, languages: [{ locale, dir, total, translated, missing, tokenMismatches }], strings: [{ key, source, context, long? }] }` (`survey.view`) |
| GET / PUT / DELETE | `…/translations/{locale}` | `PUT { strings }` replaces the language (unknown keys and blanks dropped) → `{ locale, dir, strings, missing[], tokenMismatches[] }`. Works on the draft **and** on published versions (text only; audited as `survey.translation_saved` with `published: true`). `422 default_locale`, `422 invalid_locale`, `409 too_many_languages` (30). |
| GET | `…/translations/{locale}/export.csv` | `key, context, source, translation`, UTF-8 with BOM, formula-protected cells. |
| POST | `…/translations/{locale}/import` | `{ csv }` (any column order; needs `key` and `translation`) → `{ imported, unknownKeys[], translation }`. Merges: empty cells keep what's there. |
| GET | `/api/v1/surveys/{id}/draft` | `validation.translations: [{ locale, missing, tokenMismatches }]`. |
| POST | `/api/v1/surveys/{id}/publish` | The result adds `translationWarnings` (same shape). Missing strings never block publishing. |
| GET | `/r/v1/s/{publicId}?lang=` | Serves the definition already translated. Language: `?lang=`, else the response's language when resuming, else `Accept-Language` (quality order; `pt-BR` also matches `pt`), else the default. Adds `language: { locale, dir, available[], ui }`. |
| PUT / POST | `/r/v1/s/{publicId}/response[/complete]` | Optional top-level `locale`: the respondent switched language; the end screen and consent wording follow it. |

**Login-required respondents (Q5).** `PATCH /surveys/{id} { access: { requireLogin } }`; refused on anonymous surveys
(`422 login_not_allowed_anonymous`, either way round).

| Method | Path | Notes |
|---|---|---|
| GET | `/r/v1/s/{publicId}` | Without a valid `X-Respondent-Token`: `access: { state: 'login_required', loginUrl }` (`{appUrl}/respond/{publicId}`) and no definition. With one: `respondent: { name, email }`. |
| POST | `/api/v1/respondent-handoff` | Cookie session. `{ publicId, lang? }` → `{ url, survey: { title, orgName } }`: the survey URL with `#rt=<token>` (signed, 2 minutes, single use). `403 not_a_member`. Any of the user's orgs works, not only the active one. |
| POST | `/r/v1/s/{publicId}/login` | `{ token }` → `{ respondentToken, responseKey, respondent }`. `401 invalid_login_token` when expired, reused, forged or for another survey. Send the token as `X-Respondent-Token` (12 hours) and use `responseKey`: it's derived from the survey and the member, so a member always continues the same response. Saving without a member answers `401 login_required`, another key `403 respondent_key_mismatch`, a second response `409 already_responded`. `resume-link` answers `403 not_available`. |

**AI summaries (Q10: OpenAI, opt-in per org).**

| Method | Path | Notes |
|---|---|---|
| PATCH | `/api/v1/org` | `{ ai: { enabled } }` (org admins). `422 ai_unavailable` when no provider is configured. `GET /org` adds `ai: { available, enabled, provider, model, monthlyTokenCap, tokensUsedThisMonth }`. |
| GET | `/api/v1/surveys/{id}/insights` | `responses.view` → `{ ai, insights[] }`: the latest summary per question. |
| POST | `/api/v1/surveys/{id}/insights` | `{ questionKey }` (short or long text) → `202 TextInsight` (`pending`), written by the worker. `403 ai_not_enabled`, `503 ai_unavailable`, `429 ai_token_cap_reached`, `422 not_a_text_question`. A summary already running for the question is returned instead of starting a second one. |
| GET | `/api/v1/surveys/{id}/insights/{insightId}` | `{ status, provider, model, generatedAt, responsesAnalysed, responsesTotal, summary, themes: [{ label, summary, sentiment, count, samples: [{ responseId, text }] }], sentiment, tokens, error: { code, message } }`. Samples come from answers that still exist. |

**Single sign-on.**

| Method | Path | Notes |
|---|---|---|
| GET | `/api/v1/org/sso` | Org admins → `{ enforced, canEnforce, connections[], domains[] }`. |
| POST / PATCH / DELETE | `/api/v1/org/sso/connections[/{id}]` | OIDC `{ protocol: 'oidc', name, issuer, clientId, clientSecret?, defaultRole, enabled }` (discovery is checked on save: `422 invalid_issuer`); SAML `{ protocol: 'saml', name, entryPoint, idpIssuer, idpCert?, defaultRole, enabled }` (`422 invalid_certificate`). Secrets are write-only and encrypted. Each connection lists what to enter at the identity provider (`serviceProvider`) and a `loginUrl` to test with. |
| POST / DELETE | `/api/v1/org/sso/domains[/{domain}]` | `{ domain }` → `{ domain, verified, txtRecord: { name: '_survey-verification.{domain}', value } }`. |
| POST | `/api/v1/org/sso/domains/{domain}/verify` | Looks up the TXT record. `422 not_verified`, `409 domain_taken` (another org verified it). |
| PATCH | `/api/v1/org` | `{ sso: { enforced } }`. `422 sso_not_ready` until a domain is verified and someone signed in through an enabled connection. Removing the last working connection or domain switches enforcement off (audited `sso.enforcement_relaxed`). |
| POST | `/api/v1/auth/sso/discover` | `{ email }` → `{ connections: [{ id, name, protocol, loginUrl }], enforced }` for the org that verified the domain. Says nothing about accounts. |
| GET | `/api/v1/auth/sso/{connectionId}/start?returnTo=/path` | `302` to the identity provider. Sets an `sso_bind` cookie (HttpOnly, Secure, SameSite=None, 10 minutes) that the callback must carry. |
| GET | `/api/v1/auth/sso/oidc/callback` | Code, PKCE and nonce checked. `302` to `returnTo` with a session, or to `/login?sso_error=…`. |
| POST | `/api/v1/auth/sso/saml/acs` | Form POST from the identity provider (`SAMLResponse`, `RelayState`); exempt from CSRF. Signed assertion, InResponseTo, audience, used once. |
| GET | `/api/v1/auth/sso/saml/{connectionId}/metadata` | SP metadata XML (the URL is also the SP entity ID). |
| POST | `/api/v1/auth/login`, `/signup`, `/password/reset`, `/invitations/{token}/accept` (new password) | `403 sso_required` (with `connections`) for enforced domains. `/password/forgot` still answers `202` but sends nothing. |

The routes differ from §3.2's draft (`/auth/sso/{orgSlug}/start` and one `/auth/sso/callback`): a connection id starts
a login, and each protocol has its own callback.

**Retention, usage, privacy and the super-admin console.**

| Method | Path | Notes |
|---|---|---|
| PATCH | `/api/v1/org` | `{ retention: { responsesDays: 1–3650 \| null } }`. `GET /org` adds `retention` and `sso`. |
| PATCH | `/api/v1/surveys/{id}` | `{ retentionDays: 1–3650 \| null }`; the detail adds `retentionDays` and `effectiveRetentionDays`. |
| GET | `/api/v1/org/usage?months=12` | Org admins → `{ months: [{ month, responses, surveysPublished, emailsSent, aiTokens }], totals, current: { members, surveys, responsesStored, storageBytes }, limits: { aiMonthlyTokenCap } }`. |
| GET / POST | `/api/v1/privacy/requests` | Org admins. `{ subjectEmail, kind: 'export' \| 'erase', confirmEmail? }` (erasure needs `confirmEmail`: `422 confirmation_mismatch`) → `202`. |
| GET | `/api/v1/privacy/requests/{id}[/download]` | `{ status, result: { contacts, campaignMessages, responses, files, aiSummaries?, anonymousSurveysNotSearched }, downloadUrl }`. The export is JSON, kept 7 days; downloads are audited. |
| GET | `/api/v1/admin/overview?q&status` | Super admins → `{ orgs: [{ id, name, slug, plan, status, members, surveys, aiEnabled, aiMonthlyTokenCap, aiCapOverridden, thisMonth }], totals }`. |
| GET | `/api/v1/admin/orgs/{id}/usage` | Super admins: the same report as `/org/usage`. |
| PATCH | `/api/v1/admin/orgs/{id}` | Super admins. `{ status: 'active' \| 'suspended', plan, aiMonthlyTokenCap: number \| null, reason }`. Recorded in the org's own audit log. A suspended org's members lose access, its API keys stop and its links answer 404. |

Where the build differs from the design is listed in [phase-3b-status.md](phase-3b-status.md).
