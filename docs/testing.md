# Testing

> Drive Outpost fully in memory with `@tgoliveira/outpost/testing`: in-memory repositories, a fake provider, and a controllable clock — deterministic, no infrastructure.

The `@tgoliveira/outpost/testing` entry point lets you build a complete, in-process
`Outpost` with no Postgres and no real email. It mirrors the production semantics
(lifecycle, idempotency, retry, retention, encryption) so your tests exercise the
real use cases. `test/outpost.test.ts` is the canonical worked example of every
flow.

> These utilities hold everything in RAM and verify nothing — never use them in
> production.

## What's exported

### `inMemoryRepositories(clock?)`

Returns the full repository bundle for `createOutpost`:
`{ outbox, suppressions, audit, apiKeys, webhookEvents }`. Pass a `Clock` (e.g.
`FakeClock`) so inserted/updated timestamps are deterministic — important for
retention tests. The returned `outbox` and `audit` repos expose their backing
stores (`.messages` Map, `.events` array) for assertions.

### `FakeEmailProvider`

An `EmailProvider` for tests:

- `sent: SentRecord[]` — every accepted send, each `{ providerMessageId, message }`
  where `message` is the decrypted `DispatchableMessage`.
- `failNext("transient" | "permanent")` — queue a one-shot failure to exercise
  the retry / dead-letter paths (defaults to `"transient"`).
- `verifyWebhook` accepts an **unsigned** JSON body of shape
  `{ type, providerMessageId, recipient?, isHardBounce? }` so you can drive
  lifecycle transitions deterministically.

### `FakeClock`

A controllable `Clock`:

- `new FakeClock(date?)` — defaults to `2026-01-01T00:00:00.000Z`.
- `now()` — current fake time.
- `set(date)` — jump to an absolute time.
- `advance(ms)` — move forward (e.g. to wait out a backoff or retention TTL).

## A deterministic end-to-end test

This drives the full send → tick → webhook → suppression loop with a fixed clock
and deterministic jitter:

```ts
import { describe, it, expect } from "vitest";
import { createOutpost } from "@tgoliveira/outpost";
import { inMemoryRepositories, FakeEmailProvider, FakeClock } from "@tgoliveira/outpost/testing";

function setup(opts?: { failNext?: "transient" | "permanent" }) {
  const clock = new FakeClock(new Date("2026-01-01T00:00:00.000Z"));
  const repos = inMemoryRepositories(clock);
  const provider = new FakeEmailProvider();
  if (opts?.failNext) provider.failNext(opts.failNext);

  const outpost = createOutpost({
    repositories: repos,
    providers: [provider],
    recipientHmacKey: "test-key-at-least-16-bytes-long",
    clock,
    retry: { maxAttempts: 3, baseDelayMs: 1000, maxDelayMs: 10_000 },
    random: () => 0.5, // deterministic jitter
  });
  return { outpost, provider, clock, repos };
}

describe("send → tick → webhook", () => {
  it("delivers and confirms via webhook", async () => {
    const { outpost, provider } = setup();

    // 1. Enqueue (persist only).
    const { id, state } = await outpost.send({
      idempotencyKey: "welcome-1",
      to: "user@example.com",
      subject: "Welcome",
      html: "<p>hi</p>",
    });
    expect(state).toBe("queued");

    // 2. Run one send-worker cycle → provider.send().
    const report = await outpost.tickSend();
    expect(report.claimed).toBe(1);
    expect(provider.sent).toHaveLength(1);
    const sent = await outpost.get(id);
    expect(sent.state).toBe("sent");

    // 3. Feed a delivered webhook (unsigned fake body).
    await outpost.webhook("fake", {
      headers: {},
      rawBody: JSON.stringify({ type: "delivered", providerMessageId: sent.providerMessageId }),
    });
    expect((await outpost.get(id)).state).toBe("delivered");
  });

  it("retries a transient failure after backoff", async () => {
    const { outpost, clock, provider } = setup({ failNext: "transient" });
    const { id } = await outpost.send({ idempotencyKey: "r1", to: "a@example.com", subject: "S", text: "t" });

    await outpost.tickSend();                 // transient failure → back to queued
    expect((await outpost.get(id)).state).toBe("queued");
    expect((await outpost.get(id)).attempts).toBe(1);

    clock.advance(60_000);                    // wait out the backoff
    await outpost.tickSend();                 // now succeeds
    expect((await outpost.get(id)).state).toBe("sent");
    expect(provider.sent).toHaveLength(1);
  });

  it("suppresses on a hard bounce", async () => {
    const { outpost } = setup();
    const { id } = await outpost.send({ idempotencyKey: "b1", to: "bouncer@example.com", subject: "S", text: "t" });
    await outpost.tickSend();
    const { providerMessageId } = await outpost.get(id);

    await outpost.webhook("fake", {
      headers: {},
      rawBody: JSON.stringify({ type: "bounced", providerMessageId, isHardBounce: true }),
    });
    expect(await outpost.isSuppressed("bouncer@example.com")).toBe(true);
  });
});
```

## Tips

- **Fixed jitter:** pass `random: () => 0.5` so retry backoff is reproducible.
- **One worker step at a time:** `tickSend()` / `tickRetention()` run exactly one
  cycle, so you control progress; never call `start()` in a test.
- **Inspect state directly:** `repos.outbox.messages.get(id)` exposes the raw row
  (e.g. assert `bodySealed.alg === "aes-256-gcm"` for encryption tests, or
  `"redacted"` after retention).
- **Encryption round-trips** work in memory — see the `encryption` tests in
  `test/outpost.test.ts` for symmetric and asymmetric (RSA-hybrid) examples.
- **Retention:** use a `FakeClock`, set short TTLs
  (`retention: { operationalTtlDays: 1, webhookWindowHours: 1, … }`),
  `clock.advance(...)`, then `tickRetention()`.

Run the suite with:

```bash
npm test
```

See [getting-started.md](./getting-started.md#verify-it-works) and the
deterministic-clock notes in [configuration.md](./configuration.md).
