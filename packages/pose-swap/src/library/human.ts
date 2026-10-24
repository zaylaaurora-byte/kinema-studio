/**
 * The Silent Human pose library.
 *
 * Built from `02_Silent_Human_Primary_Character_Sheet.png`, read directly: 20 expression
 * heads, 18 standing poses, 14 dynamic actions, a turnaround and a "MOUTH (VARIETY)"
 * study. The sheet is annotated "3.5 - 4 HEADS (APPROX)" with a perfectly round head, no
 * hair, no ears, no nose — two dot-oval eyes, thick angled eyebrows, and an elastic mouth.
 * The face IS the performance.
 *
 * ---------------------------------------------------------------------------
 * HOW THE POSE NAMES RELATE TO THE SHEET
 * ---------------------------------------------------------------------------
 * Names are the sheet's own words, lowerCamelCased, so an artist can put the sheet and the
 * code side by side. The sheet's annotations are quoted in each doc comment.
 *
 * Not every one of the 18 standing poses is built here. The library implements the ones
 * the show's five-beat structure actually calls for, plus the two run contacts a cycle
 * needs. Adding the rest is mechanical.
 *
 * ---------------------------------------------------------------------------
 * THE LIMB CONVENTION — THE ONE THING TO UNDERSTAND BEFORE EDITING
 * ---------------------------------------------------------------------------
 * A limb part's origin sits AT ITS JOINT (shoulder, elbow, hip, knee) and its shape hangs
 * down the local -Y axis. Therefore, for a limb:
 *
 *     rotation = 0     hangs straight down — the rest pose
 *     rotation > 0     swings toward +X
 *     rotation < 0     swings toward -X
 *
 * Angles are authored in DEGREES via `deg()`, because 118 is readable in a diff and 2.06
 * is not. They are converted to radians on the way in, since `makeTransform` consumes
 * radians. Authoring in radians by hand is the fastest way to ship a character whose arms
 * are in the wrong place by a factor of 57.
 *
 * "left"/"right" are the VIEWER's left and right, matching the rig builder, which places
 * left-hand parts at positive x and right-hand parts at negative x.
 */

import { deg, type Pose } from "../pose.js";

/**
 * Part ids produced by the human rig builder.
 *
 * Defined ONCE, here, and referenced by every pose in this file. The rig builder imports
 * this same list, so a pose and the rig it is applied to cannot disagree about what a part
 * is called. A typo in a pose part id is otherwise silent — `applyPose` ignores parts the
 * rig lacks — which would ship a pose that quietly does not move the arm it claims to.
 */
export const HUMAN_PART_IDS = {
  hips: "hips",
  torso: "torso",
  neck: "neck",
  head: "head",
  eyeLeft: "eye-left",
  eyeRight: "eye-right",
  browLeft: "brow-left",
  browRight: "brow-right",
  mouth: "mouth",
  upperArmLeft: "upperArm-left",
  lowerArmLeft: "lowerArm-left",
  handLeft: "hand-left",
  upperArmRight: "upperArm-right",
  lowerArmRight: "lowerArm-right",
  handRight: "hand-right",
  upperLegLeft: "upperLeg-left",
  lowerLegLeft: "lowerLeg-left",
  footLeft: "foot-left",
  upperLegRight: "upperLeg-right",
  lowerLegRight: "lowerLeg-right",
  footRight: "foot-right",
} as const;

/** Every human part id, as a flat list. */
export const HUMAN_PART_ID_LIST = Object.values(HUMAN_PART_IDS);

const P = HUMAN_PART_IDS;

/** Rotate a limb by an angle in degrees. Sugar, so the poses below stay readable. */
function limb(degrees: number): { rotation: number } {
  return { rotation: deg(degrees) };
}

/** A pose entry with rotation plus an explicit position, for roots and shifts. */
function moved(
  degrees: number,
  position?: { x?: number; y?: number },
): { rotation: number; x?: number; y?: number } {
  return {
    rotation: deg(degrees),
    ...(position?.x !== undefined ? { x: position.x } : {}),
    ...(position?.y !== undefined ? { y: position.y } : {}),
  };
}

