import {
  OVERRIDABLE_KEYS,
  OUTPOST_CONFIG_KEYS,
  getConfigKeyMeta,
  getNestedValue,
  maskSecretValue,
} from "../lib/config-keys.js";
import type { ConfigOverrideRepository } from "../repositories/config-override-repository.js";

export type ConfigKeyView = {
  readonly key: string;
  readonly source: "admin" | "env" | "default";
  readonly value: unknown;
  readonly secret?: boolean;
};

type ConfigOverrideServiceDeps = {
  envConfig: Record<string, unknown>;
  configOverrideRepository: ConfigOverrideRepository;
  configCacheTtlSeconds?: number;
};

export function createConfigOverrideService({
  envConfig,
  configOverrideRepository,
  configCacheTtlSeconds = 60,
}: ConfigOverrideServiceDeps) {
  let cache: Map<string, unknown> | null = null;
  let cacheLoadedAt = 0;
  const ttlMs = configCacheTtlSeconds * 1000;

  async function loadCache(): Promise<Map<string, unknown>> {
    const rows = await configOverrideRepository.getAll();
    cache = new Map(rows.map((r) => [r.key, r.value]));
    cacheLoadedAt = Date.now();
    return cache;
  }

  async function getOverrides(): Promise<Map<string, unknown>> {
    if (cache && (ttlMs === 0 || Date.now() - cacheLoadedAt < ttlMs)) {
      return cache;
    }
    return loadCache();
  }

  function invalidateCache(): void {
    cache = null;
    cacheLoadedAt = 0;
  }

  async function setOverride(key: string, value: unknown, actor: string): Promise<void> {
    if (!OVERRIDABLE_KEYS.has(key)) {
      throw new Error(`Key "${key}" is not overridable via admin panel`);
    }
    await configOverrideRepository.set(key, value, actor);
    invalidateCache();
  }

  async function deleteOverride(key: string): Promise<void> {
    await configOverrideRepository.delete(key);
    invalidateCache();
  }

  async function listAllKeys(): Promise<ConfigKeyView[]> {
    const overrides = await getOverrides();

    return OUTPOST_CONFIG_KEYS.map((meta) => {
      const secret = meta.secret === true;
      if (overrides.has(meta.key)) {
        const raw = overrides.get(meta.key);
        return {
          key: meta.key,
          source: "admin" as const,
          value: secret ? maskSecretValue(raw) : raw,
          secret,
        };
      }
      const envValue = getNestedValue(envConfig, meta.key);
      if (envValue !== undefined) {
        return {
          key: meta.key,
          source: "env" as const,
          value: secret ? maskSecretValue(envValue) : envValue,
          secret,
        };
      }
      return {
        key: meta.key,
        source: "default" as const,
        value: meta.defaultValue,
        secret,
      };
    });
  }

  /** Resolved value for runtime: admin → env → default. */
  async function resolveValue(key: string): Promise<unknown> {
    const meta = getConfigKeyMeta(key);
    if (!meta) return undefined;
    const overrides = await getOverrides();
    if (overrides.has(key)) return overrides.get(key);
    const envValue = getNestedValue(envConfig, key);
    if (envValue !== undefined) return envValue;
    return meta.defaultValue;
  }

  return {
    getOverrides,
    setOverride,
    deleteOverride,
    listAllKeys,
    resolveValue,
    invalidateCache,
  };
}

export type ConfigOverrideService = ReturnType<typeof createConfigOverrideService>;
