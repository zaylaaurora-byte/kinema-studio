"""
build_layouts.py - derive the panel rectangles for each sheet.

WHAT THIS IS, AND WHAT IT IS NOT
--------------------------------
The brief says: "Do NOT hardcode pixel coordinates for everything - derive
them, though you may seed with known structure."

That is exactly the design here, and the reason is worth recording because I
tried the alternatives first and measured them failing:

  * Row/column ink projections: these sheets have NO clean full-width rules.
    The longest continuous dark horizontal run on sheet 01 is 137 px out of
    1536. Projections produce mush.
  * Colour percolation (flood the near-beige region, each enclosed blob is a
    cell): works beautifully on sheet 03, and collapses to a *single* blob on
    sheet 01 because figures drift across the 1-2 px black rules and break the
    enclosure.
  * Threshold -> invert -> drop border-touching components: the same breakage
    means the run that would be one row of 12 expression heads comes back as
    an arbitrary subset of 7.

The measurements are in `tools/asset-extraction/README.md`. The honest summary
is: on this artwork the *panel* is reliable and the *figure* is not, and a
fully automatic panel detector is not reliable either.

So the pipeline is:

  1. An authored `spec` states the *structure* a human read off the sheet at a
     coarse level - "3 columns, title band 0..110, gutter 12" - seeded from the
     real artwork I inspected with vision.
  2. That seed is projected onto the actual pixels by maximising a cell-border
     score over a small search window, independently per boundary.
  3. The result is written to layouts.json together with `shift_px`, the
     distance the seed had to move, and a `confidence` derived from how strong
     the border evidence was where the boundary landed.

Step 2/3 is the part that matters: the stored numbers are measurements of this
artwork, and the confidence column tells you which ones to distrust. A layout
that snapped 0 px onto a strong rule is trustworthy; one that snapped 14 px
onto nothing is a guess and says so.
"""

from __future__ import annotations

import argparse
import os
import sys

import cv2
import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from extraction_core import (  # noqa: E402
    DEFAULT_SOURCE_DIR, LAYOUTS_PATH, Panel, SheetLayout, save_json,
    read_image, resolve_source_dir,
)

