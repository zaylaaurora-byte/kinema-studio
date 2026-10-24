import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";

/**
 * Credential vault — AES-256-GCM envelope encryption for BYOK provider keys.
 *
 * This module exists because of one sentence in SECURITY.md:
 *
 *   "Keys are encrypted at rest with AES-256-GCM envelope encryption and are never
 *    returned to the client after storage."
 *
 * Everything here is written to make that statement true rather than aspirational.
 *
 * ---------------------------------------------------------------------------
 * WHY GCM, AND WHAT IT BUYS US
 * ---------------------------------------------------------------------------
 * GCM is an *authenticated* cipher: it produces a 16-byte authentication tag that
 * covers both the ciphertext and any additional authenticated data. Decryption
 * therefore fails loudly on tampering instead of returning plausible garbage. That
 * matters more for API keys than for most data: a silently corrupted key would
 * surface to the user as "invalid credentials", sending them to re-issue a key that
 * was never the problem.
 *
 * ---------------------------------------------------------------------------
 * THE ONE RULE THAT IS EASY TO GET CATASTROPHICALLY WRONG: NEVER REUSE AN IV
 * ---------------------------------------------------------------------------
 * GCM's security proof collapses if a (key, IV) pair is ever reused. Two messages
 * encrypted under the same key and nonce leak the XOR of their plaintexts, and — far
 * worse — expose the authentication subkey, letting an attacker forge arbitrary
 * valid ciphertexts. With AES-GCM this is not a theoretical degradation; it is a
 * total break of confidentiality *and* integrity.
 *
 * So the IV is generated fresh with a CSPRNG for every single `seal()` call and is
 * never derived from the plaintext, a counter, or a timestamp. `vault.test.ts` pins
 * this by encrypting the same plaintext twice and asserting the outputs differ in
 * both ciphertext and IV. There is deliberately no API to pass your own IV.
 *
 * 12 bytes (96 bits) is the size GCM is specified and optimised for: it is used
 * directly as the initial counter block rather than being run through GHASH first, so
 * it is both the fastest and the best-studied choice. Other lengths are legal but are
 * hashed internally and give weaker guarantees — we do not expose that footgun.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS MODULE DELIBERATELY DOES NOT DO
 * ---------------------------------------------------------------------------
 * There is no key derivation, no password hashing and no stretching here. The master
 * key is expected to arrive as 32 bytes of high-entropy random material (`.env.example`
 * documents `openssl rand -base64 32`). Running a KDF over an already-random 256-bit
 * key would add cost without adding entropy. Refusing to accept a weak passphrase is
 * the honest design; inventing our own KDF would not be.
 */

/** AES-256 requires a 32-byte key. */
export const MASTER_KEY_BYTES = 32;

/** 96 bits, the GCM-native nonce size. See the warning above before changing this. */
export const IV_BYTES = 12;

/** GCM's authentication tag is always 128 bits. */
export const AUTH_TAG_BYTES = 16;

/**
 * A sealed credential.
 *
 * All three parts are base64 so the whole envelope can be stored in a single TEXT
 * column, or as three, depending on what the persistence layer prefers. Keeping them
 * as separate fields rather than one concatenated blob makes the stored shape
 * self-describing: an operator inspecting a database row can see that an IV and a tag
 * exist, which is exactly the property that lets them confirm GCM is in use.
 */
export interface SealedCredential {
  /** Base64 AES-256-GCM ciphertext. */
  readonly ciphertext: string;
  /** Base64 12-byte initialisation vector. Unique per encryption. */
  readonly iv: string;
  /** Base64 16-byte GCM authentication tag. */
  readonly authTag: string;
  /** Envelope version, so the format can migrate without a flag day. */
  readonly version: 1;
  /** Identifies which master key sealed this, for rotation. */
  readonly keyId: string;
}

/** Why a secret could not be decrypted. Turns an opaque crypto failure into an action. */
export type VaultErrorCode =
  | "missing_master_key"
  | "invalid_master_key"
  | "decryption_failed"
  | "malformed_envelope";

export class VaultError extends Error {
  readonly code: VaultErrorCode;

  constructor(code: VaultErrorCode, message: string) {
    super(message);
    this.name = "VaultError";
    this.code = code;
  }
}

