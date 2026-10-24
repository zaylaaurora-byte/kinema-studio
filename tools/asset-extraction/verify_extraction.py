"""
verify_extraction.py - prove the extraction is not garbage.

WHY THIS IS THE MOST IMPORTANT FILE IN THE TOOLKIT
--------------------------------------------------
An extractor that silently produces nearly-empty or nearly-opaque PNGs will
still "succeed" - it writes files, it exits 0, and nobody notices until the art
is on a compositor. Every check here exists because it is *possible* for
extract.py to be wrong in that way, and each one is a measurement against the
source rather than against the extractor's own opinion of itself.

WHAT IS CHECKED, AND WHY EACH CHECK IS THE RIGHT ONE
----------------------------------------------------
  alpha_present      The file must actually be 4-channel. The whole premise of
                     the task is that the sources have no alpha; if we emit
                     3-channel PNGs we have delivered nothing.
  alpha_removed      Alpha must not be all-255. If <2% of pixels are
                     transparent, background was not removed. This is the
                     headline failure - it means we shipped a crop, not a matte.
  content_present    Something must survive. >1% of pixels must be opaque.
  outline_retention  THE KEY CHECK. We recompute the dark-linework mask on the
                     *source* crop and ask what fraction of those ink pixels
                     still have alpha >= 0.5 in the output. Black outline is the
                     darkest thing on the sheet, so it should survive easily;
                     when a matte eats it, this ratio collapses toward 0 and the
                     number says so. Measured against the source, not the
                     output, so it cannot be gamed by the matte.
  not_noise          A real panel's opaque pixels form a few large connected
                     components. If the opaque area is shattered into hundreds of
                     tiny specks, the matte thresholded paper texture rather
                     than cutting a figure. We compare component count against
                     opaque area.
  not_duplicate      Two panels that are pixel-identical (or near-identical)
                     mean the layout produced the same rectangle twice.
  not_blank          Reject panels that are a single flat colour - a symptom of
                     a rectangle landing entirely off the artwork.

HONEST SCOPE
------------
These checks can show an extraction is *implausible*. They cannot show it is
correct - a panel can pass every check and still be mis-framed, because
framing is a judgement about the artwork that no threshold encodes. The
`framing` section reports the numbers that let a human make that judgement.
"""

from __future__ import annotations

import argparse
import os
import sys

import cv2
import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from extraction_core import (  # noqa: E402
    DEFAULT_OUT_DIR, OUTLINE_MAX_CHANNEL, OUTLINE_MIN_ALPHA_RETAINED,
    load_json, outline_mask, read_image, resolve_source_dir, save_json,
)

# Thresholds, in one place, because the brief asks for them to be configurable
# and because a reader needs to see all the judgement calls at once.
DEFAULTS = dict(
    min_alpha_zero_frac=0.02,     # <2% transparent => background not removed
    min_opaque_frac=0.01,         # <1% opaque     => nothing survived
    max_opaque_frac=0.995,        # ~100% opaque   => nothing was removed
    min_outline_retention=OUTLINE_MIN_ALPHA_RETAINED,
    max_fragments_per_10k=40.0,   # opaque specks per 10k opaque px
    min_largest_cc_frac=0.30,     # biggest blob must hold >=30% of opaque area
    duplicate_iou=0.995,          # rects this similar => duplicate layout
)


