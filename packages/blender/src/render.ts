import { spawn } from "node:child_process";
import process from "node:process";

import {
  REPORT_END_MARKER,
  REPORT_START_MARKER,
  type BlenderReport,
} from "./script-builder.js";

/**
 * Run Blender and collect its output.
 *
 * ## Why a child process, and why this shape
 *
 * ADR 0002 settles the architecture: Kinema drives Blender headlessly
 * (`--background --factory-startup --python <script>`) rather than talking to the MCP
 * addon's socket server. Compared with that server — which opens port 9876, has no
 * authentication, and "executes commands it receives" as arbitrary Python — a child
 * process opens no port at all, is deterministic under `--factory-startup`, and can be
 * killed. Those three properties are what this module exists to guarantee.
 *
 * ## Spawning
 *
 * Always `spawn(executable, argvArray, { shell: false })`, never `exec` and never a
 * command string. The executable path comes from `BLENDER_PATH` or a filesystem probe and
 * the script path is caller-supplied, so both are attacker-influenced on a shared machine;
 * argv passing means neither is ever parsed by a shell. There is no shell metacharacter to
 * escape because there is no shell.
 *
 * ## Timeout and cancellation
 *
 * A runaway Blender — an accidental `while True:` in a generated script, a Cycles render
 * of a scene far heavier than intended — must not hang the application forever, so a
 * timeout is mandatory and defaults to something finite. Cancellation is a kill of the
 * child; unlike a socket session there is no state left behind, which is the ADR's stated
 * advantage of this path.
 */

/** Raised when Blender exits non-zero. Carries the real stderr, which is the diagnostic. */
export class BlenderError extends Error {
  readonly exitCode: number | null;
  readonly stderr: string;
  readonly stdout: string;
  readonly signal: NodeJS.Signals | null;

  constructor(
    message: string,
    details: {
      exitCode: number | null;
      stderr: string;
      stdout: string;
      signal: NodeJS.Signals | null;
    },
  ) {
    super(message);
    this.name = "BlenderError";
    this.exitCode = details.exitCode;
    this.stderr = details.stderr;
    this.stdout = details.stdout;
    this.signal = details.signal;
  }
}

/** Raised when the timeout expires. Distinct from `BlenderError`: nothing went wrong. */
export class BlenderTimeoutError extends Error {
  readonly timeoutMs: number;
  readonly stderr: string;

  constructor(message: string, timeoutMs: number, stderr: string) {
    super(message);
    this.name = "BlenderTimeoutError";
    this.timeoutMs = timeoutMs;
    this.stderr = stderr;
  }
}

/** Raised when the caller's AbortSignal fires. */
export class BlenderCancelledError extends Error {
  constructor(message = "Blender run was cancelled.") {
    super(message);
    this.name = "BlenderCancelledError";
  }
}

export interface RunBlenderOptions {
  /** Absolute path to the Blender executable. */
  readonly blenderPath: string;
  /** Absolute path of the generated Python script to run. */
  readonly scriptPath: string;
  /**
   * Skip the user's addons, preferences and startup file, so the run is reproducible on
   * any machine. Default true. Turning it off means a run can depend on state the caller
   * cannot see, which the provenance record then misrepresents.
   */
  readonly factoryStartup?: boolean | undefined;
  /** Wall-clock budget. Defaults to 10 minutes. */
  readonly timeoutMs?: number | undefined;
  /** Cancellation. On abort the child is killed and the promise rejects. */
  readonly signal?: AbortSignal | undefined;
  /**
   * Extra Blender arguments, appended after the standard ones.
   *
   * Deliberately a plain array of argv entries and never a string, so callers cannot
   * smuggle shell syntax in through it.
   */
  readonly extraArgs?: readonly string[] | undefined;
  /** Environment for the child. Defaults to the parent's. */
  readonly env?: Readonly<Record<string, string | undefined>> | undefined;
}

export interface BlenderRunResult {
  /** Always 0: a non-zero exit rejects rather than resolving. */
  readonly exitCode: 0;
  readonly stdout: string;
  readonly stderr: string;
  /** Parsed `KINEMA_REPORT_*` payload, or `null` when the script printed none. */
  readonly report: BlenderReport | null;
  /** Raw JSON text between the markers, kept for diagnostics when parsing fails. */
  readonly reportRaw: string | null;
  readonly elapsedMs: number;
  /** The argv actually used, recorded so provenance can reproduce the run. */
  readonly argv: readonly string[];
}

