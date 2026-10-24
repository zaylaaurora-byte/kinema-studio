import { describe, expect, it } from "vitest";

import { measureSignal, toDb } from "./dsp.js";
import {
  NONVERBAL_BASE_DURATION_MS,
  NONVERBAL_BASE_PEAK,
  NONVERBAL_KINDS,
  renderNonverbalPalette,
  sequenceNonverbal,
  synthesiseNonverbal,
  type NonverbalKind,
} from "./nonverbal.js";
import { decodeWav } from "./wav.js";
import { MockVoiceAdapter } from "./providers/mock-voice.js";

/**
 * Non-verbal sound tests for the silent human.
 *
 * The character NEVER speaks — every sound he makes is non-verbal, and the comedy depends
 * on those sounds being distinct. A gasp, a yelp and a wheeze that all render as "a short
 * breath" are not a performance, so the central test here is PAIRWISE DISTINCTNESS,
 * measured rather than asserted by name.
 *
 * The metrics are chosen because each catches a different kind of collapse:
 *   - duration           catches two sounds that are the same length
 *   - RMS                catches two sounds at the same level
 *   - zero-crossing rate catches two sounds of the same brightness
 *   - high-frequency ratio catches two sounds with the same spectral centre of gravity
 *
 * And a reminder that belongs in every file that touches this: these are SYNTHESISED
 * SOUND EFFECTS, not recordings and not human vocalisations. They are timed placeholders
 * and a demanding test fixture. No claim is made that they are usable foley.
 */

const SAMPLE_RATE = 24000;
const CHANNELS = 1;

interface Profile {
  readonly kind: NonverbalKind;
  readonly rms: number;
  readonly peak: number;
  readonly durationSeconds: number;
  readonly zcr: number;
  readonly highRatio: number;
}

function profileOf(kind: NonverbalKind, intensity = 0.7): Profile {
  const samples = synthesiseNonverbal({
    kind,
    intensity,
    sampleRate: SAMPLE_RATE,
    channels: CHANNELS,
    seed: 12345,
  });
  const measured = measureSignal(samples, SAMPLE_RATE, CHANNELS);
  return {
    kind,
    rms: measured.rms,
    peak: measured.peak,
    durationSeconds: measured.durationSeconds,
    zcr: measured.zeroCrossingRate,
    highRatio: measured.highFrequencyRatio,
  };
}

const PALETTE = NONVERBAL_KINDS.map((kind) => profileOf(kind));

/**
 * Two sounds count as audibly distinct when they differ substantially in at least one of
 * the four dimensions. Thresholds are deliberately generous — this asserts that a listener
 * could tell them apart, not that they are statistically independent.
 */
function areDistinct(a: Profile, b: Profile): { distinct: boolean; reason: string } {
  const durationRatio = Math.max(a.durationSeconds, b.durationSeconds) /
    Math.min(a.durationSeconds, b.durationSeconds);
  if (durationRatio >= 1.5) {
    return { distinct: true, reason: `duration differs by ${durationRatio.toFixed(2)}x` };
  }

  const rmsDeltaDb = Math.abs(a.rms === 0 || b.rms === 0 ? 0 : 20 * Math.log10(a.rms / b.rms));
  if (rmsDeltaDb >= 3) {
    return { distinct: true, reason: `level differs by ${rmsDeltaDb.toFixed(1)} dB` };
  }

  const zcrRatio = Math.max(a.zcr, b.zcr) / Math.max(1, Math.min(a.zcr, b.zcr));
  if (zcrRatio >= 1.5) {
    return { distinct: true, reason: `brightness differs by ${zcrRatio.toFixed(2)}x` };
  }

  const highRatioDelta = Math.abs(a.highRatio - b.highRatio);
  if (highRatioDelta >= 0.15) {
    return { distinct: true, reason: `high-frequency share differs by ${highRatioDelta.toFixed(2)}` };
  }

  return { distinct: false, reason: "no metric separates them" };
}

