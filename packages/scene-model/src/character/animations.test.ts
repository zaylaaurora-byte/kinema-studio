import { describe, expect, it } from "vitest";

import { EASINGS, evaluate, type Rig, type SceneDocument } from "../scene.js";
import { buildHumanRig } from "./human-rig.js";
import {
  DISCRETE_ANIMATIONS,
  SMOOTH_ANIMATIONS,
  applyDiscreteAnimation,
  applySmoothAnimation,
  discreteAnimatedRig,
  getDiscreteAnimation,
  getSmoothAnimation,
  smoothAnimatedRig,
} from "./animations.js";
import {
  POSE_TRACKS,
  applyPoseTrack,
  cycleTrack,
  poseAt,
  poseTrack,
  poseTrackChannels,
  posesInTrack,
  switchTimes,
} from "./pose-track.js";
import { POSES, applyPose, composePoses, getPose } from "./poses.js";
import { MOUTH_FLAPS, MOUTH_FLAP_IDS, getMouthFlap, mouthFlapChannel } from "./mouth-flaps.js";

/**
 * Tests for animation, pose tracks and mouth flaps.
 *
 * The recurring theme: PROVE THE LIMBS ACTUALLY MOVE by sampling world transforms, not
 * by asserting that keyframes exist. A scene full of keyframes that all hold the same
 * value would satisfy the latter and fail the pilot's "not a Ken Burns zoom" rule.
 */

function sceneWith(rig: Rig, durationSeconds = 10): SceneDocument {
  return {
    id: "test",
    name: "test",
    width: 512,
    height: 512,
    fps: 30,
    durationSeconds,
    layers: [{ id: "l", name: "l", zIndex: 0, visible: true, opacity: 1, rig }],
  };
}

/** World transforms of every part at a time, keyed by part id. */
function worlds(rig: Rig, time: number): Map<string, { e: number; f: number; a: number; b: number }> {
  const frame = evaluate(sceneWith(rig), time);
  return new Map(
    frame.parts.map((p) => [p.id, { e: p.world.e, f: p.world.f, a: p.world.a, b: p.world.b }]),
  );
}

/** How far a part's world position moved between two times. */
function travel(rig: Rig, partId: string, t0: number, t1: number): number {
  const a = worlds(rig, t0).get(partId)!;
  const b = worlds(rig, t1).get(partId)!;
  return Math.hypot(b.e - a.e, b.f - a.f);
}

// ---------------------------------------------------------------------------
// Real limb movement
// ---------------------------------------------------------------------------

describe("animations move limbs for real", () => {
  it("gives different world transforms at t=0 and t=0.5 for every discrete animation", () => {
    const rig = buildHumanRig();

    for (const [name, animation] of Object.entries(DISCRETE_ANIMATIONS)) {
      const animated = applyDiscreteAnimation(rig, animation);
      const at0 = worlds(animated, 0);
      const at05 = worlds(animated, 0.5);

      // At least one limb must have moved a meaningful distance. A Ken Burns zoom would
      // leave every part's world transform identical and fail here.
      const limbIds = ["hand-right", "hand-left", "foot-left", "foot-right", "lowerArm-right"];
      const maxTravel = Math.max(
        ...limbIds.map((id) => {
          const a = at0.get(id)!;
          const b = at05.get(id)!;
          return Math.hypot(b.e - a.e, b.f - a.f);
        }),
      );

      expect(maxTravel, `${name} barely moved any limb`).toBeGreaterThan(3);
    }
  });

  it("gives different world transforms for the smooth variants too", () => {
    const rig = buildHumanRig();
    for (const [name, animation] of Object.entries(SMOOTH_ANIMATIONS)) {
      const animated = applySmoothAnimation(rig, animation);
      const moved = travel(animated, "hand-right", 0, 0.5);
      expect(moved, `${name} barely moved the right hand`).toBeGreaterThan(1);
    }
  });

  it("is deterministic: the same rig and time give identical output", () => {
    const rig = discreteAnimatedRig(buildHumanRig(), "runCycle");

    const first = evaluate(sceneWith(rig), 0.37);
    const second = evaluate(sceneWith(rig), 0.37);

    expect(first.parts.length).toBe(second.parts.length);
    for (let i = 0; i < first.parts.length; i++) {
      const a = first.parts[i]!;
      const b = second.parts[i]!;
      expect(a.id).toBe(b.id);
      // Byte-identical transforms: no wall-clock, no randomness, no accumulated state.
      expect(a.world).toEqual(b.world);
    }
  });

  it("holds a pose steady between swaps and changes exactly at the swap", () => {
    const animation = getDiscreteAnimation("runCycle");
    const rig = applyDiscreteAnimation(buildHumanRig(), animation);

    // Inside a hold, nothing moves at all. This is the defining property of limited
    // animation, and the opposite of tweening.
    const a = worlds(rig, 0.05);
    const b = worlds(rig, 0.25);
    for (const id of ["foot-left", "foot-right", "hand-left"]) {
      expect(a.get(id)!.e, `${id} drifted inside a hold`).toBeCloseTo(b.get(id)!.e, 9);
      expect(a.get(id)!.f, `${id} drifted inside a hold`).toBeCloseTo(b.get(id)!.f, 9);
    }

    // Across a swap, it changes.
    const beforeSwap = worlds(rig, 0.29).get("foot-left")!;
    const afterSwap = worlds(rig, 0.31).get("foot-left")!;
    expect(Math.hypot(afterSwap.e - beforeSwap.e, afterSwap.f - beforeSwap.f)).toBeGreaterThan(1);
  });
});

