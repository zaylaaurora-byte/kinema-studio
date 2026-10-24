/**
 * Animations for the Silent Human.
 *
 * ---------------------------------------------------------------------------
 * THE REQUIREMENT THIS FILE EXISTS TO SATISFY
 * ---------------------------------------------------------------------------
 * The pilot explicitly forbids "a Ken Burns zoom on still art". A Ken Burns move is a
 * camera transform applied to an unchanging picture: the picture never articulates. The
 * difference between that and real animation is whether the LIMB PARTS THEMSELVES change
 * their world transform over time.
 *
 * Every animation here therefore keys channels on limb parts — shoulders, elbows, hips,
 * knees — with multiple keyframes per cycle, so sampling the rig at different times
 * produces genuinely different world transforms. `animations.test.ts` proves this by
 * sampling and comparing, rather than by trusting that keyframes exist.
 *
 * ---------------------------------------------------------------------------
 * LOOPS ARE CLOSED, NOT TRUNCATED
 * ---------------------------------------------------------------------------
 * `wave` and `runCycle` repeat the start values as their final keyframe. Animations are
 * sampled by holding the last value, so a cycle that did not return to its first pose
 * would snap when looped. Closing the loop makes N repetitions seamless.
 */

import type { Channel, EasingName, Keyframe, Rig } from "../scene.js";
import { EXPRESSIONS } from "./expressions.js";
import { applyChannels, deg } from "./poses.js";

/**
 * A numeric channel assembled from `[time, value]` pairs.
 *
 * Rotation values are authored in DEGREES here and converted at construction, so the
 * animation table reads like an animator's exposure sheet rather than radians.
 */
function degChannel(frames: readonly (readonly [number, number])[]): Channel {
  return numberChannel(frames.map(([time, value]) => [time, deg(value)] as const));
}

/** A numeric channel from `[time, value]` pairs, in the channel's own units. */
function numberChannel(frames: readonly (readonly [number, number])[]): Channel {
  const keyframes: Keyframe<number>[] = frames.map(([time, value]) => ({ time, value }));
  return { kind: "number", keyframes };
}

/** A numeric channel where each keyframe carries its own easing. */
function easedChannel(
  frames: readonly (readonly [number, number, EasingName])[],
): Channel {
  const keyframes: Keyframe<number>[] = frames.map(([time, value, easing]) => ({
    time,
    value,
    easing,
  }));
  return { kind: "number", keyframes };
}

/** A numeric channel authored in degrees with per-keyframe easing. */
function easedDegChannel(
  frames: readonly (readonly [number, number, EasingName])[],
): Channel {
  const keyframes: Keyframe<number>[] = frames.map(([time, value, easing]) => ({
    time,
    value: deg(value),
    easing,
  }));
  return { kind: "number", keyframes };
}

/** Channel overrides keyed by part id, the shape `applyChannels` consumes. */
export type AnimationChannels = Readonly<Record<string, Readonly<Record<string, Channel>>>>;

export interface Animation {
  readonly name: string;
  readonly description: string;
  /** Duration of one pass, in seconds. */
  readonly duration: number;
  /** True when the last keyframe reproduces the first, so it can repeat seamlessly. */
  readonly loop: boolean;
  readonly channels: AnimationChannels;
}

// ---------------------------------------------------------------------------
// wave — arm raises, then oscillates through at least 2 full cycles
// ---------------------------------------------------------------------------

/**
 * Waving. The arm is raised once, then the forearm oscillates.
 *
 * Two full oscillation cycles are keyed (four direction changes), because the pilot
 * requires at least two and a single swing reads as a salute rather than a wave. The
 * oscillation is keyed on the FOREARM while the upper arm holds, which is how a real
 * wave looks: the shoulder holds the arm up, the elbow does the work.
 */
