/**
 * Application layer barrel — use cases and the pipeline.
 *
 * Use cases orchestrate the domain via ports. They may import `domain` and
 * `ports` but NEVER a concrete adapter or framework.
 */
export * from "./context.js";
export * from "./config.js";
export * from "./enqueue-message.js";
export * from "./dispatch-message.js";
export * from "./ingest-webhook.js";
export * from "./manage-suppression.js";
export * from "./purge-retention.js";
export * from "./manage-api-key.js";
export * from "./authenticate.js";
export * from "./message-queries.js";

export * from "./pipeline/sanitize.js";
export * from "./pipeline/domain-validation.js";
export * from "./pipeline/retry-policy.js";
