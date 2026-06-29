import type { CoreDeps } from "./context.js";
import { purgeCutoff } from "../domain/retention.js";

export interface PurgeReport {
  /** Outbox rows whose PII was redacted (or deleted if redactOnPurge=false). */
  readonly operationalProcessed: number;
  /** Audit rows deleted. */
  readonly auditDeleted: number;
  readonly redacted: boolean;
}

/**
 * PurgeRetention — the executor of the data-minimization policy (TDR §3.9, §5.5).
 *
 * Safety properties baked in here:
 *   - Acts ONLY on terminal rows older than the operational TTL AND past the
 *     webhook window (`purgeCutoff`). Never touches `sent`/non-terminal rows,
 *     so it can run concurrently with the send worker.
 *   - Default action is REDACTION (wipe PII, keep audit metadata), not deletion.
 *   - Works in batches with pauses to avoid long-held table locks.
 *   - Logs counts per cycle so operators can detect "stopped cleaning" and
 *     "cleaning too much".
 */
export class PurgeRetention {
  constructor(private readonly deps: CoreDeps) {}

  async execute(): Promise<PurgeReport> {
    const { deps } = this;
    return deps.telemetry.span("outpost.retention.purge", {}, async () => {
      const now = deps.clock.now();
      const policy = deps.config.retention;
      const cutoff = purgeCutoff(policy, now);

      // 1. Operational data: redact or delete terminal+aged rows, batched.
      let operationalProcessed = 0;
      for (;;) {
        const batch = await deps.outbox.claimTerminalForPurge(cutoff, policy.batchSize);
        if (batch.length === 0) break;
        const ids = batch.map((m) => m.id);
        const count = policy.redactOnPurge
          ? await deps.outbox.redactBatch(ids)
          : await deps.outbox.deleteBatch(ids);
        operationalProcessed += count;

        await deps.audit.append({
          messageId: null,
          eventType: policy.redactOnPurge ? "redacted" : "purged",
          actor: "system:retention",
          detail: { count, cutoff: cutoff.toISOString() },
        });
        // Stop if the repo returned a short batch (no more eligible rows).
        if (batch.length < policy.batchSize) break;
      }

      // 2. Audit data: independent, longer TTL.
      const auditCutoff = new Date(now.getTime() - policy.auditTtlDays * 24 * 60 * 60 * 1000);
      const auditDeleted = await deps.audit.purgeOlderThan(auditCutoff, policy.batchSize);

      deps.telemetry.gauge("outpost.retention.operational_processed", operationalProcessed);
      deps.telemetry.gauge("outpost.retention.audit_deleted", auditDeleted);
      deps.logger.log("info", "retention cycle complete", {
        operationalProcessed,
        auditDeleted,
        redacted: policy.redactOnPurge,
      });

      return { operationalProcessed, auditDeleted, redacted: policy.redactOnPurge };
    });
  }
}
