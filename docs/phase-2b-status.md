# Phase 2B status against the acceptance criteria

Checked on 2026-11-23 on Windows 11, Node 24, Docker Desktop. Legend: ✅ verified, with the evidence named ·
⚠️ built, but part of the criterion wasn't verified (says what's missing) · ❌ not done.

**Summary:** 10 ✅, 3 ⚠️, 0 ❌. The open items: SES itself (bounces are tested with signed SNS messages, not a
real AWS account), a scheduled report observed at its real time (tested by moving the due time), and a manual
screen-reader pass of the new admin screens.

**Test totals:** 139 unit, 240 integration (19 of them Phase 2B), 15 Playwright (4 of them Phase 2B). Lint and
typecheck clean. Respondent bundle 84.2 KB gz initial (89.0 KB with lazy chunks; budget 100 KB); `embed.js`
2.2 KB gz. Performance on 50k responses in `perf/results-summary.md`.

| Criterion | Status | Evidence |
|---|---|---|
| A 50k-row CSV import finishes in under 2 minutes with a downloadable error report; duplicates by email are merged | ✅ | `phase2b.test.ts`: 50,000 rows in 6.9 s; a mixed file shows the merge rules (duplicates in the file and with existing contacts, later non-empty values win, unsubscribes kept), invalid and missing emails with line numbers, and the error-report CSV. The uploaded file is deleted after the import. |
| A scheduled campaign sends at the set time in the creator's time zone; each recipient gets a unique link; reminders go only to non-responders and stop at the maximum | ✅ | Scheduling 09:00 America/New_York stores 13:00 UTC; nothing is sent early; cancelling makes the queued job a no-op. Links are unique per recipient. Reminders: none before the delay, only the non-responder, exactly `max` times (test moves the clock back three times). Sent end to end through Mailpit in the browser and in `phase2b.spec.ts`. Time-zone maths (including DST) checked separately. |
| Unsubscribe works without login; unsubscribed or bounced contacts are never emailed again | ✅ | Unsubscribe page and RFC 8058 one-click `POST` (form body, `List-Unsubscribe` headers); queued invitations for that contact are dropped and reminders skip them. A permanent bounce or complaint suppresses the address for every org (`email_suppressions`), and a later campaign to it sends nothing. |
| A recipient token works for one response only; a second visit shows "already responded" or resumes an incomplete response | ✅ | Non-anonymous: the token is the response key, so the same link resumes on any device; a second key with the same token is refused (`409 already_responded`); a unique index allows one response per recipient. E2E: the link answered once shows "already responded" in a fresh browser. |
| Anonymous surveys: campaign tracking marks recipients responded without linking the response (verified in the database) | ✅ | Test checks `responses.recipient_id` stays null, the recipient is `responded` with an hour-rounded time, no contact fields reach the respondent page, and the database trigger refuses a link even when inserted directly. A second response with the same token is refused. |
| The embed works inline and as a popup on a page with a strict CSP; host CSS doesn't leak in | ✅ | `phase2b.spec.ts` serves a page with `default-src 'none'; script-src <survey>; frame-src <survey>; style-src 'self'` and an aggressive stylesheet: no CSP violations, the inline frame renders unaffected and resizes to its content, the popup is a modal dialog (focus moves in, Escape closes, focus returns), and a response completes inside the frame. |
| Filters (answer, hidden field, date, status, version, tag, device) and up to 4 side-by-side segments; < 5 s on the 50k seed | ✅ | Filter grammar = the logic grammar plus response fields, compiled to parameterised SQL (`lib/result-filter.ts`); tests cover answer, NOT, hidden field (case-insensitive), status and tag filters and two segments; anonymous surveys hide groups under 5. 50k seed: answer filter p95 394 ms, 4 segments p95 875 ms. Version, device and date filters use the same compiler (not each separately tested). |
| Cross-tab of two choice-like questions with counts, row and column percentages and chi-square | ✅ | 2×2 fixture with known answer: counts, row % and chi-square 7.2, df 1, p 0.0073 (textbook values); multi-select pairs show counts with a note instead of a test; > 20% small expected counts are flagged. Checked in the browser against the seed. |
| Drop-off by question, word cloud, matrix heatmap and ranking charts render correctly against fixture data | ⚠️ | Drop-off per question (answered / left after) and word counts (stop words removed) match fixture data exactly in `phase2b.test.ts`; the matrix heatmap and ranking charts were done in 2A (`phase2a.test.ts`). The word cloud and drop-off UI were checked in the browser, but there's no automated visual test of the rendered charts. |
| The dashboard updates within 3 s of a completion via SSE, and falls back to polling | ✅ | Integration test over real HTTP: the `update` event arrives < 3 s after completion (the completion queue polls every 0.5 s). E2E: the Completed tile changes without a reload within 6 s. The page polls every 15 s when the stream isn't connected. |
| Response search finds text in open answers; tags and notes work; bulk delete by filter is audited and repairs aggregates | ✅ | Full-text search (GIN index, same expression in the query); tags assigned, filterable in the list and in results; analysts can tag and annotate but not delete tags; admins can remove anyone's note. Bulk delete refuses a stale count (`409 selection_changed`), deletes exactly the selection, writes `responses.bulk_deleted` with the selection, and the summary's pre-aggregated counts are rebuilt. |
| XLSX matches the CSV; the PDF has a chart per question plus KPIs; a 50k XLSX export completes in < 2 minutes | ⚠️ | XLSX and CSV come from the same row generator; the test compares every cell (including the formula-injection prefix). PDF: KPIs plus a chart or summary per question, drawn with pdfkit. 50k seed: XLSX of 43,931 responses in 8.3 s. **Not verified:** a person reviewing the PDF's look; the standard PDF fonts can't draw non-Latin text (shown as "?", see below). |
| Scheduled reports arrive on schedule with the chosen format and filters | ⚠️ | Recipients must be org members who can see the responses (re-checked every run); a due report is emailed once (the run is claimed before sending), with the file attached when under 8 MB, and the next run is computed in the report's time zone. Tested by moving `next_run_at` into the past; **not** observed firing at a real wall-clock time. |

