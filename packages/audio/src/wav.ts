import { UnsupportedAudioFormatError } from "./errors.js";

/**
 * Dependency-free RIFF/WAVE encoding and decoding.
 *
 * Why hand-rolled: audio is the deliverable here, not a side effect. A WAV writer that
 * is merely "self-consistent" — one that our own decoder happens to read back — proves
 * nothing, because both sides can share the same misreading of the format. So this
 * module targets the actual published layout (RIFF chunk container, `fmt ` chunk,
 * `data` chunk) and is verified against two independent decoders in the test suite:
 * Python's stdlib `wave` module and numpy.
 *
 * Supported on both read and write:
 *
 * | bit depth | sample format            | WAVE format tag |
 * |-----------|--------------------------|-----------------|
 * | 16        | signed integer PCM       | 1 (PCM)         |
 * | 32        | IEEE 754 single float    | 3 (IEEE_FLOAT)  |
 *
 * 32-bit float is the project's internal working precision — mixing in integers loses
 * headroom and makes clipping analysis guesswork — while 16-bit PCM is what the pilot's
 * delivery pipeline and most NLEs expect. Both directions matter.
 *
 * MONO AND STEREO ONLY, deliberately. WAVE's >2-channel story is a mess: the container
 * requires a WAVE_FORMAT_EXTENSIBLE `fmt ` chunk for a real channel mask, and decoders
 * disagree about the fallback when it is absent. Silently writing a 6-channel file that
 * half the world misreads is precisely the kind of quiet wrongness this codebase avoids,
 * so anything other than 1 or 2 channels throws instead.
 *
 * Sample representation: `Float64Array`, one value per channel frame, always in −1..+1
 * regardless of the on-disk bit depth. Interleaving is the *encoder's* business, not the
 * caller's, so callers pass `[left0, right0, left1, right1, ...]` for stereo and never
 * touch byte order.
 */

/** On-disk sample encodings this module can read and write. */
export type BitDepth = 16 | 32;

/** Sample format, derived from bit depth rather than configured separately. */
export type SampleFormat = "pcm_s16le" | "f32le";

export interface WavFormat {
  readonly sampleRate: number;
  readonly channels: number;
  readonly bitDepth: BitDepth;
}

export interface DecodedWav {
  /** Interleaved samples in −1..+1, length === frames * channels. */
  readonly samples: Float64Array;
  readonly sampleRate: number;
  readonly channels: number;
  readonly bitDepth: BitDepth;
}

// Byte costs, named so the header arithmetic below reads as arithmetic rather than
// as a pile of magic numbers.
const BITS_PER_BYTE = 8;
const RIFF_HEADER_BYTES = 12; // "RIFF" + size + "WAVE"
const CHUNK_HEADER_BYTES = 8; // id + size
const PCM_FMT_CHUNK_BYTES = 16; // canonical PCM fmt body
const EXTENSIBLE_FMT_CHUNK_BYTES = 40; // WAVE_FORMAT_EXTENSIBLE fmt body

const FORMAT_TAG_PCM = 0x0001;
const FORMAT_TAG_IEEE_FLOAT = 0x0003;
const FORMAT_TAG_EXTENSIBLE = 0xfffe;

/**
 * Largest value representable in a signed N-bit integer, i.e. 32767 for 16-bit.
 *
 * Note this is NOT 32768. The negative range of two's complement is one wider than the
 * positive range, so scaling by 32768 would map +1.0 onto 32768, which wraps to −32768
 * on write — a full-scale click at every peak. Dividing by 32768 on decode and
 * multiplying by 32767 on encode keeps the round trip honest within one LSB.
 */
function signedIntScale(bitDepth: BitDepth): number {
  return 2 ** (bitDepth - 1) - 1;
}

export function sampleFormatFor(bitDepth: BitDepth): SampleFormat {
  return bitDepth === 16 ? "pcm_s16le" : "f32le";
}

export function bytesPerSample(bitDepth: BitDepth): number {
  const bytes = bitDepth / BITS_PER_BYTE;
  if (!Number.isInteger(bytes)) {
    throw new UnsupportedAudioFormatError(
      `Bit depth ${bitDepth} is not a whole number of bytes.`,
    );
  }
  return bytes;
}

// ---------------------------------------------------------------------------
// Encoding
// ---------------------------------------------------------------------------

