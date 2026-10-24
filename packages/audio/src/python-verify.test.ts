import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { encodeWav } from "./wav.js";

/**
 * INDEPENDENT VERIFICATION OF THE WAV ENCODER.
 *
 * The round-trip tests in `wav.test.ts` prove the encoder and decoder agree with each
 * other — which a matched pair of bugs would also satisfy. This file proves the bytes are
 * correct against a THIRD PARTY that shares no code with us:
 *
 *   1. Python's stdlib `wave` module parses the container (channels, rate, width, frames).
 *   2. Python's stdlib `wave` module reads the sample values back.
 *   3. numpy re-reads the raw payload with an independently written parser and checks the
 *      numbers against the exact values we intended, and against `wave`'s own reading.
 *
 * If our header arithmetic were wrong — a bad RIFF size, a wrong block align, a mislabelled
 * format tag — `wave` would raise, or numpy would disagree. This is the test that
 * distinguishes "correct" from "self-consistent".
 *
 * The tests SKIP rather than fail when no interpreter is available, so the suite still
 * runs on a machine without Python; the skip reason is explicit. When the bundled
 * interpreter is present (it is, in this project) the assertions run for real.
 */

const PYTHON = process.env["KINEMA_PYTHON"] ??
  "C:\\Users\\zayla\\.dsh\\dsh-runtimes\\dsh-primary-runtime\\dependencies\\python\\python.exe";

/**
 * ffmpeg, resolved absolutely. PATH is not set in a fresh shell on this machine, so the
 * winget package location is used directly rather than relying on `Get-Command ffmpeg`.
 */
const FFMpeg = process.env["KINEMA_FFMPEG"] ??
  "C:\\Users\\zayla\\AppData\\Local\\Microsoft\\WinGet\\Packages\\" +
  "Gyan.FFmpeg_Microsoft.Winget.Source_8wekyb3d8bbwe\\ffmpeg-9.0.2-full_build\\bin\\ffmpeg.exe";

const FFPROBE = FFMpeg.replace(/ffmpeg\.exe$/, "ffprobe.exe");

const pythonAvailable = existsSync(PYTHON);
const ffmpegAvailable = existsSync(FFMpeg);
const maybe = pythonAvailable ? describe : describe.skip;
const maybeFfmpeg = ffmpegAvailable ? describe : describe.skip;

const OUT_DIR = join(process.cwd(), "tmp", "wav-verify");

/** Create the verification output directory on demand. Shared by both blocks. */
function ensureDir(): string {
  if (!existsSync(OUT_DIR)) mkdirSync(OUT_DIR, { recursive: true });
  return OUT_DIR;
}

/** Run a Python snippet and return its stdout. */
function runPython(source: string, args: readonly string[] = []): string {
  return execFileSync(PYTHON, ["-c", source, ...args], {
    encoding: "utf8",
    // No shell, no network, no environment surprises.
    shell: false,
  }).trim();
}

interface PythonWavFacts {
  readonly channels: number;
  readonly sampleRate: number;
  readonly sampwidth: number;
  readonly frames: number;
  readonly comptype: string;
  readonly rawBytes: number;
  readonly firstSamples: readonly number[];
}

const WAVE_PROBE = `
import wave, sys, json, struct
path = sys.argv[1]
with wave.open(path, 'rb') as w:
    channels = w.getnchannels()
    rate = w.getframerate()
    width = w.getsampwidth()
    frames = w.getnframes()
    comptype = w.getcomptype()
    raw = w.readframes(frames)
first = list(struct.unpack('<%dh' % min(8, frames * channels), raw[:min(8, frames * channels) * 2]))
print(json.dumps({
  'channels': channels, 'sampleRate': rate, 'sampwidth': width,
  'frames': frames, 'comptype': comptype,
  'rawBytes': len(raw), 'firstSamples': first,
}))
`;

