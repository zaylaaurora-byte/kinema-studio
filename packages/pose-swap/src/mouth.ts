/**
 * Mouth flaps — the "mouth moving" half of "we have poses and then mouth moving".
 *
 * ---------------------------------------------------------------------------
 * THE CLOSED SET
 * ---------------------------------------------------------------------------
 * ADR 0003 fixes six shapes, derived from the reference sheets' "MOUTH (VARIETY)"
 * studies. It is a CLOSED set on purpose. A mouth that can be any shape is a mouth that is
 * being morphed, which is smooth animation — the wrong technique. Six discrete drawings
 * cycled on a beat is what reads as the style.
 *
 * The two characters do not share a mouth, which is the whole reason the mapping is a
 * parameter rather than a constant:
 *
 *  - The **human's** mouth is an elastic lens shape on a blank white face. Squashing it
 *    flat is a grimace; stretching it tall is a wail. His entire performance is face.
 *  - The **host's** mouth is a fanged anime mouth with a visible upper fang and a large
 *    pink tongue. Only the widest shapes expose the fang, so her fricatives and her
 *    laughter read very differently from his.
 *
 * `DEFAULT_VISEME_MAP` below is the neutral starting point. Each library supplies its own
 * tuned map; neither is a global constant consulted behind the caller's back.
 */

import { poseTrack, samplePoseEntry, type PoseTrack } from "./pose-track.js";

/**
 * The six mouth shapes. A closed set — see the file header.
 *
 * Named as the ADR names them, because these names appear in the sheet annotations and in
 * the audio alignment data, and inventing a second vocabulary would guarantee a mismatch.
 */
export type MouthShape =
  | "closed"
  | "openSmall"
  | "openWide"
  | "oShape"
  | "teeth"
  | "smile";

/** Every mouth shape, in a stable order (closed first: it is the resting shape). */
export const MOUTH_SHAPES = [
  "closed",
  "openSmall",
  "openWide",
  "oShape",
  "teeth",
  "smile",
] as const;

/**
 * Standard viseme groups.
 *
 * These are the Oculus/Preston-Blair-style groups that audio alignment tools emit. The
 * exact taxonomy varies between tools, so the mapping below is deliberately expressed in
 * terms of these coarse GROUPS rather than individual phonemes: a tool that emits a finer
 * or coarser set can be mapped onto these seven without touching the shapes.
 */
export type VisemeGroup =
  | "silence"
  | "PP"
  | "FF"
  | "TH"
  | "DD"
  | "kk"
  | "CH"
  | "SS"
  | "nn"
  | "RR"
  | "aa"
  | "E"
  | "I"
  | "O"
  | "U";

/** One viseme event on the audio timeline. */
export interface VisemeEvent {
  readonly time: number;
  readonly viseme: VisemeGroup;
  /** Optional confidence, for tools that supply it. Unused by the mapping itself. */
  readonly weight?: number;
}

/**
 * ---------------------------------------------------------------------------
 * THE VISEME -> MOUTH SHAPE TABLE
 * ---------------------------------------------------------------------------
 * THIS IS THE TABLE AN ARTIST TUNES. Everything else in this file is machinery.
 *
 * Read it as: "when the audio says this group, draw this shape." The reasoning for each
 * row is stated so the table can be argued with rather than merely obeyed.
 *
 * | viseme   | shape       | why |
 * |---|---|---|
 * | `silence`| `closed`    | Between words and pauses. The resting mouth. |
 * | `PP`     | `closed`    | p/b/m are bilabial: the lips are genuinely shut. Showing an open shape here is the clearest lip-sync error there is. |
 * | `FF`     | `teeth`     | f/v. Upper teeth on lower lip — the closest shape in the set, and it reads as effort. |
 * | `TH`     | `teeth`     | th. Tongue to teeth; same drawn shape as FF in this vocabulary. |
 * | `DD`     | `openSmall` | t/d/n/l. A small tongue-tip opening. |
 * | `kk`     | `openSmall` | k/g. Back of the mouth, barely visible from the front. |
 * | `CH`     | `oShape`    | ch/sh/dj. Rounded with the lips pushed forward. |
 * | `SS`     | `teeth`     | s/z. A narrow hiss through closed teeth. |
 * | `nn`     | `openSmall` | n/ng. Same small opening as DD. |
 * | `RR`     | `oShape`    | r. Lips round slightly. |
 * | `aa`     | `openWide`  | The open "ah" — the widest shape, and the shouting shape. |
 * | `E`      | `openSmall` | Short front vowels, "eh". |
 * | `I`      | `openSmall` | "ih"/"ee" — a spread but not-yet-wide shape. |
 * | `O`      | `oShape`    | Round vowels. |
 * | `U`      | `oShape`    | "oo"/"w" — the most rounded, and the same drawn shape as O here. |
 *
 * A shape is deliberately reused across several visemes. Six drawings must cover fifteen
 * groups; pretending otherwise would mean asking for ten more drawings, and the extra
 * fidelity would not survive a 0.3 s hold anyway.
 */
