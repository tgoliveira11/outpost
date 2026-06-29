import type { CoreDeps } from "./context.js";
import type { Message } from "../domain/message.js";
import type { ListMessagesQuery } from "../ports/repositories.js";
import { NotFoundError, InvalidStateTransitionError } from "../domain/errors.js";
import { canTransition } from "../domain/lifecycle.js";

/**
 * A safe, PII-free projection of a message for read APIs and the admin panel.
 * Operators see metadata and lifecycle, NOT the encrypted body/recipient.
 * Body access is a separate, gated, audited operation (not exposed here).
 */
export interface MessageView {
  readonly id: string;
  readonly idempotencyKey: string;
  readonly state: Message["state"];
  readonly recipientHmac: string;
  readonly subject: string;
  readonly provider: string;
  readonly templateId: string | null;
  readonly templateVersion: number | null;
  readonly metadata: Record<string, unknown>;
  readonly attempts: number;
  readonly nextAttemptAt: string;
  readonly providerMessageId: string | null;
  readonly lastError: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export function toView(m: Message): MessageView {
  return {
    id: m.id,
    idempotencyKey: m.idempotencyKey,
    state: m.state,
    recipientHmac: m.recipientHmac,
    subject: m.subject,
    provider: m.provider,
    templateId: m.templateId,
    templateVersion: m.templateVersion,
    metadata: m.metadata,
    attempts: m.attempts,
    nextAttemptAt: m.nextAttemptAt.toISOString(),
    providerMessageId: m.providerMessageId,
    lastError: m.lastError,
    createdAt: m.createdAt.toISOString(),
    updatedAt: m.updatedAt.toISOString(),
  };
}

export class GetMessage {
  constructor(private readonly deps: CoreDeps) {}
  async execute(id: string): Promise<MessageView> {
    const m = await this.deps.outbox.findById(id);
    if (!m) throw new NotFoundError(`Message "${id}" not found`);
    return toView(m);
  }
}

export class ListMessages {
  constructor(private readonly deps: CoreDeps) {}
  async execute(query: ListMessagesQuery): Promise<MessageView[]> {
    const messages = await this.deps.outbox.list({ limit: 50, offset: 0, ...query });
    return messages.map(toView);
  }
}

/**
 * ReplayMessage — re-enqueue a dead-lettered (`failed`) message from the DLQ
 * (TDR §3.4, §3.12). Resets the retry budget and schedules an immediate retry.
 */
export class ReplayMessage {
  constructor(private readonly deps: CoreDeps) {}
  async execute(id: string, actor: string): Promise<MessageView> {
    const m = await this.deps.outbox.findById(id);
    if (!m) throw new NotFoundError(`Message "${id}" not found`);
    if (!canTransition(m.state, "queued")) {
      throw new InvalidStateTransitionError(m.state, "queued");
    }
    await this.deps.outbox.updateState(id, {
      state: "queued",
      attempts: 0,
      nextAttemptAt: this.deps.clock.now(),
      lastError: null,
    });
    await this.deps.audit.append({
      messageId: id,
      eventType: "replayed",
      actor,
      detail: { fromState: m.state },
    });
    const updated = await this.deps.outbox.findById(id);
    return toView(updated!);
  }
}