/**
 * Encode interleaved float samples as a complete RIFF/WAVE file.
 *
 * Throws on a channel count or bit depth we cannot write honestly, rather than emitting
 * a file that some decoders will misread. Values outside −1..+1 are CLAMPED, not
 * wrapped: a wrapped peak is an audible click and, worse, is indistinguishable from
 * intentional audio, whereas clamping at least fails predictably. Detecting clipping is
 * the mixer's job (`measureLoudness`), not the encoder's — by the time we are writing
 * bytes the decision has already been made.
 */
export function encodeWav(samples: Float64Array, format: WavFormat): Buffer {
  const { sampleRate, channels, bitDepth } = format;

  assertWritableFormat(format);
  if (samples.length % channels !== 0) {
    throw new UnsupportedAudioFormatError(
      `Sample count ${samples.length} is not a whole number of ${channels}-channel frames.`,
    );
  }

  const bytesPer = bytesPerSample(bitDepth);
  const dataBytes = samples.length * bytesPer;
  const fmtBytes = PCM_FMT_CHUNK_BYTES;
  const byteRate = sampleRate * channels * bytesPer;
  const blockAlign = channels * bytesPer;
  const riffSize = RIFF_HEADER_BYTES + CHUNK_HEADER_BYTES + fmtBytes + CHUNK_HEADER_BYTES + dataBytes;

  const out = Buffer.alloc(riffSize);
  let offset = 0;

  offset = writeAscii(out, offset, "RIFF");
  out.writeUInt32LE(riffSize - 8, offset);
  offset += 4;
  offset = writeAscii(out, offset, "WAVE");

  // `fmt ` — note the trailing space, which is part of the chunk id and not cosmetic.
  offset = writeAscii(out, offset, "fmt ");
  out.writeUInt32LE(fmtBytes, offset);
  offset += 4;
  out.writeUInt16LE(bitDepth === 16 ? FORMAT_TAG_PCM : FORMAT_TAG_IEEE_FLOAT, offset);
  offset += 2;
  out.writeUInt16LE(channels, offset);
  offset += 2;
  out.writeUInt32LE(sampleRate, offset);
  offset += 4;
  out.writeUInt32LE(byteRate, offset);
  offset += 4;
  out.writeUInt16LE(blockAlign, offset);
  offset += 2;
  out.writeUInt16LE(bitDepth, offset);
  offset += 2;

  offset = writeAscii(out, offset, "data");
  out.writeUInt32LE(dataBytes, offset);
  offset += 4;

  if (bitDepth === 16) {
    const scale = signedIntScale(16);
    for (let i = 0; i < samples.length; i++) {
      out.writeInt16LE(Math.round(clampUnit(samples[i]!) * scale), offset + i * 2);
    }
  } else {
    for (let i = 0; i < samples.length; i++) {
      // Float WAV stores the sample as-is; clamping is still applied because a value
      // beyond ±1 is out of contract for this module and would confuse downstream
      // loudness maths. NaN is mapped to 0 so a single bad sample cannot poison a file.
      const value = samples[i]!;
      out.writeFloatLE(Number.isFinite(value) ? clampUnit(value) : 0, offset + i * 4);
    }
  }

  return out;
}

// ---------------------------------------------------------------------------
// Decoding
// ---------------------------------------------------------------------------

/**
 * Decode a RIFF/WAVE file into interleaved float samples.
 *
 * Chunk walking is deliberately tolerant of what real encoders emit: unknown chunks are
 * skipped, chunk sizes are padded to even byte boundaries as the spec requires, and a
 * 64-bit `data` size (written as −1 in the 32-bit field) is recovered from the actual
 * buffer length. What it will NOT do is guess at a format it cannot represent — an
 * unsupported tag or depth throws rather than returning plausible-looking noise.
 */
