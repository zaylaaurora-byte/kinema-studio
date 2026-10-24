/**
 * Test-only rig builder.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS EXISTS IN THE TEST FOLDER
 * ---------------------------------------------------------------------------
 * `evaluate()` lives in `@kinema/scene-model`, whose public entry point exports ONLY
 * `scene.ts`. The character rig builder in `packages/scene-model/src/character/` is real
 * code but is not reachable from the package's exports, and this task explicitly forbids
 * modifying `packages/scene-model/`.
 *
 * So the tests build their own rig here. That is not a workaround that weakens the test —
 * it strengthens it in one specific way: it proves the part-id contract in `library/human.ts`
 * is SUFFICIENT, i.e. that a rig can actually be built with those ids and animated by these
 * poses. A test that reached into unexported internals would prove nothing about the
 * contract a real caller has to satisfy.
 *
 * The rig follows the same convention the libraries document:
 *   - a limb part's origin is AT ITS JOINT and its shape hangs down local -Y;
 *   - "left"/"right" are the viewer's, with left at positive x.
 */

import type { Channel, Rig, RigPart, Shape } from "@kinema/scene-model";
import { HUMAN_PART_IDS } from "./library/human.js";

const P = HUMAN_PART_IDS;

/** A single-keyframe numeric channel: a resting value that holds at every time. */
function rest(value: number): Channel {
  return { kind: "number", keyframes: [{ time: 0, value }] };
}

/** A capsule hanging down the local -Y axis from the part origin. */
function downLimb(length: number, radius = 3): Shape {
  return { kind: "capsule", from: { x: 0, y: 0 }, to: { x: 0, y: -length }, radius };
}

interface Spec {
  readonly id: string;
  readonly parentId?: string;
  readonly position: { readonly x: number; readonly y: number };
  readonly zIndex: number;
  readonly shapes?: readonly Shape[];
}

/**
 * Build a rig carrying every part id the human library references.
 *
 * Proportions mirror the reference sheet's constraint — a round head and a 3.5-4 head
 * figure — but the exact numbers do not matter for these tests, which assert on
 * OBSERVABLE EVALUATOR BEHAVIOUR (do transforms move between samples?) rather than on
 * pixel geometry.
 */
export function buildTestHumanRig(id = "test-human"): Rig {
  const specs: Spec[] = [
    { id: P.hips, position: { x: 0, y: 36 }, zIndex: 10, shapes: [{ kind: "rect", width: 12, height: 7, rx: 3.5 }] },
    { id: P.torso, parentId: P.hips, position: { x: 0, y: 11 }, zIndex: 10, shapes: [downLimb(22, 7.2)] },
    { id: P.neck, parentId: P.hips, position: { x: 0, y: 24 }, zIndex: 9, shapes: [downLimb(4, 3.2)] },
    { id: P.head, parentId: P.hips, position: { x: 0, y: 15 + 11 }, zIndex: 20, shapes: [{ kind: "circle", radius: 11 }] },
    { id: P.eyeLeft, parentId: P.head, position: { x: 4, y: 1.3 }, zIndex: 22, shapes: [{ kind: "circle", radius: 1.8 }] },
    { id: P.eyeRight, parentId: P.head, position: { x: -4, y: 1.3 }, zIndex: 22, shapes: [{ kind: "circle", radius: 1.8 }] },
    { id: P.browLeft, parentId: P.head, position: { x: 4, y: 5.7 }, zIndex: 23, shapes: [{ kind: "rect", width: 5, height: 1.2, rx: 0.6 }] },
    { id: P.browRight, parentId: P.head, position: { x: -4, y: 5.7 }, zIndex: 23, shapes: [{ kind: "rect", width: 5, height: 1.2, rx: 0.6 }] },
    { id: P.mouth, parentId: P.head, position: { x: 0, y: -3.7 }, zIndex: 21, shapes: [{ kind: "ellipse", rx: 2.6, ry: 1.3 }] },
    { id: P.upperArmLeft, parentId: P.hips, position: { x: 9.5, y: 22 }, zIndex: 8, shapes: [downLimb(16)] },
    { id: P.lowerArmLeft, parentId: P.upperArmLeft, position: { x: 0, y: -16 }, zIndex: 7, shapes: [downLimb(15)] },
    { id: P.handLeft, parentId: P.lowerArmLeft, position: { x: 0, y: -15 }, zIndex: 6, shapes: [{ kind: "circle", radius: 4.5 }] },
    { id: P.upperArmRight, parentId: P.hips, position: { x: -9.5, y: 22 }, zIndex: 8, shapes: [downLimb(16)] },
    { id: P.lowerArmRight, parentId: P.upperArmRight, position: { x: 0, y: -16 }, zIndex: 7, shapes: [downLimb(15)] },
    { id: P.handRight, parentId: P.lowerArmRight, position: { x: 0, y: -15 }, zIndex: 6, shapes: [{ kind: "circle", radius: 4.5 }] },
    { id: P.upperLegLeft, parentId: P.hips, position: { x: 4.2, y: 0 }, zIndex: 5, shapes: [downLimb(18)] },
    { id: P.lowerLegLeft, parentId: P.upperLegLeft, position: { x: 0, y: -18 }, zIndex: 4, shapes: [downLimb(18)] },
    { id: P.footLeft, parentId: P.lowerLegLeft, position: { x: 0, y: -18 }, zIndex: 3, shapes: [downLimb(7, 1.9)] },
    { id: P.upperLegRight, parentId: P.hips, position: { x: -4.2, y: 0 }, zIndex: 5, shapes: [downLimb(18)] },
    { id: P.lowerLegRight, parentId: P.upperLegRight, position: { x: 0, y: -18 }, zIndex: 4, shapes: [downLimb(18)] },
    { id: P.footRight, parentId: P.lowerLegRight, position: { x: 0, y: -18 }, zIndex: 3, shapes: [downLimb(7, 1.9)] },
  ];

  const parts: RigPart[] = specs.map((spec): RigPart => ({
    id: spec.id,
    ...(spec.parentId !== undefined ? { parentId: spec.parentId } : {}),
    localPosition: { x: spec.position.x, y: spec.position.y },
    ...(spec.shapes !== undefined ? { shapes: spec.shapes } : {}),
    zIndex: spec.zIndex,
    channels: {
      x: rest(spec.position.x),
      y: rest(spec.position.y),
      rotation: rest(0),
      scaleX: rest(1),
      scaleY: rest(1),
    },
  }));

  return {
    id,
    name: "Test Human",
    parts,
    styles: { body: { fill: "#ffffff", stroke: "#000000", strokeWidth: 2.2 } },
    styleRef: "body",
  };
}

/** A rig with no styles, for tests that only care about transforms. */
export function buildBareRig(): Rig {
  return {
    id: "bare",
    name: "Bare",
    parts: [
      {
        id: P.hips,
        localPosition: { x: 0, y: 36 },
        zIndex: 1,
        channels: { x: rest(0), y: rest(36), rotation: rest(0) },
      },
      {
        id: P.head,
        parentId: P.hips,
        localPosition: { x: 0, y: 26 },
        zIndex: 2,
        channels: { x: rest(0), y: rest(26), rotation: rest(0) },
      },
    ],
  };
}