/**
 * Shared resting limb angles.
 *
 * The legs carry a small opposed splay rather than sitting at exactly zero. A tube-limbed
 * figure with perfectly parallel legs reads as a flat stick; a couple of degrees of splay
 * is what makes the silhouette look drawn rather than computed.
 */
const REST_LEGS = {
  [P.upperLegLeft]: limb(1.5),
  [P.lowerLegLeft]: limb(-1.5),
  [P.upperLegRight]: limb(-1.5),
  [P.lowerLegRight]: limb(1.5),
} as const;

/**
 * NEUTRAL — the sheet's NEUTRAL.
 *
 * The pose every shot starts and returns to. Arms hang almost straight but splay a few
 * degrees, which stops the figure reading as a stick; the forearms bend back in slightly
 * so the hands sit beside the hips rather than flaring outward.
 *
 * Explicitly zeroed at the root rather than left empty, so `applyPose(NEUTRAL, rig)` is a
 * true identity and the character always has a clean standing frame to cut to.
 */
export const neutral: Pose = {
  name: "neutral",
  description: "Standing rest. Arms hanging with a slight splay, weight even.",
  channels: {
    [P.hips]: moved(0, { x: 0, y: 36 }),
    [P.torso]: limb(0),
    [P.head]: limb(0),
    [P.upperArmLeft]: limb(7),
    [P.lowerArmLeft]: limb(-4),
    [P.upperArmRight]: limb(-7),
    [P.lowerArmRight]: limb(4),
    ...REST_LEGS,
  },
};

/**
 * WAVE — the sheet's "WAVE".
 *
 * The viewer-left arm goes up. ~118 degrees puts the upper arm just past horizontal and
 * clearly out to the SIDE of the head; pushing much past this swings the arm behind the
 * head, which reads as scratching rather than waving. The forearm cocks back so the hand
 * is open to the viewer.
 */
export const wave: Pose = {
  name: "wave",
  description: "Viewer-left arm raised high and out, other arm relaxed. The sheet's WAVE.",
  channels: {
    [P.hips]: moved(0, { x: 0, y: 36 }),
    [P.torso]: limb(-3),
    [P.head]: limb(4),
    [P.upperArmRight]: limb(-118),
    [P.lowerArmRight]: limb(-24),
    [P.handRight]: limb(0),
    [P.upperArmLeft]: limb(6),
    [P.lowerArmLeft]: limb(-8),
    ...REST_LEGS,
  },
};

/**
 * POINT — the sheet's "POINT".
 *
 * Arm extended straight out to the viewer's right, body leaning into the gesture. The lean
 * is what sells a point as directed rather than as a T-pose.
 */
export const point: Pose = {
  name: "point",
  description: "Viewer-right arm extended level, body and head leaning into the gesture.",
  channels: {
    [P.hips]: moved(-2, { x: 0, y: 36 }),
    [P.torso]: limb(-5),
    [P.head]: limb(-6),
    [P.upperArmLeft]: limb(-88),
    [P.lowerArmLeft]: limb(-4),
    [P.upperArmRight]: limb(10),
    [P.lowerArmRight]: limb(-12),
    [P.upperLegLeft]: limb(6),
    [P.lowerLegLeft]: limb(-5),
    [P.upperLegRight]: limb(-6),
    [P.lowerLegRight]: limb(5),
  },
};

/** ARMS UP — the sheet's "ARMS UP (CELEBRATE)". Both arms overhead, chest open, head back. */
export const armsUp: Pose = {
  name: "armsUp",
  description: "Both arms thrown overhead, head back, feet apart. The sheet's ARMS UP.",
  channels: {
    [P.hips]: moved(0, { x: 0, y: 38 }),
    [P.torso]: limb(0),
    [P.head]: limb(10),
    [P.upperArmLeft]: limb(160),
    [P.lowerArmLeft]: limb(-20),
    [P.upperArmRight]: limb(-160),
    [P.lowerArmRight]: limb(20),
    [P.upperLegLeft]: limb(12),
    [P.lowerLegLeft]: limb(-10),
    [P.upperLegRight]: limb(-12),
    [P.lowerLegRight]: limb(10),
  },
};

/**
 * LEAN FORWARD — the sheet's "LEAN FORWARD".
 *
 * Pitched toward the viewer over a nearly straight leg line, weight shifted onto the front
 * of the feet. Distinct from `trip`: this is a deliberate, balanced lean, not a fall.
 */