export const DEFAULT_VISEME_MAP: Readonly<Record<VisemeGroup, MouthShape>> =
  Object.freeze({
    silence: "closed",
    PP: "closed",
    FF: "teeth",
    TH: "teeth",
    DD: "openSmall",
    kk: "openSmall",
    CH: "oShape",
    SS: "teeth",
    nn: "openSmall",
    RR: "oShape",
    aa: "openWide",
    E: "openSmall",
    I: "openSmall",
    O: "oShape",
    U: "oShape",
  });

/**
 * A per-character partial override of the table.
 *
 * A partial map, not a full one, because an override is nearly always a small correction
 * ("on HER, `aa` shows the fang"). Requiring the artist to restate all fifteen rows would
 * make a one-shape tweak a fifteen-line change and guarantee the table drifts out of sync
 * with the default.
 */
export type VisemeMap = Readonly<Partial<Record<VisemeGroup, MouthShape>>>;

/**
 * Resolve a partial per-character map against the default table.
 *
 * Exported so a test can assert the resolved table directly, rather than inferring it from
 * sampled output.
 */
export function resolveVisemeMap(overrides?: VisemeMap): Record<VisemeGroup, MouthShape> {
  return { ...DEFAULT_VISEME_MAP, ...(overrides ?? {}) };
}

/**
 * A mouth track: mouth shapes swapped on a beat, with the same hold semantics as a pose
 * track.
 *
 * It is a `PoseTrack` rather than a parallel type. A mouth shape IS a pose — a discrete
 * named configuration held until the next switch — and giving it a separate type would
 * duplicate `samplePose`, `holds` and the boundary rule, which is precisely where the
 * off-by-one lives. One implementation, one place to get it right.
 */
export type MouthTrack = PoseTrack;

/** Build a mouth track from `{ time, shape }` entries. Validated like any pose track. */
export function mouthTrack(
  name: string,
  entries: readonly { readonly time: number; readonly shape: MouthShape }[],
): MouthTrack {
  return poseTrack(
    name,
    entries.map((entry) => ({ time: entry.time, poseId: entry.shape })),
  );
}

/** The mouth shape active at `time`, with the same boundary rule as `samplePose`. */
export function sampleMouth(track: MouthTrack, time: number): MouthShape {
  const active = samplePoseEntry(track, time);
  if (!isMouthShape(active.poseId)) {
    throw new Error(
      `Mouth track "${track.name}" contains "${active.poseId}", which is not a mouth ` +
        `shape. Valid shapes: ${MOUTH_SHAPES.join(", ")}`,
    );
  }
  return active.poseId;
}

function isMouthShape(value: string): value is MouthShape {
  return (MOUTH_SHAPES as readonly string[]).includes(value);
}

export interface MouthFromVisemesOptions {
  /** Per-character mapping overrides. See `VisemeMap`. */
  readonly visemeMap?: VisemeMap;
  /**
   * Quantise flap changes to a fixed beat, in seconds.
   *
   * ---------------------------------------------------------------------------
   * WHY THIS IS THE OPTION THAT MAKES IT LOOK LIKE THE STYLE
   * ---------------------------------------------------------------------------
   * Raw viseme timing is dense and irregular: an alignment tool emits a new viseme every
   * 40-90 ms through speech. Drawn literally, that is a mouth shape changing twenty times
   * a second — which is not limited animation, it is noise, and it reads as a mouth
   * vibrating rather than a character talking.
   *
   * Real shows in this style change the mouth on a BEAT. Setting `cadence` to e.g. 0.1 s
   * snaps every flap to a 10 fps grid, which does three things at once: it collapses
   * runs of near-identical shapes into one held drawing, it makes the mouth move in step
   * with the body's pose swaps, and it lets the eye actually read each shape.
   *
   * The claim "cadence reduces the number of switches" is asserted by test, not assumed.
   */
  readonly cadence?: number;
  /**
   * Minimum time a shape must be held before a new one may replace it, in seconds.
   *
   * Distinct from `cadence`: cadence quantises *when* flaps land, this suppresses flaps
   * that would be too short to read even on the grid. Applied after quantisation.
   */
  readonly minHold?: number;
  /** Name for the produced track. */
  readonly name?: string;
  /** Time at which the resulting track starts. Defaults to the first viseme's time. */
  readonly startTime?: number;
}

