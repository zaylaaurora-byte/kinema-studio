/**
 * Pose cycles — A ↔ B alternation at a fixed cadence.
 *
 * ---------------------------------------------------------------------------
 * A CYCLE IS NOT AN ANIMATION CURVE
 * ---------------------------------------------------------------------------
 * In limited animation a run is not a smoothly interpolated gait. It is two or three
 * EXTREME DRAWINGS swapped on a beat, and the audience's eye supplies the motion between
 * them. That is the entire technique, and it is why this file produces a `PoseTrack`
 * rather than anything the scene model would interpolate.
 *
 * ---------------------------------------------------------------------------
 * WHY ALTERNATION IS ENFORCED RATHER THAN ASSUMED
 * ---------------------------------------------------------------------------
 * The characteristic failure of this style is a cycle that does not actually alternate:
 * `[runA, runA]`, or two poses so similar they read as one drawing. The character then
 * stands perfectly still while the timeline claims a run cycle is playing. It looks like a
 * rendering bug, and it is easy to ship because the code is "correct" — it does swap poses
 * on a beat, the poses just happen to be the same.
 *
 * `expandCycle` therefore refuses a cycle whose poses are not distinct, when the caller
 * supplies a library to check against. A cycle is a claim that something moves; this makes
 * the claim checkable at construction instead of at review.
 */

import { createPoseLibrary, type Pose, type PoseLibrary } from "./pose.js";
import { poseTrack, type PoseEntry, type PoseTrack } from "./pose-track.js";

/**
 * An alternating sequence of poses at a fixed frame duration.
 *
 * `poseIds` lists the DISTINCT drawings. `holdSeconds` is how long each is held, which the
 * ADR constrains to roughly 0.3-0.8 s: shorter reads as a glitch, longer reads as a freeze.
 */
export interface PoseCycle {
  readonly name: string;
  /** The poses, in cycle order. Must alternate between genuinely different poses. */
  readonly poseIds: readonly string[];
  /** How long each pose is held, in seconds. */
  readonly holdSeconds: number;
  /**
   * Optional closing pose.
   *
   * A cycle that is played once and left in the scene usually wants to END on its first
   * pose, so the character lands on a clean drawing rather than freezing mid-stride. Loops
   * that repeat do not need it.
   */
  readonly endPoseId?: string;
}

export interface ExpandCycleOptions {
  /**
   * Library to validate pose ids against.
   *
   * When supplied, `expandCycle` rejects a cycle with fewer than two DISTINCT poses, and
   * rejects unknown ids at construction rather than at sample time. Pass the library the
   * poses actually come from.
   */
  readonly library?: PoseLibrary;
  /** Require at least this many distinct poses. Defaults to 2. */
  readonly minDistinctPoses?: number;
}

/**
 * Expand a cycle into a `PoseTrack` over `[startTime, startTime + duration)`.
 *
 * The cycle repeats for as long as the duration requires. The final entry is only emitted
 * when a switch genuinely falls inside the window, so the track never carries a trailing
 * entry at or beyond the end — that would be a hold of zero length, which `poseTrack`
 * correctly rejects and which would be meaningless anyway.
 */
