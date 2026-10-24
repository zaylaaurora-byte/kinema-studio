import { VoiceDirectionError } from "./errors.js";

/**
 * Voice direction — the typed model of *how* a line is delivered.
 *
 * A performance direction is the difference between a read and a performance. The demon
 * host in this pilot is specified as "dry, sarcastic, warm, slightly sleepy, neutral
 * American, long pauses, understated timing", and none of that survives a pipeline that
 * only carries text. So direction is a first-class value here, applied at the adapter
 * boundary, and recorded in the timeline next to the audio it produced.
 *
 * THE CENTRAL CONSTRAINT. Providers differ enormously in how much of this they can
 * honour. The product spec is unambiguous: *apply supported controls directly; otherwise
 * use script, punctuation, segmentation or manual post-processing — never fabricate
 * unsupported parameters.*
 *
 * That sentence rules out the tempting shortcut of stuffing `<emotion value="sarcastic">`
 * into a provider's text field and calling it done. A provider that ignores unknown
 * markup will read the tag aloud, or drop it and silently deliver a flat line while our
 * provenance claims a directed performance. Both are worse than admitting the control is
 * unavailable.
 *
 * So `planDirection` is the heart of this module. Given a direction and what a provider
 * can actually do, it returns a plan that is *explicit about the gap*:
 *
 * - which controls the provider applies natively,
 * - which controls are emulated, and by which concrete mechanism (SSML-like markup,
 *   punctuation, silence insertion, post-processing),
 * - which controls CANNOT be honoured at all, with a reason a human can act on.
 *
 * A provider that supports nothing yields `unhonourable` entries for everything the
 * caller asked for. Nothing is silently dropped, which is the whole point.
 */

/** Emotional colour of a delivery. Kept as a closed set so adapters can map it. */
export type Emotion =
  | "neutral"
  | "dry"
  | "sarcastic"
  | "warm"
  | "sleepy"
  | "angry"
  | "afraid"
  | "amused"
  | "sad"
  | "excited";

/** Delivery speed, as a multiplier on the provider's baseline. 1.0 is unmodified. */
export type Pace = number;

/** A direction that can be applied to one line of dialogue. */
export interface VoiceDirection {
  readonly emotion: Emotion;
  /** 0 = barely there, 1 = maximum commitment. */
  readonly intensity: number;
  /** Multiplier on baseline speaking rate. 0.5 is half speed, 2.0 is double. */
  readonly pace: Pace;
  readonly pauseBeforeMs: number;
  readonly pauseAfterMs: number;
  /** Words to stress. Matched case-insensitively against the script. */
  readonly emphasis: readonly string[];
  /** Semitones. Positive is higher. Fractional values are allowed. */
  readonly pitchShift: number;
}

/**
 * What a provider can genuinely do with direction.
 *
 * Every field is a separate question because real providers answer them separately: some
 * offer a speed multiplier but no emotion, some accept SSML but not a pitch parameter,
 * and a plain text-only endpoint answers "no" to all of them.
 */
export interface VoiceCapabilities {
  /** A first-class emotion/style input. */
  readonly supportsEmotion: boolean;
  /** A numeric intensity or expressiveness input. */
  readonly supportsIntensity: boolean;
  /** A rate/speed multiplier. */
  readonly supportsRate: boolean;
  /** Explicit leading/trailing silence, or an inserted break. */
  readonly supportsPause: boolean;
  /** Word- or phrase-level stress markup. */
  readonly supportsEmphasis: boolean;
  /** Pitch in semitones, Hz or percent. */
  readonly supportsPitch: boolean;
  /**
   * SSML-like markup, or another structured prosody channel, that this provider
   * genuinely parses. When false, emitting markup would be fabrication — the provider
   * would either speak the tags or drop them.
   */
  readonly supportsSsml: boolean;
  /**
   * Non-verbal vocalisations (gasp, yelp, scream, wheeze, impact, breath).
   * The silent human character depends on these; a provider without them cannot voice
   * him at all.
   */
  readonly supportsNonverbal: boolean;
}