# --------------------------------------------------------------------------
# The seed spec. Coordinates are APPROXIMATE - they are a starting guess that
# the snapper then corrects. Nothing downstream trusts them directly; that is
# the whole point of snap().
#
# `groups` is a list of dicts:
#   y, h          - seed top / height of the group band
#   x0, x1        - seed left / right of the band
#   cols          - number of equal cells across the band
#   labels        - per-cell label ('%d' is substituted with the 1-based index)
#   gutter        - px of separation to assume between cells
#   alpha         - 'global' (remove page background) or 'none' (keep as-is)
# --------------------------------------------------------------------------
SPEC = {
    "01_Demon_Host_Primary_Character_Sheet.png": dict(
        title="Demon Host - primary character sheet",
        background_mode="gradient",
        groups=[
            # Turnaround: 4 figures side by side, under the "TURNAROUND (SIMPLE)" caption.
            dict(group="turnaround", y=55, h=355, x0=415, x1=800, cols=4,
                 labels=["front", "three_quarter", "side", "back"], gutter=4),
            # 12 expression heads in one wide row.
            dict(group="expressions", y=455, h=125, x0=370, x1=1500, cols=12,
                 labels=["default", "happy", "laughing", "sarcastic", "curious",
                         "surprised", "excited", "annoyed", "bored", "sleepy",
                         "thinking", "maniacal"], gutter=4),
            # Detail close-ups, 3 across x 2 down.
            dict(group="details", y=55, h=340, x0=1040, x1=1290, cols=3, rows=2,
                 labels=["eye_closeup", "horn", "ear", "mouth_fang", "tail_tip",
                         "nails"], gutter=4),
            # 6 head-angle thumbnails.
            dict(group="closeup_angles", y=680, h=310, x0=1235, x1=1500, cols=3, rows=2,
                 labels=["front", "three_quarter_left", "three_quarter_right",
                         "side_profile", "looking_up", "looking_down"], gutter=4),
        ],
    ),
    "02_Silent_Human_Primary_Character_Sheet.png": dict(
        title="Silent Human (Contestant) - primary character sheet",
        background_mode="gradient",
        groups=[
            dict(group="turnaround", y=30, h=290, x0=455, x1=875, cols=5,
                 labels=["front", "three_quarter", "side", "back", "three_quarter_back"],
                 gutter=4),
            dict(group="expressions", y=355, h=110, x0=10, x1=1500, cols=20,
                 labels=["%d"] * 20, gutter=2),
            dict(group="poses_standing", y=525, h=135, x0=10, x1=1500, cols=18,
                 labels=["%d"] * 18, gutter=2),
            dict(group="actions", y=710, h=140, x0=10, x1=1500, cols=14,
                 labels=["%d"] * 14, gutter=2),
            dict(group="interaction", y=880, h=140, x0=10, x1=1150, cols=10,
                 labels=["%d"] * 10, gutter=2),
        ],
    ),
    "03_Paired_Character_And_Expressions_Reference.png": dict(
        title="Paired character and expressions reference",
        background_mode="gradient",
        groups=[
            dict(group="demon_turnaround", y=25, h=250, x0=325, x1=875, cols=4,
                 labels=["front", "three_quarter", "side", "back"], gutter=4),
            dict(group="human_turnaround", y=25, h=250, x0=1030, x1=1500, cols=4,
                 labels=["front", "three_quarter", "side", "back"], gutter=4),
            dict(group="demon_expressions", y=280, h=120, x0=320, x1=1500, cols=15,
                 labels=["neutral", "smug", "happy", "excited", "laughing", "deadpan",
                         "annoyed", "angry", "unhinged", "tired", "suspicious",
                         "disgusted", "concerned", "cute_soft", "extra"], gutter=2),
            dict(group="human_expressions", y=410, h=130, x0=320, x1=1500, cols=15,
                 labels=["neutral", "happy", "excited", "shocked", "scared", "crying",
                         "determined", "confused", "thinking", "injured", "dizzy",
                         "cool", "love", "tired", "dead"], gutter=2),
            dict(group="demon_poses", y=555, h=140, x0=10, x1=890, cols=15,
                 labels=["%d"] * 15, gutter=2),
            dict(group="human_poses", y=705, h=135, x0=10, x1=890, cols=12,
                 labels=["%d"] * 12, gutter=2),
            dict(group="interaction", y=840, h=175, x0=10, x1=890, cols=9, rows=2,
                 labels=["%d"] * 18, gutter=2),
        ],
    ),
    "04_Human_Poses_Outfits_And_Interaction_Reference.png": dict(
        title="Human poses, outfits and interaction reference",
        background_mode="gradient",
        groups=[
            dict(group="base_design", y=40, h=290, x0=10, x1=360, cols=4,
                 labels=["front", "side", "back", "head_variants"], gutter=4),
            dict(group="expressions", y=40, h=290, x0=370, x1=725, cols=5, rows=5,
                 labels=["%d"] * 25, gutter=2),
            dict(group="poses", y=40, h=290, x0=735, x1=1095, cols=5, rows=4,
                 labels=["%d"] * 20, gutter=2),
            dict(group="outfits", y=40, h=290, x0=1105, x1=1500, cols=5, rows=2,
                 labels=["default", "modern_casual", "medieval", "roman", "survival",
                         "scientist", "knight", "explorer", "winter", "fantasy"],
                 gutter=4),
            dict(group="interaction_core", y=430, h=195, x0=10, x1=1500, cols=5,
                 labels=["explaining_the_plan", "sending_him", "immediate_trouble",
                         "her_reaction", "bringing_him_back"], gutter=4),
            dict(group="scenarios", y=635, h=185, x0=10, x1=1500, cols=5, rows=2,
                 labels=["a_prehistoric", "b_ancient_rome", "c_medieval", "d_plague_era",
                         "e_pirate_age", "f_viking", "g_fantasy_world", "h_modern_day",
                         "i_space_alien", "j_underwater"], gutter=4),
        ],
    ),
    "05_Pilot_Open_And_End_Frames.png": dict(
        title="Pilot open and end frames",
        # NOT a reference sheet: a fully painted composite with no flat
        # background. Flagged so nothing downstream tries to matte it.
        is_reference=False,
        background_mode="none",
        alpha_mode="none",
        groups=[
            dict(group="frames", y=0, h=941, x0=0, x1=1672, cols=2,
                 labels=["start_image", "end_image"], gutter=0, alpha="none"),
        ],
    ),
    "06_Trex_Pilot_Storyboard_Exploration.png": dict(
        title="T. rex pilot storyboard exploration",
        # Storyboard cells carry real illustrated backgrounds; a global matte
        # is meaningless here, so these are crop-only.
        alpha_mode="none",
        background_mode="flat",
        groups=[
            dict(group="panels", y=20, h=425, x0=10, x1=1500, cols=4, rows=2,
                 labels=["01_intro", "02_the_challenge", "03_prep", "04_send_him_in",
                         "05_arrival", "06_first_encounter", "07_bad_decision_1",
                         "08_accidental_success"], gutter=6, alpha="none"),
            dict(group="panels", y=475, h=330, x0=10, x1=1500, cols=2, rows=2,
                 labels=["09_final_ten_seconds", "10_result", "11", "12"],
                 gutter=6, alpha="none"),
        ],
    ),
}


