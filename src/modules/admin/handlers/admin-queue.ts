import type { OutpostAdminServices } from "../create-admin-services.js";
import { AdminDisabledError } from "../lib/require-admin.js";
import { requireAdmin } from "../lib/require-admin.js";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function handleAdminError(error: unknown, endpoint: string): Response {
  if (error instanceof AdminDisabledError) {
    return json({ error: "not_found" }, 404);
  }
  if (error instanceof Error && error.name === "AdminForbiddenError") {
    return json({ error: "forbidden", message: error.message }, 403);
  }
  console.error(endpoint, error);
  return json({ error: "internal_error" }, 500);
}

async function adminQueueGet(request: Request, services: OutpostAdminServices) {
  try {
    await requireAdmin(services.admin.enabled, services.requireAdmin, request);
    const [queued, sending, failed, counts] = await Promise.all([
      services.outpost.list({ state: "queued", limit: 100 }),
      services.outpost.list({ state: "sending", limit: 100 }),
      services.outpost.list({ state: "failed", limit: 100 }),
      services.outpost.deps.outbox.countByState(),
    ]);
    return json({
      queued,
      sending,
      failed,
      counts: {
        queued: counts.queued,
        sending: counts.sending,
        failed: counts.failed,
      },
    });
  } catch (error) {
    return handleAdminError(error, "GET /api/outpost/admin/queue");
  }
}

export function createGetHandler(services: OutpostAdminServices) {
  return (request: Request) => adminQueueGet(request, services);
}