/**
 * Derive a stable, non-secret identifier for a master key.
 *
 * Used to tag each envelope with the key that produced it so a rotation can find and
 * re-seal the old rows. This is a *fingerprint of the key itself*, which is sensitive
 * in the same way a password hash is: it must never be logged alongside anything that
 * narrows the search space. We only ever expose it inside a sealed envelope, and it is
 * an HMAC-free SHA-256 of the raw key bytes — sufficient for identification, useless
 * for recovery.
 */
function deriveKeyId(masterKey: Buffer): string {
  // Truncated because the full digest is not needed for identification and a shorter
  // value leaks marginally less about the key.
  return createHash("sha256").update(masterKey).digest("hex").slice(0, 16);
}

/**
 * Parse `VAULT_MASTER_KEY` into raw key bytes.
 *
 * Accepted encodings, in order:
 *   1. base64 (what `openssl rand -base64 32` emits, and what .env.example documents)
 *   2. hex (64 characters, convenient for people who prefer `openssl rand -hex 32`)
 *
 * A key that decodes to anything other than exactly 32 bytes is rejected rather than
 * padded or truncated. Silent padding is how a "256-bit key" becomes a 128-bit key
 * with trailing zeroes, which is both weaker and undetectable.
 */
export function parseMasterKey(raw: string | undefined): Buffer {
  if (raw === undefined || raw.trim().length === 0) {
    throw new VaultError(
      "missing_master_key",
      "VAULT_MASTER_KEY is not set. Generate one with `openssl rand -base64 32` and add it to .env. " +
        "Provider credentials cannot be stored or read without it.",
    );
  }

  const trimmed = raw.trim();

  // Hex first: a 64-char hex string is also valid base64, so base64 must not win by
  // default or a hex key would decode to 48 meaningless bytes.
  if (/^[0-9a-fA-F]{64}$/.test(trimmed)) {
    return Buffer.from(trimmed, "hex");
  }

  const decoded = Buffer.from(trimmed, "base64");
  if (decoded.length !== MASTER_KEY_BYTES) {
    throw new VaultError(
      "invalid_master_key",
      `VAULT_MASTER_KEY must decode to exactly ${MASTER_KEY_BYTES} bytes (got ${decoded.length}). ` +
        "Generate a valid key with `openssl rand -base64 32`.",
    );
  }
  return decoded;
}

/**
 * Invariant check used by `seal`. Kept separate so it runs on every call — a master
 * key that is somehow the wrong length must fail at encryption time, not at the first
 * decryption, which could be days later in production.
 */
function assertUsableKey(masterKey: Buffer): void {
  if (masterKey.length !== MASTER_KEY_BYTES) {
    throw new VaultError(
      "invalid_master_key",
      `Master key must be ${MASTER_KEY_BYTES} bytes; received ${masterKey.length}.`,
    );
  }
}

/**
 * Encrypt a secret.
 *
 * @param plaintext The secret. Never logged, never returned, never echoed in errors.
 * @param masterKey 32 raw key bytes, from `parseMasterKey`.
 */
export function seal(plaintext: string, masterKey: Buffer): SealedCredential {
  assertUsableKey(masterKey);

  // Fresh CSPRNG nonce, every call. See the IV-reuse warning at the top of this file.
  const iv = randomBytes(IV_BYTES);

  const cipher = createCipheriv("aes-256-gcm", masterKey, iv, {
    authTagLength: AUTH_TAG_BYTES,
  });

  const ciphertext = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);

  return {
    ciphertext: ciphertext.toString("base64"),
    iv: iv.toString("base64"),
    authTag: cipher.getAuthTag().toString("base64"),
    version: 1,
    keyId: deriveKeyId(masterKey),
  };
}

/**
 * Decrypt a sealed secret.
 *
 * Throws `VaultError` on any failure. The message is deliberately uniform — it never
 * says whether the ciphertext, the IV, the tag or the key was wrong, because that
 * distinction is a decryption oracle. Callers get `decryption_failed` and stop.
 */
