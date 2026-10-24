import { describe, expect, it } from "vitest";

import { AudioMixError, UnsupportedAudioFormatError } from "./errors.js";
import {
  dbToGain,
  gainToDb,
  INTELLIGIBLE_RMS_DB,
  linearFade,
  measureLoudness,
  mixToWav,
  windowRms,
  type TimelineClip,
} from "./mix.js";
import { decodeWav } from "./wav.js";

/**
 * Mixing tests.
 *
 * Everything is checked against the DECODED output WAV rather than against in-memory
 * buffers, because the file is the deliverable. A mix that is correct in memory but
 * mis-encoded would pass a buffer-only test and ship broken.
 */

const SAMPLE_RATE = 24000;
const CHANNELS = 1;

/** A constant-amplitude tone, so RMS and peak are predictable in closed form. */
function tone(
  durationSeconds: number,
  frequency: number,
  amplitude: number,
  sampleRate = SAMPLE_RATE,
  channels = CHANNELS,
): Float64Array {
  const frames = Math.round(durationSeconds * sampleRate);
  const out = new Float64Array(frames * channels);
  for (let f = 0; f < frames; f++) {
    const value = amplitude * Math.sin((2 * Math.PI * frequency * f) / sampleRate);
    for (let c = 0; c < channels; c++) out[f * channels + c] = value;
  }
  return out;
}

function clip(overrides: Partial<TimelineClip> & { samples: Float64Array }): TimelineClip {
  return {
    channels: CHANNELS,
    sampleRate: SAMPLE_RATE,
    startSeconds: 0,
    gainDb: 0,
    ...overrides,
  };
}

describe("dB gain conversion", () => {
  it("converts −6 dB to half amplitude, which is the definition", () => {
    // This is the bug the module documents: using 10^(dB/10) instead of 10^(dB/20) makes
    // every fader wrong by a factor of two in dB terms.
    expect(dbToGain(-6)).toBeCloseTo(0.501187, 5);
    expect(dbToGain(0)).toBe(1);
    expect(dbToGain(6)).toBeCloseTo(1.995262, 5);
    expect(dbToGain(-20)).toBeCloseTo(0.1, 10);
  });

  it("round-trips through gainToDb", () => {
    for (const db of [-30, -12, -6, -3, 0, 3, 6, 12]) {
      expect(gainToDb(dbToGain(db))).toBeCloseTo(db, 10);
    }
  });

  it("reports silence as negative infinity rather than a finite number", () => {
    expect(gainToDb(0)).toBe(Number.NEGATIVE_INFINITY);
  });

  it("rejects a non-finite gain", () => {
    expect(() => dbToGain(Number.NaN)).toThrow(AudioMixError);
    expect(() => dbToGain(Number.POSITIVE_INFINITY)).toThrow(AudioMixError);
  });
});

describe("linearFade", () => {
  it("rises linearly from zero across the fade-in", () => {
    const gains = linearFade(100, 100, 0.5, 0);
    // 0.5 s at 100 Hz is 50 frames, but the buffer is only 100 frames.
    expect(gains[0]).toBeCloseTo(0, 10);
    expect(gains[24]).toBeCloseTo(0.48, 6);
    expect(gains[49]).toBeCloseTo(0.98, 6);
    expect(gains[50]).toBe(1);
    expect(gains[99]).toBe(1);
  });

  it("falls linearly to zero across the fade-out", () => {
    const gains = linearFade(100, 100, 0, 0.3);
    expect(gains[0]).toBe(1);
    expect(gains[69]).toBe(1);
    expect(gains[99]).toBeCloseTo(0, 10);
    expect(gains[84]).toBeCloseTo(0.5, 2);
  });

  it("never exceeds unity, even when the fades overlap", () => {
    // A short clip with long fades could otherwise be boosted above 1 in the middle,
    // which would silently add gain the creator never asked for.
    const gains = linearFade(50, 100, 1, 1);
    for (const gain of gains) {
      expect(gain).toBeLessThanOrEqual(1);
      expect(gain).toBeGreaterThanOrEqual(0);
    }
  });

  it("returns unity everywhere with no fades", () => {
    const gains = linearFade(64, SAMPLE_RATE, 0, 0);
    expect(Array.from(gains).every((g) => g === 1)).toBe(true);
  });
});

