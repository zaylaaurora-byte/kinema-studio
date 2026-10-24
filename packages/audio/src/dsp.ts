/**
 * Deterministic synthesis primitives.
 *
 * Everything here is a pure function of its inputs. No `Math.random`, no `Date.now`, no
 * ambient state — the same text plus the same direction must produce byte-identical
 * audio every run, or the timing and regression tests below are worthless.
 *
 * That rules out `Math.random()` even for noise. Instead we use a seeded 32-bit PRNG
 * (mulberry32, a small well-known generator) plus a hash of the text, so "noise" is
 * reproducible noise: two runs give the same file, two different lines give different
 * files.
 */

// ---------------------------------------------------------------------------
// Deterministic randomness
// ---------------------------------------------------------------------------

/**
 * mulberry32 — a 32-bit PRNG with a full 2^32 period and good distribution for our
 * purposes. Chosen over a linear congruential generator because LCGs have visibly
 * patterned low bits, which in audio shows up as a periodic whistle in "noise" bursts.
 */
export function createPrng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * FNV-1a, 32-bit. A hash is used rather than a checksum library because this runs on
 * every line of dialogue and must not allocate.
 */
export function hashText(text: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

// ---------------------------------------------------------------------------
// Envelopes and shaping
// ---------------------------------------------------------------------------

/**
 * Raised-cosine attack/release envelope.
 *
 * A hard onset is a click: the waveform jumps from 0 to full amplitude in one sample,
 * which is broadband energy and audibly a tick. Every generated sound starts and ends
 * through this ramp, including the "sharp" ones — a fast ramp, not no ramp.
 */
export function applyEnvelope(
  samples: Float64Array,
  sampleRate: number,
  attackMs: number,
  releaseMs: number,
): Float64Array {
  const n = samples.length;
  const attack = Math.max(1, Math.min(Math.round((attackMs / 1000) * sampleRate), Math.floor(n / 2)));
  const release = Math.max(1, Math.min(Math.round((releaseMs / 1000) * sampleRate), Math.floor(n / 2)));

  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    let gain = 1;
    if (i < attack) {
      gain = 0.5 - 0.5 * Math.cos((Math.PI * i) / attack);
    }
    const fromEnd = n - 1 - i;
    if (fromEnd < release) {
      gain *= 0.5 - 0.5 * Math.cos((Math.PI * fromEnd) / release);
    }
    out[i] = samples[i]! * gain;
  }
  return out;
}

