# Phase 2A status against the acceptance criteria

Checked on 2026-11-23 on Windows 11, Node 24, Docker Desktop. Legend: ✅ verified, with the evidence named ·
⚠️ built, but part of the criterion wasn't verified (says what's missing) · ❌ not done.

**Summary:** 8 ✅, 4 ⚠️, 0 ❌. The open items: a manual screen-reader pass of the new question types, contact
fields for piping (contacts arrive in Phase 2B), the real Turnstile widget (only the API tests, with a fake
verifier, cover CAPTCHA), and driving the logic vectors through the builder preview iframe itself.

**Test totals:** 139 unit (`survey-core`), 221 integration (API, 31 of them Phase 2A), 11 Playwright (6 Phase 2A).
Lint and typecheck clean. Respondent bundle 83.1 KB gz initial (87.4 KB including lazy chunks; budget 100 KB).
Analytics on 50k responses still p95 59 / 190 / 301 ms (`perf/results-summary.md`).

| Criterion | Status | Evidence |
|---|---|---|
| Logic: show/hide questions and pages, skip-to, end, disqualify, AND/OR/NOT to 3 levels; identical in preview, respondent app and server, checked by shared vectors | ⚠️ | `packages/survey-core/test-vectors/logic.json` (7 cases) runs in Node (`logic.test.ts`), through the API completion endpoint (`apps/api/test/phase2a.test.ts`) and in Chromium (`e2e/tests/phase2a.spec.ts`, the engine loaded from the respondent dev server). The respondent UI is driven through screen-out, page skip, conditional question and a NOT/OR rule on a hidden field. The builder preview uses the same `Runner` and `checkCompletion`, but no test drives the vectors through the preview iframe itself. |
| Validator rejects backward jumps, forward references, operator/type mismatches, dangling keys, with precise messages | ✅ | `validate.ts` codes `backward_jump`, `forward_reference`, `operator_type_mismatch`, `dangling_reference`, `missing_value`, `condition_too_deep`; covered in `logic.test.ts`. Publish refuses them (`422 publish_blocked`). |
| Answers to hidden questions are discarded on completion and never reach results or exports | ✅ | API vector test compares the stored answer keys with each vector's `answeredKeys` (e.g. "good speed hides 'why' and drops its answer"). Results and CSV read stored cells only. |
| Piping: earlier answers, URL params, contact fields, with fallback; always text (XSS test) | ⚠️ | `{{q.…}}`, `{{param.…}}` and fallbacks work in titles, help, text blocks, page titles and end screens (`piping.ts`, API end-screen test, e2e). The XSS e2e test pipes `<img onerror>` into a question title and the thank-you page: rendered as text, no element created, no script ran. `{{contact.…}}` is parsed and falls back, but there are no contact values until Phase 2B contacts. |
| Matrix (single and multi per row), ranking, slider, phone (E.164), date-time and consent are keyboard and screen-reader operable; matrix stacks below 600 px | ⚠️ | Native inputs only (radios, checkboxes, selects, range, `tel`, `time`, `datetime-local`); named groups per matrix row. axe: no serious or critical violations (e2e, including the error state). Keyboard: slider by arrow keys, ranking by selects, matrix by radio groups (e2e). At 375 px the matrix shows one block per row with visible labels and no horizontal scroll (e2e and a manual check). **Not done:** a manual NVDA/VoiceOver pass like `a11y-p1.md`. |
| File upload: size and type enforced server-side; scanned before download; infected files quarantined and flagged | ✅ | Type is detected from the bytes (a `.png` that is really an `.exe` is refused), size limit per question (413), max files per question (API tests). Downloads return `409 scan_pending` until clean; EICAR is quarantined (moved to `quarantine/`, `403 file_quarantined`), the response gets the `malware` flag and an audit entry (API test with the fake scanner). The real ClamAV scanner was checked against the `clamav` container: clean text, EICAR, and a 3 MB stream. Anonymous surveys refuse uploads (API and a database trigger). |
| A theme applies to the live survey without republishing; AA contrast below threshold is blocked in the editor | ✅ | Org default and per-survey theme apply to a published survey immediately (API test, e2e checks the CSS variables, browser check). The theme editor shows each contrast ratio and disables Save below AA (checked in the browser); the API rejects it too (`422 contrast_too_low`, API and e2e tests). |
| Custom thank-you page and redirect URL with appended hidden fields | ✅ | API test: piped title/body, `redirectUrl` with `?src=panel` appended; non-http redirects refused at publish. The respondent app redirects straight away and keeps a "Continue" link. |
| Template, save-as-template and question bank produce fresh keys | ✅ | API tests: every page, question and option key differs from the template's (twice in a row), logic and piping references are remapped; org templates are hidden from the survey list and can't be published; other orgs can't use them. Bank items get fresh keys on save and again on every insert (`bankQuestion`). |
| A password-protected survey can't be read without unlocking; an open date shows "not yet open" | ✅ | API tests: no definition before unlocking, saves refused (401), wrong password 401, rate limit 429 after 10 attempts, tokens die when the password changes; `not_yet_open` page and 403 on save. Checked in the browser (password gate). |
| CAPTCHA: submissions without a valid token are rejected; quality flags visible and filterable | ⚠️ | API tests with the fake verifier: no token or a bad token → 403 `captcha_failed`, a good token starts the response, later saves don't need one. Flags `too_fast` and `straight_lined` computed on completion, shown as badges, filterable in responses, excluded from results and CSV on request (API tests). **Not verified:** the real Cloudflare widget in a browser (needs Cloudflare's servers). |
| Respondent bundle still meets the Phase 1 budget; new widgets are code-split | ✅ | `pnpm --filter @survey/respondent size`: 83.1 KB gz initial; the six new widgets load as a 3.2 KB chunk only when a survey uses them, the builder preview as a 1.1 KB chunk. |

## Where the build differs from the design

- **Local S3 is SeaweedFS, not MinIO.** MinIO's images couldn't be pulled here; SeaweedFS speaks the same S3 API.
  Production uses any S3-compatible store through the same `S3_*` settings.
- **Uploads pass through the API** instead of going straight to S3 with presigned URLs, so the real file type and
  size are checked before anything is stored. Trade-off and limits in [03 §3.10](03-api-design.md).
- **Quarantined files are kept until the response is submitted.** At completion, uploads the final answer doesn't
  reference (removed files, files on skipped questions, and quarantined files) are deleted with their objects. The
  `malware` flag and the audit entry stay.
- **Turnstile is checked once per response**, on its first save, not on every request. Later saves are tied to the
  secret response key.
- **Themes aren't versioned.** Editing a theme restyles live surveys immediately (the roadmap asks for this).
- **The respondent app receives link presets for hidden fields** (`presetHiddenFields`), so logic that uses hidden
  fields evaluates the same in the browser as on the server.
- **Consent answers record a hash of the statement** that was agreed to, so a later change to the wording is
  detectable per response.