describe("mixToWav — timeline placement", () => {
  it("produces a file of exactly the requested duration", () => {
    const result = mixToWav([clip({ samples: tone(0.5, 440, 0.5) })], {
      durationSeconds: 2,
      sampleRate: SAMPLE_RATE,
      channels: CHANNELS,
    });

    const decoded = decodeWav(result.wav);
    expect(decoded.sampleRate).toBe(SAMPLE_RATE);
    expect(decoded.channels).toBe(CHANNELS);
    expect(decoded.samples.length).toBe(2 * SAMPLE_RATE);
    expect(result.frameCount).toBe(2 * SAMPLE_RATE);
    expect(result.durationSeconds).toBe(2);
  });

  it("places a clip at 1.0s with energy present there and absent before", () => {
    // THE placement test from the brief. Silence before the clip and signal at it is the
    // only way to prove the clip landed where the timeline said, rather than merely
    // existing somewhere in the file.
    const result = mixToWav([clip({ samples: tone(0.5, 440, 0.8), startSeconds: 1.0 })], {
      durationSeconds: 2,
      sampleRate: SAMPLE_RATE,
      channels: CHANNELS,
    });

    const decoded = decodeWav(result.wav);

    // Absent before 1.0s.
    const before = windowRms(decoded.samples, SAMPLE_RATE, CHANNELS, 0, 0.9);
    expect(before).toBe(0);

    // Present at 1.0s onwards.
    const at = windowRms(decoded.samples, SAMPLE_RATE, CHANNELS, 1.0, 1.4);
    expect(at).toBeGreaterThan(0.3);

    // And silent again after the clip ends at 1.5s.
    const after = windowRms(decoded.samples, SAMPLE_RATE, CHANNELS, 1.6, 2.0);
    expect(after).toBe(0);

    // The exact sample index must match, not just the neighbourhood.
    const sampleIndex = Math.round(1.0 * SAMPLE_RATE);
    expect(Math.abs(decoded.samples[sampleIndex - 1]!)).toBe(0);
    expect(Math.abs(decoded.samples[sampleIndex + 20]!)).toBeGreaterThan(0.1);
  });

  it("places two clips at different times, both at the right offsets", () => {
    const result = mixToWav(
      [
        clip({ samples: tone(0.25, 300, 0.6), startSeconds: 0.5, label: "first" }),
        clip({ samples: tone(0.25, 900, 0.6), startSeconds: 1.5, label: "second" }),
      ],
      { durationSeconds: 2.5, sampleRate: SAMPLE_RATE, channels: CHANNELS },
    );

    const decoded = decodeWav(result.wav);
    expect(decoded.samples.length).toBe(Math.round(2.5 * SAMPLE_RATE));

    // Each clip's window has energy; the gaps between do not.
    expect(windowRms(decoded.samples, SAMPLE_RATE, CHANNELS, 0.5, 0.7)).toBeGreaterThan(0.3);
    expect(windowRms(decoded.samples, SAMPLE_RATE, CHANNELS, 1.5, 1.7)).toBeGreaterThan(0.3);
    expect(windowRms(decoded.samples, SAMPLE_RATE, CHANNELS, 0.0, 0.45)).toBe(0);
    expect(windowRms(decoded.samples, SAMPLE_RATE, CHANNELS, 0.9, 1.4)).toBe(0);
    expect(windowRms(decoded.samples, SAMPLE_RATE, CHANNELS, 1.9, 2.5)).toBe(0);
  });

  it("sums overlapping clips additively", () => {
    // Two identical clips at the same position must double the amplitude.
    const single = mixToWav([clip({ samples: tone(0.5, 440, 0.3) })], {
      durationSeconds: 1,
      sampleRate: SAMPLE_RATE,
      channels: CHANNELS,
    });
    const doubled = mixToWav(
      [
        clip({ samples: tone(0.5, 440, 0.3) }),
        clip({ samples: tone(0.5, 440, 0.3) }),
      ],
      { durationSeconds: 1, sampleRate: SAMPLE_RATE, channels: CHANNELS },
    );

    const a = decodeWav(single.wav);
    const b = decodeWav(doubled.wav);
    const index = 1000;
    expect(b.samples[index]!).toBeCloseTo(a.samples[index]! * 2, 9);
  });

  it("truncates a clip that runs past the timeline end and reports it", () => {
    const result = mixToWav([clip({ samples: tone(3, 440, 0.5), startSeconds: 1, label: "long" })], {
      durationSeconds: 2,
      sampleRate: SAMPLE_RATE,
      channels: CHANNELS,
    });

    expect(result.clips[0]!.truncated).toBe(true);
    // The file is still exactly the timeline length.
    expect(decodeWav(result.wav).samples.length).toBe(2 * SAMPLE_RATE);
  });

  it("reports a clip that is not truncated as such", () => {
    const result = mixToWav([clip({ samples: tone(0.5, 440, 0.5), startSeconds: 1, label: "fit" })], {
      durationSeconds: 2,
      sampleRate: SAMPLE_RATE,
      channels: CHANNELS,
    });
    expect(result.clips[0]!.truncated).toBe(false);
  });
});

