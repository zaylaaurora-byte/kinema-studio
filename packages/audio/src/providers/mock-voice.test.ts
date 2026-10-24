import { describe, expect, it } from "vitest";

import { decodeWav } from "../wav.js";
import { measureSignal } from "../dsp.js";
import {
  DEMON_HOST_DIRECTION,
  neutralDirection,
  planDirection,
  TEXT_ONLY_CAPABILITIES,
} from "../performance.js";
import { MOCK_VOICE_CAPABILITIES, MockVoiceAdapter, voiceAssetId } from "./mock-voice.js";

/**
 * Mock voice adapter tests.
 *
 * Two things are being verified here, and the distinction matters:
 *
 * 1. DETERMINISM AND DISTINCTNESS — the same line produces identical bytes, different
 *    lines produce different bytes. This is what makes the mock usable as a test fixture.
 *
 * 2. TIMING DIRECTION IS GENUINELY HONOURED — measured from returned sample counts, not
 *    from a claim in a plan object. A direction model that reports a pause but produces
 *    audio without one would pass every structural test and fail the creator.
 *
 * Note what is deliberately NOT asserted: that the output sounds like speech. It does not,
 * and `mock-voice.ts` says so at length. Asserting a "speech-likeness" property would be
 * inventing a metric to flatter a placeholder.
 */

const adapter = new MockVoiceAdapter({ sampleRate: 24000, channels: 1, bitDepth: 32 });

/** Sample count of a rendered WAV, as the file actually encodes it. */
function framesPerChannel(wav: Buffer): number {
  const decoded = decodeWav(wav);
  return decoded.samples.length / decoded.channels;
}

function secondsOf(wav: Buffer): number {
  const decoded = decodeWav(wav);
  return decoded.samples.length / decoded.channels / decoded.sampleRate;
}

describe("MockVoiceAdapter — contract", () => {
  it("declares itself as a mock that needs no network", async () => {
    const caps = await adapter.discoverCapabilities();
    expect(caps.kind).toBe("mock");
    expect(caps.isMock).toBe(true);
    expect(caps.requiresNetwork).toBe(false);
  });

  it("validates with no credentials, so the app runs from an empty .env", async () => {
    await expect(adapter.validateCredentials({})).resolves.toEqual({ ok: true });
  });

  it("reports zero cost reliably", async () => {
    const estimate = await adapter.estimateCost();
    expect(estimate.amount).toBe(0);
    expect(estimate.reliable).toBe(true);
  });

  it("warns prominently that it is not real speech", async () => {
    // The honesty requirement, enforced as a test: the warning must be present and
    // explicit, because this output must never be presented as a voice performance.
    const models = await adapter.listModels();
    const model = models[0]!;
    expect(model.warnings?.join(" ")).toMatch(/NOT REAL SPEECH/i);
    expect(model.displayName).toMatch(/NOT real speech/i);
    expect(model.outputs).toContain("audio");
    expect(model.outputMimeTypes).toContain("audio/wav");
  });

  it("declares its direction capabilities honestly", () => {
    const caps = adapter.capabilitiesForDirection();
    // It genuinely renders silence and non-verbal sounds.
    expect(caps.supportsPause).toBe(true);
    expect(caps.supportsNonverbal).toBe(true);
    // It genuinely does NOT have emotion, rate, pitch, emphasis or SSML inputs.
    expect(caps.supportsEmotion).toBe(false);
    expect(caps.supportsIntensity).toBe(false);
    expect(caps.supportsRate).toBe(false);
    expect(caps.supportsEmphasis).toBe(false);
    expect(caps.supportsPitch).toBe(false);
    expect(caps.supportsSsml).toBe(false);
  });

  it("rejects an empty line rather than producing silence", () => {
    const result = adapter.validateRequest(
      { modelId: "mock-voice-v1", prompt: "  " },
      {
        id: "mock-voice-v1",
        displayName: "m",
        providerId: "mock-voice",
        inputs: ["text"],
        outputs: ["audio"],
        limits: { maxPromptChars: 5000, maxBatchSize: 1 },
        capabilities: {
          supportsStreaming: false,
          supportsToolCalls: false,
          supportsReferenceImage: false,
          supportsSeed: true,
          supportsNegativePrompt: false,
          supportsInpainting: false,
          supportsTransparentBackground: false,
          supportsConversationalEdit: false,
          supportsCancellation: true,
          supportsQualityControl: false,
        },
        pricing: { basis: "free" },
        outputMimeTypes: ["audio/wav"],
      },
    );
    expect(result.valid).toBe(false);
    expect(result.problems.join(" ")).toMatch(/line of dialogue is required/i);
  });
});

