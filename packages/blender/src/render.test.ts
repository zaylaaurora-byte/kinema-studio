import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";

import { describe, expect, it } from "vitest";

import { detectBlender } from "./detect.js";
import {
  BlenderCancelledError,
  BlenderError,
  BlenderTimeoutError,
  DEFAULT_TIMEOUT_MS,
  hasPythonTraceback,
  parseReport,
  runBlender,
} from "./render.js";
import { buildSceneScript, type SceneOperation } from "./script-builder.js";

/**
 * Render tests.
 *
 * These drive REAL Blender. That is the point: a renderer that has only ever been tested
 * against mocks is a renderer whose failure mode — a blank frame, a missing file, a
 * silently-wrong engine — is discovered by the user.
 *
 * The suite SKIPS when Blender is absent, so CI without it stays green, and the skip is
 * visible in the report rather than hidden. Where Blender is present, every assertion runs
 * for real. The render is deliberately 320x240: ADR 0002 measured a 480x360 build+render
 * at ~2.4s of Blender time, and this suite keeps to the same order so it stays runnable in
 * a normal development loop.
 */

const PYTHON =
  process.env["KINEMA_PYTHON"] ??
  "C:\\Users\\zayla\\.dsh\\dsh-runtimes\\dsh-primary-runtime\\dependencies\\python\\python.exe";

const detection = await detectBlender();
const blenderPath = detection.install?.supported === true ? detection.install.path : null;
const pythonAvailable = existsSync(PYTHON);

/** Live-Bender tests only run when a supported Blender is actually installed. */
const maybeBlender = blenderPath !== null ? describe : describe.skip;
/** The image decode needs Pillow; skipped separately so a missing Pillow is visible. */
const maybeDecode = blenderPath !== null && pythonAvailable ? describe : describe.skip;

const workDir = mkdtempSync(join(tmpdir(), "kinema-render-"));

if (blenderPath !== null) {
  console.log(`[blender tests] using ${blenderPath} (${detection.install?.version ?? "?"})`);
} else {
  console.log("[blender tests] no supported Blender found; live tests will SKIP");
}

/** Write a generated script and return its path. */
function writeScript(source: string, name: string): string {
  const path = join(workDir, name);
  writeFileSync(path, source, "utf8");
  return path;
}

/** The scene the ADR's spike used, as typed operations. */
function citronScene(outputPath: string): readonly SceneOperation[] {
  return [
    { op: "setMaterial", name: "CitronAccent", baseColor: "#e6f55a", roughness: 0.35, metallic: 0 },
    {
      op: "addPrimitive",
      kind: "sphere",
      name: "KinemaSphere",
      location: { x: 0, y: 0, z: 0 },
      size: 1,
      material: "CitronAccent",
    },
    {
      op: "addPrimitive",
      kind: "plane",
      name: "KinemaGround",
      location: { x: 0, y: 0, z: -1.2 },
      size: 10,
    },
    { op: "addLight", kind: "area", name: "KeyLight", location: { x: 3, y: -3, z: 4 }, energy: 800, size: 3 },
    {
      op: "addCamera",
      name: "KinemaCamera",
      location: { x: 4.5, y: -4.5, z: 2.8 },
      rotation: { x: 1.05, y: 0, z: 0.785 },
      focalLengthMm: 50,
      makeActive: true,
    },
    {
      op: "setRenderSettings",
      width: 320,
      height: 240,
      outputPath,
      fileFormat: "PNG",
      cyclesSamples: 16,
    },
    { op: "render" },
  ];
}

/** Decode a PNG with Pillow and report the statistics that distinguish real content. */
function decodePng(path: string): {
  width: number;
  height: number;
  mode: string;
  std: number;
  uniqueColours: number;
  mean: number[];
} {
  const probe = `
import json, sys
from PIL import Image
import numpy as np

with Image.open(sys.argv[1]) as im:
    im.load()
    width, height, mode = im.width, im.height, im.mode
    arr = np.array(im.convert('RGB'))

print(json.dumps({
    'width': width,
    'height': height,
    'mode': mode,
    'std': float(arr.std()),
    'uniqueColours': int(len(np.unique(arr.reshape(-1, 3), axis=0))),
    'mean': [float(x) for x in arr.reshape(-1, 3).mean(axis=0)],
}))
`;
  return JSON.parse(
    execFileSync(PYTHON, ["-c", probe, path], { encoding: "utf8", shell: false }).trim(),
  ) as { width: number; height: number; mode: string; std: number; uniqueColours: number; mean: number[] };
}

// ---------------------------------------------------------------------------
// Pure parsing — runs everywhere
// ---------------------------------------------------------------------------

