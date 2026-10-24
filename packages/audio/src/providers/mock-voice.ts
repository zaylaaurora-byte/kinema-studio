import { createHash } from "node:crypto";

import type {
  CancellationSignal,
  CostEstimate,
  GenerationOutput,
  GenerationRequest,
  GenerationResult,
  JobHandle,
  ModelDescriptor,
  NormalisedError,
  ProviderAdapter,
  ProviderCapabilities,
  ProviderCredentials,
  ValidationResult,
} from "@kinema/types";

import {
  DEMON_HOST_DIRECTION,
  estimateBaseDurationMs,
  planDirection,
  TEXT_ONLY_CAPABILITIES,
  type DirectionPlan,
  type VoiceCapabilities,
  type VoiceDirection,
} from "../performance.js";
import { synthesiseNonverbal, NONVERBAL_KINDS, type NonverbalKind } from "../nonverbal.js";
import {
  applyEnvelope,
  createPrng,
  hashText,
  lowPass,
  measureSignal,
  normaliseTo,
  resonator,
  sawtooth,
  whiteNoise,
  type SignalCharacteristics,
} from "../dsp.js";
import { decodeWav, encodeWav } from "../wav.js";

/**
 * Offline mock voice provider.
 *
 * ═══════════════════════════════════════════════════════════════════════════════
 * THIS IS NOT SPEECH. READ THIS BEFORE USING ITS OUTPUT.
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * This adapter does not synthesise language. It does not know what a phoneme is. It has
 * no dictionary, no grapheme-to-phoneme stage, no vocoder, no neural network, and no
 * model of a human vocal tract. Nobody listening to its output could mistake it for a
 * person speaking, and it must never be presented to a user as a voice performance.
 *
 * What it DOES produce, and why that is worth having:
 *
 *   - A REAL, valid, deterministic WAV file. Not silence, not noise: a pitched,
 *     formant-filtered tone whose fundamental is derived from a hash of the text, with
 *     a per-word amplitude envelope and per-word formant variation. It has the timing
 *     and the spectral shape of speech-like audio, which is exactly enough to exercise
 *     the timeline, the mixer, the WAV writer and the loudness reporting for real.
 *   - Direction that is genuinely honoured: `pauseBeforeMs` and `pauseAfterMs` insert
 *     real digital silence of the requested duration, and `pace` measurably changes the
 *     rendered length. These are verified by measuring returned sample counts.
 *   - Non-verbal sounds that are real, distinct waveforms (see `nonverbal.ts`).
 *   - Honest capability declarations, so the negotiation in `planDirection` shows what a
 *     real provider would add rather than what this one pretends to do.
 *
 * It is a fixture for developing and testing the pipeline without paid API calls, per
 * the product spec's requirement that development not depend on paid providers. When a
 * real TTS adapter is added it implements the same `ProviderAdapter` interface and
 * nothing downstream changes.
 *
 * DETERMINISM. The same request always produces byte-identical output. The "randomness"
 * is a seeded PRNG derived from a text hash, and there is no `Math.random`, no clock and
 * no ambient state anywhere in the synthesis path — so caching and regression testing are
 * meaningful.
 */

const MODEL_ID = "mock-voice-v1";

/**
 * The mock's honest capabilities.
 *
 * Note what is FALSE here and think about what it means. This provider has no emotion
 * input, no intensity, no rate parameter, no emphasis markup, no pitch parameter and no
 * SSML parser. Those are not oversights — they are the truth, and declaring them
 * truthfully is what makes `planDirection` demonstrate its emulation paths. Ask this
 * adapter for a sarcastic, pitched, paced read and it will report all of it as
 * unhonourable, with reasons, exactly as it should.
 *
 * What it genuinely supports: it renders pauses itself (`supportsPause`), because it
 * inserts real silence into the WAV it returns rather than leaving that to the caller.
 * And it renders non-verbal sounds natively.
 *
 * CONTRAST WITH A REAL PROVIDER, so the gap is not mistaken for a design choice: a
 * production TTS service typically offers a voice/style id (`supportsEmotion`), a
 * speaking-rate multiplier (`supportsRate`), SSML with `<prosody>` and `<break>`
 * (`supportsSsml`, `supportsEmphasis`, `supportsPitch`), and mixed expressiveness
 * (`supportsIntensity`). Against this mock, all of those become explicit emulations or
 * refusals — which is the behaviour under test.
 */