/** How a control that cannot be applied natively is nevertheless achieved. */
export type EmulationMechanism =
  /** SSML-like prosody markup the provider genuinely parses. */
  | "ssml"
  /** Rewriting punctuation and adding cue words to steer the read. */
  | "punctuation"
  /** Splitting the line into separately-generated segments. */
  | "segmentation"
  /** Inserting rendered silence into the timeline after synthesis. */
  | "silence-insertion"
  /** Applying a DSP transform (e.g. resampling for pitch) to the rendered audio. */
  | "post-processing";

/** A control the provider applies itself. */
export interface NativeControl {
  readonly control: keyof VoiceDirection;
  readonly parameter: string;
  readonly value: number | string | readonly string[];
}

/** A control the provider cannot apply, but which we can achieve another way. */
export interface EmulatedControl {
  readonly control: keyof VoiceDirection;
  readonly mechanism: EmulationMechanism;
  /** The concrete artefact to use: markup, rewritten text, or a segment plan. */
  readonly artifact: string;
  /** The cost of the workaround, stated plainly. */
  readonly caveat: string;
}

/** A control that can be neither applied nor emulated. Never silently dropped. */
export interface UnhonourableControl {
  readonly control: keyof VoiceDirection;
  readonly requested: number | string | readonly string[];
  readonly reason: string;
  /** What the creator can do about it. */
  readonly recommendation: string;
}

