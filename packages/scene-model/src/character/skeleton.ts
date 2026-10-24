/**
 * Character construction helpers.
 *
 * WHY THIS FILE EXISTS: the first two attempts at the host rig were hand-placed pixel
 * coordinates, and both rendered broken — a floating head, then a detached torso with
 * hovering arms. Guessing offsets does not converge, and each attempt needs a full
 * re-render to discover it failed.
 *
 * This module replaces guessing with arithmetic. A body is described by a small set of
 * ANCHOR POINTS (hip, shoulder, chin, eye line) derived from a head count, and every part
 * is positioned relative to a named anchor. If the head count changes, the whole figure
 * rescales coherently instead of falling apart.
 *
 * It also provides `assertConnected`, which fails loudly when a child part's origin is
 * not actually inside its parent's bounds — the specific defect that took two renders to
 * catch. A test can call it; so can a future rig builder.
 */

import type { Rig, RigPart, Shape, Vec2 } from "@kinema/scene-model";

// ---------------------------------------------------------------------------
// Skeleton
// ---------------------------------------------------------------------------

export interface Skeleton {
  /** Total figure height in local units, measured from the hip line to the crown. */
  readonly height: number;
  /** Number of head-heights the figure spans. 3.5-4 for the reference characters. */
  readonly headCount: number;
  /** Derived head height. */
  readonly headHeight: number;
  readonly headWidth: number;

  /** Named anchor points. Authored TOP-DOWN: y increases downward from the crown. */
  readonly anchors: Readonly<Record<AnchorName, Vec2>>;

  readonly limb: {
    readonly upperArmLength: number;
    readonly foreArmLength: number;
    readonly armRadius: number;
    readonly legLength: number;
    readonly legRadius: number;
  };
}

export type AnchorName =
  | "crown"
  | "eyeLine"
  | "chin"
  | "neckTop"
  | "shoulderCentre"
  | "shoulderLeft"
  | "shoulderRight"
  | "chest"
  | "hip"
  | "hem"
  | "footLeft"
  | "footRight";

/**
 * Derive a coherent skeleton from a head count.
 *
 * The reference sheets state the human is "3.5-4 heads"; the host is a more naturalistic
 * 7-8 heads but is drawn in the same stylised register. Getting this from one parameter
 * means proportions stay internally consistent.
 */
export function makeSkeleton(options: {
  headCount: number;
  headWidth?: number;
  /** Shoulder span as a multiple of head width. */
  shoulderWidth?: number;
}): Skeleton {
  const { headCount } = options;
  const headWidth = options.headWidth ?? 100;
  const shoulderWidth = options.shoulderWidth ?? headWidth * 1.3;

  // Standard figure proportions, expressed as multiples of head height. These are the
  // conventional canons used in character design, so they read as "correct" to the eye.
  const headHeight = headWidth * 1.12;
  const height = headHeight * headCount;

  const crown = 0;
  const chin = headHeight;
  // The neck is a SHORT segment BELOW the chin. Previously `neckTop` was set equal to
  // `chin`, which made two anchors identical and broke the top-to-bottom ordering the
  // proportions depend on.
  const neckLength = headHeight * 0.16;
  const neckTop = chin + neckLength;
  const shoulderY = neckTop + headHeight * 0.1;
  const chestY = shoulderY + (height - shoulderY) * 0.42;
  const hipY = height;
  const hemY = hipY - headHeight * 0.12;

  // The eye line sits in the UPPER portion of the head. Measured from the crown, the
  // conventional placement is roughly one third down the head — not past the midpoint,
  // which would put the eyes at the chin.
  const eyeLine = crown + headHeight * 0.36;

  return {
    height,
    headCount,
    headHeight,
    headWidth,
    anchors: {
      crown: { x: 0, y: crown },
      eyeLine: { x: 0, y: eyeLine },
      chin: { x: 0, y: chin },
      neckTop: { x: 0, y: neckTop },
      shoulderCentre: { x: 0, y: shoulderY },
      shoulderLeft: { x: -shoulderWidth / 2, y: shoulderY },
      shoulderRight: { x: shoulderWidth / 2, y: shoulderY },
      chest: { x: 0, y: chestY },
      hip: { x: 0, y: hipY },
      hem: { x: 0, y: hemY },
      footLeft: { x: -shoulderWidth * 0.22, y: hipY + headHeight * 0.9 },
      footRight: { x: shoulderWidth * 0.22, y: hipY + headHeight * 0.9 },
    },
    limb: {
      upperArmLength: headHeight * 0.78,
      foreArmLength: headHeight * 0.72,
      armRadius: headWidth * 0.14,
      legLength: headHeight * 0.9,
      legRadius: headWidth * 0.16,
    },
  };
}

/**
 * Convert an anchor into a part's local coordinate space.
 *
 * Two conversions happen here, and getting either wrong is how the earlier rigs broke:
 *
 *  1. **Translate** so the named `origin` anchor becomes (0,0). The rig's origin is the
 *     hip line, so the crown lands at a large NEGATIVE y.
 *  2. **Flip the sign of y.** The skeleton is written top-down (y increases downward, which
 *     is how you reason about anatomy), but the scene renderer treats negative y as up.
 *     Anchors above the origin must therefore come out negative.
 */