## Where the build differs from the design

- **Recipient tokens aren't stored.** Each personal link token is an HMAC of the recipient id; only its SHA-256 is
  in the database, and reminders re-derive the same link. Rotating `SESSION_SECRET` therefore invalidates links
  already emailed.
- **Non-anonymous campaign responses use the token as the response key**, which is what lets the same link resume
  on another device. Anonymous surveys keep a random key per browser, so they resume only on the same device.
- **SES bounces arrive through an SNS HTTPS subscription** (`POST /api/v1/webhooks/ses`) with signature
  verification, a topic allow-list (`SES_SNS_TOPIC_ARNS`) and certificate URLs restricted to `sns.*.amazonaws.com`.
  The route is the only one besides one-click unsubscribe that accepts a non-JSON body.
- **Tags, notes and bulk delete live under the survey** (`/api/v1/surveys/{id}/responses/...`) rather than
  `/api/v1/responses/{id}`, so every call checks the survey permission the same way. Bulk delete runs in the
  request (not as a job) because rebuilding aggregates for 50k responses takes about a second.
- **Exports are downloaded through the API** (permission re-checked, audited) rather than from a signed S3 URL,
  matching how uploads work since 2A. Files expire after 7 days.
- **Scheduled reports use daily / weekly / monthly at an hour** instead of free-form cron, so the time zone and
  "next run" are always clear. Reports only go to org members who can see the survey's responses.
- **PDF reports are drawn with pdfkit**, not a headless browser (risk E4). The built-in fonts cover Western
  European text only; other characters print as "?". CSV and XLSX keep every character.
- **Anonymous surveys hide filtered groups smaller than 5** (`ANONYMOUS_MIN_GROUP_SIZE`), as data model §2.7
  proposed, including segments and cross-tabs.
- **Contacts are limited to org admins and creators** (`contacts.manage`); analysts never see personal contact data.
