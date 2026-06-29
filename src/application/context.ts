import type {
  OutboxRepository,
  SuppressionRepository,
  AuditRepository,
  ApiKeyRepository,
  WebhookEventRepository,
} from "../ports/repositories.js";
import type { EmailProvider } from "../ports/email-provider.js";
import type { Encryptor, RecipientHasher } from "../ports/crypto.js";
import type {
  RateLimiter,
  Clock,
  IdGenerator,
  Logger,
  Telemetry,
} from "../ports/services.js";
import type { TemplateRenderer } from "../ports/template.js";
import type { MxResolver } from "./pipeline/domain-validation.js";
import type { ResolvedConfig } from "./config.js";

/**
 * The dependency container the use cases receive (composed at the edge by
 * `createOutpost`). This is the seam where Clean Architecture's Dependency
 * Inversion is realized: use cases only ever touch these interfaces.
 *
 * Note the deliberate split between `sealEncryptor` and `openEncryptor`:
 * the ingestion side is wired with a seal-only encryptor (public key) and the
 * send worker with an open-capable one (private key). In a single-process
 * deployment they may be the same symmetric instance; in the asymmetric
 * least-privilege deployment they are different (TDR §5.4).
 */
export interface CoreDeps {
  readonly config: ResolvedConfig;

  // Persistence ports
  readonly outbox: OutboxRepository;
  readonly suppressions: SuppressionRepository;
  readonly audit: AuditRepository;
  readonly apiKeys: ApiKeyRepository;
  readonly webhookEvents: WebhookEventRepository;

  // Transport — keyed by provider name; the message carries which to use.
  readonly providers: ReadonlyMap<string, EmailProvider>;
  /** Provider name used when an enqueue does not specify one. */
  readonly defaultProvider: string;

  // Crypto
  /** Write-side encryptor (public key in the asymmetric model). */
  readonly sealEncryptor: Encryptor;
  /** Read-side encryptor (private key). Only the send worker needs this. */
  readonly openEncryptor: Encryptor;
  readonly recipientHasher: RecipientHasher;

  // Services
  readonly rateLimiter: RateLimiter;
  readonly clock: Clock;
  readonly ids: IdGenerator;
  readonly logger: Logger;
  readonly telemetry: Telemetry;

  // Optional capabilities
  readonly templates?: TemplateRenderer;
  readonly mxResolver?: MxResolver;
  /** Pluggable strong HTML sanitizer; falls back to the built-in stripper. */
  readonly sanitizeHtml?: (html: string) => string;
  /** Random sample in [0,1) for retry jitter. Injected for testability. */
  readonly random: () => number;
}