describe("mixToWav — gain", () => {
  it("applies −6 dB as a measurable drop in RMS versus 0 dB", () => {
    // The brief's requirement. −6 dB is half amplitude, which is −6.02 dB in RMS terms.
    const unity = mixToWav([clip({ samples: tone(0.5, 440, 0.5), gainDb: 0 })], {
      durationSeconds: 1,
      sampleRate: SAMPLE_RATE,
      channels: CHANNELS,
    });
    const cut = mixToWav([clip({ samples: tone(0.5, 440, 0.5), gainDb: -6 })], {
      durationSeconds: 1,
      sampleRate: SAMPLE_RATE,
      channels: CHANNELS,
    });

    const unityRms = windowRms(decodeWav(unity.wav).samples, SAMPLE_RATE, CHANNELS, 0, 0.5);
    const cutRms = windowRms(decodeWav(cut.wav).samples, SAMPLE_RATE, CHANNELS, 0, 0.5);

    expect(cutRms).toBeLessThan(unityRms);

    const deltaDb = 20 * Math.log10(unityRms / cutRms);
    expect(deltaDb).toBeCloseTo(6.02, 1);
  });

  it("applies +6 dB as a measurable rise", () => {
    const unity = mixToWav([clip({ samples: tone(0.5, 440, 0.2), gainDb: 0 })], {
      durationSeconds: 1,
      sampleRate: SAMPLE_RATE,
      channels: CHANNELS,
    });
    const boost = mixToWav([clip({ samples: tone(0.5, 440, 0.2), gainDb: 6 })], {
      durationSeconds: 1,
      sampleRate: SAMPLE_RATE,
      channels: CHANNELS,
    });

    const unityRms = windowRms(decodeWav(unity.wav).samples, SAMPLE_RATE, CHANNELS, 0, 0.5);
    const boostRms = windowRms(decodeWav(boost.wav).samples, SAMPLE_RATE, CHANNELS, 0, 0.5);
    const deltaDb = 20 * Math.log10(boostRms / unityRms);
    expect(deltaDb).toBeCloseTo(6.02, 1);
  });

  it("reports the linear gain and per-clip levels in the mix report", () => {
    const result = mixToWav([clip({ samples: tone(0.5, 440, 0.5), gainDb: -6, label: "voice" })], {
      durationSeconds: 1,
      sampleRate: SAMPLE_RATE,
      channels: CHANNELS,
    });

    const contribution = result.clips[0]!;
    expect(contribution.label).toBe("voice");
    expect(contribution.gainDb).toBe(-6);
    expect(contribution.linearGain).toBeCloseTo(0.501187, 5);
    expect(contribution.rmsDb).toBeLessThan(0);
    expect(contribution.clipsOnItsOwn).toBe(false);
  });

  it("flags a clip that exceeds full scale on its own", () => {
    const result = mixToWav([clip({ samples: tone(0.2, 440, 1.5), label: "hot" })], {
      durationSeconds: 0.5,
      sampleRate: SAMPLE_RATE,
      channels: CHANNELS,
    });
    expect(result.clips[0]!.clipsOnItsOwn).toBe(true);
  });
});