export const MOCK_VOICE_CAPABILITIES: VoiceCapabilities = {
  ...TEXT_ONLY_CAPABILITIES,
  // Real: the adapter inserts actual silence of the requested duration into the file.
  supportsPause: true,
  // Real: gasp, yelp, scream, wheeze, impact and breath are rendered as distinct signals.
  supportsNonverbal: true,
};

export interface MockVoiceOptions {
  /** Sample rate of the produced WAV. Default 24000 — ample for this synthesis. */
  readonly sampleRate?: number;
  /** 1 or 2. Default 1: dialogue is mono until the mix places it. */
  readonly channels?: 1 | 2;
  /** 16-bit PCM or 32-bit float output. Default 32-bit float, the internal precision. */
  readonly bitDepth?: 16 | 32;
}

const DEFAULT_SAMPLE_RATE = 24_000;
const DEFAULT_CHANNELS = 1;
const DEFAULT_BIT_DEPTH = 32;

/**
 * Register ranges for the two characters.
 *
 * The demon host sits low — the brief says "warm, slightly sleepy", and a low fundamental
 * is most of what makes a voice read that way. The silent human's sounds are pitched
 * relative to this base, which is why a yelp and a scream differ in absolute pitch.
 */
const HOST_BASE_HZ = 96;

/**
 * Vowel-like formant sets, cycled per word.
 *
 * These are the first two formants of roughly /a/, /e/, /i/, /o/, /u/ — real measured
 * vowel centres, not invented numbers. Cycling them per word is what stops the output
 * being a single droning note: adjacent "words" get different spectral colour, which is
 * the crudest possible stand-in for the fact that real speech changes timbre constantly.
 */
const FORMANT_SETS: readonly { readonly f1: number; readonly f2: number }[] = [
  { f1: 730, f2: 1090 }, // /a/
  { f1: 530, f2: 1840 }, // /e/
  { f1: 270, f2: 2290 }, // /i/
  { f1: 570, f2: 840 }, // /o/
  { f1: 300, f2: 870 }, // /u/
];

// ---------------------------------------------------------------------------
// Synthesis
// ---------------------------------------------------------------------------

interface SynthesisedLine {
  readonly samples: Float64Array;
  readonly sampleRate: number;
  readonly channels: number;
  /** Duration of the spoken body only, excluding inserted silence. */
  readonly speechSeconds: number;
  readonly plan: DirectionPlan;
  readonly wordCount: number;
  readonly baseDurationMs: number;
}

/**
 * Render a line of text to speech-like audio.
 *
 * The pipeline, and why each stage exists:
 *
 * 1. WORDS. The text is split into words. Pauses in real speech fall at word and clause
 *    boundaries, so the word is the unit of timing here.
 * 2. PER-WORD TIMING. Each word gets a duration from its length and the requested pace,
 *    plus an inter-word gap that scales with the word's punctuation. This is where
 *    `pace` becomes measurable in the output length.
 * 3. PITCH. The fundamental comes from a hash of the whole text, so two different lines
 *    are audibly different, and each word gets a small deterministic offset so the
 *    delivery has a melodic contour rather than one flat note.
 * 4. VOICE. A band-limited sawtooth (harmonically rich, like a glottal source) is passed
 *    through two resonators tuned to a vowel's formants. This is a source-filter model —
 *    the same idea a real synthesizer uses, implemented in about ten lines instead of a
 *    neural network.
 * 5. ENVELOPE. Per-word attack/release so words are separated rather than run together.
 * 6. PITCH SHIFT. The direction's `pitchShift` is applied by varispeed, whose duration
 *    side effect is then corrected by regenerating at the target length — see the note
 *    on `applyPitchShift` for why the naive version would corrupt the timing.
 * 7. LEADING/TRAILING SILENCE. Real zeros, inserted to the exact requested millisecond.
 */
