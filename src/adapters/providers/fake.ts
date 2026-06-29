import type { EmailProvider, ProviderReceipt, RawWebhook } from "../../ports/email-provider.js";
import type { DispatchableMessage } from "../../domain/message.js";
import type { WebhookEvent, WebhookEventType } from "../../domain/webhook.js";
import { ProviderError, WebhookVerificationError } from "../../domain/errors.js";

export interface SentRecord {
  readonly providerMessageId: string;
  readonly message: DispatchableMessage;
}

/**
 * In-memory fake provider for tests and CI (TDR §3.8). Substitutable for any
 * real provider (Liskov): same interface, same error contract.
 *
 * - Records every accepted send in `sent` for assertions.
 * - `failNext("transient"|"permanent")` queues a one-shot failure to exercise
 *   the retry / dead-letter paths.
 * - `verifyWebhook` accepts an UNSIGNED JSON body of shape
 *   `{ type, providerMessageId, recipient?, isHardBounce? }` — convenient for
 *   driving lifecycle transitions in tests. Never use this provider in prod.
 */
export class FakeEmailProvider implements EmailProvider {
  readonly name: string;
  readonly sent: SentRecord[] = [];
  private failures: Array<"transient" | "permanent"> = [];
  private counter = 0;

  constructor(name = "fake") {
    this.name = name;
  }

  failNext(kind: "transient" | "permanent" = "transient"): void {
    this.failures.push(kind);
  }

  async send(msg: DispatchableMessage): Promise<ProviderReceipt> {
    const failure = this.failures.shift();
    if (failure === "transient") throw ProviderError.transient("fake transient failure");
    if (failure === "permanent") throw ProviderError.permanent("fake permanent failure");

    const providerMessageId = `fake-${++this.counter}`;
    this.sent.push({ providerMessageId, message: msg });
    return { providerMessageId, acceptedAt: new Date(0) };
  }

  async verifyWebhook(req: RawWebhook): Promise<WebhookEvent> {
    let parsed: any;
    try {
      parsed = JSON.parse(req.rawBody);
    } catch {
      throw new WebhookVerificationError("fake webhook body is not valid JSON");
    }
    if (!parsed?.type || !parsed?.providerMessageId) {
      throw new WebhookVerificationError("fake webhook missing type/providerMessageId");
    }
    return {
      provider: this.name,
      type: parsed.type as WebhookEventType,
      providerMessageId: String(parsed.providerMessageId),
      recipient: parsed.recipient,
      isHardBounce: parsed.isHardBounce,
      raw: parsed,
    };
  }
}
