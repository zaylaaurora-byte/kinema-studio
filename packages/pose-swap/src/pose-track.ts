/**
 * `PoseTrack` — the central primitive of limited 2D animation.
 *
 * ---------------------------------------------------------------------------
 * SAMPLING IS A LOOKUP, NOT A CURVE EVALUATION
 * ---------------------------------------------------------------------------
 * A pose track is an ordered list of `{ time, poseId }`. Between two entries the earlier
 * pose is HELD. Nothing exists between entries — there is no segment to evaluate, no
 * easing to apply, and therefore no way for a limb to slide.
 *
 * This is what ADR 0003 calls for, and it is why this is not simply "keyframes with
 * strings". A string channel in the scene model with `step` easing gets the right answer,
 * but it still models the data as a curve with segment semantics that must be got right.
 * A lookup has no segment semantics at all. It is also the faster and more obviously
 * correct of the two, which is rare enough to be worth taking.
 *
 * ---------------------------------------------------------------------------
 * THE BOUNDARY RULE, STATED EXACTLY
 * ---------------------------------------------------------------------------
 * At EXACTLY a switch time, the NEW pose is active. One tick before, the OLD one is.
 *
 *     entries: [ {0, "A"}, {1, "B"} ]
 *     t = 0.9999 -> "A"
 *     t = 1.0    -> "B"     <- the new pose, at the exact instant
 *     t = 1.0001 -> "B"
 *
 * This is the single most common bug in this technique, and it is a real one rather than
 * a pedantic one: get it the other way round and every pose change in the show lands one
 * frame late, which reads as the character reacting *after* the line. The behaviour is
 * pinned by a dedicated test rather than left to emerge from whichever comparison
 * operator happened to be typed.
 *
 * Before the first entry the FIRST pose holds; after the last, the LAST pose holds. A
 * track is therefore defined for all real times, and an author never has to write a
 * redundant entry at exactly t=0.
 */

import type { Keyframe, NumberChannel, Rig } from "@kinema/scene-model";
import {
  CHANNEL_PROPERTIES,
  type ChannelProperty,
  type ChannelValues,
  type PoseLibrary,
} from "./pose.js";

/** One switch: from this time onward, this pose is active. */
export interface PoseEntry {
  /** Time in seconds at which this pose takes over. */
  readonly time: number;
  readonly poseId: string;
}

/**
 * An ordered list of pose switches with implicit holds.
 *
 * `entries` is guaranteed sorted and strictly increasing in time for any track produced by
 * `poseTrack()`. Construct one through that function rather than as a literal, so the
 * guarantee holds.
 */
export interface PoseTrack {
  readonly name: string;
  readonly entries: readonly PoseEntry[];
}

/**
 * Build a pose track, validating its ordering.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS THROWS INSTEAD OF SORTING
 * ---------------------------------------------------------------------------
 * Sorting out-of-order input is the tempting, friendly-looking choice, and it is the wrong
 * one. Out-of-order entries are always a BUG in the caller — a hand-authored cut list with
 * two shots pasted in the wrong order, or a cycle builder that reset its clock. Sorting
 * silently repairs the data and produces a track that is subtly not the one that was
 * intended, and the mistake surfaces much later as "the animation looks wrong somewhere".
 * Failing at construction names the exact index and time.
 *
 * A zero-length hold is rejected for the same reason. Two entries at the same time mean one
 * pose is never visible, which is never intended: an author who writes it has made an
 * arithmetic error, not a stylistic choice.
 */
export function poseTrack(name: string, entries: readonly PoseEntry[]): PoseTrack {
  if (entries.length === 0) {
    throw new Error(`Pose track "${name}" has no entries.`);
  }

  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i]!;

    if (!Number.isFinite(entry.time)) {
      throw new Error(
        `Pose track "${name}" entry ${i} has a non-finite time (${entry.time}).`,
      );
    }
    if (entry.time < 0) {
      throw new Error(
        `Pose track "${name}" entry ${i} has a negative time (${entry.time}). ` +
          `Times are measured from the start of the shot.`,
      );
    }

    if (i > 0) {
      const previous = entries[i - 1]!;
      if (entry.time === previous.time) {
        throw new Error(
          `Pose track "${name}" has two entries at t=${entry.time}s ` +
            `(indexes ${i - 1} and ${i}). One pose would never be visible; ` +
            `holds must have a positive duration.`,
        );
      }
      if (entry.time < previous.time) {
        throw new Error(
          `Pose track "${name}" entries are out of order: index ${i} is at ` +
            `t=${entry.time}s but index ${i - 1} is at t=${previous.time}s.`,
        );
      }
    }
  }

  return { name, entries: [...entries] };
}

/**
 * The pose active at `time`.
 *
 * A lookup: scan for the last entry whose time has been reached, and return its pose.
 * See the file header for the exact boundary semantics.
 *
 * `time` is NOT clamped to the track's range. A track describes what to show at any time,
 * including before its first entry and long after its last — clamping here would silently
 * discard the caller's timing and break a sequence assembled from several tracks.
 */
