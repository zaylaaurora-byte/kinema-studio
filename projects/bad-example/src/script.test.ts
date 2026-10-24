/**
 * Tests for the Bad Example pilot production data.
 *
 * These are not smoke tests. Each one enforces something the reference pack lists
 * as an acceptance criterion or a named failure mode, and each is written so that
 * breaking the underlying invariant makes it fail for the right reason.
 *
 * Map of test -> criterion:
 *   runtime 80-90s            brief p.11 "approximately 60-90 seconds"
 *   contiguous scenes         a gap or overlap is a dead frame on the export
 *   unique ids                a duplicate id silently corrupts the timeline join
 *   no human spoken words     brief: "Contestant remains speechless"  <- hardest
 *   no human text field       the same rule, enforced structurally
 *   3+ human expressions      pack: "At least 3 visibly different human expressions"
 *   3+ host acting states     pack: "and 3 distinct host acting states"
 *   timeline total == scenes  product spec: a projection stores no duration
 *   dialogue integrity        every line has a valid speaker and non-empty content
 */

import { describe, expect, it } from "vitest";

import {
  CHALLENGE_SECONDS,
  CHALLENGE_START_SECONDS,
  SCENES,
  TIMER_READINGS,
  allDialogue,
  challengeSecondsRemaining,
  computeTotalDuration,
  findContiguityBreak,
  formatTimer,
  hostLines,
  nonverbalLines,
  sceneEndSeconds,
} from "../src/script.js";
import type { DialogueLine, Scene } from "../src/script.js";

import {
  SCENE_PLANS,
  findPlanMismatches,
  usedHostExpressions,
  usedHumanExpressions,
} from "../src/scene-plan.js";

import {
  PILOT_TIMELINE,
  buildTimeline,
  clipEndSeconds,
  clipStartSeconds,
  clipsForScene,
  computeTotalDuration as timelineTotalDuration,
  findTimelineProblems,
  sceneSpans,
} from "../src/timeline.js";

// ---------------------------------------------------------------------------
// Runtime and structure
// ---------------------------------------------------------------------------