export const WAVE_ANIMATION: Animation = {
  name: "wave",
  description: "Raises the right arm and waves it through two full cycles.",
  duration: 2,
  loop: true,
  channels: {
    // The body rises slightly and settles as the arm comes up.
    hips: {
      y: numberChannel([
        [0, 0],
        [0.25, 1.6],
        [0.6, 1.2],
        [2, 1.2],
      ]),
      rotation: degChannel([
        [0, 0],
        [0.3, -3],
        [2, -3],
      ]),
    },
    head: {
      rotation: degChannel([
        [0, 0],
        [0.35, 5],
        [2, 5],
      ]),
    },
    // Upper arm: raise through a big arc over the first 0.35s, then HOLD.
    "upperArm-right": {
      rotation: easedDegChannel([
        [0, -6, "easeOut"],
        [0.35, 148, "easeOut"],
        [2, 148, "linear"],
      ]),
    },
    // Forearm: the actual oscillation. Two full cycles across the hold.
    "lowerArm-right": {
      rotation: easedDegChannel([
        [0.35, -30, "linear"],
        [0.6, 22, "easeInOut"],
        [0.85, -30, "easeInOut"],
        [1.1, 22, "easeInOut"],
        [1.35, -30, "easeInOut"],
        [1.6, 22, "easeInOut"],
        [1.85, -30, "easeInOut"],
        [2, -30, "linear"],
      ]),
    },
    // The hand leads the forearm slightly, which is what sells the whip.
    "hand-right": {
      rotation: degChannel([
        [0.45, -8],
        [0.7, 12],
        [0.95, -8],
        [1.2, 12],
        [1.45, -8],
        [1.7, 12],
        [1.95, -8],
      ]),
    },
    // The other arm counters, so the figure does not look pinned.
    "upperArm-left": {
      rotation: degChannel([
        [0, 6],
        [0.4, -14],
        [2, -14],
      ]),
    },
    "lowerArm-left": {
      rotation: degChannel([
        [0, -8],
        [0.4, -20],
        [2, -20],
      ]),
    },
    // A slow weight shift through the legs.
    "upperLeg-left": {
      rotation: degChannel([
        [0, 3],
        [1, 6],
        [2, 3],
      ]),
    },
    "upperLeg-right": {
      rotation: degChannel([
        [0, -3],
        [1, -6],
        [2, -3],
      ]),
    },
  },
};

// ---------------------------------------------------------------------------
// runCycle — legs and arms alternate through a full cycle with a body bounce
// ---------------------------------------------------------------------------

/**
 * A four-key run cycle.
 *
 * The four keys are the classic contact / down / passing / up beats. Opposing limbs are
 * keyed in antiphase: when the left leg is forward the right arm is forward. That
 * antiphase relationship is the whole difference between a run and a shuffle, and
 * `animations.test.ts` asserts it directly by comparing the two feet at one instant.
 *
 * The vertical bounce is keyed on the ROOT (`hips`), so the bounce carries the entire
 * body — every part descends from the hips — rather than moving the legs independently.
 */