/**
 * Default timeout.
 *
 * Ten minutes. The ADR's spike rendered 480x360 in 5.3s, and a 320x240 test render takes
 * about the same; a legitimate Cycles render of a real scene can take minutes but not
 * tens of minutes. Past this the run is stuck, and holding a process open indefinitely
 * because we cannot tell "slow" from "hung" is the worse failure.
 */
export const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * Extract the JSON report from captured stdout.
 *
 * Anchored on the marker pair. Both halves must be present: a script killed mid-print
 * leaves a lone start marker, and treating the remaining text as a report would produce a
 * half-parsed object that looks authoritative.
 *
 * The LAST marker pair wins. Blender runs the script once, but a caller's own script may
 * have printed an earlier report (a multi-stage build), and the final one describes the
 * finished scene.
 */
export function parseReport(stdout: string): { report: BlenderReport | null; raw: string | null } {
  const endIndex = stdout.lastIndexOf(REPORT_END_MARKER);
  const startIndex = stdout.lastIndexOf(REPORT_START_MARKER, endIndex === -1 ? undefined : endIndex);

  if (startIndex === -1 || endIndex === -1 || endIndex < startIndex) {
    return { report: null, raw: null };
  }

  const raw = stdout.slice(startIndex + REPORT_START_MARKER.length, endIndex).trim();
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { report: null, raw };
    }
    return { report: parsed as BlenderReport, raw };
  } catch {
    // Malformed JSON is not fatal. The caller still gets exit code, stderr and the raw
    // text, which is enough to diagnose; throwing here would discard all of that.
    return { report: null, raw };
  }
}

/** Compose the error message from the only part of Blender output that diagnoses a crash. */
function describeFailure(exitCode: number | null, stderr: string): string {
  const lines = stderr.split(/\r?\n/).filter((line) => line.trim().length > 0);
  // Blender buries the useful traceback under progress bars and deprecation notices, so
  // the tail is what matters. Keeping the last 30 lines covers a Python traceback with
  // context while staying readable in a UI error panel.
  const tail = lines.slice(-30).join("\n");
  return `Blender exited with code ${String(exitCode)}.\n${tail}`;
}

/**
 * Run a generated script in a headless Blender and collect the result.
 *
 * Resolves only on exit code 0. Everything else — non-zero exit, timeout, abort — rejects
 * with a typed error, so a caller cannot accidentally treat a failed render as a success
 * by forgetting to check a field.
 *
 * ## `--python-exit-code 1` is not optional
 *
 * Blender's default behaviour is to print a Python traceback to **stderr and still exit
 * 0**. Verified directly on 5.1.0: a script containing nothing but
 * `raise RuntimeError(...)` produces `Blender quit` and exit code 0. That is a silent
 * failure mode with a very expensive shape — a rendering pipeline that reports success,
 * hands the caller a file path, and produces no file.
 *
 * `--python-exit-code 1` makes Blender exit 1 when the script raises, which is what lets
 * the exit-code check below mean anything. The alternative would be to sniff stderr for a
 * traceback, which is strictly worse: it guesses from prose what the exit status states
 * exactly, and it would misreport a script that legitimately *prints* a traceback.
 */