export interface DirectionPlan {
  readonly native: readonly NativeControl[];
  readonly emulated: readonly EmulatedControl[];
  readonly unhonourable: readonly UnhonourableControl[];
  /**
   * The text to actually send, after punctuation and markup emulation. When nothing
   * needed rewriting this is the input verbatim.
   */
  readonly script: string;
  /** Silence the caller must insert around the rendered audio, in milliseconds. */
  readonly leadingSilenceMs: number;
  readonly trailingSilenceMs: number;
  /** True when every requested control is either native or genuinely emulated. */
  readonly fullyHonoured: boolean;
  /** One line a creator can read, stating exactly what happened. */
  readonly summary: string;
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

/** A plain, unmodified read. */
export const NEUTRAL_DIRECTION: VoiceDirection = {
  emotion: "neutral",
  intensity: 0.5,
  pace: 1,
  pauseBeforeMs: 0,
  pauseAfterMs: 0,
  emphasis: [],
  pitchShift: 0,
};

/** A provider that can do nothing beyond reading the text it is given. */
export const TEXT_ONLY_CAPABILITIES: VoiceCapabilities = {
  supportsEmotion: false,
  supportsIntensity: false,
  supportsRate: false,
  supportsPause: false,
  supportsEmphasis: false,
  supportsPitch: false,
  supportsSsml: false,
  supportsNonverbal: false,
};

export function neutralDirection(overrides: Partial<VoiceDirection> = {}): VoiceDirection {
  return { ...NEUTRAL_DIRECTION, ...overrides };
}

/** The pilot's host: dry, sarcastic, warm, sleepy, understated, long pauses. */
export const DEMON_HOST_DIRECTION: VoiceDirection = {
  emotion: "sarcastic",
  intensity: 0.35,
  pace: 0.9,
  pauseBeforeMs: 700,
  pauseAfterMs: 900,
  emphasis: [],
  pitchShift: -2,
};

// ---------------------------------------------------------------------------
// Timing
// ---------------------------------------------------------------------------

/**
 * How pace interacts with pause.
 *
 * PACE SCALES THE SPEECH, NOT THE SILENCE. This is the modelling decision that most
 * affects whether a direction sounds directed or merely processed. Slowing a read to 0.8x
 * should stretch the words; stretching the dramatic pause along with them turns a
 * deliberate beat into dead air. So pauses are absolute milliseconds and pass through
 * untouched, while the spoken body is divided by pace.
 *
 * Pitch is likewise NOT a timing control — it is carried in the plan for the provider and
 * applied to the waveform by whoever renders it — so it never changes the duration here.
 */
export interface TimingPlan {
  /** Duration of the spoken body after the pace multiplier. */
  readonly speechDurationMs: number;
  readonly pauseBeforeMs: number;
  readonly pauseAfterMs: number;
  readonly totalDurationMs: number;
  /** The pace actually applied, clamped to a range a listener would accept. */
  readonly effectivePace: Pace;
  /** True when the requested pace was clamped. */
  readonly paceClamped: boolean;
}

/**
 * Usable pace range.
 *
 * Beyond roughly 0.5x–1.6x, synthesis stops sounding like a person changing speed and
 * starts sounding broken. Because the mock's timing claims must remain trustworthy, a
 * pace outside this range is CLAMPED and reported rather than quietly honoured in the
 * timing maths while the audio degenerates.
 */
export const MIN_PACE = 0.5;
export const MAX_PACE = 1.6;

/** Apply a direction to a known base duration, producing a concrete timing plan. */
export function applyDirection(direction: VoiceDirection, baseDurationMs: number): TimingPlan {
  if (!Number.isFinite(baseDurationMs) || baseDurationMs < 0) {
    throw new VoiceDirectionError(
      `Base duration must be a non-negative finite number; received ${baseDurationMs}.`,
    );
  }
  assertDirection(direction);

  const requested = direction.pace;
  const effectivePace = Math.min(MAX_PACE, Math.max(MIN_PACE, requested));
  const speechDurationMs = baseDurationMs / effectivePace;

  // Round only at the end: rounding each component separately accumulates error across
  // a long scene of short lines.
  const total = Math.round(direction.pauseBeforeMs + speechDurationMs + direction.pauseAfterMs);

  return {
    speechDurationMs,
    pauseBeforeMs: direction.pauseBeforeMs,
    pauseAfterMs: direction.pauseAfterMs,
    totalDurationMs: total,
    effectivePace,
    paceClamped: effectivePace !== requested,
  };
}

/** Reject a direction that cannot mean anything, rather than guessing the intent. */
export function assertDirection(direction: VoiceDirection): void {
  if (!Number.isFinite(direction.intensity) || direction.intensity < 0 || direction.intensity > 1) {
    throw new VoiceDirectionError(
      `Intensity must be between 0 and 1; received ${direction.intensity}.`,
    );
  }
  if (!Number.isFinite(direction.pace) || direction.pace <= 0) {
    throw new VoiceDirectionError(`Pace must be a positive number; received ${direction.pace}.`);
  }
  if (!Number.isFinite(direction.pitchShift)) {
    throw new VoiceDirectionError(`Pitch shift must be finite; received ${direction.pitchShift}.`);
  }
  if (direction.pauseBeforeMs < 0 || direction.pauseAfterMs < 0) {
    throw new VoiceDirectionError("Pause durations cannot be negative.");
  }
  // A pitch shift beyond an octave is not a performance choice, it is a different
  // character. Catching it here stops a typo (e.g. 1200 for "1.2 octaves") from
  // producing a chipmunk in the final render.
  if (Math.abs(direction.pitchShift) > 12) {
    throw new VoiceDirectionError(
      `Pitch shift of ${direction.pitchShift} semitones exceeds one octave. ` +
        "For a different character, use a different voice rather than extreme pitch.",
    );
  }
}

// ---------------------------------------------------------------------------
// Capability negotiation
// ---------------------------------------------------------------------------

/** Human-readable labels for the summary line. */
const CONTROL_LABELS: Record<keyof VoiceDirection, string> = {
  emotion: "emotion",
  intensity: "intensity",
  pace: "pace",
  pauseBeforeMs: "leading pause",
  pauseAfterMs: "trailing pause",
  emphasis: "emphasis",
  pitchShift: "pitch",
};

/**
 * Which controls the caller actually asked for.
 *
 * "Asked for" means *differs from neutral*, not *is present*. A direction that leaves
 * pitch at 0 and emphasis empty has not requested pitch or emphasis, and reporting them
 * as unhonourable would be noise that trains a creator to ignore the warnings.
 */
function requestedControls(direction: VoiceDirection): Set<keyof VoiceDirection> {
  const requested = new Set<keyof VoiceDirection>();
  if (direction.emotion !== "neutral") requested.add("emotion");
  if (direction.intensity !== NEUTRAL_DIRECTION.intensity) requested.add("intensity");
  if (direction.pace !== 1) requested.add("pace");
  if (direction.pauseBeforeMs > 0) requested.add("pauseBeforeMs");
  if (direction.pauseAfterMs > 0) requested.add("pauseAfterMs");
  if (direction.emphasis.length > 0) requested.add("emphasis");
  if (direction.pitchShift !== 0) requested.add("pitchShift");
  return requested;
}

/**
 * Build the negotiation plan.
 *
 * Order of preference for each control is always: native, then a real emulation, then an
 * explicit refusal. The refusal path exists so that a text-only provider asked for a
 * sarcastic, pitched, paced read reports all four as unhonourable instead of returning a
 * flat read that the timeline would then label as directed.
 */
export function planDirection(
  direction: VoiceDirection,
  capabilities: VoiceCapabilities,
  script = "",
): DirectionPlan {
  assertDirection(direction);

  const requested = requestedControls(direction);
  const native: NativeControl[] = [];
  const emulated: EmulatedControl[] = [];
  const unhonourable: UnhonourableControl[] = [];

  const emulate = (
    control: keyof VoiceDirection,
    mechanism: EmulationMechanism,
    artifact: string,
    caveat: string,
  ): void => {
    emulated.push({ control, mechanism, artifact, caveat });
  };

  const refuse = (
    control: keyof VoiceDirection,
    requestedValue: number | string | readonly string[],
    reason: string,
    recommendation: string,
  ): void => {
    unhonourable.push({ control, requested: requestedValue, reason, recommendation });
  };

  // --- emotion -------------------------------------------------------------
  if (requested.has("emotion")) {
    if (capabilities.supportsEmotion) {
      native.push({ control: "emotion", parameter: "emotion", value: direction.emotion });
    } else if (capabilities.supportsSsml) {
      emulate(
        "emotion",
        "ssml",
        `<mstts:express-as style="${direction.emotion}">…</mstts:express-as>`,
        "Style markup is a coarse approximation of an acting choice; it selects a preset " +
          "rather than performing a specific beat.",
      );
    } else {
      refuse(
        "emotion",
        direction.emotion,
        "This provider has no emotion or style input and does not parse prosody markup, " +
          "so the emotion cannot be transmitted in the request at all.",
        `Pick a voice whose default read is already ${direction.emotion}, or direct the ` +
          "delivery with punctuation and wording instead (e.g. a flat comma before the " +
          "punchline reads as dry).",
      );
    }
  }

  // --- intensity -----------------------------------------------------------
  if (requested.has("intensity")) {
    if (capabilities.supportsIntensity) {
      native.push({ control: "intensity", parameter: "expressiveness", value: direction.intensity });
    } else if (capabilities.supportsSsml) {
      // Map 0..1 onto a documented prosody range. Stated in the artifact so nobody has
      // to reverse-engineer where the number came from.
      const volumePercent = Math.round(60 + direction.intensity * 40);
      emulate(
        "intensity",
        "ssml",
        `<prosody volume="${volumePercent}%">…</prosody>`,
        "Volume is not intensity: this changes loudness, not commitment. Understatement " +
          "at low intensity has to come from the voice's own baseline.",
      );
    } else {
      refuse(
        "intensity",
        direction.intensity,
        "No intensity or expressiveness control exists on this provider.",
        "If the line still reads too big, regenerate with punctuation that forces a " +
          "smaller read, or accept the voice's default level.",
      );
    }
  }

  // --- pace ----------------------------------------------------------------
  if (requested.has("pace")) {
    const timing = applyDirection(direction, 1000);
    if (capabilities.supportsRate) {
      native.push({ control: "pace", parameter: "rate", value: timing.effectivePace });
      if (timing.paceClamped) {
        // Report the clamp as an emulation caveat rather than hiding it: the caller
        // asked for something we deliberately did not do in full.
        emulate(
          "pace",
          "post-processing",
          `clamped ${direction.pace} to ${timing.effectivePace}`,
          `Pace ${direction.pace} is outside the usable range ${MIN_PACE}–${MAX_PACE}; ` +
            "the request was clamped because the result would not sound like speech.",
        );
      }
    } else if (capabilities.supportsSsml) {
      emulate(
        "pace",
        "ssml",
        `<prosody rate="${Math.round(timing.effectivePace * 100)}%">…</prosody>`,
        "Prosody rate is applied by the provider's own engine, so the resulting duration " +
          "is approximate — measure it rather than assuming the multiplier held.",
      );
    } else {
      emulate(
        "pace",
        "post-processing",
        `time-stretch rendered audio by ${timing.effectivePace}x`,
        "Resampling-based stretching shifts pitch, so pitch correction is required " +
          "afterwards if the character's timbre must stay fixed.",
      );
    }
  }

  // --- pauses --------------------------------------------------------------
  // Native pause support covers both ends; the silence figures are always reported
  // because a caller that inserts them unconditionally would double the pause.
  const pauseRequested = requested.has("pauseBeforeMs") || requested.has("pauseAfterMs");
  if (pauseRequested) {
    if (capabilities.supportsPause) {
      if (requested.has("pauseBeforeMs")) {
        native.push({
          control: "pauseBeforeMs",
          parameter: "leading-silence",
          value: direction.pauseBeforeMs,
        });
      }
      if (requested.has("pauseAfterMs")) {
        native.push({
          control: "pauseAfterMs",
          parameter: "trailing-silence",
          value: direction.pauseAfterMs,
        });
      }
    } else {
      // Silence insertion is ALWAYS available: it needs no cooperation from the
      // provider, only from the timeline. So this never becomes unhonourable.
      emulate(
        "pauseBeforeMs",
        "silence-insertion",
        `prepend ${direction.pauseBeforeMs}ms of digital silence`,
        "Silence is exact and needs nothing from the provider; it does mean the returned " +
          "audio is longer than the provider's stated duration.",
      );
    }
  }

  // --- emphasis ------------------------------------------------------------
  if (requested.has("emphasis")) {
    if (capabilities.supportsEmphasis) {
      native.push({ control: "emphasis", parameter: "emphasis", value: direction.emphasis });
    } else if (capabilities.supportsSsml) {
      emulate(
        "emphasis",
        "ssml",
        direction.emphasis
          .map((word) => `<emphasis level="strong">${word}</emphasis>`)
          .join(" "),
        "Markup emphasis raises loudness and length together, which can overshoot for a " +
          "dry, understated read.",
      );
    } else {
      // Punctuation-based emphasis is a real technique, not a consolation prize: a
      // pause before a word is how a dry comic lands a stress.
      emulate(
        "emphasis",
        "punctuation",
        direction.emphasis.map((word) => `… ${word}`).join(", "),
        "Emphasis becomes a preceding beat rather than a stressed syllable. It changes " +
          "the rhythm of the line; check the timing still fits the cut.",
      );
    }
  }

  // --- pitch ---------------------------------------------------------------
  if (requested.has("pitchShift")) {
    if (capabilities.supportsPitch) {
      native.push({ control: "pitchShift", parameter: "pitch", value: direction.pitchShift });
    } else if (capabilities.supportsSsml) {
      emulate(
        "pitchShift",
        "ssml",
        `<prosody pitch="${direction.pitchShift >= 0 ? "+" : ""}${direction.pitchShift}st">…</prosody>`,
        "Provider pitch support varies in units and direction; verify by measuring the " +
          "fundamental frequency rather than trusting the parameter.",
      );
    } else {
      emulate(
        "pitchShift",
        "post-processing",
        `shift pitch by ${direction.pitchShift} semitones (ratio ` +
          `${(2 ** (direction.pitchShift / 12)).toFixed(4)})`,
        "Naive resampling changes duration as well as pitch, so a time-stretch pass is " +
          "required to restore the original length.",
      );
    }
  }

  const rewritten = applyScriptEmulation(script, direction, capabilities, emulated);
  const leadingSilenceMs = capabilities.supportsPause ? 0 : direction.pauseBeforeMs;
  const trailingSilenceMs = capabilities.supportsPause ? 0 : direction.pauseAfterMs;

  return {
    native,
    emulated,
    unhonourable,
    script: rewritten,
    leadingSilenceMs,
    trailingSilenceMs,
    fullyHonoured: unhonourable.length === 0,
    summary: summarise(native, emulated, unhonourable),
  };
}

/**
 * Apply the script-level half of the plan.
 *
 * Markup is only ever added for emulations that selected SSML, and only when the provider
 * actually parses SSML. Any other provider gets the script back unchanged, because
 * putting tags into a plain text field means they get read aloud.
 */
function applyScriptEmulation(
  script: string,
  direction: VoiceDirection,
  capabilities: VoiceCapabilities,
  emulated: readonly EmulatedControl[],
): string {
  if (script === "") return script;
  const usesSsml = emulated.some((e) => e.mechanism === "ssml");
  if (usesSsml && capabilities.supportsSsml) {
    const inner = applyPunctuationEmphasis(script, direction, emulated);
    return wrapInSsml(inner, direction, capabilities);
  }
  return applyPunctuationEmphasis(script, direction, emulated);
}

/**
 * Punctuation emulation.
 *
 * Two effects, both real and both used by actual voice directors:
 *
 * 1. EMPHASIS by preceding beat. "… word" forces a hesitation before the stressed word.
 *    This is how a dry comic lands a stress without raising volume.
 * 2. PAUSE by comma. A trailing comma before a full stop lengthens the phrase ending,
 *    which is how "long pauses, understated timing" is written into a plain script.
 */
function applyPunctuationEmphasis(
  script: string,
  direction: VoiceDirection,
  emulated: readonly EmulatedControl[],
): string {
  let out = script;

  const usesPunctuationEmphasis = emulated.some(
    (e) => e.control === "emphasis" && e.mechanism === "punctuation",
  );
  if (usesPunctuationEmphasis && direction.emphasis.length > 0) {
    for (const word of direction.emphasis) {
      // Case-insensitive, whole-word, first occurrence only. Rewriting every occurrence
      // would turn a stress into a tic.
      const pattern = new RegExp(`\\b${escapeRegExp(word)}\\b`, "i");
      if (pattern.test(out)) {
        out = out.replace(pattern, `… ${word}`);
      }
    }
  }

  const pauseEmulated = emulated.some(
    (e) =>
      (e.control === "pauseAfterMs" || e.control === "pauseBeforeMs") &&
      e.mechanism === "silence-insertion",
  );
  if (pauseEmulated && direction.pauseAfterMs >= 250) {
    // A comma before terminal punctuation buys a beat. Only applied for pauses long
    // enough to be a deliberate choice rather than an artefact.
    out = out.replace(/([^.,!?…\s])(\s*[.!?]+)$/, "$1,$2");
  }

  return out;
}

/** Wrap the script in the narrowest SSML that expresses the requested controls. */
function wrapInSsml(script: string, direction: VoiceDirection, caps: VoiceCapabilities): string {
  let inner = escapeXml(script);

  if (caps.supportsPitch && direction.pitchShift !== 0) {
    // Not wrapped: pitch was applied natively, so re-stating it in markup would apply
    // the shift twice.
    inner = inner;
  } else if (direction.pitchShift !== 0) {
    inner = `<prosody pitch="${direction.pitchShift >= 0 ? "+" : ""}${direction.pitchShift}st">${inner}</prosody>`;
  }

  if (!caps.supportsRate && direction.pace !== 1) {
    inner = `<prosody rate="${Math.round(applyDirection(direction, 1000).effectivePace * 100)}%">${inner}</prosody>`;
  }

  if (!caps.supportsEmotion && direction.emotion !== "neutral") {
    inner = `<mstts:express-as style="${direction.emotion}">${inner}</mstts:express-as>`;
  }

  return `<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" ` +
    `xmlns:mstts="https://www.w3.org/2001/mstts" xml:lang="en-US">${inner}</speak>`;
}

function summarise(
  native: readonly NativeControl[],
  emulated: readonly EmulatedControl[],
  unhonourable: readonly UnhonourableControl[],
): string {
  const parts: string[] = [];
  if (native.length > 0) {
    parts.push(
      `Applied natively: ${native.map((n) => CONTROL_LABELS[n.control]).join(", ")}.`,
    );
  }
  if (emulated.length > 0) {
    const byMechanism = new Map<EmulationMechanism, string[]>();
    for (const e of emulated) {
      const list = byMechanism.get(e.mechanism) ?? [];
      list.push(CONTROL_LABELS[e.control]);
      byMechanism.set(e.mechanism, list);
    }
    for (const [mechanism, controls] of byMechanism) {
      parts.push(`Emulated via ${mechanism}: ${controls.join(", ")}.`);
    }
  }
  if (unhonourable.length > 0) {
    parts.push(
      `NOT HONOURED: ${unhonourable.map((u) => CONTROL_LABELS[u.control]).join(", ")}.`,
    );
  }
  if (parts.length === 0) {
    return "No direction controls requested; the line reads with the voice's defaults.";
  }
  return parts.join(" ");
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function escapeXml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

// ---------------------------------------------------------------------------
// Base duration estimation
// ---------------------------------------------------------------------------

/**
 * Estimate how long a line takes to speak, before direction.
 *
 * This is the fallback when a provider reports no duration of its own. It is an
 * estimate and is labelled as one: the true duration is measured from the returned
 * audio (`measureLoudness`, `durationSecondsOf`), and callers that need a real number
 * must use that instead. A provider that returns a duration always wins over this.
 *
 * The model is deliberately simple and explained rather than tuned to look clever:
 * ~165 words per minute is a common documentary narration baseline, adjusted for word
 * length and for punctuation, which is where pauses actually live.
 */
export function estimateBaseDurationMs(text: string, wordsPerMinute = 165): number {
  const words = text.split(/\s+/).filter((w) => w.length > 0);
  if (words.length === 0) return 0;

  const msPerWord = 60_000 / wordsPerMinute;
  let total = 0;
  for (const word of words) {
    // Longer words take longer, but sub-linearly; 5 characters is the pivot.
    const lengthFactor = 0.75 + Math.min(word.length, 14) / 20;
    total += msPerWord * lengthFactor;
  }

  // Punctuation is where a read actually slows down.
  const commas = (text.match(/[,;:]/g) ?? []).length;
  const sentenceEnds = (text.match(/[.!?…]/g) ?? []).length;
  const ellipses = (text.match(/…|\.\.\./g) ?? []).length;
  total += commas * 180;
  total += sentenceEnds * 320;
  total += ellipses * 260; // An ellipsis is a beat, on top of the sentence end.

  return Math.round(total);
}