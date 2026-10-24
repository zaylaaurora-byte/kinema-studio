import { describe, expect, it } from "vitest";

import { buildHostRig, HOST_POSES, HOST_SKELETON, HOST_STYLES } from "./host-rig.js";
import { anchorOffset, assertConnected, makeSkeleton, shapeBounds } from "./skeleton.js";
import { evaluate, type SceneDocument } from "../scene.js";

/**
 * These tests exist because the host rig rendered BROKEN twice — first as a floating
 * head, then with a detached torso and hovering arms — and both defects were only found
 * by looking at a rendered frame after a ten-second render.
 *
 * The checks below catch those specific defects arithmetically, in milliseconds, so the
 * failure mode cannot recur silently.
 */

describe("skeleton proportions", () => {
  it("derives a head height consistent with the requested head count", () => {
    const s = makeSkeleton({ headCount: 4, headWidth: 100 });
    // Overall height must equal headCount * headHeight.
    expect(s.height).toBeCloseTo(s.headHeight * 4, 6);
  });

  it("places anchors in anatomical order, top to bottom", () => {
    // y increases downward, so each anchor must be strictly below the previous.
    //
    // NOTE: `hem` is deliberately NOT in this chain. A jumper's hem sits ABOVE the hip
    // line, so ordering it after `hip` would be asserting the wrong anatomy — which is
    // exactly what this test did on its first run.
    const s = makeSkeleton({ headCount: 6.5, headWidth: 104 });
    const order = [
      "crown",
      "eyeLine",
      "chin",
      "neckTop",
      "shoulderCentre",
      "chest",
      "hip",
    ] as const;

    for (let i = 1; i < order.length; i++) {
      const previous = s.anchors[order[i - 1]!];
      const current = s.anchors[order[i]!];
      expect(current.y, `${order[i]} should be below ${order[i - 1]}`).toBeGreaterThan(previous.y);
    }

    // The hem is a garment edge, so it sits between the chest and the hip.
    expect(s.anchors.hem.y).toBeLessThan(s.anchors.hip.y);
    expect(s.anchors.hem.y).toBeGreaterThan(s.anchors.chest.y);
  });

  it("puts the eye line in the upper half of the head", () => {
    const s = makeSkeleton({ headCount: 6.5, headWidth: 104 });
    expect(s.anchors.eyeLine.y).toBeGreaterThan(s.anchors.crown.y);
    expect(s.anchors.eyeLine.y).toBeLessThan(s.anchors.chin.y);
    // Conventionally the eyes sit slightly above the vertical middle of the head.
    const midHead = (s.anchors.crown.y + s.anchors.chin.y) / 2;
    expect(s.anchors.eyeLine.y).toBeLessThan(midHead);
  });

  it("places shoulders wider apart than the head", () => {
    const s = HOST_SKELETON;
    const span = s.anchors.shoulderRight.x - s.anchors.shoulderLeft.x;
    expect(span).toBeGreaterThan(s.headWidth);
  });

  it("converts anchors so that 'up' is negative y", () => {
    // The rig's origin is the hip line and the renderer treats negative y as up, so the
    // crown must come out negative.
    const crown = anchorOffset(HOST_SKELETON, "crown");
    expect(crown.y).toBeLessThan(0);
    expect(crown.x).toBeCloseTo(0, 6);
  });
});

describe("host rig connectivity — the guard against the original defect", () => {
  it("has every child part attached inside its parent", () => {
    const rig = buildHostRig(HOST_POSES["default"]!);
    const problems = assertConnected(rig);

    // If this fails, the message names the exact part and the geometry, which is far more
    // useful than discovering it on a contact sheet.
    expect(problems.map((p) => p.message)).toEqual([]);
  });

  it("stays connected across every named pose", () => {
    // Poses vary the body lean and arm raise, which move parts. A pose that disconnected
    // a limb would be a broken pose.
    for (const [name, pose] of Object.entries(HOST_POSES)) {
      const problems = assertConnected(buildHostRig(pose));
      expect(problems.map((p) => `${name}: ${p.message}`)).toEqual([]);
    }
  });

  it("gives the torso real height so limbs have a mass to attach to", () => {
    const rig = buildHostRig(HOST_POSES["default"]!);
    const torso = rig.parts.find((p) => p.id === "torso")!;
    const bounds = shapeBounds(torso.shapes!);
    const height = bounds.max.y - bounds.min.y;
    const width = bounds.max.x - bounds.min.x;

    // A torso shorter than its own width is the "floating head" bug.
    expect(height).toBeGreaterThan(width * 0.6);
    expect(height).toBeGreaterThan(HOST_SKELETON.headHeight * 1.1);
  });

  it("attaches the head above the torso and the arms at shoulder level", () => {
    const rig = buildHostRig(HOST_POSES["default"]!);
    const byId = new Map(rig.parts.map((p) => [p.id, p]));

    const torso = byId.get("torso")!;
    const head = byId.get("head")!;
    const armLeft = byId.get("arm-left")!;
    const armRight = byId.get("arm-right")!;

    // In the torso's local space negative y is up, so the head must sit ABOVE the torso's
    // top edge — not merely above its centre. This is the assertion that catches the
    // "floating head" defect at the arithmetic level.
    const torsoBounds = shapeBounds(torso.shapes!);
    const torsoTop = torso.localPosition.y + torsoBounds.min.y;

    expect(head.localPosition.y, "head must be above the torso's top edge").toBeLessThan(torsoTop);

    // Arms attach near the TOP of the torso, not at or below its middle.
    expect(armLeft.localPosition.y).toBeLessThan(torso.localPosition.y);
    expect(armRight.localPosition.y).toBeLessThan(torso.localPosition.y);
    expect(armLeft.localPosition.y).toBeGreaterThan(torsoTop - 20);
    expect(armRight.localPosition.y).toBeGreaterThan(torsoTop - 20);
  });
});