const NUMPY_PROBE = `
import wave, sys, json
import numpy as np
path = sys.argv[1]
with wave.open(path, 'rb') as w:
    channels, rate, width, frames = w.getnchannels(), w.getframerate(), w.getsampwidth(), w.getnframes()
    raw = w.readframes(frames)
expected = json.loads(sys.argv[2])
arr = np.frombuffer(raw, dtype='<i2').astype(np.float64) / 32767.0
if channels > 1:
    arr = arr.reshape(-1, channels)
index = int(sys.argv[3])
value = float(arr.flat[index] if channels == 1 else arr[index // channels][index % channels])
print(json.dumps({
  'numpyValue': value,
  'expectedValue': expected[index],
  'absError': abs(value - expected[index]),
  'dtype': str(np.frombuffer(raw, dtype='<i2').dtype),
  'totalSamples': int(np.frombuffer(raw, dtype='<i2').size),
  'declaredFrames': frames, 'rate': rate, 'channels': channels, 'width': width,
}))
`;

maybe("WAV output verified by Python", () => {
  /**
   * 16-bit PCM, mono and stereo.
   *
   * The signals are exact rational values, so the numpy comparison is a real equality
   * check rather than a tolerance fudge: a 16-bit round trip of a value that lands on a
   * quantisation step is exact.
   */

  /**
   * A signal whose 16-bit quantisation is EXACT, so numpy can assert equality.
   *
   * Every sample is `k / 32767` for integer k, which is precisely what the encoder
   * produces on the way back out. Any error is therefore a genuine bug rather than the
   * unavoidable ½ LSB of quantisation.
   */
  function exactQuantisedSignal(frames: number, channels: number): Float64Array {
    const out = new Float64Array(frames * channels);
    for (let i = 0; i < out.length; i++) {
      // A deterministic ramp plus a small oscillation, all on exact quantisation steps.
      const k = ((i * 37) % 4001) - 2000;
      out[i] = k / 32767;
    }
    return out;
  }

  it("is parsed by Python's stdlib wave module with the right format", () => {
    const dir = ensureDir();
    const path = join(dir, "stereo-16.wav");

    const frames = 480;
    const samples = exactQuantisedSignal(frames, 2);
    writeFileSync(path, encodeWav(samples, { sampleRate: 44100, channels: 2, bitDepth: 16 }));

    const facts = JSON.parse(runPython(WAVE_PROBE, [path])) as PythonWavFacts;

    // If any of these are wrong, `wave` would either have raised or reported nonsense.
    expect(facts.channels).toBe(2);
    expect(facts.sampleRate).toBe(44100);
    expect(facts.sampwidth).toBe(2); // 16 bits = 2 bytes
    expect(facts.frames).toBe(frames);
    expect(facts.comptype).toBe("NONE"); // uncompressed
    expect(facts.rawBytes).toBe(frames * 2 * 2);

    // The first samples, read by Python, must be exactly what we wrote.
    expect(facts.firstSamples[0]).toBe(Math.round(samples[0]! * 32767));
    expect(facts.firstSamples[1]).toBe(Math.round(samples[1]! * 32767));
    expect(facts.firstSamples[4]).toBe(Math.round(samples[4]! * 32767));
  });

  it("is read back by numpy with sample values matching the encoder's intent exactly", () => {
    const dir = ensureDir();
    const path = join(dir, "mono-16.wav");

    const frames = 1000;
    const samples = exactQuantisedSignal(frames, 1);
    writeFileSync(path, encodeWav(samples, { sampleRate: 24000, channels: 1, bitDepth: 16 }));

    // Ask numpy about a sample in the middle, well past the header, where a wrong
    // data-chunk offset or a wrong block align would show up as garbage.
    const index = 777;
    const expected = JSON.stringify(Array.from(samples));
    const result = JSON.parse(runPython(NUMPY_PROBE, [path, expected, String(index)])) as {
      numpyValue: number;
      expectedValue: number;
      absError: number;
      dtype: string;
      totalSamples: number;
      declaredFrames: number;
    };

    expect(result.dtype).toBe("int16");
    expect(result.totalSamples).toBe(frames);
    expect(result.declaredFrames).toBe(frames);
    // EXACT equality: the value was chosen to land on a quantisation step.
    expect(result.numpyValue).toBe(result.expectedValue);
    expect(result.absError).toBe(0);
  });

  it("produces a file whose declared sizes match its actual length, as seen from outside", () => {
    // Python recomputes the file length from the header's own arithmetic. If the RIFF
    // size or data size were wrong, these two numbers would disagree.
    const dir = ensureDir();
    const path = join(dir, "size-check.wav");
    const frames = 321;
    writeFileSync(
      path,
      encodeWav(exactQuantisedSignal(frames, 2), { sampleRate: 16000, channels: 2, bitDepth: 16 }),
    );

    const sizeProbe = `
import wave, sys, json, os
path = sys.argv[1]
with wave.open(path, 'rb') as w:
    frames, channels, width = w.getnframes(), w.getnchannels(), w.getsampwidth()
expectedPayload = frames * channels * width
print(json.dumps({
  'actualFileBytes': os.path.getsize(path),
  'expectedFileBytes': 44 + expectedPayload,
  'expectedPayload': expectedPayload,
}))
`;
    const result = JSON.parse(runPython(sizeProbe, [path])) as {
      actualFileBytes: number;
      expectedFileBytes: number;
      expectedPayload: number;
    };

    expect(result.expectedPayload).toBe(frames * 2 * 2);
    expect(result.actualFileBytes).toBe(result.expectedFileBytes);
  });

  it("is read identically by two independent decoders, wave and a raw numpy parse", () => {
    // The strongest of the checks: Python's `wave` and a hand-written numpy parse of the
    // same bytes must agree sample for sample. A wrong chunk offset would make them
    // diverge even though `wave` alone might still succeed.
    const dir = ensureDir();
    const path = join(dir, "cross-decoder.wav");
    const frames = 300;
    const samples = exactQuantisedSignal(frames, 1);
    writeFileSync(path, encodeWav(samples, { sampleRate: 22050, channels: 1, bitDepth: 16 }));

    const crossProbe = `
import wave, sys, json
import numpy as np
path = sys.argv[1]
with wave.open(path, 'rb') as w:
    frames = w.getnframes()
    width = w.getsampwidth()
    channels = w.getnchannels()
    viaWave = np.frombuffer(w.readframes(frames), dtype='<i2')

with open(path, 'rb') as f:
    blob = f.read()
idx = blob.find(b'data')
declared = int.from_bytes(blob[idx+4:idx+8], 'little')
payload = blob[idx+8:idx+8+declared]
viaRaw = np.frombuffer(payload, dtype='<i2')

print(json.dumps({
  'waveSamples': int(viaWave.size),
  'rawSamples': int(viaRaw.size),
  'identical': bool(np.array_equal(viaWave, viaRaw)),
  'declaredDataBytes': declared,
  'width': width, 'channels': channels,
}))
`;
    const result = JSON.parse(runPython(crossProbe, [path])) as {
      waveSamples: number;
      rawSamples: number;
      identical: boolean;
      declaredDataBytes: number;
    };

    expect(result.waveSamples).toBe(frames);
    expect(result.rawSamples).toBe(frames);
    expect(result.identical).toBe(true);
    expect(result.declaredDataBytes).toBe(frames * 2);
  });
});

