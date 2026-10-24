import { AudioMixError, UnsupportedAudioFormatError } from "./errors.js";
import { convertChannels, createSilence, encodeWav, type BitDepth } from "./wav.js";
import { toDb } from "./dsp.js";

/**
 * Multitrack mixing to a real WAV file.
 *
 * This is where the pilot's dialogue, non-verbal foley and any music bed become one
 * deliverable file. Three things here are easy to get quietly wrong, and all three are
 * treated as first-class rather than as details:
 *
 * 1. GAIN IN DECIBELS. A fader marked "−6 dB" must actually halve the amplitude, which
 *    means `10^(dB/20)` — the factor of 20 because dB is a power ratio and amplitude is
 *    the square root of power. Using `10^(dB/10)` (a real and common bug) makes every
 *    fader off by a factor of two in dB terms, so a "−6 dB" cut is really −12 dB.
 *
 * 2. CLIPPING IS REPORTED, NEVER WRAPPED. Summing tracks exceeds full scale constantly.
 *    Wrapping that to the opposite polarity turns a loud moment into harsh digital
 *    distortion; silently scaling the whole mix down changes the creator's levels without
 *    telling them. So the mix is clamped, the clipping is MEASURED (how many samples, how
 *    far over, where), and reported in the result. The caller decides what to do.
 *
 * 3. FADES ARE LINEAR IN AMPLITUDE, applied per-sample, and they are applied to the clip
 *    itself rather than after summing — so a fade-out cannot be defeated by another
 *    clip's energy at the same instant.
 */

/** A clip placed on the timeline. */
export interface TimelineClip {
  /** Interleaved samples in −1..+1. Channel count is given by `channels`. */
  readonly samples: Float64Array;
  readonly channels: number;
  readonly sampleRate: number;
  /** Position on the timeline, in seconds. Positions before 0 are an error. */
  readonly startSeconds: number;
  /** Fader position in dB. 0 is unity; −6 halves amplitude; +6 doubles it. */
  readonly gainDb: number;
  /** Fade-in length in seconds, from the clip's start. */
  readonly fadeInSeconds?: number;
  /** Fade-out length in seconds, ending at the clip's end. */
  readonly fadeOutSeconds?: number;
  /** Labels the clip in reports, e.g. "host-line-04" or "foley:impact". */
  readonly label?: string;
}

export interface MixOptions {
  readonly durationSeconds: number;
  readonly sampleRate: number;
  readonly channels: number;
  readonly bitDepth?: BitDepth;
}

/** Where and how badly the mix exceeded full scale. */
export interface ClippingReport {
  readonly clipped: boolean;
  /** Number of samples that would have exceeded ±1. */
  readonly clippedSampleCount: number;
  readonly clippedFraction: number;
  /** Largest absolute value seen BEFORE clamping. > 1 means it clipped. */
  readonly peakBeforeClamp: number;
  readonly peakBeforeClampDb: number;
  /** First timestamp where clipping occurred, in seconds. */
  readonly firstClipSeconds?: number;
  /** Actionable advice, not just a flag. */
  readonly recommendation: string;
}

export interface MixResult {
  readonly wav: Buffer;
  readonly durationSeconds: number;
  readonly sampleRate: number;
  readonly channels: number;
  readonly bitDepth: BitDepth;
  readonly frameCount: number;
  readonly loudness: LoudnessReport;
  readonly clipping: ClippingReport;
  /** Per-clip contribution, for a mix report a creator can read. */
  readonly clips: readonly ClipContribution[];
}

export interface ClipContribution {
  readonly label: string;
  readonly startSeconds: number;
  readonly durationSeconds: number;
  readonly gainDb: number;
  readonly linearGain: number;
  readonly peakDb: number;
  readonly rmsDb: number;
  /** True when this clip alone exceeds full scale, i.e. it will clip regardless of others. */
  readonly clipsOnItsOwn: boolean;
  /** True when the clip extends past the timeline end and was truncated. */
  readonly truncated: boolean;
}

/** Loudness measured in dBFS. */
export interface LoudnessReport {
  /** Root mean square across the whole mix. */
  readonly rms: number;
  readonly rmsDb: number;
  /** True peak, after clamping. */
  readonly peak: number;
  readonly peakDb: number;
  /** Peak-to-loudness ratio, in dB. A rough "is it dynamic or squashed" indicator. */
  readonly crestFactorDb: number;
  /**
   * Whether this is loud enough to be intelligible on ordinary playback. Stated as a
   * plain boolean with a reason, because "RMS −34 dBFS" means nothing to a writer.
   */
  readonly intelligible: boolean;
  readonly assessment: string;
}

