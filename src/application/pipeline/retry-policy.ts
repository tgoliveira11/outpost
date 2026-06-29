/**
 * Retry policy: exponential backoff with full jitter (TDR §3.4).
 *
 * Pure function of (attempt number, config) → delay. Jitter is injected as a
 * 0..1 random sample so the policy stays deterministic and testable (the
 * worker passes a real random; tests pass a fixed value).
 */

export interface RetryConfig {
  /** Max dispatch attempts before a message is dead-lettered. */
  readonly maxAttempts: number;
  /** Base backoff in ms (first retry waits ~this, before jitter). */
  readonly baseDelayMs: number;
  /** Cap on the backoff in ms. */
  readonly maxDelayMs: number;
}

export const DEFAULT_RETRY: RetryConfig = {
  maxAttempts: 5,
  baseDelayMs: 30_000, // 30s
  maxDelayMs: 60 * 60 * 1000, // 1h
};

/** True once attempts have reached the budget — message goes to the DLQ. */
export function isExhausted(attempts: number, config: RetryConfig): boolean {
  return attempts >= config.maxAttempts;
}

/**
 * Backoff for the NEXT attempt after `attempts` failed tries.
 * delay = min(maxDelay, base * 2^(attempts-1)) then full-jitter: random in
 * [0, delay]. `jitter` is a sample in [0,1).
 */
export function backoffMs(attempts: number, config: RetryConfig, jitter: number): number {
  const exp = Math.min(config.maxDelayMs, config.baseDelayMs * 2 ** Math.max(0, attempts - 1));
  return Math.floor(exp * jitter);
}

/** Convenience: the Date of the next attempt from `now`. */
export function nextAttemptAt(
  attempts: number,
  config: RetryConfig,
  jitter: number,
  now: Date,
): Date {
  return new Date(now.getTime() + backoffMs(attempts, config, jitter));
}