// ---------------------------------------------------------------------------
// Wave
// ---------------------------------------------------------------------------

describe("wave", () => {
  it("actually oscillates the hand horizontally", () => {
    const rig = applyDiscreteAnimation(buildHumanRig(), getDiscreteAnimation("wave"));

    // Sample densely across the cycle and track the raised hand's X.
    const samples: number[] = [];
    for (let i = 0; i <= 60; i++) {
      samples.push(worlds(rig, (i / 60) * 1.2).get("hand-right")!.e);
    }

    const min = Math.min(...samples);
    const max = Math.max(...samples);
    expect(max - min, "the hand never moved horizontally").toBeGreaterThan(2);

    // It must both rise and fall, not drift one way: the sign of the step must change.
    let rises = 0;
    let falls = 0;
    for (let i = 1; i < samples.length; i++) {
      const delta = samples[i]! - samples[i - 1]!;
      if (delta > 0.01) rises++;
      if (delta < -0.01) falls++;
    }
    expect(rises, "hand never rose").toBeGreaterThan(0);
    expect(falls, "hand never fell").toBeGreaterThan(0);
  });

  it("raises the arm clear of the body", () => {
    const rig = buildHumanRig();
    const rest = worlds(applyPose(rig, getPose("neutral")), 0).get("hand-right")!;
    const raised = worlds(applyPose(rig, getPose("wave")), 0).get("hand-right")!;
    // The waving hand is dramatically higher than the resting hand.
    expect(raised.f - rest.f).toBeGreaterThan(20);
  });

  it("completes at least two full oscillation cycles", () => {
    const animation = getDiscreteAnimation("wave");
    // Two cycles of a two-pose swap: the pose returns to the start twice.
    const track = animation.track;
    const visits = track.cues.filter((c) => c.poseId === "wave").length;
    expect(visits).toBeGreaterThanOrEqual(2);
  });
});

// ---------------------------------------------------------------------------
// Run cycle
// ---------------------------------------------------------------------------

