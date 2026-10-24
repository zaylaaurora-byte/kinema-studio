import {
  applyEnvelope,
  concat,
  createPrng,
  exponentialDecay,
  glidingSine,
  highPass,
  lowPass,
  measureSignal,
  normaliseTo,
  resonator,
  sawtooth,
  whiteNoise,
  type SignalCharacteristics,
} from "./dsp.js";

/**
 * Non-verbal vocalisations for the silent human.
 *
 * The character brief is exact and unusual: he NEVER speaks. Every sound he makes is
 * non-verbal, and the pilot's comedy depends on those sounds being distinct. A gasp, a
 * yelp and a wheeze that all render as "a short breath" are not a performance, they are
 * an absence of one.
 *
 * THE HONEST FRAME, stated once here and repeated wherever this surfaces: these are
 * SYNTHESISED SOUND EFFECTS, not recordings and not real vocalisations. They are built
 * from filtered noise, formant resonators and glides. They are recognisable as the right
 * *category* of sound and they are clearly distinguishable from one another, which is
 * what makes them usable as timing placeholders and as a demanding test fixture. They are
 * not a substitute for a foley library or a voice actor, and no claim is made that a
 * listener would mistake one for a human.
 *
 * WHERE THEY ARE USED: the mock provider, offline development, and CI. In production the
 * same `NonverbalKind` values would be dispatched to a sound library or recorded takes,
 * and the timeline code would not change at all — which is the point of typing them.
 *
 * Each sound is built from a documented acoustic recipe rather than tuned by ear, so a
 * reviewer can check the reasoning without listening:
 *
 * | kind    | source            | envelope            | distinguishing trait          |
 * |---------|-------------------|---------------------|-------------------------------|
 * | gasp    | high-passed noise | fast in, medium out | bright, brief, low energy     |
 * | yelp    | gliding saw       | sharp in, fast out  | fast up-glide, high pitch     |
 * | scream  | gliding saw       | sustained           | RISING, loud, long, bright    |
 * | wheeze  | low-passed noise  | slow in, slow out   | dark, noisy, long, low energy |
 * | impact  | full-band noise   | instant in, fast out| short, broadband transient    |
 * | breath  | low-passed noise  | cosine swell        | quiet, smooth, no transient   |
 */

/** The silent human's complete repertoire. */
export type NonverbalKind = "gasp" | "yelp" | "scream" | "wheeze" | "impact" | "breath";

export const NONVERBAL_KINDS: readonly NonverbalKind[] = [
  "gasp",
  "yelp",
  "scream",
  "wheeze",
  "impact",
  "breath",
];

export interface NonverbalRequest {
  readonly kind: NonverbalKind;
  /** 0 = barely audible, 1 = full commitment. */
  readonly intensity: number;
  readonly sampleRate: number;
  readonly channels: number;
  /** Seeds the noise, so the same request always gives the same bytes. */
  readonly seed: number;
}

/** Nominal duration of each sound before intensity scaling. */
const BASE_DURATION_MS: Record<NonverbalKind, number> = {
  gasp: 340,
  yelp: 240,
  scream: 1150,
  wheeze: 900,
  impact: 160,
  breath: 700,
};

/**
 * Nominal peak level of each sound. A scream should be loud and a breath should be
 * almost nothing; equalising them would destroy the dynamics the mix depends on.
 */
const BASE_PEAK: Record<NonverbalKind, number> = {
  gasp: 0.5,
  yelp: 0.7,
  scream: 0.95,
  wheeze: 0.35,
  impact: 0.8,
  breath: 0.22,
};

/**
 * Render one non-verbal sound.
 *
 * Intensity scales duration and level together, which is how real vocal effort works: a
 * more extreme gasp is both louder and longer, not merely louder.
 */