describe("MockVoiceAdapter — real audio output", () => {
  it("produces a real, decodable WAV with a plausible header", async () => {
    const speech = await adapter.speak("Well. That went badly.");

    const decoded = decodeWav(speech.wav);
    expect(decoded.channels).toBe(1);
    expect(decoded.sampleRate).toBe(24000);
    expect(decoded.bitDepth).toBe(32);
    expect(speech.wav.toString("ascii", 0, 4)).toBe("RIFF");
    expect(speech.wav.toString("ascii", 8, 12)).toBe("WAVE");
    expect(speech.wav.toString("ascii", 12, 16)).toBe("fmt ");
  });

  it("is NOT silence", async () => {
    // The most basic failure mode for a placeholder: emitting an empty buffer that
    // downstream mixing happily accepts.
    const speech = await adapter.speak("I have been waiting a very long time.");
    const decoded = decodeWav(speech.wav);
    const measured = measureSignal(decoded.samples, decoded.sampleRate, decoded.channels);

    expect(measured.rms).toBeGreaterThan(0.01);
    expect(measured.peak).toBeGreaterThan(0.1);
    expect(measured.durationSeconds).toBeGreaterThan(0.5);
  });

  it("is NOT random noise: it has a tonal centre", async () => {
    // Noise crosses zero constantly; a pitched, formant-filtered tone does not. A
    // zero-crossing rate near the low hundreds per second is consistent with a voice-like
    // fundamental, whereas broadband noise at this level would be in the thousands.
    const speech = await adapter.speak("A line with a definite pitch to it.");
    const decoded = decodeWav(speech.wav);
    const measured = measureSignal(decoded.samples, decoded.sampleRate, decoded.channels);

    expect(measured.zeroCrossingRate).toBeLessThan(1500);
    // And it must carry real energy in the speech band rather than being a DC offset.
    expect(measured.rmsDb).toBeGreaterThan(-30);
  });

  it("is deterministic: the same text gives byte-identical output", async () => {
    const a = await adapter.speak("Same line, same result.", DEMON_HOST_DIRECTION);
    const b = await adapter.speak("Same line, same result.", DEMON_HOST_DIRECTION);
    expect(a.wav.equals(b.wav)).toBe(true);
  });

  it("is deterministic across adapter instances", async () => {
    // Guards against any hidden ambient state (a clock, a counter) leaking into synthesis.
    const other = new MockVoiceAdapter({ sampleRate: 24000, channels: 1, bitDepth: 32 });
    const a = await adapter.speak("Stable across instances.");
    const b = await other.speak("Stable across instances.");
    expect(a.wav.equals(b.wav)).toBe(true);
  });

  it("produces different bytes for different text", async () => {
    const a = await adapter.speak("The first line of dialogue.");
    const b = await adapter.speak("A completely different line.");
    expect(a.wav.equals(b.wav)).toBe(false);
  });

  it("produces different bytes for the same text at different pitches", async () => {
    // The fundamental is derived from the text hash, so a pitch shift must move it.
    const low = await adapter.speak("Test.", neutralDirection({ pitchShift: -4 }));
    const high = await adapter.speak("Test.", neutralDirection({ pitchShift: 4 }));
    expect(low.wav.equals(high.wav)).toBe(false);
  });

  it("gives a longer line more audio than a shorter one", async () => {
    const short = await adapter.speak("Hi.");
    const long = await adapter.speak(
      "I have been waiting in this basement for a very long time indeed.",
    );
    expect(secondsOf(long.wav)).toBeGreaterThan(secondsOf(short.wav));
  });

  it("keeps a single line within full scale, so mixing starts from sane levels", async () => {
    const speech = await adapter.speak("Loud enough but not clipped.");
    const decoded = decodeWav(speech.wav);
    const measured = measureSignal(decoded.samples, decoded.sampleRate, decoded.channels);
    expect(measured.peak).toBeLessThanOrEqual(1);
    expect(measured.peak).toBeGreaterThan(0.5);
  });

  it("analyses the encoded file, not the in-memory buffer", async () => {
    const speech = await adapter.speak("Measure the file.");
    const measured = adapter.analyse(speech.wav);
    expect(measured.durationSeconds).toBeCloseTo(speech.durationSeconds, 6);
    expect(measured.rms).toBeGreaterThan(0);
  });
});

