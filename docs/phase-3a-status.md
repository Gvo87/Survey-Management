# Phase 3A status against the acceptance criteria

Checked on 2026-11-23 on Windows 11, Node 24, Docker Desktop. Legend: ✅ verified, with the evidence named ·
⚠️ built, but part of the criterion wasn't verified (says what's missing) · ❌ not done.

Phase 3 is split in two ([roadmap §4.5–4.6](04-roadmap.md#45-phase-3a-collaboration-and-platform-api)). 3A
needs none of the open questions. Q5 (login-required respondents) and Q10 (AI provider) only affect 3B.

**Summary:** 9 ✅, 0 ⚠️, 0 ❌. What isn't covered by automated tests: the DNS branch of the SSRF guard (tests use IP
literals and IPv4-mapped IPv6, not a host name that resolves to a private address), and drag-to-move (checked in the
browser; the e2e test uses the keyboard-accessible folder menu instead). A manual screen-reader pass of the new
screens hasn't been done.

**Test totals:** 139 unit, 255 integration (15 of them Phase 3A), 18 Playwright (3 of them Phase 3A, including axe
checks of every new screen). Lint and typecheck clean. Respondent bundle unchanged at 84.2 KB gz initial (89.0 KB with
lazy chunks; budget 100 KB): Phase 3A adds nothing to it.

| Criterion | Status | Evidence |
|---|---|---|
| Folders (3 levels), drag-to-move, and teams usable in survey sharing | ✅ | `phase3a.test.ts`: three levels allowed, a fourth refused (`422 too_deep`), including when moving a subtree; moving into its own subtree refused; names unique per parent (case-insensitive); `GET /surveys?folderId=` and `folderId=none`; per-folder counts only include surveys the caller can see; analysts can't change folders; deleting a folder moves its surveys and subfolders up. Teams: a creator in a team shared as editor can edit, an analyst in the same team stays a viewer, non-members get 404, removing the share removes access. E2E creates a folder and moves a survey with the row's folder menu. Drag-to-move checked in the browser with real pointer events. |
| Comments can be anchored to a question, threaded and resolved; not visible to respondents | ✅ | Test: a viewer comments on a question, replies (including a reply to a reply) join the first comment's thread and inherit its anchor, unknown anchors are refused, only the author edits, the author or an editor resolves (another viewer gets 403), the respondent payload doesn't contain the comment text, other orgs get 404. E2E comments on a question in the Comments tab and resolves it. |
| With approvals on, publishing creates a request; only an org admin or designated approver approves; approval publishes exactly the reviewed revision; a later edit invalidates it | ✅ | Test: publish answers `202` with a pending request for the draft's revision; the requester can't approve (`403 self_approval`); a designated approver who can't see the survey gets 404, then approves once it's shared; the survey goes live as version 1 with the author as publisher; approvers get a notification; an edit after asking marks the request `superseded` and approving it is refused (`409 not_pending`); reject keeps the draft; analysts can't be approvers; every step is in the audit log. E2E: the admin approves a creator's request from the Approvals page and the creator is notified. |
| Audit-log viewer filters by actor, action, entity and date, exports CSV; rows can't be modified by the app's role | ✅ | Test: filters by actor, action (exact or a prefix such as `survey`), entity id and date range, cursor pagination; CSV export with header and rows, itself audited; non-admins get 403. As `survey_app`, `UPDATE` and `DELETE` on `audit_logs` fail with `42501 permission denied`. Actions by API keys name the key. |
| Notification rules fire once per event and respect each user's channel preferences | ✅ | Test: new-response, NPS-detractor (score ≤ 6), threshold (fires once, at 2 responses, not again at 3) and closing rules; recipients are everyone the survey is shared with; a user who turned off email for new responses gets them in the app only; the same event dispatched twice (a retried job) notifies nobody twice, and posts to Slack once; saving unchanged rules keeps their ids, so a threshold can't fire again. Emails are sent inside the transaction that marks them sent. |
| API keys shown once, stored hashed, scoped, revocable; out-of-scope calls 403; the OpenAPI document validates; a generated client passes a smoke test | ✅ | Test: the key is only in the create response; the database has a SHA-256 hash and a 12-character prefix; out-of-scope calls answer `403 insufficient_scope` with `requiredScope`, non-public routes `403 not_available_with_api_key`; revoked, expired and "creator no longer an admin" keys answer 401; cross-tenant reads 404; per-key rate limit with `RateLimit-*` headers and 429. `/api/v1/openapi.json` passes `@seriousme/openapi-schema-validator` (OpenAPI 3.1), and every listed route is registered. A client generated from the document at test time (one method per `operationId`, with path, query, body and bearer auth) creates, saves, publishes and reads a survey and lists responses. E2E creates a key in the settings page and calls the API with it. |
| Replaying a POST with the same `Idempotency-Key` returns the original result without a duplicate | ✅ | Test: the second request returns the same survey with `Idempotent-Replayed: true` and the database has one row; a different body with the same key is refused (`422`); the same value from another caller is a separate request. |
| Webhooks signed (sample verifier passes), retried on schedule, viewable with every attempt, redeliverable, auto-disabled, blocked from private ranges | ✅ | Test: deliveries to a real HTTP receiver verify with [`docs/examples/verify-webhook.mjs`](examples/verify-webhook.mjs) (and fail with a wrong secret or a changed body); retries are scheduled after 60, 300, 1800, 7200, 21600, 43200 and 86400 seconds (±2 s), then the delivery fails after 8 attempts, all listed with the same event id; redelivery is one manual attempt; `ping` test; rotation signs with both secrets for 24 hours; 50 failed events in a row disable the endpoint and notify admins, nothing is sent while disabled, re-enabling resets the count; dispatching an event twice creates one delivery; a survey filter is respected; anonymous payloads carry hour-precision times and nothing identifying. SSRF: loopback, private, link-local (metadata), IPv6 loopback, credentials in URLs and non-HTTP schemes refused when saving; IPv4-mapped IPv6 refused when sending. E2E checks a signed `ping` from the settings page. |
| Slack notifier posts new-response and detractor alerts; HubSpot and Google Sheets have interfaces, configuration UI and contract tests against mocks | ✅ | Test: Slack receives each new response, the detractor and the close, once each; a test message from the integrations page; the token-bearing config is encrypted at rest; in production only `https://hooks.slack.com/` URLs are accepted. HubSpot (contact upsert by the respondent's email) and Google Sheets (append a row, RAW input so nothing is evaluated as a formula) send the documented requests to a mock server, send nothing without an email answer, and surface errors. Both have configuration cards marked "Preview". |

## Where the build differs from the design

- **Webhook secrets are encrypted, not hashed.** Signing needs the secret, so it is stored with AES-256-GCM under
  `DATA_ENCRYPTION_KEY` (required in production; elsewhere derived from `SESSION_SECRET`). The same key encrypts
  integration tokens. Changing it makes stored secrets unreadable.
- **Every attempt is a row** (`webhook_attempts`), next to `webhook_deliveries`. A redelivery is one manual attempt
  with the same event id. It doesn't start a new retry schedule or count toward auto-disable.
- **Events go through one queue.** Publish, close (by hand, by date, by quota) and response completion queue an
  `events.dispatch` job in the same transaction. The worker fans it out to webhooks and notification rules. Both
  are keyed by the event id, so a retried job adds nothing.
- **API keys act as an org admin, limited to their scopes**, on an explicit list of routes. A key stops working when
  the admin who created it stops being an admin. Keys can't manage keys, members or settings.
- **`Idempotency-Key` works on any authenticated POST**, not only API-key calls. A multipart upload (CSV import) is
  matched on its URL only, because the body is read later.
- **Approvals:** nobody approves their own request, so an org with a single admin and no other approver can't
  publish while approvals are on. Designated approvers must be creators (or admins), and they review surveys shared
  with them. Admins see all of them.
- **"Closing" notifications fire when a survey closes** (by hand, by date or by quota), not ahead of the close date.
- **Notifications go to the people a survey is shared with** (directly or through a team), not to every admin.
  System notices (approval requests and decisions, a disabled webhook) ignore preferences.
- **Folders are org-wide.** Everyone sees folder names; counts only include surveys the caller can see. Moving a
  survey needs edit access to it.
- **Teams share as editor or viewer only.** A survey's owner is still one person.
- **The OpenAPI document describes requests precisely, responses loosely** (`type: object`), because response types
  are TypeScript interfaces rather than Zod schemas. Webhook payloads are described under `webhooks`.
- **HubSpot and Google Sheets are saved, not synced.** There's no OAuth app behind them yet; an admin pastes a token.
- **Housekeeping:** a daily `platform.cleanup` job deletes idempotency records after 24 hours and finished webhook
  deliveries (which can contain answers) after 30 days.
- **Upgrading:** run `pnpm db:migrate` (migration `0004_phase3a.sql` and four new queues) before starting the API and
  worker.