export function synthesiseNonverbal(request: NonverbalRequest): Float64Array {
  const { kind, sampleRate, channels, seed } = request;
  if (!Number.isFinite(request.intensity) || request.intensity < 0 || request.intensity > 1) {
    throw new RangeError(`Intensity must be between 0 and 1; received ${request.intensity}.`);
  }

  const intensity = request.intensity;
  // Duration scales from 0.7x to 1.15x. Bounded well below 2x because stretching a
  // 160 ms impact to 320 ms turns a punch into a whoosh — a different sound entirely.
  const durationScale = 0.7 + intensity * 0.45;
  const durationMs = BASE_DURATION_MS[kind] * durationScale;
  const n = Math.max(1, Math.round((durationMs / 1000) * sampleRate));
  const peak = BASE_PEAK[kind] * (0.55 + intensity * 0.45);

  const prng = createPrng(seed ^ 0x9e3779b9);
  const mono = renderMono(kind, n, sampleRate, prng, intensity);
  const shaped = applyEnvelope(mono, sampleRate, ...envelopeFor(kind, sampleRate, n));
  const normalised = normaliseTo(shaped, peak);

  // The scream is the one sound that is genuinely stereo in character: a slight
  // inter-channel difference stops it collapsing to a point source in the mix.
  if (channels === 2 && kind === "scream") {
    const out = new Float64Array(n * 2);
    for (let i = 0; i < n; i++) {
      const value = normalised[i]!;
      const drift = Math.sin((2 * Math.PI * 0.7 * i) / sampleRate) * 0.03;
      out[i * 2] = value * (1 + drift);
      out[i * 2 + 1] = value * (1 - drift);
    }
    return out;
  }

  return toChannels(normalised, channels);
}

/** Attack and release, in milliseconds. Chosen per sound from its physical character. */
function envelopeFor(
  kind: NonverbalKind,
  sampleRate: number,
  n: number,
): [number, number] {
  const ms = (value: number): number => Math.min(value, (n / sampleRate) * 1000 * 0.45);
  switch (kind) {
    case "gasp":
      return [ms(12), ms(90)];
    case "yelp":
      return [ms(6), ms(80)];
    case "scream":
      return [ms(45), ms(220)];
    case "wheeze":
      return [ms(180), ms(240)];
    case "impact":
      // Fast, not instant. A zero-length attack is a click, which reads as a
      // digital artefact rather than as a physical hit.
      return [ms(2), ms(55)];
    case "breath":
      return [ms(200), ms(260)];
  }
}

function renderMono(
  kind: NonverbalKind,
  n: number,
  sampleRate: number,
  prng: () => number,
  intensity: number,
): Float64Array {
  switch (kind) {
    case "gasp":
      return renderGasp(n, sampleRate, prng);
    case "yelp":
      return renderYelp(n, sampleRate, prng);
    case "scream":
      return renderScream(n, sampleRate, intensity);
    case "wheeze":
      return renderWheeze(n, sampleRate, prng);
    case "impact":
      return renderImpact(n, sampleRate, prng);
    case "breath":
      return renderBreath(n, sampleRate, prng);
  }
}

// ---------------------------------------------------------------------------
// Individual recipes
// ---------------------------------------------------------------------------

/**
 * GASP — a sharp intake of breath.
 *
 * Physically it is turbulent air through a constricted glottis, so: broadband noise with
 * most of its energy above the vocal range's fundamental, a very fast onset (the intake
 * is sudden) and a moderate decay. Two narrow resonances give it a faint vocal-tract
 * colour so it does not read as a hiss of static.
 *
 * vs. breath: higher cutoff, much shorter, louder.
 * vs. wheeze: bright rather than dark, and 2.6x shorter.
 */
function renderGasp(n: number, sampleRate: number, prng: () => number): Float64Array {
  const noise = whiteNoise(n, prng);
  const band = highPass(lowPass(noise, sampleRate, 6500), sampleRate, 700);
  const r1 = resonator(band, sampleRate, 1400, 450);
  const r2 = resonator(band, sampleRate, 2600, 700);
  const mixed = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    mixed[i] = band[i]! * 0.55 + r1[i]! * 0.3 + r2[i]! * 0.25;
  }
  return mixed;
}

/**
 * YELP — a startled, high, short cry.
 *
 * A fast upward glide, because a yelp is a startle reflex: the pitch jumps almost
 * immediately and then stops. The glide is on a sawtooth (harmonically rich, like a
 * voice) with a second formant, and it is deliberately HIGher than the scream at its
 * start and shorter overall.
 *
 * vs. scream: yelp rises 320 -> 720 Hz in 240 ms; scream rises 200 -> 900 Hz over
 * 1150 ms. Yelp is much shorter, yelp is a blip, scream is a sustained cry.
 */
