/**
 * Full-body poses for the Silent Human.
 *
 * The reference sheet lists 18 standing poses and 14 dynamic actions. This module
 * implements the ones the pilot depends on, each as a reusable channel set.
 *
 * ---------------------------------------------------------------------------
 * THE ONE RULE THAT MAKES POSES WORK
 * ---------------------------------------------------------------------------
 * Every limb part's origin sits AT ITS JOINT (shoulder, elbow, hip, knee) and its shape
 * hangs down the local -Y axis. So:
 *
 *   - `rotation = 0`   -> the limb hangs straight down, the rest pose;
 *   - `rotation > 0`   -> the limb swings toward +X;
 *   - `rotation < 0`   -> the limb swings toward -X.
 *
 * A negative arm rotation therefore raises the character's own right arm only because
 * the right-hand parts were placed at negative x in the builder. Where that matters, the
 * pose states the sign inline rather than relying on the reader to remember it.
 *
 * Rotations are in RADIANS throughout, because that is what `makeTransform` consumes.
 * `deg()` exists so authored poses stay readable and cannot be silently mis-scaled.
 */

import type { Channel, Rig, RigPart } from "../scene.js";

/** Degrees to radians, for readable authored poses. */
export function deg(degrees: number): number {
  return (degrees * Math.PI) / 180;
}

/** A constant numeric channel. */
function at(value: number): Channel {
  return { kind: "number", keyframes: [{ time: 0, value }] };
}

/**
 * One pose: channel overrides keyed by part id.
 *
 * Values are FINAL channel values, replacing `localPosition` rather than offsetting it.
 */
export type PoseChannels = Readonly<Record<string, Readonly<Record<string, Channel>>>>;

export interface Pose {
  readonly name: string;
  readonly description: string;
  readonly channels: PoseChannels;
}

/**
 * Build a limb override from a rotation in degrees.
 *
 * `x`/`y` are omitted unless supplied, so a pose that only rotates a limb leaves its
 * position channel at the rig's rest value.
 */
function limb(
  rotationDeg: number,
  position?: { x?: number; y?: number },
): Record<string, Channel> {
  const channels: Record<string, Channel> = { rotation: at(deg(rotationDeg)) };
  if (position?.x !== undefined) channels["x"] = at(position.x);
  if (position?.y !== undefined) channels["y"] = at(position.y);
  return channels;
}

/** Build a root override for the hips: position and/or rotation. */
function root(rotationDeg: number, x = 0, y = 0): Record<string, Channel> {
  return { rotation: at(deg(rotationDeg)), x: at(x), y: at(y) };
}

// ---------------------------------------------------------------------------
// Pose library
// ---------------------------------------------------------------------------

/**
 * Neutral standing rest pose.
 *
 * Explicitly zero rather than "no pose", so `applyPose(rig, NEUTRAL)` is a true identity
 * and the pilot can always return to a clean standing frame.
 */
export const NEUTRAL: Pose = {
  name: "neutral",
  description: "Relaxed standing rest. Arms hanging, weight even.",
  channels: {
    hips: root(0, 0, 0),
    torso: limb(0),
    head: limb(0),
    // Arms hang almost straight but splay outward a few degrees, which is what stops a
    // tube-limbed figure reading as a flat stick. The forearm bends back in slightly so
    // the hand sits beside the hip rather than flaring out.
    "upperArm-left": limb(7),
    "lowerArm-left": limb(-4),
    "upperArm-right": limb(-7),
    "lowerArm-right": limb(4),
    "upperLeg-left": limb(1.5),
    "lowerLeg-left": limb(-1.5),
    "upperLeg-right": limb(-1.5),
    "lowerLeg-right": limb(1.5),
  },
};

/**
 * Wave: the sheet's WAVE / greeting.
 *
 * The character's own right arm (negative x) is the one raised, matching the pose sheet
 * where the free arm goes up on the viewer's left.
 */
