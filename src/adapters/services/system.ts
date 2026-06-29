import { randomUUID } from "node:crypto";
import { resolveMx as dnsResolveMx } from "node:dns/promises";
import type { Clock, IdGenerator } from "../../ports/services.js";
import type { MxResolver } from "../../application/pipeline/domain-validation.js";

/** Real wall-clock. Inject a fake `Clock` in tests for determinism. */
export class SystemClock implements Clock {
  now(): Date {
    return new Date();
  }
}

/** UUID v4 ids via node:crypto. */
export class UuidGenerator implements IdGenerator {
  generate(): string {
    return randomUUID();
  }
}

/** MX resolver backed by node:dns. Used only when domainValidation.mx is on. */
export class DnsMxResolver implements MxResolver {
  async resolveMx(domain: string): Promise<string[]> {
    const records = await dnsResolveMx(domain);
    return records
      .sort((a, b) => a.priority - b.priority)
      .map((r) => r.exchange);
  }
}
