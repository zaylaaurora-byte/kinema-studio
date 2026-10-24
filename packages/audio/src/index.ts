/**
 * @kinema/audio — voice direction, speech generation and audio timeline mixing.
 *
 * The subsystem has four layers, each usable on its own:
 *
 * 1. `wav` — dependency-free RIFF/WAVE read and write (16-bit PCM, 32-bit float).
 * 2. `performance` — the typed voice-direction model and, critically, the capability
 *    negotiation that decides what a provider can honour natively, what must be emulated,
 *    and what cannot be done at all.
 * 3. `providers/mock-voice` — an offline adapter that produces real WAV audio. IT IS NOT
 *    REAL SPEECH; see the warning on that module.
 * 4. `mix` — multitrack assembly to a real WAV, with dB gain, fades, clipping detection
 *    and a loudness report.
 *
 * `nonverbal` and `dsp` are exported too, because the silent human's sounds and the
 * measurement primitives are useful outside the adapter that happens to use them.
 */

export {
  AudioError,
  AudioMixError,
  UnsupportedAudioFormatError,
  VoiceDirectionError,
} from "./errors.js";

export {
  bytesPerSample,
  convertChannels,
  createSilence,
  decodeWav,
  durationSecondsOf,
  encodeWav,
  resampleLinear,
  sampleFormatFor,
  type BitDepth,
  type DecodedWav,
  type SampleFormat,
  type WavFormat,
} from "./wav.js";

export {
  applyDirection,
  assertDirection,
  DEMON_HOST_DIRECTION,
  estimateBaseDurationMs,
  MAX_PACE,
  MIN_PACE,
  NEUTRAL_DIRECTION,
  neutralDirection,
  planDirection,
  TEXT_ONLY_CAPABILITIES,
  type DirectionPlan,
  type EmulatedControl,
  type EmulationMechanism,
  type Emotion,
  type NativeControl,
  type Pace,
  type TimingPlan,
  type UnhonourableControl,
  type VoiceCapabilities,
  type VoiceDirection,
} from "./performance.js";

export {
  applyEnvelope,
  applyPitchShift,
  createPrng,
  exponentialDecay,
  glidingSine,
  hashText,
  highPass,
  lowPass,
  measureSignal,
  normaliseTo,
  peakOf,
  resampleByRatio,
  resonator,
  sawtooth,
  sine,
  toDb,
  whiteNoise,
  type PitchShiftResult,
  type SignalCharacteristics,
} from "./dsp.js";

export {
  describeNonverbal,
  NONVERBAL_BASE_DURATION_MS,
  NONVERBAL_BASE_PEAK,
  NONVERBAL_KINDS,
  renderNonverbalPalette,
  sequenceNonverbal,
  synthesiseNonverbal,
  type NonverbalKind,
  type NonverbalRequest,
} from "./nonverbal.js";

export {
  adaptChannels,
  dbToGain,
  gainToDb,
  INTELLIGIBLE_RMS_DB,
  linearFade,
  measureLoudness,
  mixToWav,
  silentTimeline,
  windowRms,
  type ClipContribution,
  type ClippingReport,
  type LoudnessReport,
  type MixOptions,
  type MixResult,
  type TimelineClip,
} from "./mix.js";

export {
  MOCK_VOICE_CAPABILITIES,
  MockVoiceAdapter,
  voiceAssetId,
  type DirectedSpeech,
  type MockVoiceOptions,
  type NonverbalRequestOptions,
} from "./providers/mock-voice.js";