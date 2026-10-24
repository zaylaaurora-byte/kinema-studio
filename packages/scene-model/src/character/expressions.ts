/**
 * Facial expressions for the Silent Human.
 *
 * From the reference sheet: "EXPRESSES EVERYTHING THROUGH FACIAL EXPRESSIONS AND BODY
 * LANGUAGE", and the face is two oval eyes, thick angled eyebrows and an elastic mouth.
 * The sheet shows 20 expressions; this module implements the ones the pilot needs, with
 * eye/brow/mouth channel sets that are all visibly distinct.
 *
 * ---------------------------------------------------------------------------
 * HOW AN EXPRESSION IS EXPRESSED AS CHANNELS
 * ---------------------------------------------------------------------------
 * A facial expression is NOT a separate drawing. It is a set of channel overrides on
 * five existing parts:
 *
 *   eye-left, eye-right   -> `scaleX`, `scaleY` squash/stretch the oval eye
 *   brow-left, brow-right -> `rotation` angles the thick bar, `y` raises/lowers it
 *   mouth                 -> `scaleX`, `scaleY` and `y` shape the elastic mouth
 *
 * Because every one of those is a channel, an expression composes with any pose and any
 * animation, and can be swapped at a keyframe with `step` easing — the discrete-switch
 * behaviour the scene model documents for string channels.
 *
 * ---------------------------------------------------------------------------
 * WHY `y` IS AN ABSOLUTE VALUE, NOT A DELTA
 * ---------------------------------------------------------------------------
 * Channel values REPLACE `localPosition` rather than adding to it (see `evaluateRig`:
 * `sampleNumber(...) ?? part.localPosition.y`). So every `y` here is the final local
 * coordinate, not an offset. The rig's rest values are re-exported below as
 * `FACE_REST` so an expression can be authored as a readable delta and resolved to an
 * absolute value by `applyFace`.
 */

import type { Channel } from "../scene.js";
import { HEAD_RADIUS } from "./human-rig.js";

/** Numeric channel with explicit keyframes. */
function num(...values: readonly number[]): Channel {
  return {
    kind: "number",
    keyframes: values.map((value, index) => ({ time: index, value })),
  };
}

/** A constant numeric channel. */
function at(value: number): Channel {
  return num(value);
}

/**
 * The rest position of each face part inside head-local space.
 *
 * DERIVED from the rig's own head radius rather than hard-coded, so the face cannot
 * silently drift out of the head if the head is ever resized. These mirror the offsets
 * in `buildHumanRig` and are asserted against it by `human-rig.test.ts`.
 */
export const FACE_REST = {
  eyeLeft: { x: HEAD_RADIUS * 0.36, y: HEAD_RADIUS * 0.12 },
  eyeRight: { x: -HEAD_RADIUS * 0.36, y: HEAD_RADIUS * 0.12 },
  browLeft: { x: HEAD_RADIUS * 0.36, y: HEAD_RADIUS * 0.52 },
  browRight: { x: -HEAD_RADIUS * 0.36, y: HEAD_RADIUS * 0.52 },
  mouth: { x: 0, y: -HEAD_RADIUS * 0.34 },
} as const;

/**
 * One expression as channel overrides keyed by part id.
 *
 * Values are FINAL channel values (absolute local coordinates), ready to merge straight
 * into a rig's part channels.
 */
export type ExpressionChannels = Readonly<Record<string, Readonly<Record<string, Channel>>>>;

export interface Expression {
  readonly name: string;
  /** Human-readable note on what the pose communicates, for the storyboard UI. */
  readonly description: string;
  readonly channels: ExpressionChannels;
}

/**
 * Build one expression's channel set from normalised face controls.
 *
 * Every numeric argument is a RATIO of the head radius rather than an absolute
 * distance, so an expression means the same thing on any head size. The pilot may well
 * want a bigger-headed "chibi" variant later; because these are ratios, that variant
 * gets all ten expressions for free instead of needing them re-tuned.
 *
 * Only the properties an expression actually changes are emitted. Anything omitted keeps
 * its rest value from the rig, so an expression never has to restate position channels
 * it does not touch.
 *
 * @param eyeScaleX   horizontal squash of the eye oval
 * @param eyeScaleY   vertical squash of the eye oval (0.4 = heavy lids)
 * @param browRotationDeg angle of the brow bar; sign flips per side so both brows
 *                        express the same emotion
 * @param browDeltaY  how far the brow lifts or drops, in head radii
 * @param eyeDeltaY   how far the whole eye moves, in head radii
 * @param mouthScaleX horizontal stretch of the mouth
 * @param mouthScaleY vertical stretch of the mouth (large = open wail)
 * @param mouthDeltaY vertical mouth offset, in head radii
 * @param mouthRotationDeg tilt of the mouth, for a frown or a smirk
 */
