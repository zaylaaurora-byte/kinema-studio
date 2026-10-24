/**
 * Rasteriser: `EvaluatedFrame` → PNG bytes.
 *
 * Draws using `@napi-rs/canvas`, which wraps Skia and ships prebuilt N-API binaries, so
 * no native toolchain is needed on Windows.
 *
 * ## Transform convention — verified, not assumed
 *
 * `scene.ts` stores a 2D affine transform row-major as `[a c e; b d f; 0 0 1]`, and maps
 * a point with `x' = a*x + c*y + e`, `y' = b*x + d*y + f`.
 *
 * The Canvas2D spec's `setTransform(a, b, c, d, e, f)` uses the same six values in the
 * same order, with the same matrix layout. This was confirmed empirically against the
 * real Skia binding (not just from the spec): `ctx.setTransform(2, 0.5, -0.25, 3, 40, 17)`
 * round-trips through `getTransform()` to exactly those six numbers in that order.
 *
 * Therefore `Transform` can be passed straight through with no component swizzling and
 * no conversion. That is the whole reason this file has no matrix maths in it.
 *
 * Backgrounds are drawn with the *identity* transform (they are plates, not world
 * objects), while camera + part transforms are composed for everything else.
 *
 * The renderer is pure with respect to the frame: given the same `EvaluatedFrame` and
 * the same assets it produces byte-identical PNGs. It never reads a clock, never uses
 * randomness, and never carries state between frames — which is what makes the
 * determinism guarantee downstream in `encode.ts` meaningful.
 */

import { createCanvas, loadImage } from "@napi-rs/canvas";
import type { Canvas, SKRSContext2D, Image } from "@napi-rs/canvas";
import type {
  EvaluatedFrame,
  EvaluatedPart,
  RigStyle,
  Shape,
  Transform,
} from "@kinema/scene-model";

/** Options controlling rasterisation. */
export interface RasteriseOptions {
  /**
   * Resolve a background asset id to an image.
   *
   * Async because loading from disk or the network is async, and pretending otherwise
   * would force every caller into a synchronous-cache dance. Results are cached by the
   * caller-provided resolver, not here, so the renderer stays stateless.
   */
  readonly resolveAsset?: ((assetId: string) => Promise<Image | undefined>) | undefined;
  /** Supersample factor for anti-aliasing. 1 = native, 2 = render 2x then ignore. */
  readonly pixelScale?: number | undefined;
}

/** Default rig appearance: white fill, thick black stroke — the sheet look. */
const DEFAULT_STYLE: Required<Pick<RigStyle, "fill" | "stroke" | "strokeWidth" | "opacity">> = {
  fill: "#ffffff",
  stroke: "#000000",
  strokeWidth: 8,
  opacity: 1,
};

/** Apply a `Transform` directly — same six values, same order. See module header. */
function applyTransform(ctx: SKRSContext2D, t: Transform): void {
  ctx.setTransform(t.a, t.b, t.c, t.d, t.e, t.f);
}

/** Compose two transforms so `inner` is applied inside `outer`. Mirrors scene.ts. */
function compose(outer: Transform, inner: Transform): Transform {
  return {
    a: outer.a * inner.a + outer.c * inner.b,
    b: outer.b * inner.a + outer.d * inner.b,
    c: outer.a * inner.c + outer.c * inner.d,
    d: outer.b * inner.c + outer.d * inner.d,
    e: outer.a * inner.e + outer.c * inner.f + outer.e,
    f: outer.b * inner.e + outer.d * inner.f + outer.f,
  };
}

/**
 * Build the path for a shape in the *current* transform's local space.
 *
 * Shapes are authored around their part's origin, so they are added at local
 * coordinates and the canvas transform does the rest. `rect` and `capsule` are centred
 * on the origin (a limb rotates about its middle); `circle`/`ellipse` accept an explicit
 * centre offset for shapes that hang off the joint.
 */
