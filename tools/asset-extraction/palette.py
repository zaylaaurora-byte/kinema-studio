"""
palette.py - extract the authoritative character palettes.

TWO SOURCES OF TRUTH, AND WHY WE PREFER THE SWATCHES
----------------------------------------------------
A colour histogram over a character sheet is a measurement of *the artwork*: it
tells you which colours were used most, which is dominated by hair and clothing
area, and it says nothing about what the artist declared the character's colours
to be. Sheet 01 carries a literal labelled palette - Hair, Skin, Eyes,
Horn/Tail, Sweater, Clothes (Black), Mouth/Tongue, Accents (Red) - and sheet 03
carries unlabelled swatch blocks. Those swatch patches ARE the declared palette,
so we read them directly.

The histogram is still computed, as a cross-check: if a declared swatch colour
does not appear anywhere in the artwork, either we located the swatch wrongly or
the sheet is inconsistent. Reporting both, side by side, is what makes the
result trustworthy - and where they disagree we say so rather than picking one.

HOW THE SWATCHES ARE LOCATED
----------------------------
Not by hard-coded pixels. We find them structurally:

  1. Build the "flat, untextured colour" mask: a pixel is a swatch candidate if
     it is far from the page background AND its local neighbourhood is nearly
     uniform. Linework and shading fail the uniformity test; a printed swatch
     passes.
  2. Connected-component it. Swatches come out as small, high-fill rectangles.
  3. Filter on the shape signature of a printed swatch: roughly rectangular,
     compact, sensible area, and high fill ratio (a swatch is a solid block,
     so area/(w*h) is near 1; a figure is not).
  4. Group the survivors into the columns/rows they visually form, which is what
     lets us assign the known label order to them.

Every located swatch is written out with its rectangle and its hex, so the
assignment can be checked by eye in one glance. Where the automatic layout is
ambiguous we say so and fall back - we never silently guess a label.
"""

from __future__ import annotations

import argparse
import os
import sys

import cv2
import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from extraction_core import (  # noqa: E402
    DEFAULT_OUT_DIR, estimate_flat_background, hex_of, load_json, read_image,
    resolve_source_dir, save_json,
)

# The declared palettes, in the order the sheets print them. These label orders
# were read off the sheets visually; the *colours* are always measured.
DECLARED_LABELS = {
    "01_Demon_Host_Primary_Character_Sheet.png": [
        "Hair", "Skin", "Eyes", "Horns / Tail", "Sweater",
        "Clothes (Black)", "Mouth / Tongue", "Accents (Red)",
    ],
    "03_Paired_Character_And_Expressions_Reference.png": [
        "Demon swatch 1", "Demon swatch 2", "Demon swatch 3", "Demon swatch 4",
        "Demon swatch 5", "Demon swatch 6", "Demon swatch 7", "Demon swatch 8",
        "Demon swatch 9", "Demon swatch 10", "Human swatch 1", "Human swatch 2",
        "Human swatch 3",
    ],
}

# Where the declared palette lives on each sheet, as a fraction of the sheet:
# (x0, x1, y0, y1). This is a *search region*, not a coordinate list - the
# swatch finder still has to locate each block inside it. That keeps the
# "derive, don't hardcode" rule while stopping the finder from wandering into
# the artwork and latching onto a character's sweater as a swatch.
#
# Sheet 03 is split into two regions because it prints TWO palettes side by
# side (demon on the left, human on the right) with a whole turnaround panel
# between them. Treating it as one region made the finder pick up the human
# turnaround's white figure as swatches.
PALETTE_REGIONS = {
    "01_Demon_Host_Primary_Character_Sheet.png": [
        ("demon", (0.85, 0.99, 0.02, 0.42), "rect"),
    ],
    "03_Paired_Character_And_Expressions_Reference.png": [
        # This palette is a 2-column grid of CIRCLES. Getting the region right
        # took two measured corrections, both worth recording:
        #   * x0=0.60 (=921px) clipped the left column in half - the circles came
        #     back as 13x33 slivers and their median colour was corrupted.
        #   * x0=0.585 cleared the circles but let the HUMAN TURNAROUND's white
        #     figure leak in as a bogus 47x115 "swatch", which then shifted every
        #     label by one. A region that overlaps real artwork will always do
        #     this, so the region must enclose the printed palette and nothing
        #     else. 0.585..0.695 brackets the two columns (x=898..988) with a
        #     small margin and stops short of the turnaround at x~1030.
        ("demon", (0.585, 0.695, 0.02, 0.30), "circle"),
        ("human", (0.925, 0.995, 0.02, 0.30), "circle"),
    ],
}

DECLARED_LABELS_03 = {
    "demon": ["Demon Hair/Base", "Demon Accent Red", "Demon Deep Brown",
              "Demon Eye Orange", "Demon Skin", "Demon Clothes Black",
              "Demon Hair Shadow", "Demon Light Skin"],
    "human": ["Human White", "Human Red", "Human Black"],
}


