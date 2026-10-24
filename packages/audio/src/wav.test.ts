import { describe, expect, it } from "vitest";

import { UnsupportedAudioFormatError } from "./errors.js";
import { bytesPerSample, convertChannels, decodeWav, encodeWav, sampleFormatFor } from "./wav.js";

/**
 * WAV codec tests.
 *
 * The round-trip cases below prove internal consistency, which alone proves very little —
 * a matched pair of bugs in the encoder and decoder passes every round trip. The real
 * evidence that the encoder is correct is in `python-verify.test.ts`, which hands written
 * files to Python's stdlib `wave` module and to numpy and checks the numbers independently.
 */

/** Build a deterministic test signal: a sum of sines, so every sample is predictable. */
function sineMix(frames: number, sampleRate: number, channels: number): Float64Array {
  const out = new Float64Array(frames * channels);
  for (let f = 0; f < frames; f++) {
    const t = f / sampleRate;
    for (let c = 0; c < channels; c++) {
      out[f * channels + c] =
        0.6 * Math.sin(2 * Math.PI * 220 * t) + 0.3 * Math.sin(2 * Math.PI * 660 * t + c);
    }
  }
  return out;
}

describe("encodeWav / decodeWav", () => {
  describe("header correctness", () => {
    it("writes a RIFF/WAVE container with a fmt and a data chunk", () => {
      const samples = sineMix(100, 8000, 1);
      const wav = encodeWav(samples, { sampleRate: 8000, channels: 1, bitDepth: 16 });

      expect(wav.toString("ascii", 0, 4)).toBe("RIFF");
      expect(wav.toString("ascii", 8, 12)).toBe("WAVE");
      // "fmt " — the trailing space is part of the chunk id, not decoration.
      expect(wav.toString("ascii", 12, 16)).toBe("fmt ");
      expect(wav.toString("ascii", 36, 40)).toBe("data");
    });

    it("sets the fmt chunk fields to the requested format", () => {
      const wav = encodeWav(sineMix(40, 44100, 2), { sampleRate: 44100, channels: 2, bitDepth: 16 });

      expect(wav.readUInt32LE(16)).toBe(16); // fmt chunk body length
      expect(wav.readUInt16LE(20)).toBe(1); // WAVE_FORMAT_PCM
      expect(wav.readUInt16LE(22)).toBe(2); // channels
      expect(wav.readUInt32LE(24)).toBe(44100); // sample rate
      expect(wav.readUInt32LE(28)).toBe(44100 * 2 * 2); // byte rate
      expect(wav.readUInt16LE(32)).toBe(4); // block align
      expect(wav.readUInt16LE(34)).toBe(16); // bits per sample
    });

    it("declares format tag 3 for 32-bit float", () => {
      const wav = encodeWav(sineMix(40, 48000, 1), { sampleRate: 48000, channels: 1, bitDepth: 32 });
      expect(wav.readUInt16LE(20)).toBe(3); // WAVE_FORMAT_IEEE_FLOAT
      expect(wav.readUInt16LE(34)).toBe(32);
    });

    it("gets the RIFF size and data size exactly right", () => {
      const frames = 250;
      const channels = 2;
      const wav = encodeWav(sineMix(frames, 16000, channels), {
        sampleRate: 16000,
        channels,
        bitDepth: 16,
      });

      const dataBytes = frames * channels * 2;

      // RIFF size counts everything after the first 8 bytes, so it is the file length − 8.
      expect(wav.readUInt32LE(4)).toBe(wav.length - 8);
      // data chunk size counts the sample payload only.
      expect(wav.readUInt32LE(40)).toBe(dataBytes);
      // The file is exactly header (44 bytes) plus payload.
      expect(wav.length).toBe(44 + dataBytes);
      expect(wav.readUInt32LE(4)).toBe(36 + dataBytes);
    });

    it("scales the header for 32-bit float", () => {
      const frames = 128;
      const wav = encodeWav(sineMix(frames, 24000, 2), {
        sampleRate: 24000,
        channels: 2,
        bitDepth: 32,
      });
      expect(wav.readUInt16LE(32)).toBe(8); // block align: 2ch * 4 bytes
      expect(wav.readUInt32LE(40)).toBe(frames * 2 * 4);
      expect(wav.readUInt32LE(28)).toBe(24000 * 2 * 4); // byte rate
    });
  });

  describe("round trip", () => {
    it("returns the original 32-bit float samples to single-precision accuracy", () => {
      // NOTE ON THE TOLERANCE, because it is not arbitrary. 32-bit float WAV stores IEEE
      // 754 SINGLE precision, but our in-memory samples are doubles. So the round trip is
      // float64 -> float32 -> float64 and the error is the float32 machine epsilon,
      // ~6e-8 relative. Demanding exactness here would be demanding something the
      // format cannot deliver; the correct question is whether the values are preserved
      // to the precision actually stored, which is what the relative check below asks.
      const samples = sineMix(500, 22050, 2);
      const wav = encodeWav(samples, { sampleRate: 22050, channels: 2, bitDepth: 32 });
      const decoded = decodeWav(wav);

      expect(decoded.channels).toBe(2);
      expect(decoded.sampleRate).toBe(22050);
      expect(decoded.bitDepth).toBe(32);
      expect(decoded.samples.length).toBe(samples.length);

      const float32Epsilon = 2 ** -23; // ~1.19e-7 relative
      for (let i = 0; i < samples.length; i++) {
        const expected = samples[i]!;
        const actual = decoded.samples[i]!;
        const relativeError = Math.abs(actual - expected) / Math.max(Math.abs(expected), 1e-12);
        expect(relativeError).toBeLessThanOrEqual(float32Epsilon);
      }
    });

    it("round-trips 32-bit float values that are exactly representable, with no error at all", () => {
      // The counterpart to the tolerance above: values that ARE exactly representable in
      // float32 must come back bit-identical, which proves the tolerance is absorbing
      // genuine format precision and not an encoder defect.
      const samples = new Float64Array([0, 0.5, -0.5, 0.25, -0.125, 0.75, -1, 1]);
      const decoded = decodeWav(encodeWav(samples, { sampleRate: 8000, channels: 1, bitDepth: 32 }));
      for (let i = 0; i < samples.length; i++) {
        expect(decoded.samples[i]).toBe(samples[i]);
      }
    });

    it("returns the original 16-bit samples within one quantisation step", () => {
      const samples = sineMix(500, 22050, 1);
      const wav = encodeWav(samples, { sampleRate: 22050, channels: 1, bitDepth: 16 });
      const decoded = decodeWav(wav);

      // 16-bit quantisation is 1/32767 ≈ 3.05e-5. Anything larger is a real bug, not
      // rounding, so the tolerance is deliberately tight.
      const quantum = 1 / 32767;
      for (let i = 0; i < samples.length; i++) {
        expect(Math.abs(decoded.samples[i]! - samples[i]!)).toBeLessThanOrEqual(quantum);
      }
    });

    it("preserves both channels independently in stereo", () => {
      const frames = 64;
      const samples = new Float64Array(frames * 2);
      for (let f = 0; f < frames; f++) {
        samples[f * 2] = 0.5;
        samples[f * 2 + 1] = -0.25;
      }
      const decoded = decodeWav(encodeWav(samples, { sampleRate: 8000, channels: 2, bitDepth: 16 }));

      for (let f = 0; f < frames; f++) {
        expect(decoded.samples[f * 2]).toBeCloseTo(0.5, 4);
        expect(decoded.samples[f * 2 + 1]).toBeCloseTo(-0.25, 4);
        // The channels must not be swapped or summed.
        expect(decoded.samples[f * 2]).not.toBeCloseTo(decoded.samples[f * 2 + 1]!, 2);
      }
    });

    it("round-trips full-scale positive and negative extremes without wrapping", () => {
      // +1.0 is the classic off-by-one trap: scaling by 32768 writes 32768, which wraps
      // to -32768, turning a peak into a polarity flip. Scaling by 32767 avoids it.
      const samples = new Float64Array([1, -1, 0, 0.999969, -0.999969]);
      const decoded = decodeWav(encodeWav(samples, { sampleRate: 8000, channels: 1, bitDepth: 16 }));

      expect(decoded.samples[0]).toBeCloseTo(1, 4);
      expect(decoded.samples[1]).toBeCloseTo(-1, 4);
      expect(decoded.samples[2]).toBe(0);
      // Sign must be preserved at the extremes, which is what a wrap would break.
      expect(Math.sign(decoded.samples[0]!)).toBe(1);
      expect(Math.sign(decoded.samples[1]!)).toBe(-1);
    });

    it("round-trips a silent buffer as exact zeros", () => {
      const decoded = decodeWav(
        encodeWav(new Float64Array(200), { sampleRate: 8000, channels: 1, bitDepth: 16 }),
      );
      expect(decoded.samples.every((v) => v === 0)).toBe(true);
    });

    it("survives a large buffer, so chunk sizes are not size-limited", () => {
      // 3 seconds of stereo at 48 kHz is ~576 KB of float data — well past any 16-bit
      // size field, which is where naive implementations break.
      const frames = 48000 * 3;
      const samples = sineMix(frames, 48000, 2);
      const wav = encodeWav(samples, { sampleRate: 48000, channels: 2, bitDepth: 16 });
      const decoded = decodeWav(wav);

      expect(decoded.samples.length).toBe(frames * 2);
      expect(decoded.samples[1000]).toBeCloseTo(samples[1000]!, 4);
      expect(decoded.samples[frames * 2 - 10]).toBeCloseTo(samples[frames * 2 - 10]!, 4);
    });
  });

  describe("rejecting what it cannot represent", () => {
    it("refuses more than two channels rather than writing a file decoders misread", () => {
      expect(() =>
        encodeWav(new Float64Array(600), { sampleRate: 48000, channels: 6, bitDepth: 16 }),
      ).toThrow(UnsupportedAudioFormatError);
    });

    it("refuses an unsupported bit depth", () => {
      expect(() =>
        encodeWav(new Float64Array(10), {
          sampleRate: 48000,
          channels: 1,
          // 24-bit is a real format we deliberately do not claim to support.
          bitDepth: 24 as 16,
        }),
      ).toThrow(UnsupportedAudioFormatError);
    });

    it("refuses samples that are not a whole number of frames", () => {
      expect(() =>
        encodeWav(new Float64Array(7), { sampleRate: 8000, channels: 2, bitDepth: 16 }),
      ).toThrow(/whole number of 2-channel frames/);
    });

    it("refuses a zero sample rate", () => {
      expect(() =>
        encodeWav(new Float64Array(4), { sampleRate: 0, channels: 1, bitDepth: 16 }),
      ).toThrow(/positive integer/);
    });

    it("rejects non-WAV input with a precise message", () => {
      expect(() => decodeWav(Buffer.from("this is not a wav file at all, truly"))).toThrow(
        /expected "RIFF" magic/,
      );
    });

    it("rejects a truncated header", () => {
      expect(() => decodeWav(Buffer.from([0x52, 0x49, 0x46]))).toThrow(/too short/);
    });

    it("rejects a RIFF file that is not WAVE", () => {
      const buffer = Buffer.alloc(64);
      buffer.write("RIFF", 0, "ascii");
      buffer.writeUInt32LE(56, 4);
      buffer.write("AVI ", 8, "ascii");
      expect(() => decodeWav(buffer)).toThrow(/expected "WAVE" form type/);
    });

    it("rejects a 32-bit INTEGER pcm file, which is not the same as 32-bit float", () => {
      const wav = encodeWav(sineMix(10, 8000, 1), { sampleRate: 8000, channels: 1, bitDepth: 16 });
      // Rewrite the format tag to PCM while claiming 32 bits: tag 1 + depth 32.
      wav.writeUInt16LE(1, 20);
      wav.writeUInt16LE(32, 34);
      expect(() => decodeWav(wav)).toThrow(/32-bit integer PCM/);
    });

    it("rejects a file with no fmt chunk", () => {
      const buffer = Buffer.alloc(32);
      buffer.write("RIFF", 0, "ascii");
      buffer.writeUInt32LE(24, 4);
      buffer.write("WAVE", 8, "ascii");
      buffer.write("data", 12, "ascii");
      buffer.writeUInt32LE(8, 16);
      expect(() => decodeWav(buffer)).toThrow(/no `fmt ` chunk/);
    });
  });

  describe("clamping", () => {
    it("clamps out-of-range float input instead of wrapping it", () => {
      // Wrapping at a peak is an audible tear; clamping at least fails predictably.
      const samples = new Float64Array([2.5, -3.0, 0.5]);
      const decoded = decodeWav(encodeWav(samples, { sampleRate: 8000, channels: 1, bitDepth: 32 }));
      expect(decoded.samples[0]).toBe(1);
      expect(decoded.samples[1]).toBe(-1);
      expect(decoded.samples[2]).toBe(0.5);
    });

    it("maps NaN to silence rather than poisoning the file", () => {
      const samples = new Float64Array([Number.NaN, 0.5]);
      const decoded = decodeWav(encodeWav(samples, { sampleRate: 8000, channels: 1, bitDepth: 32 }));
      expect(decoded.samples[0]).toBe(0);
      expect(decoded.samples[1]).toBe(0.5);
    });
  });

  describe("helpers", () => {
    it("maps bit depths onto sample formats", () => {
      expect(sampleFormatFor(16)).toBe("pcm_s16le");
      expect(sampleFormatFor(32)).toBe("f32le");
      expect(bytesPerSample(16)).toBe(2);
      expect(bytesPerSample(32)).toBe(4);
    });

    it("averages stereo down to mono rather than summing, which would add 6 dB", () => {
      const stereo = new Float64Array([1, 1, -0.5, -0.5]);
      const mono = convertChannels(stereo, 2, 1);
      expect(mono.length).toBe(2);
      expect(mono[0]).toBeCloseTo(1, 12);
      expect(mono[1]).toBeCloseTo(-0.5, 12);
    });

    it("duplicates mono up to stereo", () => {
      const mono = new Float64Array([0.25, -0.75]);
      const stereo = convertChannels(mono, 1, 2);
      expect(Array.from(stereo)).toEqual([0.25, 0.25, -0.75, -0.75]);
    });
  });
});