function face(
  eyeScaleX: number,
  eyeScaleY: number,
  browRotationDeg: number,
  browDeltaY: number,
  eyeDeltaY: number,
  mouthScaleX: number,
  mouthScaleY: number,
  mouthDeltaY: number,
  mouthRotationDeg = 0,
): ExpressionChannels {
  const brow = (side: "left" | "right", mirror: number): Readonly<Record<string, Channel>> => ({
    rotation: at((browRotationDeg * mirror * Math.PI) / 180),
    y: at(
      (side === "left" ? FACE_REST.browLeft.y : FACE_REST.browRight.y) +
        browDeltaY * HEAD_RADIUS,
    ),
  });

  const eye = (side: "left" | "right"): Readonly<Record<string, Channel>> => ({
    scaleX: at(eyeScaleX),
    scaleY: at(eyeScaleY),
    y: at(
      (side === "left" ? FACE_REST.eyeLeft.y : FACE_REST.eyeRight.y) + eyeDeltaY * HEAD_RADIUS,
    ),
  });

  return {
    "eye-left": eye("left"),
    "eye-right": eye("right"),
    "brow-left": brow("left", 1),
    // Mirror the brow angle so both brows tilt the same way emotionally (angry brows
    // slant inward, which requires opposite signs in a mirrored layout).
    "brow-right": brow("right", -1),
    mouth: {
      scaleX: at(mouthScaleX),
      scaleY: at(mouthScaleY),
      y: at(FACE_REST.mouth.y + mouthDeltaY * HEAD_RADIUS),
      rotation: at((mouthRotationDeg * Math.PI) / 180),
    },
  };
}

// ---------------------------------------------------------------------------
// The expression library
// ---------------------------------------------------------------------------

/**
 * Neutral resting face. Present so `default` is a first-class expression rather than an
 * absence of one, and so the pilot can always cut back to a clean face.
 */
export const DEFAULT_EXPRESSION: Expression = {
  name: "default",
  description: "Neutral, pleasant, mildly vacant. The resting state.",
  channels: face(1, 1, 0, 0, 0, 1, 1, 0),
};

// Sign conventions, so the table below stays readable:
//   browDeltaY / eyeDeltaY / mouthDeltaY are in HEAD RADII, and +y is UP.
//     positive -> feature moves toward the top of the head
//     negative -> feature moves toward the chin
//   mouthDeltaY negative therefore opens the mouth DOWNWARD, away from the eyes.
//
// Magnitudes are kept small deliberately. The head radius is 11, so a delta of 0.2 is
// about 2.2 units — enough to read as a big change of expression while keeping every
// feature comfortably inside the head circle. Deltas above roughly 0.45 push the eyes
// out through the top of the head, which is why they are avoided.

/** Big open smile: the sheet's HAPPY. */
export const HAPPY: Expression = {
  name: "happy",
  description: "Warm open smile, brows relaxed and slightly raised.",
  channels: face(1, 0.78, -6, 0.08, 0, 1.5, 1.6, -0.14),
};

/** Eyes wide, mouth a big open oval: the sheet's EXCITED. */
export const EXCITED: Expression = {
  name: "excited",
  description: "Eyes wide and tall, mouth wide open in delight.",
  channels: face(1.12, 1.35, -12, 0.14, 0.04, 1.25, 2.4, -0.26),
};

/** Brows up and uneven, mouth a small squiggle: the sheet's CONFUSED. */
export const CONFUSED: Expression = {
  name: "confused",
  description: "One brow cocked, mouth a small uncertain squiggle.",
  channels: face(0.95, 1.05, 16, 0.12, 0.03, 0.7, 0.8, -0.04, 12),
};

