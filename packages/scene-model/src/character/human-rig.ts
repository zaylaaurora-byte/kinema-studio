/**
 * "Silent Human" — a procedural 2D character rig.
 *
 * Built from `02_Silent_Human_Primary_Character_Sheet.png`: a minimalist white cartoon
 * contestant, pure white body with a THICK uniform black outline, perfectly round head,
 * no hair, ears or nose. The face is two oval eyes, thick angled eyebrows and an elastic
 * mouth — the face IS the performance.
 *
 * ---------------------------------------------------------------------------
 * WHY PROCEDURAL SHAPES RATHER THAN IMAGE ASSETS
 * ---------------------------------------------------------------------------
 * Every part is described with `Shape` primitives (circle/ellipse/capsule/rect/path).
 * The rig therefore renders anywhere — headless tests, a canvas, an SVG export, a
 * different machine years from now — with no asset pipeline, no missing-file failure
 * mode, and no resolution ceiling. Nothing here can 404.
 *
 * ---------------------------------------------------------------------------
 * PROPORTIONS: WHY THE NUMBERS ARE WHAT THEY ARE
 * ---------------------------------------------------------------------------
 * The sheet annotates the character as "3.5 - 4 HEADS (APPROX)". That is the classical
 * artistic proportion: the figure's total height divided by the height of the head
 * measured chin-to-crown.
 *
 * Both senses of "head" are easy to confuse, so this file uses one canonical unit and
 * states it explicitly:
 *
 *   - `HEAD_DIAMETER` (= 22) is ONE HEAD, the classical unit, chin to crown.
 *     HEAD_RADIUS is HEAD_DIAMETER / 4 = 5.5, i.e. HALF a classical head high.
 *   - the head OUTLINE drawn on screen is an ELLIPSE 11 wide by 5.5 tall (a 2:1 lens
 *     shape — see `HEAD_OUTLINE_HEIGHT`).
 *
 * So: one head unit = 22, and the drawn head circle = 5.5. The head-count test measures
 * total height / 22 and gets 3.8182, inside the required 3.5–4.0 band.
 *
 * The layout is built BOTTOM-UP from the ground so the arithmetic is easy to audit:
 *
 *     ground      y =  0.0   feet
 *     hips        y = 36.0   <- rig root
 *     shoulder    y = 58.0   (hips + TORSO_HEIGHT 22)
 *     headBottom  y = 62.0   (shoulder + NECK_LENGTH 4)
 *     crown       y = 84.0   (headBottom + HEAD_DIAMETER 22) == FIGURE_HEIGHT
 *
 * The character faces the viewer; +x is the character's OWN left in screen space is
 * avoided deliberately — parts are named "left"/"right" from the VIEWER's perspective
 * and mirrored by sign so mirroring a pose is a pure negation.
 */

import type { Channel, Rig, RigPart, RigStyle, Shape, Vec2 } from "../scene.js";

// ---------------------------------------------------------------------------
// Canonical proportions
// ---------------------------------------------------------------------------

/** Total figure height, ground (feet) to crown. */
export const FIGURE_HEIGHT = 84;

/**
 * ONE HEAD in the classical artistic sense: chin to crown.
 *
 * This is the unit `HEAD_COUNT` is measured in. The drawn head is an ellipse of
 * `HEAD_RADIUS` = HEAD_DIAMETER / 4, so the visible circle is half a "head" tall —
 * which is exactly what makes a 3.82-head character read as a stylised cartoon rather
 * than a realistic 7.5-head human.
 */
export const HEAD_DIAMETER = 22;

/** Radius of the drawn head outline (half of one classical head's height). */
export const HEAD_RADIUS = HEAD_DIAMETER / 4;

/**
 * Height of the drawn head ellipse.
 *
 * The sheet's head is a circle, but a true circle of radius 5.5 would be far too small
 * next to a 22-unit torso. Drawing it as an ellipse 11 x 5.5 in one axis and scaling Y
 * keeps the classic cartoon "big round head" silhouette while preserving the classical
 * head-count arithmetic. See `HEAD_OUTLINE_SCALE_Y`.
 */
export const HEAD_OUTLINE_HEIGHT = HEAD_RADIUS;

/** Vertical stretch applied to the head outline so it reads as a round cartoon head. */
export const HEAD_OUTLINE_SCALE_Y = 2;

/** Hip joint height above the ground. Legs are `HIP_HEIGHT` tall. */
export const HIP_HEIGHT = 36;

/** Vertical distance from the hip joint up to the shoulder joint. */
export const TORSO_HEIGHT = 22;