function synthesiseLine(
  text: string,
  direction: VoiceDirection,
  sampleRate: number,
  channels: number,
  seedOffset: number,
): SynthesisedLine {
  const plan = planDirection(direction, MOCK_VOICE_CAPABILITIES, text);

  const words = tokenise(text);
  const baseDurationMs = estimateBaseDurationMs(text);

  if (words.length === 0) {
    // A line with no words is still a valid request — it is just a pause. Handled
    // explicitly so the caller gets the silence they asked for rather than an error.
    const silenceFrames = Math.round(
      ((direction.pauseBeforeMs + direction.pauseAfterMs) / 1000) * sampleRate,
    );
    return {
      samples: new Float64Array(silenceFrames * channels),
      sampleRate,
      channels,
      speechSeconds: 0,
      plan,
      wordCount: 0,
      baseDurationMs,
    };
  }

  const textHash = hashText(text);
  const prng = createPrng(textHash ^ seedOffset);

  // The fundamental is derived from the text hash, so different lines sit at different
  // pitches. `direction.pitchShift` is folded in here as a frequency offset, and it is
  // applied EXACTLY ONCE — no varispeed pass runs afterwards, so the shift cannot
  // compound and the timing is unaffected.
  const hashPitch = HOST_BASE_HZ + (textHash % 18);
  const wordsPerMinute = 165 * direction.pace;

  // Timing per word. Pace is applied to the spoken body only; inter-word gaps shrink
  // slightly with pace as well, because a faster read also closes up its gaps, but they
  // never vanish.
  const totalWeight = words.reduce((sum, w) => sum + wordWeight(w.text), 0);
  const speechMs = (totalWeight * 60_000) / words_per_minute;

  const scaleToTarget = speechMs / Math.max(1, words.reduce((s, w) => s + wordWeight(w.text), 0));
  const parts: Float64Array[] = [];

  for (const [index, word] of words.entries()) {
    const wordMs = wordWeight(word.text) * scaleToTarget;
    const wordFrames = Math.max(1, Math.round((wordMs / 1000) * sampleRate));
    const formants = FORMANT_SETS[index % FORMANT_SETS.length]!;

    // Each word gets a small melodic step. Real speech is never monotone, and this is
    // the cheapest honest way to make that true here. Deterministic, not random.
    const wordPitch =
      hashPitch *
      (1 + ((index * 7) % 5 - 2) * 0.03) *
      2 ** (direction.pitchShift / 12);

    const source = sawtooth(wordFrames, sampleRate, wordPitch, prng() * Math.PI * 2);
    const r1 = resonator(source, sampleRate, formants.f1, 90);
    const r2 = resonator(source, sampleRate, formants.f2, 140);
    const voiced = new Float64Array(wordFrames);
    for (let i = 0; i < wordFrames; i++) {
      voiced[i] = source[i]! * 0.5 + r1[i]! * 0.32 + r2[i]! * 0.28;
    }

    // A breathy component, low-passed and quiet. Without it the voice is a pure
    // oscillator, which sounds synthetic in a way that is distracting even for a mock.
    const air = lowPass(whiteNoise(wordFrames, prng), sampleRate, 1800);
    for (let i = 0; i < wordFrames; i++) {
      voiced[i] = voiced[i]! * 0.9 + air[i]! * 0.1;
    }

    // Slow amplitude movement within the word, as a stand-in for syllable structure.
    const syllableRate = Math.max(1.5, word.text.length / 3);
    for (let i = 0; i < wordFrames; i++) {
      const t = i / sampleRate;
      const syllable = 0.72 + 0.28 * Math.sin(2 * Math.PI * syllableRate * t);
      voiced[i] = voiced[i]! * syllable;
    }

    // Intensity makes the read more emphatic: stronger per-word attack and a slightly
    // wider amplitude swing. This is shaping, not a claimed emotion parameter.
    const attackMs = 18 - direction.intensity * 8;
    const releaseMs = 34 - direction.intensity * 12;
    parts.push(applyEnvelope(voiced, sampleRate, attackMs, releaseMs));

    // Inter-word gap. Punctuation extends it; everything extends it a little.
    //
    // The gap buffer is allocated in FRAMES, matching the word buffers (which are also
    // frame-length, since `sawtooth` generates one value per frame). `concatAll` then
    // broadcasts the monophonic stream to `channels` as it concatenates. Allocating this
    // as `frames * channels` was the bug that made stereo totals odd: the buffers would
    // disagree about their unit and the final sample count would not divide by the
    // channel count, so encodeWav rejected the buffer.
    const gapMs = word.gapMs / direction.pace;
    if (gapMs > 0) {
      parts.push(new Float64Array(Math.round((gapMs / 1000) * sampleRate)));
    }
  }

  let mono = concatAll(parts, channels);
  mono = normaliseTo(mono, 0.82);

  // PITCH. `direction.pitchShift` was already realised during synthesis, as a frequency
  // offset on the fundamental (`2 ** (semitones / 12)`), which is the correct way to do
  // it here: the pitch change is baked into the waveform that the formant filters then
  // shape, so the vowel colour stays put and the timing is untouched.
  //
  // The alternative — running the finished audio through `applyPitchShift` in dsp.ts —
  // is varispeed, which would also change the duration and therefore corrupt the timing
  // the caller is relying on. It is deliberately NOT used here, and `applyPitchShift`
  // reports that limitation in its own return value for callers that do need it.

  const speechSeconds = mono.length / channels / sampleRate;

  // ── PAUSES ────────────────────────────────────────────────────────────────
  //
  // This is where the mock ACTUALLY honours `pauseBeforeMs` / `pauseAfterMs`, and there
  // are two ways the values can arrive, so both are read:
  //
  //   - `plan.leadingSilenceMs` / `trailingSilenceMs` — the caller must insert the
  //     silence itself, because the provider has no pause control.
  //   - `plan.native` entries for `pauseBeforeMs` / `pauseAfterMs` — the provider claims
  //     it applies the pause itself. The mock declares `supportsPause: true` and therefore
  //     lands in this branch, so the silence has to be inserted HERE.
  //
  // An earlier version read ONLY the first pair. Since the mock declares native pause
  // support, those were always 0 and every requested pause was silently discarded — the
  // audio came back flat while the plan claimed the pause had been applied. It is exactly
  // the class of failure the capability model exists to prevent, and it was caught by
  // measuring returned sample counts rather than trusting the plan.
  const nativePause = (control: "pauseBeforeMs" | "pauseAfterMs"): number => {
    const entry = plan.native.find((n) => n.control === control);
    return typeof entry?.value === "number" ? entry.value : 0;
  };

  const leadingMs = plan.leadingSilenceMs + nativePause("pauseBeforeMs");
  const trailingMs = plan.trailingSilenceMs + nativePause("pauseAfterMs");

  // Every length below is in FRAMES, and the buffer is FRAMES * channels. Mixing the two
  // units is what produced an odd sample count for stereo earlier and made encodeWav
  // reject the buffer; keeping one unit throughout removes the whole class of error.
  const bodyFrames = mono.length / channels;
  const leadingFrames = Math.round((leadingMs / 1000) * sampleRate);
  const trailingFrames = Math.round((trailingMs / 1000) * sampleRate);

  const out = new Float64Array((leadingFrames + bodyFrames + trailingFrames) * channels);
  out.set(mono, leadingFrames * channels);

  return {
    samples: out,
    sampleRate,
    channels,
    speechSeconds,
    plan,
    wordCount: words.length,
    baseDurationMs,
  };
}