export function open(sealed: SealedCredential, masterKey: Buffer): string {
  assertUsableKey(masterKey);

  if (sealed.version !== 1) {
    throw new VaultError(
      "malformed_envelope",
      `Unsupported vault envelope version ${String(sealed.version)}.`,
    );
  }

  const iv = Buffer.from(sealed.iv, "base64");
  const authTag = Buffer.from(sealed.authTag, "base64");
  const ciphertext = Buffer.from(sealed.ciphertext, "base64");

  // Validate the envelope's shape BEFORE touching the cipher. Node's createDecipheriv
  // throws a generic error for a bad IV length, and we want a typed, non-oracular
  // failure instead.
  if (iv.length !== IV_BYTES || authTag.length !== AUTH_TAG_BYTES) {
    throw new VaultError(
      "malformed_envelope",
      "Sealed credential is malformed: the IV or authentication tag has the wrong length.",
    );
  }

  try {
    const decipher = createDecipheriv("aes-256-gcm", masterKey, iv, {
      authTagLength: AUTH_TAG_BYTES,
    });
    decipher.setAuthTag(authTag);

    const plaintext = Buffer.concat([
      decipher.update(ciphertext),
      decipher.final(), // GCM authentication happens HERE. Tampering throws.
    ]);

    return plaintext.toString("utf8");
  } catch {
    // Covers: wrong key, tampered ciphertext, tampered tag. One message for all three.
    throw new VaultError(
      "decryption_failed",
      "Could not decrypt the stored credential. It may have been tampered with, or " +
        "VAULT_MASTER_KEY may have changed since it was saved.",
    );
  }
}

/**
 * Re-seal a credential under a new master key.
 *
 * The rotation primitive: read with the old key, write with the new. Deliberately a
 * single function rather than something callers assemble, so the plaintext exists for
 * the shortest possible window and cannot accidentally be returned.
 */
export function reseal(
  sealed: SealedCredential,
  oldMasterKey: Buffer,
  newMasterKey: Buffer,
): SealedCredential {
  // The plaintext is a local that goes out of scope immediately. JS strings are
  // immutable and cannot be zeroed, so this is the narrowest window available without
  // changing every downstream API to hold Buffers — which would make the common path
  // more error-prone for a marginal gain at this layer.
  const plaintext = open(sealed, oldMasterKey);
  return seal(plaintext, newMasterKey);
}

/**
 * Constant-time comparison for two secrets.
 *
 * Present for callers that must compare a presented key against a stored one (for
 * example, a local-worker token). Uses `timingSafeEqual`, which requires equal-length
 * buffers, so the lengths are compared first — that does leak length, which is
 * unavoidable and not meaningful for fixed-format keys.
 */
export function secretsEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, "utf8");
  const bufB = Buffer.from(b, "utf8");
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

// ---------------------------------------------------------------------------
// Storage abstraction
// ---------------------------------------------------------------------------

/**
 * How credentials are read and written in the host application.
 *
 * NOTE ON THE IN-MEMORY IMPLEMENTATION BELOW: it exists for tests and for local
 * development with no database configured. It is explicitly NOT production storage —
 * secrets vanish on restart and a heap dump would expose them. Production uses a
 * database; `apps/api` wires its own store, and `.env.example` already documents
 * `DATABASE_URL=file:./data/kinema.db` (SQLite) or PostgreSQL.
 *
 * The interface is deliberately narrow: only whole-credential read and write. There is
 * no "get the API key" method, which means no calling code can accidentally pull a raw
 * secret into a place that serialises responses.
 */
export interface CredentialStore {
  /** Persist the sealed envelope for a connection id, replacing any existing one. */
  put(connectionId: string, sealed: SealedCredential): Promise<void>;
  /** Read the sealed envelope. Returns undefined when the connection has no secret. */
  get(connectionId: string): Promise<SealedCredential | undefined>;
  /** Permanently remove the secret. Must be idempotent. */
  delete(connectionId: string): Promise<void>;
}

/**
 * In-memory `CredentialStore` for tests and development.
 *
 * Stores only ciphertext: even this implementation never holds a plaintext key, so a
 * test that inspects the store cannot accidentally assert against a raw secret and
 * thereby normalise leaking it.
 */
export class InMemoryCredentialStore implements CredentialStore {
  readonly #entries = new Map<string, SealedCredential>();

  async put(connectionId: string, sealed: SealedCredential): Promise<void> {
    this.#entries.set(connectionId, sealed);
  }

  async get(connectionId: string): Promise<SealedCredential | undefined> {
    return this.#entries.get(connectionId);
  }

  async delete(connectionId: string): Promise<void> {
    this.#entries.delete(connectionId);
  }

  /** Test helper: how many secrets are held. Never returns the secrets themselves. */
  size(): number {
    return this.#entries.size;
  }
}