# --------------------------------------------------------------------------
# The snapper
# --------------------------------------------------------------------------
def border_score(img: np.ndarray) -> np.ndarray:
    """Per-pixel 'is this a cell rule' score.

    We reward darkness AND neutrality together. A rule is near-black and grey;
    the character's hair is near-black but distinctly warm. Scoring on both
    keeps the snapper from locking onto the hair silhouette.

    Returned as a float array in 0..1.
    """
    f = img.astype(np.float32)
    darkness = np.clip((135.0 - f.max(axis=2)) / 135.0, 0, 1)
    chroma = f.max(axis=2) - f.min(axis=2)
    neutrality = np.clip((60.0 - chroma) / 60.0, 0, 1)
    return darkness * neutrality


def foreground_mask(img: np.ndarray, tol: float = 26.0,
                    neutral_bgr=(200.0, 190.0, 178.0)) -> np.ndarray:
    """Boolean 'this pixel is not page background' mask.

    This is the primitive the snapper actually needs, and finding it was the
    turning point. I first tried to snap boundaries onto dark cell *rules*.
    Measuring the sheet showed why that cannot work: at x=578..590 the mean
    rule score over the turnaround band is 0.025 and the foreground fraction is
    0.063 - i.e. the genuine gap between two figures is *empty*, not dark. The
    1-2px rules are too faint to see, but the gutters are unmistakable.

    So we detect gutters instead: a boundary is good when a narrow strip there
    contains almost no figure pixels. That signal is strong, sign-correct and
    independent of how dark the artwork happens to be.

    The tolerance is generous on purpose. Page beige drifts across the sheet
    (#C4BAAF..#CBC1B4), so a tight tolerance would report gradient as
    foreground and fill in every gutter we are trying to find.
    """
    f = img.astype(np.float32)
    d = np.abs(f - np.asarray(neutral_bgr, np.float32)).max(axis=2)
    fg = (d > tol).astype(np.uint8)
    # Close small holes so paper texture and JPEG speckle do not masquerade as
    # figure. 3px is below the width of any real gutter on these sheets.
    fg = cv2.morphologyEx(fg, cv2.MORPH_CLOSE, np.ones((3, 3), np.uint8))
    return fg.astype(bool)


