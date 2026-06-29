/**
 * Adapters barrel — exported at `@tgoliveira/outpost/adapters`.
 *
 * Concrete implementations of the ports: providers, encryptors, rate limiters,
 * telemetry, logging, templates, and system services. The Drizzle persistence
 * adapter is exported separately at `@tgoliveira/outpost/drizzle` so apps that
 * bring their own storage don't pull in drizzle-orm.
 */

// Providers
export * from "./providers/fake.js";
export * from "./providers/smtp.js";
export * from "./providers/resend.js";

// Crypto
export * from "./crypto/recipient-hasher.js";
export * from "./crypto/encryptors.js";

// Rate limiting
export * from "./rate-limit/in-memory.js";

// Observability
export * from "./observability/logger.js";
export * from "./observability/telemetry.js";

// Templates
export * from "./template/in-memory.js";

// System services
export * from "./services/system.js";
