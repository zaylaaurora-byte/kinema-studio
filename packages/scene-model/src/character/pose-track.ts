/**
 * Discrete pose tracks: the core of limited 2D animation.
 *
 * ---------------------------------------------------------------------------
 * THE PRINCIPLE
 * ---------------------------------------------------------------------------
 * In limited animation a pose is HELD, then swapped. Sampling is a LOOKUP, not curve
 * evaluation. That distinction is the whole reason this file exists rather than being
 * folded into keyframe sampling:
 *
 *   - A keyframed `Channel` interpolates between values, which for a limb angle means
 *     the limb slides continuously. Applying that to a pose would produce the uncanny
 *     sliding that this style is trying to avoid.
 *   - A `PoseTrack` stores the times at which the pose IDENTITY changes and holds the
 *     last-entered pose until the next switch. Nothing between two entries exists.
 *
 * The scene model already provides `step` easing, which holds a value and jumps at the
 * boundary. A pose track is that same idea lifted from a scalar to a whole named pose,
 * so an entire body configuration swaps at once instead of per-channel.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS FILE DOES NOT TOUCH `scene.ts`
 * ---------------------------------------------------------------------------
 * `PoseTrack` emits ordinary `Rig`s carrying `step`-eased channels, so it composes with
 * `evaluate()` exactly like anything else. A scene document cannot tell the difference
 * between a rig driven by a pose track and one driven by hand-written keyframes — which
 * is the point. No scene-model change is needed.
 */

import type { Channel, Rig, RigPart } from "../scene.js";
import { applyChannels, getPose, type Pose } from "./poses.js";

/** One switch: from this time onward, the named pose is active. */
export interface PoseCue {
  /** Time in seconds at which this pose takes over. */
  readonly time: number;
  /** Name of the pose, resolved lazily so a track can be authored as plain data. */
  readonly poseId: string;
  /**
   * Optional easing for the segment leading INTO this cue.
   *
   * Defaults to `step`, which is the limited-animation behaviour. Passing `easeInOut`
   * here is an escape hatch for the rare deliberate tween; the default is deliberately
   * the discrete one, so the wrong style is the one you have to ask for.
   */
  readonly easing?: "step" | "linear" | "easeIn" | "easeOut" | "easeInOut";
}

export interface PoseTrack {
  readonly name: string;
  /** Cues, sorted by time. Normalised by `poseTrack()`; do not rely on hand order. */
  readonly cues: readonly PoseCue[];
}

/**
 * Build a pose track from cues.
 *
 * Cues are SORTED by time and de-duplicated so that a hand-authored list with ties or
 * out-of-order entries still samples predictably. A track whose sampling depended on
 * input order would be a latent bug in every cut list built from it.
 */
export function poseTrack(name: string, cues: readonly PoseCue[]): PoseTrack {
  const sorted = [...cues].sort((a, b) => a.time - b.time);
  return { name, cues: sorted };
}

/**
 * The pose active at a given time.
 *
 * Before the first cue the first pose is used, so a track is defined from t=0 without
 * the author having to write a cue at exactly 0. After the last cue the last pose holds
 * forever, matching the scene model's hold-don't-extrapolate rule.
 */
export function poseAt(track: PoseTrack, time: number): string {
  const cues = track.cues;
  if (cues.length === 0) {
    throw new Error(`Pose track "${track.name}" has no cues.`);
  }

  let current = cues[0]!.poseId;
  for (const cue of cues) {
    if (time >= cue.time) current = cue.poseId;
    else break;
  }
  return current;
}

/** The set of pose names a track visits, in first-appearance order. */
export function posesInTrack(track: PoseTrack): readonly string[] {
  const seen: string[] = [];
  for (const cue of track.cues) {
    if (!seen.includes(cue.poseId)) seen.push(cue.poseId);
  }
  return seen;
}

/**
 * The ordered list of SWITCH TIMES in a track, excluding time 0.
 *
 * Used by tests and by the timeline UI to mark where cuts land, and to check that a
 * track has not accidentally been given two cues so close together that a hold
 * disappears.
 */
export function switchTimes(track: PoseTrack): readonly number[] {
  return track.cues.filter((cue) => cue.time > 0).map((cue) => cue.time);
}

