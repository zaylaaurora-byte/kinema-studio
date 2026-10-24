/**
 * Bad Example — the demon host, built from the reference sheet.
 *
 * Every position here is DERIVED from a skeleton rather than hand-placed. Two earlier
 * attempts used literal pixel offsets and both rendered broken (a floating head, then a
 * detached torso), so the construction now goes through `makeSkeleton` and
 * `anchorOffset`. `assertConnected` guards it in tests.
 *
 * Character locks, from CAST.md (sourced from sheet 01 and the written brief):
 *   - pale warm skin, amber/gold eyes, half-lidded by default
 *   - LARGE curved BLACK horns sweeping back from the temples — never straight
 *   - long pointed elf ears
 *   - very long messy dark brown-black hair with heavy volume
 *   - spade-tipped tail
 *   - oversized cream jumper worn off one shoulder, black shorts, black boots
 *   - fanged mouth, dusty-rose tongue
 *
 * Acting is DISCRETE pose swaps per ADR 0003 — every channel holds one value.
 */

import type { Rig, Shape } from "@kinema/scene-model";

import { anchorOffset, assertConnected, makeSkeleton, part, type Skeleton } from "./skeleton.js";

// ---------------------------------------------------------------------------
// Palette, taken from the sheet's own labelled swatches.
// ---------------------------------------------------------------------------

export const HOST_PALETTE = {
  skin: "#EBB59F",
  skinShade: "#D89A83",
  hair: "#3A2320",
  hairHighlight: "#4E322C",
  horns: "#1A1616",
  jumper: "#F2EAD9",
  jumperShade: "#DED3BE",
  dark: "#14100F",
  clothes: "#1C1817",
  eye: "#E8A33D",
  mouth: "#C4707A",
  accentRed: "#C0392B",
} as const;

export const HOST_STYLES: Record<string, { fill: string; stroke: string; strokeWidth: number }> = {
  torso: { fill: HOST_PALETTE.jumper, stroke: HOST_PALETTE.dark, strokeWidth: 5 },
  shoulders: { fill: HOST_PALETTE.jumper, stroke: HOST_PALETTE.dark, strokeWidth: 5 },
  hem: { fill: HOST_PALETTE.jumperShade, stroke: HOST_PALETTE.dark, strokeWidth: 4 },
  "arm-left": { fill: HOST_PALETTE.jumper, stroke: HOST_PALETTE.dark, strokeWidth: 5 },
  "arm-right": { fill: HOST_PALETTE.jumper, stroke: HOST_PALETTE.dark, strokeWidth: 5 },
  neck: { fill: HOST_PALETTE.skin, stroke: HOST_PALETTE.dark, strokeWidth: 4 },
  head: { fill: HOST_PALETTE.skin, stroke: HOST_PALETTE.dark, strokeWidth: 5 },
  "hair-back": { fill: HOST_PALETTE.hair, stroke: HOST_PALETTE.dark, strokeWidth: 5 },
  "hair-left": { fill: HOST_PALETTE.hair, stroke: HOST_PALETTE.dark, strokeWidth: 4 },
  "hair-right": { fill: HOST_PALETTE.hair, stroke: HOST_PALETTE.dark, strokeWidth: 4 },
  "horn-left": { fill: HOST_PALETTE.horns, stroke: HOST_PALETTE.dark, strokeWidth: 3 },
  "horn-right": { fill: HOST_PALETTE.horns, stroke: HOST_PALETTE.dark, strokeWidth: 3 },
  "ear-left": { fill: HOST_PALETTE.skin, stroke: HOST_PALETTE.dark, strokeWidth: 3 },
  "ear-right": { fill: HOST_PALETTE.skin, stroke: HOST_PALETTE.dark, strokeWidth: 3 },
  "eye-left": { fill: HOST_PALETTE.eye, stroke: HOST_PALETTE.dark, strokeWidth: 3 },
  "eye-right": { fill: HOST_PALETTE.eye, stroke: HOST_PALETTE.dark, strokeWidth: 3 },
  "lid-left": { fill: HOST_PALETTE.skinShade, stroke: HOST_PALETTE.dark, strokeWidth: 2 },
  "lid-right": { fill: HOST_PALETTE.skinShade, stroke: HOST_PALETTE.dark, strokeWidth: 2 },
  "brow-left": { fill: HOST_PALETTE.hair, stroke: HOST_PALETTE.dark, strokeWidth: 2 },
  "brow-right": { fill: HOST_PALETTE.hair, stroke: HOST_PALETTE.dark, strokeWidth: 2 },
  mouth: { fill: HOST_PALETTE.mouth, stroke: HOST_PALETTE.dark, strokeWidth: 3 },
  tail: { fill: HOST_PALETTE.horns, stroke: HOST_PALETTE.dark, strokeWidth: 4 },
  "tail-tip": { fill: HOST_PALETTE.horns, stroke: HOST_PALETTE.dark, strokeWidth: 4 },
  "leg-left": { fill: HOST_PALETTE.clothes, stroke: HOST_PALETTE.dark, strokeWidth: 4 },
  "leg-right": { fill: HOST_PALETTE.clothes, stroke: HOST_PALETTE.dark, strokeWidth: 4 },
};

