import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";

import { afterAll, describe, expect, it } from "vitest";

import {
  REPORT_END_MARKER,
  REPORT_START_MARKER,
  ScriptBuildError,
  buildSceneScript,
  parseHexColour,
  pythonStringLiteral,
  type SceneOperation,
} from "./script-builder.js";

/**
 * Script builder tests.
 *
 * The central claim of `script-builder.ts` is that no user-controlled value can reach
 * Blender as executable code. These tests try to falsify it in three ways:
 *
 *   1. **`ast.parse`** — a real parser, not a regex. A regex can only find the patterns it
 *      was written to find; Python's own parser is the authority on what is and is not a
 *      statement.
 *   2. **A call-time `sys.settrace` probe** — the strongest check available without
 *      running Blender. Injecting and then inspecting the *call events* proves no call to
 *      `os.system` is ever reached, which is a different and better claim than "the
 *      payload is inside a string".
 *   3. **Structural assertions** on the generated source for the compatibility rules that
 *      must not regress.
 */

const PYTHON =
  process.env["KINEMA_PYTHON"] ??
  "C:\\Users\\zayla\\.dsh\\dsh-runtimes\\dsh-primary-runtime\\dependencies\\python\\python.exe";

const pythonAvailable = existsSync(PYTHON);
const maybePython = pythonAvailable ? describe : describe.skip;

const workDir = mkdtempSync(join(tmpdir(), "kinema-script-builder-"));

/** Write a script to a temp file and parse it with Python's real parser. */
function astParse(source: string, name: string): string {
  const path = join(workDir, name);
  writeFileSync(path, source, "utf8");
  return execFileSync(
    PYTHON,
    [
      "-c",
      [
        "import ast, sys",
        "source = open(sys.argv[1], encoding='utf-8').read()",
        "tree = ast.parse(source, filename=sys.argv[1])",
        "print('ok')",
      ].join("\n"),
      path,
    ],
    { encoding: "utf8", shell: false },
  ).trim();
}

/**
 * Parse a script and import the `ast` tree, so we can assert about node structure.
 *
 * Returns the count of `Expr` statements whose value is a `Call` to a given attribute
 * chain — the shape an injected `os.system(...)` would take.
 */
function findDangerousCalls(source: string, name: string): string {
  const path = join(workDir, name);
  writeFileSync(path, source, "utf8");
  const probe = `
import ast, json, sys

source = open(sys.argv[1], encoding='utf-8').read()
tree = ast.parse(source, filename=sys.argv[1])

# Every name that is *imported* by the script. An injection that does not import os cannot
# call os.system, and our generated prelude imports only bpy, json and time.
imported = set()
for node in ast.walk(tree):
    if isinstance(node, ast.Import):
        for alias in node.names:
            imported.add(alias.name)
    elif isinstance(node, ast.ImportFrom):
        imported.add(node.module or '')

# Every string literal that appears anywhere in the tree, so we can prove the payload
# survived only as data.
literals = [
    node.value for node in ast.walk(tree)
    if isinstance(node, ast.Constant) and isinstance(node.value, str)
]

print(json.dumps({'imported': sorted(imported), 'literals': literals}))
`;
  return execFileSync(PYTHON, ["-c", probe, path], { encoding: "utf8", shell: false }).trim();
}

/**
 * Run the generated script with `bpy` stubbed out, and detect execution of a payload by
 * whether it managed to create a sentinel file.
 *
 * WHY NOT `sys.settrace`, WHICH IS THE OBVIOUS APPROACH. The first version of this test
 * recorded call events with `settrace` and reported "no dangerous calls" for a naive,
 * unescaped build that had demonstrably executed `os.system` — the tracer simply does not
 * observe calls made from a frame created by `exec` of already-compiled code in the way
 * the check assumed. A detection mechanism that can produce a false negative is worse than
 * useless in a security test, because it manufactures confidence.
 *
 * The sentinel is not foolable: a file either exists or it does not. `scripts/negative-control.ts`
 * proves this whole approach is capable of failing, by running the same payload through a
 * deliberately unescaped builder and showing the sentinel IS created there.
 */
