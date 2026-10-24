import { describe, expect, it } from "vitest";

import { decodeWav, encodeWav, type BitDepth } from "./wav.js";
import { AudioMixError, UnsupportedAudioFormatError } from "./errors.js";
import { dbToGain, mixToWav, windowRms } from "./mix.js";
import { synthesiseNonverbal, NONVERBAL_KINDS } from "./nonverbal.js";
import { applyDirection, neutralDirection, planDirection, TEXT_ONLY_CAPABILITIES } from "./performance.js";
import { MockVoiceAdapter } from "./providers/mock-voice.js";

/**
 * Adversarial edge cases.
 *
 * These deliberately attack the boundaries rather than the happy path: empty buffers,
 * single samples, extreme values, pathological chunk layouts and inputs a hostile caller
 * might supply. The point is to catch defects that a well-formed round trip cannot reveal.
 */
describe("adversarial edge cases", () => {
  describe("WAV boundaries", () => {
    it("handles a zero-frame file", () => {
      const wav = encodeWav(new Float64Array(0), { sampleRate: 8000, channels: 1, bitDepth: 16 });
      // Header only: 44 bytes, data chunk size 0.
      expect(wav.length).toBe(44);
      expect(wav.readUInt32LE(40)).toBe(0);
      const decoded = decodeWav(wav);
      expect(decoded.samples.length).toBe(0);
      expect(decoded.sampleRate).toBe(8000);
    });

    it("handles a single frame", () => {
      const decoded = decodeWav(
        encodeWav(new Float64Array([0.5]), { sampleRate: 8000, channels: 1, bitDepth: 16 }),
      );
      expect(decoded.samples.length).toBe(1);
      expect(decoded.samples[0]!).toBeCloseTo(0.5, 4);
    });

    it("handles every supported depth and channel combination", () => {
      for (const bitDepth of [16, 32] as BitDepth[]) {
        for (const channels of [1, 2]) {
          const frames = 37;
          const samples = new Float64Array(frames * channels);
          for (let i = 0; i < samples.length; i++) samples[i] = Math.sin(i) * 0.9;

          const decoded = decodeWav(encodeWav(samples, { sampleRate: 11025, channels, bitDepth }));
          expect(decoded.bitDepth).toBe(bitDepth);
          expect(decoded.channels).toBe(channels);
          expect(decoded.samples.length).toBe(samples.length);
          for (let i = 0; i < samples.length; i++) {
            // 16-bit quantisation is 1/32767; float32 precision is coarse but bounded.
            const tolerance = bitDepth === 16 ? 1 / 32767 : 1e-6;
            expect(Math.abs(decoded.samples[i]! - samples[i]!)).toBeLessThanOrEqual(tolerance);
          }
        }
      }
    });

    it("skips unknown chunks rather than misreading the payload", () => {
      // Real encoders emit LIST/INFO/fact chunks. A decoder that assumes fmt-then-data
      // would read the wrong bytes.
      const base = encodeWav(new Float64Array([0.25, -0.25]), {
        sampleRate: 8000,
        channels: 1,
        bitDepth: 16,
      });

      // Splice a bogus "LIST" chunk (odd length, to exercise word alignment) between the
      // fmt and data chunks.
      const fmtEnd = 36;
      const oddChunk = Buffer.alloc(8 + 5 + 1); // header + 5 bytes + 1 pad byte
      oddChunk.write("LIST", 0, "ascii");
      oddChunk.writeUInt32LE(5, 4);
      oddChunk.write("INFO", 8, "ascii");

      const spliced = Buffer.concat([base.subarray(0, fmtEnd), oddChunk, base.subarray(fmtEnd)]);
      // Fix the RIFF size to account for the inserted chunk.
      spliced.writeUInt32LE(oddChunk.length + base.readUInt32LE(4), 4);

      const decoded = decodeWav(spliced);
      expect(decoded.samples.length).toBe(2);
      expect(decoded.samples[0]!).toBeCloseTo(0.25, 4);
      expect(decoded.samples[1]!).toBeCloseTo(-0.25, 4);
    });

    it("recovers a streamed file whose data size was never patched", () => {
      // Streaming encoders write 0xFFFFFFFF when the length is unknown up front.
      const base = encodeWav(new Float64Array(64).fill(0.5), {
        sampleRate: 8000,
        channels: 1,
        bitDepth: 16,
      });
      base.writeUInt32LE(0xffffffff, 40);
      const decoded = decodeWav(base);
      // Must fall back to the actual buffer length rather than reading past the end.
      expect(decoded.samples.length).toBe(64);
    });

    it("does not hang on a zero-size chunk", () => {
      // A zero-size chunk would spin forever in a naive `while` loop.
      const buffer = Buffer.alloc(60);
      buffer.write("RIFF", 0, "ascii");
      buffer.writeUInt32LE(52, 4);
      buffer.write("WAVE", 8, "ascii");
      buffer.write("fmt ", 12, "ascii");
      buffer.writeUInt32LE(16, 16);
      buffer.writeUInt16LE(1, 20);
      buffer.writeUInt16LE(1, 22);
      buffer.writeUInt32LE(8000, 24);
      buffer.writeUInt32LE(16000, 28);
      buffer.writeUInt16LE(2, 32);
      buffer.writeUInt16LE(16, 34);
      buffer.write("JUNK", 36, "ascii");
      buffer.writeUInt32LE(0, 40); // zero-size chunk
      expect(() => decodeWav(buffer)).toThrow(UnsupportedAudioFormatError);
    });

    it("rejects a buffer whose declared data size overruns the file", () => {
      const base = encodeWav(new Float64Array(16), { sampleRate: 8000, channels: 1, bitDepth: 16 });
      // Claim far more data than exists. Must clamp rather than read out of bounds.
      base.writeUInt32LE(999999, 40);
      const decoded = decodeWav(base);
      expect(decoded.samples.length).toBeGreaterThan(0);
      expect(decoded.samples.length).toBeLessThanOrEqual(16);
    });

    it("rejects a channel count above stereo with an explanatory message", () => {
      const base = encodeWav(new Float64Array(16), { sampleRate: 8000, channels: 1, bitDepth: 16 });
      base.writeUInt16LE(6, 22); // claim 6 channels
      expect(() => decodeWav(base)).toThrow(/mono and stereo only/);
    });

    it("rejects a zero channel count", () => {
      const base = encodeWav(new Float64Array(16), { sampleRate: 8000, channels: 1, bitDepth: 16 });
      base.writeUInt16LE(0, 22);
      expect(() => decodeWav(base)).toThrow();
    });

    it("interprets a WAVE_FORMAT_EXTENSIBLE PCM chunk correctly", () => {
      // Some tools write EXTENSIBLE even for plain mono/stereo. Tag 0xFFFE with a PCM
      // sub-format GUID must be read as the PCM it is.
      const buffer = Buffer.alloc(12 + 8 + 40 + 8 + 8);
      let o = 0;
      const ascii = (s: string) => {
        buffer.write(s, o, "ascii");
        o += s.length;
      };
      ascii("RIFF");
      buffer.writeUInt32LE(buffer.length - 8, o);
      o += 4;
      ascii("WAVE");
      ascii("fmt ");
      buffer.writeUInt32LE(40, o);
      o += 4;
      buffer.writeUInt16LE(0xfffe, o); // EXTENSIBLE
      o += 2;
      buffer.writeUInt16LE(1, o); // channels
      o += 2;
      buffer.writeUInt32LE(8000, o);
      o += 4;
      buffer.writeUInt32LE(16000, o);
      o += 4;
      buffer.writeUInt16LE(2, o); // block align
      o += 2;
      buffer.writeUInt16LE(16, o); // container bits
      o += 2;
      buffer.writeUInt16LE(22, o); // cbSize
      o += 2;
      buffer.writeUInt16LE(16, o); // valid bits
      o += 2;
      buffer.writeUInt32LE(4, o); // channel mask
      o += 4;
      buffer.writeUInt16LE(1, o); // PCM sub-format tag
      o += 16;
      ascii("data");
      buffer.writeUInt32LE(4, o);
      o += 4;
      buffer.writeInt16LE(16384, o); // 0.5
      o += 2;
      buffer.writeInt16LE(-16384, o);

      const decoded = decodeWav(buffer);
      expect(decoded.bitDepth).toBe(16);
      expect(decoded.channels).toBe(1);
      expect(decoded.samples.length).toBe(2);
      expect(decoded.samples[0]!).toBeCloseTo(0.5, 3);
    });
  });

  describe("mixing boundaries", () => {
    it("handles a clip starting exactly at the timeline end", () => {
      const result = mixToWav(
        [
          {
            samples: new Float64Array(100).fill(0.5),
            channels: 1,
            sampleRate: 8000,
            startSeconds: 1,
            gainDb: 0,
          },
        ],
        { durationSeconds: 1, sampleRate: 8000, channels: 1 },
      );
      // Nothing lands: the clip is entirely past the end, and that is reported.
      expect(result.clipping.clipped).toBe(false);
      expect(windowRms(decodeWav(result.wav).samples, 8000, 1, 0, 1)).toBe(0);
      expect(result.clips[0]!.truncated).toBe(true);
    });

    it("handles a zero-length clip without crashing", () => {
      const result = mixToWav(
        [
          {
            samples: new Float64Array(0),
            channels: 1,
            sampleRate: 8000,
            startSeconds: 0,
            gainDb: 0,
            label: "empty",
          },
        ],
        { durationSeconds: 0.1, sampleRate: 8000, channels: 1 },
      );
      expect(result.clips[0]!.rmsDb).toBe(Number.NEGATIVE_INFINITY);
      expect(decodeWav(result.wav).samples.length).toBe(800);
    });

    it("handles a deeply attenuated gain as effectively silent, without NaN", () => {
      // A fader pulled all the way down is a real operation. It must produce finite
      // samples at an utterly negligible level, not NaN which would poison the mix.
      //
      // NOTE on the level: −200 dB is a FINITE gain of 10^-10, so the result is a finite,
      // tiny RMS (about −207 dBFS), not exactly −Infinity. Asserting −Infinity would be
      // asserting something arithmetically false; `gainToDb(0)` is the only true
      // −Infinity case.
      const result = mixToWav(
        [
          {
            samples: new Float64Array(100).fill(0.9),
            channels: 1,
            sampleRate: 8000,
            startSeconds: 0,
            gainDb: -200,
          },
        ],
        { durationSeconds: 0.05, sampleRate: 8000, channels: 1 },
      );
      const decoded = decodeWav(result.wav);
      expect(Array.from(decoded.samples).every((v) => Number.isFinite(v))).toBe(true);
      expect(result.loudness.rmsDb).toBeLessThan(-150); // effectively silent
      expect(result.loudness.intelligible).toBe(false);
      expect(result.clipping.clipped).toBe(false);
    });

    it("handles many clips without accumulating NaN", () => {
      const clips = Array.from({ length: 40 }, (_, i) => ({
        samples: new Float64Array(240).fill(0.01),
        channels: 1,
        sampleRate: 8000,
        startSeconds: i * 0.01,
        gainDb: -20,
        label: `clip-${i}`,
      }));
      const result = mixToWav(clips, { durationSeconds: 1, sampleRate: 8000, channels: 1 });
      const decoded = decodeWav(result.wav);
      expect(Array.from(decoded.samples).every((v) => Number.isFinite(v))).toBe(true);
      expect(result.clips).toHaveLength(40);
    });

    it("rejects a zero sample rate in the mix", () => {
      expect(() => mixToWav([], { durationSeconds: 1, sampleRate: 0, channels: 1 })).toThrow(
        AudioMixError,
      );
    });

    it("rejects a non-finite start time", () => {
      expect(() =>
        mixToWav(
          [
            {
              samples: new Float64Array(10),
              channels: 1,
              sampleRate: 8000,
              startSeconds: Number.NaN,
              gainDb: 0,
            },
          ],
          { durationSeconds: 1, sampleRate: 8000, channels: 1 },
        ),
      ).toThrow(AudioMixError);
    });

    it("detects clipping even when only one sample exceeds full scale", () => {
      const samples = new Float64Array(1000);
      samples[500] = 1.0001;
      const result = mixToWav(
        [{ samples, channels: 1, sampleRate: 8000, startSeconds: 0, gainDb: 0 }],
        { durationSeconds: 0.125, sampleRate: 8000, channels: 1 },
      );
      expect(result.clipping.clipped).toBe(true);
      expect(result.clipping.clippedSampleCount).toBe(1);
    });
  });

  describe("dB maths boundaries", () => {
    it("agrees with the exact definition across a wide range", () => {
      for (const db of [-60, -40, -20, -6, -3, -1, 0, 1, 3, 6, 20, 40]) {
        expect(dbToGain(db)).toBeCloseTo(10 ** (db / 20), 12);
      }
    });

    it("is symmetric: +6 dB and −6 dB multiply to unity", () => {
      expect(dbToGain(6) * dbToGain(-6)).toBeCloseTo(1, 12);
    });
  });

  describe("nonverbal boundaries", () => {
    it("handles intensity 0 and 1 without producing silence or clipping", () => {
      for (const kind of NONVERBAL_KINDS) {
        for (const intensity of [0, 1]) {
          const samples = synthesiseNonverbal({
            kind,
            intensity,
            sampleRate: 24000,
            channels: 1,
            seed: 3,
          });
          expect(samples.length).toBeGreaterThan(0);
          let peak = 0;
          for (const v of samples) peak = Math.max(peak, Math.abs(v));
          expect(peak).toBeLessThanOrEqual(1);
          // At intensity 0 the sound is quiet but must still exist.
          expect(peak).toBeGreaterThan(0);
        }
      }
    });

    it("handles a very low sample rate without aliasing into silence", () => {
      const samples = synthesiseNonverbal({
        kind: "scream",
        intensity: 0.8,
        sampleRate: 8000,
        channels: 1,
        seed: 5,
      });
      let peak = 0;
      for (const v of samples) peak = Math.max(peak, Math.abs(v));
      expect(peak).toBeGreaterThan(0.1);
    });
  });

  describe("direction boundaries", () => {
    it("handles pace at the clamp boundary exactly", () => {
      const atMin = applyDirection(neutralDirection({ pace: 0.5 }), 1000);
      expect(atMin.paceClamped).toBe(false);
      const belowMin = applyDirection(neutralDirection({ pace: 0.4999 }), 1000);
      expect(belowMin.paceClamped).toBe(true);
    });

    it("handles a direction with every control requested against a text-only provider", () => {
      const plan = planDirection(
        {
          emotion: "sarcastic",
          intensity: 1,
          pace: 0.6,
          pauseBeforeMs: 100,
          pauseAfterMs: 100,
          emphasis: ["a", "b"],
          pitchShift: -5,
        },
        TEXT_ONLY_CAPABILITIES,
        "a b c.",
      );
      // Nothing may vanish, and the counts must agree.
      const all = [
        ...plan.native.map((n) => n.control),
        ...plan.emulated.map((e) => e.control),
        ...plan.unhonourable.map((u) => u.control),
      ];
      expect(new Set(all).size).toBe(all.length);
      expect(all).toHaveLength(7);
    });

    it("does not corrupt a script when an emphasis word appears inside another word", () => {
      const plan = planDirection(
        neutralDirection({ emphasis: ["cat"] }),
        TEXT_ONLY_CAPABILITIES,
        "The cat scattered cats everywhere.",
      );
      // Whole-word matching, checked by counting. The text contains "cat", "scattered"
      // and "cats"; only the standalone "cat" may receive the emphasis prefix.
      //
      // An earlier version of this assertion was written as `not.toContain("scat")`,
      // which is meaningless: "scattered" legitimately contains "scat" as a substring,
      // so that check could never pass regardless of correctness. Counting occurrences
      // of the emphasis marker is the assertion that actually tests whole-word matching.
      const markers = plan.script.match(/… /g) ?? [];
      expect(markers).toHaveLength(1);
      expect(plan.script).toBe("The … cat scattered cats everywhere.");
      // The other words must be untouched.
      expect(plan.script).toContain("scattered");
      expect(plan.script).toContain("cats ");
    });

    it("treats an emphasis word containing regex metacharacters literally", () => {
      const plan = planDirection(
        neutralDirection({ emphasis: ["(really)"] }),
        TEXT_ONLY_CAPABILITIES,
        "That is (really) something.",
      );
      // A naive RegExp would treat the parentheses as a group and mis-match.
      expect(plan.script).toContain("(really)");
    });
  });

  describe("mock voice boundaries", () => {
    it("renders a very long line without failing", () => {
      const adapter = new MockVoiceAdapter({ sampleRate: 8000, channels: 1, bitDepth: 16 });
      const text = "word ".repeat(200).trim();
      const speech = adapter.renderLine(text);
      expect(speech.samples.length).toBeGreaterThan(0);
      expect(speech.samples.length % speech.channels).toBe(0);
    });

    it("renders text with only punctuation", () => {
      const adapter = new MockVoiceAdapter({ sampleRate: 8000, channels: 1, bitDepth: 16 });
      const speech = adapter.renderLine("... !!! ???");
      expect(speech.samples.length % speech.channels).toBe(0);
    });

    it("produces a frame-aligned buffer for stereo at every pace", () => {
      // The bug this guards: mismatched frame/sample units in concatenation.
      const adapter = new MockVoiceAdapter({ sampleRate: 8000, channels: 2, bitDepth: 16 });
      for (const pace of [0.5, 0.8, 1, 1.2, 1.6]) {
        const speech = adapter.renderLine("A line of text, with punctuation.", neutralDirection({ pace }));
        expect(speech.samples.length % 2, `pace ${pace}`).toBe(0);
      }
    });

    it("handles non-ASCII text deterministically", () => {
      const adapter = new MockVoiceAdapter({ sampleRate: 8000, channels: 1, bitDepth: 16 });
      const a = adapter.renderLine("Café — naïve 日本語 🎬");
      const b = adapter.renderLine("Café — naïve 日本語 🎬");
      expect(Array.from(a.samples)).toEqual(Array.from(b.samples));
    });

    it("keeps output finite for every nonverbal kind and every channel count", () => {
      for (const channels of [1, 2] as const) {
        const adapter = new MockVoiceAdapter({ sampleRate: 8000, channels, bitDepth: 32 });
        for (const kind of NONVERBAL_KINDS) {
          const samples = adapter.renderNonverbal(kind, 0.9);
          expect(samples.length % channels, `${kind} / ${channels}ch`).toBe(0);
          expect(Array.from(samples).every((v) => Number.isFinite(v))).toBe(true);
        }
      }
    });
  });
});