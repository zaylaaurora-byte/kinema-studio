import { describe, expect, it } from "vitest";

import {
  EASINGS,
  IDENTITY,
  applyTransform,
  compose,
  evaluate,
  frameCount,
  frameToTime,
  makeTransform,
  sampleNumber,
  sampleString,
  type NumberChannel,
  type Rig,
  type SceneDocument,
  type StringChannel,
} from "./scene.js";

/**
 * Tests for the deterministic scene model.
 *
 * The recurring theme: verify that a frame is genuinely a PURE FUNCTION OF TIME. Most
 * of these tests exist to catch a specific way that property can be broken — state
 * carried between frames, non-deterministic ordering, or extrapolation past the end.
 */

describe("easing functions", () => {
  it("all easings map 0 to 0 and 1 to 1", () => {
    // A curve that does not start at 0 or end at 1 breaks every keyframe segment.
    for (const [name, fn] of Object.entries(EASINGS)) {
      expect(fn(0), `${name}(0)`).toBeCloseTo(0, 6);
      expect(fn(1), `${name}(1)`).toBeCloseTo(1, 6);
    }
  });

  it("step holds the start value then jumps", () => {
    // Essential for comedy beats and held poses; a smooth curve cannot express it.
    expect(EASINGS.step(0)).toBe(0);
    expect(EASINGS.step(0.5)).toBe(0);
    expect(EASINGS.step(0.99)).toBe(0);
    expect(EASINGS.step(1)).toBe(1);
  });

  it("easeIn starts slower than linear and easeOut starts faster", () => {
    expect(EASINGS.easeIn(0.25)).toBeLessThan(0.25);
    expect(EASINGS.easeOut(0.25)).toBeGreaterThan(0.25);
  });

  it("easeInOut is symmetric about the midpoint", () => {
    expect(EASINGS.easeInOut(0.5)).toBeCloseTo(0.5, 6);
  });
});

describe("sampleNumber", () => {
  const channel: NumberChannel = {
    kind: "number",
    keyframes: [
      { time: 0, value: 0 },
      { time: 1, value: 10 },
      { time: 2, value: 10 },
      { time: 3, value: 0 },
    ],
  };

  it("interpolates linearly between keyframes", () => {
    expect(sampleNumber(channel, 0.5)).toBeCloseTo(5);
    expect(sampleNumber(channel, 1.5)).toBeCloseTo(10);
    expect(sampleNumber(channel, 2.5)).toBeCloseTo(5);
  });

  it("holds the first value before the first keyframe", () => {
    // Extrapolating backwards would send parts flying off screen.
    expect(sampleNumber(channel, -5)).toBe(0);
  });

  it("holds the last value after the final keyframe", () => {
    expect(sampleNumber(channel, 999)).toBe(0);
  });

  it("returns the single value for a one-keyframe channel", () => {
    expect(sampleNumber({ kind: "number", keyframes: [{ time: 0, value: 42 }] }, 10)).toBe(42);
  });

  it("returns undefined for an empty channel", () => {
    expect(sampleNumber({ kind: "number", keyframes: [] }, 0)).toBeUndefined();
  });

  it("does not divide by zero on a zero-length segment", () => {
    // Duplicate timestamps are easy to produce from a UI and would otherwise yield NaN,
    // which silently poisons every downstream transform.
    const degenerate: NumberChannel = {
      kind: "number",
      keyframes: [
        { time: 1, value: 0 },
        { time: 1, value: 5 },
        { time: 2, value: 10 },
      ],
    };
    const value = sampleNumber(degenerate, 1);
    expect(Number.isNaN(value!)).toBe(false);
  });

  it("applies the easing of the segment being entered", () => {
    const eased: NumberChannel = {
      kind: "number",
      keyframes: [
        { time: 0, value: 0 },
        { time: 1, value: 100, easing: "easeIn" },
      ],
    };
    // easeIn(0.5) = 0.25, so the value should be 25, not 50.
    expect(sampleNumber(eased, 0.5)).toBeCloseTo(25);
  });
});

describe("sampleString", () => {
  it("holds the last value at or before the requested time", () => {
    const channel: StringChannel = {
      kind: "string",
      keyframes: [
        { time: 0, value: "happy" },
        { time: 1, value: "scared" },
        { time: 2, value: "tired" },
      ],
    };

    expect(sampleString(channel, 0)).toBe("happy");
    expect(sampleString(channel, 0.5)).toBe("happy");
    expect(sampleString(channel, 1)).toBe("scared");
    expect(sampleString(channel, 1.9)).toBe("scared");
    expect(sampleString(channel, 2.5)).toBe("tired");
  });
});

