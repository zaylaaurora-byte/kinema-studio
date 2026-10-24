/**
 * Ad-hoc check: generate a scene script and hand it to Python's real parser.
 *
 * Run:
 *   node --experimental-strip-types packages/blender/scripts/parse-check.ts
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildSceneScript } from "../src/script-builder.ts";

const PYTHON =
  process.env["KINEMA_PYTHON"] ??
  "C:\\Users\\zayla\\.dsh\\dsh-runtimes\\dsh-primary-runtime\\dependencies\\python\\python.exe";

const script = buildSceneScript({
  operations: [
    {
      op: "addPrimitive",
      kind: "sphere",
      name: "KinemaSphere",
      location: { x: 0, y: 0, z: 0 },
      size: 1,
      material: "CitronAccent",
    },
    {
      op: "setMaterial",
      name: "CitronAccent",
      baseColor: "#e6f55a",
      roughness: 0.35,
      metallic: 0,
    },
    {
      op: "addLight",
      kind: "area",
      name: "KeyLight",
      location: { x: 3, y: -3, z: 4 },
      energy: 800,
      size: 3,
    },
    {
      op: "addCamera",
      name: "Camera",
      location: { x: 4.5, y: -4.5, z: 2.8 },
      rotation: { x: 1.05, y: 0, z: 0.785 },
      focalLengthMm: 50,
      makeActive: true,
    },
    {
      op: "setRenderSettings",
      width: 320,
      height: 240,
      outputPath: join(tmpdir(), "kinema-check.png"),
      fileFormat: "PNG",
      cyclesSamples: 16,
    },
    { op: "render" },
  ],
});

const dir = mkdtempSync(join(tmpdir(), "kinema-parse-"));
const file = join(dir, "generated.py");
writeFileSync(file, script, "utf8");

const stdout = execFileSync(PYTHON, ["-c", "import ast,sys; ast.parse(open(sys.argv[1],encoding='utf-8').read()); print('ast.parse OK')", file], {
  encoding: "utf8",
  shell: false,
});

process.stdout.write(stdout);
process.stdout.write(`\n--- generated script (${script.split("\n").length} lines) ---\n`);
process.stdout.write(script);