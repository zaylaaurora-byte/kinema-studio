import { describe, expect, it } from "vitest";

import { VoiceDirectionError } from "./errors.js";
import {
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
  type VoiceCapabilities,
  type VoiceDirection,
} from "./performance.js";
import { MOCK_VOICE_CAPABILITIES } from "./providers/mock-voice.js";

/**
 * Voice direction tests.
 *
 * The centre of gravity here is `planDirection`, because the product rule it implements is
 * the one most easily violated: "apply supported controls directly; otherwise use script,
 * punctuation, segmentation or manual post-processing — NEVER fabricate unsupported
 * parameters."
 *
 * So the tests below are mostly about what a plan REFUSES to claim.
 */

/** A provider with every capability, for testing the native path. */
const FULL_CAPABILITIES: VoiceCapabilities = {
  supportsEmotion: true,
  supportsIntensity: true,
  supportsRate: true,
  supportsPause: true,
  supportsEmphasis: true,
  supportsPitch: true,
  supportsSsml: true,
  supportsNonverbal: true,
};

/** A provider that parses SSML but has no first-class parameters. */
const SSML_ONLY: VoiceCapabilities = {
  ...TEXT_ONLY_CAPABILITIES,
  supportsSsml: true,
};

describe("applyDirection", () => {
  it("scales the spoken body by pace but leaves pauses absolute", () => {
    // This is the modelling decision the module documents: slowing a read stretches the
    // words, not the dramatic beat. Stretching the pause too turns it into dead air.
    const direction = neutralDirection({ pace: 0.8, pauseBeforeMs: 500, pauseAfterMs: 250 });
    const plan = applyDirection(direction, 1000);

    expect(plan.speechDurationMs).toBeCloseTo(1250, 6); // 1000 / 0.8
    expect(plan.pauseBeforeMs).toBe(500); // untouched
    expect(plan.pauseAfterMs).toBe(250);
    expect(plan.totalDurationMs).toBe(2000); // 500 + 1250 + 250
  });

  it("applies pace 1.0 as no change", () => {
    const plan = applyDirection(neutralDirection({ pace: 1 }), 4000);
    expect(plan.speechDurationMs).toBe(4000);
    expect(plan.totalDurationMs).toBe(4000);
    expect(plan.paceClamped).toBe(false);
  });

  it("clamps pace to the usable range and says so", () => {
    // A pace of 0.1 would produce timing maths that looks fine but audio that is not
    // recognisable as speech. Clamping and reporting beats silently honouring it.
    const slow = applyDirection(neutralDirection({ pace: 0.1 }), 1000);
    expect(slow.effectivePace).toBe(MIN_PACE);
    expect(slow.paceClamped).toBe(true);
    expect(slow.speechDurationMs).toBe(2000); // 1000 / 0.5

    const fast = applyDirection(neutralDirection({ pace: 9 }), 1000);
    expect(fast.effectivePace).toBe(MAX_PACE);
    expect(fast.paceClamped).toBe(true);
  });

  it("sums a zero base duration to just the pauses", () => {
    const plan = applyDirection(neutralDirection({ pauseBeforeMs: 300, pauseAfterMs: 200 }), 0);
    expect(plan.speechDurationMs).toBe(0);
    expect(plan.totalDurationMs).toBe(500);
  });

  it("rejects a negative or non-finite base duration", () => {
    expect(() => applyDirection(NEUTRAL_DIRECTION, -1)).toThrow(VoiceDirectionError);
    expect(() => applyDirection(NEUTRAL_DIRECTION, Number.NaN)).toThrow(VoiceDirectionError);
  });
});

describe("assertDirection", () => {
  it("accepts the pilot's host direction", () => {
    expect(() => assertDirection(DEMON_HOST_DIRECTION)).not.toThrow();
  });

  it("rejects intensity outside 0..1", () => {
    expect(() => assertDirection(neutralDirection({ intensity: 1.5 }))).toThrow(/Intensity/);
    expect(() => assertDirection(neutralDirection({ intensity: -0.1 }))).toThrow(/Intensity/);
  });

  it("rejects a non-positive pace", () => {
    expect(() => assertDirection(neutralDirection({ pace: 0 }))).toThrow(/Pace/);
  });

  it("rejects negative pauses", () => {
    expect(() => assertDirection(neutralDirection({ pauseBeforeMs: -5 }))).toThrow(/negative/);
  });

  it("rejects a pitch shift beyond an octave, catching a units mistake", () => {
    // 1200 is what someone typing "1.2 octaves" writes. Accepting it would produce a
    // chipmunk in the final render rather than an error at the call site.
    expect(() => assertDirection(neutralDirection({ pitchShift: 13 }))).toThrow(/one octave/);
    expect(() => assertDirection(neutralDirection({ pitchShift: 12 }))).not.toThrow();
  });
});

