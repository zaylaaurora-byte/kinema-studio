/**
 * `pose.ts` tests — the discrete configuration, the library, and the bridge to `evaluate()`.
 *
 * The integration test here is the one that matters most: it proves a pose is a genuine
 * HOLD by round-tripping through the real evaluator and asserting the world transforms are
 * byte-identical at several times. An implementation that accidentally produced a drifting
 * channel would pass every structural test and fail this one.
 */

import { describe, expect, it } from "vitest";
import { evaluate, type Rig } from "@kinema/scene-model";
import {
  applyPose,
  blendPoses,
  CHANNEL_PROPERTIES,
  constChannel,
  createPoseLibrary,
  deg,
  poseChannels,
  poseDistance,
  ROTATION_WEIGHT,
  type Pose,
} from "./pose.js";
import { buildBareRig, buildTestHumanRig } from "./test-rig.js";
import { HUMAN_PART_IDS } from "./library/human.js";
import { humanLibrary, hostLibrary } from "./library/index.js";

/** Wrap a rig in a one-layer scene so the real `evaluate()` can be called. */
function sceneFor(rig: Rig) {
  return {
    id: "scene",
    name: "test",
    width: 1920,
    height: 1080,
    fps: 60,
    durationSeconds: 10,
    layers: [{ id: "l1", name: "char", zIndex: 1, visible: true, opacity: 1, rig }],
  };
}

describe("deg", () => {
  it("converts degrees to radians", () => {
    expect(deg(180)).toBeCloseTo(Math.PI, 12);
    expect(deg(90)).toBeCloseTo(Math.PI / 2, 12);
    expect(deg(0)).toBe(0);
  });
});

describe("constChannel", () => {
  it("produces a single-keyframe channel holding the value", () => {
    const channel = constChannel(42);
    expect(channel.kind).toBe("number");
    expect(channel.keyframes).toHaveLength(1);
    expect(channel.keyframes[0]!.value).toBe(42);
    expect(channel.keyframes[0]!.time).toBe(0);
  });
});

describe("poseChannels", () => {
  it("emits one single-keyframe channel per set property", () => {
    const pose: Pose = {
      name: "p",
      description: "d",
      channels: { part: { rotation: 1, x: 5 } },
    };
    const channels = poseChannels(pose);
    expect(Object.keys(channels["part"]!).sort()).toEqual(["rotation", "x"]);
    expect(channels["part"]!["x"]!.keyframes).toHaveLength(1);
  });

  it("omits a part entry that sets no known property", () => {
    // An empty override would read downstream as "this part is posed" when it is not.
    const pose: Pose = { name: "p", description: "d", channels: { part: {} } };
    expect(Object.keys(poseChannels(pose))).toEqual([]);
  });
});

describe("applyPose", () => {
  it("returns a NEW rig and does not mutate the input", () => {
    const rig = buildTestHumanRig();
    const headBefore = rig.parts.find((p) => p.id === HUMAN_PART_IDS.head)!;
    const posed = applyPose(humanLibrary.get("wave"), rig);

    expect(posed).not.toBe(rig);
    // The original rig's head channel is untouched.
    const headAfter = rig.parts.find((p) => p.id === HUMAN_PART_IDS.head)!;
    expect(headAfter.channels).toBe(headBefore.channels);
    expect(posed.parts).not.toBe(rig.parts);
  });

  it("only touches parts the pose names, leaving others identical by reference", () => {
    const rig = buildTestHumanRig();
    const posed = applyPose(humanLibrary.get("wave"), rig);

    const untouched = (id: string) =>
      rig.parts.find((p) => p.id === id) === posed.parts.find((p) => p.id === id);

    // `wave` moves the right arm and the head; it says nothing about the feet.
    expect(untouched(HUMAN_PART_IDS.footLeft)).toBe(true);
    expect(untouched(HUMAN_PART_IDS.upperArmRight)).toBe(false);
  });

  it("ignores a pose entry for a part the rig does not have", () => {
    // Intentional: it lets a human pose apply to a rig without a tail, say.
    const pose: Pose = {
      name: "tailwag",
      description: "d",
      channels: { tail: { rotation: 0.5 } },
    };
    const rig = buildTestHumanRig();
    expect(() => applyPose(pose, rig)).not.toThrow();
  });

  it("preserves properties the pose does not set, so poses compose instead of clobbering", () => {
    // Base sets x, correction sets rotation. Both must survive.
    const rig = buildBareRig();
    const positioned = applyPose(
      { name: "a", description: "d", channels: { hips: { x: 99 } } },
      rig,
    );
    const both = applyPose(
      { name: "b", description: "d", channels: { hips: { rotation: 0.5 } } },
      positioned,
    );

    const hips = both.parts.find((p) => p.id === HUMAN_PART_IDS.hips)!;
    expect(hips.channels["x"]!.keyframes[0]!.value).toBe(99);
    expect(hips.channels["rotation"]!.keyframes[0]!.value).toBeCloseTo(0.5, 12);
  });

  it("writes only properties the evaluator actually reads", () => {
    // Guards against the pose shape and the rig transform drifting apart: if `evaluate()`
    // started reading a sixth property, this test is where that is noticed.
    const channelProps = [...CHANNEL_PROPERTIES].sort();
    expect(channelProps).toEqual(["rotation", "scaleX", "scaleY", "x", "y"]);
  });
});