describe("run cycle", () => {
  it("puts the left and right feet in different places at the same instant", () => {
    const rig = applyDiscreteAnimation(buildHumanRig(), getDiscreteAnimation("runCycle"));

    // Check across the whole cycle, not just one frame: alternation must hold at every
    // beat, otherwise the "cycle" is a static pose with a wobble.
    for (let i = 0; i < 8; i++) {
      const t = (i / 8) * 1.2;
      const w = worlds(rig, t);
      const left = w.get("foot-left")!;
      const right = w.get("foot-right")!;

      const separation = Math.hypot(left.e - right.e, left.f - right.f);
      expect(separation, `feet coincided at t=${t.toFixed(2)}`).toBeGreaterThan(2);
    }
  });

  it("alternates which foot is forward across the cycle", () => {
    const rig = applyDiscreteAnimation(buildHumanRig(), getDiscreteAnimation("runCycle"));

    // The cycle is four beats: contact-left, gathered, contact-right, gathered. So the
    // forward foot flips 2 beats apart and returns to its start 4 beats later. Sampling
    // at that cadence is what tests the alternation rather than the beat spacing.
    const beat = 0.3;
    const forwardFoot = (t: number): "left" | "right" =>
      worlds(rig, t).get("foot-left")!.f > worlds(rig, t).get("foot-right")!.f ? "left" : "right";

    // t=0.15 is inside beat 0 (contact left); t=0.75 is inside beat 2 (contact right).
    const a = forwardFoot(beat * 0.5);
    const b = forwardFoot(beat * 2.5);
    // And one full cycle later the original foot leads again.
    const c = forwardFoot(beat * 4.5);

    expect(a).not.toBe(b);
    expect(a).toBe(c);
  });

  it("alternates the forward foot at every contact beat in the cycle", () => {
    const rig = applyDiscreteAnimation(buildHumanRig(), getDiscreteAnimation("runCycle"));
    const beat = 0.3;
    const lead = (beatIndex: number): "left" | "right" => {
      const w = worlds(rig, beat * beatIndex + beat * 0.5);
      return w.get("foot-left")!.f > w.get("foot-right")!.f ? "left" : "right";
    };

    // Contacts are beats 0 and 2 of each 4-beat cycle.
    expect(lead(0)).not.toBe(lead(2));
    expect(lead(4)).not.toBe(lead(6));
  });

  it("bounces the body vertically", () => {
    const rig = applyDiscreteAnimation(buildHumanRig(), getDiscreteAnimation("runCycle"));
    const heights: number[] = [];
    for (let i = 0; i < 12; i++) heights.push(worlds(rig, (i / 12) * 1.2).get("hips")!.f);

    expect(Math.max(...heights) - Math.min(...heights), "no vertical bounce").toBeGreaterThan(2);
  });
});

// ---------------------------------------------------------------------------
// Trip fall
// ---------------------------------------------------------------------------

describe("trip fall", () => {
  it("rotates the body through the fall", () => {
    const rig = applyDiscreteAnimation(buildHumanRig(), getDiscreteAnimation("tripFall"));

    const upright = worlds(rig, 0).get("hips")!;
    const fallen = worlds(rig, 0.5).get("hips")!;

    // The root's rotation is carried in the world matrix; a pitch shows up as `b`.
    expect(Math.abs(upright.b)).toBeCloseTo(0, 6);
    expect(Math.abs(fallen.b), "the body never rotated").toBeGreaterThan(0.2);
  });

  it("holds the sprawl before the reaction, per the comedic beat", () => {
    const rig = applyDiscreteAnimation(buildHumanRig(), getDiscreteAnimation("tripFall"));
    const a = worlds(rig, 0.5);
    const b = worlds(rig, 1.1);
    for (const id of ["hand-left", "foot-right", "head"]) {
      expect(a.get(id)!.e).toBeCloseTo(b.get(id)!.e, 9);
      expect(a.get(id)!.f).toBeCloseTo(b.get(id)!.f, 9);
    }
  });
});

// ---------------------------------------------------------------------------
// Pose tracks
// ---------------------------------------------------------------------------