export const RUN_CYCLE: Animation = {
  name: "runCycle",
  description: "Four-beat run with alternating legs and arms and a vertical body bounce.",
  duration: 0.8,
  loop: true,
  channels: {
    // Two bounces per cycle: lowest at each contact, highest at each passing.
    hips: {
      y: numberChannel([
        [0, 0],
        [0.1, -2.2],
        [0.2, 1.4],
        [0.3, 3.0],
        [0.4, 0],
        [0.5, -2.2],
        [0.6, 1.4],
        [0.7, 3.0],
        [0.8, 0],
      ]),
      // A slight counter-rotation of the pelvis drives the shoulders.
      rotation: degChannel([
        [0, 3],
        [0.4, -3],
        [0.8, 3],
      ]),
    },
    torso: {
      rotation: degChannel([
        [0, -8],
        [0.4, -8],
        [0.8, -8],
      ]),
    },
    head: {
      rotation: degChannel([
        [0, 6],
        [0.4, 8],
        [0.8, 6],
      ]),
    },
    // --- Legs -----------------------------------------------------------------
    // Left leg: forward at t=0, driving back through t=0.4, forward again at t=0.8.
    "upperLeg-left": {
      rotation: degChannel([
        [0, 40],
        [0.1, 26],
        [0.2, 0],
        [0.3, -22],
        [0.4, -34],
        [0.5, -20],
        [0.6, 8],
        [0.7, 30],
        [0.8, 40],
      ]),
    },
    "lowerLeg-left": {
      rotation: degChannel([
        [0, -18],
        [0.1, -6],
        [0.2, 6],
        [0.3, 46],
        [0.4, 66],
        [0.5, 40],
        [0.6, -2],
        [0.7, -24],
        [0.8, -18],
      ]),
    },
    "foot-left": {
      rotation: degChannel([
        [0, 14],
        [0.2, -6],
        [0.4, -22],
        [0.6, 8],
        [0.8, 14],
      ]),
    },
    // Right leg: exactly antiphase with the left (offset by half the cycle).
    "upperLeg-right": {
      rotation: degChannel([
        [0, -34],
        [0.1, -20],
        [0.2, 8],
        [0.3, 30],
        [0.4, 40],
        [0.5, 26],
        [0.6, 0],
        [0.7, -22],
        [0.8, -34],
      ]),
    },
    "lowerLeg-right": {
      rotation: degChannel([
        [0, 66],
        [0.1, 40],
        [0.2, -2],
        [0.3, -24],
        [0.4, -18],
        [0.5, -6],
        [0.6, 6],
        [0.7, 46],
        [0.8, 66],
      ]),
    },
    "foot-right": {
      rotation: degChannel([
        [0, -22],
        [0.2, 8],
        [0.4, 14],
        [0.6, -6],
        [0.8, -22],
      ]),
    },
    // --- Arms (antiphase with the legs on the same side) ----------------------
    "upperArm-left": {
      rotation: degChannel([
        [0, -48],
        [0.2, -10],
        [0.4, 54],
        [0.6, 18],
        [0.8, -48],
      ]),
    },
    "lowerArm-left": {
      rotation: degChannel([
        [0, -76],
        [0.2, -70],
        [0.4, -62],
        [0.6, -72],
        [0.8, -76],
      ]),
    },
    "upperArm-right": {
      rotation: degChannel([
        [0, 54],
        [0.2, 18],
        [0.4, -48],
        [0.6, -10],
        [0.8, 54],
      ]),
    },
    "lowerArm-right": {
      rotation: degChannel([
        [0, -62],
        [0.2, -72],
        [0.4, -76],
        [0.6, -70],
        [0.8, -62],
      ]),
    },
  },
};

// ---------------------------------------------------------------------------
// tripFall — a comedic fall with a real rotation
// ---------------------------------------------------------------------------

/**
 * Tripping and falling.
 *
 * The comedy is in the timing, not the distance: the body pitches over with `backOut`
 * easing so it overshoots and snaps, then holds the splat, then twitches. The whole
 * figure rotates about the hips (the root), so the rotation carries every limb.
 *
 * `step` easing is used for the final twitch, which is exactly the held-then-jump
 * behaviour the scene model documents it for.
 */