describe("mixToWav — clipping is DETECTED and reported", () => {
  it("reports clipping rather than silently wrapping it", () => {
    // The core requirement: two loud clips summing past full scale must be MEASURED and
    // reported. Wrapping would flip polarity at the peak and be invisible afterwards.
    const result = mixToWav(
      [
        clip({ samples: tone(0.5, 200, 0.8), label: "a" }),
        clip({ samples: tone(0.5, 300, 0.8), label: "b" }),
      ],
      { durationSeconds: 1, sampleRate: SAMPLE_RATE, channels: CHANNELS },
    );

    expect(result.clipping.clipped).toBe(true);
    expect(result.clipping.clippedSampleCount).toBeGreaterThan(0);
    expect(result.clipping.peakBeforeClamp).toBeGreaterThan(1);
    expect(result.clipping.peakBeforeClampDb).toBeGreaterThan(0);
    expect(result.clipping.firstClipSeconds).toBeGreaterThanOrEqual(0);
    expect(result.clipping.recommendation).toMatch(/Reduce the level/);
  });

  it("does NOT report clipping for a mix that fits", () => {
    const result = mixToWav([clip({ samples: tone(0.5, 440, 0.3) })], {
      durationSeconds: 1,
      sampleRate: SAMPLE_RATE,
      channels: CHANNELS,
    });

    expect(result.clipping.clipped).toBe(false);
    expect(result.clipping.clippedSampleCount).toBe(0);
    expect(result.clipping.recommendation).toMatch(/No clipping/);
  });

  it("clamps rather than wraps, so no sample exceeds full scale", () => {
    // Wrapping turns +1.2 into −0.8, which is a tear. Clamping at ±1 is predictable.
    const result = mixToWav(
      [
        clip({ samples: tone(0.5, 200, 1.4) }),
        clip({ samples: tone(0.5, 210, 1.4) }),
      ],
      { durationSeconds: 1, sampleRate: SAMPLE_RATE, channels: CHANNELS },
    );

    const decoded = decodeWav(result.wav);
    for (let i = 0; i < decoded.samples.length; i++) {
      expect(Math.abs(decoded.samples[i]!)).toBeLessThanOrEqual(1);
    }
    // The measured peak in the file must be exactly full scale, not less.
    expect(result.loudness.peak).toBeCloseTo(1, 3);
  });

  it("gives a recommendation that quantifies the overshoot", () => {
    const result = mixToWav(
      [clip({ samples: tone(0.3, 200, 2.0) })],
      { durationSeconds: 0.5, sampleRate: SAMPLE_RATE, channels: CHANNELS },
    );
    expect(result.clipping.clipped).toBe(true);
    // 2.0 is +6.02 dB, so the advice must mention several dB of reduction.
    expect(result.clipping.recommendation).toMatch(/\d+\.\d+ dB/);
  });

  it("reports clipping caused by gain rather than by summing", () => {
    const result = mixToWav([clip({ samples: tone(0.3, 440, 0.7), gainDb: 12 })], {
      durationSeconds: 0.5,
      sampleRate: SAMPLE_RATE,
      channels: CHANNELS,
    });
    expect(result.clipping.clipped).toBe(true);
    expect(result.clipping.peakBeforeClamp).toBeCloseTo(0.7 * dbToGain(12), 3);
  });

  it("reports the clipping fraction relative to the whole file", () => {
    const result = mixToWav(
      [clip({ samples: tone(0.25, 200, 2.0), startSeconds: 0.25 })],
      { durationSeconds: 1, sampleRate: SAMPLE_RATE, channels: CHANNELS },
    );
    // Only the middle quarter clips, so the fraction must be well below 1.
    expect(result.clipping.clippedFraction).toBeGreaterThan(0);
    expect(result.clipping.clippedFraction).toBeLessThan(0.5);
  });
});