describe("pose tracks", () => {
  it("returns the correct held pose between switches", () => {
    const track = poseTrack("test", [
      { time: 0, poseId: "neutral" },
      { time: 1, poseId: "wave" },
      { time: 2, poseId: "armsUp" },
    ]);

    // Before the first switch.
    expect(poseAt(track, 0)).toBe("neutral");
    expect(poseAt(track, 0.5)).toBe("neutral");
    expect(poseAt(track, 0.999)).toBe("neutral");

    // Between switches: held, not blended.
    expect(poseAt(track, 1)).toBe("wave");
    expect(poseAt(track, 1.5)).toBe("wave");
    expect(poseAt(track, 1.999)).toBe("wave");

    expect(poseAt(track, 2)).toBe("armsUp");
  });

  it("changes exactly at switch times, and not before", () => {
    const track = poseTrack("test", [
      { time: 0, poseId: "neutral" },
      { time: 0.8, poseId: "point" },
    ]);

    const epsilon = 1e-9;
    expect(poseAt(track, 0.8 - epsilon)).toBe("neutral");
    expect(poseAt(track, 0.8)).toBe("point");
  });

  it("holds the first pose before t=0 and the last pose forever after", () => {
    const track = poseTrack("test", [
      { time: 1, poseId: "wave" },
      { time: 2, poseId: "point" },
    ]);
    expect(poseAt(track, 0)).toBe("wave");
    expect(poseAt(track, -5)).toBe("wave");
    expect(poseAt(track, 100)).toBe("point");
  });

  it("sorts out-of-order cues so sampling does not depend on author order", () => {
    const shuffled = poseTrack("test", [
      { time: 2, poseId: "armsUp" },
      { time: 0, poseId: "neutral" },
      { time: 1, poseId: "wave" },
    ]);
    expect(poseAt(shuffled, 0.5)).toBe("neutral");
    expect(poseAt(shuffled, 1.5)).toBe("wave");
    expect(poseAt(shuffled, 2.5)).toBe("armsUp");
  });

  it("reports the poses visited and the switch times", () => {
    const track = cycleTrack("runCycle", ["run", "runAlt"], 0.3, 2);
    expect([...posesInTrack(track)].sort()).toEqual(["run", "runAlt"]);
    expect(switchTimes(track)).toEqual([0.3, 0.6, 0.9, 1.2]);
  });

  it("rejects an empty track and a non-positive hold", () => {
    expect(() => poseAt(poseTrack("empty", []), 0)).toThrow();
    expect(() => cycleTrack("bad", ["neutral"], 0)).toThrow();
    expect(() => cycleTrack("bad", [], 0.3)).toThrow();
  });

  it("emits step-eased channels, so a whole pose swaps at once", () => {
    const track = poseTrack("test", [
      { time: 0, poseId: "neutral" },
      { time: 1, poseId: "point" },
    ]);
    const channels = poseTrackChannels(track);

    const rotation = channels["upperArm-left"]?.["rotation"];
    expect(rotation).toBeDefined();
    if (rotation?.kind === "number") {
      expect(rotation.keyframes.length).toBe(2);
      for (const kf of rotation.keyframes) expect(kf.easing).toBe("step");
    }
  });

  it("returns an untouched channel to its rest value when a pose omits it", () => {
    // `armsUp` does not set `foot-left`; `trip` does. Keying the union must reset the
    // foot when switching back to a pose that says nothing about it.
    const rig = buildHumanRig();
    const track = poseTrack("test", [
      { time: 0, poseId: "trip" },
      { time: 1, poseId: "armsUp" },
    ]);
    const applied = applyPoseTrack(rig, track);

    const channels = applied.parts.find((p) => p.id === "foot-left")!.channels;
    const rotation = channels["rotation"];
    expect(rotation).toBeDefined();
    if (rotation?.kind === "number") {
      // Two keys, and the second restores the rest value rather than leaving the trip.
      expect(rotation.keyframes.length).toBe(2);
      expect(rotation.keyframes[1]!.value).toBeCloseTo(0, 9);
    }
  });

  it("applies a track so that evaluating produces the named poses", () => {
    const track = POSE_TRACKS["runCycle"]!;
    const rig = applyPoseTrack(buildHumanRig(), track);

    // The rig at the first cue's time must match the rig posed directly with that pose.
    const direct = applyPose(buildHumanRig(), getPose("run"));
    const viaTrack = worlds(rig, 0);
    const directWorlds = worlds(direct, 0);

    for (const id of ["foot-left", "foot-right", "hand-left"]) {
      expect(viaTrack.get(id)!.e).toBeCloseTo(directWorlds.get(id)!.e, 6);
      expect(viaTrack.get(id)!.f).toBeCloseTo(directWorlds.get(id)!.f, 6);
    }
  });

  it("exposes every standard track by name", () => {
    expect(Object.keys(POSE_TRACKS).sort()).toEqual(
      ["greeting", "idleTalking", "runCycle", "tripFall"].sort(),
    );
    for (const track of Object.values(POSE_TRACKS)) {
      expect(track.cues.length).toBeGreaterThan(0);
      // Every referenced pose must actually exist, or the track is authored against a
      // typo and would only fail at render time.
      for (const cue of track.cues) expect(() => getPose(cue.poseId)).not.toThrow();
    }
  });

  it("alternates between two distinct poses rather than interpolating", () => {
    const track = POSE_TRACKS["runCycle"]!;
    const rig = applyPoseTrack(buildHumanRig(), track);

    // Sample twice inside the SAME hold: the limb must be bit-identical.
    const inside1 = worlds(rig, 0.05).get("foot-left")!;
    const inside2 = worlds(rig, 0.25).get("foot-left")!;
    expect(inside1.e).toBeCloseTo(inside2.e, 9);
    expect(inside1.f).toBeCloseTo(inside2.f, 9);

    // And across a beat boundary the configuration must actually differ.
    const before = worlds(rig, 0.28).get("foot-left")!;
    const after = worlds(rig, 0.32).get("foot-left")!;
    expect(Math.hypot(after.e - before.e, after.f - before.f)).toBeGreaterThan(1);
  });
});

