/**
 * Deterministic 2D scene model.
 *
 * THE CENTRAL DESIGN RULE: a frame is a PURE FUNCTION OF TIME.
 *
 * `evaluate(scene, timeSeconds)` returns exactly what the scene looks like at that
 * instant. Nothing depends on wall-clock time, frame rate, rendering speed, or the order
 * frames happen to be drawn in.
 *
 * Why this matters more than it might appear:
 *
 *  - **Determinism.** Rendering the same scene twice produces byte-identical frames, so
 *    visual-regression tests are meaningful and caching by content hash is safe.
 *  - **Frame-accurate seek.** The scrubber can jump to any frame without replaying from
 *    the start, because there is no accumulated state to replay.
 *  - **Re-render one shot.** Fixing scene 4 cannot perturb scene 7, because nothing is
 *    carried between them.
 *  - **Slow machines produce identical output.** A 2014 CPU and a modern one agree
 *    exactly; only the wall-clock duration differs.
 *
 * The alternative — driving animation from a real-time clock, as a game engine would —
 * fails all four. It is the reason so many "video" tools cannot export reproducibly.
 */

// ---------------------------------------------------------------------------
// Geometry
// ---------------------------------------------------------------------------

export interface Vec2 {
  readonly x: number;
  readonly y: number;
}

/**
 * A 2D affine transform, stored as its six meaningful components.
 *
 * Row-major: [a c e]
 *            [b d f]
 *            [0 0 1]
 */
export interface Transform {
  readonly a: number;
  readonly b: number;
  readonly c: number;
  readonly d: number;
  readonly e: number;
  readonly f: number;
}

export const IDENTITY: Transform = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };

export function compose(outer: Transform, inner: Transform): Transform {
  return {
    a: outer.a * inner.a + outer.c * inner.b,
    b: outer.b * inner.a + outer.d * inner.b,
    c: outer.a * inner.c + outer.c * inner.d,
    d: outer.b * inner.c + outer.d * inner.d,
    e: outer.a * inner.e + outer.c * inner.f + outer.e,
    f: outer.b * inner.e + outer.d * inner.f + outer.f,
  };
}

export function applyTransform(t: Transform, point: Vec2): Vec2 {
  return {
    x: t.a * point.x + t.c * point.y + t.e,
    y: t.b * point.x + t.d * point.y + t.f,
  };
}

/** Build a transform from a part's local position, rotation and scale. */
export function makeTransform(
  position: Vec2,
  rotationRadians: number,
  scale: Vec2,
): Transform {
  const cos = Math.cos(rotationRadians);
  const sin = Math.sin(rotationRadians);
  return {
    a: cos * scale.x,
    b: sin * scale.x,
    c: -sin * scale.y,
    d: cos * scale.y,
    e: position.x,
    f: position.y,
  };
}

// ---------------------------------------------------------------------------
// Easing
// ---------------------------------------------------------------------------

/**
 * Easing functions.
 *
 * Deliberately a closed set rather than arbitrary Bezier control points: a fixed set is
 * easier to serialise, easier to reason about, and cannot produce the pathological
 * curves that make animation feel wrong.
 */
export type EasingName =
  | "linear"
  | "easeIn"
  | "easeOut"
  | "easeInOut"
  | "step"
  | "backOut"
  | "elasticOut"
  | "bounceOut";

export const EASINGS: Record<EasingName, (t: number) => number> = {
  linear: (t) => t,
  easeIn: (t) => t * t,
  easeOut: (t) => 1 - (1 - t) * (1 - t),
  easeInOut: (t) => (t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2),
  // Holds the start value until the end, then jumps. Essential for comedy beats and
  // for held poses, and impossible to express with a smooth curve.
  step: (t) => (t >= 1 ? 1 : 0),
  backOut: (t) => {
    const c1 = 1.70158;
    const c3 = c1 + 1;
    return 1 + c3 * (t - 1) ** 3 + c1 * (t - 1) ** 2;
  },
  elasticOut: (t) => {
    if (t === 0 || t === 1) return t;
    const c4 = (2 * Math.PI) / 3;
    return 2 ** (-10 * t) * Math.sin((t * 10 - 0.75) * c4) + 1;
  },
  bounceOut: (t) => {
    const n1 = 7.5625;
    const d1 = 2.75;
    if (t < 1 / d1) return n1 * t * t;
    if (t < 2 / d1) return n1 * (t -= 1.5 / d1) * t + 0.75;
    if (t < 2.5 / d1) return n1 * (t -= 2.25 / d1) * t + 0.9375;
    return n1 * (t -= 2.625 / d1) * t + 0.984375;
  },
};

