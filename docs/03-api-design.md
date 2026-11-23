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
| POST | `/r/v1/s/{publicId}/uploads` | P2 | `{ questionKey, filename, mime, size }` → `{ fileId, uploadUrl, fields }` (S3 presigned POST, size and type enforced) |
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