def swatch_candidates(im: np.ndarray, region, bg_colour,
                      shape: str = "rect") -> list[dict]:
    """Find printed swatch blocks inside a region. See module docstring.

    `shape` selects the acceptance signature. This matters: sheet 01 prints its
    palette as RECTANGLES but sheet 03 prints it as CIRCLES, and a rectangle
    filter applied to a circle rejects it on both fill ratio and aspect ratio
    (a circle fills only ~78% of its bounding box). Detecting the shape from
    the artwork automatically is possible but fragile, so the caller declares
    it per region and the numbers below do the rest.
    """
    h, w = im.shape[:2]
    x0f, x1f, y0f, y1f = region
    X0, X1 = int(x0f * w), int(x1f * w)
    Y0, Y1 = int(y0f * h), int(y1f * h)
    sub = im[Y0:Y1, X0:X1]

    f = sub.astype(np.float32)
    dist_bg = np.abs(f - np.asarray(bg_colour, np.float32)).max(axis=2)
    not_bg = (dist_bg > 22).astype(np.uint8)

    # Uniformity: a swatch is a flat block. Compute local standard deviation
    # with a box filter. Text and linework have high local variance; a printed
    # swatch is near zero.
    g = cv2.cvtColor(sub, cv2.COLOR_BGR2GRAY).astype(np.float32)
    mean = cv2.blur(g, (7, 7))
    sq = cv2.blur(g * g, (7, 7))
    local_std = np.sqrt(np.maximum(sq - mean * mean, 0))
    flat = (local_std < 8.0).astype(np.uint8)

    cand = cv2.bitwise_and(not_bg, flat)
    # Close so anti-aliased swatch borders do not split one block into pieces.
    cand = cv2.morphologyEx(cand, cv2.MORPH_CLOSE, np.ones((5, 5), np.uint8))

    n, lab, stats, cent = cv2.connectedComponentsWithStats(cand, 8)
    out = []
    region_area = sub.shape[0] * sub.shape[1]
    # A circle fills pi/4 ~= 0.785 of its bbox; a rect fills ~1.0. Anti-aliasing
    # and the closing operation cost a little in both cases.
    min_fill = 0.72 if shape == "rect" else 0.62
    max_fill = 1.01 if shape == "rect" else 0.90

    for i in range(1, n):
        x, y, ww, hh, area = stats[i]
        if area < max(200, 0.0004 * region_area):
            continue
        if ww < 12 or hh < 12:
            continue
        fill = area / float(ww * hh)
        if fill < min_fill or fill > max_fill:
            continue
        ar = ww / float(hh)
        if ar > 3.0 or ar < 0.34:
            continue
        mask = (lab == i)
        med = np.median(sub[mask], axis=0)
        out.append(dict(
            x=int(x + X0), y=int(y + Y0), w=int(ww), h=int(hh),
            area=int(area), fill=round(float(fill), 3),
            bgr=[int(v) for v in med], hex=hex_of(med),
        ))
    return out


def order_swatches(swatches: list[dict], rows_hint: int | None = None) -> list[dict]:
    """Sort swatches into reading order.

    Swatch blocks are printed in a single column or a small grid, so ordering by
    (row band, then x) reproduces the printed order. We detect the row bands
    from the y-gaps rather than assuming a fixed pitch, because sheet 01 prints
    eight swatches in one column with slightly irregular spacing.
    """
    if not swatches:
        return []
    sw = sorted(swatches, key=lambda s: (s["y"], s["x"]))
    heights = [s["h"] for s in sw]
    pitch = float(np.median(heights))
    bands, cur = [], [sw[0]]
    for s in sw[1:]:
        if abs(s["y"] - cur[-1]["y"]) <= pitch * 0.6:
            cur.append(s)
        else:
            bands.append(cur)
            cur = [s]
    bands.append(cur)
    ordered = []
    for b in bands:
        ordered.extend(sorted(b, key=lambda s: s["x"]))
    return ordered


def dominant_colours(im: np.ndarray, bg_colour, k: int = 8,
                     ignore_bg_tol: float = 26.0) -> list[dict]:
    """Area-dominant artwork colours, for cross-checking the declared palette.

    WHY k-means on a subsample: this is a cross-check, not the primary answer,
    so it only needs to be representative. We exclude near-background pixels
    first, otherwise the page beige wins every time and the result is useless.
    We report the share of artwork area each cluster covers so the reader can
    see that (for example) hair brown legitimately dominates.
    """
    f = im.reshape(-1, 3).astype(np.float32)
    keep = np.abs(f - np.asarray(bg_colour, np.float32)).max(axis=1) > ignore_bg_tol
    f = f[keep]
    if len(f) < 100:
        return []
    rs = np.random.RandomState(0)
    if len(f) > 200_000:
        f = f[rs.choice(len(f), 200_000, replace=False)]

    crit = (cv2.TERM_CRITERIA_EPS + cv2.TERM_CRITERIA_MAX_ITER, 30, 0.5)
    _, labels, centres = cv2.kmeans(f, k, None, crit, 4, cv2.KMEANS_PP_CENTERS)
    counts = np.bincount(labels.ravel(), minlength=k)
    order = np.argsort(-counts)
    total = counts.sum()
    return [dict(hex=hex_of(centres[i]),
                 bgr=[int(v) for v in centres[i]],
                 share=round(float(counts[i] / total), 4)) for i in order]


