import { describe, it, expect, beforeEach } from "vitest";
import { createOutpost } from "../src/create-outpost.js";
import { FakeEmailProvider } from "../src/adapters/providers/fake.js";
import {
  inMemoryRepositories,
  InMemoryConfigOverrideRepository,
} from "../src/testing/index.js";
import { createOutpostAdmin } from "../src/admin/create-outpost-admin.js";
import { createConfigOverrideService } from "../src/modules/admin/services/config-override-service.js";

describe("Outpost admin", () => {
  const repos = inMemoryRepositories();
  const outpost = createOutpost({
    repositories: repos,
    providers: [new FakeEmailProvider()],
    recipientHmacKey: "test-key-at-least-16-bytes-long",
  });

  const configRepo = new InMemoryConfigOverrideRepository();

  function makeAdmin(repo = configRepo) {
    return createOutpostAdmin({
      outpost,
      configOverrideRepository: repo,
      requireAdmin: async () => ({ actor: "admin:test" }),
      env: {
        DATABASE_URL: "postgres://localhost/outpost",
        OUTPOST_HMAC_KEY: "env-hmac-key-value-here",
      },
    });
  }

  let admin = makeAdmin();

  beforeEach(() => {
    admin = makeAdmin(new InMemoryConfigOverrideRepository());
  });

  it("config priority: admin > env > default", async () => {
    const service = createConfigOverrideService({
      envConfig: { sendBatchSize: 25 },
      configOverrideRepository: configRepo,
    });

    let keys = await service.listAllKeys();
    const batch = keys.find((k) => k.key === "sendBatchSize");
    expect(batch?.source).toBe("env");
    expect(batch?.value).toBe(25);

    await service.setOverride("sendBatchSize", 99, "admin:test");
    keys = await service.listAllKeys();
    expect(keys.find((k) => k.key === "sendBatchSize")).toMatchObject({
      source: "admin",
      value: 99,
    });

    await service.deleteOverride("sendBatchSize");
    keys = await service.listAllKeys();
    expect(keys.find((k) => k.key === "sendBatchSize")?.source).toBe("env");
  });

  it("masks secret env values in config list", async () => {
    const service = createConfigOverrideService({
      envConfig: { recipientHmacKey: "super-secret-hmac-key-value" },
      configOverrideRepository: configRepo,
    });
    const keys = await service.listAllKeys();
    const hmac = keys.find((k) => k.key === "recipientHmacKey");
    expect(hmac?.source).toBe("env");
    expect(String(hmac?.value)).toContain("••••");
  });

  it("admin queue GET returns queued messages", async () => {
    await outpost.send({
      idempotencyKey: "admin-queue-test-1",
      to: "user@example.com",
      subject: "Hello",
      html: "<p>Hi</p>",
    });

    const res = await admin.routes.adminQueue.GET(new Request("http://localhost/admin/queue"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.queued.length).toBeGreaterThanOrEqual(1);
    expect(body.counts.queued).toBeGreaterThanOrEqual(1);
  });

  it("admin worker POST runs tickSend", async () => {
    await outpost.send({
      idempotencyKey: "admin-worker-test-1",
      to: "user2@example.com",
      subject: "Worker",
      html: "<p>Run</p>",
    });

    const res = await admin.routes.adminWorkerSend.POST(
      new Request("http://localhost/admin/worker/send", { method: "POST" }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.claimed).toBeGreaterThanOrEqual(1);
  });

  it("returns 404 when admin is disabled", async () => {
    const disabled = createOutpostAdmin({
      outpost,
      configOverrideRepository: new InMemoryConfigOverrideRepository(),
      requireAdmin: async () => ({ actor: "admin:test" }),
      admin: { enabled: false },
    });
    const res = await disabled.routes.adminConfig.GET(new Request("http://localhost/admin/config"));
    expect(res.status).toBe(404);
  });
});
