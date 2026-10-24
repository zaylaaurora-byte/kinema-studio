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
 * The sheet annotates the character as "3.5 - 4 HEADS (APPROX)" and draws the head as a
 * PERFECTLY ROUND circle with no hair, ears or nose. Those two facts together fix the
 * geometry, because they mean the head circle's DIAMETER is the head unit:
 *
 *     head unit  = HEAD_DIAMETER = 22   (the drawn circle's diameter)
 *     figure     = 84                   (ground to crown)
 *     head count = 84 / 22 = 3.8182     -> inside the required 3.5 - 4.0 band
 *
 * An earlier draft of this file treated the head unit as twice the drawn radius, which
 * forced the head to be drawn as a tall ellipse to make the arithmetic work. That made
 * the character look like an egg-headed alien and directly contradicted the sheet, which
 * is emphatic that the head is round. The unit above is the reading that satisfies both
 * constraints at once, and the rendered result is a round head.
 *
 * The layout is built BOTTOM-UP from the ground so the arithmetic is easy to audit:
 *
 *     ground      y =  0.0   feet
 *     ankle       y =  0.0   (foot rests on the ground)
 *     knee        y = 18.0
 *     hips        y = 36.0   <- rig root
 *     shoulder    y = 58.0   (hips + TORSO_HEIGHT 22)
 *     headBottom  y = 62.0   (shoulder + NECK_LENGTH 4)
 *     crown       y = 84.0   (headBottom + HEAD_DIAMETER 22) == FIGURE_HEIGHT
 *
 * The character faces the viewer. Parts are named "left"/"right" from the VIEWER's
 * perspective and mirrored by sign, so mirroring a pose is a pure negation.
 */

import type { Channel, Rig, RigPart, RigStyle, Shape, Vec2 } from "../scene.js";

// ---------------------------------------------------------------------------
// Canonical proportions
// ---------------------------------------------------------------------------

/** Total figure height, ground (feet) to crown. */
export const FIGURE_HEIGHT = 84;

/**
 * The head unit: the DIAMETER of the drawn head circle, and therefore the unit that
 * "3.5 - 4 heads" is measured in.
 *
 * `FIGURE_HEIGHT / HEAD_DIAMETER` = 84 / 22 = 3.8182 heads.
 */
export const HEAD_DIAMETER = 22;

/** Radius of the drawn head circle. */
export const HEAD_RADIUS = HEAD_DIAMETER / 2;

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
export const HIP_HALF_WIDTH = 4.2;

/**
 * Half the distance between the two shoulder joints.
 *
 * Set wider than the torso radius so the arms hang clear of the body rather than
 * merging into it. On the sheet there is always a visible outline gap between arm and
 * torso, and that gap is most of what makes the silhouette readable.
 */
export const SHOULDER_HALF_WIDTH = 9.5;

/** Radius of the soft tube torso. */
export const TORSO_HALF_WIDTH = 7.2;

export const UPPER_LEG_LENGTH = 18;
export const LOWER_LEG_LENGTH = 18;
/** Horizontal length of the foot, pointing forward (+x in part-local space). */
export const FOOT_LENGTH = 7;

/** Length of the upper arm, shoulder joint to elbow. */
export const UPPER_ARM_LENGTH = 16;
/** Length of the forearm, elbow to wrist. */
export const LOWER_ARM_LENGTH = 15;

/**
 * Tube thickness of the limbs.
 *
 * Deliberately chunky: the sheet's limbs are fat noodles, not anatomical arms. A thin
 * limb next to a thick outline reads as a stick figure, which is the wrong character.
 */
export const LIMB_RADIUS = 3.0;

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
    // A soft capsule torso rather than a hard box: the sheet's body is a rounded tube
    // that tapers into the hips, with no modelled chest or waist.
    shapes: [
      {
        kind: "capsule",
        from: { x: 0, y: -TORSO_HEIGHT / 2 },
        to: { x: 0, y: TORSO_HEIGHT / 2 },
        radius: TORSO_HALF_WIDTH,
      },
    ],
  });

  add({
    id: "neck",
    parentId: "hips",
    // Neck spans the gap from the shoulder line to the head bottom, and is drawn a
    // little long so it tucks under the head circle rather than floating short of it.
    localPosition: { x: 0, y: TORSO_HEIGHT + NECK_LENGTH / 2 },
    zIndex: 9,
    shapes: [
      {
        kind: "capsule",
        from: { x: 0, y: -NECK_LENGTH },
        to: { x: 0, y: NECK_LENGTH },
        radius: 3.2,
      },
    ],
  });

  // -------------------------------------------------------------------------
  // Head. Round, no hair, no ears, no nose — a true circle.
  // -------------------------------------------------------------------------

  add({
    id: "head",
    parentId: "hips",
    // Origin at the CENTRE of the head circle, which is the natural pivot for a nod
    // or a head shake. Head bottom sits at TORSO_HEIGHT + NECK_LENGTH, so the centre
    // is one radius above that.
    localPosition: { x: 0, y: TORSO_HEIGHT + NECK_LENGTH + HEAD_RADIUS },
    zIndex: 20,
    shapes: [{ kind: "circle", radius: HEAD_RADIUS }],
  });

  // --- Face -----------------------------------------------------------------
  //
  // Head-local space: origin is the head centre, +y is up.
  //
  // HOW THE FACE IS DRAWN, GIVEN THE ONE-STYLE-PER-RIG LIMIT
  // --------------------------------------------------------
  // `evaluate()` applies a single style to the whole rig, so the face parts cannot be
  // given a black fill of their own — they inherit the white body fill, which would
  // render the eyes as white blobs on a white head.
  //
  // The way out is to draw the face the way ink actually works: as STROKED LINES with
  // no fill. The shared style's stroke is black and its fill is white, so a closed
  // `path` outline reads as a black mark on the white head. Every feature below is
  // therefore a `path` that traces a shape, plus a second concentric path where the
  // mark needs thickness.
  //
  // This also means an expression's `scaleY` on an eye squashes a black outline, which
  // is exactly the "elastic" behaviour the sheet describes for both eyes and mouth.

  const EYE_Y = HEAD_RADIUS * 0.12;
  const EYE_DX = HEAD_RADIUS * 0.36;
  const EYE_RX = HEAD_RADIUS * 0.17;
  const EYE_RY = HEAD_RADIUS * 0.26;
  // Brows sit clearly above the eyes with a visible gap, and are thinner than they are
  // wide so they read as expressive bars rather than a solid fringe.
  const BROW_Y = HEAD_RADIUS * 0.52;
  const BROW_HALF_W = HEAD_RADIUS * 0.24;
  const BROW_HALF_H = HEAD_RADIUS * 0.055;
  // Mouth sits between the eyes and the chin, biased toward the chin as on the sheet.
  const MOUTH_Y = -HEAD_RADIUS * 0.34;
  const MOUTH_RX = HEAD_RADIUS * 0.24;
  const MOUTH_RY = HEAD_RADIUS * 0.12;

  /**
   * A closed ellipse traced as a path, so it renders as an outline rather than a fill.
   *
   * Two half-arcs, which is the standard way to express an ellipse in SVG path data
   * without needing the `ellipse` element's fill.
   */
  const ellipsePath = (rx: number, ry: number): Shape => ({
    kind: "path",
    d:
      `M ${-rx} 0 A ${rx} ${ry} 0 0 1 ${rx} 0 ` +
      `A ${rx} ${ry} 0 0 1 ${-rx} 0 Z`,
  });

  for (const side of ["left", "right"] as const) {
    const sign = side === "left" ? 1 : -1;

    add({
      id: `eye-${side}`,
      parentId: "head",
      localPosition: { x: sign * EYE_DX, y: EYE_Y },
      zIndex: 22,
      // Tall oval eye. Drawn twice: an outer ring plus a tighter inner ring, so the eye
      // reads as a heavy ink mark at small sizes instead of a hairline.
      shapes: [ellipsePath(EYE_RX, EYE_RY), ellipsePath(EYE_RX * 0.55, EYE_RY * 0.55)],
    });

    add({
      id: `brow-${side}`,
      parentId: "head",
      localPosition: { x: sign * EYE_DX, y: BROW_Y },
      zIndex: 23,
      // A slim horizontal bar drawn as a closed path. Rotation is what makes a brow
      // angry, worried or smug; the bar is wider than it is tall so that rotation reads
      // as a change of angle rather than a change of size.
      shapes: [
        {
          kind: "path",
          d:
            `M ${-BROW_HALF_W} ${BROW_HALF_H} L ${BROW_HALF_W} ${BROW_HALF_H} ` +
            `L ${BROW_HALF_W} ${-BROW_HALF_H} L ${-BROW_HALF_W} ${-BROW_HALF_H} Z`,
        },
      ],
    });
  }

  add({
    id: "mouth",
    parentId: "head",
    localPosition: { x: 0, y: MOUTH_Y },
    zIndex: 21,
    // A lens-shaped mouth, drawn as a closed path. Scaling it stretches the grin; the
    // same part squashed flat is a grimace and stretched tall is a wail.
    shapes: [ellipsePath(MOUTH_RX, MOUTH_RY)],
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