describe("host poses are genuinely distinct", () => {
  it("provides the twelve poses the reference sheet names", () => {
    const expected = [
      "default", "happy", "laughing", "sarcastic", "curious", "surprised",
      "excited", "annoyed", "bored", "sleepy", "thinking", "maniacal",
    ];
    for (const name of expected) {
      expect(Object.keys(HOST_POSES), `missing pose "${name}"`).toContain(name);
    }
  });

  it("makes at least three poses visibly different in the mouth and eyes", () => {
    // The pilot requires at least three distinct host acting states. Measure it rather
    // than assuming.
    const measure = (name: string) => {
      const rig = buildHostRig(HOST_POSES[name]!);
      const mouth = rig.parts.find((p) => p.id === "mouth")!;
      const bounds = shapeBounds(mouth.shapes!);
      return {
        mouthHeight: bounds.max.y - bounds.min.y,
        mouthWidth: bounds.max.x - bounds.min.x,
      };
    };

    const bored = measure("bored");
    const laughing = measure("laughing");
    const maniacal = measure("maniacal");

    // A closed mouth, an open laugh and a wide grin must all differ substantially.
    expect(laughing.mouthHeight).toBeGreaterThan(bored.mouthHeight * 3);
    expect(maniacal.mouthWidth).toBeGreaterThan(bored.mouthWidth * 1.3);
  });

  it("produces different geometry for different poses", () => {
    const render = (name: string) => JSON.stringify(buildHostRig(HOST_POSES[name]!).parts);
    expect(render("bored")).not.toBe(render("laughing"));
    expect(render("sleepy")).not.toBe(render("maniacal"));
    expect(render("sarcastic")).not.toBe(render("surprised"));
  });

  it("closes the eyes in the sleepy pose and opens them wide when surprised", () => {
    const eyeHeight = (name: string): number => {
      const rig = buildHostRig(HOST_POSES[name]!);
      const eye = rig.parts.find((p) => p.id === "eye-left")!;
      const bounds = shapeBounds(eye.shapes!);
      return bounds.max.y - bounds.min.y;
    };

    expect(eyeHeight("sleepy")).toBeLessThan(eyeHeight("surprised"));
    // A blink must never produce a degenerate zero-size shape.
    expect(eyeHeight("sleepy")).toBeGreaterThan(0);
  });
});

describe("poses hold, rather than drifting", () => {
  it("evaluates to identical geometry across a hold", () => {
    // This is the specific claim of the pose-swap technique: inside a hold nothing moves.
    const rig = buildHostRig(HOST_POSES["sarcastic"]!);
    const scene: SceneDocument = {
      id: "pose-hold",
      name: "hold",
      width: 960,
      height: 540,
      fps: 30,
      durationSeconds: 1,
      layers: [{ id: "host", name: "Host", zIndex: 1, visible: true, opacity: 1, rig }],
    };

    const at0 = JSON.stringify(evaluate(scene, 0).parts.map((p) => p.world));
    const atMid = JSON.stringify(evaluate(scene, 0.5).parts.map((p) => p.world));
    const atEnd = JSON.stringify(evaluate(scene, 1).parts.map((p) => p.world));

    expect(atMid).toBe(at0);
    expect(atEnd).toBe(at0);
  });

  it("every part has a style defined, so nothing renders as an unintended colour", () => {
    const rig = buildHostRig(HOST_POSES["default"]!);
    for (const p of rig.parts) {
      expect(HOST_STYLES[p.id], `no style for part "${p.id}"`).toBeDefined();
    }
  });

  it("styles every part that the rig actually builds — no orphans either way", () => {
    const rig = buildHostRig(HOST_POSES["default"]!);
    const partIds = new Set(rig.parts.map((p) => p.id));
    for (const styledId of Object.keys(HOST_STYLES)) {
      expect(partIds, `style defined for unknown part "${styledId}"`).toContain(styledId);
    }
  });
});