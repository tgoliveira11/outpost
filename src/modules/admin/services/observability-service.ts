import type { Outpost } from "../../../client/outpost-client.js";
import type { LifecycleState } from "../../../domain/lifecycle.js";
import type { DispatchOutcome } from "../../../application/dispatch-message.js";

export type WorkerRunSummary = {
  readonly at: string;
  readonly claimed: number;
  readonly sent: number;
  readonly retried: number;
  readonly failed: number;
  readonly rateLimited: number;
};

export type MetricCatalogEntry = {
  readonly name: string;
  readonly type: "counter" | "gauge";
  readonly description: string;
};

const METRIC_CATALOG: readonly MetricCatalogEntry[] = [
  { name: "outpost.enqueue.queued", type: "counter", description: "Message enqueued as queued" },
  { name: "outpost.enqueue.suppressed", type: "counter", description: "Enqueue blocked by suppression list" },
  { name: "outpost.enqueue.deduplicated", type: "counter", description: "Duplicate idempotency key" },
  { name: "outpost.dispatch.sent", type: "counter", description: "Provider accepted a send" },
  { name: "outpost.dispatch.retry", type: "counter", description: "Transient failure re-queued" },
  { name: "outpost.dispatch.rate_limited", type: "counter", description: "Rate-limit budget re-queued" },
  { name: "outpost.dispatch.failed", type: "counter", description: "Dead-lettered" },
  { name: "outpost.suppression.added", type: "counter", description: "Address suppressed" },
  { name: "outpost.webhook.received", type: "counter", description: "Verified webhook recorded" },
  { name: "outpost.send.claimed", type: "gauge", description: "Rows claimed per send-worker tick" },
  { name: "outpost.retention.operational_processed", type: "gauge", description: "Outbox rows redacted/deleted per retention cycle" },
  { name: "outpost.retention.audit_deleted", type: "gauge", description: "Audit rows deleted per retention cycle" },
];

let lastWorkerRun: WorkerRunSummary | null = null;

function summarizeOutcomes(outcomes: readonly DispatchOutcome[]): Pick<WorkerRunSummary, "sent" | "retried" | "failed" | "rateLimited"> {
  let sent = 0;
  let retried = 0;
  let failed = 0;
  let rateLimited = 0;
  for (const o of outcomes) {
    if (o.kind === "sent") sent++;
    else if (o.kind === "retry") retried++;
    else if (o.kind === "failed") failed++;
    else if (o.kind === "rate_limited") rateLimited++;
  }
  return { sent, retried, failed, rateLimited };
}

export function createObservabilityService(outpost: Outpost) {
  return {
    async getSnapshot() {
      const countsByState = await outpost.deps.outbox.countByState();
      const suppressions = await outpost.deps.suppressions.list(10_000, 0);
      return {
        countsByState,
        suppressionCount: suppressions.length,
        lastWorkerRun,
        metrics: METRIC_CATALOG,
      };
    },

    recordWorkerRun(claimed: number, outcomes: readonly DispatchOutcome[]) {
      lastWorkerRun = {
        at: new Date().toISOString(),
        claimed,
        ...summarizeOutcomes(outcomes),
      };
      return lastWorkerRun;
    },

    /** Test helper */
    _resetLastWorkerRun() {
      lastWorkerRun = null;
    },
  };
}

export type ObservabilityService = ReturnType<typeof createObservabilityService>;

export type { LifecycleState };
