import type { CoreDeps } from "./context.js";
import type { SuppressionEntry, SuppressionReason } from "../domain/suppression.js";

/**
 * ManageSuppression — view/add/remove suppression entries (TDR §3.6).
 *
 * All matching is by recipient HMAC, so the plaintext address is hashed with
 * the same keyed HMAC used at ingestion. Adds/removes are audited.
 */
export class ManageSuppression {
  constructor(private readonly deps: CoreDeps) {}

  async isSuppressed(address: string): Promise<boolean> {
    return this.deps.suppressions.isSuppressed(this.deps.recipientHasher.hash(address));
  }

  /** Lookup by precomputed HMAC (the form the HTTP API exposes). */
  async getByHmac(recipientHmac: string): Promise<SuppressionEntry | null> {
    return this.deps.suppressions.get(recipientHmac);
  }

  async suppress(
    address: string,
    reason: SuppressionReason,
    actor: string,
    note?: string,
  ): Promise<SuppressionEntry> {
    const recipientHmac = this.deps.recipientHasher.hash(address);
    const entry = await this.deps.suppressions.add({ recipientHmac, reason, createdBy: actor, note });
    await this.deps.audit.append({
      messageId: null,
      eventType: "suppressed",
      actor,
      detail: { recipientHmac, reason },
    });
    this.deps.telemetry.counter("outpost.suppression.added", 1, { reason });
    return entry;
  }

  /** Remove by HMAC (what the DELETE endpoint receives). Audited. */
  async unsuppressByHmac(recipientHmac: string, actor: string): Promise<boolean> {
    const removed = await this.deps.suppressions.remove(recipientHmac);
    if (removed) {
      await this.deps.audit.append({
        messageId: null,
        eventType: "unsuppressed",
        actor,
        detail: { recipientHmac },
      });
    }
    return removed;
  }

  async list(limit = 100, offset = 0): Promise<SuppressionEntry[]> {
    return this.deps.suppressions.list(limit, offset);
  }
}
