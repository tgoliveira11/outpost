# ADR 0004: Domain validation = syntax + MX only, no mailbox probing

- Status: Accepted
- Date: 2026-06-29

## Context

Sending to obviously invalid addresses wastes provider quota and generates hard
bounces that damage sender reputation. It is tempting to go further and verify
that the specific mailbox exists by opening an SMTP conversation (`RCPT TO`) and
reading the server's response. In practice mailbox probing is unreliable —
many servers accept-then-bounce, greylist, or deliberately answer "ok" to every
address to defeat harvesting — and the probing traffic itself looks like
spam-list reconnaissance and harms reputation.

## Decision

The outbound pipeline validates **syntax (always)** and performs an **optional,
cached MX-record lookup** for the recipient domain. It does **not** probe
individual mailboxes. MX checking is configurable (`domainValidation.mx`) and
backed by the injectable `MxResolver` port (default `DnsMxResolver`), so it can
be disabled or cached aggressively. Real per-mailbox validity is established the
honest way: by observing actual bounces via webhooks and feeding them to the
suppression list (ADR 0006/0007).

## Consequences

- Catches the cheap, high-value errors (malformed address, domain with no mail
  exchanger) without the reputational cost of probing.
- MX results are cached, so validation does not add a DNS round-trip per send.
- Cost: Outpost cannot tell you a mailbox is invalid *before* the first send —
  that signal only arrives as a bounce. This is accepted as the correct trade.
- A non-goal is stated plainly: Outpost is not mailbox-level verification.

## Alternatives considered

- **SMTP `RCPT TO` probing.** Rejected: unreliable signal, and the probe traffic
  itself degrades sender reputation.
- **Third-party verification APIs.** Adds an external dependency and cost for a
  signal the bounce/suppression loop already provides more honestly. Deferred.