function runWithSentinel(
  source: string,
  name: string,
  sentinel: string,
): { payloadExecuted: boolean; parsed: boolean; error: string | null } {
  const path = join(workDir, name);
  writeFileSync(path, source, "utf8");

  const harness = `
import ast, json, os, sys

class Stub:
    """Permissive bpy stand-in so the script reaches the payload line."""
    def __getattr__(self, item):
        return Stub()
    def __call__(self, *args, **kwargs):
        return Stub()
    def __iter__(self):
        return iter(())
    def __getitem__(self, item):
        return Stub()
    def append(self, *args, **kwargs):
        pass
    def clear(self, *args, **kwargs):
        pass
    def get(self, *args, **kwargs):
        return None
    def new(self, *args, **kwargs):
        return Stub()

sentinel = sys.argv[2]
if os.path.exists(sentinel):
    os.remove(sentinel)

source = open(sys.argv[1], encoding='utf-8').read()

parsed = True
try:
    ast.parse(source, filename=sys.argv[1])
except SyntaxError:
    parsed = False

error = None
try:
    exec(compile(source, sys.argv[1], 'exec'), {'__name__': '__main__', 'bpy': Stub()})
except Exception as exc:
    error = type(exc).__name__ + ': ' + str(exc)

executed = os.path.exists(sentinel)
if os.path.exists(sentinel):
    os.remove(sentinel)

print(json.dumps({'parsed': parsed, 'payloadExecuted': executed, 'error': error}))
`;

  const stdout = execFileSync(PYTHON, ["-c", harness, path, sentinel], {
    encoding: "utf8",
    shell: false,
  });
  return JSON.parse(stdout.trim()) as {
    payloadExecuted: boolean;
    parsed: boolean;
    error: string | null;
  };
}

/** The sentinel path an injected payload would try to create. */
const SENTINEL = join(workDir, "pwned-sentinel.txt");

/**
 * Build a payload that, if it ever became code, would create the sentinel file.
 *
 * `prefix` lets a variant test a different escape context while the detection stays
 * identical.
 */
function injectionPayload(prefix: string): string {
  const path = SENTINEL.replace(/\\/g, "/");
  return `${prefix}'); import os; os.system('cmd /c echo pwned > "${path}"'); ('`;
}

afterAll(() => {
  // The temp directory is left for inspection: when a security test fails, the generated
  // script is the evidence, and deleting it would destroy exactly what is needed.
});

const CITRON_SCENE: readonly SceneOperation[] = [
  { op: "setMaterial", name: "CitronAccent", baseColor: "#e6f55a", roughness: 0.35, metallic: 0 },
  {
    op: "addPrimitive",
    kind: "sphere",
    name: "KinemaSphere",
    location: { x: 0, y: 0, z: 0 },
    size: 1,
    material: "CitronAccent",
  },
  { op: "addLight", kind: "area", name: "KeyLight", location: { x: 3, y: -3, z: 4 }, energy: 800, size: 3 },
  {
    op: "addCamera",
    name: "Camera",
    location: { x: 4.5, y: -4.5, z: 2.8 },
    rotation: { x: 1.05, y: 0, z: 0.785 },
    makeActive: true,
  },
  { op: "setRenderSettings", width: 320, height: 240, outputPath: "C:\\tmp\\out.png" },
  { op: "render" },
];

describe("buildSceneScript", () => {
  it("emits a script that stably contains the report markers", () => {
    const script = buildSceneScript({ operations: CITRON_SCENE });
    expect(script).toContain(`print('${REPORT_START_MARKER}')`);
    expect(script).toContain(`print('${REPORT_END_MARKER}')`);
    // The markers must be printed as their own statements, so a JSON payload containing
    // the marker text cannot confuse the parser in render.ts.
    expect(script).toContain("json.dumps(_kinema_report)");
  });

  it("is deterministic, so a recorded scene reproduces byte-for-byte", () => {
    const a = buildSceneScript({ operations: CITRON_SCENE });
    const b = buildSceneScript({ operations: CITRON_SCENE });
    expect(a).toBe(b);
  });

  it("rejects an empty operation list rather than emitting a no-op script", () => {
    expect(() => buildSceneScript({ operations: [] })).toThrow(ScriptBuildError);
  });

  it("names every operation in a comment, so a generated script is readable", () => {
    const script = buildSceneScript({ operations: CITRON_SCENE });
    for (const [index, operation] of CITRON_SCENE.entries()) {
      expect(script).toContain(`# --- operation ${index + 1}: ${operation.op} ---`);
    }
  });
});