export function expandCycle(
  cycle: PoseCycle,
  startTime: number,
  duration: number,
  options: ExpandCycleOptions = {},
): PoseTrack {
  const minDistinct = options.minDistinctPoses ?? 2;

  if (cycle.poseIds.length === 0) {
    throw new Error(`Cycle "${cycle.name}" has no poses.`);
  }
  if (cycle.holdSeconds <= 0) {
    throw new Error(
      `Cycle "${cycle.name}" needs a positive holdSeconds, got ${cycle.holdSeconds}.`,
    );
  }
  if (duration < 0) {
    throw new Error(`expandCycle("${cycle.name}"): duration must not be negative.`);
  }

  const distinct = [...new Set(cycle.poseIds)];
  if (distinct.length < Math.max(2, minDistinct)) {
    throw new Error(
      `Cycle "${cycle.name}" lists ${distinct.length} distinct pose(s) ` +
        `(${cycle.poseIds.join(", ")}) but a cycle must alternate between at least ` +
        `${Math.max(2, minDistinct)} genuinely different poses. A cycle that repeats ` +
        `one pose is a frozen character, not an animation.`,
    );
  }

  // Validate ids eagerly when a library is available, so a typo is a construction error
  // rather than a crash on the first frame of a render.
  if (options.library) {
    for (const poseId of cycle.poseIds) options.library.get(poseId);
    if (cycle.endPoseId !== undefined) options.library.get(cycle.endPoseId);
  }

  const entries: PoseEntry[] = [];
  const step = cycle.holdSeconds;
  let index = 0;

  for (let time = startTime; time < startTime + duration; time += step) {
    // Floating-point accumulation is avoided by computing the time from the index rather
    // than repeatedly adding `step`, which would drift after a few hundred frames.
    const entryTime = startTime + index * step;
    if (entryTime >= startTime + duration) break;

    entries.push({ time: entryTime, poseId: cycle.poseIds[index % cycle.poseIds.length]! });
    index++;
  }

  if (entries.length === 0) {
    // A window shorter than one hold still needs a pose: show the cycle's first drawing.
    entries.push({ time: startTime, poseId: cycle.poseIds[0]! });
  }

  if (cycle.endPoseId !== undefined && entries.length > 0) {
    entries.push({ time: startTime + duration, poseId: cycle.endPoseId });
  }

  return poseTrack(cycle.name, entries);
}

// ---------------------------------------------------------------------------
// The three cycles the show actually uses
// ---------------------------------------------------------------------------

/**
 * Speak cycle — a character talking while otherwise idle.
 *
 * NOTE WHAT THE BODY DOES: almost nothing. Two near-identical standing poses are swapped
 * on a slow beat to give a breathing settle, and the mouth carries the performance. The
 * error that makes limited animation look cheap is bouncing the whole figure on every
 * syllable; the reference shows a held body with a moving mouth, so that is what this is.
 *
 * The beat is deliberately SLOWER than the mouth cadence (see `mouth.ts`), so body and
 * mouth do not lock together into an obvious machine pulse.
 */
export function speakCycle(idleA: string, idleB: string): PoseCycle {
  return {
    name: "speak",
    poseIds: [idleA, idleB],
    // ~0.8 s: the slow end of the ADR's 0.3-0.8 s band, because breathing is slow and
    // anything faster reads as a nervous twitch under a talking mouth.
    holdSeconds: 0.8,
  };
}

/**
 * Run cycle — two contact poses at the ADR's fast end of the band.
 *
 * 0.3 s ≈ 6.7 fps alternation, which is what makes a two-drawing run read as speed rather
 * than as a shuffle.
 */
export function runCycle(runA: string, runB: string): PoseCycle {
  return {
    name: "run",
    poseIds: [runA, runB],
    holdSeconds: 0.3,
  };
}

/**
 * Idle cycle — a quiet breathing / weight shift.
 *
 * MINIMUM TWO POSES, and this is the requirement that matters most in the whole file. A
 * character with a single idle pose is a frozen PNG, and a frozen PNG in a shot that is
 * supposedly animated is exactly the "Ken Burns zoom passed off as animation" failure the
 * pilot brief forbids. Two subtly different standing drawings make the character
 * unambiguously alive even while doing nothing.
 *
 * 0.7 s per hold: fast enough that a viewer registers movement, slow enough that it does
 * not look like fidgeting.
 */
export function idleCycle(idleA: string, idleB: string): PoseCycle {
  return {
    name: "idle",
    poseIds: [idleA, idleB],
    holdSeconds: 0.7,
  };
}

/**
 * A three-pose run: two contacts plus the gathered "up" beat between them.
 *
 * Kept here rather than in the library because it is a cadence decision, not a drawing
 * decision. Two poses read as a shuffle; the middle beat is what gives the run weight.
 */
export function runCycleThree(up: string, contactA: string, contactB: string): PoseCycle {
  return {
    name: "runThree",
    poseIds: [contactA, up, contactB, up],
    holdSeconds: 0.2,
  };
}

/**
 * Build a `PoseLibrary` from `Pose` values. Re-exported convenience for callers that want
 * to assemble a cycle's poses inline without importing from `./pose.js`.
 */
export function cycleLibrary(name: string, poses: readonly Pose[]): PoseLibrary {
  return createPoseLibrary(name, poses);
}