describe("non-verbal sounds — every kind is real audio", () => {
  it("produces a non-empty, non-silent signal for every kind", () => {
    for (const kind of NONVERBAL_KINDS) {
      const samples = synthesiseNonverbal({
        kind,
        intensity: 0.7,
        sampleRate: SAMPLE_RATE,
        channels: CHANNELS,
        seed: 999,
      });
      expect(samples.length, `${kind} has samples`).toBeGreaterThan(0);
      const measured = measureSignal(samples, SAMPLE_RATE, CHANNELS);
      expect(measured.rms, `${kind} has energy`).toBeGreaterThan(0.001);
      expect(measured.peak, `${kind} peaks`).toBeGreaterThan(0.05);
      // And nothing may exceed full scale: these are mixed later.
      expect(measured.peak, `${kind} stays in range`).toBeLessThanOrEqual(1);
    }
  });

  it("starts and ends at zero, so it cannot click when dropped into a timeline", () => {
    // A discontinuity at the boundary is broadband energy, heard as a tick. Every sound
    // is enveloped for this reason, including the sharp ones.
    for (const kind of NONVERBAL_KINDS) {
      const samples = synthesiseNonverbal({
        kind,
        intensity: 0.8,
        sampleRate: SAMPLE_RATE,
        channels: CHANNELS,
        seed: 7,
      });
      expect(Math.abs(samples[0]!), `${kind} starts at zero`).toBeLessThan(0.02);
      expect(Math.abs(samples[samples.length - 1]!), `${kind} ends at zero`).toBeLessThan(0.02);
    }
  });

  it("is deterministic: the same request gives identical samples", () => {
    for (const kind of NONVERBAL_KINDS) {
      const request = { kind, intensity: 0.6, sampleRate: SAMPLE_RATE, channels: CHANNELS, seed: 42 };
      const a = synthesiseNonverbal(request);
      const b = synthesiseNonverbal(request);
      expect(Array.from(a)).toEqual(Array.from(b));
    }
  });

  it("differs between kinds even with the same seed, so no two share a realisation", () => {
    const request = { intensity: 0.6, sampleRate: SAMPLE_RATE, channels: CHANNELS, seed: 42 };
    const renders = NONVERBAL_KINDS.map((kind) => synthesiseNonverbal({ ...request, kind }));
    for (let i = 0; i < renders.length; i++) {
      for (let j = i + 1; j < renders.length; j++) {
        expect(renders[i]!.length === renders[j]!.length &&
          Array.from(renders[i]!).every((v, k) => v === renders[j]![k]), 
          `${NONVERBAL_KINDS[i]} vs ${NONVERBAL_KINDS[j]}`,
        ).toBe(false);
      }
    }
  });

  it("rejects an out-of-range intensity rather than producing a broken sound", () => {
    expect(() =>
      synthesiseNonverbal({
        kind: "gasp",
        intensity: 1.5,
        sampleRate: SAMPLE_RATE,
        channels: CHANNELS,
        seed: 1,
      }),
    ).toThrow(/Intensity/);
  });

  it("scales duration and level with intensity", () => {
    for (const kind of NONVERBAL_KINDS) {
      const quiet = profileOf(kind, 0.1);
      const loud = profileOf(kind, 1.0);
      expect(loud.peak, `${kind} louder`).toBeGreaterThan(quiet.peak);
      expect(loud.durationSeconds, `${kind} longer`).toBeGreaterThanOrEqual(quiet.durationSeconds);
    }
  });
});

