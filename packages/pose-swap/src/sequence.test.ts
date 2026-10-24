/**
 * End-to-end: a full 5-second shot, evaluated at EVERY frame.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS TEST IS DIFFERENT FROM THE OTHERS
 * ---------------------------------------------------------------------------
 * The unit tests check each primitive in isolation. This one checks the thing the show
 * actually needs, and it checks it the way the renderer will: a real rig, driven by a body
 * pose track AND an idle cycle AND a mouth track at once, put through the real `evaluate()`
 * of `@kinema/scene-model` at every frame of a 5-second shot.
 *
 * The failure it is built to catch is a GAP — a frame at which the mouth is undefined, or a
 * part has no channel, or two tracks disagree about which pose is active. Gaps do not show
 * up in unit tests; they show up as a one-frame flash in the render, which is the most
 * expensive kind of bug to find by eye.
 *
 * It doubles as an honest demonstration that this is REAL animation rather than a pan:
 * the character's geometry changes between holds, and the mouth changes on a beat.
 */

import { describe, expect, it } from "vitest";
import { evaluate, frameCount, type Rig, type SceneDocument } from "@kinema/scene-model";
import { applyPose, type Pose } from "./pose.js";
import { applyPoseTrack, poseTrack, samplePose } from "./pose-track.js";
import { mouthFromVisemes, sampleMouth, type VisemeEvent, type MouthShape } from "./mouth.js";
import { expandCycle, idleCycle, speakCycle } from "./cycles.js";
import { createPoseLibrary } from "./pose.js";
import { HUMAN_MOUTH_POSES, HUMAN_POSES } from "./library/human.js";
import { humanLibrary } from "./library/index.js";
import { buildTestHumanRig } from "./test-rig.js";

const FPS = 60;
const DURATION = 5;

/**
 * A five-second beat sheet, in the show's own terms: he explains, gestures, listens, then
 * reacts. Times are chosen to sit on the ADR's 0.3-0.8s hold band.
 */
const SHOT: readonly { readonly time: number; readonly poseId: string }[] = [
  { time: 0.0, poseId: "neutral" },
  { time: 0.4, poseId: "point" }, // explaining the plan
  { time: 1.2, poseId: "wave" }, // greeting the audience
  { time: 1.8, poseId: "armsUp" }, // delighted
  { time: 2.4, poseId: "neutral" }, // settling
  { time: 3.0, poseId: "leanForward" }, // listening
  { time: 3.6, poseId: "cower" }, // immediate trouble
  { time: 4.2, poseId: "victory" }, // brief, unearned confidence
  { time: 4.7, poseId: "trip" }, // the payoff
];

/** A spoken line with silences, dense enough to exercise cadence quantisation. */
const LINE: readonly VisemeEvent[] = [
  { time: 0.0, viseme: "silence" },
  { time: 0.3, viseme: "PP" },
  { time: 0.45, viseme: "aa" },
  { time: 0.6, viseme: "DD" },
  { time: 0.72, viseme: "E" },
  { time: 0.85, viseme: "SS" },
  { time: 1.0, viseme: "silence" },
  { time: 1.3, viseme: "O" },
  { time: 1.45, viseme: "U" },
  { time: 1.6, viseme: "aa" },
  { time: 1.75, viseme: "CH" },
  { time: 1.9, viseme: "silence" },
  { time: 2.6, viseme: "FF" },
  { time: 2.8, viseme: "I" },
  { time: 3.0, viseme: "PP" },
  { time: 3.5, viseme: "aa" },
  { time: 3.7, viseme: "aa" },
  { time: 3.95, viseme: "O" },
  { time: 4.3, viseme: "TH" },
  { time: 4.6, viseme: "SS" },
  { time: 4.8, viseme: "silence" },
];

/**
 * Compose body track + idle cycle + mouth track onto one rig.
 *
 * The composition order is the interesting part and is deliberate:
 *
 *   1. **Idle cycle first**, over the whole shot, so the character is never frozen even
 *      between body poses.
 *   2. **Body pose track over it**, which wins at every switch — a named pose is a stronger
 *      statement about what the character is doing than the background idle breath.
 *
 * Both write `step` channels with the same property names, so the later application simply
 * replaces the earlier keys at its own times. That is why the body track must be applied
 * second; reversing the order would let the idle cycle's slower keys override the pose
 * switches.
 */