describe("parseReport", () => {
  it("reads the JSON between the markers", () => {
    const stdout = [
      "Blender 5.1.0",
      "Fra:1 Mem:12.3M",
      "KINEMA_REPORT_START",
      '{"objects": ["A", "B"], "engine": "BLENDER_EEVEE"}',
      "KINEMA_REPORT_END",
      "Blender quit",
    ].join("\n");

    const { report } = parseReport(stdout);
    expect(report?.objects).toEqual(["A", "B"]);
    expect(report?.engine).toBe("BLENDER_EEVEE");
  });

  it("returns null when only one marker is present", () => {
    // A script killed mid-print leaves a lone start marker. Treating the remaining text as
    // a report would produce a half-parsed object that looks authoritative.
    expect(parseReport("KINEMA_REPORT_START\n{}").report).toBeNull();
    expect(parseReport("KINEMA_REPORT_END").report).toBeNull();
    expect(parseReport("no markers here").report).toBeNull();
  });

  it("returns null for malformed JSON but keeps the raw text for diagnosis", () => {
    const { report, raw } = parseReport("KINEMA_REPORT_START\n{not json}\nKINEMA_REPORT_END");
    expect(report).toBeNull();
    expect(raw).toBe("{not json}");
  });

  it("rejects a JSON array, which is not the report shape", () => {
    expect(parseReport("KINEMA_REPORT_START\n[1,2,3]\nKINEMA_REPORT_END").report).toBeNull();
  });

  it("takes the last report when a script printed several", () => {
    const stdout = [
      "KINEMA_REPORT_START",
      '{"engine": "first"}',
      "KINEMA_REPORT_END",
      "KINEMA_REPORT_START",
      '{"engine": "last"}',
      "KINEMA_REPORT_END",
    ].join("\n");
    expect(parseReport(stdout).report?.engine).toBe("last");
  });
});

