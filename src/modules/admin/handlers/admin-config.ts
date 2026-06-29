import { z } from "zod";
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
  if (error instanceof Error && error.message.includes("not overridable")) {
    return json({ error: error.message }, 422);
  }
  console.error(endpoint, error);
  return json({ error: "internal_error" }, 500);
}

async function parseJsonBody(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    throw new Error("Invalid JSON body");
  }
}

async function adminConfigGet(request: Request, services: OutpostAdminServices) {
  try {
    await requireAdmin(services.admin.enabled, services.requireAdmin, request);
    const keys = await services.configOverrideService.listAllKeys();
    return json({ keys });
  } catch (error) {
    return handleAdminError(error, "GET /api/outpost/admin/config");
  }
}

const setSchema = z.object({ key: z.string(), value: z.unknown() });

async function adminConfigPost(request: Request, services: OutpostAdminServices) {
  try {
    const { actor } = await requireAdmin(services.admin.enabled, services.requireAdmin, request);
    const body = await parseJsonBody(request);
    const parsed = setSchema.safeParse(body);
    if (!parsed.success) {
      return json({ error: "key and value required" }, 400);
    }
    await services.configOverrideService.setOverride(
      parsed.data.key,
      parsed.data.value,
      actor,
    );
    return json({ success: true });
  } catch (error) {
    return handleAdminError(error, "POST /api/outpost/admin/config");
  }
}

const deleteSchema = z.object({ key: z.string() });

async function adminConfigDelete(request: Request, services: OutpostAdminServices) {
  try {
    await requireAdmin(services.admin.enabled, services.requireAdmin, request);
    const body = await parseJsonBody(request);
    const parsed = deleteSchema.safeParse(body);
    if (!parsed.success) {
      return json({ error: "key required" }, 400);
    }
    await services.configOverrideService.deleteOverride(parsed.data.key);
    return json({ success: true });
  } catch (error) {
    return handleAdminError(error, "DELETE /api/outpost/admin/config");
  }
}

export function createGetHandler(services: OutpostAdminServices) {
  return (request: Request) => adminConfigGet(request, services);
}

export function createPostHandler(services: OutpostAdminServices) {
  return (request: Request) => adminConfigPost(request, services);
}

export function createDeleteHandler(services: OutpostAdminServices) {
  return (request: Request) => adminConfigDelete(request, services);
}
