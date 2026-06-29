import type { CoreDeps } from "./application/context.js";
import { resolveConfig, type ConfigOverrides, type RateLimitConfig } from "./application/config.js";
import { Outpost } from "./client/outpost-client.js";
import type {
  OutboxRepository,
  SuppressionRepository,
  AuditRepository,
  ApiKeyRepository,
  WebhookEventRepository,
} from "./ports/repositories.js";
import type { EmailProvider } from "./ports/email-provider.js";
import type { Encryptor } from "./ports/crypto.js";
import type { Clock, IdGenerator, Logger, Telemetry, RateLimiter } from "./ports/services.js";
import type { TemplateRenderer } from "./ports/template.js";
import type { MxResolver } from "./application/pipeline/domain-validation.js";

import { HmacRecipientHasher } from "./adapters/crypto/recipient-hasher.js";
import {
  NoopEncryptor,
  AesGcmEncryptor,
  HybridSealEncryptor,
  HybridOpenEncryptor,
} from "./adapters/crypto/encryptors.js";
import { InMemoryRateLimiter, UnlimitedRateLimiter } from "./adapters/rate-limit/in-memory.js";
import { SystemClock, UuidGenerator, DnsMxResolver } from "./adapters/services/system.js";
import { ConsoleLogger } from "./adapters/observability/logger.js";
import { NoopTelemetry } from "./adapters/observability/telemetry.js";

/**
 * Encryption posture (TDR §5.4). Pick one:
 *
 *   - `none`        — encryption disabled (`alg: "plain"`). Dev default.
 *   - `symmetric`   — AES-256-GCM; one 32-byte key seals and opens. Simple,
 *                     single-process. Key MUST come from KMS/secrets.
 *   - `asymmetric`  — least-privilege split: the web tier seals with the
 *                     PUBLIC key and can never read back; the send worker opens
 *                     with the PRIVATE key. Omit `privateKey` on the web tier.
 *   - bring-your-own `Encryptor` pair — back it with AWS KMS / GCP KMS / Vault.
 */
export type EncryptionOptions =
  | { mode: "none" }
  | { mode: "symmetric"; key: Buffer | string; keyId?: string }
  | { mode: "asymmetric"; publicKey: string; privateKey?: string; keyId?: string }
  | { sealEncryptor: Encryptor; openEncryptor: Encryptor };

export interface OutpostOptions extends ConfigOverrides {
  /**
   * Persistence. Build these from your Drizzle db via the helpers in
   * `@tgoliveira/outpost/drizzle`, or use the in-memory ones from
   * `@tgoliveira/outpost/testing`.
   */
  repositories: {
    outbox: OutboxRepository;
    suppressions: SuppressionRepository;
    audit: AuditRepository;
    apiKeys: ApiKeyRepository;
    webhookEvents: WebhookEventRepository;
  };

  /** One or more transport adapters. The first is the default unless overridden. */
  providers: EmailProvider[];
  defaultProvider?: string;

  /**
   * Key for the deterministic recipient HMAC (TDR §5.4). REQUIRED — it backs
   * suppression matching and recipient-keyed lookups even when encryption is
   * off. Must be ≥16 bytes of entropy and live OUTSIDE the database.
   */
  recipientHmacKey: string | Buffer;

  /** Encryption-at-rest posture. Defaults to `{ mode: "none" }`. */
  encryption?: EncryptionOptions;

  rateLimits?: RateLimitConfig;

  /** Template renderer (e.g. InMemoryTemplateRenderer). Optional. */
  templates?: TemplateRenderer;

  /** Pre-built telemetry. For OTel: `telemetry: await OtelTelemetry.create()`. */
  telemetry?: Telemetry;
  logger?: Logger;
  clock?: Clock;
  ids?: IdGenerator;
  rateLimiter?: RateLimiter;
  mxResolver?: MxResolver;
  /** Strong HTML sanitizer (e.g. sanitize-html). Falls back to a built-in. */
  sanitizeHtml?: (html: string) => string;
  /** Random source for retry jitter. Defaults to Math.random. */
  random?: () => number;
  /** Default audit actor for programmatic calls. Default "programmatic". */
  defaultActor?: string;
}

