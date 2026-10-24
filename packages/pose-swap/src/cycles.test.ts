/**
 * Pose-library distinctness and pose cycles.
 *
 * These two suites exist to catch the specific failure this whole technique is prone to: a
 * "pose library" whose entries are near-duplicates, and a "cycle" that swaps one pose for
 * itself. Both look like working code, both produce a character that never moves, and both
 * are exactly the "Ken Burns zoom passed off as animation" failure the pilot brief forbids.
 *
 * So the assertions here are about MAGNITUDE of difference, not about names existing.
 */

import { describe, expect, it } from "vitest";
import { evaluate } from "@kinema/scene-model";
import { poseDistance, type Pose } from "./pose.js";
import { countPoseSwitches, samplePose, switchTimes } from "./pose-track.js";
import {
  expandCycle,
  idleCycle,
  runCycle,
  runCycleThree,
  speakCycle,
} from "./cycles.js";
import { humanLibrary, hostLibrary } from "./library/index.js";
import { HUMAN_MOUTH_POSES, HUMAN_POSES } from "./library/human.js";
import { HOST_MOUTH_POSES, HOST_POSES } from "./library/host.js";
import { applyPoseTrack, poseTrack } from "./pose-track.js";
import { buildTestHumanRig } from "./test-rig.js";

/**
 * Minimum distance for two poses to count as genuinely different drawings.
 *
 * Chosen against the actual library: the closest legitimate pair is the idle breath pair
 * (`idleA`/`idleB`), which MUST differ but must differ SUBTLY, since it plays under
 * dialogue. Measured, that pair sits comfortably above 1.0, while an accidental duplicate
 * scores exactly 0. A threshold of 1.0 therefore separates "a deliberate subtle shift" from
 * "the same drawing twice" with a wide margin on both sides.
 */
const MIN_POSE_DISTANCE = 1.0;

/** All pairs of a set, as `[a, b, distance]` triples. */
function pairs(poses: readonly Pose[]): { a: string; b: string; distance: number }[] {
  const out: { a: string; b: string; distance: number }[] = [];
  for (let i = 0; i < poses.length; i++) {
    for (let j = i + 1; j < poses.length; j++) {
      const a = poses[i]!;
      const b = poses[j]!;
      out.push({ a: a.name, b: b.name, distance: poseDistance(a, b) });
    }
  }
  return out;
}

describe("pose library distinctness — the human", () => {
  it("has at least 6 pairwise-distinguishable body poses", () => {
    const distinguishable = pairs(HUMAN_POSES).filter(
      (p) => p.distance >= MIN_POSE_DISTANCE,
    );

    // Report the count in the failure message, so a regression says how bad it is.
    expect(
      distinguishable.length,
      `only ${distinguishable.length} of ${pairs(HUMAN_POSES).length} human pairs are ` +
        `distinguishable (>= ${MIN_POSE_DISTANCE})`,
    ).toBeGreaterThanOrEqual(6);
  });

  it("has NO pair of near-duplicate body poses at all", () => {
    const duplicates = pairs(HUMAN_POSES).filter((p) => p.distance < MIN_POSE_DISTANCE);
    expect(
      duplicates.map((d) => `${d.a}/${d.b}=${d.distance.toFixed(3)}`),
    ).toEqual([]);
  });

  it("keeps the idle pair genuinely different but still subtle", () => {
    // The idle pair must clear the "it moved" bar without becoming a visible fidget, since
    // it plays underneath dialogue.
    const distance = poseDistance(
      humanLibrary.get("idleA"),
      humanLibrary.get("idleB"),
    );
    expect(distance).toBeGreaterThanOrEqual(MIN_POSE_DISTANCE);
    expect(distance).toBeLessThan(20);
  });

  it("makes runA and runB exact mirrors, so the run alternates for real", () => {
    // The strongest form of "genuinely different": every limb is exchanged.
    const a = humanLibrary.get("runA").channels;
    const b = humanLibrary.get("runB").channels;

    const swapped = [
      ["upperLeg-left", "upperLeg-right"],
      ["lowerLeg-left", "lowerLeg-right"],
      ["foot-left", "foot-right"],
      ["upperArm-left", "upperArm-right"],
      ["lowerArm-left", "lowerArm-right"],
    ] as const;

    for (const [left, right] of swapped) {
      expect(b[left]!.rotation, `${left} should mirror ${right}`).toBeCloseTo(
        a[right]!.rotation!,
        10,
      );
      expect(b[right]!.rotation, `${right} should mirror ${left}`).toBeCloseTo(
        a[left]!.rotation!,
        10,
      );
    }
  });

  it("keeps armsUp and victory distinct despite both raising both arms", () => {
    // Two poses that both raise the arms are the likeliest accidental duplicate, so the
    // difference is made structural: arm spread, stance and head all differ.
    const distance = poseDistance(
      humanLibrary.get("armsUp"),
      humanLibrary.get("victory"),
    );
    expect(distance).toBeGreaterThan(MIN_POSE_DISTANCE);
  });

  it("distinguishes the mouth shapes from one another", () => {
    const duplicates = pairs(HUMAN_MOUTH_POSES).filter(
      (p) => p.distance < MIN_POSE_DISTANCE,
    );
    expect(duplicates.map((d) => `${d.a}/${d.b}`)).toEqual([]);
  });
});