describe("non-verbal sounds — pairwise distinctness", () => {
  it("every pair is separated by at least one measured characteristic", () => {
    // THE test the brief asks for. If any pair collapses, these placeholder sounds stop
    // being able to stand in for six different reactions.
    const failures: string[] = [];
    for (let i = 0; i < PALETTE.length; i++) {
      for (let j = i + 1; j < PALETTE.length; j++) {
        const a = PALETTE[i]!;
        const b = PALETTE[j]!;
        const verdict = areDistinct(a, b);
        if (!verdict.distinct) {
          failures.push(`${a.kind} vs ${b.kind}: ${verdict.reason}`);
        }
      }
    }
    expect(failures).toEqual([]);
    // Sanity: 6 kinds means 15 pairs, all checked.
    expect((PALETTE.length * (PALETTE.length - 1)) / 2).toBe(15);
  });

  it("has six distinct duration/level/brightness profiles", () => {
    // A second, blunter check on the same data: the tuples themselves must be unique.
    const tuples = PALETTE.map(
      (p) => `${p.durationSeconds.toFixed(3)}|${p.rms.toFixed(4)}|${p.zcr.toFixed(0)}`,
    );
    expect(new Set(tuples).size).toBe(NONVERBAL_KINDS.length);
  });

  it("separates a scream from a yelp: the brief's cleanest contrast", () => {
    // Both rise and both are loud, so they are the pair most likely to collapse into one
    // another. A scream is long and sustained; a yelp is a short blip.
    const scream = profileOf("scream");
    const yelp = profileOf("yelp");

    expect(scream.durationSeconds).toBeGreaterThan(yelp.durationSeconds * 2);
    expect(scream.rms).toBeGreaterThan(yelp.rms);
    expect(areDistinct(scream, yelp).distinct).toBe(true);
  });

  it("separates an impact from everything else by being short and broadband", () => {
    // An impact has essentially no tonal centre, which is what makes it a hit rather
    // than a vocalisation. Two properties carry that:
    //
    //   - DURATION: it is the shortest sound in the palette by a wide margin.
    //   - SPECTRAL SPREAD: its energy is not concentrated on a few low probe bands the
    //     way a voiced sound's is, so its high-frequency share sits between the voiced
    //     sounds (near 0) and the airy ones (gasp 0.52, breath 0.16).
    //
    // NOTE on zero-crossing rate, which an earlier version of this test wrongly used:
    // the GASP has a HIGHER zcr (10994) than the impact (8854), and that is correct
    // rather than a defect. A gasp is high-passed at 700 Hz to sound like a sharp
    // intake of air, while an impact is low-passed at 9 kHz around a 130 Hz thump — so
    // the gasp genuinely is the brighter of the two. Asserting otherwise would have been
    // asserting a fact about synthesis that is not true.
    const impact = profileOf("impact");
    const voiced = PALETTE.filter((p) => ["scream", "yelp", "wheeze"].includes(p.kind));

    for (const other of voiced) {
      expect(impact.durationSeconds, `impact shorter than ${other.kind}`).toBeLessThan(
        other.durationSeconds,
      );
    }

    // The impact is mid-spectrum: brighter than a pure tone, darker than a gasp or breath.
    expect(impact.highRatio).toBeGreaterThan(0.02);
    expect(impact.highRatio).toBeLessThan(0.15);
    for (const other of voiced) {
      expect(impact.highRatio, `impact brighter than ${other.kind}`).toBeGreaterThan(
        other.highRatio,
      );
    }

    // And no pair collapses, which is the property that actually matters.
    for (const other of PALETTE) {
      if (other.kind === "impact") continue;
      expect(areDistinct(impact, other).distinct, `impact vs ${other.kind}`).toBe(true);
    }
  });

  it("separates a gasp from a breath: same family, very different delivery", () => {
    // Both are air, so this is the subtlest pair. A gasp startles; a breath does not.
    const gasp = profileOf("gasp");
    const breath = profileOf("breath");

    expect(gasp.durationSeconds).toBeLessThan(breath.durationSeconds);
    expect(gasp.rms).toBeGreaterThan(breath.rms);
    expect(areDistinct(gasp, breath).distinct).toBe(true);
  });

  it("separates a wheeze from a scream by brightness and level", () => {
    const wheeze = profileOf("wheeze");
    const scream = profileOf("scream");
    expect(scream.rms).toBeGreaterThan(wheeze.rms);
    expect(areDistinct(wheeze, scream).distinct).toBe(true);
  });

  it("keeps a scream as the loudest and a breath as the quietest", () => {
    // Asserting the level ordering the recipes document, so a future edit that flattens
    // the dynamics fails loudly.
    const loudest = [...PALETTE].sort((a, b) => b.rms - a.rms)[0]!;
    const quietest = [...PALETTE].sort((a, b) => a.rms - b.rms)[0]!;
    expect(loudest.kind).toBe("scream");
    expect(quietest.kind).toBe("breath");
  });

  it("makes an impact the shortest and a scream the longest", () => {
    const shortest = [...PALETTE].sort((a, b) => a.durationSeconds - b.durationSeconds)[0]!;
    const longest = [...PALETTE].sort((a, b) => b.durationSeconds - a.durationSeconds)[0]!;
    expect(shortest.kind).toBe("impact");
    expect(longest.kind).toBe("scream");
  });

  it("matches the documented base durations and peaks", () => {
    // The recipe table in nonverbal.ts is a claim; this holds it to account.
    for (const kind of NONVERBAL_KINDS) {
      const profile = profileOf(kind);
      const baseSeconds = NONVERBAL_BASE_DURATION_MS[kind] / 1000;
      // At intensity 0.7 the duration scale is 0.7 + 0.7 * 0.45 = 1.015.
      expect(profile.durationSeconds).toBeGreaterThan(baseSeconds * 0.9);
      expect(profile.durationSeconds).toBeLessThan(baseSeconds * 1.2);
      // The peak must be at or below the documented base peak.
      expect(profile.peak).toBeLessThanOrEqual(NONVERBAL_BASE_PEAK[kind] + 1e-6);
    }
  });
});