/**
 * Composition root (TDR §6, Dependency Inversion). Resolves config, wires the
 * adapters into a `CoreDeps`, and returns the high-level `Outpost` client.
 *
 * This is the ONLY place concrete adapters are assembled — everything inward
 * depends on ports. Swapping a provider, storage backend, or KMS is a change
 * here, never in the core.
 */
export function createOutpost(options: OutpostOptions): Outpost {
  const config = resolveConfig({
    retry: options.retry,
    retention: options.retention,
    sanitize: options.sanitize,
    attachments: options.attachments,
    domainValidation: options.domainValidation,
    rateLimits: options.rateLimits,
    sendBatchSize: options.sendBatchSize,
  });

  if (options.providers.length === 0) {
    throw new Error("createOutpost requires at least one provider");
  }
  const providers = new Map<string, EmailProvider>();
  for (const p of options.providers) providers.set(p.name, p);
  const defaultProvider = options.defaultProvider ?? options.providers[0]!.name;
  if (!providers.has(defaultProvider)) {
    throw new Error(`defaultProvider "${defaultProvider}" is not in the providers list`);
  }

  const { sealEncryptor, openEncryptor } = resolveEncryption(options.encryption ?? { mode: "none" });
  const recipientHasher = new HmacRecipientHasher(options.recipientHmacKey);

  const clock: Clock = options.clock ?? new SystemClock();
  const rateLimiter: RateLimiter =
    options.rateLimiter ??
    (options.rateLimits ? new InMemoryRateLimiter(options.rateLimits, clock) : new UnlimitedRateLimiter());

  const deps: CoreDeps = {
    config,
    outbox: options.repositories.outbox,
    suppressions: options.repositories.suppressions,
    audit: options.repositories.audit,
    apiKeys: options.repositories.apiKeys,
    webhookEvents: options.repositories.webhookEvents,
    providers,
    defaultProvider,
    sealEncryptor,
    openEncryptor,
    recipientHasher,
    rateLimiter,
    clock,
    ids: options.ids ?? new UuidGenerator(),
    logger: options.logger ?? new ConsoleLogger(),
    telemetry: options.telemetry ?? new NoopTelemetry(),
    templates: options.templates,
    mxResolver:
      options.mxResolver ?? (config.domainValidation.mx ? new DnsMxResolver() : undefined),
    sanitizeHtml: options.sanitizeHtml,
    random: options.random ?? Math.random,
  };

  return new Outpost(deps, options.defaultActor);
}

function resolveEncryption(enc: EncryptionOptions): {
  sealEncryptor: Encryptor;
  openEncryptor: Encryptor;
} {
  if ("sealEncryptor" in enc) {
    return { sealEncryptor: enc.sealEncryptor, openEncryptor: enc.openEncryptor };
  }
  switch (enc.mode) {
    case "none": {
      const noop = new NoopEncryptor();
      return { sealEncryptor: noop, openEncryptor: noop };
    }
    case "symmetric": {
      const key = typeof enc.key === "string" ? Buffer.from(enc.key, "base64") : enc.key;
      const e = new AesGcmEncryptor(key, enc.keyId);
      return { sealEncryptor: e, openEncryptor: e };
    }
    case "asymmetric": {
      const seal = new HybridSealEncryptor(enc.publicKey, enc.keyId);
      // No private key (web tier) → an opener that refuses, preserving the
      // "web tier cannot read" invariant.
      const open = enc.privateKey ? new HybridOpenEncryptor(enc.privateKey) : seal;
      return { sealEncryptor: seal, openEncryptor: open };
    }
  }
}
