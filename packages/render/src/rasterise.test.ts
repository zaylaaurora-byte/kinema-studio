/**
 * Rasteriser tests.
 *
 * These assert on real pixels, not on "the function returned a Buffer". A renderer that
 * returns a correctly-sized black rectangle satisfies every structural check and is
 * completely broken, so the central assertion here is on pixel variance.
 */

import { describe, expect, it } from "vitest";
import { evaluate, frameToTime, type SceneDocument } from "@kinema/scene-model";
import { rasteriseFrame } from "./rasterise.js";
import { makeAnimatedScene, makeStaticScene, pixelStats, pngDimensions } from "./test-helpers.js";

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

describe("rasteriseFrame", () => {
  it("produces a valid PNG with the scene's dimensions", async () => {
    const scene = makeAnimatedScene();
    const frame = evaluate(scene, frameToTime(0, scene.fps));
    const png = await rasteriseFrame(frame);

    // PNG magic number: \x89 P N G \r \n \x1a \n
    expect(png.subarray(0, 8).equals(PNG_SIGNATURE)).toBe(true);
    expect(pngDimensions(png)).toEqual({ width: 320, height: 240 });
  });

  it("is NOT uniformly blank — pixel variance is non-zero", async () => {
    const scene = makeAnimatedScene();
    const frame = evaluate(scene, frameToTime(10, scene.fps));
    const png = await rasteriseFrame(frame);
    const stats = await pixelStats(png);

    // The whole point: a blank canvas would have variance 0. Real content has spread.
    expect(stats.variance).toBeGreaterThan(100);
    expect(stats.max - stats.min).toBeGreaterThan(100);
    expect(stats.distinctColors).toBeGreaterThan(2);
  });

  it("renders different frames for different times (the scene actually animates)", async () => {
    const scene = makeAnimatedScene();
    const fps = scene.fps;
    const first = await rasteriseFrame(evaluate(scene, frameToTime(0, fps)));
    const mid = await rasteriseFrame(evaluate(scene, frameToTime(15, fps)));
    const last = await rasteriseFrame(evaluate(scene, frameToTime(29, fps)));

    expect(first.equals(mid)).toBe(false);
    expect(mid.equals(last)).toBe(false);
    expect(first.equals(last)).toBe(false);
  });

  it("renders fast enough to be usable for long exports", async () => {
    const scene = makeAnimatedScene();
    const frame = evaluate(scene, frameToTime(5, scene.fps));
    const started = Date.now();
    for (let i = 0; i < 20; i++) await rasteriseFrame(frame);
    const perFrameMs = (Date.now() - started) / 20;

    // Reported, not asserted tightly: this is the number that decides whether a
    // 2550-frame export takes minutes or hours.
    console.log(`[rasterise] mean ${perFrameMs.toFixed(2)} ms/frame at 320x240`);
    expect(perFrameMs).toBeLessThan(500);
  });

  it("covers every shape kind without throwing", async () => {
    const scene: SceneDocument = {
      id: "shapes",
      name: "shapes",
      width: 200,
      height: 200,
      fps: 30,
      durationSeconds: 0.1,
      layers: [
        {
          id: "l",
          name: "l",
          zIndex: 1,
          visible: true,
          opacity: 1,
          rig: {
            id: "r",
            name: "r",
            styleRef: "s",
            styles: { s: { fill: "#ffffff", stroke: "#000000", strokeWidth: 4 } },
            parts: [
              {
                id: "circle",
                zIndex: 0,
                localPosition: { x: 40, y: 40 },
                shapes: [{ kind: "circle", radius: 20 }],
                channels: {},
              },
              {
                id: "ellipse",
                zIndex: 1,
                localPosition: { x: 100, y: 40 },
                shapes: [{ kind: "ellipse", rx: 25, ry: 12 }],
                channels: {},
              },
              {
                id: "capsule",
                zIndex: 2,
                localPosition: { x: 160, y: 40 },
                shapes: [
                  { kind: "capsule", from: { x: -20, y: 0 }, to: { x: 20, y: 0 }, radius: 10 },
                ],
                channels: {},
              },
              {
                id: "rect",
                zIndex: 3,
                localPosition: { x: 60, y: 140 },
                shapes: [
                  { kind: "rect", width: 50, height: 40, rx: 8 },
                  { kind: "rect", width: 30, height: 30 },
                ],
                channels: {},
              },
              {
                id: "pathk",
                zIndex: 4,
                localPosition: { x: 150, y: 140 },
                shapes: [{ kind: "path", d: "M -25 -20 L 25 -20 L 0 25 Z" }],
                channels: {},
              },
            ],
          },
        },
      ],
    };

    const png = await rasteriseFrame(evaluate(scene, 0));
    const stats = await pixelStats(png);
    expect(png.subarray(0, 8).equals(PNG_SIGNATURE)).toBe(true);
    expect(stats.variance).toBeGreaterThan(100);
  });

  it("respects the camera transform", async () => {
    const base = makeStaticScene();
    const zoomed: SceneDocument = {
      ...base,
      camera: {
        channels: { zoom: { kind: "number", keyframes: [{ time: 0, value: 2 }] } },
      },
    };

    const plain = await rasteriseFrame(evaluate(base, 0));
    const withZoom = await rasteriseFrame(evaluate(zoomed, 0));
    // A 2x camera zoom visibly changes the image.
    expect(plain.equals(withZoom)).toBe(false);
  });

  it("is deterministic — the same frame rasterises byte-identically", async () => {
    const scene = makeAnimatedScene();
    const frame = evaluate(scene, frameToTime(7, scene.fps));
    const a = await rasteriseFrame(frame);
    const b = await rasteriseFrame(frame);
    const c = await rasteriseFrame(evaluate(scene, frameToTime(7, scene.fps)));

    expect(a.equals(b)).toBe(true);
    expect(a.equals(c)).toBe(true);
  });

  it("hides parts switched off via the visible channel", async () => {
    const base = makeStaticScene();
    const hidden: SceneDocument = {
      ...base,
      layers: [
        {
          ...base.layers[0]!,
          rig: {
            ...base.layers[0]!.rig!,
            parts: [
              {
                ...base.layers[0]!.rig!.parts[0]!,
                channels: {
                  visible: { kind: "string", keyframes: [{ time: 0, value: "hidden" }] },
                },
              },
            ],
          },
        },
      ],
    };

    const png = await rasteriseFrame(evaluate(hidden, 0));
    const stats = await pixelStats(png);
    // Nothing is drawn, so the canvas stays at the opaque black plate: zero variance.
    expect(stats.variance).toBe(0);
    expect(stats.max).toBe(0);
  });
});