export function decodeWav(buffer: Buffer): DecodedWav {
  if (buffer.length < RIFF_HEADER_BYTES) {
    throw new UnsupportedAudioFormatError(
      `Not a WAV file: only ${buffer.length} bytes, too short for a RIFF header.`,
    );
  }
  if (buffer.toString("ascii", 0, 4) !== "RIFF") {
    throw new UnsupportedAudioFormatError(
      `Not a WAV file: expected "RIFF" magic, found "${buffer.toString("ascii", 0, 4)}".`,
    );
  }
  if (buffer.toString("ascii", 8, 12) !== "WAVE") {
    throw new UnsupportedAudioFormatError(
      `Not a WAVE file: expected "WAVE" form type, found "${buffer.toString("ascii", 8, 12)}".`,
    );
  }

  let offset = RIFF_HEADER_BYTES;
  let fmt: {
    formatTag: number;
    channels: number;
    sampleRate: number;
    blockAlign: number;
    bitDepth: number;
  } | undefined;
  let dataStart = -1;
  let dataLength = 0;

  while (offset + CHUNK_HEADER_BYTES <= buffer.length) {
    const id = buffer.toString("ascii", offset, offset + 4);
    const declared = buffer.readUInt32LE(offset + 4);
    const body = offset + CHUNK_HEADER_BYTES;

    if (id === "fmt ") {
      fmt = readFmtChunk(buffer, body, declared);
    } else if (id === "data") {
      // Some writers stream and never patch the size, leaving 0xFFFFFFFF. Trust the
      // file length instead of the header when the declared size overruns the buffer.
      const available = buffer.length - body;
      dataLength = declared === 0xffffffff || declared > available ? available : declared;
      dataStart = body;
    }

    // Chunks are word-aligned: an odd body length is followed by a pad byte.
    const advance = declared + (declared % 2);
    if (advance <= 0) break; // A zero-size chunk would spin forever; treat as end.
    offset = body + advance;
  }

  if (!fmt) {
    throw new UnsupportedAudioFormatError("Malformed WAV: no `fmt ` chunk found.");
  }
  if (dataStart < 0) {
    throw new UnsupportedAudioFormatError("Malformed WAV: no `data` chunk found.");
  }

  const bitDepth = normaliseBitDepth(fmt.formatTag, fmt.bitDepth);
  const bytesPer = bytesPerSample(bitDepth);
  const frameBytes = fmt.blockAlign > 0 ? fmt.blockAlign : fmt.channels * bytesPer;
  const frames = Math.floor(dataLength / frameBytes);
  const samples = new Float64Array(frames * fmt.channels);

  if (bitDepth === 16) {
    const scale = signedIntScale(16);
    for (let i = 0; i < samples.length; i++) {
      samples[i] = buffer.readInt16LE(dataStart + i * 2) / scale;
    }
  } else {
    for (let i = 0; i < samples.length; i++) {
      const value = buffer.readFloatLE(dataStart + i * 4);
      samples[i] = Number.isFinite(value) ? value : 0;
    }
  }

  return {
    samples,
    sampleRate: fmt.sampleRate,
    channels: fmt.channels,
    bitDepth,
  };
}

function readFmtChunk(
  buffer: Buffer,
  body: number,
  declared: number,
): { formatTag: number; channels: number; sampleRate: number; blockAlign: number; bitDepth: number } {
  if (declared < PCM_FMT_CHUNK_BYTES) {
    throw new UnsupportedAudioFormatError(
      `Malformed WAV: \`fmt \` chunk is ${declared} bytes; at least ${PCM_FMT_CHUNK_BYTES} are required.`,
    );
  }
  if (body + PCM_FMT_CHUNK_BYTES > buffer.length) {
    throw new UnsupportedAudioFormatError("Malformed WAV: `fmt ` chunk is truncated.");
  }

  let formatTag = buffer.readUInt16LE(body);
  const channels = buffer.readUInt16LE(body + 2);
  const sampleRate = buffer.readUInt32LE(body + 4);
  const blockAlign = buffer.readUInt16LE(body + 12);
  let bitDepth = buffer.readUInt16LE(body + 14);

  if (formatTag === FORMAT_TAG_EXTENSIBLE) {
    // WAVE_FORMAT_EXTENSIBLE wraps the real format in the first 2 bytes of its
    // extension; the rest is a channel mask and a GUID. We ignore the mask because we
    // only accept mono and stereo, where the conventional masks are unambiguous.
    if (declared < EXTENSIBLE_FMT_CHUNK_BYTES || body + 26 > buffer.length) {
      throw new UnsupportedAudioFormatError(
        "Malformed WAV: WAVE_FORMAT_EXTENSIBLE chunk is too short to contain a sub-format.",
      );
    }
    formatTag = buffer.readUInt16LE(body + 24);
    // The container depth can claim 32 bits of padding for 24-bit samples; the valid
    // bits field is what actually describes the sample. We only accept 16 and 32.
    bitDepth = buffer.readUInt16LE(body + 18);
  }

  if (channels < 1) {
    throw new UnsupportedAudioFormatError("Malformed WAV: channel count is zero.");
  }
  if (channels > 2) {
    throw new UnsupportedAudioFormatError(
      `Unsupported WAV: ${channels} channels. This module reads mono and stereo only, ` +
        "because multi-channel WAVE depends on a WAVE_FORMAT_EXTENSIBLE channel mask " +
        "that decoders interpret inconsistently.",
    );
  }
  if (sampleRate < 1) {
    throw new UnsupportedAudioFormatError("Malformed WAV: sample rate is zero.");
  }

  return { formatTag, channels, sampleRate, blockAlign, bitDepth };
}

