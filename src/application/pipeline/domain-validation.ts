import { ValidationError } from "../../domain/errors.js";

/**
 * Recipient domain validation (TDR §3.2 step 3, §3.10, decision #4).
 *
 * Two checks, in order of cost:
 *   1. Syntax — always on. RFC-5322-ish address shape.
 *   2. MX records — optional, cached. Confirms the domain can receive mail.
 *
 * Outpost deliberately does NOT probe whether an individual mailbox exists:
 * it is unreliable and damages sender reputation (decision #4).
 */

export interface DomainValidationConfig {
  readonly syntax: boolean;
  readonly mx: boolean;
  readonly mailboxProbe: false; // typed as a constant: never supported
  /** TTL for the MX-result cache, ms. */
  readonly mxCacheTtlMs?: number;
}

export const DEFAULT_DOMAIN_VALIDATION: DomainValidationConfig = {
  syntax: true,
  mx: false,
  mailboxProbe: false,
  mxCacheTtlMs: 60 * 60 * 1000,
};

/**
 * Pluggable MX resolver so the core stays free of `node:dns`. The default
 * resolver (provided in adapters) uses `dns/promises`. Returns the MX hosts.
 */
export interface MxResolver {
  resolveMx(domain: string): Promise<string[]>;
}

// Pragmatic, conservative address syntax check. Not a full RFC 5322 grammar
// (that grammar admits forms no provider accepts); this matches what real
// transactional senders use.
const ADDR_RE = /^[^\s@"]+(?:\.[^\s@"]+)*@([a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+)$/;

export function extractDomain(address: string): string {
  const at = address.lastIndexOf("@");
  if (at < 0) throw new ValidationError("Address has no domain part");
  return address.slice(at + 1).toLowerCase();
}

export function validateSyntax(address: string): string {
  const m = ADDR_RE.exec(address);
  if (!m) throw new ValidationError(`Recipient "${address}" is not a valid email address`);
  return m[1]!.toLowerCase(); // the domain
}

/** Small in-process TTL cache for MX results to avoid hammering DNS. */
export class MxCache {
  private readonly entries = new Map<string, { hosts: string[]; expiresAt: number }>();
  constructor(private readonly ttlMs: number) {}

  get(domain: string, nowMs: number): string[] | undefined {
    const e = this.entries.get(domain);
    if (!e) return undefined;
    if (e.expiresAt <= nowMs) {
      this.entries.delete(domain);
      return undefined;
    }
    return e.hosts;
  }

  set(domain: string, hosts: string[], nowMs: number): void {
    this.entries.set(domain, { hosts, expiresAt: nowMs + this.ttlMs });
  }
}

/**
 * Full recipient validation. `syntax` is enforced synchronously; `mx`, when
 * enabled, resolves (cached) and throws if the domain has no usable MX (and no
 * fallback A record — many small domains accept mail on the A record).
 */
export async function validateRecipient(
  address: string,
  config: DomainValidationConfig,
  deps: { mxResolver?: MxResolver; mxCache?: MxCache; nowMs: number },
): Promise<void> {
  if (config.syntax) {
    const domain = validateSyntax(address);
    if (config.mx && deps.mxResolver) {
      const cached = deps.mxCache?.get(domain, deps.nowMs);
      let hosts = cached;
      if (hosts === undefined) {
        try {
          hosts = await deps.mxResolver.resolveMx(domain);
        } catch {
          hosts = [];
        }
        deps.mxCache?.set(domain, hosts, deps.nowMs);
      }
      if (hosts.length === 0) {
        throw new ValidationError(`Recipient domain "${domain}" has no MX records`);
      }
    }
  }
}
