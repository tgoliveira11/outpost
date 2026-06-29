import type { Outpost } from "../client/outpost-client.js";
import type { ConfigOverrideRepository } from "../modules/admin/repositories/config-override-repository.js";
import type { RequireAdminFn } from "../modules/admin/lib/require-admin.js";
import {
  createOutpostAdminServices,
  type CreateOutpostAdminServicesOptions,
  type OutpostAdminConfig,
} from "../modules/admin/create-admin-services.js";
import { createAdminRoutes } from "../modules/admin/create-admin-routes.js";
import { envRecordToConfig } from "../modules/admin/lib/config-keys.js";

export type CreateOutpostAdminOptions = {
  outpost: Outpost;
  /** Gate admin HTTP routes — e.g. secure-auth session check. */
  requireAdmin: RequireAdminFn;
  configOverrideRepository: ConfigOverrideRepository;
  /** Flat env map from process.env / .env.local (second priority after admin overrides). */
  env?: Record<string, string | undefined>;
  /** Pre-parsed env config tree (overrides `env` when set). */
  envConfig?: Record<string, unknown>;
  admin?: OutpostAdminConfig;
};

/**
 * Composition root for the Outpost operator admin panel.
 * Returns lazy route handlers and services — mirror of `createSecureAuth` admin wiring.
 */
export function createOutpostAdmin(options: CreateOutpostAdminOptions) {
  const envConfig =
    options.envConfig ?? (options.env ? envRecordToConfig(options.env) : {});

  const serviceOptions: CreateOutpostAdminServicesOptions = {
    outpost: options.outpost,
    requireAdmin: options.requireAdmin,
    configOverrideRepository: options.configOverrideRepository,
    envConfig,
    admin: options.admin,
  };

  let services: ReturnType<typeof createOutpostAdminServices> | undefined;

  const getServices = () => {
    if (!services) {
      services = createOutpostAdminServices(serviceOptions);
    }
    return services;
  };

  const routes = createAdminRoutes(getServices);

  return {
    getServices,
    routes,
  };
}

export type OutpostAdmin = ReturnType<typeof createOutpostAdmin>;

export { envRecordToConfig } from "../modules/admin/lib/config-keys.js";
export type { RequireAdminFn, AdminActor } from "../modules/admin/lib/require-admin.js";
export type {
  ConfigOverrideRepository,
  AdminConfigOverride,
} from "../modules/admin/repositories/config-override-repository.js";
