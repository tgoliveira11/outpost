/**
 * Domain error taxonomy.
 *
 * Errors are classified so the dispatch pipeline can decide retry vs. fail
 * without inspecting provider-specific error shapes (TDR §3.4). Adapters map
 * their native errors onto these classes; the core never sees raw SDK errors.
 */

export type ErrorClass = "transient" | "permanent";

/** Base class for all errors Outpost raises. Carries a stable machine `code`. */
export class OutpostError extends Error {
  readonly code: string;
  constructor(code: string, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = new.target.name;
    this.code = code;
  }
}

/** A request failed authentication (missing/expired/revoked key). → HTTP 401. */
export class UnauthorizedError extends OutpostError {
  constructor(message = "Missing, expired, or revoked API key") {
    super("unauthorized", message);
  }
}

/** A valid key lacked the required scope. → HTTP 403. */
export class ForbiddenError extends OutpostError {
  constructor(message = "API key lacks the required scope") {
    super("forbidden", message);
  }
}

/** Caller input failed validation/sanitization. Never retried. → HTTP 400. */
export class ValidationError extends OutpostError {
  readonly details?: unknown;
  constructor(message: string, details?: unknown) {
    super("validation_failed", message);
    this.details = details;
  }
}

/** A referenced resource does not exist. → HTTP 404. */
export class NotFoundError extends OutpostError {
  constructor(message = "Resource not found") {
    super("not_found", message);
  }
}

/** A lifecycle transition violated the state machine. Programming/state bug. */
export class InvalidStateTransitionError extends OutpostError {
  constructor(from: string, to: string) {
    super("invalid_transition", `Cannot transition message from "${from}" to "${to}"`);
  }
}

/** Webhook signature verification failed. → HTTP 401, logged. */
export class WebhookVerificationError extends OutpostError {
  constructor(message = "Webhook signature verification failed") {
    super("webhook_unverified", message);
  }
}

/**
 * Raised by `EmailProvider` implementations. The `errorClass` drives retry:
 * `transient` errors go back to the queue with backoff; `permanent` errors go
 * straight to `failed` and the Dead Letter Queue.
 */
export class ProviderError extends OutpostError {
  readonly errorClass: ErrorClass;
  readonly providerCode?: string;
  constructor(
    errorClass: ErrorClass,
    message: string,
    options?: { providerCode?: string; cause?: unknown },
  ) {
    super(`provider_${errorClass}`, message, options);
    this.errorClass = errorClass;
    this.providerCode = options?.providerCode;
  }

  static transient(message: string, options?: { providerCode?: string; cause?: unknown }) {
    return new ProviderError("transient", message, options);
  }

  static permanent(message: string, options?: { providerCode?: string; cause?: unknown }) {
    return new ProviderError("permanent", message, options);
  }
}

/** Returns true when an unknown thrown value should be treated as retryable. */
export function isTransient(err: unknown): boolean {
  return err instanceof ProviderError && err.errorClass === "transient";
}