describe("pose library distinctness — the host", () => {
  it("has at least 4 pairwise-distinguishable body poses", () => {
    const distinguishable = pairs(HOST_POSES).filter(
      (p) => p.distance >= MIN_POSE_DISTANCE,
    );
    expect(
      distinguishable.length,
      `only ${distinguishable.length} of ${pairs(HOST_POSES).length} host pairs are ` +
        `distinguishable`,
    ).toBeGreaterThanOrEqual(4);
  });

  it("has NO pair of near-duplicate body poses at all", () => {
    const duplicates = pairs(HOST_POSES).filter((p) => p.distance < MIN_POSE_DISTANCE);
    expect(duplicates.map((d) => `${d.a}/${d.b}=${d.distance.toFixed(3)}`)).toEqual([]);
  });

  it("distinguishes the mouth shapes from one another", () => {
    const duplicates = pairs(HOST_MOUTH_POSES).filter(
      (p) => p.distance < MIN_POSE_DISTANCE,
    );
    expect(duplicates.map((d) => `${d.a}/${d.b}`)).toEqual([]);
  });

  it("keeps her resting poses ASYMMETRIC, which is her characterisation", () => {
    // The human's neutral is square; the host's is not. If this ever passes with zero
    // asymmetry, her poses have been rewritten as his and she has lost her posture.
    for (const poseName of ["neutral", "sarcastic", "leaning", "sittingAtDesk"]) {
      const pose = hostLibrary.get(poseName);
      const hipsX = pose.channels["hips"]?.x ?? 0;
      const torsoRotation = pose.channels["torso"]?.rotation ?? 0;
      const asymmetric = Math.abs(hipsX) > 0.5 || Math.abs(torsoRotation) > 0.01;
      expect(asymmetric, `host "${poseName}" is square, not the lazy off-vertical read`).toBe(
        true,
      );
    }
  });

  it("gives her a tail pose that moves between drawings", () => {
    // The tail is a part only she owns, so a tail that changes is free characterisation.
    const tails = new Set(
      HOST_POSES.map((p) => p.channels["tail"]?.rotation ?? 0).map((r) => r.toFixed(6)),
    );
    expect(tails.size).toBeGreaterThanOrEqual(4);
  });
});

