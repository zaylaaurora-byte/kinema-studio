/**
 * A pose: a DISCRETE configuration of a rig, not a curve.
 *
 * ---------------------------------------------------------------------------
 * THE COURSE CORRECTION THIS FILE ENCODES (ADR 0003)
 * ---------------------------------------------------------------------------
 * `@kinema/scene-model` is built around continuous keyframe interpolation. That is the
 * wrong primitive for this show. "Bad Example" is LIMITED 2D ANIMATION — pose-to-pose,
 * cut-out, slideshow-with-mouth-moving — the technique narrated YouTube compilation
 * channels use. In that style a character HOLDS a drawing, then swaps to another
 * drawing. Nothing slides.
 *
 * So a pose here carries plain NUMBERS, not channels:
 *
 *     { rotation: -118 }        a pose            <- this package
 *     { rotation: [keyframes]}  an animated curve <- the scene model
 *
 * That difference is the whole point. A number cannot be interpolated, because there is
 * nothing to interpolate it with. `applyPose` then converts each number into a
 * single-keyframe channel, which the evaluator already handles correctly: one keyframe
 * samples to that value at EVERY time, so the value is genuinely HELD rather than
 * drifting. The bridge is one-way and total, and `evaluate()` needs no changes — exactly
 * as the ADR requires ("the renderer is unchanged").
 *
 * ---------------------------------------------------------------------------
 * WHY POSES ARE PARTIAL
 * ---------------------------------------------------------------------------
 * A pose lists only the parts it moves. A wave does not need to mention the feet. A rig
 * supplies the rest. This keeps authoring a pose to the handful of numbers that actually
 * matter for the drawing, which is how a pose library stays maintainable — and it makes
 * `applyPose` a pure overlay rather than a full re-specification of the rig.
 */

import type { Channel, Rig, RigPart } from "@kinema/scene-model";

/** Degrees to radians. Authored poses are in degrees because 118 is readable and 2.06 is not. */
export function deg(degrees: number): number {
  return (degrees * Math.PI) / 180;
}

/**
 * The channel properties a pose can drive.
 *
 * Deliberately the exact set `evaluate()` reads for a rig part's transform, no more. If a
 * property is not in this list, `applyPose` cannot set it, and a test asserts that
 * correspondence so the two cannot silently drift apart.
 */
export interface ChannelValues {
  readonly x?: number;
  readonly y?: number;
  /** Rotation in RADIANS, because that is what `makeTransform` consumes. */
  readonly rotation?: number;
  readonly scaleX?: number;
  readonly scaleY?: number;
}

/** The property names `applyPose` writes, matching what the evaluator samples. */
export const CHANNEL_PROPERTIES = ["x", "y", "rotation", "scaleX", "scaleY"] as const;

export type ChannelProperty = (typeof CHANNEL_PROPERTIES)[number];

/**
 * One named pose.
 *
 * `channels` is keyed by rig part id. Part ids are not invented here: they are the ids
 * the rig builder actually produces (see `HUMAN_PART_IDS` / `HOST_PART_IDS` in
 * `./library/`). A pose naming a part the rig does not have is silently ignored by
 * `applyPose` — which is intentional, so a human pose can be applied to a rig that lacks,
 * say, a tail, without special-casing.
 */
export interface Pose {
  readonly name: string;
  /** Short note on the reading, for the editor's pose picker. */
  readonly description: string;
  readonly channels: Readonly<Record<string, ChannelValues>>;
}

/**
 * A lookup of named poses.
 *
 * A library is a plain value, not a class with hidden state, so it can be frozen, spread,
 * and merged. `list()` returns names in INSERTION order rather than sorted order: the
 * order a library is authored in is meaningful (neutral first, extremes later), and an
 * editor's picker should show it the way the artist wrote it.
 */
export interface PoseLibrary {
  readonly name: string;
  get(poseName: string): Pose;
  has(poseName: string): boolean;
  list(): readonly string[];
  /** Every pose in the library, in `list()` order. */
  all(): readonly Pose[];
}

/**
 * Build a `PoseLibrary` from a list of poses.
 *
 * Throws on a duplicate name. That is not defensive padding: a library is usually
 * assembled by spreading several modules together, and a duplicate means one of two
 * genuinely different drawings has just become unreachable. Failing loudly at
 * construction is far cheaper than discovering mid-render that "wave" is not the wave
 * the artist meant.
 */
export function createPoseLibrary(
  name: string,
  poses: readonly Pose[],
): PoseLibrary {
  const byName = new Map<string, Pose>();
  for (const pose of poses) {
    if (byName.has(pose.name)) {
      throw new Error(
        `Pose library "${name}" defines pose "${pose.name}" more than once.`,
      );
    }
    byName.set(pose.name, pose);
  }

  const names = [...byName.keys()];

  return {
    name,
    has: (poseName: string): boolean => byName.has(poseName),
    get: (poseName: string): Pose => {
      const pose = byName.get(poseName);
      if (!pose) {
        throw new Error(
          `Unknown pose "${poseName}" in library "${name}". ` +
            `Available: ${names.join(", ")}`,
        );
      }
      return pose;
    },
    list: (): readonly string[] => names,
    all: (): readonly Pose[] => names.map((n) => byName.get(n)!),
  };
}

