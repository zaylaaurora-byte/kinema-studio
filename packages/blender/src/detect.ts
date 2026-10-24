import { execFile } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import process from "node:process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/**
 * Blender discovery.
 *
 * The ADR is explicit that detection "must not hardcode that path": an absolute path
 * that is correct on the development machine is wrong on every other machine, and a
 * hardcoded path silently degrades into "Blender is not installed" for anyone whose
 * install differs. So the known path is only ever one *candidate* among several, and the
 * user can override the whole probe with `BLENDER_PATH`.
 *
 * Probe order (first hit wins):
 *
 *   1. `BLENDER_PATH` — deliberate user intent beats every heuristic.
 *   2. `blender` on `PATH` — how Linux/macOS package managers and the Windows installer
 *      (when ticked) expose it.
 *   3. Platform-standard install directories.
 *
 * Nothing here launches Blender; discovery is pure filesystem work plus one optional
 * `--version` call, and it never throws. A provider that cannot find Blender must
 * degrade to "unavailable with an explanation", not crash the app.
 */

/** What the integration requires. Blender 3.0 introduced the modern Python API. */
export const MINIMUM_SUPPORTED_MAJOR = 3;
export const MINIMUM_SUPPORTED_MINOR = 0;

/** The integration's stated floor, as a human-readable string. */
export const MINIMUM_SUPPORTED_LABEL = "Blender 3.0 or newer";

/** Why a candidate was rejected, so the UI can explain a failed detection. */
export interface ProbeAttempt {
  /** Where the candidate came from: `BLENDER_PATH`, `PATH`, or a known install root. */
  readonly source: string;
  /** The candidate path (or bare command name for the `PATH` probe). */
  readonly candidate: string;
  readonly found: boolean;
  readonly note?: string;
}

export interface BlenderInstall {
  /** Absolute path to the executable, or the bare name when resolved through `PATH`. */
  readonly path: string;
  /** Version as printed by `--version`, e.g. `5.1.0`. `null` when it could not be read. */
  readonly version: string | null;
  /** Which probe produced this result. */
  readonly source: string;
  /** True when `version` satisfies the integration's floor. */
  readonly supported: boolean;
  /** Whether `--version` actually ran. False means the path merely exists on disk. */
  readonly versionVerified: boolean;
}

export interface DetectionResult {
  /** The chosen install, or `null` when nothing usable was found. */
  readonly install: BlenderInstall | null;
  /** Every candidate tried, in order — the audit trail for a failed detection. */
  readonly attempts: readonly ProbeAttempt[];
}

export interface DetectionOptions {
  /** Override the environment (tests). Defaults to `process.env`. */
  readonly env?: Readonly<Record<string, string | undefined>> | undefined;
  /** Override the platform (tests). Defaults to `process.platform`. */
  readonly platform?: NodeJS.Platform | undefined;
  /**
   * When false, skip the `--version` subprocess and report `version: null`.
   * Exists so the pure-filesystem path can be unit tested without launching Blender.
   */
  readonly probeVersion?: boolean | undefined;
  /** Timeout for a single `--version` call. Blender answers in well under a second. */
  readonly versionTimeoutMs?: number | undefined;
}

/**
 * Parse the version out of `blender --version` output.
 *
 * The first line is `Blender 5.1.0`, but the number of components varies (release builds
 * are `X.Y.Z`, some builds print `X.Y`, alphas print things like `4.2.0 Alpha`). Only the
 * leading `major.minor[.patch]` is trusted; anything after it is provenance, not version.
 *
 * Returns `null` rather than throwing, because an unparseable version must not take the
 * whole detection down — the caller decides whether to treat it as unsupported.
 */
export function parseBlenderVersion(versionOutput: string): string | null {
  // Anchor on the word "Blender" when present so a stray number in a banner (a build
  // year, a hash) cannot be mistaken for the version.
  const anchored = /Blender\s+(\d+)\.(\d+)(?:\.(\d+))?/i.exec(versionOutput);
  const match = anchored ?? /^\s*(\d+)\.(\d+)(?:\.(\d+))?\s*$/m.exec(versionOutput);
  if (!match) return null;

  const major = match[1];
  const minor = match[2];
  const patch = match[3];
  if (major === undefined || minor === undefined) return null;
  return patch === undefined ? `${major}.${minor}` : `${major}.${minor}.${patch}`;
}

/** A parsed version, normalised to numbers so comparison is arithmetic, not textual. */
export interface ParsedVersion {
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
  /** True when the source string carried an explicit patch component. */
  readonly hasPatch: boolean;
}

/** Split a `major[.minor[.patch]]` string. Returns `null` for anything else. */
export function parseVersionParts(version: string): ParsedVersion | null {
  const match = /^(\d+)(?:\.(\d+))?(?:\.(\d+))?/.exec(version.trim());
  if (!match) return null;
  const major = match[1];
  if (major === undefined) return null;
  return {
    major: Number(major),
    minor: Number(match[2] ?? 0),
    patch: Number(match[3] ?? 0),
    hasPatch: match[3] !== undefined,
  };
}

