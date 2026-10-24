"""
extract.py - cut panels out of the Bad Example reference sheets and matte the
flat page background away to alpha.

WHY THE MATTE IS BUILT THE WAY IT IS
------------------------------------
The sheets are flat RGB composites: a warm beige page, with each panel drawn on
top. There is no source alpha, so any transparency we produce is *inferred*.
Three specific hazards drove the design, and each is called out at the code
that handles it:

  1. The page background is NOT one colour. Sampling sheet 01 gives corner
     #C4BAAF, mid #C8BEB2, far corner #C9BFB4, with a soft vignette between.
     A single background colour therefore leaves a visible halo on one side of
     every panel. We fit a smooth polynomial surface instead
     (`estimate_gradient_background`).

  2. Hard thresholding destroys the anti-aliased ink edge and turns it into
     jaggies. We use a soft ramp, alpha = clamp((d - lo)/(hi - lo)), so
     partially-inked pixels keep partial alpha and the edge stays smooth.

  3. THE BIG ONE: the thick black outline must not be eaten. The outline is the
     darkest thing on the sheet, so a distance-from-background matte should
     keep it easily - but the morphology used to clean the matte can erode it,
     and the hair (a very dark warm brown, close to the outline in luminance) is
     the place where the two get confused. So after matting we *measure*
     outline retention and, if the matte lost more than a small fraction of the
     ink, we report it loudly rather than shipping a quiet failure.

WHAT THIS OUTPUT IS
-------------------
Reference-grade masks. Not production-clean rig layers. The figures sit on a
flat page with no internal separation, so each panel yields ONE flat matte of
the whole figure (hair, horns, clothes and linework as a single silhouette).
There is no arm/leg/head layering here and none is implied. See README.md.
"""

from __future__ import annotations

import argparse
import os
import sys

import cv2
import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from extraction_core import (  # noqa: E402
    DEFAULT_OUT_DIR, LAYOUTS_PATH, OUTLINE_MIN_ALPHA_RETAINED, Panel, SheetLayout,
    alpha_to_bgra, background_neutral_for, clean_alpha, ensure_dir,
    estimate_flat_background, estimate_gradient_background, hex_of, load_json,
    outline_retention, read_image, resolve_source_dir, save_json,
)


# --------------------------------------------------------------------------
# Matte parameter presets.
#
# WHY PRESETS RATHER THAN ONE SETTING: sheet 06 is a storyboard whose cells
# contain real painted backgrounds. Matteing those against the page beige would
# delete the scenery and keep only the figures, which is not what a storyboard
# crop is for. Making that an explicit, named mode is better than a flag buried
# in an argument list.
# --------------------------------------------------------------------------
PRESETS = {
    # Reference sheets 01-04: flat page, line art, want a clean cut-out.
    "reference": dict(t_lo=9.0, t_hi=22.0, close_radius=2, open_radius=0,
                      min_blob=14, keep_largest=True, unassociate=True),
    # Storyboards: crop only, keep everything (no background to remove).
    "crop": dict(t_lo=0.0, t_hi=1.0, close_radius=0, open_radius=0,
                 min_blob=0, keep_largest=False, unassociate=False, off=True),
}


def panel_alpha(img: np.ndarray, rect, bg_model, preset: dict):
    """Compute the soft alpha for one panel.

    We matte the CROP, not the whole sheet, and that is deliberate: the
    background surface has already been fitted globally (so it knows about the
    page's drift), but evaluating it only over the crop keeps the array sizes
    small and means a neighbouring panel's artwork can never leak in.
    """
    x, y, w, h = rect
    x = max(0, min(x, img.shape[1] - 2))
    y = max(0, min(y, img.shape[0] - 2))
    w = max(1, min(w, img.shape[1] - x))
    h = max(1, min(h, img.shape[0] - y))
    crop = img[y:y + h, x:x + w]

    if preset.get("off"):
        return crop, np.ones((h, w), np.float32), (x, y, w, h)

    a = bg_model.alpha(crop, t_lo=preset["t_lo"], t_hi=preset["t_hi"])
    a = clean_alpha(a, min_blob=preset["min_blob"],
                    close_radius=preset["close_radius"],
                    open_radius=preset["open_radius"],
                    keep_largest=preset["keep_largest"])
    return crop, a, (x, y, w, h)