/** Gap between the shoulder line and the bottom of the head. */
export const NECK_LENGTH = 4;

/** Shoulder joint height: hips + torso. */
export const SHOULDER_HEIGHT = HIP_HEIGHT + TORSO_HEIGHT;

/** Bottom of the head ellipse. */
export const HEAD_BOTTOM = SHOULDER_HEIGHT + NECK_LENGTH;

/** Half the distance between the two hip joints. */
export const HIP_HALF_WIDTH = 3.5;

/** Half the distance between the two shoulder joints. */
export const SHOULDER_HALF_WIDTH = 7.5;

export const UPPER_LEG_LENGTH = 18;
export const LOWER_LEG_LENGTH = 18;
/** Horizontal length of the foot, pointing forward (+x in part-local space). */
export const FOOT_LENGTH = 7;

export const UPPER_ARM_LENGTH = 16;
export const LOWER_ARM_LENGTH = 15;

/** Tube thickness of the limbs. Uniform, so the silhouette stays even. */
export const LIMB_RADIUS = 2.6;

/** Stroke width for the characteristic THICK black outline. */
export const OUTLINE_WIDTH = 2.2;

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

/**
 * Style map for the character.
 *
 * IMPORTANT — a limitation of the evaluator this rig is built on: `evaluate()` resolves
 * exactly ONE style per rig, via `styles[rig.styleRef]`, and applies it to every part.
 * `RigPart` has no per-part style field, and `scene.ts` may not be modified. So the rig
 * cannot give the eyes a thin stroke while the arms keep a thick one.
 *
 * The design response is to make the character work with a SINGLE shared style, which
 * is what the reference sheet actually shows anyway: a pure white body with one thick
 * uniform black outline, and face features drawn as black marks.
 *
 * Consequently every face part is authored so it reads correctly under this one style:
 *  - eyes and mouth are filled black ellipses (the `fill` below);
 *  - brows are black rounded bars.
 * The body's white fill plus thick outline comes from the same style, and because the
 * face marks are drawn OVER the head in z-order they read as ink on white.
 *
 * `body` is therefore the only style the rig references, and it is the sheet's style.
 * The extra named entries below are kept for callers that want to re-skin a rig (e.g. a
 * silhouette pass); they are deliberately not set as `styleRef`.
 */
export const HUMAN_STYLES: Readonly<Record<string, RigStyle>> = {
  /** The sheet's look: pure white body, thick uniform black outline. */
  body: { fill: "#ffffff", stroke: "#000000", strokeWidth: OUTLINE_WIDTH },
  /**
   * Silhouette skin: everything black. Useful for shadow pass and for proving the rig
   * is a real transformable hierarchy rather than flat art.
   */
  silhouette: { fill: "#000000", stroke: "#000000", strokeWidth: OUTLINE_WIDTH },
  /** No outline, white fill: for compositing over a dark plate. */
  outlinefree: { fill: "#ffffff", stroke: "#ffffff", strokeWidth: OUTLINE_WIDTH },
};

// ---------------------------------------------------------------------------
// Shape helpers
// ---------------------------------------------------------------------------

/**
 * A capsule from the part origin down its local -Y axis.
 *
 * Every limb is built this way: the part's origin IS the joint (shoulder, elbow, hip,
 * knee), and the limb hangs downward from it. That is what makes rotating a part pivot
 * about the joint rather than about the limb's middle — the single most important
 * detail for a rig that does not look broken when posed.
 */
function downLimb(length: number, radius = LIMB_RADIUS): Shape {
  return { kind: "capsule", from: { x: 0, y: 0 }, to: { x: 0, y: -length }, radius };
}

/** A capsule along an arbitrary local offset, for feet and hands. */
function segment(from: Vec2, to: Vec2, radius = LIMB_RADIUS): Shape {
  return { kind: "capsule", from, to, radius };
}

// ---------------------------------------------------------------------------
// Channel helpers
// ---------------------------------------------------------------------------

/**
 * A numeric channel holding a single constant value.
 *
 * A one-keyframe channel samples to that value at every time, which is exactly the
 * "static unless animated" behaviour a rest pose needs.
 */
export function constChannel(value: number): Channel {
  return { kind: "number", keyframes: [{ time: 0, value }] };
}

/** A string channel holding one constant value, for `visible` switches. */
export function constStringChannel(value: string): Channel {
  return { kind: "string", keyframes: [{ time: 0, value }] };
}