/**
 * Turn a pose track into channel overrides suitable for `evaluate()`.
 *
 * HOW THIS WORKS
 * --------------
 * Every channel touched by ANY pose in the track is keyed at EVERY cue time, carrying
 * that cue's pose value with `step` easing. Keying the full union (rather than only the
 * channels a given pose mentions) is what prevents a stale value leaking from a previous
 * pose: if pose A rotates the left arm and pose B does not mention it, pose B must still
 * receive an explicit key returning the arm to rest, or the arm would stay rotated.
 *
 * @param track The pose track to render.
 * @param restRig The rig whose rest values fill in any channel a pose does not specify.
 *                 Defaults to reading each pose's own values and leaving the rest to the
 *                 rig, which is correct when every pose in a track is complete.
 */
export function poseTrackChannels(
  track: PoseTrack,
  restRig?: Rig,
): Record<string, Record<string, Channel>> {
  if (track.cues.length === 0) return {};

  const poses: Pose[] = track.cues.map((cue) => getPose(cue.poseId));

  // The union of every part/property any pose in this track touches.
  const touched = new Map<string, Set<string>>();
  for (const pose of poses) {
    for (const [partId, channels] of Object.entries(pose.channels)) {
      let props = touched.get(partId);
      if (!props) {
        props = new Set<string>();
        touched.set(partId, props);
      }
      for (const property of Object.keys(channels)) props.add(property);
    }
  }

  // Rest values, so a pose that omits a property still gets an explicit key.
  const restValues = new Map<string, Map<string, number>>();
  if (restRig) {
    for (const part of restRig.parts) {
      const byProp = new Map<string, number>();
      byProp.set("x", part.localPosition.x);
      byProp.set("y", part.localPosition.y);
      byProp.set("rotation", 0);
      byProp.set("scaleX", 1);
      byProp.set("scaleY", 1);
      byProp.set("opacity", 1);
      restValues.set(part.id, byProp);
    }
  }

  const out: Record<string, Record<string, Channel>> = {};

  for (const [partId, properties] of touched) {
    const partOut: Record<string, Channel> = {};

    for (const property of properties) {
      const keyframes: { time: number; value: number; easing: "step" }[] = [];

      for (let i = 0; i < track.cues.length; i++) {
        const cue = track.cues[i]!;
        const pose = poses[i]!;
        const fromPose = pose.channels[partId]?.[property];
        const explicit = readConstant(fromPose);

        const value =
          explicit ??
          restValues.get(partId)?.get(property) ??
          defaultFor(property);

        keyframes.push({
          time: cue.time,
          value,
          // The cue's own easing controls the segment INTO it. Default `step` means the
          // value jumps at the cue and holds in between: a pose swap, not a slide.
          easing: "step",
        });
      }

      // Apply any non-step easing the author explicitly asked for on a cue.
      for (let i = 1; i < track.cues.length; i++) {
        const requested = track.cues[i]!.easing;
        if (requested && requested !== "step") {
          keyframes[i] = { ...keyframes[i]!, easing: requested as "step" };
        }
      }

      partOut[property] = { kind: "number", keyframes };
    }

    out[partId] = partOut;
  }

  return out;
}

/**
 * Read the single constant value out of a one-keyframe channel.
 *
 * Poses are authored as constant channels, so this is how a pose's value is extracted
 * for re-keying onto a track. Returns undefined for a multi-keyframe channel, which a
 * pose should never contain — a pose with internal animation is not a pose.
 */
function readConstant(channel: Channel | undefined): number | undefined {
  if (!channel || channel.kind !== "number") return undefined;
  const frames = channel.keyframes;
  if (frames.length === 0) return undefined;
  return frames[0]!.value;
}

/** Sensible identity default for a property with no pose value and no rest rig. */
function defaultFor(property: string): number {
  if (property === "scaleX" || property === "scaleY") return 1;
  if (property === "opacity") return 1;
  return 0;
}

/**
 * Apply a pose track to a rig, returning a new rig that can be handed to `evaluate()`.
 *
 * The convenience entry point: one call turns a cut list into an animated character.
 */
export function applyPoseTrack(rig: Rig, track: PoseTrack): Rig {
  return applyChannels(rig, poseTrackChannels(track, rig));
}

/**
 * Build a track that cycles a list of poses at a fixed cadence.
 *
 * This is how a run cycle is expressed in limited animation: two or three poses swapped
 * on a beat, NOT a smoothly interpolated curve. `bounceHold` optionally holds each pose
 * for a whole number of beats, which is how a slower walk is built from the same poses.
 */