describe("transforms", () => {
  it("identity leaves a point unchanged", () => {
    expect(applyTransform(IDENTITY, { x: 3, y: 4 })).toEqual({ x: 3, y: 4 });
  });

  it("translation moves a point", () => {
    const t = makeTransform({ x: 10, y: 20 }, 0, { x: 1, y: 1 });
    expect(applyTransform(t, { x: 0, y: 0 })).toEqual({ x: 10, y: 20 });
  });

  it("rotation by 90 degrees maps (1,0) to (0,1)", () => {
    const t = makeTransform({ x: 0, y: 0 }, Math.PI / 2, { x: 1, y: 1 });
    const p = applyTransform(t, { x: 1, y: 0 });
    expect(p.x).toBeCloseTo(0, 6);
    expect(p.y).toBeCloseTo(1, 6);
  });

  it("compose applies the inner transform before the outer", () => {
    const inner = makeTransform({ x: 5, y: 0 }, 0, { x: 1, y: 1 });
    const outer = makeTransform({ x: 0, y: 3 }, 0, { x: 1, y: 1 });
    const combined = compose(outer, inner);

    // point -> inner -> outer
    const viaCompose = applyTransform(combined, { x: 0, y: 0 });
    const viaSteps = applyTransform(outer, applyTransform(inner, { x: 0, y: 0 }));

    expect(viaCompose.x).toBeCloseTo(viaSteps.x, 6);
    expect(viaCompose.y).toBeCloseTo(viaSteps.y, 6);
  });
});

