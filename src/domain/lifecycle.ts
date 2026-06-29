/**
 * Message lifecycle states and the transition rules between them.
 *
 * This module is PURE: no I/O, no framework, no provider. It encodes the
 * state machine described in the TDR §3.3. Everything outward (use cases,
 * repositories, workers) leans on these rules rather than re-deriving them.
 *
 *                  ┌─────────────┐
 *    enqueue ─────▶│   queued    │
 *                  └──────┬──────┘
 *                         │ claimed by send worker
 *                         ▼
 *                  ┌─────────────┐  suppressed recipient
 *                  │  sending    │────────────────────────▶ suppressed
 *                  └──────┬──────┘
 *                         │ provider accepted
 *                         ▼
 *                  ┌─────────────┐
 *                  │    sent     │  (accepted, not yet confirmed)
 *                  └──────┬──────┘
 *                         │ webhook
 *          ┌──────────────┼───────────────┬────────────┐
 *          ▼              ▼               ▼            ▼
 *      delivered       bounced        complained     failed
 *
 *  Transient dispatch error → back to `queued` with backoff (retry).
 *  Permanent error / retries exhausted → `failed` (terminal, DLQ).
 */

export const LIFECYCLE_STATES = [
  "queued",
  "sending",
  "sent",
  "delivered",
  "bounced",
  "complained",
  "failed",
  "suppressed",
] as const;

export type LifecycleState = (typeof LIFECYCLE_STATES)[number];

/**
 * Terminal states never transition again. The retention worker only ever acts
 * on rows in a terminal state (and only after the webhook window has closed),
 * which is what makes it safe to run concurrently with the send worker.
 */
export const TERMINAL_STATES = [
  "delivered",
  "bounced",
  "complained",
  "failed",
  "suppressed",
] as const satisfies readonly LifecycleState[];

const TERMINAL_SET = new Set<LifecycleState>(TERMINAL_STATES);

export function isTerminal(state: LifecycleState): boolean {
  return TERMINAL_SET.has(state);
}

/**
 * Allowed transitions. A transition not present here is a domain invariant
 * violation and must be rejected by the use case (never silently applied).
 */
const ALLOWED_TRANSITIONS: Record<LifecycleState, readonly LifecycleState[]> = {
  queued: ["sending", "suppressed", "failed"],
  // `sending` can fall back to `queued` on a transient error (retry).
  sending: ["sent", "queued", "failed", "suppressed"],
  sent: ["delivered", "bounced", "complained", "failed"],
  delivered: [],
  bounced: [],
  complained: [],
  failed: ["queued"], // DLQ replay re-enqueues a failed message
  suppressed: [],
};

export function canTransition(from: LifecycleState, to: LifecycleState): boolean {
  return ALLOWED_TRANSITIONS[from].includes(to);
}

/**
 * Which lifecycle states must feed the suppression list when reached.
 * Hard bounces and complaints damage sender reputation if re-sent, so the
 * recipient is suppressed automatically (TDR §3.6).
 */
export function shouldSuppressOn(state: LifecycleState): boolean {
  return state === "bounced" || state === "complained";
}