/**
 * Build a mouth track from a viseme timeline.
 *
 * The pipeline, in order, and the order matters:
 *
 *   1. **Map** each viseme to a shape, using the resolved (per-character) table.
 *   2. **Sort** by time. Audio alignment output is usually sorted, but ties and small
 *      inversions occur at boundaries, and `poseTrack` rejects inversion rather than
 *      repairing it — so sorting here, where it is legitimately part of the transform, is
 *      what keeps that strictness from becoming a nuisance.
 *   3. **Quantise** to the cadence grid if one is given (see `cadence`).
 *   4. **Collapse** consecutive duplicates. Two entries naming the same shape are one
 *      hold; keeping both would make `holds()` report a cut that does not exist.
 *   5. **Enforce** `minHold` by dropping flaps too short to read.
 *
 * A silent stretch produces a `closed` hold rather than a gap, so the mouth is always
 * defined and never pops open on a missing value.
 */
export function mouthFromVisemes(
  visemes: readonly VisemeEvent[],
  options: MouthFromVisemesOptions = {},
): MouthTrack {
  const name = options.name ?? "mouth";
  const map = resolveVisemeMap(options.visemeMap);

  if (visemes.length === 0) {
    // An empty timeline is a closed mouth, not an error: a character who says nothing for
    // five seconds still needs a mouth, and "no data" must not mean "no mouth".
    return mouthTrack(name, [{ time: options.startTime ?? 0, shape: "closed" }]);
  }

  const cadence = options.cadence;
  if (cadence !== undefined && cadence <= 0) {
    throw new Error(`mouthFromVisemes(): cadence must be positive, got ${cadence}.`);
  }

  // 1 + 2: map, then sort by time. `[...visemes]` first so the caller's array is untouched.
  //
  // `startTime` is an OFFSET applied to every viseme, not a replacement: a viseme timeline
  // is always authored from zero relative to its own audio, and a shot places that audio at
  // some point on the timeline. Replacing the time instead of offsetting it would collapse
  // the whole line onto one instant.
  const startTime = options.startTime ?? 0;
  const mapped = [...visemes]
    .sort((a, b) => a.time - b.time)
    .map((event) => ({
      time: startTime + Math.max(0, event.time),
      shape: map[event.viseme],
    }));

  // 3: quantise to the beat. Each viseme's switch time snaps DOWN to the grid, which keeps
  // a flap from ever appearing before the sound that caused it. Quantisation is applied to
  // the time RELATIVE to `startTime`, so the grid stays aligned to the audio rather than
  // being shifted by wherever the shot happens to place it.
  const frames =
    cadence === undefined
      ? mapped
      : mapped.map((entry) => ({
          ...entry,
          time: startTime + Math.floor((entry.time - startTime) / cadence) * cadence,
        }));

  // 4: collapse runs of the same shape, keeping the earliest time in the run.
  const collapsed: { time: number; shape: MouthShape }[] = [];
  for (const frame of frames) {
    const previous = collapsed[collapsed.length - 1];
    if (previous && previous.shape === frame.shape) continue;
    // A quantised shape can land on a time already taken by the previous entry; keeping
    // the later one would produce a zero-length hold, which `poseTrack` rejects.
    if (previous && frame.time <= previous.time) continue;
    collapsed.push({ time: frame.time, shape: frame.shape });
  }

  // 5: drop flaps shorter than `minHold`.
  const minHold = options.minHold;
  const held =
    minHold === undefined || minHold <= 0
      ? collapsed
      : collapsed.filter((frame, index) => {
          const next = collapsed[index + 1];
          // The final flap is open-ended, so it is never "too short".
          if (!next) return true;
          return next.time - frame.time >= minHold;
        });

  if (held.length === 0) {
    return mouthTrack(name, [{ time: options.startTime ?? 0, shape: "closed" }]);
  }

  return mouthTrack(name, held);
}

/**
 * The mouth shape to draw when a character is not talking.
 *
 * Exists so the idle mouth is a named decision rather than a literal repeated wherever an
 * idle is built. `closed` is the default; `smile` is available for a character who holds a
 * pleasant expression between lines, which is what the host's sheet shows her doing.
 */
export const IDLE_MOUTH: MouthShape = "closed";
export const IDLE_MOUTH_SMILING: MouthShape = "smile";

/** A mouth track that simply holds one shape for the whole shot. */
export function heldMouth(
  shape: MouthShape,
  duration: number,
  name = "heldMouth",
): MouthTrack {
  return mouthTrack(name, [
    { time: 0, shape },
    { time: duration, shape },
  ]);
}