function renderYelp(n: number, sampleRate: number, prng: () => number): Float64Array {
  const glide = glidingSine(n, sampleRate, (p) => 320 + 400 * Math.min(1, p * 2.5));
  // A saw at the glide's midpoint, for the harmonic body under the tone.
  const body = sawtooth(n, sampleRate, 480);
  const source = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const p = n <= 1 ? 0 : i / (n - 1);
    source[i] = glide[i]! * 0.6 + body[i]! * 0.4 * (1 - p);
  }
  const r1 = resonator(source, sampleRate, 1000, 300);
  const r2 = resonator(source, sampleRate, 2200, 500);
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    out[i] = source[i]! * 0.5 + r1[i]! * 0.3 + r2[i]! * 0.25;
  }
  // A trace of noise so it is not a pure tone, which would read as a synthesiser.
  const air = whiteNoise(n, prng);
  for (let i = 0; i < n; i++) {
    out[i] = out[i]! + air[i]! * 0.06;
  }
  return out;
}

/**
 * SCREAM — a rising cry of terror.
 *
 * The brief is explicit that a scream RISES, so the defining property is a monotonic
 * upward pitch glide (200 Hz to 900 Hz), held long and loud. Harmonics are summed
 * directly rather than glided as a single tone, so the spectrum stays rich — a scream is
 * not a whistle, it is a strained voice.
 *
 * vs. yelp: longer (1150 ms vs 240 ms), louder, and reaches a higher final pitch.
 * vs. everything else: by far the highest RMS and the longest duration.
 */
function renderScream(n: number, sampleRate: number, intensity: number): Float64Array {
  const out = new Float64Array(n);
  let phase = 0;
  const harmonics = 9;
  for (let i = 0; i < n; i++) {
    const p = n <= 1 ? 0 : i / (n - 1);
    // Rises quickly at first, then eases. A real scream peaks in the first third.
    const eased = 1 - (1 - p) ** 1.6;
    const f0 = 200 + 700 * eased;
    phase += (2 * Math.PI * f0) / sampleRate;

    let value = 0;
    for (let h = 1; h <= harmonics; h++) {
      // Roll off upper harmonics less at high intensity: that is what makes a
      // full-voice scream sound strained rather than flute-like.
      const rolloff = 1 / h ** (1.35 - intensity * 0.5);
      value += Math.sin(phase * h) * rolloff;
    }
    // A slow vibrato arrives after the onset, as the voice loses control.
    const vibratoDepth = 0.02 * Math.min(1, p * 3) * (0.5 + intensity * 0.5);
    const vibrato = 1 + Math.sin((2 * Math.PI * 5.5 * i) / sampleRate) * vibratoDepth;
    out[i] = value * vibrato;
  }

  // Formants shape the harmonics into something vocal rather than buzzy.
  const f1 = resonator(out, sampleRate, 800, 250);
  const f2 = resonator(out, sampleRate, 1150, 300);
  const shaped = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    shaped[i] = out[i]! * 0.7 + f1[i]! * 0.2 + f2[i]! * 0.2;
  }
  return shaped;
}

/**
 * WHEEZE — a laboured, obstructed exhalation.
 *
 * Narrow-band noise around 700 Hz with a slow onset and a long tail, plus a faint
 * low-frequency flutter so it has the pulsed quality of breathing rather than hissing.
 *
 * vs. breath: darker (energy concentrated far lower), longer, and carries the flutter.
 * vs. gasp: much slower onset and much lower zero-crossing rate.
 */
function renderWheeze(n: number, sampleRate: number, prng: () => number): Float64Array {
  const noise = whiteNoise(n, prng);
  const band = lowPass(highPass(noise, sampleRate, 180), sampleRate, 1400);
  const tuned = resonator(band, sampleRate, 700, 320);
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    // 2.2 Hz flutter with a slow amplitude wander across the whole sound.
    const flutter = 1 + Math.sin((2 * Math.PI * 2.2 * i) / sampleRate) * 0.35;
    const progress = n <= 1 ? 1 : i / (n - 1);
    const wander = 0.55 + 0.45 * Math.sin(Math.PI * progress);
    out[i] = (tuned[i]! * 0.8 + band[i]! * 0.2) * flutter * wander;
  }
  return out;
}

