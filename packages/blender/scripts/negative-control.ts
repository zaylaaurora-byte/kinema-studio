/**
 * NEGATIVE CONTROL for the injection tests.
 *
 * A security test that passes because it cannot detect the vulnerability is worse than no
 * test: it manufactures confidence. This script proves `script-builder.test.ts` is capable
 * of failing, by building the same scene twice —
 *
 *   A. with the real `pythonStringLiteral` escaping that ships in script-builder.ts
 *   B. with escaping disabled, i.e. the naive interpolation an unwary implementation
 *      would write
 *
 * — and showing that B executes the payload while A does not.
 *
 * Run:
 *   node --experimental-strip-types packages/blender/scripts/negative-control.ts
 */
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";

import { pythonStringLiteral } from "../src/script-builder.ts";

const SENTINEL_MARKER = "kinema-pwned-sentinel.txt";

const PYTHON =
  process.env["KINEMA_PYTHON"] ??
  "C:\\Users\\zayla\\.dsh\\dsh-runtimes\\dsh-primary-runtime\\dependencies\\python\\python.exe";

/**
 * The payload, shaped for a naive single-quoted interpolation `name='<value>'`: the value
 * closes the literal, ends the statement, and runs something.
 *
 * It writes a sentinel FILE rather than echoing to stdout, because the detection has to be
 * impossible to fool: a file either exists or it does not. The first version of this
 * control used `sys.settrace` and reported a false negative for a payload that had
 * visibly printed `pwned` — a detection mechanism that can miss is useless here.
 */
function sentinelPayload(prefix: string): string {
  // Forward slashes so the path needs no escaping of its own on Windows.
  const path = `${tmpdir().replace(/\\/g, "/")}/${SENTINEL_MARKER}`;
  return `${prefix}'); import os; os.system('cmd /c echo pwned > "${path}"'); ('`;
}

const PAYLOADS: readonly { label: string; value: string }[] = [
  { label: "quote-closing payload", value: sentinelPayload("x") },
];

const escaped = PAYLOADS.map((p) => pythonStringLiteral(p.value));
const raw = PAYLOADS.map((p) => `'${p.value}'`);

const unitsPath = join(tmpdir(), "kinema-negative-control.json");
writeFileSync(
  unitsPath,
  JSON.stringify({
    payloads: PAYLOADS.map((p, index) => ({
      label: p.label,
      value: p.value,
      escaped: escaped[index],
      raw: raw[index],
    })),
  }),
  "utf8",
);

const pyPath = join(import.meta.dirname, "negative-control.py");
const out = execFileSync(PYTHON, [pyPath, unitsPath], { encoding: "utf8", shell: false });
process.stdout.write(out);