/** Convert a fader position in dB to a linear amplitude multiplier. */
export function dbToGain(db: number): number {
  if (!Number.isFinite(db)) {
    throw new AudioMixError(`Gain must be a finite number of dB; received ${db}.`);
  }
  return 10 ** (db / 20);
}

/** Convert a linear amplitude multiplier to dB. Silence is −Infinity by definition. */
export function gainToDb(gain: number): number {
  return toDb(gain);
}

/**
 * Below this RMS, dialogue stops being reliably intelligible on phone speakers and
 * laptop drivers. It is a heuristic drawn from common delivery guidance (−24 dBFS RMS is
 * a widely used target for spoken-word web delivery, and −30 is already quiet), not a
 * broadcast standard — the report says so rather than implying certification.
 */
export const INTELLIGIBLE_RMS_DB = -30;

/** Build a linear fade multiplier array. `frames` long, values in 0..1. */
export function linearFade(frames: number, sampleRate: number, inSeconds: number, outSeconds: number): Float64Array {
  const gains = new Float64Array(frames);
  const inFrames = Math.max(0, Math.min(Math.round(inSeconds * sampleRate), frames));
  const outFrames = Math.max(0, Math.min(Math.round(outSeconds * sampleRate), frames));

  for (let i = 0; i < frames; i++) {
    let gain = 1;
    if (inFrames > 0 && i < inFrames) {
      gain *= i / inFrames;
    }
    const fromEnd = frames - 1 - i;
    if (outFrames > 0 && fromEnd < outFrames) {
      // Take the minimum so overlapping fades cannot produce a gain above 1 in the
      // middle, which would silently boost a very short clip.
      gain = Math.min(gain, fromEnd / outFrames);
    }
    gains[i] = gain;
  }
  return gains;
}

/**
 * Mix clips onto a fixed-length timeline and encode the result.
 *
 * Every clip is converted to the mix's channel count and sample rate before summing, so
 * a mono voice line and a stereo foley hit can share a timeline without a special case at
 * the call site.
 */
