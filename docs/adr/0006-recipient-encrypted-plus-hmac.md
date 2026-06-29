# ADR 0006: Recipient stored as encrypted value + searchable HMAC

- Status: Accepted
- Date: 2026-06-29

## Context

Once the recipient address is encrypted at rest (ADR 0005), two essential
features break: suppression matching ("has this address hard-bounced?") and
idempotency/lookups keyed by recipient both need to *find rows by address*. You
cannot query an AEAD ciphertext — a fresh random IV makes the same address
encrypt to a different value every time. Storing the address in plaintext
alongside the ciphertext for searchability would defeat the encryption entirely.

## Decision

Store the recipient **twice**: the encrypted value (`recipient_sealed`) for the
payload, plus a deterministic **keyed HMAC-SHA256** of the normalized address in
a separate searchable, indexed column (`recipient_hmac`). Suppression entries and
recipient lookups match on the HMAC, never on plaintext. Realized by
`HmacRecipientHasher` (`src/adapters/crypto/recipient-hasher.ts`): it trims and
lowercases before hashing so casing/whitespace variants collapse to one digest,
and requires a key of >= 16 bytes that lives outside the DB. The HMAC is keyed
(not a bare hash) so a leaked dump cannot be brute-forced back into addresses
without the key.

## Consequences

- Suppression checks and recipient-keyed queries remain exact and index-backed
  even with encryption on.
- A leaked dump exposes only keyed digests, not addresses — and only if the HMAC
  key also leaks, which is kept separately in a secret manager.
- Cost: the HMAC key is load-bearing and must be **stable forever**. Changing it
  orphans every existing suppression entry and breaks lookups — documented as a
  hard rule. The key is mandatory even when encryption is off.
- A deterministic digest is correlatable (same address → same digest), an
  accepted trade for searchability.

## Alternatives considered

- **Plaintext recipient column for search.** Defeats encryption-at-rest.
  Rejected.
- **Unkeyed hash (e.g. SHA-256 of the address).** The address space of emails is
  brute-forceable; an unkeyed hash offers little protection. Rejected in favor of
  a keyed HMAC.