export const WAVE: Pose = {
  name: "wave",
  description: "Right arm raised high and out to the side, left arm relaxed.",
  channels: {
    hips: root(0, 0, 0),
    torso: limb(-3),
    head: limb(4),
    // ~118 degrees puts the upper arm just past horizontal and clearly out to the SIDE
    // of the head. Pushing much beyond this swings the arm behind the head instead,
    // which reads as scratching rather than waving.
    "upperArm-right": limb(-118),
    "lowerArm-right": limb(-24),
    "hand-right": limb(0),
    "upperArm-left": limb(6),
    "lowerArm-left": limb(-8),
    "upperLeg-left": limb(3),
    "lowerLeg-left": limb(-3),
    "upperLeg-right": limb(-3),
    "lowerLeg-right": limb(3),
  },
};

/**
 * Wave, second extreme: the forearm swung down and forward.
 *
 * Paired with `WAVE` in a two-pose cycle. In limited animation a wave is two drawings
 * swapped on a beat, not a smoothly rotating arm — the swap is what gives it the snappy
 * hand-drawn feel, and it is why this is a separate full pose rather than a keyframe on
 * the forearm's rotation channel.
 */
export const WAVE_DOWN: Pose = {
  name: "waveDown",
  description: "Wave, second extreme: raised arm with the forearm swung down.",
  channels: {
    hips: root(0, 0, 0),
    torso: limb(-3),
    head: limb(4),
    "upperArm-right": limb(-118),
    // The forearm swings through the oscillation here.
    "lowerArm-right": limb(16),
    "hand-right": limb(-6),
    "upperArm-left": limb(6),
    "lowerArm-left": limb(-8),
    "upperLeg-left": limb(3),
    "lowerLeg-left": limb(-3),
    "upperLeg-right": limb(-3),
    "lowerLeg-right": limb(3),
  },
};

/** Point: arm out to the side, level, finger-gun style per the sheet. */
export const POINT: Pose = {
  name: "point",
  description: "Left arm extended straight out, body leaning into the gesture.",
  channels: {
    hips: root(-2, 0, 0),
    torso: limb(-5),
    head: limb(-6),
    "upperArm-left": limb(-88),
    "lowerArm-left": limb(-4),
    "upperArm-right": limb(10),
    "lowerArm-right": limb(-12),
    "upperLeg-left": limb(6),
    "lowerLeg-left": limb(-5),
    "upperLeg-right": limb(-6),
    "lowerLeg-right": limb(5),
  },
};

/** Arms up: the sheet's ARMS UP (CELEBRATE). Both arms overhead, chest open. */
export const ARMS_UP: Pose = {
  name: "armsUp",
  description: "Both arms thrown overhead in celebration, head back.",
  channels: {
    hips: root(0, 0, 2),
    torso: limb(0),
    head: limb(10),
    "upperArm-left": limb(160),
    "lowerArm-left": limb(-20),
    "upperArm-right": limb(-160),
    "lowerArm-right": limb(20),
    // Slight hop stance, legs apart.
    "upperLeg-left": limb(12),
    "lowerLeg-left": limb(-10),
    "upperLeg-right": limb(-12),
    "lowerLeg-right": limb(10),
  },
};

/**
 * Run: a genuine multi-limb pose, not neutral with a shifted root.
 *
 * This is a single frame of a run — contact on the left foot, right leg driving back,
 * opposite arms swinging. `animations.ts` varies these angles over time; the point of
 * this pose is that the limbs are in a real, asymmetric relationship.
 */
export const RUN: Pose = {
  name: "run",
  description: "Mid-run contact: left leg forward, right leg driving back, arms opposed.",
  channels: {
    // Forward lean and a raised centre of mass.
    hips: root(-12, 0, 3),
    torso: limb(-6),
    head: limb(8),
    // Left leg forward and nearly straight at contact.
    "upperLeg-left": limb(38),
    "lowerLeg-left": limb(-16),
    "foot-left": limb(14),
    // Right leg swept back with a strongly folded knee.
    "upperLeg-right": limb(-34),
    "lowerLeg-right": limb(64),
    "foot-right": limb(-20),
    // Arms opposed to the legs: right arm forward, left arm back.
    "upperArm-right": limb(52),
    "lowerArm-right": limb(-72),
    "upperArm-left": limb(-46),
    "lowerArm-left": limb(-78),
  },
};