/** Exponential decay to a floor, expressed as a time constant in milliseconds. */
export function exponentialDecay(
  n: number,
  sampleRate: number,
  decayMs: number,
  floor = 0.0005,
): Float64Array {
  const out = new Float64Array(n);
  const tau = (decayMs / 1000) * sampleRate;
  for (let i = 0; i < n; i++) {
    out[i] = floor + (1 - floor) * Math.exp(-i / tau);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Filters
// ---------------------------------------------------------------------------

/**
 * One-pole low-pass, expressed as a cutoff frequency in Hz.
 *
 * `y[n] = y[n-1] + a * (x[n] - y[n-1])` with `a = 1 - exp(-2*pi*fc/fs)`. The
 * exponential form is used rather than the common `2*pi*fc/fs` approximation because the
 * approximation is badly wrong once the cutoff approaches Nyquist, which is exactly where
 * the noise-burst sounds live.
 */
export function lowPass(
  samples: Float64Array,
  sampleRate: number,
  cutoffHz: number,
): Float64Array {
  const a = 1 - Math.exp((-2 * Math.PI * cutoffHz) / sampleRate);
  const out = new Float64Array(samples.length);
  let previous = 0;
  for (let i = 0; i < samples.length; i++) {
    previous += a * (samples[i]! - previous);
    out[i] = previous;
  }
  return out;
}

/** One-pole high-pass, the complement of `lowPass`, for removing rumble. */
export function highPass(
  samples: Float64Array,
  sampleRate: number,
  cutoffHz: number,
): Float64Array {
  const a = 1 - Math.exp((-2 * Math.PI * cutoffHz) / sampleRate);
  const out = new Float64Array(samples.length);
  let previous = 0;
  for (let i = 0; i < samples.length; i++) {
    const x = samples[i]!;
    previous += a * (x - previous);
    out[i] = x - previous;
  }
  return out;
}

/** A two-pole resonator, the basis of the formant approximation used for vowels. */
export function resonator(
  samples: Float64Array,
  sampleRate: number,
  frequencyHz: number,
  bandwidthHz: number,
): Float64Array {
  const r = Math.exp((-Math.PI * bandwidthHz) / sampleRate);
  const theta = (2 * Math.PI * frequencyHz) / sampleRate;
  const a1 = 2 * r * Math.cos(theta);
  const a2 = -(r * r);
  const gain = (1 - r) * Math.sqrt(1 - 2 * r * Math.cos(2 * theta) + r * r);

  const out = new Float64Array(samples.length);
  let y1 = 0;
  let y2 = 0;
  for (let i = 0; i < samples.length; i++) {
    const y = gain * samples[i]! + a1 * y1 + a2 * y2;
    out[i] = y;
    y2 = y1;
    y1 = y;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Waveform generators
// ---------------------------------------------------------------------------

/**
 * Band-limited-ish sawtooth built from harmonics.
 *
 * A naive `phase % 1` saw aliases badly at high fundamentals, folding energy back down
 * the spectrum as an inharmonic whistle. Summing a bounded number of harmonics below
 * Nyquist keeps the glottal source clean enough that the formant filters above shape it
 * predictably.
 */
export function sawtooth(
  n: number,
  sampleRate: number,
  frequency: number,
  phaseOffset = 0,
): Float64Array {
  const out = new Float64Array(n);
  const maxHarmonic = Math.max(1, Math.floor(sampleRate / 2 / Math.max(frequency, 1)));
  const harmonics = Math.min(24, maxHarmonic);
  for (let i = 0; i < n; i++) {
    const t = i / sampleRate;
    let value = 0;
    for (let h = 1; h <= harmonics; h++) {
      value += Math.sin(2 * Math.PI * frequency * h * t + phaseOffset * h) / h;
    }
    out[i] = value * (2 / Math.PI);
  }
  return out;
}

export function sine(n: number, sampleRate: number, frequency: number, phaseOffset = 0): Float64Array {
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    out[i] = Math.sin(2 * Math.PI * frequency * (i / sampleRate) + phaseOffset);
  }
  return out;
}

/**
 * Frequency-modulated sine, for sounds that glide.
 *
 * The phase is accumulated rather than computed as `sin(f(t) * t)`. That distinction
 * matters: `sin(f(t)*t)` is the classic FM bug — as f changes, the phase jumps, producing
 * a discontinuity that is audible as a click on every glide step. Integrating the
 * instantaneous frequency keeps the phase continuous.
 */
export function glidingSine(
  n: number,
  sampleRate: number,
  frequencyAt: (progress: number) => number,
  phaseOffset = 0,
): Float64Array {
  const out = new Float64Array(n);
  let phase = phaseOffset;
  for (let i = 0; i < n; i++) {
    const progress = n <= 1 ? 0 : i / (n - 1);
    phase += (2 * Math.PI * frequencyAt(progress)) / sampleRate;
    out[i] = Math.sin(phase);
  }
  return out;
}

/** Deterministic white noise in −1..1. */
export function whiteNoise(n: number, prng: () => number): Float64Array {
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    out[i] = prng() * 2 - 1;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Operations
// ---------------------------------------------------------------------------

export function multiply(a: Float64Array, b: Float64Array): Float64Array {
  const n = Math.min(a.length, b.length);
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) out[i] = a[i]! * b[i]!;
  return out;
}

export function scale(samples: Float64Array, gain: number): Float64Array {
  const out = new Float64Array(samples.length);
  for (let i = 0; i < samples.length; i++) out[i] = samples[i]! * gain;
  return out;
}

export function concat(parts: readonly Float64Array[]): Float64Array {
  let total = 0;
  for (const part of parts) total += part.length;
  const out = new Float64Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

/** Peak absolute sample value. */
export function peakOf(samples: Float64Array): number {
  let peak = 0;
  for (let i = 0; i < samples.length; i++) {
    const value = Math.abs(samples[i]!);
    if (value > peak) peak = value;
  }
  return peak;
}

/**
 * Scale to a target peak.
 *
 * A silent buffer is returned unchanged rather than multiplied by `Infinity`; a
 * divide-by-zero here would produce NaN samples that then poison a whole mix.
 */
export function normaliseTo(samples: Float64Array, targetPeak: number): Float64Array {
  const peak = peakOf(samples);
  if (peak <= 0) return samples;
  return scale(samples, targetPeak / peak);
}

// ---------------------------------------------------------------------------
// Directional shaping
// ---------------------------------------------------------------------------

/**
 * Resample to change pitch and duration together.
 *
 * Stated plainly because it is a real limitation: this is the "varispeed" transform. A
 * ratio above 1 plays the buffer faster, which raises pitch AND shortens the sound;
 * below 1 lowers pitch and lengthens it. It is exactly how tape speed worked.
 *
 * An independent pitch shift with preserved duration needs a phase vocoder, which is a
 * substantial piece of DSP and is not implemented here. `applyPitchShift` below is the
 * honest wrapper: it reports what it actually did.
 */
export function resampleByRatio(samples: Float64Array, ratio: number): Float64Array {
  if (ratio === 1) return samples;
  const outLength = Math.max(1, Math.round(samples.length / ratio));
  const out = new Float64Array(outLength);
  const step = samples.length / outLength;
  for (let i = 0; i < outLength; i++) {
    const position = i * step;
    const index = Math.floor(position);
    const frac = position - index;
    const a = samples[Math.min(index, samples.length - 1)] ?? 0;
    const b = samples[Math.min(index + 1, samples.length - 1)] ?? a;
    out[i] = a + (b - a) * frac;
  }
  return out;
}

export interface PitchShiftResult {
  readonly samples: Float64Array;
  /** What the transform actually did, including any duration side effect. */
  readonly note: string;
  readonly durationChanged: boolean;
}

/**
 * Apply a pitch shift in semitones.
 *
 * HONEST LIMITATION: this is varispeed, not a true pitch shift. The output is shorter
 * (for a rise) or longer (for a fall) by the same ratio. That is acceptable for the mock
 * provider — which uses it to give each character a distinct register — but it is
 * recorded in `note` so a caller never has to guess whether their timing survived.
 */
export function applyPitchShift(samples: Float64Array, semitones: number): PitchShiftResult {
  if (semitones === 0) {
    return { samples, note: "No pitch shift applied.", durationChanged: false };
  }
  const ratio = 2 ** (semitones / 12);
  return {
    samples: resampleByRatio(samples, ratio),
    note:
      `Varispeed pitch shift of ${semitones} semitones (ratio ${ratio.toFixed(4)}). ` +
      `Duration changed by ${(((1 / ratio) - 1) * 100).toFixed(1)}%: this is not a ` +
      "duration-preserving pitch shift.",
    durationChanged: true,
  };
}

// ---------------------------------------------------------------------------
// Analysis
// ---------------------------------------------------------------------------

export interface SignalCharacteristics {
  readonly durationSeconds: number;
  readonly rms: number;
  readonly rmsDb: number;
  readonly peak: number;
  readonly peakDb: number;
  /**
   * Zero-crossing rate, crossings per second. A crude but genuinely useful brightness
   * proxy: a low rumble crosses zero rarely, a hiss crosses zero constantly.
   */
  readonly zeroCrossingRate: number;
  /**
   * Fraction of spectral energy above 1 kHz, measured by a Goertzel probe across
   * logarithmically spaced bands. Distinguishes a bright scream from a dark wheeze
   * without needing a full FFT.
   */
  readonly highFrequencyRatio: number;
}

/**
 * Measure a signal.
 *
 * Zero-crossing rate and the high-frequency ratio are computed on the MONO SUM of the
 * channels, not per channel: a stereo sound whose two channels are in antiphase has
 * plenty of per-channel energy but sums to silence, and every perceptual claim we make
 * about these sounds should reflect what a listener hears.
 */
export function measureSignal(
  samples: Float64Array,
  sampleRate: number,
  channels: number,
): SignalCharacteristics {
  const frames = Math.floor(samples.length / channels);
  const mono = new Float64Array(frames);
  for (let f = 0; f < frames; f++) {
    let sum = 0;
    for (let c = 0; c < channels; c++) sum += samples[f * channels + c]!;
    mono[f] = sum / channels;
  }

  let sumSquares = 0;
  let peak = 0;
  let crossings = 0;
  for (let i = 0; i < frames; i++) {
    const value = mono[i]!;
    sumSquares += value * value;
    const abs = Math.abs(value);
    if (abs > peak) peak = abs;
    if (i > 0) {
      const previous = mono[i - 1]!;
      if ((previous < 0 && value >= 0) || (previous >= 0 && value < 0)) crossings++;
    }
  }

  const rms = frames > 0 ? Math.sqrt(sumSquares / frames) : 0;
  const durationSeconds = frames / sampleRate;

  return {
    durationSeconds,
    rms,
    rmsDb: toDb(rms),
    peak,
    peakDb: toDb(peak),
    zeroCrossingRate: durationSeconds > 0 ? crossings / durationSeconds : 0,
    highFrequencyRatio: frames > 0 ? highFrequencyEnergyRatio(mono, sampleRate) : 0,
  };
}

/** Amplitude ratio to dBFS. Silence is −Infinity, which is the correct answer. */
export function toDb(amplitude: number): number {
  if (amplitude <= 0) return Number.NEGATIVE_INFINITY;
  return 20 * Math.log10(amplitude);
}

/**
 * Fraction of energy above 1 kHz, via a Goertzel probe.
 *
 * Goertzel rather than an FFT because we only need a handful of bands and this stays
 * allocation-light and dependency-free. Bands are spaced logarithmically so the result
 * reflects octaves rather than raw hertz, which is closer to how brightness is heard.
 */
function highFrequencyEnergyRatio(mono: Float64Array, sampleRate: number): number {
  const probes = [125, 250, 500, 1000, 2000, 4000, 6000];
  let low = 0;
  let high = 0;
  for (const frequency of probes) {
    if (frequency >= sampleRate / 2) continue;
    const power = goertzelPower(mono, sampleRate, frequency);
    if (frequency > 1000) high += power;
    else low += power;
  }
  const total = low + high;
  return total > 0 ? high / total : 0;
}

/**
 * Power at one frequency, sampled over overlapping windows.
 *
 * A single window over the whole signal measures an average and misses transients — an
 * impact's entire character is its first 20 ms. Windowing takes the MAXIMUM per-window
 * power instead, so a sound that is briefly bright reads as bright.
 */
function goertzelPower(mono: Float64Array, sampleRate: number, frequency: number): number {
  const windowSize = Math.min(2048, mono.length);
  if (windowSize < 32) return 0;

  const k = Math.round((windowSize * frequency) / sampleRate);
  const omega = (2 * Math.PI * k) / windowSize;
  const coefficient = 2 * Math.cos(omega);

  let best = 0;
  const hop = Math.max(1, Math.floor(windowSize / 2));
  for (let start = 0; start + windowSize <= mono.length; start += hop) {
    let s1 = 0;
    let s2 = 0;
    for (let i = 0; i < windowSize; i++) {
      // Hann window, so a non-integer bin frequency does not leak a misleading amount
      // of energy into the probe.
      const w = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (windowSize - 1));
      const s0 = mono[start + i]! * w + coefficient * s1 - s2;
      s2 = s1;
      s1 = s0;
    }
    const power = (s1 * s1 + s2 * s2 - coefficient * s1 * s2) / (windowSize * windowSize);
    if (power > best) best = power;
  }
  return best;
}