/**
 * Mouth flaps for the Silent Human.
 *
 * ---------------------------------------------------------------------------
 * WHY MOUTH FLAPS, NOT LIP-SYNC
 * ---------------------------------------------------------------------------
 * The show is limited 2D animation: talking is performed by swapping between a small
 * closed set of mouth SHAPES on a beat. There is no jaw to interpolate and no phoneme
 * model to solve — a mouth flap is a discrete state, held for a beat, then swapped.
 * That is exactly what the scene model's `step` easing and string channels exist for.
 *
 * ---------------------------------------------------------------------------
 * HOW A FLAP IS REPRESENTED
 * ---------------------------------------------------------------------------
 * Two complementary representations, because they answer different questions:
 *
 *  1. **Shape selection** (`MOUTH_FLAP_SHAPES`) — each flap id maps to a `Shape` for the
 *     mouth part. This is what a renderer actually draws, and it is how the flaps stay
 *     visually distinct rather than being one ellipse at six scales.
 *
 *  2. **Channel overrides** (`MOUTH_FLAPS`) — each flap id maps to `scaleX`/`scaleY`/`y`
 *     channels on the `mouth` part. This is what a keyframed scene needs, and it is how
 *     a flap composes with an expression's other channels.
 *
 * Both are keyed by the same six ids, so switching between the two is a lookup.
 *
 * The six states are the ones the show needs: `closed`, `openSmall`, `openWide`,
 * `oShape`, `teeth`, `smile`.
 */

import type { Channel, Shape } from "../scene.js";
import { HEAD_RADIUS } from "./human-rig.js";

/** The six mouth states. A closed set, so a flap track cannot name a missing shape. */
export const MOUTH_FLAP_IDS = [
  "closed",
  "openSmall",
  "openWide",
  "oShape",
  "teeth",
  "smile",
] as const;

export type MouthFlapId = (typeof MOUTH_FLAP_IDS)[number];

/** A constant numeric channel. */
function at(value: number): Channel {
  return { kind: "number", keyframes: [{ time: 0, value }] };
}

/**
 * Closed lens mouth traced as a path.
 *
 * Drawn as a path rather than a primitive for consistency with every other face mark:
 * the rig has one shared style, so face features are stroked outlines rather than
 * filled primitives. See the face section of `human-rig.ts` for the full reasoning.
 */
function lensPath(rx: number, ry: number): Shape {
  return {
    kind: "path",
    d: `M ${-rx} 0 A ${rx} ${ry} 0 0 1 ${rx} 0 A ${rx} ${ry} 0 0 1 ${-rx} 0 Z`,
  };
}

/** A straight horizontal bar, used for the flat `teeth` grin. */
function barPath(halfWidth: number, halfHeight: number): Shape {
  return {
    kind: "path",
    d:
      `M ${-halfWidth} ${halfHeight} L ${halfWidth} ${halfHeight} ` +
      `L ${halfWidth} ${-halfHeight} L ${-halfWidth} ${-halfHeight} Z`,
  };
}

/** A downward-bulging arc, for the open-mouth shapes. */
function arcPath(rx: number, ry: number): Shape {
  return {
    kind: "path",
    d: `M ${-rx} 0 A ${rx} ${ry} 0 0 0 ${rx} 0 A ${rx} ${ry} 0 0 0 ${-rx} 0 Z`,
  };
}

const R = HEAD_RADIUS;

/**
 * The drawn shape for each flap.
 *
 * Deliberately distinct in silhouette, not merely in scale: `oShape` is a tall ring,
 * `openWide` is a deep open bowl, `teeth` is a flat bar, `smile` is a wide shallow
 * curve. A viewer must be able to tell them apart in a single held frame, which is the
 * whole point of a limited-animation mouth chart.
 */
export const MOUTH_FLAP_SHAPES: Readonly<Record<MouthFlapId, Shape>> = Object.freeze({
  /** Resting closed mouth. */
  closed: lensPath(R * 0.24, R * 0.1),
  /** A small round opening, for short vowels. */
  openSmall: lensPath(R * 0.17, R * 0.17),
  /** A wide open mouth, for shouting and big vowels. */
  openWide: arcPath(R * 0.3, R * 0.34),
  /** A tall narrow "O", for "oh" and for surprise. */
  oShape: lensPath(R * 0.14, R * 0.26),
  /** A flat bar of clenched teeth, for grimacing and for talking through gritted teeth. */
  teeth: barPath(R * 0.26, R * 0.07),
  /** A wide shallow upward curve, for a closed smile. */
  smile: arcPath(R * 0.34, R * 0.2),
});