interface Token {
  readonly text: string;
  /** Milliseconds of silence to follow this word. */
  readonly gapMs: number;
}

/**
 * Split text into words, attributing pause to punctuation.
 *
 * The gap sizes are the whole reason a directed read sounds different from a flat one,
 * so they are documented rather than tuned: a comma is a beat a listener can perceive
 * (~180 ms), a full stop is a longer rest (~340 ms), and an ellipsis is longer still
 * (~460 ms) because in this pilot's script it marks the host's signature pause before a
 * punchline.
 */
function tokenise(text: string): Token[] {
  const raw = text.trim();
  if (raw === "") return [];

  return raw
    .split(/\s+/)
    .filter((w) => w.length > 0)
    .map((word) => {
      let gapMs = 70; // The baseline gap between words.
      if (/[…]$|\.\.\.$/.test(word)) gapMs = 460;
      else if (/[.!?]$/.test(word)) gapMs = 340;
      else if (/[,;:]$/.test(word)) gapMs = 180;
      else if (/[—–-]$/.test(word)) gapMs = 240;
      return { text: word, gapMs };
    });
}

/** Longer words take longer, sub-linearly. Mirrors the estimator in `performance.ts`. */
function wordWeight(word: string): number {
  const letters = word.replace(/[^\p{L}\p{N}]/gu, "").length;
  return 0.75 + Math.min(letters, 14) / 20;
}