/**
 * Tiny eyes, brows high and ANGLED INWARD: the sheet's SCARED.
 *
 * Distinguished from `shocked` by the eyes being shrunken pinpricks rather than wide.
 * The two expressions are close cousins, so they are separated on eye SIZE (0.55 vs
 * 1.3 on scaleY), which is the cue an audience actually reads at a glance.
 */
export const SCARED: Expression = {
  name: "scared",
  description: "Eyes shrunk to pinpricks, brows high and drawn inward, mouth a tight oval.",
  channels: face(0.55, 0.55, -14, 0.14, 0.04, 0.6, 1.3, -0.1),
};

/**
 * Maximum terror: the sheet's PANIC.
 *
 * The brow raise is capped at 0.18 head radii. Beyond roughly 0.2 the brow bar's outer
 * CORNER crosses the head outline, because the bar is wide and the circle curves away
 * from it — the character looks like it has brows growing out of its skull. The eyes
 * carry the panic instead, which is where an audience looks anyway.
 */
export const PANIC: Expression = {
  name: "panic",
  description: "Eyes bulging, brows shot up, mouth a wailing hole.",
  channels: face(1.15, 1.4, -24, 0.16, 0.08, 1.05, 2.8, -0.3),
};

/** Brows angled hard inward and down: the sheet's DETERMINED. */
export const DETERMINED: Expression = {
  name: "determined",
  description: "Brows driven down and inward, eyes narrowed, mouth a flat line.",
  channels: face(1.05, 0.62, 24, -0.12, -0.04, 1.3, 0.35, -0.02),
};

/** Heavy lids, flat mouth, slight droop: the sheet's TIRED. */
export const TIRED: Expression = {
  name: "tired",
  description: "Half-closed eyes, brows drooping outward, small slack mouth.",
  channels: face(1.05, 0.4, -8, -0.05, -0.06, 0.85, 0.9, 0),
};

/** Extra expression: the sheet's SAD, for the fall's punchline beat. */
export const SAD: Expression = {
  name: "sad",
  description: "Brows tilted up at the inner ends, mouth turned down.",
  channels: face(1, 0.85, -22, 0.1, -0.03, 0.95, 0.7, -0.02, -18),
};

/**
 * Extra expression: the sheet's SHOCKED, a useful hard cut.
 *
 * Distinguished from `scared` by the eyes going WIDE and round rather than small, and by
 * a small round mouth instead of a tight oval.
 */
export const SHOCKED: Expression = {
  name: "shocked",
  description: "Everything wide: big round eyes, high straight brows, a small round mouth.",
  channels: face(1.25, 1.3, -14, 0.2, 0.06, 0.62, 1.35, -0.04),
};

/**
 * Every expression, keyed by name.
 *
 * Exported as a frozen record so a caller can do `EXPRESSIONS[name]` for a data-driven
 * cut list, and so tests can iterate all of them.
 */
export const EXPRESSIONS: Readonly<Record<string, Expression>> = Object.freeze({
  default: DEFAULT_EXPRESSION,
  happy: HAPPY,
  excited: EXCITED,
  confused: CONFUSED,
  scared: SCARED,
  panic: PANIC,
  determined: DETERMINED,
  tired: TIRED,
  sad: SAD,
  shocked: SHOCKED,
});

/** Names of all available expressions, in a stable order. */
export const EXPRESSION_NAMES = Object.keys(EXPRESSIONS);

/**
 * Look up an expression, failing loudly on a typo.
 *
 * A missing expression in a cut list is a content bug that should surface at the call
 * site rather than silently rendering a neutral face.
 */
export function getExpression(name: string): Expression {
  const expression = EXPRESSIONS[name];
  if (!expression) {
    throw new Error(
      `Unknown expression "${name}". Available: ${EXPRESSION_NAMES.join(", ")}`,
    );
  }
  return expression;
}

/**
 * Merge one or more expressions' channels in order, later ones winning.
 *
 * Expressed as a pure merge so an expression can be layered over an animation's channel
 * set without either knowing about the other.
 */
export function mergeExpressionChannels(
  ...expressions: readonly Expression[]
): Record<string, Record<string, Channel>> {
  const merged: Record<string, Record<string, Channel>> = {};
  for (const expression of expressions) {
    for (const [partId, channels] of Object.entries(expression.channels)) {
      merged[partId] = { ...(merged[partId] ?? {}), ...channels };
    }
  }
  return merged;
}