export const leanForward: Pose = {
  name: "leanForward",
  description: "Pitched forward over the feet, arms trailing back, head craned ahead.",
  channels: {
    [P.hips]: moved(-18, { x: 5, y: 34 }),
    [P.torso]: limb(-14),
    [P.head]: limb(12),
    [P.upperArmLeft]: limb(34),
    [P.lowerArmLeft]: limb(-16),
    [P.upperArmRight]: limb(-34),
    [P.lowerArmRight]: limb(16),
    [P.upperLegLeft]: limb(10),
    [P.lowerLegLeft]: limb(-8),
    [P.upperLegRight]: limb(-12),
    [P.lowerLegRight]: limb(14),
  },
};

/**
 * COWER — the sheet's "COWER".
 *
 * Dropped low with both arms up shielding the face and the knees folded. The hips come
 * DOWN (y 36 -> 22), which is the part that makes this read as fear rather than as a
 * shrug: the whole figure loses height.
 */
export const cower: Pose = {
  name: "cower",
  description: "Crouched low, both arms up shielding the face, knees folded.",
  channels: {
    [P.hips]: moved(0, { x: 0, y: 22 }),
    [P.torso]: limb(-18),
    [P.head]: limb(16),
    [P.upperArmLeft]: limb(122),
    [P.lowerArmLeft]: limb(-86),
    [P.upperArmRight]: limb(-128),
    [P.lowerArmRight]: limb(88),
    [P.upperLegLeft]: limb(28),
    [P.lowerLegLeft]: limb(-20),
    [P.upperLegRight]: limb(-28),
    [P.lowerLegRight]: limb(20),
  },
};

/**
 * RUN A — the sheet's "RUN", first contact.
 *
 * A genuine multi-limb pose, not neutral with a shifted root: left leg forward and nearly
 * straight at contact, right leg driven back with a folded knee, arms opposed to the legs.
 * The forward lean and raised centre of mass are what make it read as running rather than
 * as walking with bent knees.
 */
export const runA: Pose = {
  name: "runA",
  description: "Run contact: left leg forward, right leg driving back, arms opposed.",
  channels: {
    [P.hips]: moved(-12, { x: 0, y: 39 }),
    [P.torso]: limb(-6),
    [P.head]: limb(8),
    [P.upperLegLeft]: limb(38),
    [P.lowerLegLeft]: limb(-16),
    [P.footLeft]: limb(14),
    [P.upperLegRight]: limb(-34),
    [P.lowerLegRight]: limb(64),
    [P.footRight]: limb(-20),
    [P.upperArmRight]: limb(52),
    [P.lowerArmRight]: limb(-72),
    [P.upperArmLeft]: limb(-46),
    [P.lowerArmLeft]: limb(-78),
  },
};

/**
 * RUN B — the exact mirror of `runA`, and therefore a genuine second drawing.
 *
 * In this style a run is NOT an interpolated gait. It is two (sometimes three) extreme
 * poses swapped on a beat, and the audience's eye supplies the motion. Mirroring limb for
 * limb is what makes `[runA, runB]` a real alternation rather than two similar drawings —
 * the failure mode this whole package is written to prevent.
 */
export const runB: Pose = {
  name: "runB",
  description: "Run, opposite contact: right leg forward, left leg driving back.",
  channels: {
    [P.hips]: moved(-12, { x: 0, y: 39 }),
    [P.torso]: limb(-6),
    [P.head]: limb(8),
    [P.upperLegRight]: limb(38),
    [P.lowerLegRight]: limb(-16),
    [P.footRight]: limb(14),
    [P.upperLegLeft]: limb(-34),
    [P.lowerLegLeft]: limb(64),
    [P.footLeft]: limb(-20),
    [P.upperArmLeft]: limb(52),
    [P.lowerArmLeft]: limb(-72),
    [P.upperArmRight]: limb(-46),
    [P.lowerArmRight]: limb(-78),
  },
};

