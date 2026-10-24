import { describe, expect, it } from "vitest";

import { evaluate, type Rig, type SceneDocument, type Shape } from "../scene.js";
import { HEAD_RADIUS, buildHumanRig } from "./human-rig.js";
import {
  EXPRESSIONS,
  EXPRESSION_NAMES,
  FACE_REST,
  getExpression,
  mergeExpressionChannels,
  type Expression,
} from "./expressions.js";
import { applyChannels } from "./poses.js";

/**
 * The extreme points of a shape in the part's local space.
 *
 * Deliberately conservative: for a rect it returns all four corners, for a capsule both
 * endpoints displaced by its radius, and for a path it parses the ellipse or polygon it
 * traces. Returning MORE points than strictly necessary can only make the
 * inside-the-head check stricter, which is the safe direction for a test to err.
 */
function extremePoints(shape: Shape): readonly { x: number; y: number }[] {
  switch (shape.kind) {
    case "circle": {
      const cx = shape.cx ?? 0;
      const cy = shape.cy ?? 0;
      return [
        { x: cx - shape.radius, y: cy },
        { x: cx + shape.radius, y: cy },
        { x: cx, y: cy - shape.radius },
        { x: cx, y: cy + shape.radius },
      ];
    }
    case "ellipse": {
      const cx = shape.cx ?? 0;
      const cy = shape.cy ?? 0;
      return [
        { x: cx - shape.rx, y: cy },
        { x: cx + shape.rx, y: cy },
        { x: cx, y: cy - shape.ry },
        { x: cx, y: cy + shape.ry },
      ];
    }
    case "rect": {
      const hw = shape.width / 2;
      const hh = shape.height / 2;
      return [
        { x: -hw, y: -hh },
        { x: hw, y: -hh },
        { x: -hw, y: hh },
        { x: hw, y: hh },
      ];
    }
    case "capsule": {
      const r = shape.radius;
      return [shape.from, shape.to].flatMap((p) => [
        { x: p.x - r, y: p.y },
        { x: p.x + r, y: p.y },
        { x: p.x, y: p.y - r },
        { x: p.x, y: p.y + r },
      ]);
    }
    case "path": {
      // Two shapes are used for face marks: a two-arc closed ellipse, and a polygon.
      const ellipse = /M\s*(-?[\d.]+)\s+(-?[\d.]+)\s+A\s+([\d.]+)\s+([\d.]+)/.exec(shape.d);
      if (ellipse) {
        const rx = Number(ellipse[3]);
        const ry = Number(ellipse[4]);
        return [
          { x: -rx, y: 0 },
          { x: rx, y: 0 },
          { x: 0, y: -ry },
          { x: 0, y: ry },
        ];
      }
      const points = [...shape.d.matchAll(/[ML]\s*(-?[\d.]+)\s+(-?[\d.]+)/g)].map((m) => ({
        x: Number(m[1]),
        y: Number(m[2]),
      }));
      return points;
    }
  }
}

/**
 * Tests for facial expressions.
 *
 * The face is the whole performance in this show, so these tests check that expressions
 * are (a) genuinely different from one another as resolved geometry, and (b) physically
 * plausible — no brow or eye may escape the head circle.
 */

function sceneWith(rig: Rig): SceneDocument {
  return {
    id: "t",
    name: "t",
    width: 256,
    height: 256,
    fps: 30,
    durationSeconds: 1,
    layers: [{ id: "l", name: "l", zIndex: 0, visible: true, opacity: 1, rig }],
  };
}

/** Resolved local offsets of the face parts relative to the head centre. */
function faceGeometry(expression: Expression): Record<string, { x: number; y: number }> {
  const rig = applyChannels(buildHumanRig(), expression.channels);
  const frame = evaluate(sceneWith(rig), 0);
  const byId = new Map(frame.parts.map((p) => [p.id, p.world]));
  const head = byId.get("head")!;

  const out: Record<string, { x: number; y: number }> = {};
  for (const id of ["eye-left", "eye-right", "brow-left", "brow-right", "mouth"]) {
    const world = byId.get(id)!;
    out[id] = { x: world.e - head.e, y: world.f - head.f };
  }
  return out;
}