function buildShotRig(): { rig: Rig; mouthSequence: readonly MouthShape[] } {
  const base = buildTestHumanRig();

  // 1. Idle cycle across the whole shot.
  const idle = expandCycle(idleCycle("idleA", "idleB"), 0, DURATION, {
    library: humanLibrary,
  });
  const withIdle = applyPoseTrack(base, idle, humanLibrary);

  // 2. Body pose track on top.
  const body = poseTrack("shot", SHOT);
  const withBody = applyPoseTrack(withIdle, body, humanLibrary);

  // 3. Mouth: quantised to a 0.1s beat, which is what makes it read as style.
  const mouth = mouthFromVisemes(LINE, {
    name: "line",
    cadence: 0.1,
    visemeMap: {},
  });

  const mouthSequence: MouthShape[] = [];
  for (let frame = 0; frame < frameCount(sceneFor(withBody)); frame++) {
    mouthSequence.push(sampleMouth(mouth, frame / FPS));
  }

  return { rig: withBody, mouthSequence };
}

function sceneFor(rig: Rig): SceneDocument {
  return {
    id: "pilot-shot",
    name: "pilot shot",
    width: 1920,
    height: 1080,
    fps: FPS,
    durationSeconds: DURATION,
    layers: [{ id: "char", name: "human", zIndex: 1, visible: true, opacity: 1, rig }],
  };
}

describe("a full 5-second sequence", () => {
  const { rig, mouthSequence } = buildShotRig();
  const scene = sceneFor(rig);
  const totalFrames = frameCount(scene);

  it("has exactly 300 frames at 60fps for 5 seconds", () => {
    // `frameCount` rounds deliberately, so a whole number of seconds is exact.
    expect(totalFrames).toBe(300);
  });

  it("evaluates at EVERY frame with no gaps and no empty frames", () => {
    const expectedParts = rig.parts.length;

    for (let frame = 0; frame < totalFrames; frame++) {
      const time = frame / FPS;
      const evaluated = evaluate(scene, time);

      // No frame may be missing parts, and no transform may be non-finite. A NaN here is
      // the signature of a missing channel being read as a number somewhere.
      expect(evaluated.parts.length, `frame ${frame}`).toBe(expectedParts);

      for (const part of evaluated.parts) {
        expect(Number.isFinite(part.world.a), `frame ${frame} ${part.id}.a`).toBe(true);
        expect(Number.isFinite(part.world.e), `frame ${frame} ${part.id}.e`).toBe(true);
        expect(Number.isFinite(part.world.f), `frame ${frame} ${part.id}.f`).toBe(true);
      }
    }
  });

  it("produces a mouth shape at every frame, never undefined", () => {
    expect(mouthSequence).toHaveLength(totalFrames);
    for (let frame = 0; frame < totalFrames; frame++) {
      expect(mouthSequence[frame], `frame ${frame}`).toBeDefined();
      expect([
        "closed",
        "openSmall",
        "openWide",
        "oShape",
        "teeth",
        "smile",
      ]).toContain(mouthSequence[frame]);
    }
  });

  it("visits every body pose in the shot, on schedule", () => {
    const body = poseTrack("shot", SHOT);
    for (const beat of SHOT) {
      expect(samplePose(body, beat.time), `at t=${beat.time}`).toBe(beat.poseId);
    }
  });

  it("ACTUALLY MOVES the character — the frame-to-frame geometry is not constant", () => {
    // The honest answer to "is this a Ken Burns zoom?": the rig's geometry differs across
    // the shot, so nothing here is a still image being panned.
    const handAt = (frame: number) =>
      evaluate(scene, frame / FPS).parts.find((p) => p.id === "hand-left")!.world;

    const first = handAt(0);
    const distinct = new Set<string>();
    for (let frame = 0; frame < totalFrames; frame += 5) {
      const w = handAt(frame);
      distinct.add(`${w.a.toFixed(6)},${w.e.toFixed(6)},${w.f.toFixed(6)}`);
    }

    // The left hand must occupy many distinct positions across the shot.
    expect(distinct.size).toBeGreaterThan(8);
    expect(handAt(60)).not.toEqual(first);
  });

  it("HOLDS the geometry within a pose beat — still a pose swap, not a drift", () => {
    // Between two switches nothing may move. Frame 5 and frame 20 both sit inside the
    // 0 -> 0.4s neutral hold, so every part must be identical.
    const a = evaluate(scene, 5 / FPS);
    const b = evaluate(scene, 20 / FPS);

    for (let i = 0; i < a.parts.length; i++) {
      expect(b.parts[i]!.world).toEqual(a.parts[i]!.world);
    }
  });

  it("changes the mouth on a beat, and holds it between beats", () => {
    // The mouth sequence, reduced to the beats it visits.
    const beats: MouthShape[] = [];
    for (const shape of mouthSequence) {
      if (beats[beats.length - 1] !== shape) beats.push(shape);
    }

    // A dense 21-viseme line must reduce to a readable number of drawn mouth shapes.
    expect(beats.length).toBeGreaterThan(3);
    expect(beats.length).toBeLessThan(LINE.length);

    // And within a 0.1s beat the shape cannot change: quantisation guarantees it.
    expect(mouthSequence[0]).toBe(mouthSequence[4]);
  });

  it("keeps the body pose stable while the mouth is performing", () => {
    // The style rule from the ADR: talking is a mouth performance on a HELD body. Across
    // the first hold (0 to 0.4s) the mouth changes but the body does not.
    const start = evaluate(scene, 0);
    const later = evaluate(scene, 20 / FPS);
    expect(later.parts.find((p) => p.id === "head")!.world).toEqual(
      start.parts.find((p) => p.id === "head")!.world,
    );

    // The mouth, meanwhile, is a different drawn shape somewhere in that window.
    expect(mouthSequence.slice(0, 24).some((s) => s !== "closed")).toBe(true);
  });

  it("is DETERMINISTIC — evaluating the same frame twice is byte-identical", () => {
    // The property the whole pipeline rests on, checked through this composition too.
    for (const frame of [0, 37, 150, 299]) {
      const a = evaluate(scene, frame / FPS);
      const b = evaluate(scene, frame / FPS);
      expect(b.parts.map((p) => p.world)).toEqual(a.parts.map((p) => p.world));
    }
  });
});