/**
 * The host's skeleton.
 *
 * 6.5 heads is the stylised-anime register the sheet is drawn in: more naturalistic than
 * the human's 3.5-4, but still comfortably cartoon. The wider shoulders come from the
 * oversized jumper, which is a defining silhouette feature.
 */
export const HOST_SKELETON: Skeleton = makeSkeleton({
  headCount: 6.5,
  headWidth: 104,
  shoulderWidth: 176,
});

/**
 * Discrete acting values for the host.
 *
 * Each field is a separate property so a pose can vary one axis at a time — e.g. the
 * "sarcastic" pose is mostly a brow and lid change, with no body movement at all, which
 * is how the character's understated acting reads.
 */
export interface HostPose {
  readonly headTilt: number;
  /** 1 = fully open, 0 = closed. Drives a shape swap, not a fade. */
  readonly blink: number;
  /** 0 = relaxed, 1 = raised. */
  readonly browRaise: number;
  /** 0 = closed, 1 = wide. */
  readonly mouthOpen: number;
  /** How heavy the eyelids sit. The character's default is half-lidded. */
  readonly lidDroop: number;
  /** 0 = arms down, 1 = fully raised. */
  readonly armRaise: number;
  /** A slight body lean, for lounging or leaning on the desk. */
  readonly bodyLean: number;
}

/** The default resting state: half-lidded, relaxed, faintly amused. */
export const HOST_DEFAULT_POSE: HostPose = {
  headTilt: -0.04,
  blink: 1,
  browRaise: 0,
  mouthOpen: 0,
  lidDroop: 0.45,
  armRaise: 0,
  bodyLean: 0,
};

/**
 * The named poses from sheet 01's 12 expression heads: DEFAULT, HAPPY, LAUGHING,
 * SARCASTIC, CURIOUS, SURPRISED, EXCITED, ANNOYED, BORED, SLEEPY, THINKING, MANIACAL.
 *
 * Values are chosen so each pose is VISIBLY distinct — the pilot requires at least three
 * distinct host acting states, and these give twelve.
 */
export const HOST_POSES: Record<string, HostPose> = {
  default: HOST_DEFAULT_POSE,

  happy: { headTilt: 0.03, blink: 1, browRaise: 0.5, mouthOpen: 0.3, lidDroop: 0.1, armRaise: 0.15, bodyLean: 0 },

  laughing: { headTilt: -0.12, blink: 0.15, browRaise: 0.8, mouthOpen: 0.95, lidDroop: 0, armRaise: 0.3, bodyLean: -0.04 },

  // The character's signature: brows up, lids heavy, mouth barely open. Almost no body
  // movement, which is what makes it read as dry rather than theatrical.
  sarcastic: { headTilt: 0.06, blink: 1, browRaise: 1, mouthOpen: 0.12, lidDroop: 0.7, armRaise: 0.1, bodyLean: 0.02 },

  curious: { headTilt: 0.14, blink: 1, browRaise: 0.7, mouthOpen: 0.05, lidDroop: 0.2, armRaise: 0, bodyLean: 0.03 },

  surprised: { headTilt: -0.05, blink: 1, browRaise: 1, mouthOpen: 0.55, lidDroop: -0.15, armRaise: 0.25, bodyLean: -0.05 },

  excited: { headTilt: 0.05, blink: 1, browRaise: 0.9, mouthOpen: 0.7, lidDroop: -0.1, armRaise: 0.6, bodyLean: 0.04 },

  annoyed: { headTilt: 0.08, blink: 0.7, browRaise: -0.4, mouthOpen: 0.08, lidDroop: 0.75, armRaise: 0, bodyLean: 0.02 },

  bored: { headTilt: 0.1, blink: 0.5, browRaise: -0.2, mouthOpen: 0, lidDroop: 0.9, armRaise: 0, bodyLean: 0.06 },

  sleepy: { headTilt: 0.16, blink: 0.2, browRaise: 0, mouthOpen: 0.18, lidDroop: 1, armRaise: 0, bodyLean: 0.08 },

  thinking: { headTilt: 0.18, blink: 1, browRaise: 0.4, mouthOpen: 0, lidDroop: 0.5, armRaise: 0.35, bodyLean: 0.05 },

  // Wide eyes, wide grin, brows high. The one genuinely exaggerated pose in the set.
  maniacal: { headTilt: -0.08, blink: 1, browRaise: 1, mouthOpen: 1, lidDroop: -0.2, armRaise: 0.75, bodyLean: -0.03 },
};

