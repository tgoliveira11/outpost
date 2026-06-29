import type { CoreDeps } from "../application/context.js";
import { PurgeRetention, type PurgeReport } from "../application/purge-retention.js";

export interface RetentionWorkerOptions {
  /** Loop interval, ms. Default 1 hour. Retention is not latency-sensitive. */
  readonly intervalMs?: number;
}

/**
 * RetentionWorker — periodically enforces the retention/purge policy
 * (TDR §3.9). Like the send worker it offers both a long-running `start()`
 * loop and a single `tick()` for cron/route-handler deployments. It only ever
 * touches terminal, aged rows, so it is safe to run alongside the send worker.
 */
export class RetentionWorker {
  private readonly purge: PurgeRetention;
  private running = false;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly deps: CoreDeps,
    private readonly options: RetentionWorkerOptions = {},
  ) {
    this.purge = new PurgeRetention(deps);
  }

  async tick(): Promise<PurgeReport> {
    return this.purge.execute();
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    const interval = this.options.intervalMs ?? 60 * 60 * 1000;
    const loop = async () => {
      if (!this.running) return;
      try {
        await this.tick();
      } catch (err) {
        this.deps.logger.log("error", "retention worker tick failed", {
          error: err instanceof Error ? err.message : String(err),
        });
      } finally {
        if (this.running) this.timer = setTimeout(loop, interval);
      }
    };
    void loop();
  }

  stop(): void {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }
}