describe("the speak cycle under a talking mouth", () => {
  it("keeps the body cycle slower than the mouth beat, so they do not lock together", () => {
    // If the body beat and the mouth beat were equal, the character would pulse as one
    // machine. The body must be visibly slower.
    const bodyHold = speakCycle("idleA", "idleB").holdSeconds;
    const mouthBeat = 0.1;
    expect(bodyHold).toBeGreaterThan(mouthBeat * 4);
  });

  it("holds a speaking body pose across many mouth flaps", () => {
    const track = expandCycle(speakCycle("idleA", "idleB"), 0, 1.6, {
      library: humanLibrary,
    });
    // Three body beats in 1.6s = 0.8s each, which is 16 mouth flaps at a 0.1s cadence.
    expect(track.entries).toHaveLength(2);
    expect(samplePose(track, 0.79)).toBe("idleA");
    expect(samplePose(track, 0.8)).toBe("idleB");
  });
});

describe("a rig built only from applyPose, with no track at all", () => {
  it("still evaluates, and holds forever", () => {
    // The simplest possible use: a single pose, no timeline. Used for held frames and for
    // a character who is simply present in a shot.
    const posed = applyPose(humanLibrary.get("sitting"), buildTestHumanRig());
    const scene = sceneFor(posed);
    const a = evaluate(scene, 0);
    const b = evaluate(scene, DURATION);
    expect(b.parts.map((p) => p.world)).toEqual(a.parts.map((p) => p.world));
  });

  it("agrees with a one-entry pose track containing the same pose", () => {
    const rig = buildTestHumanRig();
    const direct = applyPose(humanLibrary.get("cower"), rig);
    const viaTrack = applyPoseTrack(rig, poseTrack("one", [{ time: 0, poseId: "cower" }]), humanLibrary);

    const sceneA = sceneFor(direct);
    const sceneB = sceneFor(viaTrack);
    expect(evaluate(sceneB, 1).parts.map((p) => p.world)).toEqual(
      evaluate(sceneA, 1).parts.map((p) => p.world),
    );
  });
});

describe("library independence", () => {
  it("lets a caller build a library from just the poses a shot needs", () => {
    // The library is a value, not a global: a shot can carry only the handful of drawings
    // it uses, which is what keeps a render's dependency surface small.
    const subset = createPoseLibrary("shot-subset", [
      HUMAN_POSES[0]!,
      HUMAN_POSES[1]!,
      ...HUMAN_MOUTH_POSES,
    ]);
    expect(subset.list()).toContain("neutral");
    expect(subset.list()).toContain("closed");
    expect(subset.has("trip")).toBe(false);
  });

  it("exposes every pose as plain data, so a shot file could serialise it", () => {
    for (const pose of humanLibrary.all()) {
      const roundTripped = JSON.parse(JSON.stringify(pose)) as Pose;
      expect(roundTripped.name).toBe(pose.name);
      expect(Object.keys(roundTripped.channels)).toEqual(Object.keys(pose.channels));
    }
  });
});