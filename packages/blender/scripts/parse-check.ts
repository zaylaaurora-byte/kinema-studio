/**
 * Ad-hoc end-to-end check: generate a scene, run real Blender, verify the PNG decodes.
 *
 * Run:
 *   node --experimental-strip-types packages/blender/scripts/parse-check.ts
 */
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import process from "node:process";

import { buildSceneScript } from "../src/script-builder.ts";

const PYTHON =
  process.env["KINEMA_PYTHON"] ??
  "C:\\Users\\zayla\\.dsh\\dsh-runtimes\\dsh-primary-runtime\\dependencies\\python\\python.exe";

const BLENDER =
  process.env["BLENDER_PATH"] ??
  "C:\\Program Files\\Blender Foundation\\Blender 5.1\\blender.exe";

const tmp = process.env["KINEMA_TMP"] ?? join(process.cwd(), "tmp", "blender-live");
const outputPng = join(tmp, "render2.png");

const script = buildSceneScript({
  operations: [
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
      outputPath: outputPng,
      fileFormat: "PNG",
      cyclesSamples: 16,
    },
    { op: "render" },
  ],
});

const scriptPath = join(tmp, "scene2.py");
writeFileSync(scriptPath, script, "utf8");

const started = Date.now();
const stdout = execFileSync(
  BLENDER,
  ["--background", "--factory-startup", "--python", scriptPath],
  { encoding: "utf8", shell: false, maxBuffer: 32 * 1024 * 1024 },
);
const elapsed = Date.now() - started;

const payload = stdout.split("KINEMA_REPORT_START")[1]?.split("KINEMA_REPORT_END")[0]?.trim();
process.stdout.write(`blender exit 0 in ${elapsed}ms\n`);
process.stdout.write(`report: ${payload}\n`);

const decoded = execFileSync(
  PYTHON,
  [
    "-c",
    "import sys,json\nfrom PIL import Image\nimport numpy as np\na=np.array(Image.open(sys.argv[1]).convert('RGB'))\nprint(json.dumps({'shape':list(a.shape),'std':round(float(a.std()),3),'unique':int(len(np.unique(a.reshape(-1,3),axis=0))),'mean':[round(float(x),1) for x in a.reshape(-1,3).mean(axis=0)]}))",
    outputPng,
  ],
  { encoding: "utf8", shell: false },
);
process.stdout.write(`pillow: ${decoded.trim()}\n`);