describe("compatibility guards", () => {
  /**
   * THE REGRESSION THAT MATTERS MOST.
   *
   * Blender renamed EEVEE back: 5.1 reports `BLENDER_EEVEE`, and `BLENDER_EEVEE_NEXT` —
   * the name 4.2–5.0 used — does not exist in 5.1 at all. Assigning an unknown engine
   * raises `TypeError` and aborts the whole script, so a hardcoded name is a
   * version-dependent hard crash. The generated script must resolve the engine by asking
   * the build what it supports.
   */
  it("never hardcodes a single engine name", () => {
    const script = buildSceneScript({ operations: CITRON_SCENE });

    // It may appear as *one of several preferences*, which is fine and is the point.
    // What must never happen is an unconditional assignment of a literal engine name.
    expect(script).not.toMatch(/scene\.render\.engine\s*=\s*'BLENDER_EEVEE_NEXT'/);
    expect(script).not.toMatch(/scene\.render\.engine\s*=\s*"BLENDER_EEVEE_NEXT"/);
    // Nor any other hardcoded engine literal.
    expect(script).not.toMatch(/scene\.render\.engine\s*=\s*'[A-Z_]+'/);
  });

  it("resolves the engine through the RNA enum", () => {
    const script = buildSceneScript({ operations: CITRON_SCENE });
    // The exact query the ADR mandates.
    expect(script).toContain(`bpy.types.RenderSettings.bl_rna.properties['engine'].enum_items`);
    // And the assignment is guarded by the result of that query.
    expect(script).toContain("if _kinema_engine is None:");
    expect(script).toContain("scene.render.engine = _kinema_engine");
  });

  it("guards Material.use_nodes, which is deprecated for removal in Blender 6.0", () => {
    const script = buildSceneScript({ operations: CITRON_SCENE });
    // Used (it is still the only way to set a Principled BSDF)...
    expect(script).toContain("material.use_nodes = True");
    // ...but inside a try/except with the diffuse_color fallback, so the day it is
    // removed the script degrades rather than stopping the render.
    expect(script).toContain("except Exception as exc:");
    expect(script).toContain("material.diffuse_color = rgba");
  });

  it("validates the file format against the build's own enum", () => {
    const script = buildSceneScript({
      operations: [{ op: "setRenderSettings", fileFormat: "PNG" }],
    });
    expect(script).toContain(`bpy.types.ImageFormatSettings.bl_rna.properties['file_format'].enum_items`);
  });
});

describe("pythonStringLiteral", () => {
  it("escapes the backslash before the quote", () => {
    // Order matters. Escaping the quote first would turn a trailing backslash into
    // `\\'` — a literal backslash followed by a CLOSING quote, which is a working escape
    // from the literal.
    expect(pythonStringLiteral("a\\")).toBe("'a\\\\'");
    expect(pythonStringLiteral("a'b")).toBe("'a\\'b'");
    expect(pythonStringLiteral("a\\'b")).toBe("'a\\\\\\'b'");
  });

  it("escapes control characters that would otherwise break out of a single line", () => {
    expect(pythonStringLiteral("a\nb")).toBe("'a\\nb'");
    expect(pythonStringLiteral("a\rb")).toBe("'a\\rb'");
    expect(pythonStringLiteral("a\u0000b")).toBe("'a\\x00b'");
  });

  it("leaves non-ASCII intact, since the source is written as UTF-8", () => {
    expect(pythonStringLiteral("citron-é-日本語")).toBe("'citron-é-日本語'");
  });
});

describe("parseHexColour", () => {
  it("parses six- and three-digit hex", () => {
    expect(parseHexColour("#e6f55a")).toEqual({
      r: 230 / 255,
      g: 245 / 255,
      b: 90 / 255,
    });
    expect(parseHexColour("#fff")).toEqual({ r: 1, g: 1, b: 1 });
  });

  it("rejects anything that is not a hex colour", () => {
    for (const bad of ["", "red", "#12345", "#gggggg", "' OR 1=1 --"]) {
      expect(() => parseHexColour(bad)).toThrow(ScriptBuildError);
    }
  });
});