export function samplePose(track: PoseTrack, time: number): string {
  const entries = track.entries;
  if (entries.length === 0) {
    throw new Error(`Pose track "${track.name}" has no entries.`);
  }

  // Start on the first entry, which give the before-first-entry hold for free.
  let current = entries[0]!.poseId;

  for (const entry of entries) {
    // `>=` is the boundary rule: at exactly the switch time, this entry wins.
    if (time >= entry.time) current = entry.poseId;
    else break;
  }

  return current;
}

/**
 * The entry active at `time`, with its time and index.
 *
 * Needed by an editor that highlights the current cue, and by `holds()`. Returning the
 * index as well as the entry avoids a second lookup by identity.
 */
export interface ActivePose {
  readonly poseId: string;
  /** Start time of the hold this sample landed in. */
  readonly startTime: number;
  readonly index: number;
}

export function samplePoseEntry(track: PoseTrack, time: number): ActivePose {
  const entries = track.entries;
  if (entries.length === 0) {
    throw new Error(`Pose track "${track.name}" has no entries.`);
  }

  let index = 0;
  for (let i = 0; i < entries.length; i++) {
    if (time >= entries[i]!.time) index = i;
    else break;
  }

  const entry = entries[index]!;
  return { poseId: entry.poseId, startTime: entry.time, index };
}

/** A hold: one pose, held for a measured span. What an editor draws as a bar. */
export interface Hold {
  readonly poseId: string;
  readonly startTime: number;
  /**
   * End time of the hold: the start of the next entry, or the optional `until` passed to
   * `holds()`. The final hold of an unclosed track is open-ended.
   */
  readonly endTime: number | undefined;
  readonly duration: number | undefined;
  readonly index: number;
}

/**
 * Derive the holds in a track, so an editor can show them as bars.
 *
 * `until` closes the final hold; without it the last hold has `endTime`/`duration`
 * `undefined`, because a track genuinely does not know how long its last pose is held —
 * that is decided by the shot, not the track. Reporting 0 or Infinity there would both be
 * lies that an editor would then draw as a zero-width or endless bar.
 *
 * Consecutive entries naming the SAME pose are merged into one hold. They are
 * indistinguishable to a viewer — the pose did not change — so presenting them as two bars
 * would misrepresent the animation and invite an editor to trim a non-existent cut.
 */
export function holds(track: PoseTrack, until?: number): readonly Hold[] {
  const entries = track.entries;
  if (entries.length === 0) return [];

  if (until !== undefined && until < entries[0]!.time) {
    throw new Error(
      `holds(): "until" (${until}s) is before the track's first entry ` +
        `(${entries[0]!.time}s).`,
    );
  }

  const out: Hold[] = [];

  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i]!;
    const previous = out[out.length - 1];
    if (previous && previous.poseId === entry.poseId) continue;

    out.push({
      poseId: entry.poseId,
      startTime: entry.time,
      endTime: undefined,
      duration: undefined,
      index: i,
    });
  }

  return out.map((hold, holdIndex): Hold => {
    const isLast = holdIndex === out.length - 1;
    // The end of a hold is either the next DISTINCT hold's start, or the `until` given by
    // the caller for the final one.
    const nextStart = !isLast
      ? out[holdIndex + 1]!.startTime
      : until !== undefined
        ? until
        : undefined;

    if (nextStart === undefined) return hold;
    return {
      ...hold,
      endTime: nextStart,
      duration: nextStart - hold.startTime,
    };
  });
}

/**
 * Total duration of a track: the time of its last entry.
 *
 * This is the duration of the CONTENT, not of the last pose. The last pose is held
 * indefinitely (see `samplePose`), so a track's total duration is necessarily the moment
 * of its final switch. Callers who need a closed duration pass it explicitly.
 */
export function totalDuration(track: PoseTrack): number {
  const entries = track.entries;
  if (entries.length === 0) return 0;
  return entries[entries.length - 1]!.time;
}

/** Every distinct pose a track visits, in first-appearance order. */
export function posesInTrack(track: PoseTrack): readonly string[] {
  const seen: string[] = [];
  for (const entry of track.entries) {
    if (!seen.includes(entry.poseId)) seen.push(entry.poseId);
  }
  return seen;
}

/**
 * Switch times in the track, excluding entries at t=0.
 *
 * Used by tests and the timeline UI to mark where cuts land. t=0 is excluded because it is
 * the track's start, not a switch: nothing is being swapped there.
 */
export function switchTimes(track: PoseTrack): readonly number[] {
  return track.entries.filter((e) => e.time > 0).map((e) => e.time);
}