/**
 * Run, opposite contact: the second half of a two-pose limited-animation run cycle.
 *
 * In this style a run is NOT a smoothly interpolated curve. It is two (sometimes three)
 * extreme poses swapped on a beat, and the audience's eye supplies the motion. This pose
 * is therefore the exact mirror of `RUN` — left and right limbs exchanged — which makes
 * `[run, runAlt]` a genuine alternating cycle rather than two similar drawings.
 */
export const RUN_ALT: Pose = {
  name: "runAlt",
  description: "Run, opposite contact: right leg forward, left leg driving back.",
  channels: {
    hips: root(-12, 0, 3),
    torso: limb(-6),
    head: limb(8),
    // Right leg forward and nearly straight at contact.
    "upperLeg-right": limb(38),
    "lowerLeg-right": limb(-16),
    "foot-right": limb(14),
    // Left leg swept back with a strongly folded knee.
    "upperLeg-left": limb(-34),
    "lowerLeg-left": limb(64),
    "foot-left": limb(-20),
    // Arms opposed to the legs: left arm forward, right arm back.
    "upperArm-left": limb(52),
    "lowerArm-left": limb(-72),
    "upperArm-right": limb(-46),
    "lowerArm-right": limb(-78),
  },
};

/**
 * A single held beat of a run, with the body lifted.
 *
 * The third pose of a three-pose run: both legs gathered under the body at the top of
 * the bounce. Two-pose cycles read as a shuffle; adding this "up" pose between the two
 * contacts is what gives the run its weight, and it is still only three discrete
 * drawings swapped on a beat.
 */
export const RUN_UP: Pose = {
  name: "runUp",
  description: "Run, gathered: both legs folded under the lifted body.",
  channels: {
    hips: root(-10, 0, 6),
    torso: limb(-6),
    head: limb(9),
    "upperLeg-left": limb(16),
    "lowerLeg-left": limb(52),
    "foot-left": limb(-18),
    "upperLeg-right": limb(-12),
    "lowerLeg-right": limb(46),
    "foot-right": limb(-14),
    "upperArm-left": limb(-20),
    "lowerArm-left": limb(-80),
    "upperArm-right": limb(24),
    "lowerArm-right": limb(-74),
  },
};

/**
 * Trip: the sheet's TRIP / FALL, the comedic beat the pilot's ending needs.
 *
 * Pitched forward with the feet swept out from under the body and the arms flung up.
 */
export const TRIP: Pose = {
  name: "trip",
  description: "Tripping forward: torso pitched over, legs swept back, arms flung up.",
  channels: {
    // The pitch is limited to ~30 degrees and the root is RAISED slightly rather than
    // dropped, so the sprawled figure stays inside a normal camera frame. Falling
    // further looks correct in isolation but crops the character at the frame edge,
    // which is worse for the pilot than a slightly theatrical trip.
    hips: root(-30, 2, 4),
    torso: limb(-12),
    head: limb(24),
    "upperArm-left": limb(-112),
    "lowerArm-left": limb(-30),
    "upperArm-right": limb(106),
    "lowerArm-right": limb(-34),
    "upperLeg-left": limb(-46),
    "lowerLeg-left": limb(40),
    "foot-left": limb(-24),
    "upperLeg-right": limb(-22),
    "lowerLeg-right": limb(70),
    "foot-right": limb(-30),
  },
};

/** Extra pose: the sheet's COWER / cower-and-shield. */
export const COWER: Pose = {
  name: "cower",
  description: "Crouched low, both arms up shielding the face, knees bent.",
  channels: {
    hips: root(0, 0, -14),
    torso: limb(-18),
    head: limb(16),
    "upperArm-left": limb(122),
    "lowerArm-left": limb(-86),
    "upperArm-right": limb(-128),
    "lowerArm-right": limb(88),
    "upperLeg-left": limb(28),
    "lowerLeg-left": limb(-20),
    "upperLeg-right": limb(-28),
    "lowerLeg-right": limb(20),
  },
};

