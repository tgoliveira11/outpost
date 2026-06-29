# ADR 0005: Encryption-at-rest, not E2E; keys in KMS; asymmetric split

- Status: Accepted
- Date: 2026-06-29

## Context

Message bodies and recipient addresses are PII. The realistic threats are a
leaked database dump, a stolen backup, a curious DBA, or SQLi reading the
`outbox` table — i.e. data **at rest**. The body cannot be hidden from the email
provider (the provider must render and deliver it), so end-to-end encryption
against the provider is not achievable and promising it would be dishonest.
Encryption is also pure theater if the key lives next to the data: a dump that
includes the key protects nothing.

## Decision

Outpost offers **encryption-at-rest, explicitly not E2E**, with three guards
against theater: (1) key material lives **outside the DB** in a KMS/Vault; (2) an
**asymmetric least-privilege split** — the ingestion tier seals with the public
key and *cannot* read back, only the send worker holds the private key to
decrypt; (3) no hand-rolled crypto. Decryption happens **only in the send
worker, immediately before dispatch**. Realized in
`src/adapters/crypto/encryptors.ts`: `HybridSealEncryptor` (public-key seal;
`open()` throws by design), `HybridOpenEncryptor` (private-key open; `seal()`
throws), and `AesGcmEncryptor` (AES-256-GCM for the simpler symmetric mode).
The `Encryptor` port lets you bring a KMS/Vault-backed envelope implementation.

## Consequences

- A stolen DB dump or backup yields ciphertext, not bodies/recipients.
- By construction a compromised web tier cannot decrypt historical payloads —
  it never holds the private key (omit `privateKey` there and `open()` refuses).
- The same sealed column shape is used when encryption is off (`NoopEncryptor`,
  `alg: "plain"`), so it can be enabled later with no row-format migration.
- Cost: a real KMS and key-rotation story are the operator's responsibility;
  the bundled local-key classes are a reference/dev default, not production KMS.
- It does **not** protect the message in transit to the provider — documented.

## Alternatives considered

- **One symmetric key shared by web + worker.** Simpler, but the web tier could
  then read every body, defeating least privilege. Offered as the `symmetric`
  mode but not the recommended posture.
- **End-to-end encryption.** Impossible while the provider must read the body;
  would be a false privacy promise. Rejected and stated as a non-goal.