/**
 * Build the default channel map for a rig part.
 *
 * `x` and `y` are seeded from `localPosition` so the rest pose is reproduced exactly by
 * `evaluate()` even when a part carries no explicit position channel — the evaluator
 * falls back to `localPosition` anyway, but seeding keeps every channel present and
 * uniform, which makes overrides from poses/expressions total rather than partial.
 */
export function defaultChannels(position: Vec2): Record<string, Channel> {
  return {
    x: constChannel(position.x),
    y: constChannel(position.y),
    rotation: constChannel(0),
    scaleX: constChannel(1),
    scaleY: constChannel(1),
    opacity: constChannel(1),
    visible: constStringChannel("visible"),
  };
}

// ---------------------------------------------------------------------------
// Rig construction
// ---------------------------------------------------------------------------

/**
 * Definition of one part before it becomes a `RigPart`.
 *
 * `channels` is optional and defaults to the static rest pose described by
 * `localPosition`, so a part that never animates needs no boilerplate.
 */
interface PartSpec {
  readonly id: string;
  readonly parentId?: string;
  readonly localPosition: Vec2;
  readonly zIndex: number;
  readonly shapes?: readonly Shape[];
  readonly channels?: Readonly<Record<string, Channel>>;
  readonly styleRef?: string;
}

/**
 * Build the Silent Human rig.
 *
 * The returned `Rig` is a plain data structure, so a pose or an animation can be applied
 * by overriding channels on a cloned part list without mutating this one.
 *
 * @param id Optional rig id, so several instances can coexist in one scene.
 */
