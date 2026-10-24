/**
 * The Demon Host pose library.
 *
 * Built from `01_Demon_Host_Primary_Character_Sheet.png`, read directly: 12 expression
 * heads (DEFAULT, HAPPY, LAUGHING, SARCASTIC, CURIOUS, SURPRISED, EXCITED, ANNOYED, BORED,
 * SLEEPY, THINKING, MANIACAL) and pose studies (casual sitting, lounging, on stage, holding
 * mug, lying down, pointing, leaning, sitting on desk), plus close-up angles and a
 * turnaround.
 *
 * ---------------------------------------------------------------------------
 * WHY HER POSES ARE BUILT DIFFERENTLY FROM HIS
 * ---------------------------------------------------------------------------
 * The two characters have opposite resting energy, and the pose data has to carry that or
 * they will read as the same character in different skins:
 *
 *  - The human is COMEDIC / OVERREACTIVE. He is upright, symmetric, limbs at extremes.
 *  - The host is LAZY / RELAXED. The sheet draws her almost always ASYMMETRIC and
 *    off-vertical — weight on one hip, head tipped, one arm occupied (chin, mug, chair
 *    back), tail curling. Her extremes are small and her resting poses are already leaning.
 *
 * So her poses carry deliberate asymmetry: `hips.x` is rarely 0, `torso` rotation is rarely
 * 0, and `head` almost never sits square. Her highest-energy pose (`laughing`) is still
 * less extreme than his `armsUp`. That contrast is the characterisation, and it is encoded
 * rather than described.
 *
 * She also has parts he does not: `horns`, `tail`, `ear-left`, `ear-right`. Her poses move
 * them, which is what makes her silhouette hers.
 */

import { deg, type Pose } from "../pose.js";

/**
 * Part ids produced by the host rig builder.
 *
 * The full rig is not built here — the poses are authored against the same joint-origin
 * convention as the human's so they will drop onto a rig built to this contract. Parts are
 * defined once so poses and the rig agree.
 */
