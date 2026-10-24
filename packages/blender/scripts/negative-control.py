"""
NEGATIVE CONTROL for the injection tests.

Purpose: prove the injection test is capable of FAILING. A security test that passes
because it cannot detect the vulnerability is worse than no test, because it manufactures
false confidence.

Method: build the same statement twice -
  A. with the real pythonStringLiteral escaping from script-builder.ts
  B. with escaping disabled (identity), the naive interpolation an unwary implementation
     would write
and show that (B) executes the payload while (A) does not.

WHY THE DETECTION IS A SENTINEL AND NOT A TRACER. The first version of this script used
`sys.settrace` and reported "not executed" for a naive build that had plainly printed
`pwned`. The tracer was wrong, not the conclusion: `settrace` does not observe calls made
from a frame created by `exec` of already-compiled code in the way that check assumed.
A detection mechanism that can report a false negative is useless for a negative control,
so the payload now writes to a sentinel file and the check is `os.path.exists`. That
cannot miss: either the file was created or it was not.

Run: node --experimental-strip-types packages/blender/scripts/negative-control.ts
"""

import ast
import json
import os
import sys
import tempfile


class Stub:
    """Permissive stand-in so the generated statement reaches the payload position."""

    def __getattr__(self, item):
        return Stub()

    def __call__(self, *args, **kwargs):
        return Stub()


def build(material_literal: str) -> str:
    """The exact statement shape script-builder.ts emits, literal supplied by the caller."""
    return "mat = bpy.data.materials.new(name=%s)\n" % material_literal


def run_and_detect(source: str, label: str, sentinel: str) -> bool:
    """
    Run a source string and report whether the payload executed.

    Returns True when the sentinel file exists afterwards, which can only happen if the
    payload's `os.system` call actually ran.
    """
    if os.path.exists(sentinel):
        os.remove(sentinel)

    print(f"  {label}")
    print(f"    source: {source.strip()}")
    try:
        ast.parse(source)
        print("    parses: YES")
    except SyntaxError as exc:
        print(f"    parses: NO -> {exc}")

    error = None
    try:
        exec(compile(source, "<generated>", "exec"), {"bpy": Stub()})
    except Exception as exc:  # noqa: BLE001
        error = f"{type(exc).__name__}: {exc}"

    executed = os.path.exists(sentinel)
    if error:
        print(f"    runtime error: {error}")
    print(f"    sentinel created: {executed}")
    print(f"    >>> EXECUTED PAYLOAD: {executed}")
    print()
    return executed


def main() -> int:
    units = json.loads(open(sys.argv[1], encoding="utf-8").read())

    print("=" * 74)
    print("NEGATIVE CONTROL: the injection test must be able to FAIL")
    print("=" * 74)
    print()

    problems = 0
    sentinel = os.path.join(tempfile.gettempdir(), "kinema-pwned-sentinel.txt")

    for entry in units["payloads"]:
        print(f"payload ({entry['label']}): {entry['value']!r}")
        print(f"  sentinel: {sentinel}")
        print()

        caught = run_and_detect(
            build(entry["escaped"]), "A. WITH escaping (script-builder.ts as shipped)", sentinel
        )
        exploited = run_and_detect(
            build(entry["raw"]), "B. WITHOUT escaping (naive interpolation)", sentinel
        )

        if caught:
            print("  !! FAIL: the shipped escaper let the payload execute.")
            problems += 1
        if not exploited:
            print("  !! INCONCLUSIVE: the naive build did not execute either, so this payload")
            print("     proves nothing about the escaper. Pick a payload that does.")
            problems += 1

        print("-" * 74)
        print()

    if os.path.exists(sentinel):
        os.remove(sentinel)

    print("=" * 74)
    if problems:
        print(f"RESULT: {problems} problem(s). The negative control did not establish its point.")
        print("=" * 74)
        return 1
    print("RESULT: every payload was BLOCKED by the shipped escaper and EXECUTED by the naive")
    print("        one. The injection test in script-builder.test.ts can therefore fail, and")
    print("        its passing is meaningful evidence rather than a vacuous green tick.")
    print("=" * 74)
    return 0


if __name__ == "__main__":
    sys.exit(main())