export async function runBlender(options: RunBlenderOptions): Promise<BlenderRunResult> {
  const {
    blenderPath,
    scriptPath,
    factoryStartup = true,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    signal,
    extraArgs = [],
    env,
  } = options;

  if (signal?.aborted) {
    throw new BlenderCancelledError();
  }

  // argv order matters: Blender processes these left to right, and `--python` must come
  // after the flags that configure the session it runs in.
  const argv: string[] = [blenderPath, "--background"];
  if (factoryStartup) argv.push("--factory-startup");
  // Without this, a script that raises still exits 0. See the note above: it is the
  // difference between a pipeline that notices a failed render and one that does not.
  argv.push("--python-exit-code", "1");
  argv.push("--python", scriptPath, ...extraArgs);

  const started = Date.now();

  return await new Promise<BlenderRunResult>((resolve, reject) => {
    const child = spawn(argv[0] ?? blenderPath, argv.slice(1), {
      // Never a shell. See the module comment.
      shell: false,
      windowsHide: true,
      // `env` is passed through wholesale rather than merged, so a caller can hand the
      // child a deliberately minimal environment. Blender needs HOME/APPDATA/TEMP and
      // little else, and a minimal env is the smallest blast radius for a generated
      // script that calls os.environ.
      ...(env !== undefined ? { env: env as NodeJS.ProcessEnv } : {}),
    });

    let stdout = "";
    let stderr = "";
    let settled = false;
    let timedOut = false;
    let cancelled = false;

    // Bounded capture. A runaway script printing in a loop would otherwise grow these
    // strings until the process dies of memory exhaustion — which is a crash caused by
    // our own buffering, not by Blender, and so is entirely avoidable.
    const MAX_CAPTURE_BYTES = 16 * 1024 * 1024;
    const append = (target: "stdout" | "stderr", chunk: Buffer): void => {
      if (target === "stdout") {
        if (stdout.length < MAX_CAPTURE_BYTES) stdout += chunk.toString("utf8");
      } else if (stderr.length < MAX_CAPTURE_BYTES) {
        stderr += chunk.toString("utf8");
      }
    };

    child.stdout?.on("data", (chunk: Buffer) => append("stdout", chunk));
    child.stderr?.on("data", (chunk: Buffer) => append("stderr", chunk));

    const cleanup = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    };

    const kill = (): void => {
      // SIGKILL rather than SIGTERM: Blender's own signal handling on Windows is minimal,
      // and a partially-completed render is exactly what we do not want to wait for. There
      // is no work here worth a graceful shutdown — no state is persisted by this path.
      child.kill("SIGKILL");
    };

    const onAbort = (): void => {
      if (settled) return;
      cancelled = true;
      kill();
    };

    const timer = setTimeout(() => {
      if (settled) return;
      timedOut = true;
      kill();
    }, timeoutMs);

    signal?.addEventListener("abort", onAbort, { once: true });

    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      // ENOENT here means the path was wrong or Blender was uninstalled between detection
      // and the run. Reported as a BlenderError so the caller has one failure type to
      // handle, with the OS message preserved.
      reject(
        new BlenderError(`Could not start Blender at "${blenderPath}": ${error.message}`, {
          exitCode: null,
          stderr,
          stdout,
          signal: null,
        }),
      );
    });

    child.on("close", (code, closeSignal) => {
      if (settled) return;
      settled = true;
      cleanup();

      const elapsedMs = Date.now() - started;

      if (cancelled) {
        reject(new BlenderCancelledError());
        return;
      }
      if (timedOut) {
        reject(
          new BlenderTimeoutError(
            `Blender did not finish within ${timeoutMs}ms and was killed.`,
            timeoutMs,
            stderr,
          ),
        );
        return;
      }
      if (code !== 0) {
        reject(
          new BlenderError(describeFailure(code, stderr), {
            exitCode: code,
            stderr,
            stdout,
            signal: closeSignal,
          }),
        );
        return;
      }

      const { report, raw } = parseReport(stdout);
      resolve({
        exitCode: 0,
        stdout,
        stderr,
        report,
        reportRaw: raw,
        elapsedMs,
        argv,
      });
    });
  });
}

/**
 * Does Blender's stderr contain a Python traceback rather than mere noise?
 *
 * Blender writes deprecation warnings (including the `Material.use_nodes` one this
 * integration deliberately triggers) and progress output to stderr while still exiting 0.
 * That is not a failure and must not be treated as one — but it is worth surfacing, so
 * this distinguishes the two for the warnings list.
 */
export function hasPythonTraceback(stderr: string): boolean {
  return /Traceback \(most recent call last\)/.test(stderr);
}

/** Environment variable names that configure this integration, documented in one place. */
export const ENV = {
  /** Explicit Blender executable. Beats every probe. */
  path: "BLENDER_PATH",
  /** Overrides the bundled Python used by the test-time image verification. */
  python: "KINEMA_PYTHON",
  /** Emitted by Blender itself; harmless, and useful for diagnostics. */
  nodeEnv: process.env["NODE_ENV"],
} as const;