describe("planDirection — native capability", () => {
  it("applies everything natively and emulates nothing when the provider supports it all", () => {
    const direction = neutralDirection({
      emotion: "sarcastic",
      intensity: 0.8,
      pace: 0.9,
      pauseBeforeMs: 400,
      pauseAfterMs: 300,
      emphasis: ["never"],
      pitchShift: -3,
    });
    const plan = planDirection(direction, FULL_CAPABILITIES, "I would never do that.");

    expect(plan.fullyHonoured).toBe(true);
    expect(plan.unhonourable).toHaveLength(0);
    expect(plan.emulated).toHaveLength(0);

    const controls = plan.native.map((n) => n.control);
    expect(controls).toContain("emotion");
    expect(controls).toContain("intensity");
    expect(controls).toContain("pace");
    expect(controls).toContain("pauseBeforeMs");
    expect(controls).toContain("pauseAfterMs");
    expect(controls).toContain("emphasis");
    expect(controls).toContain("pitchShift");

    // Native pause support means the caller must NOT also insert silence, or the pause
    // would be applied twice.
    expect(plan.leadingSilenceMs).toBe(0);
    expect(plan.trailingSilenceMs).toBe(0);
    // Nothing needed emulation, so the script must be untouched.
    expect(plan.script).toBe("I would never do that.");
  });

  it("reports pause durations as native values with the requested milliseconds", () => {
    const plan = planDirection(
      neutralDirection({ pauseBeforeMs: 750 }),
      FULL_CAPABILITIES,
      "Line.",
    );
    const pause = plan.native.find((n) => n.control === "pauseBeforeMs");
    expect(pause?.value).toBe(750);
  });
});

describe("planDirection — emulation", () => {
  it("emulates pace via the provider's SSML rather than inventing a rate parameter", () => {
    const plan = planDirection(neutralDirection({ pace: 0.8 }), SSML_ONLY, "Slow down.");

    expect(plan.unhonourable).toHaveLength(0);
    const pace = plan.emulated.find((e) => e.control === "pace");
    expect(pace?.mechanism).toBe("ssml");
    // 0.8 becomes 80% in the prosody tag, and the artifact states it.
    expect(pace?.artifact).toContain("80%");
    // The markup must actually reach the script when the provider parses SSML.
    expect(plan.script).toContain("<prosody rate=\"80%\">");
  });

  it("emulates emphasis with punctuation when there is no markup support at all", () => {
    // A preceding ellipsis is how a dry comic lands a stress without raising volume: a
    // real technique, so this is emulation rather than a consolation prize.
    const plan = planDirection(
      neutralDirection({ emphasis: ["moist"] }),
      TEXT_ONLY_CAPABILITIES,
      "It is a moist evening.",
    );

    const emphasis = plan.emulated.find((e) => e.control === "emphasis");
    expect(emphasis?.mechanism).toBe("punctuation");
    expect(plan.script).toContain("… moist");
    // The original word must survive the rewrite, only prefixed.
    expect(plan.script).toContain("evening");
  });

  it("emulates pitch by post-processing rather than sending a parameter nobody accepts", () => {
    const plan = planDirection(neutralDirection({ pitchShift: -2 }), TEXT_ONLY_CAPABILITIES, "Low.");

    const pitch = plan.emulated.find((e) => e.control === "pitchShift");
    expect(pitch?.mechanism).toBe("post-processing");
    // The artifact states the actual ratio, so the caller can apply it precisely.
    expect(pitch?.artifact).toContain("0.8909");
    // And the caveat is honest about the duration side effect.
    expect(pitch?.caveat).toMatch(/resampl|time-stretch/i);
  });

  it("always emulates pauses by silence insertion when the provider has no pause control", () => {
    // Silence insertion needs nothing from the provider, so this must never be a refusal.
    const plan = planDirection(
      neutralDirection({ pauseBeforeMs: 500, pauseAfterMs: 250 }),
      TEXT_ONLY_CAPABILITIES,
      "Hello.",
    );

    expect(plan.leadingSilenceMs).toBe(500);
    expect(plan.trailingSilenceMs).toBe(250);
    expect(plan.unhonourable.map((u) => u.control)).not.toContain("pauseBeforeMs");
    const pause = plan.emulated.find((e) => e.control === "pauseBeforeMs");
    expect(pause?.mechanism).toBe("silence-insertion");
  });

  it("wraps the script in SSML only when the provider genuinely parses SSML", () => {
    const textOnly = planDirection(
      neutralDirection({ pitchShift: -2, emotion: "dry" }),
      TEXT_ONLY_CAPABILITIES,
      "A line.",
    );
    // No SSML support: putting tags in would get them read aloud.
    expect(textOnly.script).not.toContain("<");
    expect(textOnly.script).toBe("A line.");

    const ssml = planDirection(
      neutralDirection({ pitchShift: -2, emotion: "dry" }),
      SSML_ONLY,
      "A line.",
    );
    expect(ssml.script).toContain("<speak");
    expect(ssml.script).toContain("mstts:express-as");
  });

  it("escapes XML metacharacters so markup cannot be broken by the script", () => {
    const plan = planDirection(
      neutralDirection({ pitchShift: -2 }),
      SSML_ONLY,
      "He said <hello> & \"goodbye\" to 5 > 3.",
    );
    expect(plan.script).toContain("&lt;hello&gt;");
    expect(plan.script).toContain("&amp;");
    expect(plan.script).toContain("&quot;");
    // The raw characters must not survive into the markup.
    expect(plan.script).not.toContain("<hello>");
  });
});