// ---------------------------------------------------------------------------
// Keyframes
// ---------------------------------------------------------------------------

/** A keyframe holds a value at a point in time. */
export interface Keyframe<T> {
  /** Time in seconds from the start of the scene. */
  readonly time: number;
  readonly value: T;
  /** Easing applied on the segment leading INTO this keyframe. */
  readonly easing?: EasingName;
}

/**
 * An animation channel: a named property animated over time.
 *
 * Channels are numeric because that is what the rig actually transforms. Discrete
 * switches (which face is showing) use a string channel with `step` easing.
 */
export interface NumberChannel {
  readonly kind: "number";
  readonly keyframes: readonly Keyframe<number>[];
}

export interface StringChannel {
  readonly kind: "string";
  readonly keyframes: readonly Keyframe<string>[];
}

export type Channel = NumberChannel | StringChannel;

/**
 * Sample a numeric channel at a given time.
 *
 * Before the first keyframe and after the last, the value is held rather than
 * extrapolated — extrapolating a position channel produces parts that fly off screen,
 * which is never what an animator wants.
 *
 * Accepts `undefined` so callers can pass a possibly-missing channel straight through.
 * This matters because `channels` is a partial record: a part that never animates its
 * x position simply has no "x" channel, and that is the common case, not an error.
 * Requiring callers to check first invites the `as NumberChannel` cast that turns a
 * missing channel into a runtime crash.
 */
export function sampleNumber(
  channel: NumberChannel | undefined,
  time: number,
): number | undefined {
  if (!channel) return undefined;

  const frames = channel.keyframes;
  if (frames.length === 0) return undefined;
  if (frames.length === 1) return frames[0]!.value;

  const first = frames[0]!;
  if (time <= first.time) return first.value;

  const last = frames[frames.length - 1]!;
  if (time >= last.time) return last.value;

  for (let i = 1; i < frames.length; i++) {
    const to = frames[i]!;
    if (time <= to.time) {
      const from = frames[i - 1]!;
      const span = to.time - from.time;
      // Guard against zero-length segments, which would divide by zero.
      if (span <= 0) return to.value;

      const raw = (time - from.time) / span;
      const easing = EASINGS[to.easing ?? "linear"];
      const eased = easing(raw);
      return from.value + (to.value - from.value) * eased;
    }
  }

  return last.value;
}

export function sampleString(
  channel: StringChannel | undefined,
  time: number,
): string | undefined {
  if (!channel) return undefined;

  const frames = channel.keyframes;
  if (frames.length === 0) return undefined;

  let current = frames[0]!.value;
  for (const frame of frames) {
    if (time >= frame.time) current = frame.value;
    else break;
  }
  return current;
}

// ---------------------------------------------------------------------------
// Rig
// ---------------------------------------------------------------------------

/**
 * A single transformable part of a character.
 *
 * `parentId` gives a hierarchy: moving the torso moves the head and arms attached to it.
 * This is what makes genuine character animation possible rather than moving a flat
 * image — the requirement that the pilot "must not be a Ken Burns zoom".
 */
export interface RigPart {
  readonly id: string;
  readonly parentId?: string;
  /** Where this part's origin sits in the parent's coordinate space. */
  readonly localPosition: Vec2;
  /** How the part is drawn relative to its own origin. */
  readonly assetId?: string;
  /** Procedural shapes, so simple characters need no image assets at all. */
  readonly shapes?: readonly Shape[];
  /** Stacking order within the parent. Higher draws later. */
  readonly zIndex: number;
  /** Rotation/pivot offset, for parts that rotate about a joint rather than centre. */
  readonly pivot?: Vec2;
  readonly channels: Readonly<Record<string, Channel>>;
}

