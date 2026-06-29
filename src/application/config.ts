import { DEFAULT_RETRY, type RetryConfig } from "./pipeline/retry-policy.js";
import {
  DEFAULT_SANITIZE_LIMITS,
  DEFAULT_ATTACHMENT_POLICY,
  type SanitizeLimits,
  type AttachmentPolicy,
} from "./pipeline/sanitize.js";
import {
  DEFAULT_DOMAIN_VALIDATION,
  type DomainValidationConfig,
} from "./pipeline/domain-validation.js";
import { DEFAULT_RETENTION, type RetentionPolicy } from "../domain/retention.js";

/**
 * Layered rate-limit budgets (TDR §3.2 step 4). Each is a token-bucket-style
 * "max events per window". The in-memory limiter and any external limiter share
 * this shape via the `RateLimiter` port.
 */
export interface RateLimitConfig {
  /** Global ceiling across all providers/recipients. */
  readonly global?: RateBudget;
  /** Per-provider ceiling, keyed by provider name. */
  readonly perProvider?: RateBudget;
  /** Per recipient-domain ceiling. */
  readonly perRecipientDomain?: RateBudget;
}

export interface RateBudget {
  readonly max: number;
  readonly windowMs: number;
}

/** Fully-resolved internal config — every field defaulted, no optionals. */
export interface ResolvedConfig {
  readonly retry: RetryConfig;
  readonly retention: RetentionPolicy;
  readonly sanitize: SanitizeLimits;
  readonly attachments: AttachmentPolicy;
  readonly domainValidation: DomainValidationConfig;
  readonly rateLimits: RateLimitConfig;
  /** Max rows the send worker claims per poll. */
  readonly sendBatchSize: number;
  /**
   * Lease window for `sending` rows, ms. A row left in `sending` longer than
   * this is treated as abandoned (its worker crashed mid-dispatch) and is
   * reclaimed by the next poll. Keep comfortably larger than a real dispatch.
   */
  readonly staleSendingLeaseMs: number;
}

export interface ConfigOverrides {
  retry?: Partial<RetryConfig>;
  retention?: Partial<RetentionPolicy>;
  sanitize?: Partial<SanitizeLimits>;
  attachments?: Partial<AttachmentPolicy>;
  domainValidation?: Partial<Omit<DomainValidationConfig, "mailboxProbe">>;
  rateLimits?: RateLimitConfig;
  sendBatchSize?: number;
  staleSendingLeaseMs?: number;
}

export function resolveConfig(overrides: ConfigOverrides = {}): ResolvedConfig {
  return {
    retry: { ...DEFAULT_RETRY, ...overrides.retry },
    retention: { ...DEFAULT_RETENTION, ...overrides.retention },
    sanitize: { ...DEFAULT_SANITIZE_LIMITS, ...overrides.sanitize },
    attachments: { ...DEFAULT_ATTACHMENT_POLICY, ...overrides.attachments },
    domainValidation: {
      ...DEFAULT_DOMAIN_VALIDATION,
      ...overrides.domainValidation,
      mailboxProbe: false,
    },
    rateLimits: overrides.rateLimits ?? {},
    sendBatchSize: overrides.sendBatchSize ?? 50,
    staleSendingLeaseMs: overrides.staleSendingLeaseMs ?? 5 * 60 * 1000,
  };
}
