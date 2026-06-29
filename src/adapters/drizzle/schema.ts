import {
  pgTable,
  pgEnum,
  uuid,
  text,
  integer,
  boolean,
  jsonb,
  timestamp,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import type { Sealed } from "../../domain/message.js";
import type { LifecycleState } from "../../domain/lifecycle.js";
import type { SuppressionReason } from "../../domain/suppression.js";
import type { ApiScope } from "../../domain/api-key.js";

/**
 * Drizzle/PostgreSQL schema (TDR §7).
 *
 * PII columns (`recipient_sealed`, `body_sealed`) hold the `Sealed` envelope as
 * JSONB — ciphertext when encryption is on, base64 plaintext (`alg: "plain"`)
 * otherwise, so the column shape never changes. Index columns (`state`,
 * `next_attempt_at`, `recipient_hmac`, `idempotency_key`) stay clear so the
 * polling worker and suppression lookups remain functional (TDR §5.4).
 *
 * Generate a migration from this schema with drizzle-kit (see docs/database.md).
 */

export const lifecycleStateEnum = pgEnum("outpost_lifecycle_state", [
  "queued",
  "sending",
  "sent",
  "delivered",
  "bounced",
  "complained",
  "failed",
  "suppressed",
]);

export const suppressionReasonEnum = pgEnum("outpost_suppression_reason", [
  "hard_bounce",
  "complaint",
  "unsubscribe",
  "invalid",
  "manual",
]);

export const outbox = pgTable(
  "outpost_outbox",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    idempotencyKey: text("idempotency_key").notNull(),
    state: lifecycleStateEnum("state").notNull().default("queued").$type<LifecycleState>(),
    recipientHmac: text("recipient_hmac").notNull(),
    recipientSealed: jsonb("recipient_sealed").notNull().$type<Sealed>(),
    bodySealed: jsonb("body_sealed").notNull().$type<Sealed>(),
    subject: text("subject").notNull(),
    templateId: text("template_id"),
    templateVersion: integer("template_version"),
    provider: text("provider").notNull(),
    metadata: jsonb("metadata").notNull().default({}).$type<Record<string, unknown>>(),
    attempts: integer("attempts").notNull().default(0),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }).notNull().defaultNow(),
    scheduledFor: timestamp("scheduled_for", { withTimezone: true }),
    providerMessageId: text("provider_message_id"),
    lastError: text("last_error"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    idempotencyKeyUq: uniqueIndex("outpost_outbox_idempotency_key_uq").on(t.idempotencyKey),
    // Drives the polling send worker's claim query.
    pollIdx: index("outpost_outbox_poll_idx").on(t.state, t.nextAttemptAt),
    recipientHmacIdx: index("outpost_outbox_recipient_hmac_idx").on(t.recipientHmac),
    providerMessageIdIdx: index("outpost_outbox_provider_message_id_idx").on(t.providerMessageId),
  }),
);

export const auditEvents = pgTable(
  "outpost_audit_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    messageId: uuid("message_id"),
    eventType: text("event_type").notNull(),
    actor: text("actor").notNull(),
    detail: jsonb("detail").$type<Record<string, unknown> | null>(),
    at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    messageIdIdx: index("outpost_audit_message_id_idx").on(t.messageId),
    atIdx: index("outpost_audit_at_idx").on(t.at),
  }),
);

export const suppressions = pgTable("outpost_suppressions", {
  recipientHmac: text("recipient_hmac").primaryKey(),
  reason: suppressionReasonEnum("reason").notNull().$type<SuppressionReason>(),
  createdBy: text("created_by").notNull(),
  note: text("note"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const webhookEvents = pgTable(
  "outpost_webhook_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    provider: text("provider").notNull(),
    type: text("type").notNull(),
    providerMessageId: text("provider_message_id").notNull(),
    recipient: text("recipient"),
    isHardBounce: boolean("is_hard_bounce"),
    occurredAt: timestamp("occurred_at", { withTimezone: true }),
    raw: jsonb("raw").notNull(),
    receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    providerMessageIdIdx: index("outpost_webhook_provider_message_id_idx").on(t.providerMessageId),
  }),
);

export const apiKeys = pgTable(
  "outpost_api_keys",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    label: text("label").notNull(),
    keyHash: text("key_hash").notNull(),
    scopes: jsonb("scopes").notNull().$type<ApiScope[]>(),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
  },
  (t) => ({
    keyHashUq: uniqueIndex("outpost_api_keys_key_hash_uq").on(t.keyHash),
  }),
);

export const adminConfigOverrides = pgTable("outpost_admin_config_overrides", {
  key: text("key").primaryKey(),
  value: jsonb("value").notNull(),
  updatedBy: text("updated_by"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/** The full schema object — pass to `drizzle(client, { schema })`. */
export const outpostSchema = {
  outbox,
  auditEvents,
  suppressions,
  webhookEvents,
  apiKeys,
  adminConfigOverrides,
  lifecycleStateEnum,
  suppressionReasonEnum,
};

export type OutboxRow = typeof outbox.$inferSelect;
export type AuditRow = typeof auditEvents.$inferSelect;
export type SuppressionRow = typeof suppressions.$inferSelect;
export type WebhookRow = typeof webhookEvents.$inferSelect;
export type ApiKeyRow = typeof apiKeys.$inferSelect;
export type AdminConfigOverrideRow = typeof adminConfigOverrides.$inferSelect;
