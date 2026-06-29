import type { Sealed } from "../domain/message.js";

/**
 * Encryption ports (TDR §5.4).
 *
 * `Encryptor` is split into seal (write) and open (read) so the asymmetric,
 * least-privilege model is expressible in the type system: the ingestion API
 * is wired with a seal-only encryptor (public key), while the send worker holds
 * the open-capable one (private key). Compromising the web API therefore can
 * never read plaintext bodies back.
 */
export interface Encryptor {
  /** Algorithm tag stamped onto produced `Sealed` values. */
  readonly alg: string;
  /** Encrypt plaintext for storage at rest. */
  seal(plaintext: string): Promise<Sealed>;
  /**
   * Decrypt a sealed value. Seal-only encryptors (public-key ingestion side)
   * reject this with an error — by construction they cannot read.
   */
  open(sealed: Sealed): Promise<string>;
}

/**
 * Deterministic keyed HMAC of a recipient address. Used as the searchable
 * column for suppression matching and idempotency-by-recipient when the
 * plaintext recipient is encrypted (TDR §5.4 condition 3). Deterministic so the
 * same address always maps to the same digest; keyed so the digest cannot be
 * brute-forced from a leaked dump without the key.
 */
export interface RecipientHasher {
  hash(address: string): string;
}