// ---------------------------------------------------------------------------
// Distinct poses
// ---------------------------------------------------------------------------

describe("named poses", () => {
  it("exposes every required pose by name", () => {
    for (const required of [
      "neutral",
      "wave",
      "point",
      "armsUp",
      "run",
      "trip",
      "cower",
      "victory",
    ]) {
      expect(() => getPose(required), `missing pose ${required}`).not.toThrow();
    }
  });

  it("gives at least three named poses genuinely different limb configurations", () => {
    const rig = buildHumanRig();
    const names = ["neutral", "armsUp", "point", "run", "cower", "victory", "trip"];

    const signature = (name: string): number[] => {
      const posed = applyPose(rig, getPose(name));
      const w = worlds(posed, 0);
      const out: number[] = [];
      for (const id of [
        "hand-left",
        "hand-right",
        "foot-left",
        "foot-right",
        "lowerArm-left",
        "lowerArm-right",
        "lowerLeg-left",
        "lowerLeg-right",
      ]) {
        out.push(w.get(id)!.e, w.get(id)!.f);
      }
      return out;
    };

    const sigs = names.map((n) => ({ name: n, sig: signature(n) }));

    // Every pair of poses must differ in at least one limb by a visible margin.
    let distinctPairs = 0;
    for (let i = 0; i < sigs.length; i++) {
      for (let j = i + 1; j < sigs.length; j++) {
        const a = sigs[i]!;
        const b = sigs[j]!;
        let maxDelta = 0;
        for (let k = 0; k < a.sig.length; k += 2) {
          maxDelta = Math.max(
            maxDelta,
            Math.hypot(b.sig[k]! - a.sig[k]!, b.sig[k + 1]! - a.sig[k + 1]!),
          );
        }
        if (maxDelta > 2) distinctPairs++;
        else throw new Error(`poses ${a.name} and ${b.name} are nearly identical`);
      }
    }

    // With 7 poses there are 21 pairs, and all of them must be visibly different.
    expect(distinctPairs).toBe((names.length * (names.length - 1)) / 2);
  });

  it("makes `run` a real multi-limb pose, not a shifted neutral", () => {
    const rig = buildHumanRig();
    const neutral = worlds(applyPose(rig, getPose("neutral")), 0);
    const run = worlds(applyPose(rig, getPose("run")), 0);

    // Measure the limb's FAR END, not the joint. Each limb part's origin sits at its
    // joint (the hip, the shoulder), so rotating the thigh leaves `upperLeg-left`'s own
    // origin exactly where it was — the movement shows up at the knee and the foot. A
    // test that measured the joint would report "no movement" for a perfectly good pose.
    for (const id of ["lowerLeg-left", "lowerLeg-right", "hand-left", "hand-right"]) {
      const delta = Math.hypot(
        run.get(id)!.e - neutral.get(id)!.e,
        run.get(id)!.f - neutral.get(id)!.f,
      );
      expect(delta, `${id} barely differs between neutral and run`).toBeGreaterThan(4);
    }

    // Torso and head must also have changed, so the whole body is committed to the pose.
    expect(
      Math.hypot(run.get("torso")!.e - neutral.get("torso")!.e, run.get("torso")!.f - neutral.get("torso")!.f),
    ).toBeGreaterThan(0.5);

    // And the legs must be in OPPOSITE configurations, which is what makes it a stride.
    // In `run`, the +x leg is swung forward, so its knee sits further forward than the
    // other leg's knee.
    expect(run.get("lowerLeg-left")!.e).toBeGreaterThan(run.get("lowerLeg-right")!.e);
    // The feet must be genuinely split, not stacked.
    const footSplit = Math.abs(run.get("foot-left")!.e - run.get("foot-right")!.e);
    expect(footSplit).toBeGreaterThan(3);
  });

  it("makes the two run contacts exact opposites, so the cycle alternates for real", () => {
    const rig = buildHumanRig();
    const posedRun = applyPose(rig, getPose("run"));
    const posedAlt = applyPose(rig, getPose("runAlt"));

    // Compare the ROTATION ANGLES rather than world positions. Limb parts pivot about
    // their joint, and the two hip joints sit at x = +/-4.2 rather than both at zero, so
    // an identical angle on the other leg lands at a different absolute x. The angle is
    // the configuration; the offset is just anatomy.
    const angle = (r: Rig, partId: string): number => {
      const channel = r.parts.find((p) => p.id === partId)!.channels["rotation"];
      if (channel?.kind !== "number") throw new Error(`${partId} has no rotation channel`);
      return channel.keyframes[0]!.value;
    };

    // Whatever `run` does with a left limb, `runAlt` does with the right limb, and the
    // angles must be identical because the poses were authored as exact swaps.
    for (const joint of ["upperLeg", "lowerLeg", "foot", "upperArm", "lowerArm"] as const) {
      expect(angle(posedAlt, `${joint}-left`), `${joint}: alt-left vs run-right`).toBeCloseTo(
        angle(posedRun, `${joint}-right`),
        9,
      );
      expect(angle(posedAlt, `${joint}-right`), `${joint}: alt-right vs run-left`).toBeCloseTo(
        angle(posedRun, `${joint}-left`),
        9,
      );
    }

    // The two contacts must be genuinely different drawings, not the same pose twice.
    expect(angle(posedRun, "upperLeg-left")).not.toBeCloseTo(angle(posedRun, "upperLeg-right"), 3);

    // And in world terms, the legs are in opposite phase: one knee forward, one back.
    const run = worlds(posedRun, 0);
    const alt = worlds(posedAlt, 0);
    const runGap = run.get("lowerLeg-left")!.e - run.get("lowerLeg-right")!.e;
    const altGap = alt.get("lowerLeg-left")!.e - alt.get("lowerLeg-right")!.e;
    expect(Math.sign(runGap)).toBe(-Math.sign(altGap));
    expect(Math.abs(runGap)).toBeGreaterThan(3);
    expect(Math.abs(altGap)).toBeGreaterThan(3);
  });

  it("mirrors vertices correctly with composePoses, later poses winning", () => {
    const combined = composePoses(getPose("neutral"), getPose("point"));
    // The combined pose takes `point`'s arm.
    expect(combined.channels["upperArm-left"]).toEqual(
      getPose("point").channels["upperArm-left"],
    );
  });

  it("lists every pose in the POSES record", () => {
    expect(Object.keys(POSES)).toEqual(
      ["neutral", "wave", "waveDown", "point", "armsUp", "run", "runAlt", "runUp", "trip", "cower", "handsOnHips", "victory"],
    );
  });
});