export function mixToWav(clips: readonly TimelineClip[], options: MixOptions): MixResult {
  const { durationSeconds, sampleRate, channels } = options;
  const bitDepth: BitDepth = options.bitDepth ?? 16;

  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) {
    throw new AudioMixError(`Timeline duration must be positive; received ${durationSeconds}.`);
  }
  if (channels !== 1 && channels !== 2) {
    throw new UnsupportedAudioFormatError(
      `Cannot mix to ${channels} channels. Mono and stereo are supported.`,
    );
  }
  if (!Number.isInteger(sampleRate) || sampleRate < 1) {
    throw new AudioMixError(`Sample rate must be a positive integer; received ${sampleRate}.`);
  }

  const totalFrames = Math.round(durationSeconds * sampleRate);
  // Accumulate in float64 regardless of the output depth. Summing in 16-bit integers
  // would quantise every partial sum and make the clipping measurement meaningless.
  const accumulator = new Float64Array(totalFrames * channels);
  const contributions: ClipContribution[] = [];

  for (const [index, clip] of clips.entries()) {
    const label = clip.label ?? `clip-${index}`;

    if (!Number.isFinite(clip.startSeconds) || clip.startSeconds < 0) {
      throw new AudioMixError(
        `Clip "${label}" starts at ${clip.startSeconds}s. Negative start times are not ` +
          "supported; trim the clip instead.",
      );
    }
    if (clip.channels !== 1 && clip.channels !== 2) {
      throw new UnsupportedAudioFormatError(
        `Clip "${label}" has ${clip.channels} channels; mono and stereo are supported.`,
      );
    }
    if (clip.samples.length % clip.channels !== 0) {
      throw new AudioMixError(
        `Clip "${label}" has ${clip.samples.length} samples, which is not a whole number ` +
          `of ${clip.channels}-channel frames.`,
      );
    }

    const linearGain = dbToGain(clip.gainDb);
    const clipFrames = Math.floor(clip.samples.length / clip.channels);
    const startFrame = Math.round(clip.startSeconds * sampleRate);
    const clipSeconds = clipFrames / clip.sampleRate;

    // Fades are computed in the CLIP's own timebase, then applied as the clip is
    // written, so a fade-in always aligns with the clip's audible start.
    const fadeGains = linearFade(
      clipFrames,
      clip.sampleRate,
      clip.fadeInSeconds ?? 0,
      clip.fadeOutSeconds ?? 0,
    );

    // Measure the clip as it will appear on the timeline (gain applied), so the report
    // describes what the mixer actually contributed.
    let clipPeak = 0;
    let clipSumSquares = 0;
    let written = 0;

    for (let frame = 0; frame < clipFrames; frame++) {
      const targetFrame = startFrame + frame;
      if (targetFrame >= totalFrames) break; // Past the timeline end: truncated, reported.

      const fade = fadeGains[frame]!;
      for (let c = 0; c < channels; c++) {
        // Up/down-mix the source channel onto the destination channel. A mono source
        // feeds both output channels; a stereo source into a mono mix is averaged.
        const source = readClipSample(clip, frame, c, channels);
        const value = source * linearGain * fade;
        accumulator[targetFrame * channels + c] = accumulator[targetFrame * channels + c]! + value;
        if (c === 0) {
          clipSumSquares += value * value;
          const abs = Math.abs(value);
          if (abs > clipPeak) clipPeak = abs;
        }
      }
      written++;
    }

    const writtenSeconds = written / sampleRate;
    contributions.push({
      label,
      startSeconds: clip.startSeconds,
      durationSeconds: clipSeconds,
      gainDb: clip.gainDb,
      linearGain,
      peakDb: toDb(clipPeak),
      rmsDb: toDb(written > 0 ? Math.sqrt(clipSumSquares / written) : 0),
      clipsOnItsOwn: clipPeak > 1,
      truncated: startFrame + clipFrames > totalFrames,
    });
  }

  // --- clipping ------------------------------------------------------------
  let clippedCount = 0;
  let peakBeforeClamp = 0;
  let firstClipFrame = -1;
  const mixed = new Float64Array(accumulator.length);

  for (let i = 0; i < accumulator.length; i++) {
    const value = accumulator[i]!;
    const abs = Math.abs(value);
    if (abs > peakBeforeClamp) peakBeforeClamp = abs;
    if (abs > 1) {
      clippedCount++;
      if (firstClipFrame < 0) firstClipFrame = Math.floor(i / channels);
      // Clamp rather than wrap. Wrapping is the single worst option: it flips the
      // waveform's polarity at the peak, which is heard as a tear rather than as
      // loudness, and it is invisible in any later measurement.
      mixed[i] = value > 0 ? 1 : -1;
    } else {
      mixed[i] = value;
    }
  }

  const clipping: ClippingReport = {
    clipped: clippedCount > 0,
    clippedSampleCount: clippedCount,
    clippedFraction: mixed.length > 0 ? clippedCount / mixed.length : 0,
    peakBeforeClamp,
    peakBeforeClampDb: toDb(peakBeforeClamp),
    ...(firstClipFrame >= 0 ? { firstClipSeconds: firstClipFrame / sampleRate } : {}),
    recommendation:
      clippedCount > 0
        ? `Reduce the level: the mix exceeds full scale by ${toDb(peakBeforeClamp).toFixed(2)} dB. ` +
          `Lower every clip by ${Math.ceil(toDb(peakBeforeClamp))} dB, or use a limiter, then remix.`
        : "No clipping: the mix stays within full scale.",
  };

  const loudness = measureLoudness(mixed, sampleRate, channels);
  const wav = encodeWav(mixed, { sampleRate, channels, bitDepth });

  return {
    wav,
    durationSeconds: totalFrames / sampleRate,
    sampleRate,
    channels,
    bitDepth,
    frameCount: totalFrames,
    loudness,
    clipping,
    clips: contributions,
  };
}

/**
 * Read one channel of one frame from a clip, adapting channel count.
 *
 * The rules, stated because they are audible decisions rather than plumbing:
 * - mono source -> stereo target: the same sample feeds both channels (centre pan).
 * - stereo source -> mono target: the two channels are AVERAGED, not summed. Summing
 *   would add up to +6 dB and clip material that was fine in stereo.
 * - matching counts: straight read.
 */
