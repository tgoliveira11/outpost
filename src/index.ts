/**
 * @tgoliveira/outpost — a transactional outbox with pluggable transport.
 *
 * Public entry point. Most apps need just:
 *
 *   import { createOutpost } from "@tgoliveira/outpost";
 *
 * Then bring adapters from the subpath exports:
 *   - "@tgoliveira/outpost/adapters" — providers, encryptors, rate limiters…
 *   - "@tgoliveira/outpost/drizzle"  — Postgres persistence
 *   - "@tgoliveira/outpost/next"     — HTTP route handlers
 *   - "@tgoliveira/outpost/workers"  — send & retention workers
 *   - "@tgoliveira/outpost/testing"  — in-memory repos + fakes
 *
 * Architecture (TDR §6): domain → ports → application → adapters. Dependencies
 * point inward only. See AGENTS.md and docs/ for the full guide.
 */

// Composition root
export { createOutpost } from "./create-outpost.js";
export type { OutpostOptions, EncryptionOptions } from "./create-outpost.js";
export { Outpost } from "./client/outpost-client.js";

// Domain (entities, lifecycle, errors) — pure, framework-free.
export * from "./domain/index.js";

// Ports (interfaces) — implement these to extend Outpost.
export * from "./ports/index.js";

// Application (use cases, config, pipeline) — the orchestration layer.
export * from "./application/index.js";