export const HOST_PART_IDS = {
  hips: "hips",
  torso: "torso",
  neck: "neck",
  head: "head",
  hair: "hair",
  hornLeft: "horn-left",
  hornRight: "horn-right",
  earLeft: "ear-left",
  earRight: "ear-right",
  eyeLeft: "eye-left",
  eyeRight: "eye-right",
  browLeft: "brow-left",
  browRight: "brow-right",
  mouth: "mouth",
  tail: "tail",
  tailTip: "tail-tip",
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

/** Every host part id, as a flat list. */
export const HOST_PART_ID_LIST = Object.values(HOST_PART_IDS);

const P = HOST_PART_IDS;

function limb(degrees: number): { rotation: number } {
  return { rotation: deg(degrees) };
}

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
 * Her tail, curling. Shared by most poses and varied where it matters.
 *
 * The tail is the cheapest characterisation she has: it is a part only she owns, and a tail
 * that curls differently between two poses makes them read as different drawings even when
 * the body barely changes.
 */
function tail(curlDegrees: number): { rotation: number } {
  return { rotation: deg(curlDegrees) };
}

/**
 * NEUTRAL — the sheet's DEFAULT.
 *
 * Already asymmetric at rest: weight on the viewer-right hip, head tipped a few degrees,
 * one arm closer to the body than the other, tail hanging with a lazy curl. This is the
 * pose the sheet draws her in far more often than a square stance, and it is the single
 * clearest expression of "lazy / relaxed".
 */
export const neutral: Pose = {
  name: "neutral",
  description: "Resting, already off-square: weight on one hip, head tipped, tail curling.",
  channels: {
    [P.hips]: moved(2, { x: 1.5, y: 34 }),
    [P.torso]: limb(-4),
    [P.head]: limb(3),
    [P.hair]: limb(-2),
    [P.tail]: tail(24),
    [P.tailTip]: tail(-18),
    [P.upperArmLeft]: limb(10),
    [P.lowerArmLeft]: limb(-22),
    [P.upperArmRight]: limb(-6),
    [P.lowerArmRight]: limb(14),
    [P.upperLegLeft]: limb(3),
    [P.lowerLegLeft]: limb(-3),
    [P.upperLegRight]: limb(-5),
    [P.lowerLegRight]: limb(4),
  },
};

/**
 * SARCASTIC — the sheet's SARCASTIC, and her signature pose.
 *
 * Chin propped on her hand with the elbow up, head tilted into it, weight fully committed
 * to one hip, tail flicking. The half-lidded unimpressed read is what the brief asks for in
 * the pilot, so this pose is built to be held for seconds at a time rather than passed
 * through: it is stable, balanced, and reads at a glance.
 */
export const sarcastic: Pose = {
  name: "sarcastic",
  description: "Chin propped on the hand, elbow up, head lolling, weight on one hip.",
  channels: {
    [P.hips]: moved(4, { x: 3, y: 33.5 }),
    [P.torso]: limb(-8),
    [P.head]: limb(12),
    [P.hair]: limb(-4),
    [P.tail]: tail(52),
    [P.tailTip]: tail(-30),
    // The propping arm: upper arm out and up, forearm folded back so the hand meets the chin.
    [P.upperArmLeft]: limb(46),
    [P.lowerArmLeft]: limb(-134),
    [P.handLeft]: limb(-10),
    // The other arm hangs slack, which is what makes the pose read as lazy rather than posed.
    [P.upperArmRight]: limb(-4),
    [P.lowerArmRight]: limb(10),
    [P.upperLegLeft]: limb(4),
    [P.lowerLegLeft]: limb(-4),
    [P.upperLegRight]: limb(-7),
    [P.lowerLegRight]: limb(5),
  },
};

/**
 * POINTING — the sheet's "POINTING" (action / dynamic poses).
 *
 * Her one genuinely energetic pose: arm flung out and up, body turned into the gesture,
 * tail whipped up behind her, hair thrown. Even here the legs stay lazy — she points from
 * the hip rather than stepping into it, which keeps it in character.
 */
export const pointing: Pose = {
  name: "pointing",
  description: "Arm flung out high, torso turned into the gesture, tail whipped up.",
  channels: {
    [P.hips]: moved(-6, { x: -2, y: 34.5 }),
    [P.torso]: limb(-10),
    [P.head]: limb(-8),
    [P.hair]: limb(6),
    [P.tail]: tail(-38),
    [P.tailTip]: tail(-24),
    [P.upperArmLeft]: limb(-128),
    [P.lowerArmLeft]: limb(-18),
    [P.handLeft]: limb(6),
    [P.upperArmRight]: limb(16),
    [P.lowerArmRight]: limb(-30),
    [P.upperLegLeft]: limb(8),
    [P.lowerLegLeft]: limb(-6),
    [P.upperLegRight]: limb(-4),
    [P.lowerLegRight]: limb(6),
  },
};

/**
 * LEANING — the sheet's "LEANING".
 *
 * Leaning back with her weight on one leg and the tail counterbalancing forward. The hips
 * shift BACK while the chest stays open, which is the confident slouch the sheet draws; a
 * lean built by rotating the torso alone reads as a stoop instead.
 */
export const leaning: Pose = {
  name: "leaning",
  description: "Leaning back, hips pushed out, chest open, tail balancing forward.",
  channels: {
    [P.hips]: moved(10, { x: -4, y: 33 }),
    [P.torso]: limb(8),
    [P.head]: limb(-4),
    [P.hair]: limb(3),
    [P.tail]: tail(-52),
    [P.tailTip]: tail(20),
    [P.upperArmLeft]: limb(14),
    [P.lowerArmLeft]: limb(-26),
    [P.upperArmRight]: limb(-12),
    [P.lowerArmRight]: limb(20),
    [P.upperLegLeft]: limb(-6),
    [P.lowerLegLeft]: limb(6),
    [P.upperLegRight]: limb(4),
    [P.lowerLegRight]: limb(-4),
  },
};

/**
 * SITTING AT DESK — the sheet's "SITTING ON DESK".
 *
 * Perched on the desk edge with the legs hanging and the torso turned. Hips drop to desk
 * height, thighs forward and level, shins down and slightly back. The arms brace behind her
 * on the desk, which is what makes "sitting on something" read rather than "hovering".
 */
export const sittingAtDesk: Pose = {
  name: "sittingAtDesk",
  description: "Perched on the desk edge: thighs level, shins hanging, arms braced behind.",
  channels: {
    [P.hips]: moved(2, { x: 2, y: 26 }),
    [P.torso]: limb(-3),
    [P.head]: limb(4),
    [P.hair]: limb(-2),
    [P.tail]: tail(68),
    [P.tailTip]: tail(-40),
    [P.upperLegLeft]: limb(86),
    [P.lowerLegLeft]: limb(-84),
    [P.footLeft]: limb(10),
    [P.upperLegRight]: limb(82),
    [P.lowerLegRight]: limb(-88),
    [P.footRight]: limb(8),
    // Braced back on the desk.
    [P.upperArmLeft]: limb(-38),
    [P.lowerArmLeft]: limb(-40),
    [P.upperArmRight]: limb(34),
    [P.lowerArmRight]: limb(38),
  },
};

/**
 * LAUGHING — the sheet's LAUGHING expression, extended to the body.
 *
 * Head thrown back, chest open, one hand up, tail lashing. This is her most extreme pose
 * and it is still narrower in limb angle than the human's `armsUp` — she finds chaos
 * hilarious from a seated position rather than leaping about, and the numbers say so.
 */
export const laughing: Pose = {
  name: "laughing",
  description: "Head thrown back, chest open, hand raised, tail lashing.",
  channels: {
    [P.hips]: moved(-8, { x: 0, y: 33.5 }),
    [P.torso]: limb(12),
    [P.head]: limb(-26),
    [P.hair]: limb(-8),
    [P.tail]: tail(-72),
    [P.tailTip]: tail(34),
    [P.upperArmLeft]: limb(72),
    [P.lowerArmLeft]: limb(-96),
    [P.handLeft]: limb(-12),
    [P.upperArmRight]: limb(-20),
    [P.lowerArmRight]: limb(26),
    [P.upperLegLeft]: limb(-4),
    [P.lowerLegLeft]: limb(4),
    [P.upperLegRight]: limb(6),
    [P.lowerLegRight]: limb(-6),
  },
};

/**
 * IDLE A — lounging breath in.
 *
 * The host's idle pair is built on the ASYMMETRIC resting stance rather than a square one,
 * so her idle still reads as her. Chest lifts, the tail drifts, the head settles a degree.
 * Under dialogue this must be nearly invisible; between dialogue it is what stops her being
 * a frozen PNG — the same requirement the human's idle pair meets, in her own posture.
 */
export const idleA: Pose = {
  name: "idleA",
  description: "Lounging idle, breath in: chest lifted, tail drifting, head settled.",
  channels: {
    [P.hips]: moved(1.5, { x: 1.2, y: 34.4 }),
    [P.torso]: limb(-2.5),
    [P.head]: limb(1.5),
    [P.hair]: limb(-1),
    [P.tail]: tail(20),
    [P.tailTip]: tail(-14),
    [P.upperArmLeft]: limb(9),
    [P.lowerArmLeft]: limb(-20),
    [P.upperArmRight]: limb(-5),
    [P.lowerArmRight]: limb(12),
    [P.upperLegLeft]: limb(2.5),
    [P.lowerLegLeft]: limb(-2.5),
    [P.upperLegRight]: limb(-4),
    [P.lowerLegRight]: limb(3),
  },
};

/** IDLE B — lounging breath out. The other half of the host's idle cycle. */
export const idleB: Pose = {
  name: "idleB",
  description: "Lounging idle, breath out: chest dropped, weight sunk, tail swung out.",
  channels: {
    [P.hips]: moved(2.5, { x: 1.8, y: 33.6 }),
    [P.torso]: limb(-5.5),
    [P.head]: limb(4.5),
    [P.hair]: limb(-3),
    [P.tail]: tail(30),
    [P.tailTip]: tail(-22),
    [P.upperArmLeft]: limb(12),
    [P.lowerArmLeft]: limb(-24),
    [P.upperArmRight]: limb(-8),
    [P.lowerArmRight]: limb(16),
    [P.upperLegLeft]: limb(3.5),
    [P.lowerLegLeft]: limb(-3.5),
    [P.upperLegRight]: limb(-6),
    [P.lowerLegRight]: limb(5),
  },
};

/** The host's full body pose library, in picker order: resting first, extremes after. */
export const HOST_POSES: readonly Pose[] = [
  neutral,
  sarcastic,
  pointing,
  leaning,
  sittingAtDesk,
  laughing,
  idleA,
  idleB,
];

/**
 * The host's mouth library.
 *
 * HER MOUTH IS NOT HIS. The sheet's MOUTH / FANG detail shows a fanged anime mouth with a
 * visible upper fang and a large pink tongue, so:
 *
 *  - `smile` is WIDER and lower on the face than the human's — her smirk is a lateral
 *    stretch that uncovers the fang, not a symmetric grin;
 *  - `teeth` is TALLER than the human's flat grimace, because her fricatives show fang and
 *    tongue rather than a closed tooth line;
 *  - `openWide` is slightly narrower and taller, because a fanged mouth has more jaw drop
 *    before it reads as a shout.
 *
 * Same six names, different numbers. That is exactly the "mapping must be authored per
 * character" requirement, applied to the drawn shapes themselves.
 */
export const HOST_MOUTH_POSES: readonly Pose[] = [
  {
    name: "closed",
    description: "Mouth closed — resting and between syllables. Fang just covered.",
    channels: { [P.mouth]: { scaleX: 1, scaleY: 0.2 } },
  },
  {
    name: "openSmall",
    description: "A small open shape; the fang begins to show.",
    channels: { [P.mouth]: { scaleX: 0.9, scaleY: 0.62 } },
  },
  {
    name: "openWide",
    description: "Wide open with tongue and fang visible.",
    channels: { [P.mouth]: { scaleX: 1.25, scaleY: 1.72 } },
  },
  {
    name: "oShape",
    description: "Rounded lips for rounded vowels.",
    channels: { [P.mouth]: { scaleX: 0.56, scaleY: 0.88 } },
  },
  {
    name: "teeth",
    description: "Fang and tongue bared for fricatives and effort — taller than the human's.",
    channels: { [P.mouth]: { scaleX: 1.4, scaleY: 0.52 } },
  },
  {
    name: "smile",
    description: "Lateral smirk that uncovers the fang. Held for laughter.",
    channels: { [P.mouth]: { scaleX: 1.72, scaleY: 0.68 } },
  },
];

/**
 * Per-character viseme overrides for the host.
 *
 * This is the mapping table being a PARAMETER rather than a global constant, which the ADR
 * requires. Two rows genuinely differ from the default, and both are motivated by the
 * drawing rather than by taste:
 *
 *  - **`silence` -> `smile`.** Her sheet's resting expression is a faint smirk, not a flat
 *    closed mouth. Between her lines she holds that smirk; it is most of her personality,
 *    and it is exactly the kind of thing that is invisible in the audio data and obvious on
 *    screen.
 *  - **`SS` -> `openSmall`.** A drawn hiss through a FANGED mouth does not close flat. The
 *    human's `teeth` shape is a squashed line that suits a toothless elastic mouth; on her
 *    it would hide the fang that the sheet is emphatic about showing.
 */
export const HOST_VISEME_OVERRIDES = {
  silence: "smile",
  SS: "openSmall",
} as const;

/*
 * Prefixed aliases — see the equivalent block in `human.ts` for why these exist. Both
 * characters define `neutral`, `idleA` and friends, so the barrel needs qualified names.
 */
export {
  neutral as hostNeutral,
  sarcastic as hostSarcastic,
  pointing as hostPointing,
  leaning as hostLeaning,
  sittingAtDesk as hostSittingAtDesk,
  laughing as hostLaughing,
  idleA as hostIdleA,
  idleB as hostIdleB,
};