describe("hasPythonTraceback", () => {
  it("distinguishes a traceback from ordinary Blender stderr noise", () => {
    // Blender writes deprecation warnings and progress to stderr while exiting 0. Calling
    // that a failure would make every successful run look broken.
    expect(hasPythonTraceback("DeprecationWarning: 'Material.use_nodes' is expected to be removed in Blender 6.0")).toBe(false);
    expect(hasPythonTraceback("Fra:1 Mem:12.3M | Time:00:00.01")).toBe(false);
    expect(
      hasPythonTraceback("Traceback (most recent call last):\n  File \"x.py\", line 3\nTypeError: bad"),
    ).toBe(true);
  });

  it("defaults the timeout to something finite, so a runaway render cannot hang forever", () => {
    expect(DEFAULT_TIMEOUT_MS).toBeGreaterThan(0);
    expect(Number.isFinite(DEFAULT_TIMEOUT_MS)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Failure paths — need Blender, but not a render
// ---------------------------------------------------------------------------

maybeBlender("runBlender failure handling", () => {
  it("reports the real stderr when Blender exits non-zero", async () => {
    // A genuine Python error inside Blender. The traceback is the only useful diagnostic,
    // so it must survive into the error rather than being replaced by a generic message.
    const script = writeScript(
      ["raise RuntimeError('kinema-deliberate-failure')"].join("\n"),
      "failing.py",
    );

    const path = blenderPath;
    if (path === null) throw new Error("unreachable");

    let caught: unknown = null;
    try {
      await runBlender({ blenderPath: path, scriptPath: script, timeoutMs: 60_000 });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(BlenderError);
    const failure = caught as BlenderError;
    expect(failure.exitCode).not.toBe(0);
    // The actual message from Blender's traceback, not a generic substitute.
    expect(failure.stderr).toContain("kinema-deliberate-failure");
    expect(failure.message).toContain("kinema-deliberate-failure");
    expect(hasPythonTraceback(failure.stderr)).toBe(true);
  }, 90_000);

  it("reports a missing executable rather than hanging", async () => {
    const script = writeScript("import bpy\n", "noop.py");
    let caught: unknown = null;
    try {
      await runBlender({
        blenderPath: join(workDir, "definitely-not-blender.exe"),
        scriptPath: script,
        timeoutMs: 15_000,
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(BlenderError);
    expect((caught as BlenderError).message).toMatch(/Could not start Blender/);
  }, 30_000);

  it("kills a runaway script on timeout and reports a timeout, not a hang", async () => {
    // The real hazard: a generated script with an accidental infinite loop, or a render of
    // a scene far heavier than intended. Without a timeout the application waits forever.
    const script = writeScript(
      [
        "import time",
        "while True:",
        "    time.sleep(0.05)",
      ].join("\n"),
      "runaway.py",
    );

    const path = blenderPath;
    if (path === null) throw new Error("unreachable");

    const started = Date.now();
    let caught: unknown = null;
    try {
      await runBlender({ blenderPath: path, scriptPath: script, timeoutMs: 3_000 });
    } catch (error) {
      caught = error;
    }
    const elapsed = Date.now() - started;

    expect(caught).toBeInstanceOf(BlenderTimeoutError);
    const timeout = caught as BlenderTimeoutError;
    expect(timeout.timeoutMs).toBe(3_000);
    expect(timeout.message).toMatch(/did not finish within 3000ms/);

    // It must actually have been killed, not merely reported. Blender's own startup takes
    // a few seconds, so anything far past the budget means the kill did not take.
    expect(elapsed).toBeLessThan(30_000);
  }, 60_000);

  it("rejects immediately when the signal is already aborted", async () => {
    const script = writeScript("import time\ntime.sleep(30)\n", "pre-aborted.py");
    const controller = new AbortController();
    controller.abort();

    await expect(
      runBlender({
        blenderPath: blenderPath ?? "blender",
        scriptPath: script,
        signal: controller.signal,
      }),
    ).rejects.toBeInstanceOf(BlenderCancelledError);
  }, 15_000);
});

// ---------------------------------------------------------------------------
// Cancellation — needs a run long enough to interrupt
// ---------------------------------------------------------------------------

maybeBlender("cancellation", () => {
  it("kills a mid-render Blender and leaves no process behind", async () => {
    // A scene heavy enough that the render cannot finish before we abort. Cycles on CPU at
    // a high sample count is reliably slow, and the abort lands while Blender is working
    // rather than during startup.
    const outputPath = join(workDir, "cancelled.png");
    const operations: SceneOperation[] = [
      ...citronScene(outputPath).filter((operation) => operation.op !== "render"),
      {
        op: "setRenderSettings",
        width: 640,
        height: 480,
        outputPath,
        fileFormat: "PNG",
        enginePreference: ["CYCLES"],
        cyclesSamples: 4096,
        cyclesDevice: "CPU",
      },
      { op: "render" },
    ];

    const script = writeScript(buildSceneScript({ operations }), "cancel-me.py");
    const controller = new AbortController();
    // Long enough that Blender has definitely started work, short enough to keep the suite
    // quick. Blender's own cold start is ~2-4s on this machine.
    const abortAfterMs = 5_000;

    const timer = setTimeout(() => controller.abort(), abortAfterMs);
    const started = Date.now();

    let caught: unknown = null;
    try {
      await runBlender({
        blenderPath: blenderPath ?? "blender",
        scriptPath: script,
        signal: controller.signal,
        timeoutMs: 180_000,
      });
    } catch (error) {
      caught = error;
    }
    clearTimeout(timer);
    const elapsed = Date.now() - started;

    expect(caught).toBeInstanceOf(BlenderCancelledError);
    // Cancellation must be prompt: the whole point over the socket path, where the ADR
    // notes there is "no clean cancellation".
    expect(elapsed).toBeLessThan(abortAfterMs + 20_000);

    // No partial output: a cancelled render must not leave a file that a downstream step
    // could mistake for a finished one.
    expect(existsSync(outputPath)).toBe(false);
  }, 240_000);
});

// ---------------------------------------------------------------------------
// THE KEY TEST — a real render
// ---------------------------------------------------------------------------

maybeDecode("a real Blender render produces a real image", () => {
  it("builds the scene, renders a PNG, and the image has actual content", async () => {
    const outputPath = join(workDir, "real-render.png");
    const script = writeScript(
      buildSceneScript({ operations: citronScene(outputPath) }),
      "real-render.py",
    );

    const path = blenderPath;
    if (path === null) throw new Error("unreachable");

    const result = await runBlender({ blenderPath: path, scriptPath: script, timeoutMs: 180_000 });

    // 1. The process exited 0. runBlender only resolves on 0, but assert it explicitly so
    //    a future change that resolves on failure is caught here.
    expect(result.exitCode).toBe(0);

    console.log(
      `[real render] blender ${result.elapsedMs}ms, engine ${result.report?.engine ?? "?"}, ` +
        `resolution ${JSON.stringify(result.report?.resolution ?? null)}`,
    );

    // 2. The output file exists and is a valid PNG — checked by its signature, which is a
    //    byte-level fact, not an extension we chose ourselves.
    expect(existsSync(outputPath)).toBe(true);
    const bytes = readFileSync(outputPath);
    expect(bytes.length).toBeGreaterThan(1000);
    const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    expect(bytes.subarray(0, 8).equals(PNG_SIGNATURE)).toBe(true);

    // 3. The parsed report names the objects we asked for. This is the machine-readable
    //    report doing its job: no scraping of Blender's prose.
    expect(result.report).not.toBeNull();
    const objects = result.report?.objects ?? [];
    expect(objects).toContain("KinemaSphere");
    expect(objects).toContain("KinemaGround");
    expect(objects).toContain("KeyLight");
    expect(objects).toContain("KinemaCamera");
    // Exactly the objects we built: the factory startup cube must not be present, because
    // the script starts from an empty scene.
    expect(objects).toHaveLength(4);
    expect(objects).not.toContain("Cube");
    expect(result.report?.materials).toContain("CitronAccent");
    expect(result.report?.camera).toBe("KinemaCamera");
    expect(result.report?.render).toBe("ok");
    expect(result.report?.resolution).toEqual([320, 240]);

    // The generated script's own self-check must have found nothing wrong. A non-empty
    // warnings list here means a covered identifier silently misbehaved.
    expect(result.report?.warnings).toEqual([]);

    // 4. THE IMAGE IS NOT BLANK. Decoded by Pillow — a completely independent decoder —
    //    and judged by pixel variance. A file that exists but is a uniform grey would pass
    //    every check above and still be a failure.
    const stats = decodePng(outputPath);
    console.log(
      `[real render] decoded ${stats.width}x${stats.height} ${stats.mode}, ` +
        `std ${stats.std.toFixed(2)}, ${stats.uniqueColours} unique colours, ` +
        `mean ${stats.mean.map((v) => v.toFixed(1)).join("/")}`,
    );

    expect(stats.width).toBe(320);
    expect(stats.height).toBe(240);
    // A blank frame has std ~0 and 1 unique colour. The ADR's spike measured std 71.5 with
    // 1898 unique colours at 480x360; a threshold of 5 is far below any real render and far
    // above a blank one, so it cannot pass by accident and does not flake on a real image.
    expect(stats.std).toBeGreaterThan(5);
    expect(stats.uniqueColours).toBeGreaterThan(50);
  }, 240_000);

  it("selects an engine this Blender build actually contains", async () => {
    // Acceptance, alongside the structural assertion in script-builder.test.ts: the
    // script does not hardcode an engine, and the engine that comes back must be one the
    // build reports. On Blender 5.1 that is BLENDER_EEVEE, never BLENDER_EEVEE_NEXT.
    const outputPath = join(workDir, "engine-check.png");
    const script = writeScript(
      buildSceneScript({ operations: citronScene(outputPath) }),
      "engine-check.py",
    );

    const path = blenderPath;
    if (path === null) throw new Error("unreachable");
    const result = await runBlender({ blenderPath: path, scriptPath: script, timeoutMs: 180_000 });

    const engine = result.report?.engine ?? "";
    expect(["BLENDER_EEVEE", "BLENDER_EEVEE_NEXT", "CYCLES"]).toContain(engine);

    // The compatibility fix, stated as a fact about the selected engine: on a build that
    // does not expose BLENDER_EEVEE_NEXT, it must not be the engine that got selected.
    const available = execFileSync(
      path,
      [
        "--background",
        "--factory-startup",
        "--python-expr",
        "import bpy; print('KINEMA_ENGINES=' + ','.join(i.identifier for i in bpy.types.RenderSettings.bl_rna.properties['engine'].enum_items))",
      ],
      { encoding: "utf8", shell: false, maxBuffer: 8 * 1024 * 1024 },
    );
    const match = /KINEMA_ENGINES=([^\r\n]*)/.exec(available);
    expect(match).not.toBeNull();
    const engines = (match?.[1] ?? "").split(",").filter((name) => name.length > 0);
    console.log(`[engine check] this build reports: ${engines.join(", ")}`);

    // The engine chosen must be one of the identifiers the build itself lists. This is the
    // assertion that would have caught the BLENDER_EEVEE_NEXT hardcoding.
    expect(engines).toContain(engine);
  }, 240_000);

  it("renders reproducibly: the same scene twice gives identical geometry in the report", async () => {
    // Reproducibility is what `--factory-startup` buys, and what the provenance record
    // promises. Objects and resolution must match exactly; the PNG bytes are allowed to
    // differ only if the engine's sampling is non-deterministic, which is why the
    // assertion is on the report rather than on a hash.
    const first: string[] = [];
    const second: string[] = [];

    for (const [index, sink] of [first, second].entries()) {
      const outputPath = join(workDir, `repro-${index}.png`);
      const script = writeScript(
        buildSceneScript({ operations: citronScene(outputPath) }),
        `repro-${index}.py`,
      );
      const path = blenderPath;
      if (path === null) throw new Error("unreachable");
      const result = await runBlender({ blenderPath: path, scriptPath: script, timeoutMs: 180_000 });
      sink.push(...(result.report?.objects ?? []));
      sink.push(result.report?.engine ?? "", JSON.stringify(result.report?.resolution ?? null));
    }

    expect(first).toEqual(second);
  }, 300_000);
});