/** A drawable primitive. Enough to construct the minimalist human from the sheets. */
export type Shape =
  | { readonly kind: "circle"; readonly radius: number; readonly cx?: number; readonly cy?: number }
  | { readonly kind: "ellipse"; readonly rx: number; readonly ry: number; readonly cx?: number; readonly cy?: number }
  | {
      readonly kind: "capsule";
      readonly from: Vec2;
      readonly to: Vec2;
      readonly radius: number;
    }
  | { readonly kind: "rect"; readonly width: number; readonly height: number; readonly rx?: number }
  | { readonly kind: "path"; readonly d: string };

export interface RigStyle {
  readonly fill?: string;
  readonly stroke?: string;
  readonly strokeWidth?: number;
  readonly opacity?: number;
}

/** A part of the rig resolved at a moment in time. */
export interface EvaluatedPart {
  readonly id: string;
  readonly zIndex: number;
  /** World transform, with all ancestors applied. */
  readonly world: Transform;
  readonly assetId?: string;
  readonly shapes?: readonly Shape[];
  readonly style?: RigStyle;
  /** Visible flag, so a part can be switched off (e.g. a detachable hat). */
  readonly visible: boolean;
}

// ---------------------------------------------------------------------------
// Layers
// ---------------------------------------------------------------------------

export interface Layer {
  readonly id: string;
  readonly name: string;
  readonly zIndex: number;
  readonly visible: boolean;
  readonly opacity: number;
  /** Static background/plate, referenced by asset id. */
  readonly backgroundAssetId?: string;
  /** A character rig placed in the scene. */
  readonly rig?: Rig;
  readonly transform?: Transform;
}

export interface Rig {
  readonly id: string;
  readonly name: string;
  readonly parts: readonly RigPart[];
  /** Named style lookup, so parts can share appearance without duplication. */
  readonly styles?: Readonly<Record<string, RigStyle>>;
  readonly styleRef?: string;
}

// ---------------------------------------------------------------------------
// Scene
// ---------------------------------------------------------------------------

export interface Camera {
  readonly channels: Readonly<Record<string, Channel>>;
}

export interface SceneDocument {
  readonly id: string;
  readonly name: string;
  readonly width: number;
  readonly height: number;
  readonly fps: number;
  readonly durationSeconds: number;
  readonly layers: readonly Layer[];
  readonly camera?: Camera;
  readonly background?: string;
}

/**
 * Evaluate a scene at a specific time.
 *
 * This is the function the entire pipeline rests on. It must remain pure: no I/O, no
 * randomness, no reference to the current date. Any impurity here would silently break
 * determinism and make single-shot re-rendering unsafe.
 */
export function evaluate(scene: SceneDocument, timeSeconds: number): EvaluatedFrame {
  const clamped = Math.min(Math.max(timeSeconds, 0), scene.durationSeconds);

  const camera = scene.camera ? evaluateCamera(scene.camera, clamped) : IDENTITY;

  const parts: EvaluatedPart[] = [];
  const backgrounds: { layerId: string; assetId: string; zIndex: number; opacity: number }[] = [];

  for (const layer of scene.layers) {
    if (!layer.visible) continue;

    if (layer.backgroundAssetId) {
      backgrounds.push({
        layerId: layer.id,
        assetId: layer.backgroundAssetId,
        zIndex: layer.zIndex,
        opacity: layer.opacity,
      });
      continue;
    }

    if (layer.rig) {
      const rigParts = evaluateRig(layer.rig, clamped, layer.transform ?? IDENTITY);
      for (const part of rigParts) {
        parts.push({ ...part, zIndex: layer.zIndex * 1000 + part.zIndex });
      }
    }
  }

  // Deterministic draw order. Sorting by zIndex then id means two parts that share a
  // zIndex always resolve the same way, instead of depending on array order.
  parts.sort((x, y) => (x.zIndex - y.zIndex) || x.id.localeCompare(y.id));

  return {
    timeSeconds: clamped,
    camera,
    backgrounds,
    parts: parts.filter((p) => p.visible),
    width: scene.width,
    height: scene.height,
  };
}

export interface EvaluatedFrame {
  readonly timeSeconds: number;
  readonly camera: Transform;
  readonly backgrounds: readonly {
    layerId: string;
    assetId: string;
    zIndex: number;
    opacity: number;
  }[];
  readonly parts: readonly EvaluatedPart[];
  readonly width: number;
  readonly height: number;
}