describe("mixToWav — fades", () => {
  it("fades a clip in from silence", () => {
    const result = mixToWav([clip({ samples: tone(1, 440, 0.8), fadeInSeconds: 0.5 })], {
      durationSeconds: 1,
      sampleRate: SAMPLE_RATE,
      channels: CHANNELS,
    });

    const decoded = decodeWav(result.wav);
    // Start near silence.
    expect(windowRms(decoded.samples, SAMPLE_RATE, CHANNELS, 0, 0.02)).toBeLessThan(0.05);
    // Midway through the fade is louder.
    const early = windowRms(decoded.samples, SAMPLE_RATE, CHANNELS, 0.0, 0.1);
    const middle = windowRms(decoded.samples, SAMPLE_RATE, CHANNELS, 0.2, 0.3);
    const after = windowRms(decoded.samples, SAMPLE_RATE, CHANNELS, 0.6, 0.9);
    expect(early).toBeLessThan(middle);
    expect(middle).toBeLessThan(after);
  });

  it("fades a clip out to silence", () => {
    const result = mixToWav([clip({ samples: tone(1, 440, 0.8), fadeOutSeconds: 0.5 })], {
      durationSeconds: 1,
      sampleRate: SAMPLE_RATE,
      channels: CHANNELS,
    });

    const decoded = decodeWav(result.wav);
    const before = windowRms(decoded.samples, SAMPLE_RATE, CHANNELS, 0.0, 0.4);
    const late = windowRms(decoded.samples, SAMPLE_RATE, CHANNELS, 0.75, 1.0);
    expect(late).toBeLessThan(before);
    // The very end must be essentially silent.
    expect(Math.abs(decoded.samples[decoded.samples.length - 1]!)).toBeLessThan(0.02);
  });

  it("applies a fade to the clip, so another clip is unaffected by it", () => {
    // Fading after summing would let one clip's fade be defeated by another's energy.
    const result = mixToWav(
      [
        clip({ samples: tone(1, 300, 0.5), fadeInSeconds: 0.5, label: "faded" }),
        clip({ samples: tone(1, 900, 0.5), startSeconds: 0.5, label: "steady" }),
      ],
      { durationSeconds: 1, sampleRate: SAMPLE_RATE, channels: CHANNELS },
    );

    const decoded = decodeWav(result.wav);
    // At 0.5s the faded clip is at full and the steady one has just begun, so there IS
    // energy — proving the fade did not silence the whole mix.
    expect(windowRms(decoded.samples, SAMPLE_RATE, CHANNELS, 0.5, 0.9)).toBeGreaterThan(0.3);
  });
});

describe("mixToWav — channel adaptation", () => {
  it("mixes a mono clip into a stereo timeline on both channels", () => {
    const result = mixToWav([clip({ samples: tone(0.5, 440, 0.5) })], {
      durationSeconds: 1,
      sampleRate: SAMPLE_RATE,
      channels: 2,
    });

    const decoded = decodeWav(result.wav);
    expect(decoded.channels).toBe(2);
    expect(decoded.samples.length).toBe(2 * SAMPLE_RATE);
    // Both channels carry the same centred signal.
    for (const frame of [100, 5000, 11000]) {
      expect(decoded.samples[frame * 2]!).toBeCloseTo(decoded.samples[frame * 2 + 1]!, 6);
    }
  });

  it("mixes a stereo clip into a mono timeline by averaging, not summing", () => {
    // Summing would add up to +6 dB and clip material that was fine in stereo.
    const frames = 1000;
    const stereo = new Float64Array(frames * 2);
    for (let f = 0; f < frames; f++) {
      stereo[f * 2] = 0.5;
      stereo[f * 2 + 1] = 0.5;
    }

    const result = mixToWav(
      [clip({ samples: stereo, channels: 2, gainDb: 0 })],
      { durationSeconds: 0.2, sampleRate: SAMPLE_RATE, channels: 1 },
    );

    const decoded = decodeWav(result.wav);
    expect(decoded.channels).toBe(1);
    // Averaged to 0.5, not summed to 1.0.
    expect(decoded.samples[500]!).toBeCloseTo(0.5, 4);
  });

  it("keeps independent stereo channels independent", () => {
    const frames = 500;
    const stereo = new Float64Array(frames * 2);
    for (let f = 0; f < frames; f++) {
      stereo[f * 2] = 0.6;
      stereo[f * 2 + 1] = -0.3;
    }

    const result = mixToWav([clip({ samples: stereo, channels: 2 })], {
      durationSeconds: 0.1,
      sampleRate: SAMPLE_RATE,
      channels: 2,
    });

    const decoded = decodeWav(result.wav);
    expect(decoded.samples[200]!).toBeCloseTo(0.6, 4);
    expect(decoded.samples[201]!).toBeCloseTo(-0.3, 4);
  });
});

