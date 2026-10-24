/**
 * Character libraries: the named pose sets for the show's two characters.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS FILE EXISTS SEPARATELY FROM `human.ts` / `host.ts`
 * ---------------------------------------------------------------------------
 * Those two modules hold the DRAWN DATA — the numbers, one pose at a time. This module
 * assembles that data into the two things a caller actually wants:
 *
 *   1. a single `PoseLibrary` per character, covering BODY and MOUTH poses together, so a
 *      body swap and a mouth flap are looked up through one namespace and cannot disagree;
 *   2. the per-character viseme map, resolved, so the mouth builder takes it as a plain
 *      argument.
 *
 * Keeping the split means the pose data stays readable as a list of drawings, and the
 * wiring stays in one auditable place.
 */

import { createPoseLibrary, type Pose, type PoseLibrary } from "../pose.js";
import { resolveVisemeMap, type VisemeMap, type VisemeGroup, type MouthShape } from "../mouth.js";
import {
  HUMAN_MOUTH_POSES,
  HUMAN_POSES,
  HUMAN_VISEME_OVERRIDES,
} from "./human.js";
import {
  HOST_MOUTH_POSES,
  HOST_POSES,
  HOST_VISEME_OVERRIDES,
} from "./host.js";

/**
 * The Silent Human's pose library: body poses plus mouth shapes in one namespace.
 *
 * Body and mouth names do not collide — body poses are things like `wave`, mouth shapes are
 * the six mouth names — so one library is safe and avoids a caller having to know which of
 * two lookups to use.
 */
export const humanLibrary: PoseLibrary = createPoseLibrary("human", [
  ...HUMAN_POSES,
  ...HUMAN_MOUTH_POSES,
]);

/** The Demon Host's pose library: body poses plus mouth shapes in one namespace. */
export const hostLibrary: PoseLibrary = createPoseLibrary("host", [
  ...HOST_POSES,
  ...HOST_MOUTH_POSES,
]);

/** The human's resolved viseme table (defaults; he overrides nothing). */
export const humanVisemeMap: Readonly<Record<VisemeGroup, MouthShape>> =
  resolveVisemeMap(HUMAN_VISEME_OVERRIDES);

/** The host's resolved viseme table, including her smirk-on-silence and her fanged hiss. */
export const hostVisemeMap: Readonly<Record<VisemeGroup, MouthShape>> =
  resolveVisemeMap(HOST_VISEME_OVERRIDES);

/** A character: everything needed to animate them. */
export interface CharacterPoses {
  readonly name: string;
  readonly library: PoseLibrary;
  /** Resolved viseme table for this character's mouth. */
  readonly visemeMap: Readonly<Record<VisemeGroup, MouthShape>>;
  /** The same table as a partial override, for passing straight to `mouthFromVisemes`. */
  readonly visemeOverrides: VisemeMap;
  /** Body poses only, without the mouth shapes. */
  readonly bodyPoses: readonly Pose[];
  /** Mouth shape poses only. */
  readonly mouthPoses: readonly Pose[];
  /** The two idle poses, for building an idle or speak cycle. */
  readonly idle: { readonly a: string; readonly b: string };
  /** The two run contacts, for building a run cycle. */
  readonly run: { readonly a: string; readonly b: string };
  /** The pose a shot starts and returns to. */
  readonly rest: string;
}

export const human: CharacterPoses = {
  name: "human",
  library: humanLibrary,
  visemeMap: humanVisemeMap,
  visemeOverrides: HUMAN_VISEME_OVERRIDES,
  bodyPoses: HUMAN_POSES,
  mouthPoses: HUMAN_MOUTH_POSES,
  idle: { a: "idleA", b: "idleB" },
  run: { a: "runA", b: "runB" },
  rest: "neutral",
};

export const host: CharacterPoses = {
  name: "host",
  library: hostLibrary,
  visemeMap: hostVisemeMap,
  visemeOverrides: HOST_VISEME_OVERRIDES,
  bodyPoses: HOST_POSES,
  mouthPoses: HOST_MOUTH_POSES,
  idle: { a: "idleA", b: "idleB" },
  // The host has no run in the pilot; her pair is a pose she genuinely alternates between.
  // Pointing it at two distinct poses keeps `CharacterPoses` total without inventing a run
  // cycle she does not have.
  run: { a: "pointing", b: "laughing" },
  rest: "neutral",
};

/** Both characters, keyed by name. */
export const CHARACTERS: Readonly<Record<string, CharacterPoses>> = Object.freeze({
  human,
  host,
});

/*
 * NOTE — no `export *` here.
 *
 * Both character modules define poses with the same SHORT names (`neutral`, `idleA`,
 * `closed`, ...), because inside its own module each name is unambiguous and reads better
 * unqualified. Re-exporting both with `*` would make those collide, and the collision
 * resolves to whichever module was listed last — a silent wrong-pose bug.
 *
 * So the barrel exports the character-qualified aliases explicitly, and callers who want the
 * short names import the specific module.
 */
export {
  HUMAN_MOUTH_POSES,
  HUMAN_PART_ID_LIST,
  HUMAN_PART_IDS,
  HUMAN_POSES,
  HUMAN_VISEME_OVERRIDES,
  humanArmsUp,
  humanCower,
  humanIdleA,
  humanIdleB,
  humanLeanForward,
  humanNeutral,
  humanPoint,
  humanRunA,
  humanRunB,
  humanSitting,
  humanTrip,
  humanVictory,
  humanWave,
} from "./human.js";

export {
  HOST_MOUTH_POSES,
  HOST_PART_ID_LIST,
  HOST_PART_IDS,
  HOST_POSES,
  HOST_VISEME_OVERRIDES,
  hostIdleA,
  hostIdleB,
  hostLaughing,
  hostLeaning,
  hostNeutral,
  hostPointing,
  hostSarcastic,
  hostSittingAtDesk,
} from "./host.js";