def gutter_profiles(img: np.ndarray, strip: float = 0.35) -> tuple[np.ndarray, np.ndarray]:
    """Score every x (and y) by how *empty* a strip around it is.

    `strip` scales the strip width to the axis length rather than fixing it in
    pixels, because a cell in the 20-across expression row is ~70px wide while
    a turnaround figure is ~130px. A fixed 10px strip would over-smooth the
    former and under-smooth the latter.

    Returns (col_score, row_score) in 0..1, where 1 means "definitely a
    gutter".
    """
    fg = foreground_mask(img)
    h, w = fg.shape

    def band_score(mask: np.ndarray, half: int) -> np.ndarray:
        # Integral image gives every window's sum in O(1), so this stays fast
        # even at 1536x1024 with a 90px strip.
        ii = cv2.integral(mask.astype(np.uint8), sdepth=cv2.CV_32S)
        n = mask.shape[0]
        idx = np.arange(n)
        lo = np.clip(idx - half, 0, n)
        hi = np.clip(idx + half + 1, 0, n)
        tot = ii[hi, -1] - ii[lo, -1]
        counts = (hi - lo) * mask.shape[1]
        return 1.0 - (tot / np.maximum(counts, 1))

    col = band_score(fg.T, max(3, int(w * strip)))   # strip of columns
    row = band_score(fg, max(3, int(h * strip)))
    return col, row


def snap(val: int, limit: int, profile: np.ndarray, radius: int) -> tuple[int, float, int]:
    """Snap one boundary to the emptiest nearby strip.

    Now that `profile` is a *gutter* score (1 = definitely empty, 0 = solid
    artwork) the rule is simply: move to the local maximum, but only if that
    maximum is genuinely gutter-like in absolute terms. The `min_abs` gate is
    the important one - when a seed sits inside a dense pose cluster there is
    no gutter within reach, and moving to the least-bad spot would be worse
    than leaving the seed where the human put it.

    Shift is returned signed and reported, because the whole point is to make
    visible which rectangles were verified against the pixels and which were
    not.
    """
    lo, hi = max(0, val - radius), min(len(profile), val + radius + 1)
    if hi <= lo:
        return val, 0.0, 0

    win = profile[lo:hi].astype(np.float64)
    best = int(np.argmax(win))
    peak = float(win[best])
    chosen = lo + best

    # 0.72 is calibrated from the measurements in README: genuine gutters on
    # these sheets score 0.86-1.00, while the best available spot inside an
    # occupied cell tops out around 0.5. A threshold in that gap is stable
    # across sheets; 0.5 would snap to half-empty corners, 0.9 would refuse
    # real gutters that figures slightly encroach on.
    min_abs = 0.72
    if peak < min_abs:
        return val, float(np.clip(peak, 0.0, 1.0)), 0

    return int(np.clip(chosen, 0, limit)), float(np.clip(peak, 0.0, 1.0)), int(chosen - val)


def expand_groups(spec_groups) -> list[dict]:
    """Flatten the seed spec into one record per panel."""
    out = []
    for g in spec_groups:
        cols = int(g.get("cols", 1))
        rows = int(g.get("rows", 1))
        labels = list(g.get("labels") or [])
        gutter = int(g.get("gutter", 0))
        x0, x1 = int(g["x0"]), int(g["x1"])
        y0, y1 = int(g["y"]), int(g["y"]) + int(g["h"])
        cell_w = (x1 - x0 - gutter * (cols - 1)) / float(cols)
        cell_h = (y1 - y0 - gutter * (rows - 1)) / float(rows)
        for r in range(rows):
            for c in range(cols):
                i = r * cols + c
                lab = labels[i] if i < len(labels) else "%d" % (i + 1)
                if lab == "%d":
                    lab = "%02d" % (i + 1)
                out.append(dict(
                    label=lab, group=g["group"],
                    x=int(round(x0 + c * (cell_w + gutter))),
                    y=int(round(y0 + r * (cell_h + gutter))),
                    w=int(round(cell_w)), h=int(round(cell_h)),
                    alpha=g.get("alpha"),
                ))
    return out


