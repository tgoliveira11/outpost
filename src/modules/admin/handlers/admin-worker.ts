import type { OutpostAdminServices } from "../create-admin-services.js";
import { requireAdmin, AdminDisabledError } from "../lib/require-admin.js";

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

async function adminWorkerPost(request: Request, services: OutpostAdminServices) {
  try {
    await requireAdmin(services.admin.enabled, services.requireAdmin, request);
    const report = await services.outpost.tickSend();
    services.observabilityService.recordWorkerRun(report.claimed, report.outcomes);
    return json(report);
  } catch (error) {
    return handleAdminError(error, "POST /api/outpost/admin/worker/send");
  }
}

export function createPostHandler(services: OutpostAdminServices) {
  return (request: Request) => adminWorkerPost(request, services);
}