describe("expandCycle", () => {
  it("alternates A,B,A,B when expanded — the proof of real animation", () => {
    const cycle = runCycle("runA", "runB");
    const track = expandCycle(cycle, 0, 1.2, { library: humanLibrary });

    // 1.2s at a 0.3s hold is four beats.
    expect(track.entries).toHaveLength(4);

    // Sampled per frame at 60fps, the pose id must alternate and never repeat twice.
    const sampled: string[] = [];
    for (let frame = 0; frame < 72; frame++) {
      const pose = samplePose(track, frame / 60);
      if (sampled[sampled.length - 1] !== pose) sampled.push(pose);
    }
    expect(sampled).toEqual(["runA", "runB", "runA", "runB"]);
  });

  it("counts three switches across a four-beat window", () => {
    const track = expandCycle(runCycle("runA", "runB"), 0, 1.2, {
      library: humanLibrary,
    });
    expect(countPoseSwitches(track, 1.2, 60)).toBe(3);
  });

  it("starts the cycle at the requested startTime", () => {
    const track = expandCycle(runCycle("runA", "runB"), 2.0, 0.9, {
      library: humanLibrary,
    });
    expect(track.entries[0]!.time).toBe(2.0);
    expect(samplePose(track, 1.9)).toBe("runA");
    expect(samplePose(track, 2.0)).toBe("runA");
    expect(samplePose(track, 2.3)).toBe("runB");
  });

  it("does not emit an entry at or beyond the end of the window", () => {
    // An entry exactly at the end would be a zero-length hold, which poseTrack rejects.
    const track = expandCycle(runCycle("runA", "runB"), 0, 0.9, {
      library: humanLibrary,
    });
    for (const entry of track.entries) expect(entry.time).toBeLessThan(0.9);
  });

  it("appends the closing pose when one is given", () => {
    const track = expandCycle(
      { ...runCycle("runA", "runB"), endPoseId: "neutral" },
      0,
      1.2,
      { library: humanLibrary },
    );
    expect(samplePose(track, 1.2)).toBe("neutral");
    expect(track.entries[track.entries.length - 1]!.time).toBe(1.2);
  });

  it("still shows the first pose when the window is shorter than one hold", () => {
    const track = expandCycle(runCycle("runA", "runB"), 0, 0.1, {
      library: humanLibrary,
    });
    expect(track.entries).toHaveLength(1);
    expect(samplePose(track, 0.05)).toBe("runA");
  });

  it("REJECTS a cycle that repeats one pose", () => {
    // The headline guard: a cycle of one pose is a frozen character.
    expect(() =>
      expandCycle({ name: "fake", poseIds: ["runA", "runA"], holdSeconds: 0.3 }, 0, 1, {
        library: humanLibrary,
      }),
    ).toThrow(/must alternate between at least 2 genuinely different poses/);
  });

  it("REJECTS a single-pose cycle", () => {
    expect(() =>
      expandCycle({ name: "fake", poseIds: ["runA"], holdSeconds: 0.3 }, 0, 1),
    ).toThrow(/frozen character, not an animation/);
  });

  it("REJECTS an unknown pose id at construction when a library is supplied", () => {
    // A typo becomes a construction error, not a crash on frame 1 of a render.
    expect(() =>
      expandCycle({ name: "t", poseIds: ["runA", "typo"], holdSeconds: 0.3 }, 0, 1, {
        library: humanLibrary,
      }),
    ).toThrow(/Unknown pose "typo"/);
  });

  it("REJECTS a non-positive hold duration", () => {
    expect(() =>
      expandCycle({ name: "t", poseIds: ["runA", "runB"], holdSeconds: 0 }, 0, 1),
    ).toThrow(/positive holdSeconds/);
  });

  it("does not accumulate floating-point error over a long cycle", () => {
    // Built by index rather than repeated addition, so a 5-minute cycle stays exact.
    const track = expandCycle(runCycle("runA", "runB"), 0, 300, {
      library: humanLibrary,
    });
    const last = track.entries[track.entries.length - 1]!;
    expect(last.time).toBeCloseTo(299.7, 9);
    // Strictly increasing throughout: the validation in poseTrack would have thrown.
    for (let i = 1; i < track.entries.length; i++) {
      expect(track.entries[i]!.time).toBeGreaterThan(track.entries[i - 1]!.time);
    }
  });
});