describe("planDirection — refusing to fabricate", () => {
  it("reports every unsupported control when the provider supports nothing", () => {
    // THE central test of this module. Ask a plain text endpoint for a directed
    // performance and it must say what it cannot do, not return a flat read labelled as
    // directed.
    const direction = neutralDirection({
      emotion: "sarcastic",
      intensity: 0.9,
      pace: 0.85,
      emphasis: ["really"],
      pitchShift: -3,
    });
    const plan = planDirection(direction, TEXT_ONLY_CAPABILITIES, "Oh, really.");

    const refused = plan.unhonourable.map((u) => u.control);
    expect(refused).toContain("emotion");
    expect(refused).toContain("intensity");
    // Pace, emphasis and pitch are emulable, so they must NOT appear as refusals.
    expect(refused).not.toContain("pace");
    expect(refused).not.toContain("emphasis");
    expect(refused).not.toContain("pitchShift");

    expect(plan.fullyHonoured).toBe(false);
  });

  it("gives each refusal a reason and an actionable recommendation", () => {
    const plan = planDirection(
      neutralDirection({ emotion: "afraid", intensity: 0.9 }),
      TEXT_ONLY_CAPABILITIES,
      "Oh no.",
    );

    for (const refusal of plan.unhonourable) {
      expect(refusal.reason.length).toBeGreaterThan(20);
      expect(refusal.recommendation.length).toBeGreaterThan(20);
    }
    const emotion = plan.unhonourable.find((u) => u.control === "emotion");
    expect(emotion?.requested).toBe("afraid");
    expect(emotion?.recommendation).toMatch(/voice|punctuation/i);
  });

  it("does not report controls the caller never asked for", () => {
    // A neutral direction requests nothing, so reporting pitch and emphasis as
    // unhonourable would be noise that trains a creator to ignore real warnings.
    const plan = planDirection(NEUTRAL_DIRECTION, TEXT_ONLY_CAPABILITIES, "Plain line.");
    expect(plan.unhonourable).toHaveLength(0);
    expect(plan.native).toHaveLength(0);
    expect(plan.emulated).toHaveLength(0);
    expect(plan.fullyHonoured).toBe(true);
    expect(plan.summary).toMatch(/No direction controls requested/);
  });

  it("never claims a control is native when the provider cannot do it", () => {
    // The anti-fabrication invariant, checked across every control and both provider
    // shapes: a native entry for a control requires the matching capability flag.
    const direction: VoiceDirection = {
      emotion: "sarcastic",
      intensity: 0.9,
      pace: 0.8,
      pauseBeforeMs: 300,
      pauseAfterMs: 300,
      emphasis: ["word"],
      pitchShift: -4,
    };

    for (const caps of [TEXT_ONLY_CAPABILITIES, SSML_ONLY]) {
      const plan = planDirection(direction, caps, "A word here.");
      for (const native of plan.native) {
        if (native.control === "emotion") expect(caps.supportsEmotion).toBe(true);
        if (native.control === "intensity") expect(caps.supportsIntensity).toBe(true);
        if (native.control === "pace") expect(caps.supportsRate).toBe(true);
        if (native.control === "emphasis") expect(caps.supportsEmphasis).toBe(true);
        if (native.control === "pitchShift") expect(caps.supportsPitch).toBe(true);
        if (native.control === "pauseBeforeMs" || native.control === "pauseAfterMs") {
          expect(caps.supportsPause).toBe(true);
        }
      }
      // Every requested control must be accounted for somewhere in the plan. This is the
      // anti-silent-drop invariant: nothing a caller asked for may simply vanish.
      const accounted = new Set([
        ...plan.native.map((n) => n.control),
        ...plan.emulated.map((e) => e.control),
        ...plan.unhonourable.map((u) => u.control),
      ]);
      for (const control of [
        "emotion",
        "intensity",
        "pace",
        "pauseBeforeMs",
        "pauseAfterMs",
        "emphasis",
        "pitchShift",
      ] as const) {
        expect(accounted.has(control)).toBe(true);
      }
      // And nothing may be reported twice: a control is native, emulated or refused,
      // never two of those at once.
      expect(plan.native.length + plan.emulated.length + plan.unhonourable.length).toBe(
        accounted.size,
      );
    }
  });

  it("produces a summary that names what was applied, emulated and refused", () => {
    const plan = planDirection(
      neutralDirection({ emotion: "warm", pace: 0.9 }),
      TEXT_ONLY_CAPABILITIES,
      "Hello there.",
    );
    expect(plan.summary).toMatch(/Emulated via post-processing: pace/);
    expect(plan.summary).toMatch(/NOT HONOURED: emotion/);
  });
});

