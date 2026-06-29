import type { CoreDeps } from "../application/context.js";
import { DispatchMessage, type DispatchOutcome } from "../application/dispatch-message.js";

export interface SendTickReport {
  readonly claimed: number;
  readonly outcomes: DispatchOutcome[];
}

export interface SendWorkerOptions {
  /** Poll interval for the long-running loop, ms. Default 1000. */
  readonly intervalMs?: number;
  /** Max messages claimed per tick. Defaults to config.sendBatchSize. */
  readonly batchSize?: number;
  /** Max concurrent dispatches within a tick. Default 10. */
  readonly concurrency?: number;
}

/**
 * SendWorker — the polling outbound processor (TDR §3.2, decision #2).
 *
 * Polls the outbox (NEVER a dual-written queue), atomically claims a batch with
 * `FOR UPDATE SKIP LOCKED`, and runs each message through `DispatchMessage`.
 * Safe to run as multiple concurrent instances — the claim guarantees no two
 * workers process the same row.
 *
 * Two ways to run it:
 *   - `start()` / `stop()` — long-running process (setInterval-style loop).
 *   - `tick()` — one cycle; call it from a cron job or Next.js route handler
 *     (e.g. a Vercel Cron hitting `/api/cron/outpost-send`).
 */
export class SendWorker {
  private readonly dispatch: DispatchMessage;
  private running = false;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly deps: CoreDeps,
    private readonly options: SendWorkerOptions = {},
  ) {
    this.dispatch = new DispatchMessage(deps);
  }

  /** Process one batch. Returns what happened (for logging/metrics/tests). */
  async tick(): Promise<SendTickReport> {
    const now = this.deps.clock.now();
    const batchSize = this.options.batchSize ?? this.deps.config.sendBatchSize;
    const reclaimBefore = new Date(now.getTime() - this.deps.config.staleSendingLeaseMs);
    const claimed = await this.deps.outbox.claimBatchForSending(batchSize, now, reclaimBefore);

    this.deps.telemetry.gauge("outpost.send.claimed", claimed.length);
    if (claimed.length === 0) return { claimed: 0, outcomes: [] };

    const concurrency = this.options.concurrency ?? 10;
    const outcomes = await runWithConcurrency(claimed, concurrency, (m) =>
      this.dispatch.execute(m).catch((err) => {
        // DispatchMessage handles its own errors; this guards against an
        // unexpected throw so one bad message can't kill the whole tick.
        this.deps.logger.log("error", "dispatch threw unexpectedly", {
          messageId: m.id,
          error: err instanceof Error ? err.message : String(err),
        });
        return { kind: "failed", reason: "unexpected error" } as DispatchOutcome;
      }),
    );

    return { claimed: claimed.length, outcomes };
  }

  /** Start the long-running poll loop. Idempotent. */
  start(): void {
    if (this.running) return;
    this.running = true;
    const interval = this.options.intervalMs ?? 1000;
    const loop = async () => {
      if (!this.running) return;
      try {
        await this.tick();
      } catch (err) {
        this.deps.logger.log("error", "send worker tick failed", {
          error: err instanceof Error ? err.message : String(err),
        });
      } finally {
        if (this.running) this.timer = setTimeout(loop, interval);
      }
    };
    void loop();
  }

  /** Stop the loop. In-flight dispatches complete; no new tick starts. */
  stop(): void {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }
}

/** Run `fn` over items with a bounded concurrency, preserving input order. */
async function runWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const i = cursor++;
      if (i >= items.length) return;
      results[i] = await fn(items[i]!);
    }
  });
  await Promise.all(workers);
  return results;
}
