/**
 * Ports layer barrel — the interfaces the application core depends on.
 *
 * Ports may import from `domain` only. Adapters implement these; use cases
 * consume them. No concrete SDK imports live here.
 */
export * from "./email-provider.js";
export * from "./repositories.js";
export * from "./crypto.js";
export * from "./services.js";
export * from "./template.js";
