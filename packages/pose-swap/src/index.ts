/**
 * @kinema/pose-swap — limited 2D (pose-swap / cut-out) animation.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS PACKAGE IS FOR
 * ---------------------------------------------------------------------------
 * ADR 0003 corrected the production technique: "Bad Example" is **limited 2D animation** —
 * the narrated YouTube compilation style — where a character HOLDS a drawn pose and then
 * SWAPS to another. Talking is **mouth flaps** on a beat. Nothing is smoothly interpolated,
 * because smoothly tweening a character drawn for pose swaps reads as uncanny sliding.
 *
 * `@kinema/scene-model` remains the renderer-facing truth: a frame is still a pure function
 * of time, and `evaluate()` is unchanged. This package is the AUTHORING layer above it —
 * poses, pose tracks, mouth tracks and cycles — which converts its discrete decisions into
 * ordinary single-keyframe (and `step`-eased) channels that the existing evaluator already
 * understands. The renderer cannot tell a held pose from a hand-written keyframe, which is
 * exactly the ADR's requirement that "the renderer is unchanged".
 *
 * ---------------------------------------------------------------------------
 * READING ORDER
 * ---------------------------------------------------------------------------
 *   `pose.ts`        what a pose is, and the bridge to `evaluate()`
 *   `pose-track.ts`  THE primitive: discrete switches with implicit holds
 *   `mouth.ts`       the six mouth shapes, the viseme table, and cadence quantisation
 *   `cycles.ts`      A/B alternation at a fixed beat
 *   `library/`       the two characters' actual pose sets, from the reference sheets
 *
 * ---------------------------------------------------------------------------
 * DETERMINISM
 * ---------------------------------------------------------------------------
 * Every function here is pure and there is no randomness, no clock and no I/O anywhere in
 * the package. Sampling is a lookup over an ordered list, so it has no floating-point
 * accumulation — the ADR notes this makes determinism better than interpolation, not worse.
 */

export {
  applyPose,
  blendPoses,
  CHANNEL_PROPERTIES,
  constChannel,
  createPoseLibrary,
  deg,
  poseChannels,
  poseDistance,
  ROTATION_WEIGHT,
  SCALE_WEIGHT,
  type ChannelProperty,
  type ChannelValues,
  type Pose,
  type PoseLibrary,
} from "./pose.js";

export {
  applyPoseTrack,
  countPoseSwitches,
  holds,
  poseTrack,
  posesInTrack,
  samplePose,
  samplePoseEntry,
  switchTimes,
  totalDuration,
  type ActivePose,
  type Hold,
  type PoseEntry,
  type PoseTrack,
} from "./pose-track.js";

export {
  DEFAULT_VISEME_MAP,
  heldMouth,
  IDLE_MOUTH,
  IDLE_MOUTH_SMILING,
  MOUTH_SHAPES,
  mouthFromVisemes,
  mouthTrack,
  resolveVisemeMap,
  sampleMouth,
  type MouthFromVisemesOptions,
  type MouthShape,
  type MouthTrack,
  type VisemeEvent,
  type VisemeGroup,
  type VisemeMap,
} from "./mouth.js";

export {
  cycleLibrary,
  expandCycle,
  idleCycle,
  runCycle,
  runCycleThree,
  speakCycle,
  type ExpandCycleOptions,
  type PoseCycle,
} from "./cycles.js";

export {
  CHARACTERS,
  host,
  hostLibrary,
  hostVisemeMap,
  human,
  humanLibrary,
  humanVisemeMap,
  type CharacterPoses,
} from "./library/index.js";

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
} from "./library/host.js";

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
} from "./library/human.js";