/**
 * TRIP — the sheet's "TRIP / FALL", the pilot's closing comedic beat.
 *
 * Pitched forward with the feet swept out from under the body and the arms flung up. The
 * pitch is held to ~30 degrees and the root is RAISED rather than dropped, so the sprawled
 * figure stays inside a normal camera frame. Falling further looks correct in isolation and
 * crops the character at the frame edge, which is worse for the pilot than a slightly
 * theatrical trip.
 */
export const trip: Pose = {
  name: "trip",
  description: "Tripping forward: torso pitched over, legs swept back, arms flung up.",
  channels: {
    [P.hips]: moved(-30, { x: 2, y: 40 }),
    [P.torso]: limb(-12),
    [P.head]: limb(24),
    [P.upperArmLeft]: limb(-112),
    [P.lowerArmLeft]: limb(-30),
    [P.upperArmRight]: limb(106),
    [P.lowerArmRight]: limb(-34),
    [P.upperLegLeft]: limb(-46),
    [P.lowerLegLeft]: limb(40),
    [P.footLeft]: limb(-24),
    [P.upperLegRight]: limb(-22),
    [P.lowerLegRight]: limb(70),
    [P.footRight]: limb(-30),
  },
};

/**
 * SITTING — the sheet's "LIE DOWN" / seated reading, adapted to a chair-sized drop.
 *
 * Hips down to a seat height, legs forward and folded, torso upright. Distinct from
 * `cower` by silhouette: the hips are lower but the arms hang, where cower's are up.
 */
export const sitting: Pose = {
  name: "sitting",
  description: "Seated: hips dropped to chair height, thighs forward, shins down, arms resting.",
  channels: {
    [P.hips]: moved(0, { x: 0, y: 24 }),
    [P.torso]: limb(4),
    [P.head]: limb(2),
    [P.upperLegLeft]: limb(84),
    [P.lowerLegLeft]: limb(-82),
    [P.footLeft]: limb(6),
    [P.upperLegRight]: limb(84),
    [P.lowerLegRight]: limb(-82),
    [P.footRight]: limb(6),
    [P.upperArmLeft]: limb(14),
    [P.lowerArmLeft]: limb(-24),
    [P.upperArmRight]: limb(-14),
    [P.lowerArmRight]: limb(24),
  },
};

/**
 * VICTORY — the sheet's "VICTORY".
 *
 * Deliberately DIFFERENT from `armsUp` even though both raise both arms: victory is a wide
 * V with the chin up and the feet planted apart, armsUp is straight overhead with a
 * vertical hop. Two poses that differ only in arm angle by a few degrees would be the
 * near-duplicate failure the tests exist to catch, so the difference is made structural —
 * arm spread AND stance AND head.
 */
export const victory: Pose = {
  name: "victory",
  description: "Wide V arms raised, chin up, feet planted apart. The sheet's VICTORY.",
  channels: {
    [P.hips]: moved(0, { x: 0, y: 37 }),
    [P.torso]: limb(-2),
    [P.head]: limb(6),
    [P.upperArmLeft]: limb(132),
    [P.lowerArmLeft]: limb(-10),
    [P.upperArmRight]: limb(-132),
    [P.lowerArmRight]: limb(10),
    [P.upperLegLeft]: limb(8),
    [P.lowerLegLeft]: limb(-6),
    [P.upperLegRight]: limb(-8),
    [P.lowerLegRight]: limb(6),
  },
};

/**
 * IDLE A — a quiet standing breath, in-breath.
 *
 * One of the two poses of the idle cycle. `neutral` cannot be used for both halves of a
 * cycle, so the pair is authored as a real, if subtle, weight shift: the chest lifts
 * slightly, the head tips a degree, the arms settle a touch closer to the body. Subtle is
 * the point — this plays under dialogue and must not compete with it — but it must be
 * measurably different from `idleB`, and the distance test holds that.
 */
export const idleA: Pose = {
  name: "idleA",
  description: "Idle breath in: chest lifted, weight on the viewer-left leg, arms settled in.",
  channels: {
    [P.hips]: moved(1, { x: -0.5, y: 36.6 }),
    [P.torso]: limb(1.5),
    [P.head]: limb(-1.5),
    [P.upperArmLeft]: limb(5),
    [P.lowerArmLeft]: limb(-3),
    [P.upperArmRight]: limb(-5),
    [P.lowerArmRight]: limb(3),
    [P.upperLegLeft]: limb(2.5),
    [P.lowerLegLeft]: limb(-1),
    [P.upperLegRight]: limb(-0.5),
    [P.lowerLegRight]: limb(1),
  },
};