/**
 * Does this version satisfy the integration's requirement?
 *
 * `null` (unknown version) is treated as **unsupported**, not as "probably fine". The
 * ADR's whole theme is refusing to overclaim: if we could not read the version we cannot
 * assert the API surface we depend on exists, so we say so and let the user override.
 */
export function isSupported(version: string | null): boolean {
  if (version === null) return false;
  const parts = parseVersionParts(version);
  if (parts === null) return false;
  if (parts.major !== MINIMUM_SUPPORTED_MAJOR) {
    return parts.major > MINIMUM_SUPPORTED_MAJOR;
  }
  return parts.minor >= MINIMUM_SUPPORTED_MINOR;
}

function isWindows(platform: NodeJS.Platform): boolean {
  return platform === "win32";
}

/**
 * The executable's file name on this platform. Windows needs the extension because
 * `spawn` will not append it for us, and Blender's Windows installer never adds a
 * shell shim.
 */
export function executableName(platform: NodeJS.Platform): string {
  return isWindows(platform) ? "blender.exe" : "blender";
}

/** macOS installs Blender as a bundle; the binary is inside `Contents/MacOS`. */
const MACOS_INSTALL_ROOTS = ["/Applications/Blender.app/Contents/MacOS/blender"];

/** Where Linux distributions and the official tarball conventionally put Blender. */
const LINUX_INSTALL_ROOTS = [
  "/usr/bin/blender",
  "/usr/local/bin/blender",
  "/snap/bin/blender",
  "/var/lib/flatpak/exports/bin/org.blender.Blender",
];

/** The directory Blender's own Windows installer writes into. */
const WINDOWS_INSTALL_PARENT = "C:\\Program Files\\Blender Foundation";

/**
 * Compare two Windows install directory names by the version they encode.
 *
 * WHY THIS IS NOT `Array.prototype.sort()` ON STRINGS. The obvious implementation sorts
 * directory names alphabetically, which is wrong in exactly the case that matters:
 * `"Blender 10.0" < "Blender 5.1"` is true as text and false as a version. Sorting by
 * string would therefore keep using Blender 5.1 after the user installs Blender 10 — a
 * silent downgrade that is very hard to notice. Numeric comparison of the parsed
 * components (major first, then minor, then patch) is the only correct ordering.
 *
 * Directories with no parseable version sort last, since we cannot claim they are newer.
 * A stable directory-name tiebreak keeps the result deterministic.
 */
export function compareInstallDirs(a: string, b: string): number {
  const va = parseVersionParts(extractVersionFromDirName(a) ?? "");
  const vb = parseVersionParts(extractVersionFromDirName(b) ?? "");

  if (va === null && vb === null) return 0;
  if (va === null) return -1; // unversioned directories rank below any known version
  if (vb === null) return 1;

  if (va.major !== vb.major) return va.major - vb.major;
  if (va.minor !== vb.minor) return va.minor - vb.minor;
  if (va.patch !== vb.patch) return va.patch - vb.patch;
  return 0;
}

/** Pull `5.1` / `5.1.0` out of a directory name like `Blender 5.1`. */
export function extractVersionFromDirName(dirName: string): string | null {
  const match = /Blender[ _-]?(\d+(?:\.\d+){0,2})/i.exec(dirName);
  return match?.[1] ?? null;
}

/**
 * Expand the Windows install root into concrete candidates, newest version first.
 *
 * Exported for testing: the ordering rule above is the part that is easy to get wrong and
 * impossible to exercise without a synthetic directory listing.
 */
export function windowsInstallCandidates(
  parent: string,
  readDir: (path: string) => readonly string[],
  joinPath: (...segments: string[]) => string = join,
): readonly string[] {
  let entries: readonly string[];
  try {
    entries = readDir(parent);
  } catch {
    // No such directory (Blender not installed, or a non-Windows host). Not an error.
    return [];
  }

  return [...entries]
    .filter((entry) => extractVersionFromDirName(entry) !== null)
    .sort(compareInstallDirs)
    .reverse() // highest version first
    .map((entry) => joinPath(parent, entry, "blender.exe"));
}

/** Build the ordered list of platform-standard candidates for this host. */
export function standardInstallCandidates(
  platform: NodeJS.Platform,
  readDir: (path: string) => readonly string[] = (path) => readdirSync(path),
): readonly string[] {
  if (isWindows(platform)) {
    return windowsInstallCandidates(WINDOWS_INSTALL_PARENT, readDir);
  }
  if (platform === "darwin") {
    // Newest first is not expressible here (Apple ships one bundle), so order is fixed.
    return [...MACOS_INSTALL_ROOTS].reverse();
  }
  return LINUX_INSTALL_ROOTS;
}

