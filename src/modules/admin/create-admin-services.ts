import type { Outpost } from "../../client/outpost-client.js";
import type { ConfigOverrideRepository } from "./repositories/config-override-repository.js";
import type { RequireAdminFn } from "./lib/require-admin.js";
import { createConfigOverrideService } from "./services/config-override-service.js";
import { createObservabilityService } from "./services/observability-service.js";

export type OutpostAdminConfig = {
  /** When false, admin routes return 404. Default true. */
  readonly enabled?: boolean;
  readonly configCacheTtlSeconds?: number;
};

export type OutpostAdminServices = {
  readonly outpost: Outpost;
  readonly admin: Required<OutpostAdminConfig>;
  readonly requireAdmin: RequireAdminFn;
  readonly envConfig: Record<string, unknown>;
  readonly configOverrideService: ReturnType<typeof createConfigOverrideService>;
  readonly observabilityService: ReturnType<typeof createObservabilityService>;
  readonly configOverrideRepository: ConfigOverrideRepository;
};

export type CreateOutpostAdminServicesOptions = {
  outpost: Outpost;
  requireAdmin: RequireAdminFn;
  configOverrideRepository: ConfigOverrideRepository;
  /** Values sourced from env.local / secret manager — second in priority after admin overrides. */
  envConfig?: Record<string, unknown>;
  admin?: OutpostAdminConfig;
};

export function createOutpostAdminServices(options: CreateOutpostAdminServicesOptions): OutpostAdminServices {
  const admin: Required<OutpostAdminConfig> = {
    enabled: options.admin?.enabled ?? true,
    configCacheTtlSeconds: options.admin?.configCacheTtlSeconds ?? 60,
  };

  const configOverrideService = createConfigOverrideService({
    envConfig: options.envConfig ?? {},
    configOverrideRepository: options.configOverrideRepository,
    configCacheTtlSeconds: admin.configCacheTtlSeconds,
  });

  return {
    outpost: options.outpost,
    admin,
    requireAdmin: options.requireAdmin,
    envConfig: options.envConfig ?? {},
    configOverrideService,
    observabilityService: createObservabilityService(options.outpost),
    configOverrideRepository: options.configOverrideRepository,
  };
}