describe("mixToWav — validation", () => {
  it("rejects a non-positive timeline duration", () => {
    expect(() =>
      mixToWav([], { durationSeconds: 0, sampleRate: SAMPLE_RATE, channels: CHANNELS }),
    ).toThrow(AudioMixError);
  });

  it("rejects more than two channels", () => {
    expect(() =>
      mixToWav([], { durationSeconds: 1, sampleRate: SAMPLE_RATE, channels: 6 }),
    ).toThrow(UnsupportedAudioFormatError);
  });

  it("rejects a negative start time rather than silently moving the clip", () => {
    expect(() =>
      mixToWav([clip({ samples: tone(0.5, 440, 0.5), startSeconds: -1, label: "bad" })], {
        durationSeconds: 1,
        sampleRate: SAMPLE_RATE,
        channels: CHANNELS,
      }),
    ).toThrow(/negative start times/i);
  });

  it("names the offending clip in the error", () => {
    expect(() =>
      mixToWav([clip({ samples: tone(0.5, 440, 0.5), startSeconds: -1, label: "host-line-04" })], {
        durationSeconds: 1,
        sampleRate: SAMPLE_RATE,
        channels: CHANNELS,
      }),
    ).toThrow(/host-line-04/);
  });

  it("rejects a clip whose sample count is not a whole number of frames", () => {
    expect(() =>
      mixToWav([clip({ samples: new Float64Array(7), channels: 2, label: "odd" })], {
        durationSeconds: 1,
        sampleRate: SAMPLE_RATE,
        channels: CHANNELS,
      }),
    ).toThrow(/whole number of 2-channel frames/);
  });

  it("produces a valid empty timeline when there are no clips", () => {
    const result = mixToWav([], {
      durationSeconds: 0.5,
      sampleRate: SAMPLE_RATE,
      channels: CHANNELS,
    });
    const decoded = decodeWav(result.wav);
    expect(decoded.samples.length).toBe(Math.round(0.5 * SAMPLE_RATE));
    expect(Array.from(decoded.samples).every((v) => v === 0)).toBe(true);
    expect(result.loudness.intelligible).toBe(false);
  });
});

describe("measureLoudness", () => {
  it("measures a full-scale sine at about −3 dBFS RMS", () => {
    // A sine of amplitude 1 has RMS 1/√2 = 0.7071, which is −3.01 dBFS. This is a
    // closed-form check that the maths is right, not a tuned expectation.
    const samples = tone(1, 440, 1);
    const report = measureLoudness(samples, SAMPLE_RATE, CHANNELS);

    expect(report.rmsDb).toBeCloseTo(-3.01, 1);
    expect(report.peakDb).toBeCloseTo(0, 3);
    expect(report.intelligible).toBe(true);
  });

  it("measures silence as negative infinity and not intelligible", () => {
    const report = measureLoudness(new Float64Array(1000), SAMPLE_RATE, CHANNELS);
    expect(report.rmsDb).toBe(Number.NEGATIVE_INFINITY);
    expect(report.peakDb).toBe(Number.NEGATIVE_INFINITY);
    expect(report.intelligible).toBe(false);
    expect(report.assessment).toMatch(/Too quiet/);
  });

  it("flags a quiet mix as unintelligible with actionable advice", () => {
    const samples = tone(1, 440, 0.02); // −34 dBFS
    const report = measureLoudness(samples, SAMPLE_RATE, CHANNELS);

    expect(report.rmsDb).toBeLessThan(INTELLIGIBLE_RMS_DB);
    expect(report.intelligible).toBe(false);
    expect(report.assessment).toMatch(/Raise the dialogue clips/);
  });

  it("computes crest factor as the gap between peak and RMS", () => {
    const samples = tone(1, 440, 0.5);
    const report = measureLoudness(samples, SAMPLE_RATE, CHANNELS);
    expect(report.crestFactorDb).toBeCloseTo(report.peakDb - report.rmsDb, 10);
    // A sine's crest factor is 3.01 dB.
    expect(report.crestFactorDb).toBeCloseTo(3.01, 1);
  });

  it("describes itself as a level report rather than a loudness standard", () => {
    // Honesty guard: the docs say this is NOT BS.1770 / LUFS. The assessment string must
    // not imply certification it does not have.
    const report = measureLoudness(tone(1, 440, 0.5), SAMPLE_RATE, CHANNELS);
    expect(report.assessment).toMatch(/not a loudness standard/i);
    expect(report.assessment).not.toMatch(/LUFS|BS\.1770|EBU R128/);
  });
});

