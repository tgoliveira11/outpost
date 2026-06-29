# API reference

> The programmatic `Outpost` client and the Fetch-based HTTP API (`OutpostRouter`), with signatures, scopes, and request/response shapes.

There are two ways to drive Outpost. Server-side code in the same app calls the
**programmatic client** directly. Cross-service callers go through the **HTTP
API**, whose handlers call the exact same use cases under the hood.

---

## (a) Programmatic API

`createOutpost(options)` returns an `Outpost` instance. Its methods:

### `send(input, opts?)`

Enqueue a message (persist-then-queue). Idempotent on `idempotencyKey`. Does
**not** send — a worker dispatches it later.

```ts
send(input: EnqueueInput, opts?: { actor?: string }): Promise<EnqueueResult>
```

`EnqueueInput`:

| Field | Type | Notes |
|---|---|---|
| `idempotencyKey` | `string` | **Required.** Dedupe key — derive from the business event, not a random UUID. |
| `to` | `string` | Recipient address. |
| `template?` | `{ id: string; version?: number; vars: Record<string, unknown> }` | Render via the configured `TemplateRenderer`. Either `template` OR `subject` is required. |
| `subject?` | `string` | Overrides a template's subject if both are present. |
| `html?` / `text?` | `string` | Raw body (at least one of html/text non-empty). |
| `provider?` | `string` | Override the default provider for this message. |
| `metadata?` | `Record<string, unknown>` | Clear, queryable. **Never put PII here.** |
| `scheduledFor?` | `Date` | Phase 2 scheduling; the worker won't claim it until then. |

`EnqueueResult`: `{ id, state, idempotencyKey, deduplicated }`. `deduplicated` is
`true` when an existing message with the same key was returned.

```ts
const r = await outpost.send({
  idempotencyKey: "order-1234-receipt",
  to: "customer@example.com",
  subject: "Your receipt",
  html: "<p>Thanks!</p>",
});
// { id: "…", state: "queued", idempotencyKey: "order-1234-receipt", deduplicated: false }
```

### `get(id)`

Fetch a message's lifecycle + metadata as a **PII-free** `MessageView` (no
decrypted body/recipient). Throws `NotFoundError` if missing.

```ts
get(id: string): Promise<MessageView>
```

`MessageView` fields: `id`, `idempotencyKey`, `state`, `recipientHmac`, `subject`,
`provider`, `templateId`, `templateVersion`, `metadata`, `attempts`,
`nextAttemptAt`, `providerMessageId`, `lastError`, `createdAt`, `updatedAt`
(timestamps are ISO strings).

```ts
const msg = await outpost.get(id); // { state: "failed", lastError, attempts, … }
```

### `list(query?)`

List messages, newest first.

```ts
list(query?: ListMessagesQuery): Promise<MessageView[]>
```

`ListMessagesQuery`: `{ state?, recipientHmac?, provider?, createdAfter?, createdBefore?, limit?, offset? }`
(`limit` defaults to 50).

```ts
const failures = await outpost.list({ state: "failed", limit: 20 });
```

### `replay(id, opts?)`

Re-enqueue a dead-lettered (`failed`) message from the DLQ. Resets the retry
budget and schedules an immediate retry. Throws `InvalidStateTransitionError` if
the message isn't in a replayable state.

```ts
replay(id: string, opts?: { actor?: string }): Promise<MessageView>
```

```ts
await outpost.replay(id);
```

### `isSuppressed(address)`

```ts
isSuppressed(address: string): Promise<boolean>
```

### `suppress(address, reason?, opts?)`

Add an address to the suppression list (audited). `reason` defaults to
`"manual"`; valid reasons are `hard_bounce | complaint | unsubscribe | invalid |
manual`.

```ts
suppress(
  address: string,
  reason?: SuppressionReason,
  opts?: { note?: string; actor?: string },
): Promise<SuppressionEntry>
```

```ts
await outpost.suppress("user@example.com", "unsubscribe");
```

### `unsuppress(address, opts?)`

Remove an address from the suppression list (audited). Returns whether a row was
removed.

```ts
unsuppress(address: string, opts?: { actor?: string }): Promise<boolean>
```

### `webhook(provider, raw)`

Ingest a verified provider webhook (used by the HTTP webhook sink). Verifies the
signature via the named provider, records the raw event, correlates to the
outbox row, transitions lifecycle, and feeds suppression on hard bounce/complaint.

```ts
webhook(provider: string, raw: { headers: Record<string, string | string[] | undefined>; rawBody: string }): Promise<IngestWebhookResult>
```

`IngestWebhookResult`: `{ accepted, eventType, messageId, note? }`.

### `tickSend()` / `tickRetention()`

Run one cycle of the send or retention worker. Ideal for cron / route-handler
deployments.

```ts
tickSend(): Promise<SendTickReport>          // { claimed, outcomes }
tickRetention(): Promise<PurgeReport>        // { operationalProcessed, auditDeleted, redacted }
```

### Sub-clients

The client also exposes the underlying use cases directly:

| Property | Type | Use |
|---|---|---|
| `outpost.keys` | `ManageApiKey` | `create({ label, scopes, expiresAt? })` → `{ id, label, scopes, expiresAt, secret }` (secret shown once); `revoke(id)`; `list()`. |
| `outpost.auth` | `Authenticate` | `resolve(secret)`, `authorize(secret, scope)`, `Authenticate.extractKey(headers)`. |
| `outpost.suppression` | `ManageSuppression` | `getByHmac(hash)`, `unsuppressByHmac(hash, actor)`, `list(limit?, offset?)`. |
| `outpost.send_worker` | `SendWorker` | `start()`, `stop()`, `tick()`. |
| `outpost.retention_worker` | `RetentionWorker` | `start()`, `stop()`, `tick()`. |
| `outpost.enqueueMessage`, `outpost.ingestWebhook` | use cases | the objects backing `send()` / `webhook()`. |

```ts
const { secret } = await outpost.keys.create({ label: "ci", scopes: ["messages:send"] });
// `secret` (opk_…) is shown ONCE — store it now; only a hash is persisted.
await outpost.keys.revoke(keyId); // takes effect immediately
```

---

## (b) HTTP API

Exported at `@tgoliveira/outpost/next` as `OutpostRouter`, built on the Web Fetch
`Request`/`Response`, so it drops into the Next.js App Router, Remix, Hono, or any
Fetch runtime. Wiring is in [nextjs.md](./nextjs.md).

```ts
import { OutpostRouter } from "@tgoliveira/outpost/next";
const router = new OutpostRouter(outpost);
```

### Route table

Paths below assume a mount at `/api/outpost`. The router method is what you bind
in each route file; the path is determined by your file layout.

| Method | Path | `OutpostRouter` method | Scope | Request body | Success response |
|---|---|---|---|---|---|
| POST | `/messages` | `enqueue` | `messages:send` | `EnqueueInput` JSON | `EnqueueResult`; **202** Accepted (or **200** if `deduplicated`) |
| GET | `/messages` | `list` | `messages:read` | — (query: `state`, `recipientHmac`, `provider`, `limit`, `offset`) | `200 { messages: MessageView[] }` |
| GET | `/messages/:id` | `get` | `messages:read` | — | `200 MessageView` |
| POST | `/messages/:id/replay` | `replay` | `messages:replay` | — | `200 MessageView` |
| GET | `/suppressions/:hash` | `getSuppression` | `suppressions:read` | — | `200 SuppressionEntry` (404 if not suppressed) |
| POST | `/suppressions` | `suppress` | `suppressions:write` | `{ address, reason?, note? }` | `201 SuppressionEntry` |
| DELETE | `/suppressions/:hash` | `unsuppress` | `suppressions:write` | — | `200 { removed: boolean }` |
| POST | `/webhooks/:provider` | `webhook` | **none** (signature-verified) | raw provider payload | `200 IngestWebhookResult` |

> The `:hash` segment for suppression routes is the **recipient HMAC**, not a
> plaintext address (the API never receives plaintext addresses for lookup).

Method signatures (note: `enqueue`/`suppress` parse the JSON body; the rest
receive the path param and the auth context):

```ts
router.enqueue(req)            // POST /messages
router.list(req)               // GET /messages
router.get(req, id)            // GET /messages/:id
router.replay(req, id)         // POST /messages/:id/replay
router.getSuppression(req, hash)
router.suppress(req)           // POST /suppressions
router.unsuppress(req, hash)   // DELETE /suppressions/:hash
router.webhook(req, provider)  // POST /webhooks/:provider
```

### Authentication

Every endpoint except the webhook sink requires an API key. Two accepted forms:

```
Authorization: Bearer opk_...
```
or
```
x-outpost-key: opk_...
```

The key is hashed and looked up on **every** request (no caching), so revocation
and expiry take effect immediately. The required scope is enforced per route;
the `admin` scope implies all others. Scopes: `messages:send`, `messages:read`,
`messages:replay`, `suppressions:read`, `suppressions:write`, `keys:manage`,
`admin`.

The webhook sink is **not** API-key authenticated — trust is established by
verifying the provider's signature over the raw body.

### Error / status mapping

Domain errors are mapped to HTTP status codes by `errorResponse`. The body is
`{ error: <code>, message: <string> }` (validation errors also include
`details`).

| Error | `code` | HTTP status |
|---|---|---|
| `UnauthorizedError` | `unauthorized` | 401 |
| `WebhookVerificationError` | `webhook_unverified` | 401 |
| `ForbiddenError` | `forbidden` | 403 |
| `ValidationError` | `validation_failed` | 400 (+ `details`) |
| `NotFoundError` | `not_found` | 404 |
| `OutpostError` (any other, e.g. `InvalidStateTransitionError` → `invalid_transition`) | its `code` | 400 |
| anything else | `internal_error` | 500 |

Example error body:

```json
{ "error": "forbidden", "message": "API key lacks the required scope" }
```
