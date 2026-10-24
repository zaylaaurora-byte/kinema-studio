/**
 * `@kinema/render` — turn an evaluated 2D scene into a real, playable MP4.
 *
 * Three layers, each usable on its own:
 *
 *  - `rasterise.ts` — `EvaluatedFrame` → PNG bytes, via Skia.
 *  - `encode.ts`    — a stream of PNGs → MP4, via FFmpeg, with backpressure and abort.
 *  - `export.ts`    — `exportScene(scene, options)`, the one call most callers want.
 *
 * `ffmpeg-path.ts` holds tool discovery and documents the GPL licensing constraint:
 * FFmpeg is an external, user-provided tool here — never bundled, never `ffmpeg-static`.
 */

export {
  resolveFfmpegPath,
  resolveFfprobePath,
  requireFfmpegPath,
  requireFfprobePath,
  type ToolResolveOptions,
} from "./ffmpeg-path.js";

export {
  encodeFrames,
  buildFfmpegArgs,
  FfmpegError,
  RenderAbortedError,
  type EncodeOptions,
  type EncodeResult,
} from "./encode.js";

export {
  rasteriseFrame,
  rasteriseFrameToDataUrl,
  loadImage,
  type RasteriseOptions,
  type Image,
} from "./rasterise.js";

export {
  exportScene,
  rasteriseScene,
  IS_WINDOWS,
  type ExportSceneOptions,
  type ExportResult,
} from "./export.js";