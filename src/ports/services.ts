/**
 * Cross-cutting service ports (TDR §6): rate limiting, time, ids, logging,
 * and observability. Narrow by design; injected at the edge.
 */

/** Scope a rate-limit acquisition targets: global, a provider, or a domain. */
export interface RateLimitScope {
  readonly kind: "global" | "provider" | "recipientDomain";
  /** The provider name or recipient domain; absent for global. */
  readonly key?: string;
}

/**
 * Layered rate limiter (TDR §3.2 step 4). `acquire` returns false when the
 * caller is over budget for the given scope; the send worker then re-queues
 * the message with a short backoff rather than dropping it.
 */
export interface RateLimiter {
  acquire(scope: RateLimitScope): Promise<boolean>;
}

/** Injectable clock — keeps use cases deterministic and testable. */
export interface Clock {
  now(): Date;
}

/** Injectable id generator (UUID v4 by default). */
export interface IdGenerator {
  generate(): string;
}

export type LogLevel = "debug" | "info" | "warn" | "error";

/** Minimal structured logger port. Console adapter provided by default. */
export interface Logger {
  log(level: LogLevel, message: string, fields?: Record<string, unknown>): void;
}

/**
 * Observability port (TDR §8). A thin wrapper so the core can emit spans and
 * metrics without importing the OpenTelemetry SDK directly. A no-op default is
 * used when otel is disabled; an OTel-backed adapter is provided.
 */
export interface Telemetry {
  /** Run `fn` inside a span named `name`, recording errors and duration. */
  span<T>(name: string, attrs: Record<string, unknown>, fn: () => Promise<T>): Promise<T>;
  /** Increment a counter metric. */
  counter(name: string, value: number, attrs?: Record<string, unknown>): void;
  /** Record a gauge/observation (e.g. queue depth). */
  gauge(name: string, value: number, attrs?: Record<string, unknown>): void;
}