function normaliseBitDepth(formatTag: number, bitDepth: number): BitDepth {
  if (formatTag === FORMAT_TAG_PCM && bitDepth === 16) return 16;
  if (formatTag === FORMAT_TAG_IEEE_FLOAT && bitDepth === 32) return 32;
  if (formatTag === FORMAT_TAG_PCM && bitDepth === 32) {
    throw new UnsupportedAudioFormatError(
      "Unsupported WAV: 32-bit integer PCM. Only 16-bit integer and 32-bit float are supported.",
    );
  }
  throw new UnsupportedAudioFormatError(
    `Unsupported WAV: format tag 0x${formatTag.toString(16).padStart(4, "0")} ` +
      `at ${bitDepth} bits. Only 16-bit PCM and 32-bit IEEE float are supported.`,
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function assertWritableFormat(format: WavFormat): void {
  if (format.channels !== 1 && format.channels !== 2) {
    throw new UnsupportedAudioFormatError(
      `Cannot write ${format.channels} channels. This module writes mono and stereo only.`,
    );
  }
  if (format.bitDepth !== 16 && format.bitDepth !== 32) {
    throw new UnsupportedAudioFormatError(
      `Cannot write ${format.bitDepth}-bit samples. Only 16-bit PCM and 32-bit float are supported.`,
    );
  }
  if (!Number.isInteger(format.sampleRate) || format.sampleRate < 1) {
    throw new UnsupportedAudioFormatError(
      `Sample rate must be a positive integer; received ${format.sampleRate}.`,
    );
  }
}

function writeAscii(buffer: Buffer, offset: number, text: string): number {
  buffer.write(text, offset, "ascii");
  return offset + text.length;
}

function clampUnit(value: number): number {
  if (value > 1) return 1;
  if (value < -1) return -1;
  return value;
}

// ---------------------------------------------------------------------------
// Signals
// ---------------------------------------------------------------------------

/** Allocate a silent buffer of the given duration. */
export function createSilence(
  durationSeconds: number,
  sampleRate: number,
  channels: number,
): Float64Array {
  const frames = Math.max(0, Math.round(durationSeconds * sampleRate));
  return new Float64Array(frames * channels);
}

export function durationSecondsOf(sampleCount: number, sampleRate: number, channels: number): number {
  return sampleCount / channels / sampleRate;
}

/**
 * Convert stereo to mono by averaging, or mono to stereo by duplication.
 *
 * Averaging (rather than summing) keeps a centre-panned signal at the same perceived
 * level as its mono source; summing would add 6 dB and push a near-full-scale mix into
 * clipping during format conversion.
 */
export function convertChannels(
  samples: Float64Array,
  from: number,
  to: number,
): Float64Array {
  if (from === to) return samples;
  if (from === 1 && to === 2) {
    const out = new Float64Array(samples.length * 2);
    for (let i = 0; i < samples.length; i++) {
      const value = samples[i]!;
      out[i * 2] = value;
      out[i * 2 + 1] = value;
    }
    return out;
  }
  if (from === 2 && to === 1) {
    const out = new Float64Array(samples.length / 2);
    for (let i = 0; i < out.length; i++) {
      out[i] = (samples[i * 2]! + samples[i * 2 + 1]!) / 2;
    }
    return out;
  }
  throw new UnsupportedAudioFormatError(
    `Cannot convert ${from} channels to ${to}. Only mono and stereo are supported.`,
  );
}

/** Resample by linear interpolation. Adequate for pitch/pace shaping; not a studio SRC. */
export function resampleLinear(
  samples: Float64Array,
  fromRate: number,
  toRate: number,
): Float64Array {
  if (fromRate === toRate) return samples;
  const ratio = toRate / fromRate;
  const outLength = Math.max(1, Math.round(samples.length * ratio));
  const out = new Float64Array(outLength);
  for (let i = 0; i < outLength; i++) {
    const position = i / ratio;
    const index = Math.floor(position);
    const frac = position - index;
    const a = samples[Math.min(index, samples.length - 1)] ?? 0;
    const b = samples[Math.min(index + 1, samples.length - 1)] ?? a;
    out[i] = a + (b - a) * frac;
  }
  return out;
}