/**
 * IMPACT — a body hitting something. Wholly non-vocal.
 *
 * The physics of a hit is a broadband transient followed by a very fast decay, so this is
 * full-band noise plus a low thump, with an exponential envelope. It is the only sound in
 * the set with essentially no tonal centre, which is exactly what distinguishes it.
 *
 * vs. everything else: shortest (160 ms), highest high-frequency ratio, zero pitch.
 */
function renderImpact(n: number, sampleRate: number, prng: () => number): Float64Array {
  const noise = whiteNoise(n, prng);
  // Barely filtered: an impact's whole point is that its energy is spread wide.
  const broadband = highPass(lowPass(noise, sampleRate, 9000), sampleRate, 90);
  const thump = glidingSine(n, sampleRate, (p) => 130 * (1 - p * 0.65));
  const decay = exponentialDecay(n, sampleRate, 34, 0.001);

  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    out[i] = (broadband[i]! * 0.7 + thump[i]! * 0.45) * decay[i]!;
  }
  return out;
}

/**
 * BREATH — calm, quiet, unremarkable air.
 *
 * The quietest and smoothest sound in the set. Heavily low-passed noise with a cosine
 * swell and no transient whatsoever, so it can sit under dialogue without drawing
 * attention.
 *
 * vs. gasp: same family, but far quieter, far darker, and with a slow swell instead of a
 * sharp onset. That contrast is the point — a gasp should startle, a breath should not.
 */
function renderBreath(n: number, sampleRate: number, prng: () => number): Float64Array {
  const noise = whiteNoise(n, prng);
  const dark = lowPass(noise, sampleRate, 1100);
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const progress = n <= 1 ? 0 : i / (n - 1);
    // One slow swell across the sound: inhale, then release.
    const swell = Math.sin(Math.PI * progress) ** 1.4;
    out[i] = dark[i]! * swell;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function toChannels(mono: Float64Array, channels: number): Float64Array {
  if (channels === 1) return mono;
  const out = new Float64Array(mono.length * 2);
  for (let i = 0; i < mono.length; i++) {
    out[i * 2] = mono[i]!;
    out[i * 2 + 1] = mono[i]!;
  }
  return out;
}

/** Render every kind, for tests and for auditioning the palette. */
export function renderNonverbalPalette(
  sampleRate: number,
  channels: number,
  intensity = 0.7,
): Record<NonverbalKind, Float64Array> {
  const out = {} as Record<NonverbalKind, Float64Array>;
  for (const kind of NONVERBAL_KINDS) {
    out[kind] = synthesiseNonverbal({
      kind,
      intensity,
      sampleRate,
      channels,
      // Seeds differ per kind so two sounds never share a noise realisation, which
      // would otherwise make them correlated in the tests.
      seed: 0x51ed270b + kind.length * 7919 + kind.charCodeAt(0),
    });
  }
  return out;
}

/** Convenience: the measured characteristics of a rendered sound. */
export function describeNonverbal(
  samples: Float64Array,
  sampleRate: number,
  channels: number,
): SignalCharacteristics {
  return measureSignal(samples, sampleRate, channels);
}

/** Concatenate a sequence of non-verbal sounds with gaps, as a foley bed. */
export function sequenceNonverbal(
  events: readonly { kind: NonverbalKind; intensity: number; gapAfterMs: number }[],
  sampleRate: number,
  channels: number,
  seed = 1,
): Float64Array {
  const parts: Float64Array[] = [];
  let index = 0;
  for (const event of events) {
    parts.push(
      synthesiseNonverbal({
        kind: event.kind,
        intensity: event.intensity,
        sampleRate,
        channels,
        seed: seed + index * 104729,
      }),
    );
    parts.push(new Float64Array(Math.round((event.gapAfterMs / 1000) * sampleRate) * channels));
    index++;
  }
  return concat(parts);
}

/** Exposed for the tests that assert level and duration ordering. */
export const NONVERBAL_BASE_PEAK: Readonly<Record<NonverbalKind, number>> = BASE_PEAK;
export const NONVERBAL_BASE_DURATION_MS: Readonly<Record<NonverbalKind, number>> = BASE_DURATION_MS;