describe("the provided cycles", () => {
  it("idleCycle alternates so a character is never fully frozen", () => {
    const track = expandCycle(idleCycle("idleA", "idleB"), 0, 2.8, {
      library: humanLibrary,
    });
    expect(countPoseSwitches(track, 2.8, 60)).toBe(3);
    expect(samplePose(track, 0)).not.toBe(samplePose(track, 0.7));
  });

  it("speakCycle holds the BODY nearly still while the mouth performs", () => {
    // A talking loop must not bounce the whole figure; only the mouth carries it. So a
    // speak cycle swaps poses far more slowly than a run.
    const speak = speakCycle("idleA", "idleB");
    const run = runCycle("runA", "runB");
    expect(speak.holdSeconds).toBeGreaterThan(run.holdSeconds);

    const track = expandCycle(speak, 0, 2.4, { library: humanLibrary });
    expect(track.entries).toHaveLength(3);
  });

  it("runCycle uses the ADR's fast end of the 0.3-0.8s band", () => {
    expect(runCycle("runA", "runB").holdSeconds).toBe(0.3);
  });

  it("idleCycle uses a hold inside the ADR's 0.3-0.8s band", () => {
    const hold = idleCycle("idleA", "idleB").holdSeconds;
    expect(hold).toBeGreaterThanOrEqual(0.3);
    expect(hold).toBeLessThanOrEqual(0.8);
  });

  it("runCycleThree visits four beats and returns to its middle pose", () => {
    const track = expandCycle(
      runCycleThree("runA", "runB", "runA"),
      0,
      0.8,
      { library: humanLibrary },
    );
    expect(track.entries).toHaveLength(4);
    // Compared with a tolerance: these are index * holdSeconds products, and 3 * 0.2 is
    // 0.6000000000000001 in IEEE754. Asserting bit equality here would test floating point,
    // not the cycle builder.
    const times = switchTimes(track);
    expect(times).toHaveLength(3);
    expect(times[0]).toBeCloseTo(0.2, 12);
    expect(times[1]).toBeCloseTo(0.4, 12);
    expect(times[2]).toBeCloseTo(0.6, 12);
    // And the ORDER is what the cycle guarantees.
    expect(times[0]!).toBeLessThan(times[1]!);
    expect(times[1]!).toBeLessThan(times[2]!);
  });
});

describe("a cycle drives a real rig through evaluate()", () => {
  it("produces DIFFERENT world transforms on alternating beats", () => {
    // The end-to-end proof, and the honest answer to "is this real animation?": a rig
    // driven by a run cycle has genuinely different geometry on consecutive beats, so it
    // cannot be a still image being panned.
    const rig = buildTestHumanRig();
    const track = expandCycle(runCycle("runA", "runB"), 0, 1.2, {
      library: humanLibrary,
    });
    const animated = applyPoseTrack(rig, track, humanLibrary);
    const scene = {
      id: "s",
      name: "s",
      width: 1920,
      height: 1080,
      fps: 60,
      durationSeconds: 2,
      layers: [{ id: "l", name: "c", zIndex: 1, visible: true, opacity: 1, rig: animated }],
    };

    const handAt = (t: number) =>
      evaluate(scene, t).parts.find((p) => p.id === "hand-left")!.world;

    // Beat 1 (runA) vs beat 2 (runB): the limbs are exchanged, so the hand has moved.
    expect(handAt(0.1)).not.toEqual(handAt(0.4));
    // Beat 1 vs beat 3: the cycle has come back round, so it is identical again. Exact
    // equality is correct here — same pose, same channels, no arithmetic in between.
    expect(handAt(0.7)).toEqual(handAt(0.1));
    // But it is STILL held across the interior of beat 1 (holds must not drift).
    expect(handAt(0.05)).toEqual(handAt(0.25));
  });
});