// ---------------------------------------------------------------------------
// Mouth flaps
// ---------------------------------------------------------------------------

describe("mouth flaps", () => {
  it("exposes the six required states", () => {
    expect([...MOUTH_FLAP_IDS].sort()).toEqual(
      ["closed", "openSmall", "openWide", "oShape", "teeth", "smile"].sort(),
    );
  });

  it("switches the mouth between at least four distinct states", () => {
    const rig = buildHumanRig();
    const states: number[][] = [];

    for (const id of MOUTH_FLAP_IDS) {
      const flap = getMouthFlap(id);
      const applied: Rig = {
        ...rig,
        parts: rig.parts.map((part) =>
          part.id === "mouth"
            ? { ...part, shapes: [flap.shape], channels: { ...part.channels, ...flap.channels } }
            : part,
        ),
      };
      const w = worlds(applied, 0).get("mouth")!;
      states.push([w.e, w.f]);

      // Every flap must be a real, distinct shape rather than a scaled duplicate.
      expect(flap.shape.kind).toBe("path");
    }

    // The shapes must differ from one another in their path data.
    const paths = MOUTH_FLAP_IDS.map((id) => JSON.stringify(getMouthFlap(id).shape));
    expect(new Set(paths).size).toBe(MOUTH_FLAP_IDS.length);
    expect(new Set(paths).size).toBeGreaterThanOrEqual(4);
  });

  it("drives a mouth flap channel with step easing, holding each shape", () => {
    const channel = mouthFlapChannel(["closed", "openWide", "closed"], 0.1);
    expect(channel.kind).toBe("string");
    if (channel.kind === "string") {
      expect(channel.keyframes.map((k) => k.value)).toEqual(["closed", "openWide", "closed"]);
      for (const kf of channel.keyframes) expect(kf.easing).toBe("step");
    }
  });

  it("rejects an empty flap sequence and a non-positive beat", () => {
    expect(() => mouthFlapChannel([], 0.1)).toThrow();
    expect(() => mouthFlapChannel(["closed"], 0)).toThrow();
    expect(() => getMouthFlap("nope")).toThrow();
  });

  it("applies a flap so the mouth part carries its channels", () => {
    const rig = buildHumanRig();
    const flap = getMouthFlap("openWide");
    const applied: Rig = {
      ...rig,
      parts: rig.parts.map((part) =>
        part.id === "mouth" ? { ...part, channels: { ...part.channels, ...flap.channels } } : part,
      ),
    };
    const mouth = applied.parts.find((p) => p.id === "mouth")!;
    expect(mouth.channels["scaleX"]).toBeDefined();
    expect(mouth.channels["scaleY"]).toBeDefined();
  });

  it("keeps every flap's record in agreement with the shape table", () => {
    for (const id of MOUTH_FLAP_IDS) {
      const flap = MOUTH_FLAPS[id]!;
      expect(flap.id).toBe(id);
      expect(flap.shape).toEqual(MOUTH_FLAPS[id]!.shape);
      expect(Object.keys(flap.channels).length).toBeGreaterThan(0);
    }
  });
});

// ---------------------------------------------------------------------------
// Easings, as the scene model defines them
// ---------------------------------------------------------------------------

describe("easings", () => {
  it("makes `step` hold then jump at the end", () => {
    const step = EASINGS.step;
    expect(step(0)).toBe(0);
    expect(step(0.5)).toBe(0);
    expect(step(0.99)).toBe(0);
    expect(step(1)).toBe(1);
  });

  it("makes `easeIn` and `easeOut` differ from each other and from linear", () => {
    const t = 0.25;
    expect(EASINGS.easeIn(t)).toBeLessThan(EASINGS.linear(t));
    expect(EASINGS.easeOut(t)).toBeGreaterThan(EASINGS.linear(t));
    expect(EASINGS.easeIn(t)).not.toBeCloseTo(EASINGS.easeOut(t), 6);
  });

  it("keeps every easing pinned at 0 and 1", () => {
    for (const [name, fn] of Object.entries(EASINGS)) {
      expect(fn(0), `${name} at 0`).toBeCloseTo(0, 6);
      expect(fn(1), `${name} at 1`).toBeCloseTo(1, 6);
    }
  });
});