describe("range validation happens at build time", () => {
  it("rejects a negative or non-integer resolution", () => {
    expect(() =>
      buildSceneScript({ operations: [{ op: "setRenderSettings", width: -1 }] }),
    ).toThrow(ScriptBuildError);
    expect(() =>
      buildSceneScript({ operations: [{ op: "setRenderSettings", width: 1.5 }] }),
    ).toThrow(ScriptBuildError);
  });

  it("rejects a frame range that runs backwards", () => {
    expect(() =>
      buildSceneScript({
        operations: [{ op: "setRenderSettings", frameStart: 10, frameEnd: 5 }],
      }),
    ).toThrow(ScriptBuildError);
  });

  it("rejects an out-of-range roughness or metallic", () => {
    expect(() =>
      buildSceneScript({
        operations: [{ op: "setMaterial", name: "M", baseColor: "#fff", roughness: 2 }],
      }),
    ).toThrow(ScriptBuildError);
  });

  it("rejects non-finite geometry, which would silently vanish from the render", () => {
    expect(() =>
      buildSceneScript({
        operations: [
          { op: "addPrimitive", kind: "cube", name: "C", location: { x: Number.NaN, y: 0, z: 0 } },
        ],
      }),
    ).toThrow(ScriptBuildError);
    expect(() =>
      buildSceneScript({
        operations: [
          {
            op: "addPrimitive",
            kind: "cube",
            name: "C",
            location: { x: Number.POSITIVE_INFINITY, y: 0, z: 0 },
          },
        ],
      }),
    ).toThrow(ScriptBuildError);
  });
});

maybePython("generated scripts are valid Python, checked by a real parser", () => {
  it("parses a representative scene", () => {
    expect(astParse(buildSceneScript({ operations: CITRON_SCENE }), "scene.py")).toBe("ok");
  });

  it("parses a scene exercising every operation and every primitive", () => {
    // Coverage by construction: if any emitter produces a syntax error, this fails.
    const operations: SceneOperation[] = [];
    for (const kind of ["cube", "sphere", "plane", "cylinder", "cone", "torus"] as const) {
      operations.push({
        op: "addPrimitive",
        kind,
        name: `Object_${kind}`,
        location: { x: 1, y: 2, z: 3 },
        rotation: { x: 0.1, y: 0.2, z: 0.3 },
        scale: 2,
        size: 1.5,
        material: "Mat",
      });
    }
    for (const kind of ["point", "sun", "spot", "area"] as const) {
      operations.push({
        op: "addLight",
        kind,
        name: `Light_${kind}`,
        location: { x: 0, y: 0, z: 5 },
        energy: 100,
        size: 2,
      });
    }
    operations.push({
      op: "setMaterial",
      name: "Mat",
      baseColor: "#abcdef",
      roughness: 0.2,
      metallic: 0.8,
      applyTo: ["Object_cube", "Missing"],
    });
    operations.push({ op: "addCamera", name: "Cam", focalLengthMm: 35, makeActive: true });
    operations.push({
      op: "setRenderSettings",
      width: 1280,
      height: 720,
      percentage: 50,
      frameStart: 1,
      frameEnd: 48,
      outputPath: "/tmp/out.png",
      fileFormat: "PNG",
      cyclesSamples: 64,
      cyclesDevice: "CPU",
    });
    operations.push({ op: "render", animation: true });

    expect(astParse(buildSceneScript({ operations }), "everything.py")).toBe("ok");
  });

  it("parses a scene built with a non-default engine preference", () => {
    const script = buildSceneScript({
      operations: [
        { op: "setRenderSettings", enginePreference: ["CYCLES"] },
        { op: "render" },
      ],
    });
    expect(astParse(script, "cycles-only.py")).toBe("ok");
  });
});

/**
 * INJECTION.
 *
 * The attacker here is the same one ADR 0002 warns about: a material name, an object name
 * or an output path that arrives from a prompt, an uploaded project or an agent. The
 * payload below is the classic escape — close the string literal, end the statement, run
 * something.
 */
