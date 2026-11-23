# Phase 1 status against the acceptance criteria

Checked on 2026-11-23 on Windows 11, Node 24, Docker Desktop. Legend: ✅ verified, with the evidence named ·
⚠️ built, but part of the criterion wasn't verified (says what's missing) · ❌ not done.

**Summary:** 39 ✅, 8 ⚠️, 1 ❌. The open items are mostly checks a person or another environment has to do:
a screen-reader pass, other browsers and operating systems, opening the CSV in Excel, scanning the QR code with a
phone, and the first CI run.

## Foundation
| Criterion | Status | Evidence |
|---|---|---|
| Clean-machine setup from the README brings up the stack | ⚠️ | Done on Windows (this machine). Not yet run on macOS or Linux. |
| `pnpm verify` and `pnpm test:e2e` pass | ✅ | Lint, typecheck (6 packages), 84 unit + 190 integration tests, bundle budget; 5 Playwright tests |

## Authentication and organization
| Criterion | Status | Evidence |
|---|---|---|
| Signup creates org + `org_admin`; verification email arrives | ✅ | `auth.test.ts`; Mailpit received the worker's emails in dev |
| Cookie `HttpOnly`, `SameSite=Lax`, `Secure` outside local; no CSRF token → 403 | ✅ | `auth.test.ts`; config refuses to start in production with `COOKIE_SECURE=false` |
| Login throttled per account; errors don't reveal accounts | ✅ | `auth.test.ts` (11th attempt → 429; identical messages) |
| Reset token single-use, 1 h expiry, revokes other sessions | ✅ | `auth.test.ts` (single use, revocation); expiry set in the email job |
| Invitations: new or existing user, 7-day expiry, revocable | ✅ | `auth.test.ts` |
| Role changes; last admin protected | ✅ | `auth.test.ts` |
| Org switching keeps data separate | ✅ | `auth.test.ts`, plus `409 org_mismatch` for stale tabs |

## Authorization and tenant isolation
| Criterion | Status | Evidence |
|---|---|---|
| Table-driven test of every capability × role | ✅ | `permissions.test.ts`: 78 matrix cases + unit cases |
| Creator/analyst/viewer limits | ✅ | `permissions.test.ts` |
| Org A gets 404 for every org B ID; lists never leak | ✅ | `tenancy.test.ts`: 22 endpoints |
| RLS enabled and forced on every `org_id` table | ✅ | `tenancy.test.ts` (enumerates `information_schema`; app role has no `BYPASSRLS`) |
| Super admin without membership has no access | ✅ | `tenancy.test.ts` |

## Builder
| Criterion | Status | Evidence |
|---|---|---|
| Pages, all 11 element types, edit, reorder questions and pages (mouse and keyboard), move between pages, duplicate, delete | ✅ | Checked in the browser. Mouse: drag handles (dnd-kit). Keyboard: Move up/down buttons (cross page boundaries), "Move to page", page ↑/↓. Keyboard *dragging* was dropped because it was unreliable with expanded cards ([risks R1](05-risks.md)). |
| Settings behave identically in preview and live survey | ✅ | The preview *is* the respondent app in an iframe; stable randomization unit-tested |
| Preview updates within 1 s; desktop / 390 px | ✅ | 150 ms debounce; `journey.spec.ts` checks the preview shows a new question |
| Edits survive reload; two tabs → conflict prompt | ⚠️ | Autosave + `409 revision_conflict` tested in `surveys.test.ts`. The conflict banner's two buttons aren't exercised by an automated UI test. |
| Validation panel; publish blocked on errors | ✅ | Problems dialog; publish button disabled; server `422 publish_blocked` tested |

## Publishing and versioning
| Criterion | Status | Evidence |
|---|---|---|
| Publish → v1, public link, `live` | ✅ | `surveys.test.ts`, `journey.spec.ts` |
| Editing live creates a draft; link keeps v1 until v2 | ✅ | `surveys.test.ts` |
| Respondent who started on v1 finishes on v1 | ✅ | `surveys.test.ts` |
| SQL `UPDATE` of a published definition rejected | ✅ | `surveys.test.ts` (database trigger) |
| Results merge versions; removed question keeps counts | ✅ | `surveys.test.ts` |