export interface MouthFlap {
  readonly id: MouthFlapId;
  readonly description: string;
  /** Shape to draw, from `MOUTH_FLAP_SHAPES`. */
  readonly shape: Shape;
  /** Channel overrides for the `mouth` part. */
  readonly channels: Readonly<Record<string, Channel>>;
}

/**
 * The flap chart.
 *
 * Each entry carries both its shape and its channel override, so a data-driven flap
 * track can switch either representation without consulting a second table.
 */
export const MOUTH_FLAPS: Readonly<Record<MouthFlapId, MouthFlap>> = Object.freeze({
  closed: {
    id: "closed",
    description: "Resting closed mouth.",
    shape: MOUTH_FLAP_SHAPES.closed,
    channels: { scaleX: at(1), scaleY: at(1), rotation: at(0) },
  },
  openSmall: {
    id: "openSmall",
    description: "Small round opening, for short vowels.",
    shape: MOUTH_FLAP_SHAPES.openSmall,
    channels: { scaleX: at(1), scaleY: at(1), rotation: at(0) },
  },
  openWide: {
    id: "openWide",
    description: "Wide open mouth, for shouting and long vowels.",
    shape: MOUTH_FLAP_SHAPES.openWide,
    channels: { scaleX: at(1.15), scaleY: at(1.1), rotation: at(0) },
  },
  oShape: {
    id: "oShape",
    description: "Tall narrow O, for 'oh' and for surprise.",
    shape: MOUTH_FLAP_SHAPES.oShape,
    channels: { scaleX: at(0.8), scaleY: at(1.2), rotation: at(0) },
  },
  teeth: {
    id: "teeth",
    description: "Flat bar of clenched teeth, for a grimace.",
    shape: MOUTH_FLAP_SHAPES.teeth,
    channels: { scaleX: at(1.1), scaleY: at(1), rotation: at(0) },
  },
  smile: {
    id: "smile",
    description: "Wide shallow upward curve, a closed smile.",
    shape: MOUTH_FLAP_SHAPES.smile,
    channels: { scaleX: at(1.15), scaleY: at(0.9), rotation: at(0) },
  },
});

/** Names of all flap ids, in a stable order. */
export const MOUTH_FLAP_NAMES: readonly MouthFlapId[] = MOUTH_FLAP_IDS;

/** Look up a flap, failing loudly on an unknown id. */
export function getMouthFlap(id: string): MouthFlap {
  const flap = MOUTH_FLAPS[id as MouthFlapId];
  if (!flap) {
    throw new Error(
      `Unknown mouth flap "${id}". Available: ${MOUTH_FLAP_IDS.join(", ")}`,
    );
  }
  return flap;
}

/**
 * A `step`-eased string channel cycling through mouth flaps on a fixed beat.
 *
 * This is the machinery that turns a list of flap ids into a talking mouth. `step`
 * easing is essential: a linear or eased string channel would produce an undefined
 * blend between two shape names, whereas `step` holds each value until the next switch —
 * which is precisely limited-animation cadence.
 *
 * @param sequence Flap ids in order, one per beat.
 * @param beatSeconds How long each flap is held.
 * @param startTime Time of the first flap, so a flap track can begin mid-scene.
 */
export function mouthFlapChannel(
  sequence: readonly MouthFlapId[],
  beatSeconds = 0.12,
  startTime = 0,
): Channel {
  if (sequence.length === 0) {
    throw new Error("A mouth flap channel needs at least one flap.");
  }
  if (beatSeconds <= 0) {
    throw new Error("Mouth flap beat must be positive.");
  }

  return {
    kind: "string",
    keyframes: sequence.map((value, index) => ({
      time: startTime + index * beatSeconds,
      value,
      // Hold each flap, then jump to the next: the discrete swap that defines the style.
      easing: "step" as const,
    })),
  };
}

/**
 * A talking loop, for a character babbling silently.
 *
 * The order is chosen so consecutive flaps differ in silhouette — alternating open and
 * closed shapes reads as speech, whereas two adjacent open shapes read as a frozen
 * gape. Cycling this sequence is what makes the character look like it is talking
 * without any audio analysis.
 */
export const TALKING_SEQUENCE: readonly MouthFlapId[] = [
  "closed",
  "openSmall",
  "openWide",
  "openSmall",
  "oShape",
  "closed",
  "openSmall",
  "teeth",
];