def nearest_share(colour_bgr, dom: list[dict]) -> float:
    """How much artwork area is close to a given colour.

    NOTE ON WHAT A LOW VALUE MEANS: with k=8 clusters, a minority accent (the
    eye orange #EEA651 covers ~0.13% of sheet 01) cannot own a cluster, so it
    legitimately scores ~0 here even though it IS in the artwork. A low share
    therefore means "does not dominate any region", NOT "absent". Use
    `pixel_share` below when the question is literally presence.
    """
    if not dom:
        return 0.0
    c = np.asarray(colour_bgr, np.float32)
    best = 0.0
    for d in dom:
        dc = np.asarray(d["bgr"], np.float32)
        if np.abs(c - dc).max() < 28:
            best += d["share"]
    return round(best, 4)


def pixel_share(im: np.ndarray, colour_bgr, tol: int = 28) -> float:
    """Exact fraction of sheet pixels within `tol` of a colour.

    This is the honest presence test, and it is cheap, so we run it for every
    declared swatch. It distinguishes 'this colour is rare' from 'this colour is
    not on the sheet at all'.
    """
    c = np.asarray(colour_bgr, np.float32)
    d = np.abs(im.astype(np.float32) - c).max(axis=2)
    return round(float((d <= tol).mean()), 6)


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description="Extract character palettes.")
    ap.add_argument("--source", default=None, help="directory holding the sheets")
    ap.add_argument("--out", default=None,
                    help="JSON output path (default: <extracted>/palette.json)")
    ap.add_argument("--clusters", type=int, default=8, help="k for the cross-check histogram")
    args = ap.parse_args(argv)

    src = resolve_source_dir(args.source)
    out = args.out or os.path.join(DEFAULT_OUT_DIR, "palette.json")

    print("source: %s\n" % src)
    results = {}

    for sheet, labels in DECLARED_LABELS.items():
        path = os.path.join(src, sheet)
        if not os.path.exists(path):
            print("!! missing %s" % sheet)
            continue
        im = read_image(path)
        bg = estimate_flat_background(im).colour
        dom = dominant_colours(im, bg, k=args.clusters)

        print("== %s" % sheet)
        print("   background %s" % hex_of(bg))

        declared = []
        for region_name, region, shape in PALETTE_REGIONS.get(sheet, []):
            found = order_swatches(swatch_candidates(im, region, bg, shape))
            if sheet == "03_Paired_Character_And_Expressions_Reference.png":
                sub_labels = DECLARED_LABELS_03.get(region_name, [])
            else:
                sub_labels = labels

            if not found:
                print("   [%s] no swatches located in region %s" % (region_name, region))
                continue
            print("   [%s] %d swatch blocks located (shape=%s)" % (region_name, len(found), shape))
            for i, s in enumerate(found):
                label = sub_labels[i] if i < len(sub_labels) else "%s swatch %d" % (region_name, i + 1)
                share = nearest_share(s["bgr"], dom)
                present = pixel_share(im, s["bgr"])
                declared.append(dict(label=label, group=region_name, hex=s["hex"],
                                     bgr=s["bgr"], rect=[s["x"], s["y"], s["w"], s["h"]],
                                     fill=s["fill"], artwork_share=share,
                                     sheet_pixel_share=present))
                flag = ""
                if present < 1e-5:
                    flag = "   <- colour ABSENT from sheet"
                elif share <= 0.001:
                    flag = "   <- present but rare (holds no cluster)"
                print("     %-22s %s  rect=%4d,%4d %3dx%-3d  px %6.3f%%  cluster %5.1f%%%s"
                      % (label, s["hex"], s["x"], s["y"], s["w"], s["h"],
                         100 * present, 100 * share, flag))
            if len(found) != len(sub_labels):
                print("     NOTE: found %d blocks but %d labels are declared for this "
                      "region." % (len(found), len(sub_labels)))
                print("           Labels are assigned in printed reading order, so any "
                      "label at or after a missed block is WRONG.")

        absent = [d for d in declared if d["sheet_pixel_share"] < 1e-5]
        if absent:
            print("   WARNING: %d declared colour(s) absent from the sheet: %s"
                  % (len(absent), ", ".join(d["label"] for d in absent)))

        print("   dominant artwork colours (k=%d):" % args.clusters)
        for d in dom[:args.clusters]:
            print("     %s  %5.1f%% of artwork" % (d["hex"], 100 * d["share"]))
        print()

        results[sheet] = dict(
            background=hex_of(bg),
            declared=declared,
            declared_source=("located swatch blocks" if found else "none found"),
            dominant=dom,
            labels_are_printed_order=True,
            caveat=("Labels are assigned in the printed reading order. Verify the "
                    "rectangles in `declared[].rect` against the sheet: if the "
                    "finder missed or merged a block, labels after that point "
                    "shift by one."),
        )

    save_json(out, dict(generated_by="palette.py", source_dir=src, sheets=results))
    print("wrote %s" % out)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())