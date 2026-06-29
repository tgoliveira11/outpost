# Providers

> The built-in transport adapters (Resend, SMTP/Mailpit, Fake), their options, and how to write your own `EmailProvider`.

A provider is the swappable transport that actually sends a message. Every
provider implements one small port, `EmailProvider`, so adding one never touches
the core (Open/Closed). Providers are passed to `createOutpost({ providers })`;
the first is the default unless `defaultProvider` is set, and a message can
override per-send with `provider`.

## Built-in providers

| Provider | Import | Options type | Webhooks? |
|---|---|---|---|
| `ResendEmailProvider` | `@tgoliveira/outpost/adapters` | `ResendProviderOptions` | ✅ yes (Svix signature) |
| `SmtpEmailProvider` | `@tgoliveira/outpost/adapters` | `SmtpProviderOptions` | ❌ **no** — `verifyWebhook` always rejects |
| `FakeEmailProvider` | `@tgoliveira/outpost/adapters` and `@tgoliveira/outpost/testing` | constructor `name?` | ✅ test-only (unsigned JSON) |

> **SMTP has no delivery webhooks.** With `SmtpEmailProvider` the lifecycle stops
> at `sent` — there is no `delivered`/`bounced`/`complained`. Use a
> webhook-capable provider (Resend, and Phase 2: SES/SendGrid/Postmark) for
> delivery tracking and automatic suppression.

### Resend

Uses the global `fetch` (Node 18+) — no SDK dependency. Webhooks are verified
with Resend's Svix signature scheme before being trusted.

`ResendProviderOptions`:

| Field | Type | Notes |
|---|---|---|
| `apiKey` | `string` | Resend API key. |
| `from` | `string` | Default From (verified Resend domain), e.g. `"Acme <no-reply@acme.com>"`. |
| `webhookSecret?` | `string` | Svix signing secret (`whsec_…`). Required to ingest delivery/bounce/complaint webhooks. |
| `name?` | `string` | Provider key. Default `"resend"`. |
| `baseUrl?` | `string` | Override the API base (testing). |

```ts
import { ResendEmailProvider } from "@tgoliveira/outpost/adapters";

new ResendEmailProvider({
  apiKey: process.env.RESEND_API_KEY!,
  from: "Acme <no-reply@acme.com>",
  webhookSecret: process.env.RESEND_WEBHOOK_SECRET!,
});
```

Retry classification: a network failure or a `429` / `5xx` response throws
`ProviderError.transient` (retried with backoff); other `4xx` responses throw
`ProviderError.permanent` (dead-lettered). Resend webhook event mapping:
`email.delivered → delivered`, `email.bounced → bounced`,
`email.complained → complained`, `email.opened → opened`, `email.failed → failed`;
`email.sent`/`email.clicked`/`email.delivery_delayed` are ignored.

### SMTP / Mailpit

Generic SMTP via `nodemailer`, which is an **optional** peer dependency imported
lazily — install it only if you use this provider (`npm i nodemailer`). Point it
at Mailpit for local dev.

`SmtpProviderOptions`:

| Field | Type | Notes |
|---|---|---|
| `host` | `string` | SMTP host. |
| `port` | `number` | SMTP port (Mailpit defaults to `1025`). |
| `from` | `string` | Default From. |
| `secure?` | `boolean` | TLS. Default `false`. |
| `auth?` | `{ user: string; pass: string }` | SMTP auth (omit for Mailpit). |
| `name?` | `string` | Provider key. Default `"smtp"` — use `"mailpit"` for the dev box. |
| `transportOptions?` | `Record<string, unknown>` | Extra options passed straight to `nodemailer.createTransport`. |

```ts
import { SmtpEmailProvider } from "@tgoliveira/outpost/adapters";

new SmtpEmailProvider({ name: "mailpit", host: "localhost", port: 1025, secure: false, from: "Dev <dev@localhost>" });
```

