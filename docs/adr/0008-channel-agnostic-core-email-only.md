# ADR 0008: Channel-agnostic core, email-only v1

- Status: Accepted
- Date: 2026-06-29

## Context

Outpost's value — durable, idempotent, auditable, provider-swappable delivery —
is not specific to email; the same machinery would serve SMS, push, or webhooks.
The temptation is to build a fully generalized multi-channel abstraction up
front. But abstractions guessed from a single example are usually wrong: you
encode the quirks of the one channel you have into the "generic" interface and
pay to undo it later. Premature abstraction is its own form of risk.

## Decision

Build the **core channel-agnostic** (domain entities, lifecycle state machine,
outbox, retention, suppression carry no email-specific assumptions) but ship
**only email in v1**, behind a single narrow `EmailProvider` port
(`src/ports/email-provider.ts`) with Resend, SMTP/Mailpit, and a fake
implementation. The abstraction is designed to permit a second channel and
provider fallback, but those are not built until a real second transport
(e.g. SMS, in Phase 2) forces and validates the generalization.

## Consequences

- v1 stays small and honest: one channel, no speculative seams that nobody
  exercises.
- The core's purity (no Next.js / Drizzle / provider imports inward) means
  adding a channel later is additive, not a rewrite.
- The provider abstraction already exists, so swapping email providers
  (Resend ↔ SMTP ↔ SES) needs no core change today.
- Cost: a future multi-channel API may need to revisit naming that currently
  reads as email-centric (`subject`, `EmailProvider`). Accepted — better to
  refactor against a real second case than to guess now.

## Alternatives considered

- **Full multi-channel abstraction in v1.** Maximum future flexibility, but the
  interface would be guessed from one example and likely wrong. Rejected as
  premature.
- **Hard-code email throughout.** Cheapest now, but bakes email assumptions into
  the durable core, making any later channel a rewrite. Rejected.
