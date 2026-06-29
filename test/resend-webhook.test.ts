import { describe, it, expect } from "vitest";
import { createHmac } from "node:crypto";
import { ResendEmailProvider } from "../src/adapters/providers/resend.js";

/** Build a valid Svix signature for a payload, as Resend would. */
function sign(secret: string, id: string, ts: string, body: string): string {
  const secretBytes = Buffer.from(secret.replace(/^whsec_/, ""), "base64");
  const sig = createHmac("sha256", secretBytes).update(`${id}.${ts}.${body}`).digest("base64");
  return `v1,${sig}`;
}

const SECRET = `whsec_${Buffer.from("super-secret-signing-key-bytes!!").toString("base64")}`;

describe("Resend webhook verification (Svix)", () => {
  const provider = new ResendEmailProvider({ apiKey: "x", from: "a@b.com", webhookSecret: SECRET });

  it("accepts and normalizes a correctly-signed delivered event", async () => {
    const body = JSON.stringify({ type: "email.delivered", data: { email_id: "abc123", to: ["x@y.com"] } });
    const id = "msg_1";
    const ts = "1700000000";
    const event = await provider.verifyWebhook({
      headers: { "svix-id": id, "svix-timestamp": ts, "svix-signature": sign(SECRET, id, ts, body) },
      rawBody: body,
    });
    expect(event.type).toBe("delivered");
    expect(event.providerMessageId).toBe("abc123");
  });

  it("rejects a tampered body", async () => {
    const id = "msg_2";
    const ts = "1700000000";
    const signature = sign(SECRET, id, ts, JSON.stringify({ type: "email.delivered", data: { email_id: "abc" } }));
    await expect(
      provider.verifyWebhook({
        headers: { "svix-id": id, "svix-timestamp": ts, "svix-signature": signature },
        rawBody: JSON.stringify({ type: "email.bounced", data: { email_id: "evil" } }), // swapped
      }),
    ).rejects.toThrow(/signature/i);
  });

  it("rejects when signature headers are missing", async () => {
    await expect(
      provider.verifyWebhook({ headers: {}, rawBody: "{}" }),
    ).rejects.toThrow(/signature/i);
  });

  async function verifySigned(payload: object) {
    const body = JSON.stringify(payload);
    const id = "msg";
    const ts = "1700000000";
    return provider.verifyWebhook({
      headers: { "svix-id": id, "svix-timestamp": ts, "svix-signature": sign(SECRET, id, ts, body) },
      rawBody: body,
    });
  }

  it("maps bounced (hard vs transient), complained, and opened events", async () => {
    const hard = await verifySigned({ type: "email.bounced", data: { email_id: "e1", bounce: { type: "Permanent" } } });
    expect(hard.type).toBe("bounced");
    expect(hard.isHardBounce).toBe(true);

    const soft = await verifySigned({ type: "email.bounced", data: { email_id: "e2", bounce: { type: "Transient" } } });
    expect(soft.isHardBounce).toBe(false);

    expect((await verifySigned({ type: "email.complained", data: { email_id: "e3" } })).type).toBe("complained");
    expect((await verifySigned({ type: "email.opened", data: { email_id: "e4" } })).type).toBe("opened");
  });

  it("rejects an unhandled event type and a missing email id", async () => {
    await expect(verifySigned({ type: "email.sent", data: { email_id: "e5" } })).rejects.toThrow(/Unhandled/);
    await expect(verifySigned({ type: "email.delivered", data: {} })).rejects.toThrow(/missing email id/);
  });
});
