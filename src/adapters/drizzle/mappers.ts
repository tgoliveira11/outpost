import type { Message } from "../../domain/message.js";
import type { SuppressionEntry } from "../../domain/suppression.js";
import type { ApiKey } from "../../domain/api-key.js";
import type { AuditEvent } from "../../domain/audit.js";
import type { OutboxRow, SuppressionRow, ApiKeyRow, AuditRow } from "./schema.js";

/** Row → domain mappers. Keep DB shape isolated from the domain. */

export function rowToMessage(r: OutboxRow): Message {
  return {
    id: r.id,
    idempotencyKey: r.idempotencyKey,
    state: r.state,
    recipientHmac: r.recipientHmac,
    recipientSealed: r.recipientSealed,
    bodySealed: r.bodySealed,
    subject: r.subject,
    templateId: r.templateId,
    templateVersion: r.templateVersion,
    provider: r.provider,
    metadata: r.metadata,
    attempts: r.attempts,
    nextAttemptAt: r.nextAttemptAt,
    scheduledFor: r.scheduledFor,
    providerMessageId: r.providerMessageId,
    lastError: r.lastError,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  };
}

export function rowToSuppression(r: SuppressionRow): SuppressionEntry {
  return {
    recipientHmac: r.recipientHmac,
    reason: r.reason,
    createdBy: r.createdBy,
    createdAt: r.createdAt,
    note: r.note ?? undefined,
  };
}

export function rowToApiKey(r: ApiKeyRow): ApiKey {
  return {
    id: r.id,
    label: r.label,
    keyHash: r.keyHash,
    scopes: r.scopes,
    expiresAt: r.expiresAt,
    revokedAt: r.revokedAt,
    createdAt: r.createdAt,
    lastUsedAt: r.lastUsedAt,
  };
}

export function rowToAuditEvent(r: AuditRow): AuditEvent {
  return {
    id: r.id,
    messageId: r.messageId,
    eventType: r.eventType as AuditEvent["eventType"],
    actor: r.actor,
    detail: r.detail ?? null,
    at: r.at,
  };
}