describe("applyPoseTrack", () => {
  it("keys the full channel union, so a stale limb cannot leak between poses", () => {
    // pose A raises the left arm; pose B does not mention it. B must get an explicit key
    // returning the arm to rest, or the character keeps the arm in the air for the shot.
    const rig = buildTestHumanRig();
    const library = {
      name: "two",
      has: () => true,
      get: (name: string): Pose =>
        name === "raised"
          ? {
              name: "raised",
              description: "",
              channels: { "upperArm-left": { rotation: -1.2 } },
            }
          : { name: "plain", description: "", channels: { head: { rotation: 0.5 } } },
      list: () => ["raised", "plain"],
      all: () => [],
    };

    const track = poseTrack("leak", [
      { time: 0, poseId: "raised" },
      { time: 0.5, poseId: "plain" },
    ]);
    const animated = applyPoseTrack(rig, track, library);

    const arm = animated.parts.find((p) => p.id === "upperArm-left")!;
    const frames = arm.channels["rotation"]!.keyframes as readonly {
      time: number;
      value: number;
    }[];
    expect(frames).toHaveLength(2);
    expect(frames[0]!.value).toBe(-1.2);
    // Rest value 0, explicitly keyed at the second switch.
    expect(frames[1]!.value).toBe(0);
  });

  it("uses step easing so the value holds then jumps, rather than sliding", () => {
    const rig = buildTestHumanRig();
    const track = poseTrack("t", [
      { time: 0, poseId: "neutral" },
      { time: 0.5, poseId: "wave" },
    ]);
    const animated = applyPoseTrack(rig, track, humanLibrary);
    const arm = animated.parts.find((p) => p.id === "upperArm-right")!;
    for (const frame of arm.channels["rotation"]!.keyframes) {
      expect(frame.easing).toBe("step");
    }
  });

  it("falls back to the rig's REST value, not to zero, when a pose omits a property", () => {
    // The failure this prevents: a part sitting at x=9.5 (the arm's rig rest) being yanked to
    // the origin on the first switch — the classic teleport-to-origin bug.
    //
    // The property must be in the track's channel UNION for a fallback to happen at all: a
    // property NO pose sets is never keyed, and the rig's own channel simply passes through
    // untouched (which the next test covers). So this case uses a library where one pose
    // sets `x` on the arm and the other does not.
    const rig = buildTestHumanRig();
    const library = {
      name: "partial",
      has: () => true,
      get: (name: string): Pose =>
        name === "lifted"
          ? {
              name: "lifted",
              description: "",
              channels: { "upperArm-left": { rotation: -1.2, x: 20 } },
            }
          : // No `x` here, so the rest value must fill in.
            { name: "plain", description: "", channels: { "upperArm-left": { rotation: 0 } } },
      list: () => ["lifted", "plain"],
      all: () => [],
    };

    const track = poseTrack("t", [
      { time: 0, poseId: "lifted" },
      { time: 0.4, poseId: "plain" },
    ]);
    const animated = applyPoseTrack(rig, track, library);
    const arm = animated.parts.find((p) => p.id === "upperArm-left")!;

    const frames = arm.channels["x"]!.keyframes as readonly { time: number; value: number }[];
    expect(frames).toHaveLength(2);
    expect(frames[0]!.value).toBe(20);
    // The rig's rest x for the arm, not 0.
    expect(frames[1]!.value).toBe(9.5);
  });

  it("leaves an untouched channel alone when no pose mentions the property", () => {
    // Neither `wave` nor `victory` sets `x` on the arm, so `x` is not in the union and the
    // rig's channel is passed through by reference — no needless re-keying.
    const rig = buildTestHumanRig();
    const track = poseTrack("t", [
      { time: 0, poseId: "wave" },
      { time: 0.4, poseId: "victory" },
    ]);
    const animated = applyPoseTrack(rig, track, humanLibrary);

    const arm = animated.parts.find((p) => p.id === "upperArm-left")!;
    const rigArm = rig.parts.find((p) => p.id === "upperArm-left")!;
    expect(arm.channels["x"]).toBe(rigArm.channels["x"]);
    // But the arm's ROTATION is keyed, because both poses set it.
    expect(arm.channels["rotation"]).not.toBe(rigArm.channels["rotation"]);
    expect(arm.channels["rotation"]!.keyframes).toHaveLength(2);
  });

  it("rejects being applied to a track with no entries", () => {
    expect(() =>
      applyPoseTrack(buildTestHumanRig(), { name: "x", entries: [] }, humanLibrary),
    ).toThrow(/no entries/);
  });
});