/**
 * Float WAV, verified by ffmpeg.
 *
 * WHY NOT PYTHON HERE — a genuine and important limitation, not a workaround for our own
 * bug. Python's stdlib `wave` module CANNOT read IEEE-float WAV files. By design it
 * accepts only `WAVE_FORMAT_PCM` (tag 1) or `WAVE_FORMAT_EXTENSIBLE` whose SubFormat GUID
 * is the PCM subtype; anything else raises `wave.Error: unknown format: 3`. That
 * restriction lives in wave.py upstream. The only way to make `wave` accept a float file
 * would be to write a false format tag, which is exactly the quiet wrongness this module
 * refuses to do — so the file stays correct and the verification uses a decoder that
 * genuinely supports the format.
 *
 * ffmpeg reads format tag 3 natively and shares no code with us, so it is a real
 * independent check. It also independently sanity-checks the header arithmetic: ffprobe
 * derives the frame count from our `data` chunk size, so a wrong size shows up as a wrong
 * duration rather than as a passing test.
 */
maybeFfmpeg("32-bit float WAV verified by ffmpeg", () => {
  it("is probed by ffprobe as pcm_f32le with the header fields we wrote", () => {
    const dir = ensureDir();
    const path = join(dir, "mono-32f.wav");

    const frames = 512;
    const samples = new Float64Array(frames);
    for (let i = 0; i < frames; i++) {
      samples[i] = 0.5 * Math.sin((2 * Math.PI * 440 * i) / 48000);
    }
    writeFileSync(path, encodeWav(samples, { sampleRate: 48000, channels: 1, bitDepth: 32 }));

    const probe = execFileSync(
      FFPROBE,
      [
        "-v", "error",
        "-select_streams", "a:0",
        "-show_entries", "stream=codec_name,sample_fmt,sample_rate,channels,bits_per_sample,duration",
        "-of", "json",
        path,
      ],
      { encoding: "utf8", shell: false },
    );
    const stream = (JSON.parse(probe) as { streams: Record<string, unknown>[] }).streams[0]!;

    // ffmpeg must agree with every header field we wrote.
    expect(stream["codec_name"]).toBe("pcm_f32le");
    expect(stream["sample_fmt"]).toBe("flt");
    expect(stream["sample_rate"]).toBe("48000");
    expect(stream["channels"]).toBe(1);
    expect(stream["bits_per_sample"]).toBe(32);
    // Duration is derived by ffmpeg from our data-chunk size, so this checks the sizes.
    expect(Number(stream["duration"])).toBeCloseTo(frames / 48000, 4);
  });

  it("decodes to sample values matching the encoder's intent", () => {
    const dir = ensureDir();
    const path = join(dir, "mono-32f-values.wav");

    const frames = 512;
    const samples = new Float64Array(frames);
    for (let i = 0; i < frames; i++) {
      samples[i] = 0.5 * Math.sin((2 * Math.PI * 440 * i) / 48000);
    }
    writeFileSync(path, encodeWav(samples, { sampleRate: 48000, channels: 1, bitDepth: 32 }));

    const raw = execFileSync(
      FFMpeg,
      ["-v", "error", "-i", path, "-f", "f64le", "-acodec", "pcm_f64le", "-"],
      { shell: false, maxBuffer: 64 * 1024 * 1024 },
    );
    const decoded = new Float64Array(raw.buffer, raw.byteOffset, raw.length / 8);

    expect(decoded.length).toBe(frames);
    // Sampled across the file, so a wrong data-chunk offset would misalign these.
    for (const index of [0, 100, 255, 511]) {
      expect(decoded[index]!).toBeCloseTo(samples[index]!, 6);
    }
  });

  it("also round-trips 16-bit stereo through ffmpeg, cross-checking the PCM path", () => {
    // Independent confirmation of the same 16-bit path Python verified, from a second
    // decoder. Two unrelated readers agreeing is much stronger than one.
    const dir = ensureDir();
    const path = join(dir, "stereo-16-ffmpeg.wav");

    const frames = 400;
    const samples = new Float64Array(frames * 2);
    for (let f = 0; f < frames; f++) {
      samples[f * 2] = 0.5 * Math.sin((2 * Math.PI * 300 * f) / 16000);
      samples[f * 2 + 1] = 0.5 * Math.sin((2 * Math.PI * 700 * f) / 16000);
    }
    writeFileSync(path, encodeWav(samples, { sampleRate: 16000, channels: 2, bitDepth: 16 }));

    const raw = execFileSync(
      FFMpeg,
      ["-v", "error", "-i", path, "-f", "f64le", "-acodec", "pcm_f64le", "-"],
      { shell: false, maxBuffer: 64 * 1024 * 1024 },
    );
    const decoded = new Float64Array(raw.buffer, raw.byteOffset, raw.length / 8);

    expect(decoded.length).toBe(frames * 2);
    // 16-bit quantisation: 1/32767 ≈ 3.05e-5, so a tolerance of 1e-4 is tight.
    for (const frame of [0, 50, 200, 399]) {
      expect(decoded[frame * 2]!).toBeCloseTo(samples[frame * 2]!, 4);
      expect(decoded[frame * 2 + 1]!).toBeCloseTo(samples[frame * 2 + 1]!, 4);
    }
    // The channels must not have been swapped or summed.
    expect(Math.abs(decoded[100 * 2]! - decoded[100 * 2 + 1]!)).toBeGreaterThan(0.05);
  });
});