describe("planDirection against the mock provider's real capabilities", () => {
  it("reports the mock as unable to do emotion but able to do pauses", () => {
    // The mock declares only pause and nonverbal support. So a directed host line must
    // come back with emotion and intensity refused, and the pauses handled natively —
    // which is exactly the honest picture of what this adapter does.
    const plan = planDirection(
      DEMON_HOST_DIRECTION,
      MOCK_VOICE_CAPABILITIES,
      "Well. That went badly.",
    );

    const refused = plan.unhonourable.map((u) => u.control);
    expect(refused).toContain("emotion");
    expect(refused).toContain("intensity");

    // Pitch, by contrast, is EMULATED rather than refused: varispeed post-processing is
    // always available, so there is no honest reason to report it as impossible.
    expect(refused).not.toContain("pitchShift");
    const pitch = plan.emulated.find((e) => e.control === "pitchShift");
    expect(pitch?.mechanism).toBe("post-processing");

    // Pauses ARE supported natively by the mock.
    const nativeControls = plan.native.map((n) => n.control);
    expect(nativeControls).toContain("pauseBeforeMs");
    expect(nativeControls).toContain("pauseAfterMs");
    // Since they are native, the caller must not insert them again.
    expect(plan.leadingSilenceMs).toBe(0);
    expect(plan.trailingSilenceMs).toBe(0);
    expect(plan.fullyHonoured).toBe(false);
  });
});

describe("estimateBaseDurationMs", () => {
  it("returns zero for empty or whitespace text", () => {
    expect(estimateBaseDurationMs("")).toBe(0);
    expect(estimateBaseDurationMs("   ")).toBe(0);
  });

  it("grows with word count", () => {
    const short = estimateBaseDurationMs("Hello.");
    const long = estimateBaseDurationMs("Hello there, my old friend, how have you been.");
    expect(long).toBeGreaterThan(short);
  });

  it("adds time for punctuation, which is where a read actually slows down", () => {
    const flat = estimateBaseDurationMs("one two three four five");
    const punctuated = estimateBaseDurationMs("one, two, three, four, five.");
    expect(punctuated).toBeGreaterThan(flat);
  });

  it("treats an ellipsis as an extra beat beyond the sentence end", () => {
    const fullStop = estimateBaseDurationMs("Well that happened.");
    const ellipsis = estimateBaseDurationMs("Well that happened…");
    expect(ellipsis).toBeGreaterThan(fullStop);
  });

  it("is documented as an estimate, and produces a plausible order of magnitude", () => {
    // Guarding the honesty claim: the function's own docs say the true duration must be
    // measured from returned audio, so this only asserts plausibility, not precision.
    //
    // The bound is derived rather than guessed. The sentence is 18 words; a 165 wpm
    // baseline is 60000/165 = 363.6 ms per word, so the floor is 18 * 363.6 = 6545 ms
    // before word-length and punctuation adjustments. The function returned 6327 ms,
    // which is slightly BELOW the flat baseline because short words ("I", "in", "for",
    // "me", "a") carry a length factor under 1.0. So the correct range brackets that
    // baseline, and a tighter upper bound would be asserting something false.
    const text =
      "I have been waiting in this basement for one thousand years and nobody has offered me a biscuit";
    const words = text.split(/\s+/).filter((w) => w.length > 0).length;
    expect(words).toBe(18);

    const flatBaselineMs = words * (60_000 / 165);
    const duration = estimateBaseDurationMs(text);

    expect(duration).toBeGreaterThan(flatBaselineMs * 0.9);
    expect(duration).toBeLessThan(flatBaselineMs * 1.2);
  });
});