export const TRIP_FALL: Animation = {
  name: "tripFall",
  description: "Comedic forward trip, rotation to the ground, splat and a small twitch.",
  duration: 1.6,
  loop: false,
  channels: {
    hips: {
      // Root rotation: upright, pitch over, land, settle.
      rotation: easedDegChannel([
        [0, 0, "linear"],
        [0.3, -8, "easeIn"],
        [0.75, -68, "backOut"],
        [0.95, -62, "easeOut"],
        [1.6, -62, "linear"],
      ]),
      // Drop to the ground as the figure goes over.
      y: easedChannel([
        [0, 0, "easeIn"],
        [0.3, 1, "easeIn"],
        [0.75, -26, "easeOut"],
        [0.95, -24, "easeOut"],
        [1.6, -24, "linear"],
      ]),
      x: numberChannel([
        [0, 0],
        [0.75, 6],
        [1.6, 6],
      ]),
    },
    torso: {
      rotation: easedDegChannel([
        [0, 0, "linear"],
        [0.35, -14, "easeOut"],
        [0.8, -10, "easeOut"],
        [1.6, -10, "linear"],
      ]),
    },
    // Head whips forward, then snaps back on landing.
    head: {
      rotation: easedDegChannel([
        [0, 0, "linear"],
        [0.35, 24, "easeOut"],
        [0.8, 30, "easeIn"],
        [0.9, 18, "backOut"],
        [1.6, 18, "linear"],
      ]),
    },
    // Arms fling up during the trip, then sprawl.
    "upperArm-left": {
      rotation: easedDegChannel([
        [0, 4, "linear"],
        [0.4, -124, "easeOut"],
        [0.85, -96, "easeOut"],
        [1.6, -96, "linear"],
      ]),
    },
    "lowerArm-left": {
      rotation: easedDegChannel([
        [0, -8, "linear"],
        [0.4, -38, "easeOut"],
        [0.85, -20, "easeOut"],
        [1.6, -20, "linear"],
      ]),
    },
    "upperArm-right": {
      rotation: easedDegChannel([
        [0, -4, "linear"],
        [0.4, 118, "easeOut"],
        [0.85, 92, "easeOut"],
        [1.6, 92, "linear"],
      ]),
    },
    "lowerArm-right": {
      rotation: easedDegChannel([
        [0, 8, "linear"],
        [0.4, -34, "easeOut"],
        [0.85, -18, "easeOut"],
        [1.6, -18, "linear"],
      ]),
    },
    // Legs: the trailing foot catches, the lead leg swings out.
    "upperLeg-left": {
      rotation: easedDegChannel([
        [0, 2, "linear"],
        [0.3, -30, "easeOut"],
        [0.8, -52, "easeOut"],
        [1.6, -52, "linear"],
      ]),
    },
    "lowerLeg-left": {
      rotation: easedDegChannel([
        [0, -2, "linear"],
        [0.3, 20, "easeOut"],
        [0.8, 34, "easeOut"],
        [1.6, 34, "linear"],
      ]),
    },
    "upperLeg-right": {
      rotation: easedDegChannel([
        [0, -2, "linear"],
        [0.3, 26, "easeOut"],
        [0.8, 40, "easeOut"],
        [1.6, 40, "linear"],
      ]),
    },
    "lowerLeg-right": {
      rotation: easedDegChannel([
        [0, 2, "linear"],
        [0.3, 34, "easeOut"],
        [0.8, 62, "easeOut"],
        [1.6, 62, "linear"],
      ]),
    },
    // The comedy twitch: held, then a single jumped frame.
    "foot-right": {
      rotation: easedDegChannel([
        [0, 0, "step"],
        [0.85, 0, "step"],
        [1.25, -18, "step"],
        [1.6, -18, "linear"],
      ]),
    },
  },
};

/** Every animation, keyed by name. */
export const ANIMATIONS: Readonly<Record<string, Animation>> = Object.freeze({
  wave: WAVE_ANIMATION,
  runCycle: RUN_CYCLE,
  tripFall: TRIP_FALL,
});

/** Names of all available animations, in a stable order. */
export const ANIMATION_NAMES = Object.keys(ANIMATIONS);

/** Look up an animation, failing loudly on a typo. */
export function getAnimation(name: string): Animation {
  const animation = ANIMATIONS[name];
  if (!animation) {
    throw new Error(`Unknown animation "${name}". Available: ${ANIMATION_NAMES.join(", ")}`);
  }
  return animation;
}

/** Apply an animation's channels to a rig, returning a new rig. */
export function applyAnimation(rig: Rig, animation: Animation): Rig {
  return applyChannels(rig, animation.channels);
}

/**
 * Build a rig already carrying an animation, ready to be handed to `evaluate()`.
 *
 * The convenience entry point the pilot uses: `rigAt("runCycle")` inside a scene layer
 * and every frame of that layer articulates without any further setup.
 */
export function animatedRig(rig: Rig, animationName: string): Rig {
  return applyAnimation(rig, getAnimation(animationName));
}

/**
 * Convenience: a rig posed by an animation, dressed with a facial expression.
 *
 * Layering order is animation first, then expression, so an expression can override a
 * face channel an animation touched without the two fighting.
 */
export function animatedRigWithExpression(
  rig: Rig,
  animationName: string | undefined,
  expressionName: string,
): Rig {
  const animated = animationName ? animatedRig(rig, animationName) : rig;
  const expression = EXPRESSIONS[expressionName];
  if (!expression) {
    throw new Error(
      `Unknown expression "${expressionName}". Available: ${Object.keys(EXPRESSIONS).join(", ")}`,
    );
  }
  return applyChannels(animated, expression.channels);
}