function evaluateCamera(camera: Camera, time: number): Transform {
  // Channels are optional: a camera with no "x" channel simply does not pan.
  const x = sampleNumber(asNumberChannel(camera.channels["x"]), time) ?? 0;
  const y = sampleNumber(asNumberChannel(camera.channels["y"]), time) ?? 0;
  const zoom = sampleNumber(asNumberChannel(camera.channels["zoom"]), time) ?? 1;
  const rotation = sampleNumber(asNumberChannel(camera.channels["rotation"]), time) ?? 0;

  // Camera transform is the inverse of the camera's own movement: moving the camera
  // right moves the world left.
  const cos = Math.cos(-rotation);
  const sin = Math.sin(-rotation);
  const s = 1 / (zoom === 0 ? 1 : zoom);

  return {
    a: cos * s,
    b: sin * s,
    c: -sin * s,
    d: cos * s,
    e: -x * s,
    f: -y * s,
  };
}

function evaluateRig(rig: Rig, time: number, rootTransform: Transform): EvaluatedPart[] {
  const output: EvaluatedPart[] = [];
  const worldCache = new Map<string, Transform>();

  // Resolve parents before children. A cycle would otherwise hang, so depth is bounded.
  const byId = new Map(rig.parts.map((p) => [p.id, p]));

  const resolve = (part: RigPart, depth: number): Transform => {
    const cached = worldCache.get(part.id);
    if (cached) return cached;

    // Defensive: malformed data must not hang the renderer.
    if (depth > 64) {
      const fallback = rootTransform;
      worldCache.set(part.id, fallback);
      return fallback;
    }

    const parentWorld = part.parentId
      ? (() => {
          const parent = byId.get(part.parentId!);
          return parent ? resolve(parent, depth + 1) : rootTransform;
        })()
      : rootTransform;

    const x = sampleNumber(asNumberChannel(part.channels["x"]), time) ?? part.localPosition.x;
    const y = sampleNumber(asNumberChannel(part.channels["y"]), time) ?? part.localPosition.y;
    const rotation = sampleNumber(asNumberChannel(part.channels["rotation"]), time) ?? 0;
    const scaleX = sampleNumber(asNumberChannel(part.channels["scaleX"]), time) ?? 1;
    const scaleY = sampleNumber(asNumberChannel(part.channels["scaleY"]), time) ?? 1;

    const local = makeTransform({ x, y }, rotation, { x: scaleX, y: scaleY });
    const world = compose(parentWorld, local);
    worldCache.set(part.id, world);
    return world;
  };

  for (const part of rig.parts) {
    const world = resolve(part, 0);

    const visibleRaw = asStringChannel(part.channels["visible"]);
    const visible = visibleRaw ? sampleString(visibleRaw, time) !== "hidden" : true;

    const opacity = sampleNumber(asNumberChannel(part.channels["opacity"]), time) ?? 1;

    const style = rig.styles?.[rig.styleRef ?? ""];

    output.push({
      id: part.id,
      zIndex: part.zIndex,
      world,
      ...(part.assetId ? { assetId: part.assetId } : {}),
      ...(part.shapes ? { shapes: part.shapes } : {}),
      ...(style ? { style: { ...style, opacity: (style.opacity ?? 1) * opacity } } : {}),
      visible,
    });
  }

  return output;
}

/**
 * Narrow a channel to a numeric one, or undefined.
 *
 * These two helpers exist to replace `channels["x"] as NumberChannel`. That cast is a
 * lie the compiler cannot check: if the channel is missing or is the wrong kind, the
 * cast still typechecks and the failure surfaces at runtime as a crash deep inside
 * sampling. Narrowing honestly costs one function call and removes a whole class of bug.
 */
function asNumberChannel(channel: Channel | undefined): NumberChannel | undefined {
  return channel?.kind === "number" ? channel : undefined;
}

function asStringChannel(channel: Channel | undefined): StringChannel | undefined {
  return channel?.kind === "string" ? channel : undefined;
}

/**
 * Total frame count for a scene.
 *
 * Uses `round` rather than `floor` so a 2-second scene at 30fps yields exactly 60
 * frames rather than 59 — the off-by-one that produces a one-frame flash at every cut.
 */
export function frameCount(scene: SceneDocument): number {
  return Math.round(scene.durationSeconds * scene.fps);
}

/** Convert a frame index to its exact time. The inverse of `frameToTime`. */
export function frameToTime(frame: number, fps: number): number {
  return frame / fps;
}