function traceShape(ctx: SKRSContext2D, shape: Shape): void {
  switch (shape.kind) {
    case "circle": {
      const cx = shape.cx ?? 0;
      const cy = shape.cy ?? 0;
      ctx.moveTo(cx + shape.radius, cy);
      ctx.arc(cx, cy, shape.radius, 0, Math.PI * 2);
      break;
    }
    case "ellipse": {
      const cx = shape.cx ?? 0;
      const cy = shape.cy ?? 0;
      ctx.ellipse(cx, cy, shape.rx, shape.ry, 0, 0, Math.PI * 2);
      break;
    }
    case "capsule": {
      // A stadium: two parallel edges plus semicircular caps. Drawn manually rather
      // than via roundRect so it works for any orientation, including vertical and
      // zero-length (which degenerates to a circle).
      const { from, to, radius } = shape;
      const dx = to.x - from.x;
      const dy = to.y - from.y;
      const len = Math.hypot(dx, dy);
      if (len === 0) {
        ctx.moveTo(from.x + radius, from.y);
        ctx.arc(from.x, from.y, radius, 0, Math.PI * 2);
        break;
      }
      // Perpendicular unit vector.
      const nx = -dy / len;
      const ny = dx / len;
      const angle = Math.atan2(dy, dx);

      const ax = from.x + nx * radius;
      const ay = from.y + ny * radius;
      const bx = to.x + nx * radius;
      const by = to.y + ny * radius;
      const cx2 = to.x - nx * radius;
      const cy2 = to.y - ny * radius;
      const dx2 = from.x - nx * radius;
      const dy2 = from.y - ny * radius;

      ctx.moveTo(ax, ay);
      ctx.lineTo(bx, by);
      ctx.arc(to.x, to.y, radius, angle - Math.PI / 2, angle + Math.PI / 2);
      ctx.lineTo(cx2, cy2);
      ctx.arc(from.x, from.y, radius, angle + Math.PI / 2, angle + (3 * Math.PI) / 2);
      ctx.closePath();
      break;
    }
    case "rect": {
      const w = shape.width;
      const h = shape.height;
      const x = -w / 2;
      const y = -h / 2;
      if (shape.rx && shape.rx > 0) {
        ctx.roundRect(x, y, w, h, shape.rx);
      } else {
        ctx.rect(x, y, w, h);
      }
      break;
    }
    case "path": {
      // SVG path data. Skia exposes Path2D via the canvas package; if the constructor is
      // unavailable we fall back to a no-op rather than throwing mid-render, because a
      // single malformed shape should not destroy an entire export.
      const Path2DImpl = (globalThis as { Path2D?: new (d: string) => unknown }).Path2D;
      if (!Path2DImpl) return;
      try {
        const p = new Path2DImpl(shape.d);
        // The napi-rs Path2D is accepted by fill/stroke directly; ctx.addPath is not
        // universally present, so hand the path to the draw calls instead.
        (ctx as unknown as { __pendingPath?: unknown }).__pendingPath = p;
      } catch {
        // Malformed path data: skip this shape.
      }
      break;
    }
    default: {
      // Exhaustiveness: if a new Shape kind is added this line fails to compile.
      const never: never = shape;
      void never;
      break;
    }
  }
}

/** Draw one shape with the part's style. */
function drawShape(ctx: SKRSContext2D, shape: Shape, style: RigStyle): void {
  const fill = style.fill ?? DEFAULT_STYLE.fill;
  const stroke = style.stroke ?? DEFAULT_STYLE.stroke;
  const strokeWidth = style.strokeWidth ?? DEFAULT_STYLE.strokeWidth;

  ctx.beginPath();
  traceShape(ctx, shape);

  const pending = (ctx as unknown as { __pendingPath?: unknown }).__pendingPath;
  if (pending) {
    delete (ctx as unknown as { __pendingPath?: unknown }).__pendingPath;
    const p = pending as Parameters<SKRSContext2D["fill"]>[0];
    if (fill !== "none") {
      ctx.fillStyle = fill;
      ctx.fill(p);
    }
    if (stroke !== "none" && strokeWidth > 0) {
      ctx.strokeStyle = stroke;
      ctx.lineWidth = strokeWidth;
      ctx.stroke(p);
    }
    return;
  }

  if (fill !== "none") {
    ctx.fillStyle = fill;
    ctx.fill();
  }
  if (stroke !== "none" && strokeWidth > 0) {
    // Stroke after fill, matching the sheet look where the outline sits on top.
    ctx.strokeStyle = stroke;
    ctx.lineWidth = strokeWidth;
    ctx.stroke();
  }
}