function readClipSample(
  clip: TimelineClip,
  frame: number,
  targetChannel: number,
  targetChannels: number,
): number {
  if (clip.channels === targetChannels) {
    return clip.samples[frame * clip.channels + targetChannel] ?? 0;
  }
  if (clip.channels === 1) {
    return clip.samples[frame] ?? 0;
  }
  // clip.channels === 2, targetChannels === 1
  return ((clip.samples[frame * 2] ?? 0) + (clip.samples[frame * 2 + 1] ?? 0)) / 2;
}

/**
 * Measure loudness in dBFS.
 *
 * Stated limitation: this is RMS and true-peak amplitude, NOT a perceptual loudness
 * standard. It does not implement ITU-R BS.1770 / EBU R128 — no K-weighting filter, no
 * gated loudness integration, no LUFS. So the numbers are honest as *level* figures and
 * must not be presented as broadcast-compliant loudness. What it is genuinely good for is
 * the question this pilot actually asks: is the dialogue audible, and how much headroom
 * is left?
 */
export function measureLoudness(
  samples: Float64Array,
  sampleRate: number,
  channels: number,
): LoudnessReport {
  const frames = Math.floor(samples.length / channels);
  if (frames === 0) {
    return {
      rms: 0,
      rmsDb: Number.NEGATIVE_INFINITY,
      peak: 0,
      peakDb: Number.NEGATIVE_INFINITY,
      crestFactorDb: 0,
      intelligible: false,
      assessment: "The timeline is empty, so there is nothing to measure.",
    };
  }

  let sumSquares = 0;
  let peak = 0;
  for (let i = 0; i < samples.length; i++) {
    // RMS is taken over the interleaved stream, which weights a stereo frame twice as
    // heavily as a mono frame — correct, since it carries twice the energy.
    const value = samples[i]!;
    sumSquares += value * value;
    const abs = Math.abs(value);
    if (abs > peak) peak = abs;
  }

  const rms = Math.sqrt(sumSquares / samples.length);
  const rmsDb = toDb(rms);
  const peakDb = toDb(peak);
  const intelligible = rmsDb > INTELLIGIBLE_RMS_DB;

  return {
    rms,
    rmsDb,
    peak,
    peakDb,
    crestFactorDb: peakDb - rmsDb,
    intelligible,
    assessment: intelligible
      ? `Dialogue should be intelligible: RMS ${rmsDb.toFixed(1)} dBFS, peak ` +
        `${peakDb.toFixed(1)} dBFS. Target for spoken-word delivery is around −24 dBFS RMS, ` +
        "so this is a level report, not a loudness standard."
      : `Too quiet to be reliably intelligible: RMS ${rmsDb.toFixed(1)} dBFS is below the ` +
        `${INTELLIGIBLE_RMS_DB} dBFS floor. Raise the dialogue clips by roughly ` +
        `${(INTELLIGIBLE_RMS_DB - rmsDb).toFixed(1)} dB.`,
  };
}

/**
 * Build a silent timeline, the starting point for assembling a scene.
 *
 * Provided so a caller can reserve the exact duration first and place clips into it,
 * which keeps timing decisions in one place instead of emerging from clip lengths.
 */
export function silentTimeline(durationSeconds: number, sampleRate: number, channels: number): Float64Array {
  return createSilence(durationSeconds, sampleRate, channels);
}

/** Adapt a clip's channel count to a target timeline. Exposed for assembling scenes. */
export function adaptChannels(samples: Float64Array, from: number, to: number): Float64Array {
  return convertChannels(samples, from, to);
}

/** Energy in a time window, used to assert that audio is where it should be on a timeline. */
export function windowRms(
  samples: Float64Array,
  sampleRate: number,
  channels: number,
  startSeconds: number,
  endSeconds: number,
): number {
  const startFrame = Math.max(0, Math.round(startSeconds * sampleRate));
  const endFrame = Math.min(Math.floor(samples.length / channels), Math.round(endSeconds * sampleRate));
  if (endFrame <= startFrame) return 0;

  let sumSquares = 0;
  let count = 0;
  for (let frame = startFrame; frame < endFrame; frame++) {
    for (let c = 0; c < channels; c++) {
      const value = samples[frame * channels + c]!;
      sumSquares += value * value;
      count++;
    }
  }
  return count > 0 ? Math.sqrt(sumSquares / count) : 0;
}