Retry classification: SMTP `5xx` → permanent; `4xx` (greylisting) → transient;
connection-level errors (`ETIMEDOUT`, `ECONNRESET`, `ECONNREFUSED`, `ESOCKET`,
`EDNS`) → transient. See [getting-started.md](./getting-started.md#local-development-with-mailpit)
for the Mailpit walkthrough.

### Fake (testing only)

In-memory provider for tests and CI. Substitutable for a real provider (same
interface + error contract). See [testing.md](./testing.md).

- Records every accepted send in `provider.sent` (`SentRecord[]`).
- `failNext("transient" | "permanent")` queues a one-shot failure to exercise
  retry / dead-letter paths.
- `verifyWebhook` accepts an **unsigned** JSON body of shape
  `{ type, providerMessageId, recipient?, isHardBounce? }` for driving lifecycle
  transitions deterministically.

```ts
import { FakeEmailProvider } from "@tgoliveira/outpost/testing";
const provider = new FakeEmailProvider();
provider.failNext("transient");
```

> Never use `FakeEmailProvider` in production — it sends nothing and verifies
> nothing.

## Writing a custom provider

Implement the `EmailProvider` port (`src/ports/email-provider.ts`):

```ts
import type { EmailProvider, ProviderReceipt, RawWebhook } from "@tgoliveira/outpost";
import type { DispatchableMessage, WebhookEvent } from "@tgoliveira/outpost";
import { ProviderError, WebhookVerificationError } from "@tgoliveira/outpost";

export class MyProvider implements EmailProvider {
  readonly name = "my-provider"; // stable key, persisted on the message

  async send(msg: DispatchableMessage): Promise<ProviderReceipt> {
    // msg has { id, to, subject, body: { html?, text? }, headers, metadata }
    try {
      const res = await fetch("https://api.example.com/send", { /* … */ });
      if (res.status === 429 || res.status >= 500) {
        // Retryable: back to the queue with backoff.
        throw ProviderError.transient(`upstream ${res.status}`, { providerCode: String(res.status) });
      }
      if (!res.ok) {
        // Not retryable: straight to `failed` (DLQ).
        throw ProviderError.permanent(`rejected ${res.status}`, { providerCode: String(res.status) });
      }
      const { id } = await res.json();
      return { providerMessageId: id }; // "accepted", not yet "delivered"
    } catch (err) {
      if (err instanceof ProviderError) throw err;
      // Network/unknown errors are retryable.
      throw ProviderError.transient("request failed", { cause: err });
    }
  }

  async verifyWebhook(req: RawWebhook): Promise<WebhookEvent> {
    // Verify the signature over the RAW body before trusting anything.
    if (!signatureValid(req.headers, req.rawBody)) {
      throw new WebhookVerificationError("bad signature");
    }
    const payload = JSON.parse(req.rawBody);
    return {
      provider: this.name,
      type: "delivered", // "delivered" | "bounced" | "complained" | "opened" | "failed"
      providerMessageId: payload.message_id, // correlates back to the outbox row
      recipient: payload.to,
      isHardBounce: payload.bounce_type === "hard",
      occurredAt: new Date(payload.timestamp),
      raw: payload,
    };
  }
}
```

The contract that makes retry/dead-letter classification work without the core
inspecting provider-specific errors:

- **`send()` MUST throw a `ProviderError`** on failure. Use
  `ProviderError.transient(message, opts?)` for retryable failures (rate limits,
  `5xx`, network) and `ProviderError.permanent(message, opts?)` for non-retryable
  ones (bad request, rejected content). Both accept `{ providerCode?, cause? }`.
  A transient error re-queues with backoff; a permanent one (or exhausted
  retries) goes to `failed`.
- **`verifyWebhook()` MUST verify the signature over the raw body** and throw
  `WebhookVerificationError` on any mismatch, then normalize the native payload
  into the uniform `WebhookEvent`. Returning a uniform event is what gives Outpost
  one ingestion path for all providers.
- A `ProviderReceipt` means the provider *accepted* the message, not that it was
  delivered — delivery is confirmed asynchronously via the webhook.

Register it like any built-in:

```ts
createOutpost({ /* … */, providers: [new MyProvider()] });
```

> **Provider fallback** (automatically retrying a failed send on a second
> provider) is a Phase 2 feature. In v1 a message dispatches on its assigned
> provider only; you can still register multiple providers and route per-message
> via `send({ provider })`.
