/**
 * Domain layer barrel — the innermost, framework-free core.
 *
 * Everything here is pure data and invariants. Nothing in this directory may
 * import from `application`, `adapters`, `ports`, or any third-party SDK.
 * Dependencies point inward only (Clean Architecture, TDR §6).
 */
export * from "./lifecycle.js";
export * from "./message.js";
export * from "./suppression.js";
export * from "./api-key.js";
export * from "./retention.js";
export * from "./webhook.js";
export * from "./audit.js";
export * from "./errors.js";