def process_sheet(sheet: str, layout: SheetLayout, img: np.ndarray,
                  out_root: str, preset_name: str, verbose: bool):
    """Extract every panel of one sheet. Returns (records, summary)."""
    preset = PRESETS[preset_name]

    # --- Background model -------------------------------------------------
    bg_model = None
    bg_desc = "n/a (crop-only)"
    if not preset.get("off"):
        if layout.background_mode == "gradient":
            bg_model = estimate_gradient_background(img)
            bg_desc = ("polynomial(deg=%d) over %s, 95th-pct residual %.1f levels"
                       % (bg_model.poly_degree, hex_of(bg_model.colour),
                          bg_model.residual_p95))
        elif layout.background_mode == "flat":
            bg_model = estimate_flat_background(img)
            bg_desc = "flat %s" % hex_of(bg_model.colour)
        else:
            bg_model = estimate_flat_background(img)
            bg_desc = "flat(fallback) %s" % hex_of(bg_model.colour)

    sheet_dir = ensure_dir(os.path.join(out_root, os.path.splitext(sheet)[0]))
    records = []

    for p in layout.panels:
        crop, alpha, rect = panel_alpha(img, p.rect(), bg_model, preset)
        h, w = alpha.shape

        ret = outline_retention(crop, alpha)

        # Colour handling: undo the background blend on partial-alpha pixels so
        # the edge does not fringe beige once composited. Only meaningful when
        # we actually matted.
        if bg_model is not None and preset.get("unassociate"):
            out_bgr = unassociate_against(crop, alpha, bg_model)
        else:
            out_bgr = crop

        bgra = alpha_to_bgra(out_bgr, alpha)

        # index_label.png keeps the panels sortable in a file browser and
        # self-describing without the manifest.
        fname = "%03d_%s.png" % (p.index, sanitise(p.label))
        out_path = os.path.join(sheet_dir, fname)
        cv2.imwrite(out_path, bgra)

        frac = float((alpha > 0.5).mean())
        rec = dict(
            sheet=sheet, index=p.index, label=p.label, group=p.group,
            file=os.path.relpath(out_path, out_root).replace("\\", "/"),
            source_rect=dict(x=rect[0], y=rect[1], w=rect[2], h=rect[3]),
            size=dict(w=w, h=h),
            alpha_mode=p.alpha_mode if not preset.get("off") else "none",
            layout_confidence=p.confidence,
            layout_notes=p.notes,
            fg_fraction=round(frac, 4),
            outline_px=ret["outline_px"],
            outline_retained_px=ret["retained_px"],
            outline_retention=(None if ret["retention"] is None
                               else round(ret["retention"], 4)),
            mean_alpha_on_outline=(None if ret["mean_alpha_on_outline"] is None
                                   else round(ret["mean_alpha_on_outline"], 4)),
        )
        records.append(rec)

        # Live warning for the specific failure the brief flags. We do not
        # silently "fix" it: if the matte ate the outline, the honest move is to
        # say so with the number.
        if ret["retention"] is not None and ret["retention"] < OUTLINE_MIN_ALPHA_RETAINED:
            if verbose:
                print("      ! outline retention %.1f%% on %s (below %.0f%% gate)"
                      % (ret["retention"] * 100, p.label,
                         OUTLINE_MIN_ALPHA_RETAINED * 100))

    return records, dict(background=bg_desc, sheet_dir=sheet_dir,
                         preset=preset_name)


def unassociate_against(crop, alpha, bg_model):
    """Recover foreground colour on partial-alpha pixels.

    A pixel observed on the composite is  obs = a*fg + (1-a)*bg  with bg known
    per-pixel from the fitted surface, so fg = (obs - (1-a)*bg)/a. Skipping this
    is why naive extractions show a pale halo when placed on a dark background:
    the stored RGB still contains the beige, and the compositor blends the beige
    in a second time.
    """
    a = np.clip(alpha, 0.0, 1.0)[..., None]
    bg = bg_model.evaluate(crop)
    f = crop.astype(np.float32)
    # Only trust the division where alpha is large enough for it to be stable;
    # at alpha->0 the result is meaningless and the pixel is invisible anyway.
    safe = a > 0.15
    fg = np.where(safe, (f - (1.0 - a) * bg) / np.maximum(a, 1e-3), f)
    return np.clip(fg, 0, 255).astype(np.uint8)