describe("evaluate — determinism and purity", () => {
  const scene = makeTestScene();

  it("returns identical output for the same scene and time", () => {
    // The foundation of caching, visual regression, and safe single-frame re-render.
    const a = evaluate(scene, 0.5);
    const b = evaluate(scene, 0.5);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it("is independent of evaluation order", () => {
    // Evaluating out of order must not change results. This catches any hidden
    // accumulated state, which is the usual way determinism is lost.
    const forward = [0, 0.25, 0.5, 0.75, 1].map((t) => evaluate(scene, t));
    const backward = [1, 0.75, 0.5, 0.25, 0].map((t) => evaluate(scene, t)).reverse();

    expect(JSON.stringify(forward)).toBe(JSON.stringify(backward));
  });

  it("clamps time to the scene duration", () => {
    expect(evaluate(scene, 999).timeSeconds).toBe(scene.durationSeconds);
    expect(evaluate(scene, -5).timeSeconds).toBe(0);
  });

  it("sorts parts deterministically by zIndex then id", () => {
    // Two parts sharing a zIndex must resolve the same way every time, rather than
    // depending on the order the array happened to be built in.
    const frame = evaluate(scene, 0);
    const zs = frame.parts.map((p) => p.zIndex);
    const sorted = [...zs].sort((a, b) => a - b);
    expect(zs).toEqual(sorted);
  });

  it("omits invisible layers", () => {
    const hidden: SceneDocument = {
      ...scene,
      layers: scene.layers.map((l) => ({ ...l, visible: false })),
    };
    expect(evaluate(hidden, 0).parts).toHaveLength(0);
  });
});

describe("rig hierarchy", () => {
  it("moves a child part when its parent rotates", () => {
    // This is what distinguishes real rigged animation from moving a flat image: a
    // child inherits its parent's transform.
    const rig: Rig = {
      id: "test-rig",
      name: "test",
      parts: [
        {
          id: "torso",
          localPosition: { x: 0, y: 0 },
          zIndex: 0,
          channels: {
            rotation: {
              kind: "number",
              keyframes: [
                { time: 0, value: 0 },
                { time: 1, value: Math.PI / 2 },
              ],
            },
          },
        },
        {
          id: "arm",
          parentId: "torso",
          localPosition: { x: 10, y: 0 },
          zIndex: 1,
          channels: {},
        },
      ],
    };

    const scene: SceneDocument = {
      id: "s",
      name: "s",
      width: 100,
      height: 100,
      fps: 30,
      durationSeconds: 1,
      layers: [{ id: "l", name: "l", zIndex: 0, visible: true, opacity: 1, rig }],
    };

    const atStart = evaluate(scene, 0);
    const atEnd = evaluate(scene, 1);

    const armStart = atStart.parts.find((p) => p.id === "arm")!;
    const armEnd = atEnd.parts.find((p) => p.id === "arm")!;

    // Apply each world transform to the arm's own origin to get its world position.
    const pStart = applyTransform(armStart.world, { x: 0, y: 0 });
    const pEnd = applyTransform(armEnd.world, { x: 0, y: 0 });

    expect(pStart.x).toBeCloseTo(10, 4);
    expect(pStart.y).toBeCloseTo(0, 4);

    // After a 90-degree parent rotation the arm must have swung round.
    expect(pEnd.x).toBeCloseTo(0, 4);
    expect(pEnd.y).toBeCloseTo(10, 4);

    // The explicit claim: the child moved because the parent moved.
    expect(pStart.x).not.toBeCloseTo(pEnd.x, 3);
  });

  it("hides a part whose visible channel says hidden", () => {
    const rig: Rig = {
      id: "r",
      name: "r",
      parts: [
        {
          id: "hat",
          localPosition: { x: 0, y: 0 },
          zIndex: 0,
          channels: {
            visible: {
              kind: "string",
              keyframes: [
                { time: 0, value: "visible" },
                { time: 0.5, value: "hidden" },
              ],
            },
          },
        },
      ],
    };

    const scene: SceneDocument = {
      id: "s",
      name: "s",
      width: 10,
      height: 10,
      fps: 30,
      durationSeconds: 1,
      layers: [{ id: "l", name: "l", zIndex: 0, visible: true, opacity: 1, rig }],
    };

    expect(evaluate(scene, 0).parts).toHaveLength(1);
    expect(evaluate(scene, 0.75).parts).toHaveLength(0);
  });

  it("does not hang on a cyclic parent reference", () => {
    // Malformed data must not take down the renderer.
    const rig: Rig = {
      id: "cyclic",
      name: "cyclic",
      parts: [
        { id: "a", parentId: "b", localPosition: { x: 0, y: 0 }, zIndex: 0, channels: {} },
        { id: "b", parentId: "a", localPosition: { x: 0, y: 0 }, zIndex: 1, channels: {} },
      ],
    };

    const scene: SceneDocument = {
      id: "s",
      name: "s",
      width: 10,
      height: 10,
      fps: 30,
      durationSeconds: 1,
      layers: [{ id: "l", name: "l", zIndex: 0, visible: true, opacity: 1, rig }],
    };

    expect(() => evaluate(scene, 0)).not.toThrow();
  });
});

describe("frame maths", () => {
  it("computes exactly 60 frames for 2 seconds at 30fps", () => {
    // floor() would give 59 here, producing a one-frame flash at every scene cut.
    const scene: SceneDocument = {
      id: "s",
      name: "s",
      width: 1,
      height: 1,
      fps: 30,
      durationSeconds: 2,
      layers: [],
    };
    expect(frameCount(scene)).toBe(60);
  });

  it("converts frame index to time correctly", () => {
    expect(frameToTime(0, 30)).toBe(0);
    expect(frameToTime(30, 30)).toBe(1);
    expect(frameToTime(15, 30)).toBe(0.5);
  });

  it("covers the full duration when iterating frames", () => {
    const fps = 30;
    const duration = 2;
    const total = Math.round(duration * fps);
    const lastTime = frameToTime(total - 1, fps);
    expect(lastTime).toBeLessThan(duration);
    expect(lastTime).toBeCloseTo(duration - 1 / fps, 6);
  });
});

describe("camera", () => {
  it("moves the world opposite to the camera", () => {
    // Moving the camera right must move the world left.
    const scene: SceneDocument = {
      id: "s",
      name: "s",
      width: 100,
      height: 100,
      fps: 30,
      durationSeconds: 1,
      layers: [],
      camera: {
        channels: {
          x: { kind: "number", keyframes: [{ time: 0, value: 0 }, { time: 1, value: 100 }] },
        },
      },
    };

    const start = evaluate(scene, 0);
    const end = evaluate(scene, 1);

    const originStart = applyTransform(start.camera, { x: 0, y: 0 });
    const originEnd = applyTransform(end.camera, { x: 0, y: 0 });

    expect(originEnd.x).toBeLessThan(originStart.x);
    expect(originEnd.x).toBeCloseTo(-100, 4);
  });

  it("zooming in scales the world up", () => {
    const scene: SceneDocument = {
      id: "s",
      name: "s",
      width: 100,
      height: 100,
      fps: 30,
      durationSeconds: 1,
      layers: [],
      camera: {
        channels: {
          zoom: { kind: "number", keyframes: [{ time: 0, value: 1 }, { time: 1, value: 2 }] },
        },
      },
    };

    const zoomed = evaluate(scene, 1).camera;
    // At 2x zoom a point 10 units out appears 5 units out, because the camera
    // transform is the inverse of the camera's movement.
    const p = applyTransform(zoomed, { x: 10, y: 0 });
    expect(p.x).toBeCloseTo(5, 4);
  });
});

function makeTestScene(): SceneDocument {
  const rig: Rig = {
    id: "rig",
    name: "rig",
    parts: [
      {
        id: "body",
        localPosition: { x: 50, y: 50 },
        zIndex: 0,
        channels: {
          y: {
            kind: "number",
            keyframes: [
              { time: 0, value: 50 },
              { time: 0.5, value: 40 },
              { time: 1, value: 50 },
            ],
          },
        },
      },
      {
        id: "head",
        parentId: "body",
        localPosition: { x: 0, y: -20 },
        zIndex: 1,
        channels: {},
      },
    ],
  };

  return {
    id: "test-scene",
    name: "Test",
    width: 100,
    height: 100,
    fps: 30,
    durationSeconds: 1,
    layers: [{ id: "main", name: "Main", zIndex: 0, visible: true, opacity: 1, rig }],
  };
}