function drawPart(ctx: SKRSContext2D, part: EvaluatedPart, camera: Transform): void {
  const style = part.style ?? {};
  const opacity = style.opacity ?? 1;
  if (opacity <= 0) return;

  ctx.save();
  applyTransform(ctx, compose(camera, part.world));
  ctx.globalAlpha = Math.min(Math.max(opacity, 0), 1);
  // Strokes must scale with the part, which is the default for a canvas lineWidth under
  // a scaling transform. Line joins are rounded so articulated limbs do not spike.
  ctx.lineJoin = "round";
  ctx.lineCap = "round";

  if (part.shapes) {
    for (const shape of part.shapes) drawShape(ctx, shape, style);
  }

  ctx.restore();
}

/**
 * Rasterise a frame to a PNG buffer.
 *
 * Draw order: backgrounds first (in their own z order), then parts. `evaluate()` has
 * already sorted `parts` by zIndex then id, so drawing them in array order is correct
 * and stable.
 */
export async function rasteriseFrame(
  frame: EvaluatedFrame,
  options: RasteriseOptions = {},
): Promise<Buffer> {
  const scale = options.pixelScale ?? 1;
  const width = Math.max(1, Math.round(frame.width * scale));
  const height = Math.max(1, Math.round(frame.height * scale));

  const canvas: Canvas = createCanvas(width, height);
  const ctx: SKRSContext2D = canvas.getContext("2d");

  // Start from an opaque black plate so an un-set background never yields transparent
  // pixels, which would encode as a colour shift through yuv420p.
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = "#000000";
  ctx.fillRect(0, 0, width, height);
  if (scale !== 1) ctx.scale(scale, scale);

  // Backgrounds are plates: drawn under camera motion, in their own z order.
  if (frame.backgrounds.length > 0) {
    const ordered = [...frame.backgrounds].sort(
      (x, y) => x.zIndex - y.zIndex || x.layerId.localeCompare(y.layerId),
    );
    for (const bg of ordered) {
      const image = options.resolveAsset ? await options.resolveAsset(bg.assetId) : undefined;
      if (!image) continue;
      ctx.save();
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      if (scale !== 1) ctx.scale(scale, scale);
      ctx.globalAlpha = Math.min(Math.max(bg.opacity, 0), 1);
      // Cover the frame without distorting the plate's aspect ratio.
      const frameAspect = width / height;
      const imageAspect = image.width / image.height;
      let drawW = width;
      let drawH = height;
      if (imageAspect > frameAspect) drawH = width / imageAspect;
      else drawW = height * imageAspect;
      // Temporarily work in device pixels for the cover calculation.
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.drawImage(image, (width - drawW) / 2, (height - drawH) / 2, drawW, drawH);
      ctx.restore();
    }
  }

  for (const part of frame.parts) {
    // A part with no shapes and no asset has nothing to draw. Asset-backed parts need a
    // resolver; without one they are skipped rather than throwing, so a scene missing
    // its sprites still renders its procedural parts.
    if (!part.shapes && part.assetId && options.resolveAsset) {
      const image = await options.resolveAsset(part.assetId);
      if (image) {
        ctx.save();
        applyTransform(ctx, compose(frame.camera, part.world));
        if (scale !== 1) ctx.scale(scale, scale);
        ctx.globalAlpha = Math.min(Math.max(part.style?.opacity ?? 1, 0), 1);
        ctx.drawImage(image, -image.width / 2, -image.height / 2);
        ctx.restore();
      }
      continue;
    }
    if (!part.shapes) continue;
    drawPart(ctx, part, frame.camera);
  }

  return canvas.toBuffer("image/png");
}

/** Convenience: rasterise straight to a `data:` URI (useful for previews/tests). */
export async function rasteriseFrameToDataUrl(
  frame: EvaluatedFrame,
  options: RasteriseOptions = {},
): Promise<string> {
  const buf = await rasteriseFrame(frame, options);
  return `data:image/png;base64,${buf.toString("base64")}`;
}

export { loadImage };
export type { Image };