def sanitise(label: str) -> str:
    keep = [c if (c.isalnum() or c in "-_") else "_" for c in label]
    return "".join(keep).strip("_") or "panel"


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(
        description="Extract panels from the reference sheets to transparent PNGs.")
    ap.add_argument("--source", default=None, help="directory holding the sheets")
    ap.add_argument("--layouts", default=LAYOUTS_PATH, help="layouts.json to consume")
    ap.add_argument("--out", default=DEFAULT_OUT_DIR, help="output root for extracted PNGs")
    ap.add_argument("--sheets", default=None,
                    help="comma-separated sheet filenames to limit the run")
    ap.add_argument("--preset", default=None,
                    choices=sorted(PRESETS), help="override the matte preset for all sheets")
    ap.add_argument("--dry-run", action="store_true", help="report without writing PNGs")
    ap.add_argument("--verbose", action="store_true")
    args = ap.parse_args(argv)

    src = resolve_source_dir(args.source)
    layouts = load_json(args.layouts)["sheets"]
    wanted = None
    if args.sheets:
        wanted = {s.strip() for s in args.sheets.split(",") if s.strip()}

    ensure_dir(args.out)
    manifest_sheets = []
    print("source : %s" % src)
    print("output : %s" % args.out)
    print("layouts: %s\n" % args.layouts)

    total_panels = 0
    grand_outline = [0, 0]
    for sheet, ld in layouts.items():
        if wanted and sheet not in wanted:
            continue
        path = os.path.join(src, sheet)
        if not os.path.exists(path):
            print("!! missing source sheet: %s" % sheet)
            continue
        img = read_image(path)
        layout = SheetLayout.from_json(ld)
        # Preset choice follows what the layout says about the sheet, not just
        # the is_reference flag. Sheet 06 is technically a reference (it is a
        # real storyboard board) but its cells contain painted scenery, so it
        # must be crop-only. Trusting the per-sheet alpha_mode keeps that
        # decision in one place - layouts.json - instead of duplicating it here.
        preset_name = args.preset or (
            "crop" if (not layout.is_reference or layout.alpha_mode == "none"
                       or layout.background_mode == "none") else "reference")

        if args.dry_run:
            print("%-52s %3d panels (dry-run, preset=%s)"
                  % (sheet[:52], len(layout.panels), preset_name))
            continue

        records, info = process_sheet(sheet, layout, img, args.out, preset_name,
                                      args.verbose)

        rets = [r["outline_retention"] for r in records if r["outline_retention"] is not None]
        px = sum(r["outline_px"] for r in records)
        kept = sum(r["outline_retained_px"] for r in records)
        grand_outline[0] += px
        grand_outline[1] += kept
        fgs = [r["fg_fraction"] for r in records]

        print("%-52s %3d panels  preset=%-9s fg=%.1f-%.1f%%  outline kept %s"
              % (sheet[:52], len(records), preset_name,
                 100 * min(fgs) if fgs else 0, 100 * max(fgs) if fgs else 0,
                 ("%.1f%%" % (100 * kept / px)) if px else "n/a"))
        if args.verbose:
            print("      background: %s" % info["background"])
            print("      -> %s" % info["sheet_dir"])

        total_panels += len(records)
        manifest_sheets.append(dict(
            sheet=sheet, title=layout.title, is_reference=layout.is_reference,
            background=info["background"], preset=preset_name,
            panel_count=len(records), panels=records,
        ))

    if args.dry_run:
        return 0

    manifest = dict(
        generated_by="extract.py",
        source_dir=src,
        note=("Extractions are reference-grade mattes of a flat composite sheet. "
              "Each panel is a single flat silhouette of the whole figure; there "
              "is no limb/part separation. Expect to hand-clean before rigging."),
        outline_gate=OUTLINE_MIN_ALPHA_RETAINED,
        totals=dict(
            panels=total_panels,
            outline_px=grand_outline[0],
            outline_retained_px=grand_outline[1],
            outline_retention_overall=(round(grand_outline[1] / grand_outline[0], 4)
                                       if grand_outline[0] else None),
        ),
        sheets=manifest_sheets,
    )
    mpath = os.path.join(args.out, "manifest.json")
    save_json(mpath, manifest)
    print("\nwrote %d panels across %d sheets" % (total_panels, len(manifest_sheets)))
    print("manifest: %s" % mpath)
    if grand_outline[0]:
        print("outline retention overall: %.2f%% of %d ink px"
              % (100 * grand_outline[1] / grand_outline[0], grand_outline[0]))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())