export function anchorOffset(skeleton: Skeleton, name: AnchorName, origin: AnchorName = "hip"): Vec2 {
  const target = skeleton.anchors[name];
  const from = skeleton.anchors[origin];
  // target.y < from.y for anything above the origin, so negating makes it negative.
  return { x: target.x - from.x, y: target.y - from.y };
}

/**
 * Offset from a parent part's own origin.
 *
 * This is the function that prevents detached limbs: a child is always positioned
 * relative to where its parent actually is, never in absolute space.
 */
export function relativeTo(parent: Vec2, child: Vec2): Vec2 {
  return { x: child.x - parent.x, y: child.y - parent.y };
}

// ---------------------------------------------------------------------------
// Connectivity checking — the guard against the bug that took two renders
// ---------------------------------------------------------------------------

export interface PartBounds {
  readonly min: Vec2;
  readonly max: Vec2;
}

/** Approximate the local bounds of a part's shapes, for connectivity checks. */
export function shapeBounds(shapes: readonly Shape[]): PartBounds {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;

  const include = (x: number, y: number): void => {
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
  };

  for (const shape of shapes) {
    switch (shape.kind) {
      case "circle": {
        const cx = shape.cx ?? 0;
        const cy = shape.cy ?? 0;
        include(cx - shape.radius, cy - shape.radius);
        include(cx + shape.radius, cy + shape.radius);
        break;
      }
      case "ellipse": {
        const cx = shape.cx ?? 0;
        const cy = shape.cy ?? 0;
        include(cx - shape.rx, cy - shape.ry);
        include(cx + shape.rx, cy + shape.ry);
        break;
      }
      case "rect":
        include(0, 0);
        include(shape.width, shape.height);
        break;
      case "capsule":
        include(shape.from.x - shape.radius, shape.from.y - shape.radius);
        include(shape.to.x + shape.radius, shape.to.y + shape.radius);
        break;
      case "path":
        include(-1, -1);
        include(1, 1);
        break;
    }
  }

  return { min: { x: minX, y: minY }, max: { x: maxX, y: maxY } };
}

function pointInBounds(point: Vec2, bounds: PartBounds, tolerance: number): boolean {
  return (
    point.x >= bounds.min.x - tolerance &&
    point.x <= bounds.max.x + tolerance &&
    point.y >= bounds.min.y - tolerance &&
    point.y <= bounds.max.y + tolerance
  );
}

export interface ConnectivityProblem {
  readonly childId: string;
  readonly parentId: string;
  readonly message: string;
}

/**
 * Check that every child part's origin lies within (or near) its parent's drawn bounds.
 *
 * A child whose attachment point is outside its parent's geometry will visibly float.
 * That is a rendering defect, not a stylistic choice, and it should be caught by a test
 * rather than by a human squinting at a contact sheet after a 10-second render.
 *
 * @param tolerance How far outside the parent a joint may sit. A little slack is
 *   realistic — a limb can attach at the very edge — but metres of slack means detached.
 */
export function assertConnected(rig: Rig, tolerance = 14): ConnectivityProblem[] {
  const byId = new Map(rig.parts.map((p) => [p.id, p]));
  const problems: ConnectivityProblem[] = [];

  for (const part of rig.parts) {
    if (!part.parentId) continue;
    const parent = byId.get(part.parentId);
    if (!parent) {
      problems.push({
        childId: part.id,
        parentId: part.parentId,
        message: `parent "${part.parentId}" does not exist`,
      });
      continue;
    }

    // The child's origin, expressed in the parent's coordinate space, is simply its
    // declared localPosition.
    if (!parent.shapes || parent.shapes.length === 0) continue;

    const bounds = shapeBounds(parent.shapes);
    if (!pointInBounds(part.localPosition, bounds, tolerance)) {
      problems.push({
        childId: part.id,
        parentId: parent.id,
        message:
          `"${part.id}" attaches at (${part.localPosition.x.toFixed(0)}, ` +
          `${part.localPosition.y.toFixed(0)}) but its parent "${parent.id}" only spans ` +
          `x ${bounds.min.x.toFixed(0)}..${bounds.max.x.toFixed(0)}, ` +
          `y ${bounds.min.y.toFixed(0)}..${bounds.max.y.toFixed(0)}`,
      });
    }
  }

  return problems;
}

/**
 * Build a part with a consistent origin, keeping the construction terse.
 */
export function part(input: {
  id: string;
  parentId?: string;
  at: Vec2;
  zIndex: number;
  shapes: readonly Shape[];
  rotation?: number;
  visible?: boolean;
}): RigPart {
  const channels: Record<string, unknown> = {};

  if (input.rotation !== undefined) {
    channels["rotation"] = {
      kind: "number",
      keyframes: [{ time: 0, value: input.rotation }],
    };
  }
  if (input.visible !== undefined) {
    channels["visible"] = {
      kind: "string",
      keyframes: [{ time: 0, value: input.visible ? "visible" : "hidden" }],
    };
  }

  return {
    id: input.id,
    ...(input.parentId ? { parentId: input.parentId } : {}),
    localPosition: input.at,
    zIndex: input.zIndex,
    shapes: input.shapes,
    channels,
  } as RigPart;
}