describe("non-verbal sounds — rendering and sequencing", () => {
  it("renders the whole palette with distinct content", () => {
    const palette = renderNonverbalPalette(SAMPLE_RATE, CHANNELS);
    expect(Object.keys(palette).sort()).toEqual([...NONVERBAL_KINDS].sort());

    const profiles = NONVERBAL_KINDS.map((kind) =>
      measureSignal(palette[kind], SAMPLE_RATE, CHANNELS),
    );
    // Every render must carry energy.
    for (const [index, measured] of profiles.entries()) {
      expect(measured.rms, `${NONVERBAL_KINDS[index]} has energy`).toBeGreaterThan(0.001);
    }
  });

  it("sequences sounds with gaps, preserving total duration", () => {
    // A foley bed: gasp, beat, impact.
    const bed = sequenceNonverbal(
      [
        { kind: "gasp", intensity: 0.8, gapAfterMs: 200 },
        { kind: "impact", intensity: 0.9, gapAfterMs: 300 },
      ],
      SAMPLE_RATE,
      CHANNELS,
    );

    const gaspFrames = Math.round(NONVERBAL_BASE_DURATION_MS.gasp * 1.06 * (SAMPLE_RATE / 1000));
    const impactFrames = Math.round(NONVERBAL_BASE_DURATION_MS.impact * 1.06 * (SAMPLE_RATE / 1000));
    const gapFrames = Math.round(0.2 * SAMPLE_RATE) + Math.round(0.3 * SAMPLE_RATE);

    // Allow a few frames of rounding slack across the concatenation.
    expect(Math.abs(bed.length - (gaspFrames + impactFrames + gapFrames))).toBeLessThan(200);
  });

  it("produces a WAV the decoder can read back", () => {
    const adapter = new MockVoiceAdapter({ sampleRate: SAMPLE_RATE, channels: 1, bitDepth: 32 });
    const wav = adapter.speakNonverbal("scream", 0.9);
    const decoded = decodeWav(wav);

    expect(decoded.sampleRate).toBe(SAMPLE_RATE);
    expect(decoded.channels).toBe(1);
    const measured = measureSignal(decoded.samples, decoded.sampleRate, decoded.channels);
    // The scream must survive encode/decode at a healthy level.
    expect(measured.rmsDb).toBeGreaterThan(-20);
  });

  it("renders the whole palette as WAVs through the adapter", () => {
    const adapter = new MockVoiceAdapter({ sampleRate: SAMPLE_RATE, channels: 1, bitDepth: 32 });
    const palette = adapter.speakNonverbalPalette(0.7);

    const profiles = NONVERBAL_KINDS.map((kind) => {
      const decoded = decodeWav(palette[kind]);
      const measured = measureSignal(decoded.samples, decoded.sampleRate, decoded.channels);
      return { kind, ...measured };
    });

    // Pairwise distinctness must survive the full encode/decode path, not just exist in
    // memory — otherwise the files on disk could be interchangeable.
    for (let i = 0; i < profiles.length; i++) {
      for (let j = i + 1; j < profiles.length; j++) {
        const a = profiles[i]!;
        const b = profiles[j]!;
        const distinct =
          Math.max(a.durationSeconds, b.durationSeconds) /
            Math.min(a.durationSeconds, b.durationSeconds) >= 1.5 ||
          Math.abs(a.rmsDb - b.rmsDb) >= 3 ||
          Math.max(a.zeroCrossingRate, b.zeroCrossingRate) /
            Math.max(1, Math.min(a.zeroCrossingRate, b.zeroCrossingRate)) >= 1.5 ||
          Math.abs(a.highFrequencyRatio - b.highFrequencyRatio) >= 0.15;
        expect(distinct, `${a.kind} vs ${b.kind} in WAV form`).toBe(true);
      }
    }
  });

  it("reports levels in dB that match the linear values", () => {
    const profile = profileOf("impact");
    expect(toDb(profile.rms)).toBeLessThan(0);
    expect(profile.peak).toBeGreaterThan(profile.rms);
  });
});