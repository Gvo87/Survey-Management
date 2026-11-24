# Public API and webhooks

For developers connecting another system. The machine-readable reference is the OpenAPI 3.1 document at
`GET /api/v1/openapi.json`. It lists every endpoint an API key can call, with request schemas and the scope each
one needs.

## API keys

An org admin creates keys under **Settings → API and webhooks**. The key (`sk_live_…`) is shown once. Only a SHA-256
hash is stored, so a lost key can't be recovered: revoke it and create another.

```http
GET /api/v1/surveys?status=live
Authorization: Bearer sk_live_…
```

- **Scopes.** Each key has one or more scopes. A call outside them answers `403 insufficient_scope`, with
  `requiredScope` in the body. Endpoints that aren't part of the public API answer `403 not_available_with_api_key`.

  | Scope | Allows |
  |---|---|
  | `surveys:read` | List surveys, read drafts, versions and definitions |
  | `surveys:write` | Create surveys, save drafts, publish, close, reopen, archive |
  | `responses:read` | List and read responses, the results summary, CSV export |
  | `responses:delete` | Delete a response |
  | `contacts:read` | List contacts and lists, read imports |
  | `contacts:write` | Create, change and delete contacts and lists |
  | `webhooks:manage` | Manage webhook endpoints, deliveries and redeliveries |

- **Acting as the org.** A key acts as an org admin, limited to its scopes. The audit log records the key as the
  actor and keeps the admin who created it in the entry's details.
- **When a key stops working.** A key answers `401` once it is revoked or expired, or once the admin who created it
  is no longer an admin of the org.
- **Rate limit.** 600 requests a minute per key. Every response carries `RateLimit-Limit`, `RateLimit-Remaining` and
  `RateLimit-Reset`. Over the limit, the API answers `429` with `Retry-After`.
- **Cookies and CSRF.** API keys don't use them.

### Idempotent POSTs

Send an `Idempotency-Key` header with any POST (1 to 255 printable ASCII characters, for example a UUID):

- **Same key, same body, within 24 hours:** you get the first response again, with `Idempotent-Replayed: true`,
  instead of a second survey, contact or webhook.
- **Same key, different body:** `422 idempotency_key_reused`.
- **First request still running:** `409 idempotency_in_progress`. Retry shortly.
- **Server errors (5xx)** aren't stored, so retrying with the same key runs the request again.

Keys are scoped to the caller, so two integrations can't collide by choosing the same value.

### Errors

Errors are RFC 9457 problem documents:

```json
{ "type": "urn:survey:error:insufficient_scope", "title": "This API key needs the surveys:write scope.",
  "status": 403, "code": "insufficient_scope", "requiredScope": "surveys:write", "requestId": "req_…" }
```

## Webhooks

Register an endpoint under **Settings → API and webhooks**, or with `POST /api/v1/webhooks`. You can listen to:

- `response.submitted`: a respondent completed the survey or was screened out
- `survey.published`
- `survey.closed`: closed by hand, by the close date, or by the response limit

`surveyIds` limits an endpoint to particular surveys. The signing secret (`whsec_…`) is in the create response only.

### What we send

```http
POST https://your.example/webhooks/surveys
Content-Type: application/json
Survey-Webhook-Id: evt_0193…            # the event id: the same on every retry and redelivery
Survey-Webhook-Event: response.submitted
Survey-Webhook-Timestamp: 1795430400
Survey-Webhook-Signature: v1=5f2b…      # hex(HMAC_SHA256(secret, timestamp + "." + raw body))

{ "id": "evt_0193…", "type": "response.submitted", "createdAt": "2026-11-23T10:00:00.000Z",
  "data": { "surveyId": "…", "responseId": "…", "status": "completed", "versionNumber": 3,
            "completedAt": "…", "distribution": "Default link", "hiddenFields": { "customer_id": "C-981" },
            "answers": [ { "questionKey": "q_7Hk2", "title": "How likely…", "type": "nps", "value": 9, "display": "9" } ] } }
```

Payloads carry only what the database stores. Anonymous surveys send no identifying data, and their times are
rounded to the hour.

### Verifying a delivery

Check the signature against the **raw** body, reject old timestamps, and drop event ids you've already processed.
[`examples/verify-webhook.mjs`](examples/verify-webhook.mjs) does the first two, and the integration tests run it
against real deliveries:

```js
import { verifyWebhook } from './verify-webhook.mjs';

app.post('/webhooks/surveys', express.raw({ type: 'application/json' }), (req, res) => {
  if (!verifyWebhook(process.env.SURVEY_WEBHOOK_SECRET, req.headers, req.body.toString('utf8'))) return res.sendStatus(400);
  // …dedupe on req.headers['survey-webhook-id'], then handle JSON.parse(req.body)
  res.sendStatus(204);
});
```

After you rotate the secret, the signature header has two `v1=` values for 24 hours, one per secret. Accept either.

### Retries, redelivery and disabling

- **Success:** any `2xx` within 10 seconds. Redirects aren't followed.
- **Retries:** failed deliveries are retried after 1 minute, 5 minutes, 30 minutes, 2 hours, 6 hours, 12 hours and
  24 hours. If all 8 attempts fail, the delivery is marked `failed`.
- **History:** every attempt is kept for 30 days, with its status code, timing and the first 500 characters of the
  response. You can **redeliver** any finished delivery (one more attempt, same event id) and **send a test** `ping`.
- **Auto-disable:** after 50 events in a row fail every attempt, the endpoint is turned off and org admins are told
  in the app and by email. Turning it back on resets the count.

### Network rules

Endpoints must be `http://` or `https://` URLs without credentials. In production the API resolves each host and
refuses private, loopback, link-local (including cloud metadata at 169.254.169.254), carrier-grade NAT, multicast
and reserved addresses, for IPv4, IPv6 and IPv4-mapped IPv6. It then connects to the address it checked, so a DNS
change between the check and the connection can't redirect it. For local development,
`ALLOW_PRIVATE_WEBHOOK_URLS=true` (the default in development) lifts this. The API refuses to start in production
with that setting on.