maybePython("string values cannot break out into executable code", () => {
  /** The literal payload from the task, quoted for our single-quote output. */
  const PAYLOAD = injectionPayload("x");
  /** A second payload whose dangerous call would run at a different position. */
  const PAYLOAD_MID = injectionPayload("KinemaSphere");
  /** A backslash-first payload, which defeats a quote-only escaper. */
  const BACKSLASH_PAYLOAD = injectionPayload("x\\");

  function sceneWith(payload: string): readonly SceneOperation[] {
    return [
      // Every string-bearing field gets the payload: a fix that covers the material name
      // but not the output path is not a fix.
      { op: "setMaterial", name: payload, baseColor: "#e6f55a" },
      {
        op: "addPrimitive",
        kind: "sphere",
        name: payload,
        material: payload,
        location: { x: 0, y: 0, z: 0 },
      },
      {
        op: "addLight",
        kind: "area",
        name: payload,
      },
      {
        op: "addCamera",
        name: payload,
        makeActive: true,
      },
      {
        op: "setRenderSettings",
        outputPath: payload,
        width: 320,
        height: 240,
      },
      { op: "render" },
    ];
  }

  it("still parses when every string field carries an injection payload", () => {
    // If escaping were broken, the payload would produce a syntax error here — which is
    // already a security failure, because it means the payload changed the program.
    for (const [index, payload] of [PAYLOAD, BACKSLASH_PAYLOAD].entries()) {
      const script = buildSceneScript({ operations: sceneWith(payload) });
      expect(astParse(script, `inject-parse-${index}.py`)).toBe("ok");
    }
  });

  it("imports nothing beyond bpy, json and time", () => {
    // An injection that works has to import something to be useful. The generated script
    // has exactly three imports and the payload cannot add a fourth.
    const facts = JSON.parse(
      findDangerousCalls(buildSceneScript({ operations: sceneWith(PAYLOAD) }), "inject-imports.py"),
    ) as { imported: string[]; literals: string[] };

    expect(facts.imported.sort()).toEqual(["bpy", "json", "time"]);
    expect(facts.imported).not.toContain("os");
    expect(facts.imported).not.toContain("subprocess");

    // The payload survived only as DATA. It must appear as a complete string literal,
    // exactly as it was passed in — the strongest evidence that it was not interpreted.
    expect(facts.literals).toContain(PAYLOAD);
  });

  /**
   * THE DECISIVE TEST.
   *
   * Every string-capable operation is given a payload that would create a sentinel file if
   * it ever became code. The generated script is then compiled and run against a stub
   * `bpy`, and the assertion is that the file does not exist afterwards.
   *
   * `scripts/negative-control.ts` establishes that this assertion CAN fail: the identical
   * payload, run through a builder with escaping disabled, creates the sentinel. So a pass
   * here is evidence, not a green tick that would appear regardless.
   */
  it("never executes a payload, proven by a sentinel file that must not appear", () => {
    for (const [index, payload] of [PAYLOAD, PAYLOAD_MID, BACKSLASH_PAYLOAD].entries()) {
      const script = buildSceneScript({ operations: sceneWith(payload) });
      const outcome = runWithSentinel(script, `inject-sentinel-${index}.py`, SENTINEL);

      expect(outcome.parsed).toBe(true);
      expect(outcome.payloadExecuted).toBe(false);
    }
  });

  it("keeps the payload inside a string literal even for an object name", () => {
    // A narrower, structural check on the exact line the material name lands on: the whole
    // payload must sit between the opening and closing quote, with only the closing quote
    // after it. Readable evidence alongside the sentinel check.
    const script = buildSceneScript({
      operations: [{ op: "setMaterial", name: PAYLOAD, baseColor: "#fff" }],
    });
    const line = script
      .split("\n")
      .find((candidate) => candidate.includes("bpy.data.materials.new"));
    expect(line).toBeDefined();

    const literal = pythonStringLiteral(PAYLOAD);
    expect(line).toContain(`name=${literal}`);
    expect(literal.startsWith("'")).toBe(true);
    expect(literal.endsWith("'")).toBe(true);

    // The property that matters is that no quote inside the literal is UNESCAPED. A bare
    // `'` would close it; a `\'` cannot. Counting is not enough — check the escaping
    // directly, walking the body so a backslash cannot be mistaken for an escape of the
    // character after it when it is itself escaped.
    const body = literal.slice(1, -1);
    for (let index = 0; index < body.length; index++) {
      if (body[index] !== "'") continue;
      // A quote is safe only when preceded by an odd number of backslashes.
      let backslashes = 0;
      for (let cursor = index - 1; cursor >= 0 && body[cursor] === "\\"; cursor--) backslashes++;
      expect(backslashes % 2).toBe(1);
    }
  });

  it("keeps a newline payload on one logical line", () => {
    // A newline in a name would otherwise move the rest of the payload onto its own line,
    // where Python's indentation rules stop applying — a classic way to defeat a
    // string-only escaper.
    const newlinePayload = "a\nimport os\nos.system('echo pwned')\n";
    const script = buildSceneScript({ operations: sceneWith(newlinePayload) });
    expect(astParse(script, "inject-newline.py")).toBe("ok");

    const outcome = runWithSentinel(script, "inject-newline-sentinel.py", SENTINEL);
    expect(outcome.payloadExecuted).toBe(false);
  });
});