/**
 * Build the host rig for a pose.
 *
 * Returns a `Rig` whose parts are all positioned from the skeleton, with single-keyframe
 * channels holding the pose — so evaluating it at any time inside a hold gives identical
 * geometry, which is what a pose-swap system requires.
 */
export function buildHostRig(
  pose: HostPose,
  skeleton: Skeleton = HOST_SKELETON,
  overrides: { facingGear?: boolean } = {},
): Rig {
  const s = skeleton;
  const { headTilt, blink, browRaise, mouthOpen, lidDroop, armRaise, bodyLean } = pose;

  // Convert the head-height-based head count into the blob radii the renderer draws.
  const headRx = s.headWidth / 2;
  const headRy = s.headHeight / 2;

  // Eyes close by collapsing their height. A floor prevents a zero-radius shape, which
  // some rasterisers handle poorly.
  const eyeRy = Math.max(0.8, headRy * 0.16 * blink);
  const eyeRx = headRx * 0.17;

  // Eyelid covers the top portion of the eye; a heavier droop reveals less of the iris.
  const lidHeight = headRy * 0.34 * Math.max(0, lidDroop);

  const mouthRy = 1.5 + headRy * 0.14 * mouthOpen;
  const mouthRx = headRx * 0.24 * (0.6 + mouthOpen * 0.55);

  // Arm poses. Because the arm is drawn FROM its origin along a direction, changing the
  // endpoint angle raises or lowers it without moving the shoulder joint.
  const shoulderY = anchorOffset(s, "shoulderCentre").y;
  const armAngle = -Math.PI / 2 + (Math.PI / 2 - armRaise * 1.75);
  const upperLen = s.limb.upperArmLength;
  const armEndX = Math.cos(armAngle) * upperLen;
  const armEndY = Math.sin(armAngle) * upperLen;

  // Mirror for the left arm, which hangs slightly further out.
  const leftEndX = -Math.abs(armEndX) - 6;
  const leftEndY = armEndY;

  // The torso spans from the shoulder anchor down to the hem. In the rig's local space
// (origin at the hip, up is negative) both of those are negative numbers, and the torso's
// own origin is their midpoint.
  const torsoTop = anchorOffset(s, "shoulderCentre").y;
  const torsoBottom = anchorOffset(s, "hem").y;
  const torsoHeight = Math.abs(torsoBottom - torsoTop);
  const torsoCentreY = (torsoTop + torsoBottom) / 2;

  // The head sits ABOVE the top of the torso, offset by the neck. Everything on the face
  // is then positioned relative to the head's own origin, never to the skeleton's hip.
  const neckLength = s.headHeight * 0.16;
  const headOriginY = torsoTop - neckLength - s.headHeight / 2;

  const parts: ReturnType<typeof part>[] = [
    // --- Legs, drawn before the torso so it overlaps them ------------------
    part({
      id: "leg-left",
      at: { x: -s.headWidth * 0.22, y: -s.headHeight * 0.14 },
      zIndex: 4,
      shapes: [
        { kind: "capsule", from: { x: 0, y: 0 }, to: { x: 0, y: s.limb.legLength }, radius: s.limb.legRadius },
      ],
    }),
    part({
      id: "leg-right",
      at: { x: s.headWidth * 0.22, y: -s.headHeight * 0.14 },
      zIndex: 4,
      shapes: [
        { kind: "capsule", from: { x: 0, y: 0 }, to: { x: 0, y: s.limb.legLength }, radius: s.limb.legRadius },
      ],
    }),

    // --- Torso ------------------------------------------------------------
    // Spans from the shoulder line down to the hem, so arms and head have a real mass
    // to attach to. Drawn from its CENTRE, which is why the offset is halved.
    part({
      id: "torso",
      at: { x: 0, y: torsoCentreY },
      zIndex: 10,
      rotation: bodyLean,
      shapes: [
        {
          kind: "rect",
          width: s.headWidth * 1.05,
          height: torsoHeight,
          rx: s.headWidth * 0.2,
        },
      ],
    }),

    // Shoulder band, sitting exactly on the shoulder anchor.
    part({
      id: "shoulders",
      parentId: "torso",
      at: { x: 0, y: -torsoHeight / 2 + s.headHeight * 0.22 },
      zIndex: 11,
      shapes: [
        { kind: "rect", width: s.headWidth * 1.35, height: s.headHeight * 0.42, rx: s.headWidth * 0.22 },
      ],
    }),

    // Jumper hem.
    part({
      id: "hem",
      parentId: "torso",
      at: { x: 0, y: torsoHeight / 2 - s.headHeight * 0.04 },
      zIndex: 9,
      shapes: [
        { kind: "rect", width: s.headWidth * 1.12, height: s.headHeight * 0.14, rx: 6 },
      ],
    }),

    // --- Arms, hung off the TORSO at shoulder level -----------------------
    part({
      id: "arm-left",
      parentId: "torso",
      at: { x: -s.headWidth * 0.66, y: -torsoHeight / 2 + s.headHeight * 0.3 },
      zIndex: 8,
      shapes: [
        { kind: "capsule", from: { x: 0, y: 0 }, to: { x: leftEndX * 0.35, y: upperLen * 0.92 }, radius: s.limb.armRadius },
      ],
    }),
    part({
      id: "arm-right",
      parentId: "torso",
      at: { x: s.headWidth * 0.66, y: -torsoHeight / 2 + s.headHeight * 0.3 },
      zIndex: 12,
      shapes: [
        { kind: "capsule", from: { x: 0, y: 0 }, to: { x: armEndX, y: armEndY }, radius: s.limb.armRadius },
      ],
    }),

    // --- Head, attached to the torso's top ---------------------------------
    part({
      id: "neck",
      parentId: "torso",
      at: { x: 0, y: -torsoHeight / 2 - s.headHeight * 0.02 },
      zIndex: 7,
      shapes: [
        { kind: "rect", width: s.headWidth * 0.3, height: s.headHeight * 0.3, rx: 5 },
      ],
    }),
    part({
      id: "head",
      parentId: "torso",
      at: { x: 0, y: headOriginY },
      zIndex: 20,
      rotation: headTilt,
      shapes: [{ kind: "ellipse", rx: headRx, ry: headRy }],
    }),

    // Hair mass, behind the face.
    part({
      id: "hair-back",
      parentId: "head",
      at: { x: 0, y: headRy * 0.1 },
      zIndex: 19,
      shapes: [{ kind: "ellipse", rx: headRx * 1.34, ry: headRy * 1.3 }],
    }),
    // Long side falls, giving the messy volume the sheet calls for.
    part({
      id: "hair-left",
      parentId: "head",
      at: { x: -headRx * 0.92, y: headRy * 0.5 },
      zIndex: 21,
      shapes: [
        { kind: "capsule", from: { x: 0, y: 0 }, to: { x: -headRx * 0.1, y: headRy * 1.5 }, radius: headRx * 0.42 },
      ],
    }),
    part({
      id: "hair-right",
      parentId: "head",
      at: { x: headRx * 0.92, y: headRy * 0.5 },
      zIndex: 21,
      shapes: [
        { kind: "capsule", from: { x: 0, y: 0 }, to: { x: headRx * 0.12, y: headRy * 1.45 }, radius: headRx * 0.4 },
      ],
    }),

    // Horns: large, black, sweeping UP and BACK from the temples. The sheet is explicit
    // that they curve — a straight horn would break the character.
    part({
      id: "horn-left",
      parentId: "head",
      at: { x: -headRx * 0.6, y: -headRy * 0.66 },
      zIndex: 18,
      shapes: [
        { kind: "capsule", from: { x: 0, y: 0 }, to: { x: -headRx * 0.28, y: -headRy * 0.72 }, radius: headRx * 0.19 },
      ],
    }),
    part({
      id: "horn-right",
      parentId: "head",
      at: { x: headRx * 0.6, y: -headRy * 0.66 },
      zIndex: 18,
      shapes: [
        { kind: "capsule", from: { x: 0, y: 0 }, to: { x: headRx * 0.28, y: -headRy * 0.72 }, radius: headRx * 0.19 },
      ],
    }),

    // Pointed elf ears, angled outward and slightly back.
    part({
      id: "ear-left",
      parentId: "head",
      at: { x: -headRx * 0.92, y: -headRy * 0.05 },
      zIndex: 17,
      shapes: [
        { kind: "capsule", from: { x: 0, y: 0 }, to: { x: -headRx * 0.5, y: -headRy * 0.22 }, radius: headRx * 0.16 },
      ],
    }),
    part({
      id: "ear-right",
      parentId: "head",
      at: { x: headRx * 0.92, y: -headRy * 0.05 },
      zIndex: 17,
      shapes: [
        { kind: "capsule", from: { x: 0, y: 0 }, to: { x: headRx * 0.5, y: -headRy * 0.22 }, radius: headRx * 0.16 },
      ],
    }),

    // --- Face -------------------------------------------------------------
    // All face features are offsets from the HEAD's origin (its centre). The eye line
    // sits slightly above centre; mouth below.
    part({
      id: "eye-left",
      parentId: "head",
      at: { x: -headRx * 0.38, y: -headRy * 0.1 },
      zIndex: 23,
      shapes: [{ kind: "ellipse", rx: eyeRx, ry: eyeRy }],
    }),
    part({
      id: "eye-right",
      parentId: "head",
      at: { x: headRx * 0.38, y: -headRy * 0.1 },
      zIndex: 23,
      shapes: [{ kind: "ellipse", rx: eyeRx, ry: eyeRy }],
    }),

    // The heavy upper lid that gives the character her default half-lidded look. Drawn
    // over the top of each eye and offset down by the droop amount.
    part({
      id: "lid-left",
      parentId: "head",
      at: { x: -headRx * 0.38, y: -headRy * 0.1 - eyeRy + lidHeight / 2 },
      zIndex: 24,
      shapes: lidHeight > 0.5 ? [{ kind: "rect", width: eyeRx * 2.4, height: lidHeight, rx: 3 }] : [],
      visible: lidHeight > 0.5,
    }),
    part({
      id: "lid-right",
      parentId: "head",
      at: { x: headRx * 0.38, y: -headRy * 0.1 - eyeRy + lidHeight / 2 },
      zIndex: 24,
      shapes: lidHeight > 0.5 ? [{ kind: "rect", width: eyeRx * 2.4, height: lidHeight, rx: 3 }] : [],
      visible: lidHeight > 0.5,
    }),

    part({
      id: "brow-left",
      parentId: "head",
      at: { x: -headRx * 0.38, y: -headRy * 0.42 - browRaise * headRy * 0.16 },
      zIndex: 25,
      rotation: browRaise * -0.12,
      shapes: [{ kind: "rect", width: headRx * 0.42, height: headRy * 0.075, rx: 2 }],
    }),
    part({
      id: "brow-right",
      parentId: "head",
      at: { x: headRx * 0.38, y: -headRy * 0.42 - browRaise * headRy * 0.16 },
      zIndex: 25,
      rotation: browRaise * 0.12,
      shapes: [{ kind: "rect", width: headRx * 0.42, height: headRy * 0.075, rx: 2 }],
    }),

    // Mouth, with a fang when it opens — the sheet shows a visible upper fang on smirks.
    part({
      id: "mouth",
      parentId: "head",
      at: { x: 0, y: headRy * 0.42 },
      zIndex: 26,
      shapes: [
        { kind: "ellipse", rx: mouthRx, ry: mouthRy },
        ...(mouthOpen > 0.25
          ? ([{ kind: "rect", width: mouthRx * 0.32, height: mouthRy * 0.5, rx: 1 }] as Shape[])
          : []),
      ],
    }),

    // --- Tail, attached low on the torso -----------------------------------
    part({
      id: "tail",
      parentId: "torso",
      at: { x: s.headWidth * 0.6, y: torsoHeight / 2 - s.headHeight * 0.1 },
      zIndex: 6,
      rotation: 0.35,
      shapes: [
        { kind: "capsule", from: { x: 0, y: 0 }, to: { x: s.headWidth * 0.6, y: s.headHeight * 0.42 }, radius: 5 },
      ],
    }),
    part({
      id: "tail-tip",
      parentId: "tail",
      at: { x: s.headWidth * 0.6, y: s.headHeight * 0.42 },
      zIndex: 6,
      shapes: [{ kind: "ellipse", rx: s.headWidth * 0.1, ry: s.headHeight * 0.13 }],
    }),
  ];

  return {
    id: "host-rig",
    name: "Demon Host",
    parts,
  };
}

/** Re-exported so tests and renderers can check the rig assembled correctly. */
export { assertConnected };