import type { OutpostAdminServices } from "./create-admin-services.js";

export type RouteHandler = (request: Request) => Response | Promise<Response>;

type HandlerFactories = {
  createGetHandler?: (services: OutpostAdminServices) => RouteHandler;
  createPostHandler?: (services: OutpostAdminServices) => RouteHandler;
  createDeleteHandler?: (services: OutpostAdminServices) => RouteHandler;
};

function lazyServiceRoute(
  getServices: () => OutpostAdminServices | Promise<OutpostAdminServices>,
  loader: () => Promise<HandlerFactories>,
  method: "GET" | "POST" | "DELETE",
): RouteHandler {
  const factoryKey =
    method === "GET"
      ? "createGetHandler"
      : method === "POST"
        ? "createPostHandler"
        : "createDeleteHandler";

  return (request) =>
    Promise.all([Promise.resolve(getServices()), loader()]).then(([services, mod]) => {
      const factory = mod[factoryKey];
      if (!factory) {
        throw new Error(`@tgoliveira/outpost: handler ${factoryKey} not found`);
      }
      return factory(services)(request);
    });
}

export function createAdminRoutes(getServices: () => OutpostAdminServices | Promise<OutpostAdminServices>) {
  return {
    adminQueue: {
      GET: lazyServiceRoute(getServices, () => import("./handlers/admin-queue.js"), "GET"),
    },
    adminWorkerSend: {
      POST: lazyServiceRoute(getServices, () => import("./handlers/admin-worker.js"), "POST"),
    },
    adminConfig: {
      GET: lazyServiceRoute(getServices, () => import("./handlers/admin-config.js"), "GET"),
      POST: lazyServiceRoute(getServices, () => import("./handlers/admin-config.js"), "POST"),
      DELETE: lazyServiceRoute(getServices, () => import("./handlers/admin-config.js"), "DELETE"),
    },
    adminObservability: {
      GET: lazyServiceRoute(
        getServices,
        () => import("./handlers/admin-observability.js"),
        "GET",
      ),
    },
  };
}

export type OutpostAdminRoutes = ReturnType<typeof createAdminRoutes>;