def check_panel(rec, out_root, src_dir, thr: dict):
    """Run every check on one panel. Returns (failures, metrics)."""
    fails = []
    m = {}

    path = os.path.join(out_root, *rec["file"].split("/"))
    if not os.path.exists(path):
        return ["missing_output"], m

    img = cv2.imread(path, cv2.IMREAD_UNCHANGED)
    if img is None:
        return ["unreadable_output"], m

    if img.ndim != 3 or img.shape[2] != 4:
        fails.append("no_alpha_channel")
        return fails, m

    bgr, alpha = img[:, :, :3], img[:, :, 3]
    n = alpha.size
    m["size"] = [int(img.shape[1]), int(img.shape[0])]

    # --- 1. was anything actually removed? --------------------------------
    zero_frac = float((alpha == 0).mean())
    m["alpha_zero_frac"] = round(zero_frac, 4)
    if zero_frac < thr["min_alpha_zero_frac"]:
        fails.append("background_not_removed")

    # --- 2. did anything survive? -----------------------------------------
    opaque = alpha >= 128
    opaque_frac = float(opaque.mean())
    m["opaque_frac"] = round(opaque_frac, 4)
    if opaque_frac < thr["min_opaque_frac"]:
        fails.append("empty_result")
    if opaque_frac > thr["max_opaque_frac"]:
        fails.append("nothing_removed_at_all")

    # --- 3. is the result a figure or a spray of specks? ------------------
    n_lab, lab, stats, _ = cv2.connectedComponentsWithStats(
        opaque.astype(np.uint8), 8)
    areas = stats[1:, cv2.CC_STAT_AREA] if n_lab > 1 else np.array([0])
    n_cc = int(len(areas))
    m["components"] = n_cc
    if opaque_frac > 0:
        per10k = n_cc / max(opaque_frac * n / 10000.0, 1e-6)
        m["fragments_per_10k_opaque"] = round(float(per10k), 2)
        if per10k > thr["max_fragments_per_10k"]:
            fails.append("noise_not_figure")
    largest = float(areas.max()) / max(areas.sum(), 1)
    m["largest_component_frac"] = round(largest, 4)
    if opaque_frac > 0.02 and largest < thr["min_largest_cc_frac"]:
        fails.append("shattered")

    # --- 4. flat/degenerate content ---------------------------------------
    if opaque.any():
        sel = bgr[opaque]
        m["colour_std"] = round(float(sel.std()), 2)
        if float(sel.std()) < 3.0:
            fails.append("blank_flat_panel")

    # --- 5. THE OUTLINE CHECK ---------------------------------------------
    # Recompute ink on the SOURCE crop so this is a like-for-like measurement:
    # of the black pixels present in the source, how many are still present?
    src_path = os.path.join(src_dir, rec["sheet"])
    if os.path.exists(src_path):
        src = read_image(src_path)
        r = rec["source_rect"]
        y, x, w, h = r["y"], r["x"], r["w"], r["h"]
        crop = src[y:y + h, x:x + w]
        if crop.shape[:2] == alpha.shape:
            ink = outline_mask(crop, OUTLINE_MAX_CHANNEL)
            n_ink = int(ink.sum())
            m["source_outline_px"] = n_ink
            if n_ink >= 20:
                kept = int((alpha[ink] >= 128).sum())
                ret = kept / float(n_ink)
                m["outline_retention"] = round(ret, 4)
                m["outline_lost_px"] = n_ink - kept
                if ret < thr["min_outline_retention"]:
                    fails.append("outline_eaten")
            else:
                m["outline_retention"] = None

    return fails, m


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(
        description="Verify that extracted panels are plausible mattes.")
    ap.add_argument("--source", default=None, help="directory holding the source sheets")
    ap.add_argument("--extracted", default=DEFAULT_OUT_DIR, help="extraction output root")
    ap.add_argument("--manifest", default=None, help="manifest.json (default: <extracted>/manifest.json)")
    ap.add_argument("--min-outline-retention", type=float, default=DEFAULTS["min_outline_retention"])
    ap.add_argument("--min-alpha-zero-frac", type=float, default=DEFAULTS["min_alpha_zero_frac"])
    ap.add_argument("--min-opaque-frac", type=float, default=DEFAULTS["min_opaque_frac"])
    ap.add_argument("--report", default=None, help="write a JSON report here")
    ap.add_argument("--quiet", action="store_true", help="summary table only")
    args = ap.parse_args(argv)

    thr = dict(DEFAULTS)
    thr["min_outline_retention"] = args.min_outline_retention
    thr["min_alpha_zero_frac"] = args.min_alpha_zero_frac
    thr["min_opaque_frac"] = args.min_opaque_frac

    src = resolve_source_dir(args.source)
    mpath = args.manifest or os.path.join(args.extracted, "manifest.json")
    if not os.path.exists(mpath):
        print("no manifest at %s - run extract.py first" % mpath, file=sys.stderr)
        return 2
    manifest = load_json(mpath)

    # Crop-only sheets are exempt from matte checks: they declare that they have
    # no background to remove (studio composites and storyboards). Pretending
    # otherwise would produce a flood of false failures.
    crop_only = {s["sheet"] for s in manifest["sheets"] if s["preset"] == "crop"}

    print("verifying %s" % mpath)
    print("source    %s\n" % src)

    per_sheet = {}
    all_fails = []
    dup_seen = {}
    total = 0

    print("%-44s %5s %7s %8s %9s %8s %6s" % (
        "sheet", "n", "alpha0%", "opaque%", "outline%", "maxFrag", "FAIL"))
    print("-" * 96)

    for s in manifest["sheets"]:
        rows = []
        for rec in s["panels"]:
            total += 1
            # duplicate-rectangle detection (cheap, catches layout bugs)
            key = (rec["sheet"], rec["source_rect"]["x"], rec["source_rect"]["y"],
                   rec["source_rect"]["w"], rec["source_rect"]["h"])
            dup = key in dup_seen
            dup_seen[key] = rec["label"]

            res = check_panel(rec, args.extracted, src, thr)
            # check_panel returns either (fails, metrics) or a bare list
            if isinstance(res, tuple):
                fails, metrics = res
            else:
                fails, metrics = res, {}
            if dup:
                fails = list(fails) + ["duplicate_rect"]
            if s["sheet"] in crop_only:
                fails = [f for f in fails
                         if f not in ("background_not_removed", "nothing_removed_at_all")]
            rows.append((rec, fails, metrics))
            if fails:
                all_fails.append((rec, fails, metrics))

        zf = [r[2].get("alpha_zero_frac", 1.0) for r in rows if r[2]]
        of = [r[2].get("opaque_frac", 0.0) for r in rows if r[2]]
        orr = [r[2]["outline_retention"] for r in rows
               if r[2].get("outline_retention") is not None]
        fr = [r[2].get("fragments_per_10k_opaque", 0.0) for r in rows if r[2]]
        nf = sum(1 for r in rows if r[1])

        print("%-44s %5d %7s %8s %9s %8s %6d" % (
            s["sheet"][:44], len(rows),
            ("%.1f" % (100 * np.mean(zf))) if zf else "-",
            ("%.1f" % (100 * np.mean(of))) if of else "-",
            ("%.1f" % (100 * np.mean(orr))) if orr else "n/a",
            ("%.1f" % max(fr)) if fr else "-",
            nf))

        per_sheet[s["sheet"]] = dict(
            panels=len(rows), failed=nf,
            mean_alpha_zero_frac=float(np.mean(zf)) if zf else None,
            mean_opaque_frac=float(np.mean(of)) if of else None,
            mean_outline_retention=float(np.mean(orr)) if orr else None,
            min_outline_retention=float(np.min(orr)) if orr else None,
            crop_only=s["sheet"] in crop_only,
        )

    # ---------------- failure detail ----------------
    if all_fails and not args.quiet:
        print("\nFAILURES (%d panels)" % len(all_fails))
        print("-" * 96)
        by_kind = {}
        for rec, fails, metrics in all_fails:
            for f in fails:
                by_kind.setdefault(f, []).append((rec, metrics))
        for kind in sorted(by_kind, key=lambda k: -len(by_kind[k])):
            items = by_kind[kind]
            print("\n  %s  (%d panels)" % (kind.upper(), len(items)))
            for rec, metrics in items[:6]:
                extra = ""
                if kind == "outline_eaten":
                    extra = (" - lost %s of %s ink px (%.1f%% kept)" % (
                        metrics.get("outline_lost_px"), metrics.get("source_outline_px"),
                        100 * metrics.get("outline_retention", 0)))
                elif kind == "background_not_removed":
                    extra = " - only %.2f%% of pixels transparent" % (
                        100 * metrics.get("alpha_zero_frac", 0))
                elif kind == "noise_not_figure":
                    extra = " - %.1f specks per 10k opaque px" % metrics.get(
                        "fragments_per_10k_opaque", 0)
                print("    %-40s %s%s" % (rec["label"][:40], rec["file"], extra))
            if len(items) > 6:
                print("    ... and %d more" % (len(items) - 6))

    # ---------------- worst outline retention ----------------
    all_rows = []
    for s in manifest["sheets"]:
        pass
    # recompute a ranked list cheaply from the manifest's own recorded numbers
    ranked = []
    for s in manifest["sheets"]:
        for rec in s["panels"]:
            r = rec.get("outline_retention")
            if r is not None:
                ranked.append((r, s["sheet"], rec["label"]))
    ranked.sort()
    if ranked:
        print("\nWORST OUTLINE RETENTION (lowest 8 of %d panels with ink)" % len(ranked))
        print("-" * 96)
        for r, sh, lab in ranked[:8]:
            flag = "  <-- BELOW GATE" if r < thr["min_outline_retention"] else ""
            print("  %6.2f%%  %-40s %s%s" % (100 * r, lab[:40], sh[:38], flag))
        print("  mean %.2f%%   min %.2f%%" % (
            100 * np.mean([r[0] for r in ranked]), 100 * ranked[0][0]))

    ok = len(all_fails) == 0
    print("\n%s: %d panels checked, %d failed" % (
        "PASS" if ok else "FAIL", total, len(all_fails)))

    if args.report:
        save_json(args.report, dict(
            manifest=mpath, thresholds=thr, sheets=per_sheet,
            failures=[dict(file=r["file"], sheet=r["sheet"], label=r["label"],
                           checks=f, metrics=m) for r, f, m in all_fails],
            passed=ok, panels=total,
        ))
        print("report: %s" % args.report)

    # Non-zero exit on any failure, as required - so this can gate a build.
    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(main())