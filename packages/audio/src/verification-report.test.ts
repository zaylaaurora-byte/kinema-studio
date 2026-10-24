import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { encodeWav } from "./wav.js";

/**
 * Printed evidence that the WAV encoder is correct.
 *
 * `python-verify.test.ts` asserts the properties; this file PRINTS the raw decoder output
 * so the evidence can be read and pasted directly, rather than paraphrased from a passing
 * assertion. It is a separate file on purpose: the console noise belongs to the
 * verification step, not to the normal suite.
 *
 * Run it explicitly:
 *   & $node $pnpm --filter @kinema/audio exec vitest run src/verification-report.test.ts
 */

const PYTHON =
  process.env["KINEMA_PYTHON"] ??
  "C:\\Users\\zayla\\.dsh\\dsh-runtimes\\dsh-primary-runtime\\dependencies\\python\\python.exe";

const FFMPEG =
  process.env["KINEMA_FFMPEG"] ??
  "C:\\Users\\zayla\\AppData\\Local\\Microsoft\\WinGet\\Packages\\" +
    "Gyan.FFmpeg_Microsoft.Winget.Source_8wekyb3d8bbwe\\ffmpeg-9.0.2-full_build\\bin\\ffmpeg.exe";

const FFPROBE = FFMPEG.replace(/ffmpeg\.exe$/, "ffprobe.exe");

const OUT_DIR = join(process.cwd(), "tmp", "wav-verify");

function py(source: string): string {
  return execFileSync(PYTHON, ["-c", source], { encoding: "utf8" }).trim();
}

describe("WAV encoder — independent verification report", () => {
  it("prints what Python wave, numpy and ffmpeg each make of our files", () => {
    if (!existsSync(OUT_DIR)) mkdirSync(OUT_DIR, { recursive: true });

    // -----------------------------------------------------------------------
    // 1. Mono 16-bit PCM, read by Python's wave module and by numpy.
    // -----------------------------------------------------------------------
    const frames = 1000;
    const samples = new Float64Array(frames);
    for (let i = 0; i < frames; i++) samples[i] = (((i * 37) % 4001) - 2000) / 32767;

    const monoPath = join(OUT_DIR, "report-mono-16.wav");
    writeFileSync(monoPath, encodeWav(samples, { sampleRate: 24000, channels: 1, bitDepth: 16 }));

    const waveOutput = py(`
import wave, struct
with wave.open(r"${monoPath}", 'rb') as w:
    print('    channels     =', w.getnchannels())
    print('    sample rate  =', w.getframerate())
    print('    sample width =', w.getsampwidth(), 'bytes')
    print('    frames       =', w.getnframes())
    print('    compression  =', w.getcomptype())
    print('    duration     =', round(w.getnframes()/w.getframerate(), 6), 'seconds')
    print('    first 4 samples =', struct.unpack('<4h', w.readframes(4)))
`);

    const numpyOutput = py(`
import wave, json
import numpy as np
with wave.open(r"${monoPath}", 'rb') as w:
    arr = np.frombuffer(w.readframes(w.getnframes()), dtype='<i2')
expected = json.loads(r'''${JSON.stringify(Array.from(samples))}''')
errs = [abs(float(v)/32767.0 - e) for v, e in zip(arr, expected)]
print('    dtype        =', arr.dtype)
print('    samples      =', arr.size)
for i in (0, 1, 500, 999):
    print(f'    sample[{i:4d}]  = {arr[i]:6d}')
print('    max |error|  =', max(errs))
print('    exact matches=', sum(1 for e in errs if e == 0.0), 'of', len(errs))
`);

    // -----------------------------------------------------------------------
    // 2. 32-bit float, read by ffmpeg.
    // -----------------------------------------------------------------------
    const floatFrames = 512;
    const floatSamples = new Float64Array(floatFrames);
    for (let i = 0; i < floatFrames; i++) {
      floatSamples[i] = 0.5 * Math.sin((2 * Math.PI * 440 * i) / 48000);
    }
    const floatPath = join(OUT_DIR, "report-mono-32f.wav");
    writeFileSync(floatPath, encodeWav(floatSamples, { sampleRate: 48000, channels: 1, bitDepth: 32 }));

    const ffprobeOutput = execFileSync(
      FFPROBE,
      [
        "-v", "error", "-select_streams", "a:0",
        "-show_entries", "stream=codec_name,sample_fmt,sample_rate,channels,bits_per_sample,duration",
        "-of", "default=noprint_wrappers=1",
        floatPath,
      ],
      { encoding: "utf8" },
    ).trim();

    const rawF64 = execFileSync(
      FFMPEG,
      ["-v", "error", "-i", floatPath, "-f", "f64le", "-acodec", "pcm_f64le", "-"],
      { maxBuffer: 64 * 1024 * 1024 },
    );
    const decoded = new Float64Array(rawF64.buffer, rawF64.byteOffset, rawF64.length / 8);
    const sampleLines = [0, 100, 255, 511]
      .map(
        (i) =>
          `    sample[${String(i).padStart(3)}] = ${decoded[i]!.toFixed(9)}` +
          `   intended ${floatSamples[i]!.toFixed(9)}` +
          `   abs err ${Math.abs(decoded[i]! - floatSamples[i]!).toExponential(2)}`,
      )
      .join("\n");

    // -----------------------------------------------------------------------
    // 3. Python's wave module on the float file — the documented limitation.
    // -----------------------------------------------------------------------
    const waveOnFloat = py(`
import wave
try:
    wave.open(r"${floatPath}", 'rb')
    print('    UNEXPECTED: wave opened the float file')
except Exception as exc:
    print(f'    {type(exc).__name__}: {exc}')
`);

    // eslint-disable-next-line no-console
    console.log(
      [
        "",
        "═".repeat(74),
        "WAV ENCODER — INDEPENDENT VERIFICATION",
        "═".repeat(74),
        "",
        `1. MONO 16-BIT PCM — written by encodeWav`,
        `   file      : ${monoPath}`,
        `   intended  : ${frames} frames @ 24000 Hz, 16-bit, 1 channel`,
        "",
        "   Python stdlib `wave`:",
        waveOutput,
        "",
        "   numpy (independent parse of the payload):",
        numpyOutput,
        "",
        "2. 32-BIT FLOAT — written by encodeWav",
        `   file      : ${floatPath}`,
        `   intended  : ${floatFrames} frames @ 48000 Hz, 32-bit float, 1 channel`,
        "",
        "   ffprobe:",
        ffprobeOutput
          .split("\n")
          .map((line) => `    ${line}`)
          .join("\n"),
        "",
        "   ffmpeg decode (f64) vs intended:",
        sampleLines,
        "",
        "3. PYTHON wave ON THE FLOAT FILE (upstream limitation, not our bug)",
        waveOnFloat,
        "    Python's wave accepts only WAVE_FORMAT_PCM (1) or EXTENSIBLE with a PCM",
        "    subformat GUID; format tag 3 (IEEE float) is rejected by design. The encoder",
        "    does not mislabel the file to satisfy it — ffmpeg verifies float instead.",
        "",
        "═".repeat(74),
        "",
      ].join("\n"),
    );

    // The report must reflect real, correct output, not just be printed.
    expect(decoded.length).toBe(floatFrames);
    expect(ffprobeOutput).toContain("pcm_f32le");
  });
});