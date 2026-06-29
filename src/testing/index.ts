/**
 * Testing utilities — exported at `@tgoliveira/outpost/testing`.
 *
 * In-memory repositories + a deterministic fake clock, and re-export of the
 * fake provider. Build a fully in-process Outpost with NO Postgres and NO real
 * email for unit/integration tests and CI (TDR §3.8).
 */
import type { Clock } from "../ports/services.js";
import {
  InMemoryOutboxRepository,
  InMemorySuppressionRepository,
  InMemoryAuditRepository,
  InMemoryApiKeyRepository,
  InMemoryWebhookEventRepository,
} from "./in-memory-repositories.js";

export * from "./in-memory-repositories.js";
export { FakeEmailProvider } from "../adapters/providers/fake.js";

/** A controllable clock for deterministic tests. */
export class FakeClock implements Clock {
  constructor(private current: Date = new Date("2026-01-01T00:00:00.000Z")) {}
  now(): Date {
    return new Date(this.current);
  }
  set(date: Date): void {
    this.current = date;
  }
  advance(ms: number): void {
    this.current = new Date(this.current.getTime() + ms);
  }
}

/**
 * Convenience: a complete in-memory repository bundle for `createOutpost`.
 *
 *   import { createOutpost } from "@tgoliveira/outpost";
 *   import { inMemoryRepositories, FakeEmailProvider } from "@tgoliveira/outpost/testing";
 *   const outpost = createOutpost({
 *     repositories: inMemoryRepositories(),
 *     providers: [new FakeEmailProvider()],
 *     recipientHmacKey: "test-key-at-least-16-bytes-long",
 *   });
 */
export function inMemoryRepositories(clock?: Clock) {
  const now = clock ? () => clock.now() : undefined;
  return {
    outbox: new InMemoryOutboxRepository(now),
    suppressions: new InMemorySuppressionRepository(),
    audit: new InMemoryAuditRepository(now),
    apiKeys: new InMemoryApiKeyRepository(),
    webhookEvents: new InMemoryWebhookEventRepository(),
  };
}
