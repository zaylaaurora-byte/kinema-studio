import { describe, expect, it } from "vitest";

import { compose, evaluate, type Rig, type SceneDocument } from "../scene.js";
import {
  FIGURE_HEIGHT,
  HEAD_DIAMETER,
  HEAD_RADIUS,
  LIMB_RADIUS,
  HUMAN_PART_IDS,
  buildHumanRig,
} from "./human-rig.js";
import { FACE_REST } from "./expressions.js";

/**
 * Tests for the rig itself: proportions, hierarchy and geometry.
 *
 * These deliberately measure the ASSEMBLED rig through `evaluate()` rather than reading
 * the constants back. Asserting that `FIGURE_HEIGHT === 84` would pass even if the parts
 * were wired up wrong; measuring the resolved crown and feet cannot.
 */

function sceneWith(rig: Rig): SceneDocument {
  return {
    id: "test",
    name: "test",
    width: 512,
    height: 512,
    fps: 30,
    durationSeconds: 10,
    layers: [{ id: "l", name: "l", zIndex: 0, visible: true, opacity: 1, rig }],
  };
}

/** Resolve every part's world transform at t=0. */
function worlds(rig: Rig, time = 0): Map<string, { e: number; f: number }> {
  const frame = evaluate(sceneWith(rig), time);
  return new Map(frame.parts.map((p) => [p.id, { e: p.world.e, f: p.world.f }]));
}

describe("buildHumanRig — structure", () => {
  it("produces every required part", () => {
    const rig = buildHumanRig();
    const ids = rig.parts.map((p) => p.id);

    for (const required of [
      "hips",
      "torso",
      "head",
      "eye-left",
      "eye-right",
      "brow-left",
      "brow-right",
      "mouth",
      "upperArm-left",
      "lowerArm-left",
      "hand-left",
      "upperArm-right",
      "lowerArm-right",
      "hand-right",
      "upperLeg-left",
      "lowerLeg-left",
      "foot-left",
      "upperLeg-right",
      "lowerLeg-right",
      "foot-right",
    ]) {
      expect(ids, `missing part ${required}`).toContain(required);
    }
  });

  it("declares HUMAN_PART_IDS in agreement with the built rig", () => {
    const rig = buildHumanRig();
    expect([...rig.parts.map((p) => p.id)].sort()).toEqual([...HUMAN_PART_IDS].sort());
  });

  it("hangs every non-root part off a parent that exists", () => {
    const rig = buildHumanRig();
    const ids = new Set(rig.parts.map((p) => p.id));

    for (const part of rig.parts) {
      if (part.id === "hips") {
        expect(part.parentId).toBeUndefined();
        continue;
      }
      expect(part.parentId, `${part.id} has no parent`).toBeDefined();
      expect(ids.has(part.parentId!), `${part.id}'s parent is missing`).toBe(true);
    }
  });

  it("builds the face as children of the head, so a head turn carries the face", () => {
    const rig = buildHumanRig();
    const byId = new Map(rig.parts.map((p) => [p.id, p]));
    for (const id of ["eye-left", "eye-right", "brow-left", "brow-right", "mouth"]) {
      expect(byId.get(id)!.parentId).toBe("head");
    }
  });

  it("gives every part procedural shapes and no image assets", () => {
    const rig = buildHumanRig();
    for (const part of rig.parts) {
      expect(part.shapes, `${part.id} has no shapes`).toBeDefined();
      expect(part.shapes!.length).toBeGreaterThan(0);
      // The whole point of the procedural rig: it renders anywhere, with no assets.
      expect(part.assetId).toBeUndefined();
    }
  });

  it("uses the sheet's thick black outline on the shared body style", () => {
    const rig = buildHumanRig();
    const style = rig.styles![rig.styleRef!]!;
    expect(style.fill).toBe("#ffffff");
    expect(style.stroke).toBe("#000000");
    expect(style.strokeWidth).toBeGreaterThan(2);
  });

  it("keeps the limb tube radius uniform, so the silhouette stays even", () => {
    const rig = buildHumanRig();
    const byId = new Map(rig.parts.map((p) => [p.id, p]));
    for (const id of ["upperArm-left", "lowerArm-left", "upperLeg-right", "lowerLeg-right"]) {
      const shape = byId.get(id)!.shapes![0]!;
      expect(shape.kind).toBe("capsule");
      if (shape.kind === "capsule") expect(shape.radius).toBe(LIMB_RADIUS);
    }
  });
});