/**
 * Run `blender --version` and return its first line.
 *
 * `execFile` with an argv array, never a shell string: the path comes from the
 * environment and could contain shell metacharacters, and there is no reason to give it
 * the chance to be interpreted.
 */
async function readVersion(
  executable: string,
  timeoutMs: number,
): Promise<{ output: string; ok: boolean }> {
  try {
    const { stdout, stderr } = await execFileAsync(executable, ["--version"], {
      timeout: timeoutMs,
      windowsHide: true,
      // Explicit for clarity: no shell, so the path cannot inject anything.
      shell: false,
      maxBuffer: 4 * 1024 * 1024,
    });
    return { output: stdout || stderr, ok: true };
  } catch (error) {
    // A candidate that fails `--version` is not necessarily useless (it might be a
    // wrapper script), but we cannot verify it, and we refuse to claim a version we
    // did not read.
    return { output: error instanceof Error ? error.message : String(error), ok: false };
  }
}

/**
 * Probe for a usable Blender install.
 *
 * Never throws. The caller gets the chosen install (or `null`) plus the full attempt
 * list, which is what makes a "Blender not found" message actionable — the user can see
 * every path we tried and set `BLENDER_PATH` accordingly, exactly as the ADR requires.
 */
export async function detectBlender(options: DetectionOptions = {}): Promise<DetectionResult> {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const probeVersion = options.probeVersion ?? true;
  const versionTimeoutMs = options.versionTimeoutMs ?? 20_000;

  const attempts: ProbeAttempt[] = [];

  /** Candidates in probe order, each tagged with its source for the audit trail. */
  const candidates: { source: string; candidate: string; exists: boolean }[] = [];

  const explicit = env["BLENDER_PATH"]?.trim();
  if (explicit) {
    candidates.push({
      source: "BLENDER_PATH",
      candidate: explicit,
      // An explicit override is honoured even if the file check fails: on Windows a
      // `.cmd` shim or a store alias may not satisfy `existsSync`, and the user's
      // instruction should still be attempted.
      exists: true,
    });
  }

  // `blender` on PATH. We do not resolve it ourselves with `which`/`where`: the child
  // process resolves it, and PATH lookup is exactly what the OS is for.
  candidates.push({
    source: "PATH",
    candidate: executableName(platform),
    exists: true,
  });

  for (const candidatePath of standardInstallCandidates(platform)) {
    // `existsSync` on a UNC or missing drive returns false rather than throwing.
    if (existsSync(candidatePath)) {
      candidates.push({
        source: "standard-install-location",
        candidate: candidatePath,
        exists: true,
      });
    } else {
      attempts.push({
        source: "standard-install-location",
        candidate: candidatePath,
        found: false,
        note: "path does not exist",
      });
    }
  }

  for (const { source, candidate, exists } of candidates) {
    if (!exists) {
      attempts.push({ source, candidate, found: false, note: "path does not exist" });
      continue;
    }

    if (!probeVersion) {
      attempts.push({ source, candidate, found: true, note: "version probe skipped" });
      return {
        install: {
          path: candidate,
          version: null,
          source,
          supported: false,
          versionVerified: false,
        },
        attempts,
      };
    }

    const { output, ok } = await readVersion(candidate, versionTimeoutMs);
    const version = ok ? parseBlenderVersion(output) : null;

    if (ok && version !== null) {
      attempts.push({ source, candidate, found: true, note: `version ${version}` });
      return {
        install: {
          path: candidate,
          version,
          source,
          supported: isSupported(version),
          versionVerified: true,
        },
        attempts,
      };
    }

    attempts.push({
      source,
      candidate,
      found: false,
      note: ok
        ? "executable ran but printed no recognisable version"
        : "executable could not be run",
    });
  }

  return { install: null, attempts };
}

/**
 * Convenience wrapper for callers that only need the path, and want a hard failure.
 *
 * Kept separate from `detectBlender` so the common path (the adapter's capability
 * discovery) can report "not installed" as data rather than as an exception.
 */
export async function requireBlenderPath(options: DetectionOptions = {}): Promise<string> {
  const { install, attempts } = await detectBlender(options);
  if (install === null) {
    const tried = attempts.map((a) => `  ${a.source}: ${a.candidate}`).join("\n");
    throw new BlenderNotFoundError(
      `Blender was not found. Set BLENDER_PATH to the executable, or install ${MINIMUM_SUPPORTED_LABEL}.\nTried:\n${tried}`,
      attempts,
    );
  }
  return install.path;
}

export class BlenderNotFoundError extends Error {
  readonly attempts: readonly ProbeAttempt[];

  constructor(message: string, attempts: readonly ProbeAttempt[]) {
    super(message);
    this.name = "BlenderNotFoundError";
    this.attempts = attempts;
  }
}

/** Link offered in the UI when no install is found (ADR decision 1: we do not bundle). */
export const BLENDER_DOWNLOAD_URL = "https://www.blender.org/download/";