describe("expressions", () => {
  it("exposes at least the eight required expressions", () => {
    for (const required of [
      "default",
      "happy",
      "excited",
      "confused",
      "scared",
      "panic",
      "determined",
      "tired",
    ]) {
      expect(() => getExpression(required), `missing expression ${required}`).not.toThrow();
    }
    expect(EXPRESSION_NAMES.length).toBeGreaterThanOrEqual(8);
  });

  it("fails loudly on an unknown expression", () => {
    expect(() => getExpression("smug")).toThrow(/Unknown expression/);
  });

  it("gives every expression a description, for the storyboard UI", () => {
    for (const [name, expression] of Object.entries(EXPRESSIONS)) {
      expect(expression.name, `${name} name mismatch`).toBe(name);
      expect(expression.description.length, `${name} has no description`).toBeGreaterThan(5);
    }
  });

  it("touches the eye, brow and mouth parts in every expression", () => {
    for (const [name, expression] of Object.entries(EXPRESSIONS)) {
      for (const partId of ["eye-left", "eye-right", "brow-left", "brow-right", "mouth"]) {
        expect(expression.channels[partId], `${name} does not set ${partId}`).toBeDefined();
      }
    }
  });

  it("makes at least three expressions visibly different from one another", () => {
    // Build a geometry signature per expression and require every pair to differ.
    const signatures = EXPRESSION_NAMES.map((name) => {
      const geo = faceGeometry(getExpression(name));
      const values: number[] = [];
      for (const id of ["eye-left", "eye-right", "brow-left", "brow-right", "mouth"]) {
        values.push(geo[id]!.x, geo[id]!.y);
      }
      return { name, values };
    });

    let distinct = 0;
    for (let i = 0; i < signatures.length; i++) {
      for (let j = i + 1; j < signatures.length; j++) {
        const a = signatures[i]!;
        const b = signatures[j]!;
        let maxDelta = 0;
        for (let k = 0; k < a.values.length; k++) {
          maxDelta = Math.max(maxDelta, Math.abs(b.values[k]! - a.values[k]!));
        }
        // A centimetre of difference in a head this size is a visible change.
        if (maxDelta > 0.3) distinct++;
        else throw new Error(`${a.name} and ${b.name} are nearly identical`);
      }
    }

    const pairs = (signatures.length * (signatures.length - 1)) / 2;
    expect(distinct).toBe(pairs);
  });

  it("keeps every face feature inside the head, at rest and in every expression", () => {
    // Check the feature's true EXTREME POINT, not its origin plus a guessed margin.
    // A brow is a wide bar, so when it is rotated its far corner reaches further than
    // its centre does; an earlier version of this test used a flat margin and produced
    // false failures for exactly that reason.
    for (const name of EXPRESSION_NAMES) {
      const expression = getExpression(name);
      const rig = applyChannels(buildHumanRig(), expression.channels);
      const frame = evaluate(sceneWith(rig), 0);
      const byId = new Map(frame.parts.map((p) => [p.id, p.world]));
      const head = byId.get("head")!;

      for (const partId of ["eye-left", "eye-right", "brow-left", "brow-right", "mouth"]) {
        const part = frame.parts.find((p) => p.id === partId)!;
        const world = byId.get(partId)!;

        // The farthest any drawn point of this part can be from the head centre.
        let maxDistance = 0;
        for (const shape of part.shapes ?? []) {
          for (const point of extremePoints(shape)) {
            // Transform the local point by the part's world matrix, then measure from
            // the head centre.
            const wx = world.a * point.x + world.c * point.y + world.e;
            const wy = world.b * point.x + world.d * point.y + world.f;
            maxDistance = Math.max(
              maxDistance,
              Math.hypot(wx - head.e, wy - head.f),
            );
          }
        }

        expect(maxDistance, `${name}/${partId} escapes the head`).toBeLessThanOrEqual(
          HEAD_RADIUS,
        );
      }
    }
  });

  it("mirrors the eyes and brows symmetrically about the centre line", () => {
    for (const name of EXPRESSION_NAMES) {
      const geo = faceGeometry(getExpression(name));
      expect(Math.abs(geo["eye-left"]!.x), `${name} eyes asymmetric`).toBeCloseTo(
        Math.abs(geo["eye-right"]!.x),
        6,
      );
      expect(geo["eye-left"]!.y, `${name} eyes at different heights`).toBeCloseTo(
        geo["eye-right"]!.y,
        6,
      );
      expect(Math.abs(geo["brow-left"]!.x), `${name} brows asymmetric`).toBeCloseTo(
        Math.abs(geo["brow-right"]!.x),
        6,
      );
      expect(geo["mouth"]!.x, `${name} mouth off centre`).toBeCloseTo(0, 6);
    }
  });

  it("leaves `default` at the rig's own rest positions", () => {
    const geo = faceGeometry(getExpression("default"));
    expect(geo["eye-left"]!.x).toBeCloseTo(FACE_REST.eyeLeft.x, 6);
    expect(geo["eye-left"]!.y).toBeCloseTo(FACE_REST.eyeLeft.y, 6);
    expect(geo["brow-left"]!.y).toBeCloseTo(FACE_REST.browLeft.y, 6);
    expect(geo["mouth"]!.y).toBeCloseTo(FACE_REST.mouth.y, 6);
  });

  it("makes `happy` open the mouth wider than `default`", () => {
    const happy = getExpression("happy");
    const def = getExpression("default");
    const scaleOf = (e: Expression): number => {
      const ch = e.channels["mouth"]!["scaleY"];
      if (ch?.kind !== "number") throw new Error("no mouth scaleY");
      return ch.keyframes[0]!.value;
    };
    expect(scaleOf(happy)).toBeGreaterThan(scaleOf(def));
  });

  it("makes `scared` shrink the eyes compared with `default`", () => {
    const scaleOf = (e: Expression): number => {
      const ch = e.channels["eye-left"]!["scaleY"];
      if (ch?.kind !== "number") throw new Error("no eye scaleY");
      return ch.keyframes[0]!.value;
    };
    expect(scaleOf(getExpression("scared"))).toBeLessThan(scaleOf(getExpression("default")));
  });

  it("gives `determined` and `panicked` brows opposite angles", () => {
    const angleOf = (e: Expression): number => {
      const ch = e.channels["brow-left"]!["rotation"];
      if (ch?.kind !== "number") throw new Error("no brow rotation");
      return ch.keyframes[0]!.value;
    };
    // Angry brows drive down and inward; panicked brows fly up and outward.
    expect(angleOf(getExpression("determined"))).toBeGreaterThan(0);
    expect(angleOf(getExpression("panic"))).toBeLessThan(0);
  });

  it("merges expression channels with later expressions winning", () => {
    const merged = mergeExpressionChannels(getExpression("default"), getExpression("panic"));
    const panicMouth = getExpression("panic").channels["mouth"]!;
    expect(merged["mouth"]).toEqual(panicMouth);

    // Merging is pure: the source expressions are not mutated.
    const before = JSON.stringify(getExpression("default").channels);
    mergeExpressionChannels(getExpression("default"), getExpression("panic"));
    expect(JSON.stringify(getExpression("default").channels)).toBe(before);
  });

  it("is deterministic when evaluated", () => {
    const rig = applyChannels(buildHumanRig(), getExpression("panic").channels);
    const a = evaluate(sceneWith(rig), 0);
    const b = evaluate(sceneWith(rig), 0);
    expect(a.parts.map((p) => p.world)).toEqual(b.parts.map((p) => p.world));
  });
});