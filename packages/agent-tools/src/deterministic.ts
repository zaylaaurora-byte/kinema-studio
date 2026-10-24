/**
 * Deterministic hashing.
 *
 * ── Why this exists ──────────────────────────────────────────────────────────
 *
 * Three separate requirements need a content hash:
 *
 *   1. **The production target is a budget.** Turning a goal into a plan means turning
 *      prose into numbers — how many scenes, how many images, how many seconds of audio.
 *      A hash gives a stable, arbitrary-but-reproducible decomposition, so the same goal
 *      always yields the same plan and the same cost, with no randomness anywhere.
 *   2. **"Same goal → identical plan"** is a test assertion, and this is the only source
 *      of variation in the mock planner. If it were not deterministic, the test would be
 *      a coin flip.
 *   3. **Audit.** `AuditMetadata.contentHash` lets a resumed run prove it is executing the
 *      plan that was approved, rather than one that merely looks similar.
 *
 * FNV-1a, 32-bit, is used deliberately: it is short enough to diff by eye in a test
 * failure, has no dependency, and its collision behaviour is irrelevant here — a collision
 * would produce a slightly different scene count, not a wrong render.
 */

/**
 * FNV-1a over the UTF-16 code units of `input`.
 *
 * Returns an unsigned 32-bit integer. `Math.imul` keeps the multiply in 32-bit range,
 * which is what makes the result identical across engines and platforms.
 */
export function fnv1a(input: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/** A short hexadecimal digest, for ids and content hashes. */
export function shortHash(input: string, length = 8): string {
  const h1 = fnv1a(input);
  // A second, differently-seeded pass widens the digest so 8 characters are not just
  // 32 bits — enough separation that two different scenes never share an id in practice.
  const h2 = fnv1a(`${input}\u0000salt`);
  const hex = h1.toString(16).padStart(8, "0") + h2.toString(16).padStart(8, "0");
  return hex.slice(0, length);
}

/**
 * A deterministic integer in `[min, max]`, inclusive.
 *
 * @throws RangeError if the range is empty or inverted. Silently returning `min` would
 *   hide a real bug in a caller's arithmetic.
 */
export function deterministicInt(seedText: string, min: number, max: number): number {
  if (!Number.isFinite(min) || !Number.isFinite(max) || max < min) {
    throw new RangeError(`deterministicInt: invalid range [${min}, ${max}].`);
  }
  if (max === min) return min;
  const span = max - min + 1;
  return min + (fnv1a(seedText) % span);
}

/**
 * A deterministic pick from a list.
 *
 * @throws RangeError on an empty list, rather than returning `undefined` and pushing the
 *   problem into a place where it reads as a missing-value bug.
 */
export function deterministicPick<T>(seedText: string, options: readonly T[]): T {
  if (options.length === 0) {
    throw new RangeError("deterministicPick: cannot pick from an empty list.");
  }
  const choice = options[fnv1a(seedText) % options.length];
  // `noUncheckedIndexedAccess` cannot see that the modulo bounds the index; the guard
  // makes the invariant explicit rather than casting it away.
  if (choice === undefined) {
    throw new RangeError("deterministicPick: index out of range, which should be impossible.");
  }
  return choice;
}

/** Round to a fixed number of decimal places, avoiding float dust in cost arithmetic. */
export function roundTo(value: number, decimals = 4): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}