describe("applyPose integrates with @kinema/scene-model evaluate()", () => {
  it("produces a rig evaluate() accepts, with every posed part present", () => {
    const rig = buildTestHumanRig();
    const posed = applyPose(humanLibrary.get("victory"), rig);
    const frame = evaluate(sceneFor(posed), 0);

    expect(frame.parts.length).toBeGreaterThan(0);
    expect(frame.parts.map((p) => p.id)).toContain(HUMAN_PART_IDS.handLeft);
  });

  /**
   * THE HOLD TEST.
   *
   * A pose must be a HOLD, not a drift. Evaluating the same posed rig at many times must
   * give identical world transforms. This is what distinguishes limited animation from
   * interpolation, and it is the property that a subtly wrong implementation (a two-keyframe
   * channel, a stray easing, an accidental curve) would break while looking correct.
   */
  it("holds world transforms CONSTANT across time — a pose does not drift", () => {
    const posed = applyPose(humanLibrary.get("wave"), buildTestHumanRig());
    const scene = sceneFor(posed);

    const times = [0, 0.016, 0.5, 1.7, 3.333, 9.99];
    const baseline = evaluate(scene, times[0]!);

    for (const time of times.slice(1)) {
      const frame = evaluate(scene, time);
      expect(frame.parts.length).toBe(baseline.parts.length);

      for (let i = 0; i < baseline.parts.length; i++) {
        const a = baseline.parts[i]!;
        const b = frame.parts[i]!;
        expect(b.id).toBe(a.id);
        // Exact equality, not toBeCloseTo: identical inputs must give IDENTICAL output,
        // because there is no arithmetic between two samples of a constant channel.
        expect(b.world).toEqual(a.world);
      }
    }
  });

  it("holds scale channels constant too, which is how mouth shapes work", () => {
    const posed = applyPose(humanLibrary.get("openWide"), buildTestHumanRig());
    const scene = sceneFor(posed);
    const a = evaluate(scene, 0).parts.find((p) => p.id === HUMAN_PART_IDS.mouth)!;
    const b = evaluate(scene, 4.2).parts.find((p) => p.id === HUMAN_PART_IDS.mouth)!;
    expect(b.world).toEqual(a.world);
  });

  it("actually MOVES a part when a pose is applied — a pose is not a no-op", () => {
    // The mirror of the hold test: if `applyPose` silently did nothing, the hold test
    // would still pass. This catches that.
    const rig = buildTestHumanRig();
    const neutralHead = evaluate(sceneFor(rig), 0).parts.find(
      (p) => p.id === HUMAN_PART_IDS.head,
    )!;
    const waved = applyPose(humanLibrary.get("wave"), rig);
    const waveHead = evaluate(sceneFor(waved), 0).parts.find(
      (p) => p.id === HUMAN_PART_IDS.head,
    )!;

    expect(waveHead.world).not.toEqual(neutralHead.world);
  });
});