describe("MockVoiceAdapter — timing direction is honoured", () => {
  /**
   * These are the tests the brief asks for specifically: the timing must be measurable in
   * the returned sample count, not merely asserted in a plan object.
   */

  it("inserts a real pause of the correct duration before the line", async () => {
    const without = await adapter.speak("Hello there.", neutralDirection({ pauseBeforeMs: 0 }));
    const withPause = await adapter.speak("Hello there.", neutralDirection({ pauseBeforeMs: 500 }));

    const deltaSeconds = secondsOf(withPause.wav) - secondsOf(without.wav);
    // 500 ms requested; allow one sample of rounding at each end.
    expect(deltaSeconds).toBeGreaterThan(0.499);
    expect(deltaSeconds).toBeLessThan(0.501);
  });

  it("inserts a real pause after the line", async () => {
    const without = await adapter.speak("Hello there.", neutralDirection({ pauseAfterMs: 0 }));
    const withPause = await adapter.speak("Hello there.", neutralDirection({ pauseAfterMs: 750 }));

    const deltaSeconds = secondsOf(withPause.wav) - secondsOf(without.wav);
    expect(deltaSeconds).toBeGreaterThan(0.749);
    expect(deltaSeconds).toBeLessThan(0.751);
  });

  it("sums leading and trailing pauses independently", async () => {
    const bare = await adapter.speak("Line.", neutralDirection({}));
    const padded = await adapter.speak(
      "Line.",
      neutralDirection({ pauseBeforeMs: 300, pauseAfterMs: 400 }),
    );
    const deltaSeconds = secondsOf(padded.wav) - secondsOf(bare.wav);
    expect(deltaSeconds).toBeGreaterThan(0.699);
    expect(deltaSeconds).toBeLessThan(0.701);
  });

  it("actually puts the silence at the START, not just anywhere", async () => {
    // Length alone would be satisfied by padding at the wrong end. This checks the
    // silence is where the direction said it should be.
    const padded = await adapter.speak("Hello there.", neutralDirection({ pauseBeforeMs: 500 }));
    const decoded = decodeWav(padded.wav);
    const { samples, sampleRate, channels } = decoded;

    const leadingFrames = Math.round(0.4 * sampleRate) * channels;
    let leadingEnergy = 0;
    for (let i = 0; i < leadingFrames; i++) leadingEnergy += Math.abs(samples[i]!);
    expect(leadingEnergy).toBe(0); // digital silence

    // And there IS audio immediately after the pause.
    const afterFrames = Math.round((0.45 + 0.1) * sampleRate) * channels;
    let laterEnergy = 0;
    for (let i = leadingFrames; i < Math.min(afterFrames, samples.length); i++) {
      laterEnergy += Math.abs(samples[i]!);
    }
    expect(laterEnergy).toBeGreaterThan(0);
  });

  it("puts trailing silence at the END", async () => {
    const padded = await adapter.speak("Hello there.", neutralDirection({ pauseAfterMs: 600 }));
    const decoded = decodeWav(padded.wav);
    const { samples, sampleRate, channels } = decoded;

    const tailFrames = Math.round(0.5 * sampleRate) * channels;
    let tailEnergy = 0;
    for (let i = samples.length - tailFrames; i < samples.length; i++) tailEnergy += Math.abs(samples[i]!);
    expect(tailEnergy).toBe(0);
  });

  it("changes the synthesised duration when pace changes", async () => {
    // The brief's requirement: pace must ACTUALLY change the rendered length, measured
    // from the samples rather than trusted from the plan.
    const slow = await adapter.speak("This is a line of moderate length.", neutralDirection({ pace: 0.7 }));
    const normal = await adapter.speak("This is a line of moderate length.", neutralDirection({ pace: 1 }));
    const fast = await adapter.speak("This is a line of moderate length.", neutralDirection({ pace: 1.4 }));

    const slowSeconds = secondsOf(slow.wav);
    const normalSeconds = secondsOf(normal.wav);
    const fastSeconds = secondsOf(fast.wav);

    expect(slowSeconds).toBeGreaterThan(normalSeconds);
    expect(normalSeconds).toBeGreaterThan(fastSeconds);
    // And the effect must be substantial, not a rounding artefact.
    expect(slowSeconds / fastSeconds).toBeGreaterThan(1.5);
  });

  it("scales the spoken body by pace while keeping the pause absolute", async () => {
    // The modelling decision from performance.ts, verified on real audio: slowing the
    // read stretches the words, not the dramatic beat.
    const fast = await adapter.speak(
      "A line.",
      neutralDirection({ pace: 1.4, pauseBeforeMs: 500 }),
    );
    const slow = await adapter.speak(
      "A line.",
      neutralDirection({ pace: 0.7, pauseBeforeMs: 500 }),
    );

    // Both carry exactly 500 ms of leading silence.
    for (const speech of [fast, slow]) {
      const decoded = decodeWav(speech.wav);
      const pauseFrames = Math.round(0.45 * decoded.sampleRate) * decoded.channels;
      let energy = 0;
      for (let i = 0; i < pauseFrames; i++) energy += Math.abs(decoded.samples[i]!);
      expect(energy).toBe(0);
    }

    // The speech portion differs, so the totals differ by less than the full ratio would
    // suggest if the pause had been scaled too.
    const fastSpeech = secondsOf(fast.wav) - 0.5;
    const slowSpeech = secondsOf(slow.wav) - 0.5;
    expect(slowSpeech).toBeGreaterThan(fastSpeech);
    expect(slowSpeech / fastSpeech).toBeGreaterThan(1.5);
  });

  it("honours a direction with no text as a pure pause", async () => {
    // A beat of silence is a legitimate request in an edit, and it must not throw.
    const speech = await adapter.speak("", neutralDirection({ pauseBeforeMs: 200, pauseAfterMs: 300 }));
    expect(secondsOf(speech.wav)).toBeCloseTo(0.5, 3);
    const decoded = decodeWav(speech.wav);
    expect(Array.from(decoded.samples).every((v) => v === 0)).toBe(true);
  });

  it("reports the true duration it produced, not the estimate it started from", async () => {
    const speech = await adapter.speak("A line of dialogue, with a comma.");
    // durationSeconds must match the encoded file exactly.
    expect(speech.durationSeconds).toBeCloseTo(secondsOf(speech.wav), 6);
    // And the speech-only figure must be less than the total when pauses are present.
    const padded = await adapter.speak("A line.", neutralDirection({ pauseBeforeMs: 400 }));
    expect(padded.speechSeconds).toBeLessThan(padded.durationSeconds);
  });
});

