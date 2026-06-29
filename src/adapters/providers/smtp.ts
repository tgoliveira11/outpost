import type { EmailProvider, ProviderReceipt, RawWebhook } from "../../ports/email-provider.js";
import type { DispatchableMessage } from "../../domain/message.js";
import type { WebhookEvent } from "../../domain/webhook.js";
import { ProviderError, WebhookVerificationError } from "../../domain/errors.js";

export interface SmtpProviderOptions {
  /** Stable provider key. Defaults to "smtp". Use "mailpit" for the dev box. */
  readonly name?: string;
  readonly host: string;
  readonly port: number;
  readonly secure?: boolean;
  readonly auth?: { user: string; pass: string };
  /** Default From address (e.g. "Acme <no-reply@acme.com>"). */
  readonly from: string;
  /** Extra options passed straight to nodemailer.createTransport. */
  readonly transportOptions?: Record<string, unknown>;
}

/**
 * Generic SMTP provider via nodemailer — also the Mailpit dev adapter (point
 * it at Mailpit's SMTP port). `nodemailer` is an OPTIONAL peer dependency,
 * imported lazily so consumers who only use Resend never need it installed.
 *
 * SMTP has no delivery webhooks, so `verifyWebhook` always rejects: lifecycle
 * past `sent` is not observable over plain SMTP. Use a provider with webhooks
 * (Resend/SES/SendGrid) for delivery/bounce/complaint tracking.
 */
export class SmtpEmailProvider implements EmailProvider {
  readonly name: string;
  private transporter: any;

  constructor(private readonly opts: SmtpProviderOptions) {
    this.name = opts.name ?? "smtp";
  }

  private async getTransporter(): Promise<any> {
    if (this.transporter) return this.transporter;
    let nodemailer: any;
    try {
      nodemailer = await import("nodemailer");
    } catch {
      throw new Error(
        'SmtpEmailProvider requires the optional peer dependency "nodemailer". Install it: npm i nodemailer',
      );
    }
    this.transporter = (nodemailer.default ?? nodemailer).createTransport({
      host: this.opts.host,
      port: this.opts.port,
      secure: this.opts.secure ?? false,
      auth: this.opts.auth,
      ...this.opts.transportOptions,
    });
    return this.transporter;
  }

  async send(msg: DispatchableMessage): Promise<ProviderReceipt> {
    const transporter = await this.getTransporter();
    try {
      const info = await transporter.sendMail({
        from: this.opts.from,
        to: msg.to,
        subject: msg.subject,
        html: msg.body.html,
        text: msg.body.text,
        headers: msg.headers,
      });
      return { providerMessageId: String(info.messageId) };
    } catch (err) {
      throw classifySmtpError(err);
    }
  }

  async verifyWebhook(_req: RawWebhook): Promise<WebhookEvent> {
    throw new WebhookVerificationError("SMTP transport has no webhooks");
  }
}

/** Map an SMTP/network error onto transient vs. permanent (TDR §3.4). */
function classifySmtpError(err: unknown): ProviderError {
  const e = err as { responseCode?: number; code?: string; message?: string };
  const msg = e.message ?? "SMTP send failed";
  // 5xx = permanent rejection; 4xx = greylisting/temporary.
  if (typeof e.responseCode === "number") {
    return e.responseCode >= 500
      ? ProviderError.permanent(msg, { providerCode: String(e.responseCode) })
      : ProviderError.transient(msg, { providerCode: String(e.responseCode) });
  }
  // Connection-level errors are transient (retry).
  const transientCodes = ["ETIMEDOUT", "ECONNRESET", "ECONNREFUSED", "ESOCKET", "EDNS"];
  if (e.code && transientCodes.includes(e.code)) {
    return ProviderError.transient(msg, { providerCode: e.code });
  }
  return ProviderError.transient(msg, { providerCode: e.code });
}