/** Extra pose: the sheet's HANDS ON HIPS, a good "unimpressed" read. */
export const HANDS_ON_HIPS: Pose = {
  name: "handsOnHips",
  description: "Elbows out, hands planted on the hips. Confident or unimpressed.",
  channels: {
    hips: root(0, 0, 0),
    torso: limb(0),
    head: limb(-4),
    "upperArm-left": limb(58),
    "lowerArm-left": limb(-118),
    "upperArm-right": limb(-58),
    "lowerArm-right": limb(118),
    "upperLeg-left": limb(4),
    "lowerLeg-left": limb(-4),
    "upperLeg-right": limb(-4),
    "lowerLeg-right": limb(4),
  },
};

/** Extra pose: victory / both arms up in a wide V. */
export const VICTORY: Pose = {
  name: "victory",
  description: "Wide V arms raised, chin up, feet planted apart.",
  channels: {
    hips: root(0, 0, 1),
    torso: limb(-2),
    head: limb(6),
    "upperArm-left": limb(132),
    "lowerArm-left": limb(-10),
    "upperArm-right": limb(-132),
    "lowerArm-right": limb(10),
    "upperLeg-left": limb(8),
    "lowerLeg-left": limb(-6),
    "upperLeg-right": limb(-8),
    "lowerLeg-right": limb(6),
  },
};

/** Every pose, keyed by name. */
export const POSES: Readonly<Record<string, Pose>> = Object.freeze({
  neutral: NEUTRAL,
  wave: WAVE,
  waveDown: WAVE_DOWN,
  point: POINT,
  armsUp: ARMS_UP,
  run: RUN,
  runAlt: RUN_ALT,
  runUp: RUN_UP,
  trip: TRIP,
  cower: COWER,
  handsOnHips: HANDS_ON_HIPS,
  victory: VICTORY,
});

/** Names of all available poses, in a stable order. */
export const POSE_NAMES = Object.keys(POSES);

/** Look up a pose, failing loudly on a typo. */
export function getPose(name: string): Pose {
  const pose = POSES[name];
  if (!pose) {
    throw new Error(`Unknown pose "${name}". Available: ${POSE_NAMES.join(", ")}`);
  }
  return pose;
}

/**
 * Apply a pose to a rig, returning a NEW rig.
 *
 * Pure by construction: the input rig is never mutated, so the canonical rig can be
 * posed repeatedly and in any order with identical results. This is the same
 * no-shared-mutable-state property that makes `evaluate()` safe to cache.
 */
export function applyPose(rig: Rig, pose: Pose): Rig {
  return applyChannels(rig, pose.channels);
}

/**
 * Merge channel overrides into a rig's parts, returning a new rig.
 *
 * Shared by poses, expressions and animations — the single place where overrides become
 * a rig, so all three compose identically and can be layered in any order.
 */
export function applyChannels(
  rig: Rig,
  overrides: Readonly<Record<string, Readonly<Record<string, Channel>>>>,
): Rig {
  return {
    ...rig,
    parts: rig.parts.map((part: RigPart): RigPart => {
      const override = overrides[part.id];
      if (!override) return part;
      return { ...part, channels: { ...part.channels, ...override } };
    }),
  };
}

/**
 * Apply several poses in order, later ones winning.
 *
 * Lets a pose be built as a base plus a correction without duplicating every channel.
 */
export function composePoses(...poses: readonly Pose[]): Pose {
  const channels: Record<string, Record<string, Channel>> = {};
  for (const pose of poses) {
    for (const [partId, partChannels] of Object.entries(pose.channels)) {
      channels[partId] = { ...(channels[partId] ?? {}), ...partChannels };
    }
  }
  return {
    name: poses.map((p) => p.name).join("+"),
    description: poses.map((p) => p.description).join(" / "),
    channels,
  };
}