describe("MockVoiceAdapter — direction negotiation is wired in", () => {
  it("returns the negotiation plan alongside the audio", async () => {
    const speech = await adapter.speak("Well. That went badly.", DEMON_HOST_DIRECTION);

    // The plan must reflect the mock's real capabilities, so emotion is refused.
    expect(speech.plan.fullyHonoured).toBe(false);
    const refused = speech.plan.unhonourable.map((u) => u.control);
    expect(refused).toContain("emotion");
    // Pauses are native here, so we must not have inserted them twice.
    expect(speech.plan.leadingSilenceMs).toBe(0);
  });

  it("agrees with planDirection called directly", async () => {
    const direction = neutralDirection({ pace: 0.9, pauseBeforeMs: 200 });
    const speech = await adapter.speak("Consistent.", direction);
    const direct = planDirection(direction, MOCK_VOICE_CAPABILITIES, "Consistent.");
    expect(speech.plan.summary).toBe(direct.summary);
  });

  it("does not silently claim to apply emotion it cannot", async () => {
    // The demonstration case from the brief: a text-only provider asked for a directed
    // read must SAY it cannot do it.
    const plan = planDirection(
      neutralDirection({ emotion: "sarcastic", intensity: 0.8, pitchShift: -3 }),
      TEXT_ONLY_CAPABILITIES,
      "Oh, wonderful.",
    );
    expect(plan.fullyHonoured).toBe(false);
    expect(plan.unhonourable.map((u) => u.control)).toContain("emotion");
    expect(plan.summary).toMatch(/NOT HONOURED/);
  });

  it("records the honesty flag in provenance", async () => {
    const result = await adapter.submitJobAndResolve({
      modelId: "mock-voice-v1",
      prompt: "Provenance check.",
    });
    expect(result.status).toBe("succeeded");
    expect(result.outputs[0]!.mimeType).toBe("audio/wav");
    expect(result.provenance.parameters?.["synthesisIsRealSpeech"]).toBe(false);
  });

  it("carries a direction through providerOptions on the shared contract", async () => {
    const result = await adapter.submitJobAndResolve({
      modelId: "mock-voice-v1",
      prompt: "Directed via options.",
      providerOptions: { direction: neutralDirection({ pauseBeforeMs: 500 }) },
    });
    const output = result.outputs[0]!;
    // The 500 ms pause must be present in the returned file.
    expect(output.durationSeconds).toBeGreaterThan(0.5);
    const parameters = result.provenance.parameters as Record<string, unknown>;
    expect(parameters["directionPlan"]).toBeDefined();
  });

  it("produces a stable asset id per text and direction pair", () => {
    const a = voiceAssetId("Line.", DEMON_HOST_DIRECTION);
    const b = voiceAssetId("Line.", DEMON_HOST_DIRECTION);
    const c = voiceAssetId("Line.", neutralDirection({ pace: 1.2 }));
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(a).toHaveLength(16);
  });

  it("refuses a batch request rather than quietly returning one take", async () => {
    const models = await adapter.listModels();
    const validation = adapter.validateRequest(
      { modelId: "mock-voice-v1", prompt: "Take.", count: 3 },
      models[0]!,
    );
    expect(validation.valid).toBe(false);
    expect(validation.unsupportedFields).toContain("count");
  });
});