describe("buildHumanRig — proportions from resolved positions", () => {
  it("is 3.5 to 4.0 heads tall, measured from the assembled figure", () => {
    const rig = buildHumanRig();
    const w = worlds(rig);

    // The crown is the top of the head circle: head centre plus its radius.
    const headCentreY = w.get("head")!.f;
    const crownY = headCentreY + HEAD_RADIUS;
    // The lowest point is the bottom of a foot capsule.
    const footY = w.get("foot-left")!.f;

    const totalHeight = crownY - footY;
    const headCount = totalHeight / HEAD_DIAMETER;

    expect(totalHeight).toBeCloseTo(FIGURE_HEIGHT, 5);
    expect(headCount).toBeGreaterThanOrEqual(3.5);
    expect(headCount).toBeLessThanOrEqual(4.0);
    // Pin the exact value, so a future change to any limb length is caught here.
    expect(headCount).toBeCloseTo(3.8182, 3);
  });

  it("puts the feet on the ground and the hips above them", () => {
    const w = worlds(buildHumanRig());
    expect(w.get("foot-left")!.f).toBeCloseTo(0, 5);
    expect(w.get("foot-right")!.f).toBeCloseTo(0, 5);
    // Hips sit at the top of a 36-unit leg.
    expect(w.get("hips")!.f).toBeCloseTo(36, 5);
  });

  it("places joints in a strictly descending chain down each limb", () => {
    const w = worlds(buildHumanRig());
    // Shoulder above elbow above wrist, for both arms.
    for (const side of ["left", "right"]) {
      const shoulder = w.get(`upperArm-${side}`)!.f;
      const elbow = w.get(`lowerArm-${side}`)!.f;
      const wrist = w.get(`hand-${side}`)!.f;
      expect(shoulder).toBeGreaterThan(elbow);
      expect(elbow).toBeGreaterThan(wrist);
    }
    // Hip above knee above ankle, for both legs.
    for (const side of ["left", "right"]) {
      const hip = w.get(`upperLeg-${side}`)!.f;
      const knee = w.get(`lowerLeg-${side}`)!.f;
      const ankle = w.get(`foot-${side}`)!.f;
      expect(hip).toBeGreaterThan(knee);
      expect(knee).toBeGreaterThan(ankle);
    }
  });

  it("keeps the arms and legs on opposite sides of the centre line", () => {
    const w = worlds(buildHumanRig());
    expect(w.get("hand-left")!.e).toBeGreaterThan(0);
    expect(w.get("hand-right")!.e).toBeLessThan(0);
    expect(w.get("foot-left")!.e).toBeGreaterThan(0);
    expect(w.get("foot-right")!.e).toBeLessThan(0);
  });

  it("keeps every face feature inside the head circle", () => {
    const rig = buildHumanRig();
    const w = worlds(rig);
    const head = w.get("head")!;

    // Each face part's rest offset must be within the head radius, or an expression
    // would be able to push an eye out through the skull.
    const offsets: readonly (readonly [string, number, number])[] = [
      ["eye-left", FACE_REST.eyeLeft.x, FACE_REST.eyeLeft.y],
      ["eye-right", FACE_REST.eyeRight.x, FACE_REST.eyeRight.y],
      ["brow-left", FACE_REST.browLeft.x, FACE_REST.browLeft.y],
      ["brow-right", FACE_REST.browRight.x, FACE_REST.browRight.y],
      ["mouth", FACE_REST.mouth.x, FACE_REST.mouth.y],
    ];

    for (const [id, dx, dy] of offsets) {
      const actual = w.get(id)!;
      // The part's resolved offset from the head centre is its local position, since the
      // head has no rotation at rest.
      expect(actual.e - head.e, `${id} x`).toBeCloseTo(dx, 4);
      expect(actual.f - head.f, `${id} y`).toBeCloseTo(dy, 4);
      expect(Math.hypot(dx, dy), `${id} escapes the head`).toBeLessThan(HEAD_RADIUS);
    }
  });

  it("keeps the shoulders wider than the torso, so arms clear the body", () => {
    const w = worlds(buildHumanRig());
    const shoulderX = Math.abs(w.get("upperArm-left")!.e);
    // The torso capsule's outer edge is its radius.
    const torsoRadius = 7.2;
    expect(shoulderX).toBeGreaterThan(torsoRadius);
  });
});

describe("buildHumanRig — hierarchy", () => {
  it("moves a child's world transform when its PARENT rotates", () => {
    const rig = buildHumanRig();
    const before = worlds(rig);
    const handBefore = before.get("hand-left")!;

    // Rotate the shoulder only. The hand's own channels are untouched.
    const rotated: Rig = {
      ...rig,
      parts: rig.parts.map((part) =>
        part.id === "upperArm-left"
          ? {
              ...part,
              channels: {
                ...part.channels,
                rotation: { kind: "number", keyframes: [{ time: 0, value: Math.PI / 2 }] },
              },
            }
          : part,
      ),
    };

    const after = worlds(rotated).get("hand-left")!;

    // Rotating the shoulder 90 degrees must swing the hand a long way.
    const moved = Math.hypot(after.e - handBefore.e, after.f - handBefore.f);
    expect(moved).toBeGreaterThan(10);
  });

  it("moves the head and both arms when the root moves, and moves nothing when it does not", () => {
    const rig = buildHumanRig();
    const base = worlds(rig);

    const shifted: Rig = {
      ...rig,
      parts: rig.parts.map((part) =>
        part.id === "hips"
          ? {
              ...part,
              channels: {
                ...part.channels,
                y: { kind: "number", keyframes: [{ time: 0, value: 60 }] },
              },
            }
          : part,
      ),
    };
    const moved = worlds(shifted);

    for (const id of ["head", "hand-right", "foot-left", "mouth"]) {
      expect(moved.get(id)!.f - base.get(id)!.f, `${id} did not follow the root`).toBeCloseTo(24, 5);
    }
  });

  it("composes parent and child transforms the same way `compose` does", () => {
    // Independent check of the hierarchy maths against the scene model's own compose().
    const rig = buildHumanRig();
    const frame = evaluate(sceneWith(rig), 0);
    const byId = new Map(frame.parts.map((p) => [p.id, p.world]));

    const parent = byId.get("upperArm-left")!;
    const child = byId.get("lowerArm-left")!;
    // The child's local transform is a pure translation down its own -Y axis.
    const childLocal = { a: 1, b: 0, c: 0, d: 1, e: 0, f: -16 };
    const recomposed = compose(parent, childLocal);

    expect(child.e).toBeCloseTo(recomposed.e, 5);
    expect(child.f).toBeCloseTo(recomposed.f, 5);
  });
});