## Distribution and access
| Criterion | Status | Evidence |
|---|---|---|
| Named links with presets; declared hidden fields captured; undeclared ignored | ✅ | `respondent.test.ts` |
| QR code as SVG/PNG that scans | ⚠️ | Generated and downloadable (checked in the browser); not yet scanned with a phone |
| Close date / manual close / quota stop new respondents; in-progress can finish | ✅ | `respondent.test.ts`, `surveys.test.ts` |
| One response per browser (best effort) | ⚠️ | Implemented in the respondent app; no automated test |

## Respondent experience
| Criterion | Status | Evidence |
|---|---|---|
| Current Chrome, Firefox, Safari, Edge; iOS Safari and Android Chrome at 360 px | ⚠️ | Tested in Chromium (desktop + Pixel 7 emulation). Firefox, Safari, Edge and real iOS/Android not yet tested. |
| Errors linked, announced, focus to first error | ✅ | Checked in the browser (`aria-describedby`, live region, focus); `a11y.spec.ts` |
| axe: zero serious/critical violations for every type | ✅ | `a11y.spec.ts` (all 10 types, plus error state); found and fixed unlabelled Likert radios |
| Manual NVDA or VoiceOver pass recorded | ❌ | Needs a person with a screen reader. Checklist ready in [a11y-p1.md](a11y-p1.md). |
| Resume after closing the tab | ✅ | `resilience.spec.ts` |
| Network cut while submitting → retried, exactly one response | ✅ | `resilience.spec.ts` (browser offline), `respondent.test.ts` (replays) |
| Server rejects missing required answers | ✅ | `respondent.test.ts` |
| Honeypot not stored; > 20 new responses/min/IP → 429 | ✅ | `respondent.test.ts` |
| Anonymous: no identifiers, hour precision, email question blocked | ✅ | `respondent.test.ts`, `surveys.test.ts`, database trigger |
| LCP < 2 s on slow 4G, JS ≤ 100 KB, enforced in CI | ⚠️ | LCP **1,508 ms** ([report](../perf/lighthouse-respondent.md)); JS **76 KB** gz, checked by `pnpm verify`. Both are in the CI workflow, which hasn't run yet (no remote). |

## Results and export
| Criterion | Status | Evidence |
|---|---|---|
| KPIs and drop-off; new completion visible within 15 s | ✅ | Totals are live; dashboard polls every 15 s; `journey.spec.ts` |
| A visualization per type | ✅ | Checked in the browser. Choices use bars or a **share bar** instead of a pie (data-viz guidance); [roadmap](04-roadmap.md) updated. |
| Date range, version, partial, test filters | ✅ | `results.test.ts` |
| Response list, detail, delete updates counts | ✅ | Immediately, not within a minute (`results.test.ts`) |
| CSV opens in Excel and Google Sheets; layouts; formula injection; audited | ⚠️ | BOM, quoting, Unicode, both layouts, formula injection and audit all tested. Not yet opened in Excel or Sheets by hand. |
| 50 k responses: unfiltered < 1 s, filtered < 5 s (p95) | ✅ | **72 ms** and **214 ms**, 336 ms incl. partials ([report](../perf/results-summary.md)) |

## Operations
| Criterion | Status | Evidence |
|---|---|---|
| JSON logs with request ID; no answers, emails or tokens in logs | ✅ | `ops.test.ts` |
| `/healthz`, `/readyz`; Sentry when `SENTRY_DSN` is set | ⚠️ | Health checks tested. Sentry is wired in but not tested against a real DSN. |
| Audit rows for the listed actions | ✅ | `surveys.test.ts`, `results.test.ts`, `ops.test.ts` |
| Seed data with one user per role and sample surveys | ✅ | `pnpm db:seed` (credentials in the README, development only) |