describe("MockVoiceAdapter — sample rates and channel layouts", () => {
  it("honours the configured sample rate in the file header", async () => {
    const at48 = new MockVoiceAdapter({ sampleRate: 48000, channels: 1, bitDepth: 16 });
    const speech = await at48.speak("Rate check.");
    const decoded = decodeWav(speech.wav);
    expect(decoded.sampleRate).toBe(48000);
    expect(decoded.bitDepth).toBe(16);
  });

  it("produces stereo when asked, with identical channels for a mono line", async () => {
    const stereo = new MockVoiceAdapter({ sampleRate: 24000, channels: 2, bitDepth: 32 });
    const speech = await stereo.speak("Stereo check.");
    const decoded = decodeWav(speech.wav);
    expect(decoded.channels).toBe(2);
    // A voice line is centred, so both channels should carry the same signal.
    for (let f = 0; f < 50; f++) {
      expect(decoded.samples[f * 2]).toBeCloseTo(decoded.samples[f * 2 + 1]!, 6);
    }
  });

  it("produces the same audio content at different sample rates, at different lengths", async () => {
    const at24 = new MockVoiceAdapter({ sampleRate: 24000, channels: 1, bitDepth: 32 });
    const at48 = new MockVoiceAdapter({ sampleRate: 48000, channels: 1, bitDepth: 32 });
    const a = await at24.speak("Same words.");
    const b = await at48.speak("Same words.");

    // Duration should agree closely; sample count should double.
    expect(secondsOf(a.wav)).toBeCloseTo(secondsOf(b.wav), 2);
    expect(framesPerChannel(b.wav)).toBeGreaterThan(framesPerChannel(a.wav) * 1.8);
  });
});