/**
 * A single-keyframe numeric channel that holds `value` at every time.
 *
 * One keyframe is the important detail. `sampleNumber` returns `frames[0].value` for a
 * one-keyframe channel without ever consulting an easing curve, so the value is constant
 * by construction rather than by choosing the right easing. A held pose cannot drift,
 * because there is no segment in which to drift.
 */
export function constChannel(value: number): Channel {
  return { kind: "number", keyframes: [{ time: 0, value }] };
}

/**
 * Convert a pose's channel values into scene-model channels.
 *
 * Exposed separately from `applyPose` because the pose-track builder needs the channels
 * without a rig to attach them to.
 */
export function poseChannels(
  pose: Pose,
): Record<string, Record<string, Channel>> {
  const out: Record<string, Record<string, Channel>> = {};
  for (const [partId, values] of Object.entries(pose.channels)) {
    const channels: Record<string, Channel> = {};
    for (const property of CHANNEL_PROPERTIES) {
      const value = values[property];
      if (value !== undefined) channels[property] = constChannel(value);
    }
    // A pose entry naming a part but setting no known property would otherwise create an
    // empty object, which reads downstream as "this part is posed" when it is not.
    if (Object.keys(channels).length > 0) out[partId] = channels;
  }
  return out;
}

/**
 * Apply a pose to a rig, returning a NEW rig that `evaluate()` accepts.
 *
 * ---------------------------------------------------------------------------
 * THE HOLD GUARANTEE
 * ---------------------------------------------------------------------------
 * Every part the pose names receives EXPLICIT single-keyframe channels for each property
 * the pose sets. Two consequences, both deliberate:
 *
 *  1. The posed value is held at t=0, t=1, t=100 — `evaluate()` returns identical world
 *     transforms at every time. That is the difference between a pose swap and a drift,
 *     and it is asserted directly in the tests.
 *  2. Only the named properties are touched. A pose that sets `rotation` but not `x`
 *     leaves the rig's existing `x` channel alone rather than resetting it, so poses
 *     compose (base pose + correction) instead of clobbering each other.
 *
 * The input rig is never mutated. The canonical rig can therefore be posed repeatedly, in
 * any order, with identical results — the same no-shared-mutable-state property that makes
 * `evaluate()` safe to cache.
 *
 * Parts absent from the pose are returned UNCHANGED (same object identity), which keeps
 * this cheap for the common case of a pose that moves five parts out of twenty-one.
 */
export function applyPose(pose: Pose, rig: Rig): Rig {
  const overrides = poseChannels(pose);

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
 * Apply several poses in order, later ones winning. Returns a new `Pose`.
 *
 * Lets a pose be authored as a base plus a correction without retyping every number,
 * which is what keeps a library legible. Purely a data merge; no rig involved.
 */
export function blendPoses(...poses: readonly Pose[]): Pose {
  if (poses.length === 0) {
    throw new Error("blendPoses() needs at least one pose.");
  }

  const channels: Record<string, ChannelValues> = {};
  for (const pose of poses) {
    for (const [partId, values] of Object.entries(pose.channels)) {
      channels[partId] = { ...(channels[partId] ?? {}), ...values };
    }
  }

  const first = poses[0]!;
  const last = poses[poses.length - 1]!;
  return {
    name: poses.length === 1 ? first.name : `${first.name}+${last.name}`,
    description: poses.map((p) => p.description).join(" / "),
    channels,
  };
}

/**
 * Numeric distance between two poses, over the channels they both set.
 *
 * This is the measurement the "poses must not be near-duplicates" test is built on, so
 * its definition matters and is stated rather than implied:
 *
 *  - **Rotation is weighted, not compared in radians.** A rotation difference is scaled
 *    by `ROTATION_WEIGHT` so that one radian of limb swing counts as the equivalent of
 *    `ROTATION_WEIGHT` units of position. Without this, a pose that swings both arms
 *    through 100 degrees would score as "similar" to neutral next to a pose that shifts
 *    the hips 30 units — which is the opposite of the truth for a drawn character, whose
 *    whole readability lives in limb angle.
 *  - **Scale differences count double**, since a scale of 1 vs 1.3 is a large visual
 *    change on a small part like an eye.
 *  - Only properties set by BOTH poses are compared. A property only one pose sets is
 *    already a difference, and is counted by `poseDifference` in the tests instead.
 *
 * Returns 0 for identical poses. Deterministic: pure arithmetic over the inputs.
 */
export const ROTATION_WEIGHT = 20;
export const SCALE_WEIGHT = 2;

export function poseDistance(a: Pose, b: Pose): number {
  let total = 0;

  for (const [partId, aValues] of Object.entries(a.channels)) {
    const bValues = b.channels[partId];
    if (!bValues) continue;

    for (const property of CHANNEL_PROPERTIES) {
      const av = aValues[property];
      const bv = bValues[property];
      if (av === undefined || bv === undefined) continue;

      const delta = Math.abs(av - bv);
      if (property === "rotation") total += delta * ROTATION_WEIGHT;
      else if (property === "scaleX" || property === "scaleY") {
        total += delta * SCALE_WEIGHT;
      } else total += delta;
    }
  }

  return total;
}