def build_sheet(sheet: str, img: np.ndarray, spec: dict, radius: int) -> SheetLayout:
    score = border_score(img)
    col_prof, row_prof = gutter_profiles(img)
    H, W = img.shape[:2]

    layout = SheetLayout(
        sheet=sheet,
        title=spec.get("title", sheet),
        is_reference=bool(spec.get("is_reference", True)),
        background_mode=spec.get("background_mode", "gradient"),
        alpha_mode=spec.get("alpha_mode", "global"),
        origin="derived",
        panels=[],
    )

    rows_ = expand_groups(spec["groups"])
    for i, p in enumerate(rows_, start=1):
        # Snap each of the four boundaries independently. Left/right snap on the
        # column profile, top/bottom on the row profile. Snapping all four is
        # what turns a seed grid into a measurement.
        nx, cx, dx = snap(p["x"], W, col_prof, radius)
        ny, cy, dy = snap(p["y"], H, row_prof, radius)
        # Right/bottom are snapped as their own boundaries, not derived from
        # x+w, so a mis-sized seed cell cannot propagate.
        rx, crx, drx = snap(p["x"] + p["w"], W, col_prof, radius)
        by, cby, dby = snap(p["y"] + p["h"], H, row_prof, radius)

        # Guard the obvious degenerate case: if two snapped boundaries cross
        # over, the snap was wrong and the seed was more trustworthy.
        if rx - nx < 24:
            nx, rx, crx = p["x"], p["x"] + p["w"], 0.0
        if by - ny < 24:
            ny, by, cby = p["y"], p["y"] + p["h"], 0.0

        w, h = rx - nx, by - ny
        shift = max(abs(dx), abs(dy), abs(drx), abs(dby))
        # Confidence combines the four boundary strengths and is penalised for
        # large movement: a big shift means we may have latched onto a figure
        # edge rather than a real rule.
        conf = float(np.mean([cx, cy, crx, cby]))
        conf *= float(np.clip(1.0 - shift / max(radius * 1.5, 1.0), 0.0, 1.0))

        alpha = p["alpha"] or layout.alpha_mode
        layout.panels.append(Panel(
            index=i, label=p["label"], x=int(nx), y=int(ny), w=int(w), h=int(h),
            group=p["group"], alpha_mode=alpha, confidence=round(conf, 3),
            notes=("shift=%dpx" % shift) if shift else "",
        ))
    return layout


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description="Derive panel layouts for the reference sheets.")
    ap.add_argument("--source", default=None, help="directory holding the source PNGs")
    ap.add_argument("--out", default=LAYOUTS_PATH, help="where to write layouts.json")
    ap.add_argument("--snap-radius", type=int, default=14,
                    help="how far a seeded boundary may move to find real evidence "
                         "(default 14px; larger snaps risk locking onto artwork)")
    ap.add_argument("--verbose", action="store_true")
    args = ap.parse_args(argv)

    src = resolve_source_dir(args.source)
    layouts = {}
    print("source directory: %s" % src)
    print("snap radius: %dpx\n" % args.snap_radius)
    print("%-52s %5s %6s %8s %8s %7s" %
          ("sheet", "panels", "ref?", "meanConf", "minConf", "shiftP95"))
    print("-" * 92)

    for sheet, spec in SPEC.items():
        path = os.path.join(src, sheet)
        if not os.path.exists(path):
            print("  !! missing: %s" % sheet)
            continue
        img = read_image(path)
        layout = build_sheet(sheet, img, spec, args.snap_radius)
        layouts[sheet] = layout.to_json()

        confs = np.array([p.confidence for p in layout.panels]) if layout.panels else np.array([0.0])
        shifts = []
        for p in layout.panels:
            if p.notes.startswith("shift="):
                shifts.append(int(p.notes.split("=")[1].rstrip("px")))
        shifts = shifts or [0]
        print("%-52s %5d %6s %8.3f %8.3f %7d" % (
            sheet[:52], len(layout.panels), "yes" if layout.is_reference else "NO",
            confs.mean(), confs.min(), int(np.percentile(shifts, 95))))

        if args.verbose:
            for p in layout.panels:
                print("      %-24s x=%4d y=%4d w=%4d h=%4d  conf=%.2f %s" %
                      (p.label, p.x, p.y, p.w, p.h, p.confidence, p.notes))

    save_json(args.out, dict(
        generated_by="build_layouts.py",
        snap_radius=args.snap_radius,
        note=("Panel rectangles were seeded from structure read off the sheets, "
              "then snapped to measured cell-rule evidence. `confidence` is the "
              "strength of that evidence; low values mean the rectangle follows "
              "the seed rather than the artwork."),
        sheets=layouts,
    ))
    n = sum(len(v["panels"]) for v in layouts.values())
    print("\nwrote %s (%d sheets, %d panels)" % (args.out, len(layouts), n))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())