/** IDLE B — the same breath, out. The other half of the idle cycle. See `idleA`. */
export const idleB: Pose = {
  name: "idleB",
  description: "Idle breath out: chest dropped, weight shifted to the viewer-right leg.",
  channels: {
    [P.hips]: moved(-1, { x: 0.5, y: 35.4 }),
    [P.torso]: limb(-1.5),
    [P.head]: limb(1.5),
    [P.upperArmLeft]: limb(9),
    [P.lowerArmLeft]: limb(-5),
    [P.upperArmRight]: limb(-9),
    [P.lowerArmRight]: limb(5),
    [P.upperLegLeft]: limb(0.5),
    [P.lowerLegLeft]: limb(-2),
    [P.upperLegRight]: limb(-2.5),
    [P.lowerLegRight]: limb(2),
  },
};

/**
 * The human's full pose library.
 *
 * Order is the order an artist wants to see in a picker: the resting pose first, then the
 * body poses roughly by energy, then the cycle pairs last.
 */
export const HUMAN_POSES: readonly Pose[] = [
  neutral,
  wave,
  point,
  armsUp,
  leanForward,
  cower,
  runA,
  runB,
  trip,
  sitting,
  victory,
  idleA,
  idleB,
];

/**
 * The human's mouth library.
 *
 * These are FACE poses, in the same `Pose` shape as body poses, so a mouth flap and a body
 * swap are the same kind of object and can be driven by the same machinery. The mouth part
 * is scaled rather than redrawn: `openWide` stretches the lens shape tall, `teeth` squashes
 * it flat, `smile` widens it. That is exactly the "elastic mouth" the sheet's MOUTH
 * (VARIETY) study shows, and it is achievable with scale alone on a drawn part.
 */
export const HUMAN_MOUTH_POSES: readonly Pose[] = [
  {
    name: "closed",
    description: "Mouth closed — the resting shape and the between-syllables shape.",
    channels: { [P.mouth]: { scaleX: 1, scaleY: 0.18 } },
  },
  {
    name: "openSmall",
    description: "A small open shape for short vowels.",
    channels: { [P.mouth]: { scaleX: 0.95, scaleY: 0.7 } },
  },
  {
    name: "openWide",
    description: "The wide open 'ah' — long vowels and shouting.",
    channels: { [P.mouth]: { scaleX: 1.35, scaleY: 1.6 } },
  },
  {
    name: "oShape",
    description: "Rounded lips for rounded vowels.",
    channels: { [P.mouth]: { scaleX: 0.6, scaleY: 0.95 } },
  },
  {
    name: "teeth",
    description: "Flattened grimace for fricatives and effort.",
    channels: { [P.mouth]: { scaleX: 1.5, scaleY: 0.3 } },
  },
  {
    name: "smile",
    description: "Wide lifted grin, held for laughter.",
    channels: { [P.mouth]: { scaleX: 1.6, scaleY: 0.55 } },
  },
];

/**
 * Per-character viseme overrides for the human.
 *
 * His mouth is an elastic lens on a blank white face, so the default table already suits
 * him — he has no fangs to hide and no lip line to respect. He is kept as an explicit empty
 * override rather than being special-cased in code, so both characters take the same path
 * and a future tweak has an obvious home.
 */
export const HUMAN_VISEME_OVERRIDES = {} as const;

/*
 * Prefixed aliases.
 *
 * Both characters have a pose called `neutral`, `idleA`, `closed` and so on, so a barrel
 * that exports both modules would otherwise have colliding names — and the collision would
 * resolve to whichever module was exported last, silently. These aliases give every pose a
 * character-qualified name that is unambiguous at the call site.
 */
export {
  neutral as humanNeutral,
  wave as humanWave,
  point as humanPoint,
  armsUp as humanArmsUp,
  leanForward as humanLeanForward,
  cower as humanCower,
  runA as humanRunA,
  runB as humanRunB,
  trip as humanTrip,
  sitting as humanSitting,
  victory as humanVictory,
  idleA as humanIdleA,
  idleB as humanIdleB,
};