describe("mixToWav — end to end with the mock voice", () => {
  it("assembles a directed host line and a non-verbal reaction into one real WAV", async () => {
    // The pilot's actual shape: the demon host speaks, the silent human reacts. This
    // proves the whole chain — direction, synthesis, silence insertion, mixing, encoding —
    // produces one file with the audio in the right places.
    const { MockVoiceAdapter } = await import("./providers/mock-voice.js");
    const { neutralDirection } = await import("./performance.js");

    const adapter = new MockVoiceAdapter({ sampleRate: SAMPLE_RATE, channels: 1, bitDepth: 32 });

    const line = adapter.renderLine(
      "Well. That went badly.",
      neutralDirection({ pauseBeforeMs: 200, pace: 0.95 }),
    );
    const reaction = adapter.renderNonverbal("gasp", 0.8);

    const result = mixToWav(
      [
        {
          samples: line.samples,
          channels: line.channels,
          sampleRate: line.sampleRate,
          startSeconds: 0,
          gainDb: 0,
          label: "host-line-01",
        },
        {
          samples: reaction,
          channels: 1,
          sampleRate: adapter.renderLine("x").sampleRate,
          startSeconds: line.samples.length / line.channels / line.sampleRate + 0.1,
          gainDb: -3,
          fadeInSeconds: 0.01,
          fadeOutSeconds: 0.05,
          label: "human:gasp",
        },
      ],
      { durationSeconds: 5, sampleRate: SAMPLE_RATE, channels: 1, bitDepth: 16 },
    );

    // A real, readable WAV of the exact requested length.
    const decoded = decodeWav(result.wav);
    expect(decoded.sampleRate).toBe(SAMPLE_RATE);
    expect(decoded.bitDepth).toBe(16);
    expect(decoded.samples.length).toBe(5 * SAMPLE_RATE);

    // Audio where the line actually is. NOTE the window starts at 0.25s, not 0: the
    // direction asks for a 200 ms pause before the line, and that pause is REAL audio
    // silence at the head of the clip. Asserting energy in the first 200 ms would be
    // asserting that the pause had been ignored.
    expect(windowRms(decoded.samples, SAMPLE_RATE, CHANNELS, 0, 0.15)).toBe(0);
    expect(windowRms(decoded.samples, SAMPLE_RATE, CHANNELS, 0.25, 0.5)).toBeGreaterThan(0.01);
    const gaspStart = line.samples.length / line.channels / line.sampleRate + 0.15;
    expect(
      windowRms(decoded.samples, SAMPLE_RATE, CHANNELS, gaspStart, gaspStart + 0.15),
    ).toBeGreaterThan(0.01);
    expect(windowRms(decoded.samples, SAMPLE_RATE, CHANNELS, 4.5, 5.0)).toBe(0);

    // The report names both clips.
    expect(result.clips.map((c) => c.label)).toEqual(["host-line-01", "human:gasp"]);
    // And it does not clip.
    expect(result.clipping.clipped).toBe(false);
  });
});