"""Repair mojibake in text files across the repository.

A Windows process wrote UTF-8 bytes that were then interpreted as CP1252, turning
em-dashes and arrows into character sequences. This finds and repairs them so the
source reads correctly.

Only touches files it actually changes, and reports every one.
"""

import os
import sys
from pathlib import Path

# The mojibake sequences and what they should be. Built via escape sequences so this
# file itself stays pure ASCII and cannot be corrupted by the same problem.
REPLACEMENTS = [
    ("\u00e2\u20ac\u201d", "\u2014"),  # em dash
    ("\u00e2\u20ac\u201c", "\u2014"),
    ("\u00e2\u20ac\u2122", "\u2019"),  # right single quote
    ("\u00e2\u20ac\u0153", "\u201c"),  # left double quote
    ("\u00e2\u20ac\u009d", "\u201d"),  # right double quote
    ("\u00e2\u2020\u2019", "\u2192"),  # right arrow
    ("\u00e2\u2020\u201c", "\u2190"),  # left arrow
    ("\u00c2\u00a0", " "),             # non-breaking space
]

EXTENSIONS = {".ts", ".tsx", ".md", ".json", ".yml", ".yaml", ".css", ".py"}
SKIP_DIRS = {"node_modules", ".git", ".next", "dist", ".turbo", "tmp", "__pycache__"}


def repair(path: Path) -> bool:
    try:
        original = path.read_text(encoding="utf-8")
    except (UnicodeDecodeError, OSError):
        return False

    fixed = original
    for bad, good in REPLACEMENTS:
        fixed = fixed.replace(bad, good)

    if fixed == original:
        return False

    path.write_text(fixed, encoding="utf-8", newline="")
    return True


def main() -> int:
    root = Path(sys.argv[1] if len(sys.argv) > 1 else ".")
    changed: list[Path] = []
    scanned = 0

    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = [d for d in dirnames if d not in SKIP_DIRS]
        for name in filenames:
            path = Path(dirpath) / name
            if path.suffix.lower() not in EXTENSIONS:
                continue
            scanned += 1
            if repair(path):
                changed.append(path)

    print(f"Scanned {scanned} text files")
    if changed:
        print(f"Repaired {len(changed)}:")
        for path in changed:
            print(f"  {path.relative_to(root)}")
    else:
        print("No mojibake found.")
    return 0


if __name__ == "__main__":
    sys.exit(main())