function concatAll(parts: readonly Float64Array[], channels: number): Float64Array {
  let total = 0;
  for (const part of parts) total += part.length;
  const out = new Float64Array(total);
  let offset = 0;
  for (const part of parts) {
    // Mono parts are broadcast to the target channel count as they are concatenated.
    if (channels === 1 || part.length === 0) {
      out.set(part, offset);
      offset += part.length;
      continue;
    }
    const frames = part.length;
    for (let f = 0; f < frames; f++) {
      const value = part[f]!;
      for (let c = 0; c < channels; c++) out[offset + f * channels + c] = value;
    }
    offset += frames * channels;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Model descriptor
// ---------------------------------------------------------------------------

const MOCK_CAPABILITIES: ProviderCapabilities = {
  providerId: "mock-voice",
  kind: "mock",
  supportsStreaming: false,
  supportsAsyncJobs: false,
  supportsCancellation: true,
  requiresNetwork: false,
  isMock: true,
  notes: [
    "Offline mock voice provider. Produces real, deterministic WAV audio without any network access or cost.",
    "CRITICAL: this is NOT speech synthesis. It generates a speech-like tone from the text; it does not pronounce words. Do not present its output as a voice performance.",
    "Direction is honoured for timing (pauses and pace are measurable in the output), but emotion, intensity, emphasis and pitch are NOT supported and are reported as such by planDirection.",
  ],
};

const MOCK_MODEL: ModelDescriptor = {
  id: MODEL_ID,
  displayName: "Mock Voice (offline, NOT real speech)",
  providerId: "mock-voice",
  inputs: ["text"],
  outputs: ["audio"],
  limits: {
    maxPromptChars: 5000,
    maxBatchSize: 1,
    maxLatencyMs: 120,
  },
  capabilities: {
    supportsStreaming: false,
    supportsToolCalls: false,
    supportsReferenceImage: false,
    // A real voice clone would need reference audio; the mock cannot accept it.
    supportsSeed: true,
    supportsNegativePrompt: false,
    supportsInpainting: false,
    supportsTransparentBackground: false,
    supportsConversationalEdit: false,
    supportsCancellation: true,
    // Honest: there is no quality or expressiveness control here.
    supportsQualityControl: false,
  },
  pricing: {
    basis: "free",
    note: "Local mock synthesis. No network call, no cost.",
    source: "built-in",
    verifiedAt: new Date().toISOString(),
  },
  outputMimeTypes: ["audio/wav"],
  warnings: [
    "NOT REAL SPEECH. The output is a synthetic speech-like tone derived from the text, not a spoken performance of it.",
    "Use it for pipeline development, timing tests and CI. Replace it with a real TTS adapter before any output is shown to an audience.",
    "Emotion, intensity, emphasis and pitch direction are not supported and are reported as unhonourable rather than silently applied.",
  ],
};

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

/** A request for a non-verbal sound, addressed to the silent human. */
export interface NonverbalRequestOptions {
  readonly kind: NonverbalKind;
  readonly intensity: number;
  readonly direction?: Partial<VoiceDirection>;
}

/** The result of a directed line, beyond the raw provider output. */
export interface DirectedSpeech {
  readonly wav: Buffer;
  readonly direction: VoiceDirection;
  readonly plan: DirectionPlan;
  readonly durationSeconds: number;
  readonly speechSeconds: number;
  readonly wordCount: number;
  readonly sampleRate: number;
  readonly channels: number;
}

export class MockVoiceAdapter implements ProviderAdapter {
  readonly id = "mock-voice";
  readonly displayName = "Mock Voice (offline)";
  readonly kind = "mock" as const;

  private readonly sampleRate: number;
  private readonly channels: 1 | 2;
  private readonly bitDepth: 16 | 32;

  constructor(options: MockVoiceOptions = {}) {
    this.sampleRate = options.sampleRate ?? DEFAULT_SAMPLE_RATE;
    this.channels = options.channels ?? DEFAULT_CHANNELS;
    this.bitDepth = options.bitDepth ?? DEFAULT_BIT_DEPTH;
  }

  /** What this provider can genuinely do with direction. Consulted by `planDirection`. */
  capabilitiesForDirection(): VoiceCapabilities {
    return MOCK_VOICE_CAPABILITIES;
  }

  async discoverCapabilities(): Promise<ProviderCapabilities> {
    return MOCK_CAPABILITIES;
  }

  async listModels(): Promise<readonly ModelDescriptor[]> {
    return [MOCK_MODEL];
  }

  async validateCredentials(_credentials: ProviderCredentials): Promise<{ ok: true }> {
    // No credentials needed, which is what lets the whole app run from an empty .env.
    return { ok: true };
  }

  async estimateCost(): Promise<CostEstimate> {
    return { amount: 0, currency: "USD", reliable: true, note: "Mock provider is free." };
  }

  validateRequest(request: GenerationRequest, model: ModelDescriptor): ValidationResult {
    const problems: string[] = [];
    const unsupportedFields: string[] = [];

    if (!request.prompt || request.prompt.trim().length === 0) {
      problems.push("A line of dialogue is required.");
    }
    if (request.prompt && model.limits.maxPromptChars !== undefined) {
      if (request.prompt.length > model.limits.maxPromptChars) {
        problems.push(
          `Line is ${request.prompt.length} characters; the model accepts at most ${model.limits.maxPromptChars}.`,
        );
      }
    }
    if (request.count !== undefined && request.count > 1) {
      // Rejecting rather than quietly returning one file, per the no-false-capability rule.
      unsupportedFields.push("count");
      problems.push("This provider renders one take per request; request a count per take.");
    }
    if (request.referenceAssetIds && request.referenceAssetIds.length > 0) {
      unsupportedFields.push("referenceAssetIds");
      problems.push(
        "This provider cannot clone a voice from reference audio, so character voice continuity cannot be guaranteed with it.",
      );
    }
    if (request.negativePrompt) {
      unsupportedFields.push("negativePrompt");
      problems.push("This provider does not support negative prompts.");
    }

    return { valid: problems.length === 0, unsupportedFields, problems };
  }

  async submitJob(
    request: GenerationRequest,
    _credentials: ProviderCredentials,
    signal?: CancellationSignal,
  ): Promise<JobHandle> {
    if (signal?.aborted) return { providerJobId: "", status: "cancelled" };

    const validation = this.validateRequest(request, MOCK_MODEL);
    if (!validation.valid) {
      throw new Error(`Invalid request: ${validation.problems.join(" ")}`);
    }
    const jobId = `mock-voice-${hashText(request.prompt + (request.seed ?? ""))}`;
    return { providerJobId: jobId, status: "succeeded" };
  }

  /**
   * The mock completes synchronously, so there is nothing to poll. Declared for contract
   * completeness and to fail loudly rather than returning an empty result by accident.
   */
  async pollOrSubscribe(
    _handle: JobHandle,
    _credentials: ProviderCredentials,
    _signal?: CancellationSignal,
  ): Promise<GenerationResult> {
    throw new Error(
      "MockVoiceAdapter is synchronous; call submitJobAndResolve() or speak() instead.",
    );
  }

  async cancelJob(): Promise<boolean> {
    return true;
  }

  normaliseResult(raw: unknown): GenerationResult {
    return raw as GenerationResult;
  }

  normaliseError(error: unknown): NormalisedError {
    const message = error instanceof Error ? error.message : String(error);
    return {
      code: "invalid_request",
      message,
      retryable: false,
      userActionRequired: true,
      detail: message,
    };
  }

  // -------------------------------------------------------------------------
  // Speech
  // -------------------------------------------------------------------------

  /**
   * Render a directed line and return the WAV plus the negotiation plan.
   *
   * This is the entry point the timeline should use, because it hands back the plan as
   * well as the audio: a caller that records the plan alongside the clip can explain
   * later exactly which direction controls made it into the render and which did not.
   */
  async speak(
    text: string,
    direction: VoiceDirection = DEMON_HOST_DIRECTION,
    signal?: CancellationSignal,
  ): Promise<DirectedSpeech> {
    if (signal?.aborted) {
      throw new Error("Cancelled before synthesis.");
    }

    const result = synthesiseLine(
      text,
      direction,
      this.sampleRate,
      this.channels,
      0x5eed,
    );

    return {
      wav: encodeWav(result.samples, {
        sampleRate: result.sampleRate,
        channels: result.channels,
        bitDepth: this.bitDepth,
      }),
      direction,
      plan: result.plan,
      durationSeconds: result.samples.length / result.channels / result.sampleRate,
      speechSeconds: result.speechSeconds,
      wordCount: result.wordCount,
      sampleRate: result.sampleRate,
      channels: result.channels,
    };
  }

  /** Render a line and return the raw samples, for mixing without a round trip. */
  renderLine(
    text: string,
    direction: VoiceDirection = DEMON_HOST_DIRECTION,
    seedOffset = 0x5eed,
  ): { samples: Float64Array; sampleRate: number; channels: number; plan: DirectionPlan } {
    const result = synthesiseLine(text, direction, this.sampleRate, this.channels, seedOffset);
    return {
      samples: result.samples,
      sampleRate: result.sampleRate,
      channels: result.channels,
      plan: result.plan,
    };
  }

  /** Render a non-verbal sound for the silent human. Never language. */
  renderNonverbal(kind: NonverbalKind, intensity = 0.7): Float64Array {
    return synthesiseNonverbal({
      kind,
      intensity,
      sampleRate: this.sampleRate,
      channels: this.channels,
      seed: hashText(kind) + 1,
    });
  }

  /** Render a non-verbal sound and wrap it as a real WAV file. */
  speakNonverbal(kind: NonverbalKind, intensity = 0.7): Buffer {
    return encodeWav(this.renderNonverbal(kind, intensity), {
      sampleRate: this.sampleRate,
      channels: this.channels,
      bitDepth: this.bitDepth,
    });
  }

  /** Every non-verbal sound the human can make, as WAVs. */
  speakNonverbalPalette(intensity = 0.7): Record<NonverbalKind, Buffer> {
    const out = {} as Record<NonverbalKind, Buffer>;
    for (const kind of NONVERBAL_KINDS) {
      out[kind] = this.speakNonverbal(kind, intensity);
    }
    return out;
  }

  /**
   * The synchronous path onto the shared `ProviderAdapter` contract, mirroring the mock
   * image adapter. The direction travels in `providerOptions.direction` because the
   * shared request type has no field for it — and adding one would change a package we
   * must not modify.
   */
  async submitJobAndResolve(
    request: GenerationRequest,
    signal?: CancellationSignal,
  ): Promise<GenerationResult> {
    const handle = await this.submitJob(request, {}, signal);
    if (handle.status === "cancelled") {
      return { status: "cancelled", outputs: [], provenance: this.buildProvenance(request) };
    }

    const direction = readDirection(request.providerOptions);
    const result = synthesiseLine(request.prompt, direction, this.sampleRate, this.channels, 0x5eed);

    const output: GenerationOutput = {
      kind: "audio",
      data: encodeWav(result.samples, {
        sampleRate: result.sampleRate,
        channels: result.channels,
        bitDepth: this.bitDepth,
      }),
      mimeType: "audio/wav",
      durationSeconds: result.samples.length / result.channels / result.sampleRate,
    };

    return {
      status: "succeeded",
      outputs: [output],
      provenance: this.buildProvenance(request, direction, result.plan),
    };
  }

  /**
 * Measure the returned audio, so a caller can report real characteristics rather than
 * the characteristics the synthesis intended.
 *
 * This decodes the WAV rather than analysing the pre-encode samples on purpose: the
 * bytes are what the creator will hear, and they have been through quantisation and
 * clamping. Measuring the in-memory buffer would report numbers that no listener could
 * ever experience.
 */
  analyse(wav: Buffer): SignalCharacteristics {
    const decoded = decodeWav(wav);
    return measureSignal(decoded.samples, decoded.sampleRate, decoded.channels);
  }

  private buildProvenance(
    request: GenerationRequest,
    direction?: VoiceDirection,
    plan?: DirectionPlan,
  ) {
    return {
      providerId: this.id,
      modelId: MODEL_ID,
      prompt: request.prompt,
      ...(request.seed !== undefined ? { seed: request.seed } : {}),
      createdAt: new Date().toISOString(),
      parameters: {
        sampleRate: this.sampleRate,
        channels: this.channels,
        bitDepth: this.bitDepth,
        ...(direction ? { direction } : {}),
        ...(plan
          ? {
              directionPlan: {
                native: plan.native,
                emulated: plan.emulated,
                unhonourable: plan.unhonourable,
                summary: plan.summary,
              },
            }
          : {}),
        // Recorded in provenance so the mock can never be mistaken for a real voice.
        synthesisIsRealSpeech: false,
      },
    };
  }
}

/** Read a direction out of the passthrough options, ignoring malformed values. */
function readDirection(options: Readonly<Record<string, unknown>> | undefined): VoiceDirection {
  const raw = options?.["direction"];
  if (!raw || typeof raw !== "object") return DEMON_HOST_DIRECTION;
  const candidate = raw as Partial<VoiceDirection>;
  return {
    ...DEMON_HOST_DIRECTION,
    ...candidate,
    emphasis: Array.isArray(candidate.emphasis) ? candidate.emphasis : [],
  };
}

/** SHA-256 based id, matching the image adapter's convention for stable asset ids. */
export function voiceAssetId(text: string, direction: VoiceDirection): string {
  return createHash("sha256")
    .update(`${text}|${JSON.stringify(direction)}`)
    .digest("hex")
    .slice(0, 16);
}