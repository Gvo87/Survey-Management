# 5. Risks, Conflicts and Expensive Items

The brief asked me to flag anything that conflicts, is risky, or would be expensive to build. Each item below has a
recommendation. Items marked **decision** are also listed as open questions in the [README](README.md#open-questions).

## 5.1 Conflicts in the requirements

| # | Conflict | Recommendation |
|---|---|---|
| C1 | **Anonymous mode vs. identity features.** "Genuinely stores no identifying data" clashes with one-response-per-person via token or login, personalised email links, reminders to non-responders, device and location tracking, identifying hidden fields (`customer_id`), and per-respondent GDPR export/erasure. | Anonymous mode turns these off or decouples them, enforced in the server and database ([data model §2.7](02-data-model.md#27-anonymous-mode)). Campaigns still stop reminders by marking the *recipient* as responded without linking the response. Login-based limits aren't available in anonymous mode. Subject-access requests can't find anonymous answers, which is correct by design and should be stated in the privacy notice. |
| C2 | **"Queue + retry" vs. "never lost".** A Redis queue in front of the database would be a *weaker* durability point than Postgres. | Postgres commit is the durability point. The client keeps a local retry queue. Side effects are jobs enqueued in the same transaction. Remaining gap: during a full database outage, answers wait in the respondent's browser. If that isn't acceptable, add an SQS ingest buffer (expensive, see E6). |
| C3 | **Approval before publish vs. "editing a live survey creates a new version".** With approvals on, every typo fix on a live survey needs approval. **Decision.** | Recommended: no exemptions, but make approval fast (one click from the notification, diff view of what changed). Alternative: let org admins self-approve. |
| C4 | **Quotas and close dates vs. respondents in progress.** Cutting someone off at the last page is hostile, but letting them finish overruns the quota slightly. **Decision (Q7).** | Default: block *new* starts, let in-progress respondents finish within 24 h. A "strict" toggle can come later if needed. |
| C5 | **Cookie-based "one response per person"**, especially in embeds. Browsers partition or block third-party storage, and clearing storage bypasses it. | Label it "best-effort, one per browser". Use recipient tokens (P2) or login (P3) where it matters. |
| C6 | **"Optional location" vs. privacy.** Browser geolocation triggers a permission prompt that hurts completion rates. Storing IPs undermines anonymity. | Country only, derived from GeoIP at ingest. The IP is discarded and country is never collected in anonymous mode. No browser geolocation. |
| C7 | **CAPTCHA vs. anonymity.** Any third-party CAPTCHA sees the respondent's IP. | Off by default. Cloudflare Turnstile (privacy-friendlier, mostly invisible) when enabled. Disclosed in the respondent privacy notice. Auto-enabled only when abuse thresholds trip. |
| C8 | **Immutable versions vs. translations.** Adding a language to a live survey shouldn't force a new version. | Translations can be edited on published versions (they can't change structure or keys). The edits are audit-logged. |
| C9 | **Super Admin manages "billing", but no billing requirements are given.** **Decision (Q6).** | `plan` field and plan limits only. A Stripe integration is a separate project. |

## 5.2 Risks

| # | Risk | Mitigation |
|---|---|---|
| R1 | **Accessibility (WCAG 2.1 AA)** of the drag-and-drop builder and custom widgets (ranking, matrix, slider). These are where accessibility usually fails. | Use dnd-kit keyboard sensors plus a "Move to…" menu as an alternative to dragging. Ranking also works through up/down buttons. Matrix becomes stacked questions on mobile. Automated axe checks plus a manual screen-reader pass each phase. |
| R2 | **Logic engine diverging** between preview, respondent app and server, so a respondent passes the client but fails the server, or the reverse. | One `survey-core` package used everywhere. A shared JSON test-vector suite runs against browser and Node builds. Property-based tests. |
| R3 | **SSRF** through webhook and integration URLs. | Resolve DNS at send time and block private, link-local and metadata ranges. No redirects followed. HTTPS only. |
| R4 | **Email deliverability:** one org sending spam damages the shared domain's reputation for everyone. | Suppression lists for bounces and complaints, per-org send limits, opt-out handling, warm-up. Custom per-org sending domains (SPF/DKIM) are a later, paid feature. |
| R5 | **File uploads:** malware, storage cost, personal data, and they break anonymity. | Presigned S3 uploads with server-enforced size and type limits. Malware scanning (ClamAV in the worker, or GuardDuty Malware Protection for S3) before files can be downloaded. Not allowed in anonymous surveys. Included in retention purges. |
| R6 | **AI summaries:** respondent text goes to a third party, invented themes, uncontrolled cost. | Opt-in per org, behind a data processing agreement. Emails and phone numbers redacted before sending. Each theme links to supporting responses. Labelled AI-generated. Per-org token caps. Respondent text is treated as untrusted data (summaries only, never actions). |
| R7 | **Data growth** in `answers` (estimated 30–100 M rows/month at the upper end). | The primary key is partition-ready. Switch on hash partitioning by `survey_id` before about 200 M rows. Retention policies (P3). |
| R8 | **RLS misconfiguration:** a new table shipped without a policy. | Migration helper adds the policy. A test fails if any `org_id` table lacks RLS. The app's database role has no `BYPASSRLS`. |
| R9 | **Multi-org users with several tabs open:** switching org in one tab changes the other tab's context. | The admin app sends `X-Org-Id`. The server returns `409 org_mismatch` when it differs from the session, and the app reloads. RLS already prevents cross-tenant writes. This prevents confusion. |
| R10 | **Concurrent editing** of a draft by two editors. | Optimistic locking (`409` + reload/overwrite prompt). Real-time co-editing is out of scope (E5). |
| R11 | **Data residency** (for example "EU data stays in the EU") isn't specified. | Single-region assumption [A8]. Per-region deployments would be a significant later project. |

## 5.3 Expensive items

Relative cost: **$** = days, **$$** = 1–3 weeks, **$$$** = a month or more for one engineer, including tests.

| # | Item | Cost | Notes and cheaper alternative |
|---|---|---|---|
| E1 | SSO (SAML + OIDC) with just-in-time provisioning and enforcement | $$$ | Self-hosted (node-saml / openid-client, or BoxyHQ SAML Jackson) means more engineering and support work. A broker (WorkOS etc.) is faster to build but charged per connection. Recommend: OIDC first, SAML via a broker. |
| E2 | Multi-language surveys incl. right-to-left layout and a translation workflow | $$–$$$ | Translation storage is cheap with this design. The editor UX, RTL layout and string import/export cost the most. |
| E3 | Email campaigns run reliably at volume | $$ (+ ongoing operations) | Deliverability is an operational cost, not just code. |
| E4 | PDF reports | $$ | Headless Chromium in the worker is memory-heavy. Alternative: XLSX plus a "print view" page the browser saves as PDF. |
| E5 | Real-time co-editing in the builder | $$$ | Not in the brief. Excluded. Optimistic locking only. |
| E6 | Accepting submissions during a database outage (SQS ingest buffer) | $$ | Needs dedupe, ordering and eventual visibility in results. Only if C2's remaining gap is unacceptable. |
| E7 | Login-required respondents | $–$$$ | **Decision (Q5).** Cheap if respondents are org members (reuse login or SSO). Expensive if they're external (magic-link identity, account lifecycle). |
| E8 | Matrix, ranking and slider widgets, fully accessible and mobile-friendly | $$ | The main cost driver of Phase 2A. |
| E9 | Embed widget with theme parity and host-page isolation | $ | Cheap because it's an iframe. The resize and popup trigger polish takes the time. |
| E10 | Billing (Stripe subscriptions, metering, invoices, dunning) | $$$ | Not specified. **Decision (Q6).** |
