import type { CoreDeps } from "../application/context.js";
import { EnqueueMessage, type EnqueueInput, type EnqueueResult } from "../application/enqueue-message.js";
import { IngestWebhook, type IngestWebhookResult } from "../application/ingest-webhook.js";
import { ManageSuppression } from "../application/manage-suppression.js";
import { ManageApiKey } from "../application/manage-api-key.js";
import { Authenticate } from "../application/authenticate.js";
import {
  GetMessage,
  ListMessages,
  ReplayMessage,
  type MessageView,
} from "../application/message-queries.js";
import type { ListMessagesQuery } from "../ports/repositories.js";
import type { SuppressionReason, SuppressionEntry } from "../domain/suppression.js";
import type { RawWebhook } from "../ports/email-provider.js";
import { SendWorker } from "../workers/send-worker.js";
import { RetentionWorker } from "../workers/retention-worker.js";

/**
 * The high-level, typed programmatic client returned by `createOutpost`
 * (TDR §4.2). Server-side use within the same app calls these methods directly;
 * cross-service callers go through the HTTP handlers (which call the same use
 * cases under the hood).
 *
 * `actor` labels who performed an action in the audit trail. The programmatic
 * client defaults to `"programmatic"`; the HTTP layer passes the API key id.
 */
export class Outpost {
  readonly enqueueMessage: EnqueueMessage;
  readonly ingestWebhook: IngestWebhook;
  readonly suppression: ManageSuppression;
  readonly keys: ManageApiKey;
  readonly auth: Authenticate;
  readonly send_worker: SendWorker;
  readonly retention_worker: RetentionWorker;

  private readonly getMessage: GetMessage;
  private readonly listMessages: ListMessages;
  private readonly replayMessage: ReplayMessage;

  constructor(
    readonly deps: CoreDeps,
    private readonly defaultActor = "programmatic",
  ) {
    this.enqueueMessage = new EnqueueMessage(deps);
    this.ingestWebhook = new IngestWebhook(deps);
    this.suppression = new ManageSuppression(deps);
    this.keys = new ManageApiKey(deps);
    this.auth = new Authenticate(deps);
    this.getMessage = new GetMessage(deps);
    this.listMessages = new ListMessages(deps);
    this.replayMessage = new ReplayMessage(deps);
    this.send_worker = new SendWorker(deps);
    this.retention_worker = new RetentionWorker(deps);
  }

  /** Enqueue a message (persist-then-queue). Idempotent on `idempotencyKey`. */
  send(input: EnqueueInput, opts?: { actor?: string }): Promise<EnqueueResult> {
    return this.enqueueMessage.execute(input, opts?.actor ?? this.defaultActor);
  }

  /** Fetch a message's lifecycle + metadata (PII-free view). */
  get(id: string): Promise<MessageView> {
    return this.getMessage.execute(id);
  }

  /** List messages by state / recipient hash / date. */
  list(query: ListMessagesQuery = {}): Promise<MessageView[]> {
    return this.listMessages.execute(query);
  }

  /** Re-enqueue a dead-lettered (failed) message from the DLQ. */
  replay(id: string, opts?: { actor?: string }): Promise<MessageView> {
    return this.replayMessage.execute(id, opts?.actor ?? this.defaultActor);
  }

  /** Check whether an address is on the suppression list. */
  isSuppressed(address: string): Promise<boolean> {
    return this.suppression.isSuppressed(address);
  }

  /** Add an address to the suppression list (audited). */
  suppress(
    address: string,
    reason: SuppressionReason = "manual",
    opts?: { note?: string; actor?: string },
  ): Promise<SuppressionEntry> {
    return this.suppression.suppress(address, reason, opts?.actor ?? this.defaultActor, opts?.note);
  }

  /** Remove an address from the suppression list (audited). */
  async unsuppress(address: string, opts?: { actor?: string }): Promise<boolean> {
    const hmac = this.deps.recipientHasher.hash(address);
    return this.suppression.unsuppressByHmac(hmac, opts?.actor ?? this.defaultActor);
  }

  /** Ingest a verified provider webhook (used by the HTTP webhook sink). */
  webhook(provider: string, raw: RawWebhook): Promise<IngestWebhookResult> {
    return this.ingestWebhook.execute(provider, raw);
  }

  /** Convenience: run one send-worker cycle (cron/route-handler deployments). */
  tickSend(): ReturnType<SendWorker["tick"]> {
    return this.send_worker.tick();
  }

  /** Convenience: run one retention cycle. */
  tickRetention(): ReturnType<RetentionWorker["tick"]> {
    return this.retention_worker.tick();
  }
}