export function cycleTrack(
  name: string,
  poseIds: readonly string[],
  holdSeconds: number,
  repeats = 1,
): PoseTrack {
  if (poseIds.length === 0) {
    throw new Error(`Cycle track "${name}" needs at least one pose.`);
  }
  if (holdSeconds <= 0) {
    throw new Error(`Cycle track "${name}" needs a positive hold duration.`);
  }
  if (repeats <= 0) {
    throw new Error(`Cycle track "${name}" needs at least one repeat.`);
  }

  const cues: PoseCue[] = [];
  const beats = poseIds.length * repeats;
  for (let i = 0; i < beats; i++) {
    const poseId = poseIds[i % poseIds.length]!;
    // Time is computed by MULTIPLYING the beat index rather than accumulating
    // `time += holdSeconds`. Accumulation drifts: three additions of 0.3 give
    // 0.8999999999999999, so a cue that should land exactly on a frame boundary falls
    // just short of it and the switch fires one frame late.
    cues.push({ time: roundTime(i * holdSeconds), poseId });
  }
  // Close the loop explicitly so the final beat returns to the first pose, which is what
  // makes a repeating cycle seamless rather than stopping on its last pose.
  cues.push({ time: roundTime(beats * holdSeconds), poseId: poseIds[0]! });

  return poseTrack(name, cues);
}

/**
 * Round a time to microseconds.
 *
 * Timings are authored in decimal seconds (0.3, 0.12) and compared against frame
 * boundaries. Binary floating point cannot represent 0.3 exactly, so accumulating or
 * multiplying beats produces values like 0.8999999999999999 that compare unequal to the
 * 0.9 an author wrote. Rounding at the point of construction keeps cue times equal to
 * the decimals they were authored as, which makes `switchTimes` and any frame-aligned
 * comparison behave as expected. Microsecond resolution is far finer than any frame rate
 * this tool will target.
 */
function roundTime(seconds: number): number {
  return Math.round(seconds * 1e6) / 1e6;
}

// ---------------------------------------------------------------------------
// The show's standard tracks
// ---------------------------------------------------------------------------

/**
 * A silent talking loop: the body holds a neutral pose while the mouth flaps.
 *
 * Note that the BODY does not move here. In limited animation, talking is a mouth
 * performance on a held body; bouncing the whole figure on every syllable is the
 * mistake that makes limited animation look cheap.
 */
export const IDLE_TALKING: PoseTrack = cycleTrack("idleTalking", ["neutral"], 0.6, 4);

/** A greeting: neutral, then a wave held across several beats. */
export const GREETING: PoseTrack = poseTrack("greeting", [
  { time: 0, poseId: "neutral" },
  { time: 0.4, poseId: "wave" },
  { time: 1.6, poseId: "neutral" },
]);

/** A two-pose run cycle at the 0.3s cadence the brief specifies. */
export const RUN_CYCLE_TRACK: PoseTrack = cycleTrack(
  "runCycle",
  ["run", "runAlt"],
  0.3,
  2,
);

/** The trip: stand, trip, and hold the fallen pose. */
export const TRIP_TRACK: PoseTrack = poseTrack("tripFall", [
  { time: 0, poseId: "neutral" },
  { time: 0.5, poseId: "trip" },
  { time: 1.4, poseId: "trip" },
  { time: 1.6, poseId: "cower", easing: "easeOut" },
]);

/** Every standard track, keyed by name. */
export const POSE_TRACKS: Readonly<Record<string, PoseTrack>> = Object.freeze({
  idleTalking: IDLE_TALKING,
  greeting: GREETING,
  runCycle: RUN_CYCLE_TRACK,
  tripFall: TRIP_TRACK,
});

/**
 * Re-key a rig part list so every part carries `step`-eased channels.
 *
 * Used when a rig is animated purely by pose swaps: it converts the rig from "static
 * rest values" to "explicit channel values", which makes the swap semantics visible in
 * the data rather than implicit in `localPosition` fallbacks.
 */
export function materialiseChannels(rig: Rig): Rig {
  return {
    ...rig,
    parts: rig.parts.map((part: RigPart): RigPart => ({ ...part })),
  };
}