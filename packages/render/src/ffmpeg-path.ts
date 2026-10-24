/**
 * FFmpeg / ffprobe discovery.
 *
 * ## LICENSING — READ BEFORE BUNDLING
 *
 * The FFmpeg build used here (Gyan "full_build", ffmpeg 9.0.2) is **GPLv3**: its own
 * `-version` banner reports `--enable-gpl --enable-version3 --enable-libx264`. The GPL
 * comes from libx264 (and libx265), which are GPL-licensed.
 *
 * Consequences, stated plainly:
 *
 *  - **Local / personal use is unproblematic.** Running a GPL binary as a separate
 *    process does not make our code a derivative work. Kinema's own source stays
 *    AGPL-3.0-or-later.
 *  - **Distribution is the problem.** Shipping this binary inside an installer, or
 *    making it a hard dependency that the product cannot function without, obliges us
 *    to comply with the GPL for that binary — source offer, licence text, no additional
 *    restrictions. It also means we cannot ship a proprietary build.
 *
 * Therefore this module deliberately:
 *
 *  1. Never vendors or downloads FFmpeg. There is no `ffmpeg-static` dependency, and
 *     there must not be one — that package is GPL and would silently relicense the
 *     product.
 *  2. Treats the binary as an **external, user-provided tool**, located by explicit
 *     configuration first (`FFMPEG_PATH` env var, or `options.ffmpegPath`) and PATH
 *     only as a fallback.
 *  3. Fails with an actionable error rather than a `ENOENT` stack when it is missing,
 *     so a packaging mistake surfaces as a clear message.
 *
 * The eventual distribution story is one of: (a) ship an LGPL-only FFmpeg build (no
 * libx264 — use OpenH264 or the native `mpeg4` encoder), or (b) require the user to
 * install FFmpeg themselves and point `FFMPEG_PATH` at it. This module supports both
 * without code changes, which is why resolution is indirected here rather than
 * hard-coded at the call site.
 */

import { existsSync } from "node:fs";
import { delimiter, dirname, join } from "node:path";
import process from "node:process";

/** Injectable for tests; defaults to the real environment. */
export interface ToolResolveOptions {
  /** Explicit absolute path. Highest precedence. */
  readonly explicitPath?: string | undefined;
  /** Environment to read `FFMPEG_PATH` / `FFPROBE_PATH` from. Defaults to `process.env`. */
  readonly env?: Readonly<Record<string, string | undefined>> | undefined;
  /** PATH string to search as a last resort. Defaults to `process.env.PATH`. */
  readonly pathEnv?: string | undefined;
}

const EXE = process.platform === "win32" ? ".exe" : "";

/**
 * Search a PATH-style string for an executable.
 *
 * Returns the first real hit. Windows also accepts a bare name with no extension, so
 * the extensionless form is probed after the `.exe` form.
 */
function searchPath(name: string, pathEnv: string | undefined): string | undefined {
  if (!pathEnv) return undefined;
  const candidates = [`${name}${EXE}`, name];

  for (const dir of pathEnv.split(delimiter)) {
    if (!dir) continue;
    for (const candidate of candidates) {
      const full = join(dir, candidate);
      try {
        if (existsSync(full)) return full;
      } catch {
        // A malformed PATH entry (illegal characters) must not abort the search.
      }
    }
  }
  return undefined;
}

/**
 * Resolve the `ffmpeg` executable.
 *
 * Precedence: explicit path → `FFMPEG_PATH` → PATH. Returns `undefined` when nothing
 * is found; callers decide whether that is fatal.
 */
export function resolveFfmpegPath(options: ToolResolveOptions = {}): string | undefined {
  const env = options.env ?? process.env;
  const pathEnv = options.pathEnv ?? env["PATH"];

  const explicit = options.explicitPath ?? env["FFMPEG_PATH"];
  if (explicit) {
    if (existsSync(explicit)) return explicit;
    // An explicitly configured path that does not exist is a configuration error, and
    // silently falling through to PATH would hide it. Report it loudly.
    throw new Error(
      `FFMPEG_PATH is set to "${explicit}" but no such file exists. ` +
        `Fix the path or unset FFMPEG_PATH to fall back to PATH.`,
    );
  }

  return searchPath("ffmpeg", pathEnv);
}

/**
 * Resolve `ffprobe`, which ships beside `ffmpeg` in every standard build.
 *
 * If `ffmpeg` was given explicitly we prefer the sibling `ffprobe` in the same
 * directory — that is almost always the matching build — before consulting PATH.
 */
export function resolveFfprobePath(options: ToolResolveOptions = {}): string | undefined {
  const env = options.env ?? process.env;
  const pathEnv = options.pathEnv ?? env["PATH"];

  const explicit = options.explicitPath ?? env["FFPROBE_PATH"];
  if (explicit) {
    if (existsSync(explicit)) return explicit;
    throw new Error(
      `FFPROBE_PATH is set to "${explicit}" but no such file exists. ` +
        `Fix the path or unset FFPROBE_PATH to fall back to PATH.`,
    );
  }

  // If ffmpeg is known, its sibling ffprobe is overwhelmingly likely to be correct.
  const ffmpeg = resolveFfmpegPath(options);
  if (ffmpeg) {
    const sibling = join(dirname(ffmpeg), `ffprobe${EXE}`);
    if (existsSync(sibling)) return sibling;
  }

  return searchPath("ffprobe", pathEnv);
}

/** Resolve `ffmpeg` or throw an actionable error. */
export function requireFfmpegPath(options: ToolResolveOptions = {}): string {
  const found = resolveFfmpegPath(options);
  if (found) return found;
  throw new Error(
    "ffmpeg was not found.\n" +
      "Kinema does not bundle FFmpeg (the common builds are GPL, which would relicense " +
      "the product). Install it and either put it on PATH or set FFMPEG_PATH to the " +
      "absolute path of ffmpeg.exe.\n" +
      "  Windows: winget install Gyan.FFmpeg\n" +
      "  macOS:   brew install ffmpeg\n" +
      "  Linux:   apt install ffmpeg",
  );
}

/** Resolve `ffprobe` or throw an actionable error. */
export function requireFfprobePath(options: ToolResolveOptions = {}): string {
  const found = resolveFfprobePath(options);
  if (found) return found;
  throw new Error(
    "ffprobe was not found. It normally ships alongside ffmpeg. " +
      "Set FFPROBE_PATH to its absolute path, or set FFMPEG_PATH to a build that " +
      "includes it.",
  );
}