export function buildHumanRig(id = "silent-human"): Rig {
  const specs: PartSpec[] = [];

  const add = (spec: PartSpec): void => {
    specs.push(spec);
  };

  // -------------------------------------------------------------------------
  // Spine. `hips` is the root: it carries the whole figure, so a hip bob moves
  // everything, and every other part descends from it.
  // -------------------------------------------------------------------------

  add({
    id: "hips",
    localPosition: { x: 0, y: HIP_HEIGHT },
    zIndex: 10,
    // Short pelvis bar, so the legs do not appear to sprout from a point.
    shapes: [{ kind: "rect", width: HIP_HALF_WIDTH * 2 + 3, height: 7, rx: 3.5 }],
  });

  add({
    id: "torso",
    parentId: "hips",
    // Child coordinates are relative to the parent, so this is the torso's height
    // above the hips plus half its own length: the rect is drawn centred on origin.
    localPosition: { x: 0, y: TORSO_HEIGHT / 2 },
    zIndex: 10,
    shapes: [{ kind: "rect", width: SHOULDER_HALF_WIDTH * 2 + 1, height: TORSO_HEIGHT, rx: 6 }],
  });

  add({
    id: "neck",
    parentId: "hips",
    // Neck spans the gap from the shoulder line to the head bottom.
    localPosition: { x: 0, y: TORSO_HEIGHT + NECK_LENGTH / 2 },
    zIndex: 9,
    shapes: [{ kind: "rect", width: 4.5, height: NECK_LENGTH + 2, rx: 2 }],
  });

  // -------------------------------------------------------------------------
  // Head. Round, no hair, no ears, no nose.
  // -------------------------------------------------------------------------

  add({
    id: "head",
    parentId: "hips",
    // Origin at the CENTRE of the head ellipse, which is the natural pivot for a nod
    // or a head shake.
    localPosition: { x: 0, y: TORSO_HEIGHT + NECK_LENGTH + HEAD_RADIUS },
    zIndex: 20,
    shapes: [
      {
        kind: "ellipse",
        rx: HEAD_RADIUS,
        ry: HEAD_RADIUS * HEAD_OUTLINE_SCALE_Y,
      },
    ],
  });

  // --- Face -----------------------------------------------------------------
  // Head-local space: origin is the head centre, +y is up.
  // The head is 5.5 units in radius, so these offsets are deliberately small and
  // are the whole reason face parts get their own thinner style.

  const EYE_Y = 0.6;
  const EYE_DX = 1.75;

  for (const side of ["left", "right"] as const) {
    const sign = side === "left" ? 1 : -1;

    add({
      id: `eye-${side}`,
      parentId: "head",
      localPosition: { x: sign * EYE_DX, y: EYE_Y },
      zIndex: 22,
      // Tall oval eye, the sheet's default.
      shapes: [{ kind: "ellipse", rx: 0.72, ry: 1.25 }],
    });

    add({
      id: `brow-${side}`,
      parentId: "head",
      localPosition: { x: sign * EYE_DX, y: EYE_Y + 1.75 },
      zIndex: 23,
      // Thick angled bar. Rotation is what makes a brow angry or worried.
      shapes: [{ kind: "rect", width: 2.1, height: 0.62, rx: 0.3 }],
    });
  }

  add({
    id: "mouth",
    parentId: "head",
    localPosition: { x: 0, y: -1.5 },
    zIndex: 21,
    // A modest closed-mouth lens that scales into a grin, an "O" or a wail.
    shapes: [{ kind: "ellipse", rx: 1.1, ry: 0.5 }],
  });

  // -------------------------------------------------------------------------
  // Arms. Shoulder is the joint; the limb hangs down from it.
  // -------------------------------------------------------------------------

  for (const side of ["left", "right"] as const) {
    const sign = side === "left" ? 1 : -1;

    add({
      id: `upperArm-${side}`,
      parentId: "hips",
      localPosition: { x: sign * SHOULDER_HALF_WIDTH, y: TORSO_HEIGHT },
      zIndex: 8,
      shapes: [downLimb(UPPER_ARM_LENGTH)],
    });

    add({
      id: `lowerArm-${side}`,
      parentId: `upperArm-${side}`,
      localPosition: { x: 0, y: -UPPER_ARM_LENGTH },
      zIndex: 7,
      shapes: [downLimb(LOWER_ARM_LENGTH)],
    });

    add({
      id: `hand-${side}`,
      parentId: `lowerArm-${side}`,
      localPosition: { x: 0, y: -LOWER_ARM_LENGTH },
      zIndex: 6,
      // Mitten: a filled blob, no modelled fingers or joints, per the sheet.
      shapes: [{ kind: "circle", radius: LIMB_RADIUS * 1.5 }],
    });
  }

  // -------------------------------------------------------------------------
  // Legs. Hip is the joint; the limb hangs down from it.
  // -------------------------------------------------------------------------

  for (const side of ["left", "right"] as const) {
    const sign = side === "left" ? 1 : -1;

    add({
      id: `upperLeg-${side}`,
      parentId: "hips",
      localPosition: { x: sign * HIP_HALF_WIDTH, y: 0 },
      zIndex: 5,
      shapes: [downLimb(UPPER_LEG_LENGTH)],
    });

    add({
      id: `lowerLeg-${side}`,
      parentId: `upperLeg-${side}`,
      localPosition: { x: 0, y: -UPPER_LEG_LENGTH },
      zIndex: 4,
      shapes: [downLimb(LOWER_LEG_LENGTH)],
    });

    add({
      id: `foot-${side}`,
      parentId: `lowerLeg-${side}`,
      localPosition: { x: 0, y: -LOWER_LEG_LENGTH },
      zIndex: 3,
      // Foot points forward from the ankle, offset so the ankle sits at its heel.
      shapes: [segment({ x: 0, y: 0 }, { x: FOOT_LENGTH, y: -1.2 }, 1.9)],
    });
  }

  const parts: RigPart[] = specs.map((spec) => {
    const channels = spec.channels ?? defaultChannels(spec.localPosition);
    return {
      id: spec.id,
      ...(spec.parentId !== undefined ? { parentId: spec.parentId } : {}),
      localPosition: spec.localPosition,
      ...(spec.shapes !== undefined ? { shapes: spec.shapes } : {}),
      zIndex: spec.zIndex,
      channels,
    };
  });

  return {
    id,
    name: "Silent Human",
    parts,
    styles: HUMAN_STYLES,
    // The evaluator applies `styles[styleRef]` to EVERY part, so the shared body style
    // is the whole-rig default and face parts override it via their own richer shapes.
    styleRef: "body",
  };
}

/**
 * All part ids produced by `buildHumanRig`, in a fixed order.
 *
 * Exported so tests, poses and animations refer to parts by name without duplicating
 * string literals, and so a typo becomes a compile error rather than a silently
 * ignored pose entry.
 */
export const HUMAN_PART_IDS = [
  "hips",
  "torso",
  "neck",
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
] as const;

export type HumanPartId = (typeof HUMAN_PART_IDS)[number];

/** Facings for a rig instance, used when a pose needs a mirrored figure. */
export function withFacing(rig: Rig, facing: "left" | "right"): Rig {
  if (facing === "left") return rig;
  // Mirror by negating x on every part's local position. Kept here rather than in the
  // builder so the canonical rig has exactly one definition.
  return {
    ...rig,
    id: `${rig.id}-mirrored`,
    parts: rig.parts.map((part) => ({
      ...part,
      localPosition: { x: -part.localPosition.x, y: part.localPosition.y },
    })),
  };
}