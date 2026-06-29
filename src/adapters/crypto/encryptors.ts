import {
  randomBytes,
  createCipheriv,
  createDecipheriv,
  publicEncrypt,
  privateDecrypt,
  constants as cryptoConstants,
} from "node:crypto";
import type { Encryptor } from "../../ports/crypto.js";
import type { Sealed } from "../../domain/message.js";

/**
 * Encryptor implementations (TDR §5.4). All use vetted primitives — no
 * hand-rolled crypto. Three flavors:
 *
 *   - NoopEncryptor       — encryption disabled; `alg: "plain"`. Same column
 *                           shape so encryption can be turned on later with no
 *                           row-format migration.
 *   - AesGcmEncryptor     — symmetric AEAD (AES-256-GCM). One key seals+opens.
 *   - Hybrid{Seal,Open}   — asymmetric least-privilege split: the ingestion API
 *                           gets seal-only (public key), the send worker gets
 *                           open (private key). The web tier physically cannot
 *                           read plaintext back.
 *
 * For production, hold key material in KMS/Vault and implement `Encryptor`
 * against it (envelope encryption) — these local-key classes are the reference
 * and the dev/test default. See docs/security.md.
 */

const PLAIN_ALG = "plain";

/** No-op: stores base64(plaintext). Used when encryption is disabled. */
export class NoopEncryptor implements Encryptor {
  readonly alg = PLAIN_ALG;
  async seal(plaintext: string): Promise<Sealed> {
    return { alg: PLAIN_ALG, ciphertext: Buffer.from(plaintext, "utf8").toString("base64") };
  }
  async open(sealed: Sealed): Promise<string> {
    return Buffer.from(sealed.ciphertext, "base64").toString("utf8");
  }
}

const AES_ALG = "aes-256-gcm";

/** Symmetric AEAD. The 32-byte key MUST come from KMS/secrets, not the DB. */
export class AesGcmEncryptor implements Encryptor {
  readonly alg = AES_ALG;
  private readonly key: Buffer;

  constructor(key: Buffer, private readonly keyId = "default") {
    if (key.length !== 32) throw new Error("AES-256-GCM requires a 32-byte key");
    this.key = key;
  }

  async seal(plaintext: string): Promise<Sealed> {
    const iv = randomBytes(12);
    const cipher = createCipheriv(AES_ALG, this.key, iv);
    const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
    const tag = cipher.getAuthTag();
    return {
      alg: AES_ALG,
      ciphertext: ct.toString("base64"),
      iv: iv.toString("base64"),
      tag: tag.toString("base64"),
      keyId: this.keyId,
    };
  }

  async open(sealed: Sealed): Promise<string> {
    if (sealed.alg === PLAIN_ALG) return new NoopEncryptor().open(sealed);
    if (!sealed.iv || !sealed.tag) throw new Error("Sealed value missing iv/tag");
    const decipher = createDecipheriv(AES_ALG, this.key, Buffer.from(sealed.iv, "base64"));
    decipher.setAuthTag(Buffer.from(sealed.tag, "base64"));
    const pt = Buffer.concat([
      decipher.update(Buffer.from(sealed.ciphertext, "base64")),
      decipher.final(),
    ]);
    return pt.toString("utf8");
  }
}

const HYBRID_ALG = "hybrid-rsa-aes-256-gcm";

function rsaOaep(key: string) {
  return { key, padding: cryptoConstants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256" } as const;
}

/**
 * Seal-only encryptor for the ingestion tier. Holds ONLY the public key:
 * generates a fresh AES data key per message, seals the payload with it, and
 * wraps the data key under RSA-OAEP. `open` throws — by construction the web
 * tier cannot decrypt (TDR §5.4 condition 2).
 */
export class HybridSealEncryptor implements Encryptor {
  readonly alg = HYBRID_ALG;
  constructor(private readonly publicKeyPem: string, private readonly keyId = "default") {}

  async seal(plaintext: string): Promise<Sealed> {
    const dataKey = randomBytes(32);
    const iv = randomBytes(12);
    const cipher = createCipheriv(AES_ALG, dataKey, iv);
    const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
    const tag = cipher.getAuthTag();
    const wrappedKey = publicEncrypt(rsaOaep(this.publicKeyPem), dataKey);
    return {
      alg: HYBRID_ALG,
      ciphertext: ct.toString("base64"),
      iv: iv.toString("base64"),
      tag: tag.toString("base64"),
      wrappedKey: wrappedKey.toString("base64"),
      keyId: this.keyId,
    };
  }

  async open(): Promise<string> {
    throw new Error(
      "HybridSealEncryptor cannot decrypt: the ingestion tier holds only the public key (by design)",
    );
  }
}

/**
 * Open-capable encryptor for the send worker. Holds the private key; unwraps the
 * data key and decrypts. `seal` throws — the worker is not the writer.
 */
export class HybridOpenEncryptor implements Encryptor {
  readonly alg = HYBRID_ALG;
  constructor(private readonly privateKeyPem: string) {}

  async seal(): Promise<Sealed> {
    throw new Error("HybridOpenEncryptor is read-only; use HybridSealEncryptor to seal");
  }

  async open(sealed: Sealed): Promise<string> {
    if (sealed.alg === PLAIN_ALG) return new NoopEncryptor().open(sealed);
    if (!sealed.wrappedKey || !sealed.iv || !sealed.tag) {
      throw new Error("Sealed value missing wrappedKey/iv/tag for hybrid open");
    }
    const dataKey = privateDecrypt(
      rsaOaep(this.privateKeyPem),
      Buffer.from(sealed.wrappedKey, "base64"),
    );
    const decipher = createDecipheriv(AES_ALG, dataKey, Buffer.from(sealed.iv, "base64"));
    decipher.setAuthTag(Buffer.from(sealed.tag, "base64"));
    const pt = Buffer.concat([
      decipher.update(Buffer.from(sealed.ciphertext, "base64")),
      decipher.final(),
    ]);
    return pt.toString("utf8");
  }
}
