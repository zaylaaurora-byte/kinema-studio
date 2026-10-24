/**
 * BAD EXAMPLE — Pilot 01 production data.
 *
 * "Can You Survive 60 Seconds With a T. rex?" — ~85 seconds.
 *
 * This package is DATA. It contains no renderer, no provider calls and no I/O. The
 * script, the visual plan and the timeline are plain typed values so that the app,
 * the voice provider and the tests all read the same source rather than three
 * drifting copies of it.
 *
 *   script.ts      the authoritative script: 8 contiguous scenes, typed dialogue
 *   scene-plan.ts  per-scene background, cast, expressions, poses and motion
 *   timeline.ts    the projection: 4 tracks of clips derived from the scenes
 *
 * Two invariants are worth knowing before reading anything else:
 *
 *   1. THE HUMAN NEVER SPEAKS. `NonverbalLine` has no `text` field, so a spoken
 *      human line is not representable. See `script.ts`.
 *   2. A PROJECTION STORES NO DURATION. `Timeline` has no duration field and clips
 *      carry scene-relative offsets; total length comes from `computeTotalDuration`.
 *      See `timeline.ts`.
 */

export type {
  HostDirection,
  HostEmotion,
  HostLine,
  NonverbalLine,
  DialogueLine,
  Scene,
} from "./script.js";

export {
  PILOT_FPS,
  CHALLENGE_SECONDS,
  CHALLENGE_START_SECONDS,
  CHALLENGE_WINDOW_START_SECONDS,
  CHALLENGE_END_SECONDS,
  TIMER_READINGS,
  SCENES,
  sceneEndSeconds,
  findContiguityBreak,
  computeTotalDuration,
  challengeSecondsRemaining,
  formatTimer,
  allDialogue,
  hostLines,
  nonverbalLines,
} from "./script.js";

export type {
  HumanExpression,
  HumanPose,
  HumanAction,
  HumanWardrobe,
  HumanBeat,
  HostPose,
  HostBeat,
  CharacterId,
  ScenePlan,
} from "./scene-plan.js";

export {
  SCENE_PLANS,
  usedHumanExpressions,
  usedHostExpressions,
  plannedMotions,
  findPlanMismatches,
} from "./scene-plan.js";

export type {
  TrackKind,
  Track,
  ClipBase,
  VideoClip,
  HostDialogueClip,
  NonverbalClip,
  MusicClip,
  Clip,
  Timeline,
} from "./timeline.js";

export {
  TRACKS,
  buildTimeline,
  clipStartSeconds,
  clipEndSeconds,
  clipsOnTrack,
  clipsForScene,
  findTimelineProblems,
  sceneSpans,
  PILOT_TIMELINE,
} from "./timeline.js";