describe("createPoseLibrary", () => {
  const a: Pose = { name: "a", description: "A", channels: {} };
  const b: Pose = { name: "b", description: "B", channels: {} };

  it("looks poses up by name", () => {
    const lib = createPoseLibrary("lib", [a, b]);
    expect(lib.get("a")).toBe(a);
    expect(lib.has("b")).toBe(true);
    expect(lib.has("nope")).toBe(false);
  });

  it("lists names in insertion order, which is the artist's order", () => {
    const lib = createPoseLibrary("lib", [b, a]);
    expect(lib.list()).toEqual(["b", "a"]);
    expect(lib.all().map((p) => p.name)).toEqual(["b", "a"]);
  });

  it("throws a helpful error on an unknown pose, listing what exists", () => {
    const lib = createPoseLibrary("lib", [a, b]);
    expect(() => lib.get("typo")).toThrow(/Unknown pose "typo"/);
    expect(() => lib.get("typo")).toThrow(/Available: a, b/);
  });

  it("rejects a duplicate name at construction, since one drawing would be unreachable", () => {
    expect(() => createPoseLibrary("lib", [a, { ...a, description: "other" }])).toThrow(
      /defines pose "a" more than once/,
    );
  });
});

describe("blendPoses", () => {
  it("merges later poses over earlier ones, property by property", () => {
    const base: Pose = {
      name: "base",
      description: "b",
      channels: { head: { rotation: 1, x: 2 } },
    };
    const fix: Pose = { name: "fix", description: "f", channels: { head: { rotation: 9 } } };
    const merged = blendPoses(base, fix);

    expect(merged.channels["head"]).toEqual({ rotation: 9, x: 2 });
  });

  it("touches neither input", () => {
    const base: Pose = { name: "base", description: "b", channels: { h: { x: 1 } } };
    const fix: Pose = { name: "fix", description: "f", channels: { h: { x: 2 } } };
    blendPoses(base, fix);
    expect(base.channels["h"]).toEqual({ x: 1 });
    expect(fix.channels["h"]).toEqual({ x: 2 });
  });

  it("rejects being called with no poses", () => {
    expect(() => blendPoses()).toThrow(/at least one pose/);
  });
});

describe("poseDistance", () => {
  const p = (channels: Pose["channels"]): Pose => ({ name: "p", description: "", channels });

  it("is zero for identical poses", () => {
    const pose = p({ head: { rotation: 1, x: 3 } });
    expect(poseDistance(pose, pose)).toBe(0);
  });

  it("is zero when the poses share no part in common", () => {
    // Only properties BOTH poses set are compared; a disjoint pair has nothing to compare.
    expect(poseDistance(p({ a: { x: 1 } }), p({ b: { x: 1 } }))).toBe(0);
  });

  it("weights rotation so limb swing dominates, as it does on a drawn character", () => {
    const d = poseDistance(p({ h: { rotation: 1 } }), p({ h: { rotation: 0 } }));
    expect(d).toBe(ROTATION_WEIGHT);
  });

  it("sums absolute differences over position channels", () => {
    const d = poseDistance(p({ h: { x: 0, y: 0 } }), p({ h: { x: 3, y: 4 } }));
    expect(d).toBe(7);
  });
});

describe("the two character libraries", () => {
  it("expose the required pose names", () => {
    // Listed explicitly so a rename cannot silently drop a pose the brief requires.
    for (const required of [
      "neutral",
      "wave",
      "point",
      "armsUp",
      "leanForward",
      "cower",
      "runA",
      "runB",
      "trip",
      "sitting",
      "victory",
      "closed",
      "openSmall",
      "openWide",
      "oShape",
      "teeth",
      "smile",
    ]) {
      expect(humanLibrary.has(required), `human is missing "${required}"`).toBe(true);
    }

    for (const required of [
      "neutral",
      "sarcastic",
      "pointing",
      "leaning",
      "sittingAtDesk",
      "laughing",
      "closed",
      "openSmall",
      "openWide",
      "oShape",
      "teeth",
      "smile",
    ]) {
      expect(hostLibrary.has(required), `host is missing "${required}"`).toBe(true);
    }
  });

  it("reference only part ids the rig contract defines", () => {
    const humanIds = new Set(Object.values(HUMAN_PART_IDS));
    for (const pose of humanLibrary.all()) {
      for (const partId of Object.keys(pose.channels)) {
        expect(humanIds.has(partId as never), `${pose.name} uses unknown part "${partId}"`).toBe(
          true,
        );
      }
    }
  });
});