/**
 * Number of times the ACTIVE POSE changes across `[0, duration)` at `fps`.
 *
 * This is the measurement that makes "cadence quantisation reduced the number of switches"
 * a checkable claim rather than an impression, so its definition is pinned:
 *
 *  - Frames are sampled at `i / fps`, and the pose is compared between consecutive frames.
 *  - The count is of CHANGES, not of distinct poses. Alternating A,B,A,B gives three.
 *  - Consecutive entries naming the same pose contribute no change, matching `holds()`.
 */
export function countPoseSwitches(
  track: PoseTrack,
  duration: number,
  fps: number,
): number {
  if (fps <= 0) throw new Error(`countPoseSwitches() needs a positive fps.`);
  if (duration <= 0) return 0;

  const frameCount = Math.round(duration * fps);
  if (frameCount < 2) return 0;

  let switches = 0;
  let previous = samplePose(track, 0);
  for (let frame = 1; frame < frameCount; frame++) {
    const current = samplePose(track, frame / fps);
    if (current !== previous) switches++;
    previous = current;
  }
  return switches;
}

/**
 * Apply a pose track to a rig: the one call that turns a cut list into an animated rig.
 *
 * ---------------------------------------------------------------------------
 * WHY THE FULL CHANNEL UNION IS KEYED AT EVERY SWITCH
 * ---------------------------------------------------------------------------
 * Every channel touched by ANY pose in the track gets an explicit key at EVERY switch
 * time, carrying that switch's value — including entirely back to the rig's rest value
 * when the incoming pose does not mention the part.
 *
 * The alternative, keying only what each pose mentions, has a specific and ugly failure:
 * pose A raises the left arm, pose B does not mention the left arm, so the arm stays
 * raised through B. The character keeps an arm in the air for the rest of the shot. Keying
 * the union makes every switch total, so a pose is always exactly what it says it is.
 *
 * Keys use `step` easing, which holds the value across the segment and jumps at the end —
 * the discrete behaviour. Single-keyframe channels would not work here, because a track
 * has many switch times that each need to take effect.
 *
 * Values a pose omits fall back to, in order: the rig's rest value for that property, then
 * an identity default. Without the rest fallback, a part at x=40 would be yanked to x=0 on
 * the first switch, which is the classic "the character teleports to the origin" bug.
 */
export function applyPoseTrack(rig: Rig, track: PoseTrack, library: PoseLibrary): Rig {
  const entries = track.entries;
  if (entries.length === 0) {
    throw new Error(`Cannot apply pose track "${track.name}": it has no entries.`);
  }

  const poses = entries.map((entry) => library.get(entry.poseId));

  // Union of part/property pairs touched by any pose in this track. Iterating the KNOWN
  // property list rather than `Object.keys(values)` means an unexpected key in a pose is
  // ignored here rather than producing a channel the evaluator never reads.
  const touched = new Map<string, Set<ChannelProperty>>();
  for (const pose of poses) {
    for (const [partId, values] of Object.entries(pose.channels)) {
      let properties = touched.get(partId);
      if (!properties) {
        properties = new Set<ChannelProperty>();
        touched.set(partId, properties);
      }
      for (const property of CHANNEL_PROPERTIES) {
        if (values[property] !== undefined) properties.add(property);
      }
    }
  }

  // Rest values, so a pose that omits a property still receives an explicit key.
  const rest = new Map<string, Map<string, number>>();
  for (const part of rig.parts) {
    rest.set(
      part.id,
      new Map<string, number>([
        ["x", part.localPosition.x],
        ["y", part.localPosition.y],
        ["rotation", 0],
        ["scaleX", 1],
        ["scaleY", 1],
      ]),
    );
  }

  const overrides: Record<string, Record<string, NumberChannel>> = {};

  for (const [partId, properties] of touched) {
    const partChannels: Record<string, NumberChannel> = {};

    for (const property of properties) {
      const keyframes: Keyframe<number>[] = entries.map((entry, entryIndex) => {
        const value =
          readNumber(poses[entryIndex]!.channels[partId], property) ??
          rest.get(partId)?.get(property) ??
          identityDefault(property);

        return { time: entry.time, value, easing: "step" as const };
      });

      partChannels[property] = { kind: "number", keyframes };
    }

    overrides[partId] = partChannels;
  }

  return {
    ...rig,
    parts: rig.parts.map((part) => {
      const override = overrides[part.id];
      if (!override) return part;
      return { ...part, channels: { ...part.channels, ...override } };
    }),
  };
}

/**
 * Read one numeric property from a pose's channel values for a part, if set.
 *
 * Typed against `ChannelValues` rather than a loose index-record, so the property name is
 * checked at the call site instead of being a free-form string that can silently miss.
 */
function readNumber(
  values: ChannelValues | undefined,
  property: ChannelProperty,
): number | undefined {
  if (!values) return undefined;
  const value = values[property];
  return typeof value === "number" ? value : undefined;
}

/** Identity default for a property no pose and no rig supplies. */
function identityDefault(property: string): number {
  if (property === "scaleX" || property === "scaleY") return 1;
  return 0;
}