import { createHmac, timingSafeEqual } from "node:crypto";
import type { EmailProvider, ProviderReceipt, RawWebhook } from "../../ports/email-provider.js";
import type { DispatchableMessage } from "../../domain/message.js";
import type { WebhookEvent, WebhookEventType } from "../../domain/webhook.js";
import { ProviderError, WebhookVerificationError } from "../../domain/errors.js";

export interface ResendProviderOptions {
  readonly name?: string;
  readonly apiKey: string;
  /** Default From address (must be a verified Resend domain). */
  readonly from: string;
  /**
   * Webhook signing secret from the Resend dashboard (Svix `whsec_...`).
   * Required to ingest delivery/bounce/complaint webhooks securely.
   */
  readonly webhookSecret?: string;
  /** Override for testing. */
  readonly baseUrl?: string;
}

/**
 * Resend provider (TDR §3.8, recommended first production provider). Uses the
 * global `fetch` (Node 18+) — no SDK dependency. Webhooks are verified with
 * Resend's Svix signature scheme before being trusted (TDR §5.2).
 */
export class ResendEmailProvider implements EmailProvider {
  readonly name: string;
  private readonly baseUrl: string;

  constructor(private readonly opts: ResendProviderOptions) {
    this.name = opts.name ?? "resend";
    this.baseUrl = opts.baseUrl ?? "https://api.resend.com";
  }

  async send(msg: DispatchableMessage): Promise<ProviderReceipt> {
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}/emails`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.opts.apiKey}`,
          "Content-Type": "application/json",
          // Resend honors an idempotency key — pass the message id for safety.
          "Idempotency-Key": msg.id,
        },
        body: JSON.stringify({
          from: this.opts.from,
          to: msg.to,
          subject: msg.subject,
          html: msg.body.html,
          text: msg.body.text,
          headers: msg.headers,
        }),
      });
    } catch (err) {
      // Network failure → transient.
      throw ProviderError.transient("Resend request failed", { cause: err });
    }

    if (res.ok) {
      const json = (await res.json()) as { id?: string };
      if (!json.id) throw ProviderError.transient("Resend accepted but returned no id");
      return { providerMessageId: json.id };
    }

    const text = await res.text().catch(() => "");
    // 429 and 5xx are retryable; 4xx (bad request, rejected content) are not.
    if (res.status === 429 || res.status >= 500) {
      throw ProviderError.transient(`Resend ${res.status}: ${text}`, {
        providerCode: String(res.status),
      });
    }
    throw ProviderError.permanent(`Resend ${res.status}: ${text}`, {
      providerCode: String(res.status),
    });
  }

  async verifyWebhook(req: RawWebhook): Promise<WebhookEvent> {
    if (!this.opts.webhookSecret) {
      throw new WebhookVerificationError("Resend webhookSecret is not configured");
    }
    verifySvixSignature(req, this.opts.webhookSecret);

    const payload = JSON.parse(req.rawBody) as {
      type: string;
      created_at?: string;
      data?: { email_id?: string; id?: string; to?: string[]; bounce?: { type?: string } };
    };
    const type = mapResendEvent(payload.type);
    if (!type) throw new WebhookVerificationError(`Unhandled Resend event "${payload.type}"`);

    const providerMessageId = payload.data?.email_id ?? payload.data?.id;
    if (!providerMessageId) {
      throw new WebhookVerificationError("Resend webhook missing email id");
    }

    return {
      provider: this.name,
      type,
      providerMessageId,
      recipient: payload.data?.to?.[0],
      isHardBounce: type === "bounced" ? payload.data?.bounce?.type !== "Transient" : undefined,
      occurredAt: payload.created_at ? new Date(payload.created_at) : undefined,
      raw: payload,
    };
  }
}

function mapResendEvent(type: string): WebhookEventType | null {
  switch (type) {
    case "email.delivered":
      return "delivered";
    case "email.bounced":
      return "bounced";
    case "email.complained":
      return "complained";
    case "email.opened":
      return "opened";
    case "email.failed":
      return "failed";
    default:
      return null; // email.sent, email.clicked, email.delivery_delayed → ignored
  }
}

/**
 * Verify a Svix-style signature (Resend's webhook scheme). Signed content is
 * `${id}.${timestamp}.${body}`, HMAC-SHA256 with the base64 secret (after the
 * `whsec_` prefix), compared constant-time against the v1 signatures.
 */
function verifySvixSignature(req: RawWebhook, secret: string): void {
  const id = header(req, "svix-id");
  const timestamp = header(req, "svix-timestamp");
  const signatures = header(req, "svix-signature");
  if (!id || !timestamp || !signatures) {
    throw new WebhookVerificationError("Missing Svix signature headers");
  }

  const secretBytes = Buffer.from(secret.replace(/^whsec_/, ""), "base64");
  const signedContent = `${id}.${timestamp}.${req.rawBody}`;
  const expected = createHmac("sha256", secretBytes).update(signedContent).digest("base64");

  const provided = signatures.split(" ").map((s) => s.split(",", 2)[1] ?? s);
  const ok = provided.some((sig) => {
    const a = Buffer.from(sig);
    const b = Buffer.from(expected);
    return a.length === b.length && timingSafeEqual(a, b);
  });
  if (!ok) throw new WebhookVerificationError("Svix signature mismatch");
}

function header(req: RawWebhook, name: string): string | null {
  const v = req.headers[name] ?? req.headers[name.toLowerCase()];
  if (Array.isArray(v)) return v[0] ?? null;
  return v ?? null;
}
