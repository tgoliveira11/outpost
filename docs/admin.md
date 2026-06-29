# Administration

> Outpost ships operator capabilities as **authenticated API endpoints**, a
> **typed client**, and **ready-to-use admin pages** (like `@tgoliveira/secure-auth/react`).
> Embed the pages in your Next.js app and wire the route handlers — you keep
> your design system variables and admin authentication.

## Admin UI (`@tgoliveira/outpost/react`)

Import ready-made pages and mount them under `/admin` in your app:

```tsx
// app/admin/page.tsx
import { AdminPanelPage } from "@tgoliveira/outpost/react";
export default function Page() { return <AdminPanelPage />; }

// app/admin/queue/page.tsx
import { AdminQueuePage } from "@tgoliveira/outpost/react";
export default function Page() { return <AdminQueuePage apiBase="/api/outpost" />; }

// app/admin/config/page.tsx
import { AdminConfigPage } from "@tgoliveira/outpost/react";

// app/admin/observability/page.tsx
import { AdminObservabilityPage } from "@tgoliveira/outpost/react";
```

Import `@tgoliveira/outpost/styles.css` from your `globals.css` (after Tailwind) so
classes are scanned.

| Page | Route suffix | Description |
|---|---|---|
| `AdminPanelPage` | `/admin` | Overview cards |
| `AdminQueuePage` | `/admin/queue` | Queued/sending/failed messages + **Run send worker** |
| `AdminConfigPage` | `/admin/config` | Vault/env settings — priority **admin → env.local → default** |
| `AdminObservabilityPage` | `/admin/observability` | Queue depth, last worker run, OTel metric catalog |

Optional `OutpostUIProvider` sets `paths.adminPanel` (default `/admin`).

## Admin API (`@tgoliveira/outpost/admin`)

Wire lazy route handlers in your App Router (mirror secure-auth):

```ts
// lib/outpost-admin.ts
import { createOutpostAdmin } from "@tgoliveira/outpost/admin";
import { DrizzleConfigOverrideRepository } from "@tgoliveira/outpost/drizzle";
import { outpost } from "./outpost";

export const outpostAdmin = createOutpostAdmin({
  outpost,
  configOverrideRepository: new DrizzleConfigOverrideRepository(db),
  requireAdmin: async (request) => {
    // Your session/role check — e.g. secure-auth admin user
    return { actor: "admin:jane" };
  },
  env: process.env, // second priority after DB overrides
});
```

```ts
// app/api/outpost/admin/queue/route.ts
import { outpostAdmin } from "@/lib/outpost-admin";
export const GET = outpostAdmin.routes.adminQueue.GET;

// app/api/outpost/admin/worker/send/route.ts
export const POST = outpostAdmin.routes.adminWorkerSend.POST;

// app/api/outpost/admin/config/route.ts
export const GET = outpostAdmin.routes.adminConfig.GET;
export const POST = outpostAdmin.routes.adminConfig.POST;
export const DELETE = outpostAdmin.routes.adminConfig.DELETE;

// app/api/outpost/admin/observability/route.ts
export const GET = outpostAdmin.routes.adminObservability.GET;
```

Run the `outpost_admin_config_overrides` migration (see `drizzle/`) before using
the config page.

---

## Operator capabilities → where they live

| Capability | Client method | HTTP endpoint | Scope |
|---|---|---|---|
| Search / list messages | `outpost.list(query)` | `GET /api/outpost/messages` | `messages:read` |
| Inspect a message (PII-free) | `outpost.get(id)` | `GET /api/outpost/messages/:id` | `messages:read` |
| Inspect DLQ (failed) | `outpost.list({ state: "failed" })` | `GET /api/outpost/messages?state=failed` | `messages:read` |
| Replay from DLQ | `outpost.replay(id)` | `POST /api/outpost/messages/:id/replay` | `messages:replay` |
| View suppression list | `outpost.suppression.list()` | — | `suppressions:read` |
| Add suppression | `outpost.suppress(addr, reason)` | `POST /api/outpost/suppressions` | `suppressions:write` |
| Remove suppression | `outpost.unsuppress(addr)` | `DELETE /api/outpost/suppressions/:hash` | `suppressions:write` |
| Create API key | `outpost.keys.create({ label, scopes })` | — | `keys:manage` |
| Revoke API key | `outpost.keys.revoke(id)` | — | `keys:manage` |
| List API keys | `outpost.keys.list()` | — | `keys:manage` |
| Audit trail for a message | `outpost.deps.audit.listForMessage(id)` | — | (server-side) |

> Key management and audit listing are intentionally **not** exposed as HTTP
> endpoints by default — they are high-privilege operations you should gate
> behind your app's own admin authentication and call server-side via the
> client. Add HTTP routes for them only if your architecture requires it.

## Inspection respects encryption

`outpost.get()` / `outpost.list()` return a `MessageView` — lifecycle state,
metadata, recipient **HMAC**, subject, provider, attempts, errors, timestamps.
They do **not** return the decrypted body or recipient address. Body access is a
separate, gated, audited operation by design (TDR §3.12, §5.5); if you build a
"reveal body" feature, decrypt server-side with the open-capable `Encryptor`,
require an elevated scope, and write an audit event for the access.

## Building the panel

A typical embedded panel is a few server components / route handlers in the same
Next.js app that call the client directly (no HTTP round-trip needed):

```tsx
// app/admin/messages/page.tsx (server component)
import { outpost } from "@/lib/outpost";

export default async function Messages() {
  const failed = await outpost.list({ state: "failed", limit: 100 });
  return <DLQTable rows={failed} onReplay={replayAction} />;
}

// a server action
async function replayAction(id: string) {
  "use server";
  await outpost.replay(id, { actor: "admin:jane" });
}
```

Dashboards (throughput, success/bounce/complaint rates, queue depth) are best
driven from your OpenTelemetry metrics backend — see
[observability.md](./observability.md) for the metric names Outpost emits.

## Audit trail

Every state-changing operation appends an immutable audit event (actor, type,
timestamp, redactable detail). The audit trail survives PII redaction and has an
independent (longer) retention than operational data. Read it server-side via
`outpost.deps.audit.listForMessage(messageId)` to render a per-message timeline.
