import type { RateLimiter, RateLimitScope, Clock } from "../../ports/services.js";
import type { RateLimitConfig, RateBudget } from "../../application/config.js";

/**
 * In-memory token-bucket rate limiter (TDR §3.2 step 4).
 *
 * Layered: a distinct bucket per (scope.kind + scope.key). A budget of
 * `{ max, windowMs }` refills `max` tokens over `windowMs`. `acquire` consumes
 * one token; returns false when the bucket is empty (caller re-queues).
 *
 * This is correct for a SINGLE process. For multiple send-worker instances,
 * implement the `RateLimiter` port against Redis (shared counters) — the port
 * is the seam, the core does not change.
 */
export class InMemoryRateLimiter implements RateLimiter {
  private readonly buckets = new Map<string, { tokens: number; lastRefill: number }>();

  constructor(
    private readonly config: RateLimitConfig,
    private readonly clock: Clock,
  ) {}

  async acquire(scope: RateLimitScope): Promise<boolean> {
    const budget = this.budgetFor(scope);
    if (!budget) return true; // unlimited when no budget configured

    const key = `${scope.kind}:${scope.key ?? ""}`;
    const now = this.clock.now().getTime();
    const refillRate = budget.max / budget.windowMs; // tokens per ms

    let bucket = this.buckets.get(key);
    if (!bucket) {
      bucket = { tokens: budget.max, lastRefill: now };
      this.buckets.set(key, bucket);
    } else {
      const elapsed = now - bucket.lastRefill;
      bucket.tokens = Math.min(budget.max, bucket.tokens + elapsed * refillRate);
      bucket.lastRefill = now;
    }

    if (bucket.tokens >= 1) {
      bucket.tokens -= 1;
      return true;
    }
    return false;
  }

  private budgetFor(scope: RateLimitScope): RateBudget | undefined {
    switch (scope.kind) {
      case "global":
        return this.config.global;
      case "provider":
        return this.config.perProvider;
      case "recipientDomain":
        return this.config.perRecipientDomain;
    }
  }
}

/** Always allows. Used when no rate limits are configured. */
export class UnlimitedRateLimiter implements RateLimiter {
  async acquire(): Promise<boolean> {
    return true;
  }
}