describe("pilot runtime and scene structure", () => {
  it("runs between 80 and 90 seconds", () => {
    const total = computeTotalDuration(SCENES);

    // The brief asks for a test edit of "approximately 60-90 seconds" with a
    // 60-second challenge inside it, and names ~85 s as the production target.
    expect(total).toBeGreaterThanOrEqual(80);
    expect(total).toBeLessThanOrEqual(90);
    expect(total).toBe(85);

    // And the challenge itself is a 60-second event, from the brief verbatim.
    expect(CHALLENGE_SECONDS).toBe(60);
  });

  it("has eight scenes, one per brief shot-list row", () => {
    expect(SCENES).toHaveLength(8);
    expect(SCENES.map((scene) => scene.order)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });

  it("is contiguous: every scene starts exactly where the previous one ended", () => {
    // A gap here is dead air on the export; an overlap is a dropped shot. Both are
    // silent failures, so they are checked rather than assumed.
    expect(findContiguityBreak(SCENES)).toBeUndefined();

    const ordered = [...SCENES].sort((a, b) => a.order - b.order);
    expect(ordered[0]?.startSeconds).toBe(0);

    for (let i = 1; i < ordered.length; i++) {
      const previous = ordered[i - 1]!;
      const current = ordered[i]!;
      expect(current.startSeconds).toBe(sceneEndSeconds(previous));
    }

    const last = ordered[ordered.length - 1]!;
    expect(sceneEndSeconds(last)).toBe(computeTotalDuration(SCENES));
  });

  it("matches the brief's per-scene shot-list boundaries exactly", () => {
    // Transcribed from BRIEF.md p.11. Timings come from the written brief, not the
    // storyboard, per the reconciliation recorded in script.ts (R1).
    const expected = [
      { title: "Studio Intro", startSeconds: 0, durationSeconds: 8 },
      { title: "The Challenge", startSeconds: 8, durationSeconds: 8 },
      { title: "Gear And Send-Off", startSeconds: 16, durationSeconds: 9 },
      { title: "Arrival", startSeconds: 25, durationSeconds: 10 },
      { title: "Reveal", startSeconds: 35, durationSeconds: 10 },
      { title: "Bad Decision", startSeconds: 45, durationSeconds: 13 },
      { title: "Chase And Near Miss", startSeconds: 58, durationSeconds: 14 },
      { title: "Result And Callback", startSeconds: 72, durationSeconds: 13 },
    ];

    const actual = [...SCENES]
      .sort((a, b) => a.order - b.order)
      .map((scene) => ({
        title: scene.title,
        startSeconds: scene.startSeconds,
        durationSeconds: scene.durationSeconds,
      }));

    expect(actual).toEqual(expected);
  });

  it("has unique scene ids", () => {
    const ids = SCENES.map((scene) => scene.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("has non-empty titles and synopses with camera and sfx notes on every scene", () => {
    for (const scene of SCENES) {
      expect(scene.id.length).toBeGreaterThan(0);
      expect(scene.title.trim().length).toBeGreaterThan(0);
      expect(scene.synopsis.trim().length).toBeGreaterThan(40);
      expect(scene.camera.trim().length).toBeGreaterThan(40);
      expect(scene.sfx.trim().length).toBeGreaterThan(40);
      expect(scene.durationSeconds).toBeGreaterThan(0);
    }
  });

  it("handles an empty scene list and a deliberately broken one", () => {
    // The contiguity helper must be usable by the editor on in-progress data, so it
    // has to return a useful answer rather than throw.
    expect(computeTotalDuration([])).toBe(0);
    expect(findContiguityBreak([])).toBeUndefined();

    const gapped: Scene[] = [
      { ...SCENES[0]!, startSeconds: 0, durationSeconds: 8 },
      { ...SCENES[1]!, startSeconds: 12, durationSeconds: 8 },
    ];
    expect(findContiguityBreak(gapped)).toBe(SCENES[1]!.id);
  });
});

// ---------------------------------------------------------------------------
// The silence constraint
// ---------------------------------------------------------------------------

describe("the human never speaks", () => {
  it("gives every human line kind 'nonverbal'", () => {
    const humanLines = allDialogue(SCENES).filter((line) => line.speaker === "human");

    // He has plenty to do in this episode — this asserts the positive case too, so
    // the test cannot pass vacuously by there being no human lines at all.
    expect(humanLines.length).toBeGreaterThanOrEqual(8);

    for (const line of humanLines) {
      expect(line.kind).toBe("nonverbal");
      expect(line.speaker).toBe("human");
    }
  });

  it("has no human line carrying a text field, at runtime or in the type", () => {
    for (const line of nonverbalLines(SCENES)) {
      // A `text` property on a human line would mean someone had widened the type.
      // The brief warns that storyboard art "may inaccurately imply spoken
      // dialogue"; this is the guard that art cannot leak into the data.
      expect(Object.prototype.hasOwnProperty.call(line, "text")).toBe(false);
      expect(Object.keys(line).sort()).toEqual(["kind", "sound", "speaker"]);
    }
  });

  it("never puts a word-shaped string in a human sound cue", () => {
    // A nonverbal sound is a description for the SFX editor. If one of these ever
    // becomes quoted dialogue the character has started talking.
    for (const line of nonverbalLines(SCENES)) {
      expect(line.sound.trim().length).toBeGreaterThan(0);
      // No quoted speech, in straight or curly quotes.
      expect(line.sound).not.toMatch(/["\u201C\u201D]/);
      // No script-style speaker prefix, which is how a line gets attributed to
      // someone. A bare "Enthusiastic wave:" label is a description; "HUMAN:" is
      // dialogue, so the check is against an all-caps name or the character's own.
      expect(line.sound).not.toMatch(/^(HUMAN|CONTESTANT|HOST)\s*:/i);
      expect(line.sound).not.toMatch(/^[A-Z]{2,}\s*:/);
    }
  });

  it("keeps spoken words out of every human beat by type construction", () => {
    // Compile-time proof, not a runtime assertion. These assignments MUST be
    // rejected; `@ts-expect-error` turns each rejection into a passing line and
    // fails the build the moment the constraint stops holding.
    const withText: DialogueLine = {
      speaker: "human",
      kind: "nonverbal",
      sound: "gasp",
      // @ts-expect-error - NonverbalLine has no `text`; a human cannot carry words.
      text: "Hello!",
    };
    expect(withText.speaker).toBe("human");

    const wrongKind: DialogueLine = {
      speaker: "human",
      // @ts-expect-error - the human has exactly one kind, and it is "nonverbal".
      kind: "spoken",
      sound: "gasp",
    };
    // Narrowed deliberately: the point is that the value is still a human line.
    expect(wrongKind.speaker).toBe("human");

    // @ts-expect-error - HostLine requires `text` and `direction`; the host cannot
    // be reduced to a sound cue, because the show needs her words.
    const wordlessHost: DialogueLine = { speaker: "host" };

    // @ts-expect-error - and the host cannot borrow the human's nonverbal shape.
    const nonverbalHost: DialogueLine = { speaker: "host", kind: "nonverbal", sound: "hm" };

    expect(wordlessHost).toBeDefined();
    expect(nonverbalHost).toBeDefined();
  });

  it("gives the host every spoken line in the pilot", () => {
    const spoken = allDialogue(SCENES).filter(
      (line) => line.speaker === "host" && line.text.trim().length > 0,
    );
    expect(spoken.length).toBeGreaterThanOrEqual(20);

    // Every host line is genuinely spoken; every human line genuinely is not.
    expect(hostLines(SCENES).every((line) => line.direction.delivery !== undefined)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Cast coverage — the pack's stated minimum
// ---------------------------------------------------------------------------

describe("expression and acting-state coverage", () => {
  it("has at least 3 distinct human expressions, and in fact many more", () => {
    const expressions = usedHumanExpressions(SCENE_PLANS);

    expect(expressions.length).toBeGreaterThanOrEqual(3);

    // The exact count matters as a regression guard: if someone trims a beat and
    // this number drops, the pilot has quietly lost an acting state.
    expect(expressions).toEqual([
      "CONFUSED",
      "CURIOUS",
      "DETERMINED",
      "EXCITED",
      "HAPPY",
      "LAUGHING",
      "PANIC",
      "PROUD",
      "SCARED",
      "SHOCKED",
      "SILLY",
      "TIRED",
      "WORRIED",
    ]);

    // The brief's scene 05 requires the danger to land as a facial change, so these
    // two specifically must both appear.
    expect(expressions).toContain("SHOCKED");
    expect(expressions).toContain("CURIOUS");
    // And the closer is the dead-inside reaction from the closing keyframe.
    expect(expressions).toContain("TIRED");
  });

  it("has at least 3 distinct host acting states, and in fact many more", () => {
    const states = usedHostExpressions(SCENE_PLANS);

    expect(states.length).toBeGreaterThanOrEqual(3);
    expect(states.length).toBe(11);

    // CAST.md nominates these three as the pilot's comedy beats.
    expect(states).toContain("sarcastic");
    expect(states).toContain("bored");
    expect(states).toContain("maniacal");
  });

  it("only uses expression and pose names that exist on the reference sheets", () => {
    // Partial proof of the closed vocabulary: the runtime values must be members of
    // the sheet-derived unions. Combined with the union types themselves, a typo is
    // a compile error rather than art drift discovered in review.
    const sheetExpressions = [
      "DEFAULT", "HAPPY", "EXCITED", "LAUGHING", "SILLY", "CURIOUS", "CONFUSED",
      "SUSPICIOUS", "WORRIED", "SCARED", "PANIC", "SHOCKED", "DETERMINED", "ANGRY",
      "DISAPPOINTED", "TIRED", "SAD", "HURT", "PROUD", "CREEPED OUT",
    ];
    const sheetPoses = [
      "NEUTRAL", "WAVE", "THUMBS UP", "POINT", "ARMS UP", "HANDS ON HIPS",
      "LEAN FORWARD", "LEAN BACK", "SNEAK", "TIPTOE", "HIDE", "COWER", "CONFUSE",
      "SHRUG", "ON ALERT", "DEFENSIVE", "EXPLAINING", "BEGGING", "VICTORY",
    ];
    const sheetActions = [
      "RUN", "TRIP-FALL", "JUMP", "CLIMB", "PUSH", "PULL", "HOLD STICK", "THROW",
      "DUCK", "LIE DOWN", "PEEK", "HIDE BEHIND", "GET ATTACKED", "PANIC RUN",
    ];
    const sheetHostStates = [
      "default", "happy", "laughing", "sarcastic", "curious", "surprised",
      "excited", "annoyed", "bored", "sleepy", "thinking", "maniacal",
    ];

    for (const plan of SCENE_PLANS) {
      for (const beat of plan.humanBeats) {
        expect(sheetExpressions).toContain(beat.expression);
        expect(sheetPoses).toContain(beat.pose);
        if (beat.action !== undefined) expect(sheetActions).toContain(beat.action);
      }
      for (const beat of plan.hostBeats) {
        expect(sheetHostStates).toContain(beat.expression);
      }
    }
  });

  it("plans rigged movement in every scene, so the pilot is not a moving still", () => {
    // The pack: "At least one actual animated human movement, not a Ken Burns zoom
    // on still art." Every scene names the movement it owes, and those descriptions
    // must be distinct work rather than one repeated line.
    for (const plan of SCENE_PLANS) {
      expect(plan.requiredMotion.trim().length).toBeGreaterThan(60);
    }
    expect(new Set(SCENE_PLANS.map((plan) => plan.requiredMotion)).size).toBe(SCENE_PLANS.length);
  });

  it("keeps the explorer costume a removable overlay, never permanent anatomy", () => {
    // BRIEF.md: the hat and backpack "must not become permanent anatomy".
    const wardrobes = SCENE_PLANS.flatMap((plan) =>
      plan.humanBeats.map((beat) => beat.wardrobe),
    ).filter((wardrobe) => wardrobe !== undefined);

    expect(wardrobes).toContain("plain-white");
    expect(wardrobes).toContain("explorer-hat-backpack");
    // He ends holding the hat, per the pack's closing keyframe and CAST.md.
    expect(wardrobes).toContain("hat-held");
  });

  it("has a plan for every scene and a scene for every plan", () => {
    expect(findPlanMismatches(SCENES, SCENE_PLANS)).toEqual([]);
    expect(SCENE_PLANS).toHaveLength(SCENES.length);
  });

  it("gives every scene a background, a cast and at least one beat per character", () => {
    for (const plan of SCENE_PLANS) {
      expect(plan.background.trim().length).toBeGreaterThan(60);
      expect(plan.characters.length).toBeGreaterThan(0);
      expect(plan.humanBeats.length).toBeGreaterThan(0);
      expect(plan.hostBeats.length).toBeGreaterThan(0);
    }
  });
});

// ---------------------------------------------------------------------------
// Timeline projection
// ---------------------------------------------------------------------------

describe("timeline is a projection of the scenes", () => {
  it("does not store its own duration", () => {
    // The product spec: a projection must not carry its own duration. This asserts
    // the property at runtime as well as in the type, so a future cast-to-any or an
    // untyped JSON load cannot sneak the field back in.
    expect(Object.prototype.hasOwnProperty.call(PILOT_TIMELINE, "durationSeconds")).toBe(false);
    expect(Object.keys(PILOT_TIMELINE)).not.toContain("durationSeconds");
    expect(Object.keys(PILOT_TIMELINE)).not.toContain("duration");
  });

  it("has a total duration equal to the sum of the scene durations", () => {
    const fromScenes = computeTotalDuration(SCENES);
    const fromTimeline = timelineTotalDuration(SCENES);

    expect(fromTimeline).toBe(fromScenes);
    expect(fromTimeline).toBe(85);

    // And independently of the helper: the last picture clip's absolute end.
    const pictureClips = PILOT_TIMELINE.clips.filter((clip) => clip.kind === "video");
    const latestEnd = Math.max(...pictureClips.map((clip) => clipEndSeconds(clip, SCENES)));
    expect(latestEnd).toBe(fromScenes);
  });

  it("derives every clip's absolute time from its scene, not from itself", () => {
    for (const clip of PILOT_TIMELINE.clips) {
      const scene = SCENES.find((candidate) => candidate.id === clip.sceneId);
      expect(scene).toBeDefined();
      expect(clipStartSeconds(clip)).toBe(scene!.startSeconds + clip.offsetSeconds);
    }
  });

  it("reprojects when the scenes change, proving the relationship is live", () => {
    // The acceptance criterion is a LIVE scene-to-timeline relationship. Stretch one
    // scene and the timeline must follow without being told.
    const stretched: Scene[] = SCENES.map((scene) =>
      scene.id === "scene-05-reveal"
        ? { ...scene, durationSeconds: scene.durationSeconds + 5 }
        : scene,
    );

    const stretchedTimeline = buildTimeline(stretched);

    expect(timelineTotalDuration(stretched)).toBe(90);
    expect(timelineTotalDuration(SCENES)).toBe(85);

    // The picture clip for the edited scene reflects the new length, and the
    // timeline still validates against its (edited) source.
    const revealClip = stretchedTimeline.clips.find(
      (clip) => clip.sceneId === "scene-05-reveal" && clip.kind === "video",
    );
    expect(revealClip?.lengthSeconds).toBe(15);
    expect(findTimelineProblems(stretchedTimeline, stretched)).toEqual([]);
  });

  it("has four tracks and places clips only on them", () => {
    const kinds = PILOT_TIMELINE.tracks.map((track) => track.kind).sort();
    expect(kinds).toEqual(["dialogue", "music", "sfx", "video"]);

    const trackIds = new Set(PILOT_TIMELINE.tracks.map((track) => track.id));
    for (const clip of PILOT_TIMELINE.clips) {
      expect(trackIds.has(clip.trackId)).toBe(true);
    }
  });

  it("has no problems against its source scenes", () => {
    expect(findTimelineProblems(PILOT_TIMELINE, SCENES)).toEqual([]);
  });

  it("rejects a clip that points at a scene which does not exist", () => {
    // The validator must actually detect breakage, not just always return empty.
    const broken = {
      ...PILOT_TIMELINE,
      clips: [
        ...PILOT_TIMELINE.clips,
        {
          kind: "music" as const,
          id: "clip-orphan",
          sceneId: "scene-99-does-not-exist",
          trackId: "track-music",
          label: "orphan",
          offsetSeconds: 0,
          lengthSeconds: 1,
          cue: "orphan",
        },
      ],
    };
    expect(findTimelineProblems(broken, SCENES)).toContain(
      "clip clip-orphan references unknown scene scene-99-does-not-exist",
    );
  });

  it("gives every scene picture, dialogue and sfx coverage", () => {
    for (const scene of SCENES) {
      const clips = clipsForScene(PILOT_TIMELINE, scene.id);
      expect(clips.some((clip) => clip.kind === "video")).toBe(true);
      expect(clips.some((clip) => clip.kind === "dialogue")).toBe(true);
      expect(clips.some((clip) => clip.kind === "nonverbal")).toBe(true);
      expect(clips.some((clip) => clip.kind === "music")).toBe(true);
    }
  });

  it("routes every nonverbal clip to the sfx track and every host line to dialogue", () => {
    for (const clip of PILOT_TIMELINE.clips) {
      if (clip.kind === "nonverbal") {
        expect(clip.trackId).toBe("track-sfx");
        expect(clip.line.speaker).toBe("human");
      }
      if (clip.kind === "dialogue") {
        expect(clip.trackId).toBe("track-dialogue");
        expect(clip.line.speaker).toBe("host");
      }
    }
  });

  it("has unique clip ids", () => {
    const ids = PILOT_TIMELINE.clips.map((clip) => clip.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("reports scene spans that tile the programme exactly", () => {
    const spans = sceneSpans(SCENES);
    expect(spans[0]?.startSeconds).toBe(0);
    expect(spans[spans.length - 1]?.endSeconds).toBe(computeTotalDuration(SCENES));

    for (let i = 1; i < spans.length; i++) {
      expect(spans[i]!.startSeconds).toBe(spans[i - 1]!.endSeconds);
    }
  });
});

// ---------------------------------------------------------------------------
// Dialogue integrity
// ---------------------------------------------------------------------------

describe("dialogue integrity", () => {
  it("gives every line a valid speaker", () => {
    for (const line of allDialogue(SCENES)) {
      expect(["host", "human"]).toContain(line.speaker);
    }
  });

  it("gives every line non-empty content", () => {
    for (const line of allDialogue(SCENES)) {
      if (line.speaker === "host") {
        expect(line.text.trim().length).toBeGreaterThan(0);
        // Host lines also carry full performance direction.
        expect(["slow", "measured", "brisk"]).toContain(line.direction.pace);
        expect(["soft", "conversational", "projected"]).toContain(line.direction.volume);
        expect(["on-stage", "voice-over"]).toContain(line.direction.delivery);
        expect(Array.isArray(line.direction.pauses)).toBe(true);
      } else {
        expect(line.kind).toBe("nonverbal");
        expect(line.sound.trim().length).toBeGreaterThan(0);
      }
    }
  });

  it("has no empty or whitespace-only strings anywhere in the data", () => {
    const walk = (value: unknown, path: string): void => {
      if (typeof value === "string") {
        if (value.trim().length === 0) throw new Error(`empty string at ${path}`);
        return;
      }
      if (Array.isArray(value)) {
        value.forEach((entry, index) => walk(entry, `${path}[${index}]`));
        return;
      }
      if (value && typeof value === "object") {
        for (const [key, entry] of Object.entries(value)) walk(entry, `${path}.${key}`);
      }
    };

    expect(() => walk(SCENES, "SCENES")).not.toThrow();
    expect(() => walk(SCENE_PLANS, "SCENE_PLANS")).not.toThrow();
  });

  it("places every line inside its own scene's time window", () => {
    // Lines are spoken within the scene; the timeline must never schedule one past
    // the cut. Checked via the projection, which is what the editor actually plays.
    for (const scene of SCENES) {
      const clips = clipsForScene(PILOT_TIMELINE, scene.id);
      for (const clip of clips) {
        expect(clip.offsetSeconds).toBeGreaterThanOrEqual(0);
        expect(clip.offsetSeconds + clip.lengthSeconds).toBeLessThanOrEqual(
          scene.durationSeconds + 1e-6,
        );
      }
    }
  });

  it("has a pause on every host line whose direction calls for one", () => {
    const withPauses = hostLines(SCENES).filter((line) => line.direction.pauses.length > 0);
    expect(withPauses.length).toBeGreaterThanOrEqual(15);

    for (const line of hostLines(SCENES)) {
      for (const pause of line.direction.pauses) {
        expect(pause.seconds).toBeGreaterThan(0);
        // A pause keyed to a phrase that is not in the line is a direction error.
        expect(line.text).toContain(pause.afterWords.replace(/\.\.\.$/, ""));
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Timer continuity (reconciliation R5)
// ---------------------------------------------------------------------------

describe("on-screen timer continuity", () => {
  it("derives the on-screen clock from the scene structure", () => {
    // The storyboard's timer read 00:07 at 1:10-1:22, which does not agree with its
    // own panel timings. Recomputed against the brief's structure instead.
    expect(challengeSecondsRemaining(CHALLENGE_START_SECONDS)).toBe(CHALLENGE_SECONDS);
    expect(challengeSecondsRemaining(23)).toBe(60);
    expect(challengeSecondsRemaining(83)).toBe(0);
    expect(challengeSecondsRemaining(0)).toBe(60);

    // Never negative, even if the clock is read after the programme ends.
    expect(challengeSecondsRemaining(200)).toBe(0);
  });

  it("matches every published timer reading", () => {
    for (const reading of TIMER_READINGS) {
      expect(formatTimer(challengeSecondsRemaining(reading.atSeconds))).toBe(reading.display);
    }
  });

  it("formats the clock as MM:SS", () => {
    expect(formatTimer(60)).toBe("01:00");
    expect(formatTimer(7)).toBe("00:07");
    expect(formatTimer(0)).toBe("00:00");
    expect(formatTimer(-5)).toBe("00:00");
  });

  it("starts the clock inside scene 03 and ends it inside scene 07", () => {
    const gearScene = SCENES.find((scene) => scene.id === "scene-03-gear-and-send-off")!;
    const chaseScene = SCENES.find((scene) => scene.id === "scene-07-chase-and-near-miss")!;

    // The button press is inside the gear scene, not before or after it.
    expect(CHALLENGE_START_SECONDS).toBeGreaterThan(gearScene.startSeconds);
    expect(CHALLENGE_START_SECONDS).toBeLessThan(sceneEndSeconds(gearScene));

    // The 60-second challenge therefore expires inside the chase scene.
    expect(CHALLENGE_START_SECONDS + CHALLENGE_SECONDS).toBeGreaterThan(chaseScene.startSeconds);
    expect(CHALLENGE_START_SECONDS + CHALLENGE_SECONDS).toBeLessThanOrEqual(
      sceneEndSeconds(chaseScene),
    );
  });
});