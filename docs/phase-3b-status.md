# Phase 3B status against the acceptance criteria

Checked on 2026-11-24 on Windows 11, Node 24, Docker Desktop. Legend: ✅ verified, with the evidence named ·
⚠️ built, but part of the criterion wasn't verified (says what's missing) · ❌ not done.

Phase 3 is split in two ([roadmap §4.5–4.6](04-roadmap.md#46-phase-3b-global-and-governed)). 3B was built in one
pass: it is about the size of 3A and 2B. Open questions answered for it on 2026-11-24
([README](README.md#open-questions)): **Q5** login-required respondents are org members only; **Q10** AI summaries use
OpenAI, opt-in per org.

**Summary:** 6 ✅, 1 ⚠️, 0 ❌. The ⚠️ is SSO: SAML and OIDC are tested against local mock identity providers, not
against real Okta, Entra ID or Google tenants, which needs accounts there (see the checklist below). Also not covered
by automated tests: a live call to the OpenAI API (the real client is tested against a local stand-in of the Chat
Completions API, so the chosen default model `gpt-6-luna` hasn't been called), and a manual screen-reader pass of the
new screens.

**Test totals:** 152 unit (13 of them Phase 3B), 278 integration (23 Phase 3B), 23 Playwright (5 Phase 3B, with axe
checks of every new screen: translation editor, results with an AI summary, organization settings, single sign-on,
the login page in SSO mode, survey retention, usage, privacy requests, the platform console, and the respondent app
right to left and asking to sign in). `pnpm verify`, `pnpm build` and `pnpm test:e2e` pass; lint and typecheck clean.
Respondent bundle 85.0 KB gz initial, 89.8 KB with lazy chunks (was 84.2 / 89.0; budget 100 KB): languages and
right-to-left support added 0.8 KB. The Lighthouse LCP check wasn't run locally; CI runs it.

Migration `0005_phase3b.sql` was applied to the shared development database with the Phase 3A data in place. The seed
was checked in a throwaway database (then dropped, so the development data was left alone): 1,850 responses, the NPS
survey with all 33 strings in French and 10 in Arabic, Acme's 730-day retention and the event survey's 365, the
members-only *Team retro*, `acme.test` verified, and usage counters for both orgs.

**Dependency audit:** the packages 3B adds (openid-client, @node-saml/node-saml and their dependencies; jose,
xml-crypto, selfsigned and pg for tests) have no advisories. `pnpm audit` still reports high and critical advisories in
packages that were already on `main`: drizzle-orm (< 0.45.2), nodemailer, vitest's tinypool, and Lighthouse's
puppeteer chain (extract-zip, basic-ftp, zod). Upgrading them is a separate change.

| Criterion | Status | Evidence |
|---|---|---|
| A survey translated into 2 languages serves each by `lang` param and by browser detection; logic and piping work in every language; publish warns about missing strings; a right-to-left language renders mirrored | ✅ | `packages/survey-core/test/i18n.test.ts`: every text has a stable key (pages, questions, options, matrix rows, settings labels, end screens, buttons); localizing keeps keys, structure and logic, falls back to the default language, and piping shows the translated option label; `Accept-Language` negotiation by quality and base language; RTL detection. `phase3b.test.ts`: strings saved on the draft (unknown keys dropped, default language and bad codes refused, analysts 404, audited); the draft's validation and the publish result list languages with missing strings, and publishing goes ahead; `?lang=fr` and `Accept-Language: de, fr-CA, en` both serve French, `ja` falls back to English, Arabic comes with `dir: rtl`; "No" ends the survey early in French as in English, the end screen pipes the French label, switching language mid-way changes the end screen, and responses record their language; editing the live version's French reaches respondents at once (cache dropped, audited with `published: true`); new drafts start with the live translations; CSV export and import round-trip, including formula-protected cells. Playwright: a browser set to French gets French, the picker switches to Arabic and the page mirrors (`dir=rtl`, the primary button on the left), axe on the RTL page, answering in French pipes "Oui", the translation editor saves a string on the live version and adds German, axe on the editor. |
| AI summaries: off until an org admin opts in; labelled "AI-generated" with model and date; shows the count of responses analysed; links each theme to sample responses; respects a per-org monthly token cap; redacts emails and phone numbers before sending | ✅ | `phase3b.test.ts`: summaries refused until an admin opts in (`403 ai_not_enabled`), opting in refused without a provider (`422 ai_unavailable`), creators can't opt in, audited; a summary names provider, model and `generatedAt`, counts 7 of 7 answers, every theme's samples are responses of the survey, sentiment covers every answer, tokens are added to the month's usage, requested and generated are audited; a cap below this month's usage refuses requests (`429 ai_token_cap_reached`) and a queued request whose estimate exceeds the cap fails with `token_cap_reached`. The real OpenAI client against a local stand-in: the request uses `json_schema` output and the configured model, the text sent contains `[email]` and `[phone]` and none of the address or number, no response ids are sent (opaque `a1…` ids), and an id the model invented is dropped from its theme. Redaction unit cases (plus-addresses, brackets, spelled-out "at"/"dot", dates kept). Playwright: the results page says summaries are off, the admin opts in (the third-party-processor notice is shown), "Summarize with AI" shows "AI-generated · fake-summarizer", "Based on 4 answers", sample answers link to the response, axe on both pages. |
| SAML (tested with Okta or Entra ID) and OIDC (tested with Google) logins work with just-in-time provisioning; enforced SSO blocks password login for that org's domains | ⚠️ | Against local mock identity providers (`apps/api/test/mock-oidc.ts`, `mock-saml.ts`), not real Okta, Entra ID or Google. `phase3b.test.ts`: domains verify by DNS TXT record and only one org can verify a domain; OIDC discovery is checked on save, the secret is encrypted and never returned; sign-in uses PKCE (S256), creates the account and the membership with the connection's role, links the same subject next time and an existing password account by email (keeping its admin role); refused for emails outside the org's verified domains, for unverified emails, without the browser-binding cookie, on a reused state, and `returnTo` can't redirect off-site. SAML: SP metadata, signed assertions accepted and provisioned; a replayed response, an unsigned one, one signed by another key, one for another request id and one for another audience are refused. Enforcement: refused until a sign-in worked; then password login and sign-up for the domain answer `403 sso_required`, reset emails aren't sent, invitations can't be accepted with a new password, other domains are unaffected, and removing the last connection switches enforcement off (audited). Playwright: the SSO settings page adds and verifies a domain and an OIDC connection (axe), a new person signs in from the login page through the mock provider and lands as an analyst, then enforcement can be switched on. **Not verified:** a real Okta or Entra ID SAML app and a real Google OIDC client (needs the user's accounts; checklist below). |
| A retention policy purges responses older than N days on schedule, repairs aggregates and writes an audit entry | ✅ | `phase3b.test.ts`: org default 30 days, one survey overridden to 10 (`effectiveRetentionDays` shown on both); the nightly job deletes the 40-day-old response under the default and everything older than 10 days under the override, the results summary, per-question counts and `completedCount` match what's left, one audit entry per survey gives the count and period, a second run deletes nothing; creators can't change the org default. Soft-deleted surveys are purged after 30 days (a recent one is kept). The job is scheduled daily at 02:20 UTC in the worker. Playwright sets the org default from the settings page (axe). |
| Usage metrics per org are visible to org admins and super admins | ✅ | `phase3b.test.ts`: responses, published versions, campaign emails and AI tokens per month (a retried aggregation job doesn't count a response twice), plus members, surveys, responses stored and file storage; analysts get 403; super admins see every org's month in the console and one org's report, and still get 404 for its surveys; others get 403 on the console. The migration backfills counters from existing data. Playwright: the usage page shows this month's responses (axe). |
| A subject export request produces a file of every non-anonymous record for an email; erasure removes them and is audit-logged; anonymous responses are out of scope | ✅ | `phase3b.test.ts`: the export finds the contact, the campaign email, a response through the personal link and one whose email answer matches (case-insensitively), skips someone else's response and an anonymous response containing the address, and reports the anonymous survey as not searched; the JSON file has the contact, the campaign email and both responses with their answers; analysts get 403; erasure needs the address typed twice, then removes the responses (aggregates rebuilt), the contact and the AI summary that cited one of them, leaves the anonymous response, and is audited with counts only (the address appears in no audit entry); a second export finds nothing. Responses of signed-in members and hidden fields equal to the address are found too. Playwright: export, download link, erasure from the privacy page (axe). |
| Login-required respondents (Q5: org members only) | ✅ | `phase3b.test.ts`: can't be combined with anonymity (either order); visitors get `login_required` with the admin app's sign-in URL and saving without a member is refused; the handoff link from the admin app carries a one-time token in the fragment, exchanged once for a respondent token and the member's response key; the response stores `respondent_user_id` and the response viewer shows who answered; the same member resumes the same response, can't start a second one (`respondent_key_mismatch`, and a unique index); non-members, forged tokens and tokens for another survey are refused; a member removed mid-way loses access; resume-by-email is off. Playwright: the respondent sees "Sign in to continue" (axe), signs in on the admin app with a password, comes back signed in with the token gone from the address bar, answers, and gets "You've already responded" on a second visit; the admin sees "Signed in as". |

The super-admin console (scope, no criterion of its own): `phase3b.test.ts` lists orgs with usage, suspends one (members
lose access, its links answer 404, its API keys 401, audited in that org with the reason), and reactivates it.
Playwright suspends an org from the console (axe).

## Checking SSO against real identity providers

Needs an admin account at each provider. In Settings → Single sign-on, verify your domain (TXT record), then:

1. **Google (OIDC):** create an OAuth client (Web application) with redirect URI
   `<APP_URL>/api/v1/auth/sso/oidc/callback`; add a connection with issuer `https://accounts.google.com`, the client
   id and secret. Sign in with "Test sign-in".
2. **Okta (SAML):** create a SAML 2.0 app with the ACS URL and entity ID shown on the connection, NameID format
   EmailAddress, attribute `email`; paste the sign-on URL, the issuer and the signing certificate.
3. **Entra ID (SAML):** an enterprise application with the same ACS URL and identifier; Entra sends the email as a
   claim (`…/claims/emailaddress`), which is read.
4. With one of them working, switch on enforcement and check that password sign-in for the domain is refused.

## Where the build differs from the design

- **Languages.**
  - Translations are flat maps keyed by place (`{questionKey}.option.{optionKey}`, `ui.next`…), stored with each version.
    The API serves the survey already translated, so the respondent bundle carries no translation code beyond a few
    UI strings.
  - Browser detection uses the `Accept-Language` header on the server, which also works on the request the respondent
    page starts before its script loads.
  - Translatable buttons and messages: next, back, submit, "required", the required-answer error, the error summary,
    "page n of m", the select placeholder, the language label and the anonymous note. Other validation messages, the
    closed / not-found / already-answered pages and the default language's own buttons stay in English.
  - Consent answers record the hash of the wording in the respondent's language.
- **AI summaries (Q10: OpenAI, not Anthropic as first suggested).**
  - Chat Completions with Structured Outputs through `fetch`; `OPENAI_MODEL` defaults to `gpt-6-luna` (OpenAI's
    cheapest current model, per its docs on 2026-11-24). `AI_PROVIDER=fake` is a deterministic stand-in for
    development and tests, refused in production.
  - Up to `AI_MAX_ANSWERS` (400) most recent completed answers per summary. The cap (`AI_MONTHLY_TOKEN_CAP`, 500,000 by
    default) is per org and calendar month (UTC); super admins can change it per org, org admins can't. The cap is
    checked before a request (used ≥ cap) and again by the job with an estimate of the request.
  - Response text goes to **OpenAI, a third-party processor**: the opt-in screen says so. Only emails and phone
    numbers are removed; other personal details people type are sent as written.
  - Erasure deletes summaries that cite an erased response. Retention purges don't (the summary is aggregate; its
    links to purged answers disappear).
- **SSO.**
  - Self-hosted (openid-client, @node-saml/node-saml) rather than through a broker.
  - Routes differ from the draft: a login starts from a connection id; OIDC and SAML have their own callbacks.
  - **Domain verification by DNS TXT record** wasn't in the design. It's what makes SSO safe: logins are only
    accepted for emails in a verified domain of the connection's org, and enforcement only covers verified domains.
    `SSO_DOMAIN_VERIFICATION=auto` verifies on adding, for local development and tests only.
  - Enforcement needs one successful SSO login first, and switches itself off (audited) when the last working
    connection or verified domain is removed. Sessions open before enforcement keep working. Super admins aren't
    exempt.
  - Just-in-time members get the connection's role (creator or analyst); admins are never provisioned automatically.
  - Not supported: IdP-initiated SAML, single logout, signed AuthnRequests and encrypted assertions.
- **Login-required respondents (Q5).** Members of the survey's org only (any of the user's orgs, not just the active
  one). The respondent app never sees the admin session: a two-minute, single-use signed token in the URL fragment is
  exchanged for a 12-hour respondent token (sessionStorage) and a response key derived from survey and member.
  "Email me a link to finish later" is off for these surveys (members sign in on any device). Campaigns still work for
  members; external people use personal campaign links on surveys that don't require login.
- **Retention.** A response's age is its completion time, or its last activity if never completed; test responses are
  included. Soft-deleted surveys are purged after 30 days by the same nightly job.
- **Usage.** Responses are counted when the aggregation job takes them (once per response), so not on the submission
  path. "Emails" are campaign emails and reminders, not notifications or account emails.
- **Super-admin console.** Changes run in the target org's tenant context and touch only the org row; the list comes
  from one `SECURITY DEFINER` function. Suspension also makes `resolve_public_survey` ignore the org's surveys.
  Unsubscribe links keep working for suspended orgs.
- **Privacy requests.**
  - Linked to an email by: contact, campaign recipient, signed-in member, an answer equal to the address, or a hidden
    field equal to it.
  - Not covered: contact-import error reports, webhook delivery logs (kept 30 days), in-app notification texts, notes
    on other responses that mention the address, and the platform-wide email suppression list (kept, so the address
    is never emailed again). Member accounts aren't deleted (that's member management); the export includes them.
  - The request row keeps the address as the record of the request; audit entries never contain it.
- **Upgrading:** run `pnpm db:migrate` (migration `0005_phase3b.sql` and three new queues: `insights.generate`,
  `retention.purge`, `privacy.process`) before starting the API and worker. New optional variables: `AI_PROVIDER`,
  `OPENAI_API_KEY`, `OPENAI_MODEL`, `OPENAI_BASE_URL`, `AI_MONTHLY_TOKEN_CAP`, `AI_MAX_ANSWERS`,
  `SSO_DOMAIN_VERIFICATION`.
