import { randomBytes } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  AUTH_TAG_BYTES,
  IV_BYTES,
  InMemoryCredentialStore,
  MASTER_KEY_BYTES,
  VaultError,
  open,
  parseMasterKey,
  reseal,
  seal,
  secretsEqual,
} from "./vault.js";

/**
 * Vault tests.
 *
 * The happy path is one test. The rest are adversarial, because that is where an
 * encryption wrapper actually fails: a round-trip test passes for ECB, for a fixed IV,
 * and for a cipher with no authentication at all. Each test below is written to fail
 * against one specific plausible-but-wrong implementation.
 */

/** Deterministic 32-byte key, so failures are reproducible. */
const KEY_A = Buffer.alloc(MASTER_KEY_BYTES, 0x11);
const KEY_B = Buffer.alloc(MASTER_KEY_BYTES, 0x22);

const SECRET = "sk-proj-DO-NOT-LEAK-abcdefghijklmnop1234";

describe("vault: round trip", () => {
  it("recovers the exact plaintext", () => {
    const sealed = seal(SECRET, KEY_A);
    expect(open(sealed, KEY_A)).toBe(SECRET);
  });

  it("round-trips unicode, empty and very long values", () => {
    const cases = [
      "",
      "a",
      "キネマ 🎬 émoji\u0000null-byte",
      "x".repeat(100_000),
    ];
    for (const value of cases) {
      expect(open(seal(value, KEY_A), KEY_A)).toBe(value);
    }
  });

  it("never stores the plaintext in the envelope", () => {
    const sealed = seal(SECRET, KEY_A);
    const serialised = JSON.stringify(sealed);

    expect(serialised).not.toContain(SECRET);
    // Also check the raw decoded bytes, in case base64 happened to hide a partial
    // match from the string check above.
    const ciphertextBytes = Buffer.from(sealed.ciphertext, "base64");
    expect(ciphertextBytes.includes(Buffer.from(SECRET, "utf8"))).toBe(false);
  });

  it("emits an envelope with a 12-byte IV and a 16-byte tag", () => {
    const sealed = seal(SECRET, KEY_A);
    expect(Buffer.from(sealed.iv, "base64")).toHaveLength(IV_BYTES);
    expect(Buffer.from(sealed.authTag, "base64")).toHaveLength(AUTH_TAG_BYTES);
    expect(sealed.version).toBe(1);
  });
});

describe("vault: IV uniqueness", () => {
  /**
   * THE MOST IMPORTANT TEST IN THIS FILE.
   *
   * Reusing a (key, IV) pair under GCM does not merely weaken the cipher — it leaks
   * the XOR of the two plaintexts and exposes the authentication subkey, allowing an
   * attacker to forge valid ciphertexts. An implementation that derived the IV from
   * the plaintext (or used a fixed one, or a counter reset on restart) would pass a
   * naive round-trip test and be completely broken.
   */
  it("produces different ciphertext AND different IV for the same plaintext", () => {
    const first = seal(SECRET, KEY_A);
    const second = seal(SECRET, KEY_A);

    expect(second.iv).not.toBe(first.iv);
    expect(second.ciphertext).not.toBe(first.ciphertext);
    expect(second.authTag).not.toBe(first.authTag);
  });

  it("does not repeat an IV across many encryptions", () => {
    // 500 samples: a 96-bit random IV colliding by chance is ~1e-138, so any collision
    // here means the IV is not random.
    const seen = new Set<string>();
    const rounds = 500;
    for (let i = 0; i < rounds; i++) {
      seen.add(seal(SECRET, KEY_A).iv);
    }
    expect(seen.size).toBe(rounds);
  });

  it("still decrypts every one of a batch of same-plaintext seals", () => {
    // Guards against a "fix" that made IVs unique but broke the ciphertext/tag pairing.
    for (let i = 0; i < 25; i++) {
      expect(open(seal(SECRET, KEY_A), KEY_A)).toBe(SECRET);
    }
  });
});

