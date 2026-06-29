import { DEFAULT_RETRY } from "../../../application/pipeline/retry-policy.js";
import { DEFAULT_RETENTION } from "../../../domain/retention.js";
import { DEFAULT_SANITIZE_LIMITS } from "../../../application/pipeline/sanitize.js";
import { DEFAULT_DOMAIN_VALIDATION } from "../../../application/pipeline/domain-validation.js";

export type ConfigKeyMeta = {
  readonly key: string;
  readonly secret?: boolean;
  readonly defaultValue?: unknown;
  readonly envVar?: string;
};

/** Keys exposed in the admin config screen — mirrors `.env.example` + `createOutpost` tunables. */
export const OUTPOST_CONFIG_KEYS: readonly ConfigKeyMeta[] = [
  { key: "database.url", secret: true, envVar: "DATABASE_URL" },
  { key: "recipientHmacKey", secret: true, envVar: "OUTPOST_HMAC_KEY" },
  { key: "providers.resend.apiKey", secret: true, envVar: "RESEND_API_KEY" },
  { key: "providers.resend.webhookSecret", secret: true, envVar: "RESEND_WEBHOOK_SECRET" },
  { key: "encryption.mode", defaultValue: "none" },
  { key: "encryption.symmetricKey", secret: true, envVar: "OUTPOST_ENCRYPTION_KEY" },
  { key: "encryption.publicKey", secret: true, envVar: "OUTPOST_ENCRYPTION_PUBLIC_KEY" },
  { key: "encryption.privateKey", secret: true, envVar: "OUTPOST_ENCRYPTION_PRIVATE_KEY" },
  { key: "sendBatchSize", defaultValue: 50 },
  { key: "staleSendingLeaseMs", defaultValue: 5 * 60 * 1000 },
  { key: "retry.maxAttempts", defaultValue: DEFAULT_RETRY.maxAttempts },
  { key: "retry.baseDelayMs", defaultValue: DEFAULT_RETRY.baseDelayMs },
  { key: "retry.maxDelayMs", defaultValue: DEFAULT_RETRY.maxDelayMs },
  { key: "retention.operationalTtlDays", defaultValue: DEFAULT_RETENTION.operationalTtlDays },
  { key: "retention.auditTtlDays", defaultValue: DEFAULT_RETENTION.auditTtlDays },
  { key: "retention.redactOnPurge", defaultValue: DEFAULT_RETENTION.redactOnPurge },
  { key: "retention.webhookWindowHours", defaultValue: DEFAULT_RETENTION.webhookWindowHours },
  { key: "retention.batchSize", defaultValue: DEFAULT_RETENTION.batchSize },
  { key: "sanitize.maxSubjectBytes", defaultValue: DEFAULT_SANITIZE_LIMITS.maxSubjectBytes },
  { key: "sanitize.maxBodyBytes", defaultValue: DEFAULT_SANITIZE_LIMITS.maxBodyBytes },
  { key: "sanitize.maxRecipientBytes", defaultValue: DEFAULT_SANITIZE_LIMITS.maxRecipientBytes },
  { key: "sanitize.maxHeaderValueBytes", defaultValue: DEFAULT_SANITIZE_LIMITS.maxHeaderValueBytes },
  { key: "domainValidation.syntax", defaultValue: DEFAULT_DOMAIN_VALIDATION.syntax },
  { key: "domainValidation.mx", defaultValue: DEFAULT_DOMAIN_VALIDATION.mx },
] as const;

export const OVERRIDABLE_KEYS = new Set(OUTPOST_CONFIG_KEYS.map((k) => k.key));

export function getConfigKeyMeta(key: string): ConfigKeyMeta | undefined {
  return OUTPOST_CONFIG_KEYS.find((k) => k.key === key);
}

export function maskSecretValue(value: unknown): string {
  if (value === undefined || value === null || value === "") return "—";
  const s = String(value);
  if (s.length <= 4) return "••••";
  return `${s.slice(0, 2)}••••${s.slice(-2)}`;
}

function setNestedPath(obj: Record<string, unknown>, path: string, value: unknown): void {
  const parts = path.split(".");
  let current: Record<string, unknown> = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    const part = parts[i]!;
    const next = current[part];
    if (!next || typeof next !== "object") {
      current[part] = {};
    }
    current = current[part] as Record<string, unknown>;
  }
  current[parts[parts.length - 1]!] = value;
}

function getNestedValue(obj: unknown, path: string): unknown {
  const parts = path.split(".");
  let current: unknown = obj;
  for (const part of parts) {
    if (current === null || current === undefined || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

/** Flat env map (key → value) built by the consumer from process.env / .env.local. */
export function envRecordToConfig(env: Record<string, string | undefined>): Record<string, unknown> {
  const config: Record<string, unknown> = {};
  for (const meta of OUTPOST_CONFIG_KEYS) {
    if (!meta.envVar) continue;
    const raw = env[meta.envVar];
    if (raw !== undefined && raw !== "") {
      setNestedPath(config, meta.key, raw);
    }
  }
  return config;
}

export { getNestedValue, setNestedPath };