describe("vault: GCM authentication rejects tampering", () => {
  it("fails when the ciphertext is modified", () => {
    const sealed = seal(SECRET, KEY_A);

    // Flip one bit in the middle of the ciphertext.
    const bytes = Buffer.from(sealed.ciphertext, "base64");
    const midpoint = Math.floor(bytes.length / 2);
    bytes[midpoint] = bytes[midpoint]! ^ 0x01;

    const tampered = { ...sealed, ciphertext: bytes.toString("base64") };
    expect(() => open(tampered, KEY_A)).toThrow(VaultError);
    expect(() => open(tampered, KEY_A)).toThrow(/could not decrypt/i);
  });

  it("fails when the authentication tag is modified", () => {
    const sealed = seal(SECRET, KEY_A);
    const tag = Buffer.from(sealed.authTag, "base64");
    tag[0] = tag[0]! ^ 0xff;

    const tampered = { ...sealed, authTag: tag.toString("base64") };
    expect(() => open(tampered, KEY_A)).toThrow(VaultError);
  });

  it("fails when the IV is modified", () => {
    const sealed = seal(SECRET, KEY_A);
    const iv = Buffer.from(sealed.iv, "base64");
    iv[0] = iv[0]! ^ 0xff;

    const tampered = { ...sealed, iv: iv.toString("base64") };
    expect(() => open(tampered, KEY_A)).toThrow(VaultError);
  });

  it("fails on a truncated ciphertext rather than returning partial plaintext", () => {
    const sealed = seal(SECRET, KEY_A);
    const bytes = Buffer.from(sealed.ciphertext, "base64");

    const tampered = {
      ...sealed,
      ciphertext: bytes.subarray(0, bytes.length - 1).toString("base64"),
    };
    expect(() => open(tampered, KEY_A)).toThrow(VaultError);
  });

  it("reports tamper failures with the tamper-specific code, not a generic error", () => {
    const sealed = seal(SECRET, KEY_A);
    const tag = Buffer.from(sealed.authTag, "base64");
    tag[5] = tag[5]! ^ 0x0f;

    try {
      open({ ...sealed, authTag: tag.toString("base64") }, KEY_A);
      expect.unreachable("decryption should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(VaultError);
      expect((error as VaultError).code).toBe("decryption_failed");
    }
  });

  it("rejects a malformed envelope before attempting decryption", () => {
    const sealed = seal(SECRET, KEY_A);

    // A 5-byte IV would make Node throw an opaque error; we want a typed one.
    const shortIv = {
      ...sealed,
      iv: randomBytes(5).toString("base64"),
    };
    try {
      open(shortIv, KEY_A);
      expect.unreachable("should have thrown");
    } catch (error) {
      expect((error as VaultError).code).toBe("malformed_envelope");
    }

    expect(() => open({ ...sealed, authTag: "AAAA" }, KEY_A)).toThrow(/malformed/i);
  });

  it("rejects an unknown envelope version", () => {
    const sealed = seal(SECRET, KEY_A);
    const future = { ...sealed, version: 2 as unknown as 1 };
    expect(() => open(future, KEY_A)).toThrow(/version/i);
  });
});

describe("vault: key handling", () => {
  it("fails to decrypt with the wrong key", () => {
    const sealed = seal(SECRET, KEY_A);
    expect(() => open(sealed, KEY_B)).toThrow(VaultError);
    expect(() => open(sealed, KEY_B)).toThrow(/could not decrypt/i);
  });

  it("almost-right keys still fail (no partial-key tolerance)", () => {
    const sealed = seal(SECRET, KEY_A);
    // One byte different out of 32.
    const nearly = Buffer.from(KEY_A);
    nearly[31] = nearly[31]! ^ 0x01;
    expect(() => open(sealed, nearly)).toThrow(VaultError);
  });

  it("rejects a master key of the wrong length at seal time", () => {
    expect(() => seal(SECRET, Buffer.alloc(16))).toThrow(/32 bytes/);
    expect(() => seal(SECRET, Buffer.alloc(0))).toThrow(/32 bytes/);
  });

  it("rejects a master key of the wrong length at open time", () => {
    const sealed = seal(SECRET, KEY_A);
    expect(() => open(sealed, Buffer.alloc(31))).toThrow(/32 bytes/);
  });

  it("tags the envelope with a key id that changes with the key", () => {
    const a = seal(SECRET, KEY_A);
    const b = seal(SECRET, KEY_B);
    expect(a.keyId).not.toBe(b.keyId);

    // Stable for the same key, so rotation can group rows.
    expect(seal(SECRET, KEY_A).keyId).toBe(a.keyId);

    // ...and it is not itself key material.
    expect(a.keyId).not.toContain(KEY_A.toString("hex"));
  });
});

describe("parseMasterKey", () => {
  it("accepts a base64 key of exactly 32 bytes", () => {
    const key = randomBytes(32);
    const parsed = parseMasterKey(key.toString("base64"));
    expect(parsed).toHaveLength(MASTER_KEY_BYTES);
    expect(parsed.equals(key)).toBe(true);
  });

  it("accepts a 64-character hex key", () => {
    const key = randomBytes(32);
    const parsed = parseMasterKey(key.toString("hex"));
    expect(parsed.equals(key)).toBe(true);
  });

  it("prefers hex interpretation for a 64-char hex string", () => {
    // A 64-char string is valid base64 too; taking the base64 branch would silently
    // produce a 48-byte key and a confusing length error.
    const parsed = parseMasterKey("a".repeat(64));
    expect(parsed).toHaveLength(MASTER_KEY_BYTES);
    expect(parsed.equals(Buffer.alloc(32, 0xaa))).toBe(true);
  });

  it("refuses a missing key with an actionable message", () => {
    for (const value of [undefined, "", "   "]) {
      try {
        parseMasterKey(value);
        expect.unreachable("should have thrown");
      } catch (error) {
        expect((error as VaultError).code).toBe("missing_master_key");
        // The message must tell the operator how to fix it.
        expect((error as Error).message).toContain("openssl rand -base64 32");
      }
    }
  });

  it("refuses a short human passphrase rather than padding it", () => {
    // "hunter2" is not 32 bytes of entropy and must not be stretched into a key.
    expect(() => parseMasterKey("hunter2")).toThrow(VaultError);
    expect(() => parseMasterKey(Buffer.alloc(16).toString("base64"))).toThrow(
      /exactly 32 bytes/,
    );
  });

  it("trims surrounding whitespace so a pasted value works", () => {
    const key = randomBytes(32);
    expect(parseMasterKey(`  ${key.toString("base64")}  \n`).equals(key)).toBe(true);
  });
});

describe("secretsEqual", () => {
  it("compares equal and unequal secrets", () => {
    expect(secretsEqual("abc123", "abc123")).toBe(true);
    expect(secretsEqual("abc123", "abc124")).toBe(false);
  });

  it("returns false for different lengths without throwing", () => {
    expect(secretsEqual("short", "much-longer-value")).toBe(false);
  });
});

describe("reseal (key rotation)", () => {
  it("moves a secret to a new key and invalidates the old one", () => {
    const original = seal(SECRET, KEY_A);
    const rotated = reseal(original, KEY_A, KEY_B);

    expect(open(rotated, KEY_B)).toBe(SECRET);
    expect(rotated.keyId).not.toBe(original.keyId);
    // The old key must no longer open the new envelope.
    expect(() => open(rotated, KEY_A)).toThrow(VaultError);
  });

  it("propagates a failure rather than emitting a corrupt envelope", () => {
    const original = seal(SECRET, KEY_A);
    expect(() => reseal(original, KEY_B, KEY_B)).toThrow(VaultError);
  });
});

describe("InMemoryCredentialStore", () => {
  it("stores sealed envelopes keyed by connection id", async () => {
    const store = new InMemoryCredentialStore();
    const sealed = seal(SECRET, KEY_A);

    await store.put("conn-1", sealed);
    expect(await store.get("conn-1")).toEqual(sealed);
    expect(await store.get("missing")).toBeUndefined();
    expect(store.size()).toBe(1);
  });

  it("holds only ciphertext, never the plaintext", async () => {
    const store = new InMemoryCredentialStore();
    await store.put("conn-1", seal(SECRET, KEY_A));

    const value = await store.get("conn-1");
    expect(JSON.stringify(value)).not.toContain(SECRET);
    expect(JSON.stringify(value)).not.toContain("DO-NOT-LEAK");
  });

  it("deletes idempotently", async () => {
    const store = new InMemoryCredentialStore();
    await store.put("conn-1", seal(SECRET, KEY_A));
    await store.delete("conn-1");
    await store.delete("conn-1");
    expect(await store.get("conn-1")).toBeUndefined();
    expect(store.size()).toBe(0);
  });
});