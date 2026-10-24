"""
continuity.py - compare a generated shot against a reference for drift.

WHAT THIS IS FOR
----------------
The production brief requires side-by-side reference-vs-generated comparison and
forbids "character art silently drifting between scenes". This module produces
the numbers for that review, and - just as importantly - states clearly which
kinds of drift it can and cannot see.

WHAT IS MEASURED
----------------
  palette_distance   Earth Mover's Distance between the two images' colour
                     distributions, computed in RGB. EMD is the right metric
                     here rather than a histogram intersection because it
                     respects *how far* colours moved: a character's sweater
                     shifting from cream to beige is a small, tolerable move,
                     while shifting to green is a large one, and L1 histogram
                     distance rates those identically. We solve the small
                     transport problem with a few iterations of the classic
                     Sinkhorn-style scaling, which is enough for 2 x (a few
                     hundred) bins and needs no scipy.
  silhouette_iou     Shape agreement of the figure masks, after aligning the two
                     images. This is the main structural signal.
  aspect_ratio_delta |bw/bh of A minus bw/bh of B| - the cheap, honest proxy for
                     "unexpected extra appendage".
  area_ratio         1 - min/max of the two silhouette areas.
  perceptual         Mean absolute difference in CIE-Lab, which is far closer to
                     human sensitivity than RGB differencing.

THE APPENDAGE PROXY, STATED PLAINLY
-----------------------------------
The brief asks us to try to catch "unexpected extra limbs/appendages". Detecting
a sixth limb requires knowing what a limb is; nothing in this toolkit segments
body parts, so we do NOT claim to detect extra limbs. What we do instead is
measure the two signatures an extra appendage leaves on the whole silhouette:

  * bounding-box aspect ratio (an extra arm out to the side widens the box)
  * silhouette area ratio (an extra limb adds area)

A large deviation in either is a *prompt to look* - it is not a diagnosis. This
proxy has two honest failure modes and the report says so:
  * it MISSES an appendage that fits inside the existing silhouette (e.g. an
    extra arm held tight to the body, or a fourth leg behind the others)
  * it FIRES on legitimate pose or framing differences, which is why the
    thresholds are configurable and the verdict is advisory

A reference turnaround front view and a laughing expression sheet head *should*
differ in both area and aspect ratio. The tool reports that difference with its
numbers rather than pretending it is a defect.
"""

from __future__ import annotations

import argparse
import json
import os
import sys

import cv2
import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from extraction_core import hex_of, load_json, read_image, save_json  # noqa: E402

# Configurable thresholds. Defaults are deliberately loose because these sheets
# are reference artwork, not matched renders: a legitimate change of pose moves
# the silhouette far more than a rendering slip does. Tighten them for
# frame-to-frame work, where the camera and pose are meant to be identical.
DEFAULT_THRESHOLDS = dict(
    palette_emd=0.22,        # normalised EMD, 0 = identical palettes
    silhouette_iou=0.62,     # below this, the shapes disagree substantially
    aspect_ratio_delta=0.35, # |AR_a - AR_b|; the appendage proxy
    area_ratio=0.45,         # 1 - min/max area; the appendage proxy
    perceptual_lab=26.0,     # mean dE; above this the images look different
)


# --------------------------------------------------------------------------
# Loading and alignment
# --------------------------------------------------------------------------
def load_bgra_or_rgb(path: str):
    """Load an image, returning (bgr, alpha). Alpha is None for 3-channel input."""
    raw = cv2.imread(path, cv2.IMREAD_UNCHANGED)
    if raw is None:
        raise FileNotFoundError(path)
    if raw.ndim == 3 and raw.shape[2] == 4:
        return raw[:, :, :3], raw[:, :, 3]
    if raw.ndim == 2:
        return cv2.cvtColor(raw, cv2.COLOR_GRAY2BGR), None
    return raw[:, :, :3], None


def silhouette(bgr, alpha, bg_tol: int = 26) -> np.ndarray:
    """Boolean mask of 'this is the subject'.

    If the image carries real alpha we trust it - that is the whole point of
    having extracted a matte. If not, we fall back to distance from the median
    border colour, which is the same assumption the extractor makes and keeps
    the two tools consistent.
    """
    if alpha is not None and not np.all(alpha == 255):
        return alpha >= 128
    h, w = bgr.shape[:2]
    ring = np.concatenate([bgr[0:3].reshape(-1, 3), bgr[h - 3:h].reshape(-1, 3),
                           bgr[:, 0:3].reshape(-1, 3), bgr[:, w - 3:w].reshape(-1, 3)])
    bg = np.median(ring, axis=0).astype(np.float32)
    return np.abs(bgr.astype(np.float32) - bg).max(axis=2) > bg_tol


def align_pair(ref_bgr, ref_mask, gen_bgr, gen_mask, size=(512, 512)):
    """Scale both to a common canvas and align by silhouette centroid.

    WHY centroid rather than raw scaling to the same box: if the generated shot
    is framed slightly differently, scaling each to fill the canvas would
    *manufacture* a shape match. Aligning centres and scaling by the silhouette's
    own bounding-box diagonal normalises for size while preserving genuine shape
    differences, which is what IoU is supposed to measure.

    We deliberately do NOT do a full affine/registration fit: a fit that is free
    to rotate and shear would absorb real pose drift and hide the very thing we
    are trying to detect.
    """
    out = []
    for bgr, mask in ((ref_bgr, ref_mask), (gen_bgr, gen_mask)):
        ys, xs = np.where(mask)
        if len(xs) < 10:
            # Degenerate: no subject found. Fall back to plain resize so the
            # comparison still produces numbers (and they will be bad, rightly).
            b = cv2.resize(bgr, size, interpolation=cv2.INTER_AREA)
            m = cv2.resize(mask.astype(np.uint8), size,
                           interpolation=cv2.INTER_NEAREST).astype(bool)
            out.append((b, m))
            continue
        x0, x1, y0, y1 = xs.min(), xs.max(), ys.min(), ys.max()
        diag = float(np.hypot(x1 - x0, y1 - y0))
        if diag < 4:
            diag = 4.0
        # Scale so the subject's diagonal becomes 70% of the canvas diagonal.
        target = 0.70 * float(np.hypot(*size))
        scale = target / diag
        M = cv2.getRotationMatrix2D(((x0 + x1) / 2.0, (y0 + y1) / 2.0), 0.0, scale)
        M[0, 2] += size[0] / 2.0 - (x0 + x1) / 2.0
        M[1, 2] += size[1] / 2.0 - (y0 + y1) / 2.0
        b = cv2.warpAffine(bgr, M, size, flags=cv2.INTER_AREA,
                           borderMode=cv2.BORDER_REPLICATE)
        m = cv2.warpAffine(mask.astype(np.uint8), M, size,
                           flags=cv2.INTER_NEAREST).astype(bool)
        out.append((b, m))
    return out[0][0], out[0][1], out[1][0], out[1][1]


# --------------------------------------------------------------------------
# Metrics
# --------------------------------------------------------------------------
def palette_distribution(bgr, mask, bins: int = 6) -> np.ndarray:
    """Normalised 3-D RGB histogram over the subject only."""
    px = bgr[mask] if mask.any() else bgr.reshape(-1, 3)
    if len(px) == 0:
        return np.zeros((bins ** 3,), np.float64)
    q = np.clip((px[:, ::-1].astype(np.float32) / 256.0 * bins).astype(int), 0, bins - 1)
    idx = (q[:, 0] * bins + q[:, 1]) * bins + q[:, 2]
    h = np.bincount(idx, minlength=bins ** 3).astype(np.float64)
    s = h.sum()
    return h / s if s > 0 else h


def emd_rgb(hist_a: np.ndarray, hist_b: np.ndarray, bins: int = 6,
            iters: int = 200) -> float:
    """Earth Mover's Distance between two binned colour distributions.

    We compute the ground distance as Euclidean distance between bin centres in
    RGB, normalised so the metric lands in a human-readable 0..1 range. The
    transport problem is solved by Sinkhorn iteration (entropic regularisation),
    which converges in a few dozen iterations at this size and avoids pulling in
    scipy for one function. The regularisation epsilon trades accuracy for
    stability; 0.02 in normalised units is small enough that the smoothed
    solution tracks the true EMD closely for our purpose (comparing distances to
    a threshold, not reporting an absolute physical quantity).
    """
    a = hist_a / max(hist_a.sum(), 1e-12)
    b = hist_b / max(hist_b.sum(), 1e-12)

    centres = np.stack(np.meshgrid(
        (np.arange(bins) + 0.5) / bins,
        (np.arange(bins) + 0.5) / bins,
        (np.arange(bins) + 0.5) / bins, indexing="ij"), -1).reshape(-1, 3)
    # Max possible RGB distance is sqrt(3).
    C = np.linalg.norm(centres[:, None, :] - centres[None, :, :], axis=2) / np.sqrt(3.0)

    eps = 0.02
    K = np.exp(-C / eps)
    u = np.ones_like(a)
    v = np.ones_like(b)
    for _ in range(iters):
        u = a / np.maximum(K @ v, 1e-300)
        v = b / np.maximum(K.T @ u, 1e-300)
    P = u[:, None] * K * v[None, :]
    return float((P * C).sum())


def lab_mean_absdiff(bgr_a, mask_a, bgr_b, mask_b) -> float:
    """Mean absolute CIE-Lab difference over the union of both subjects.

    Lab is used because it is approximately perceptually uniform: a dE of 26
    means 'clearly different colours', whereas the same numeric difference in
    RGB could be imperceptible or glaring depending on where in the cube it
    falls. Compared on the union of masks so that a missing region (one image
    has a limb the other does not) counts as a large difference rather than
    being silently excluded.
    """
    la = cv2.cvtColor(bgr_a, cv2.COLOR_BGR2LAB).astype(np.float32)
    lb = cv2.cvtColor(bgr_b, cv2.COLOR_BGR2LAB).astype(np.float32)
    union = mask_a | mask_b
    if not union.any():
        return 0.0
    return float(np.abs(la[union] - lb[union]).mean())


def bbox_aspect(mask) -> float:
    ys, xs = np.where(mask)
    if len(xs) < 4:
        return 0.0
    w = xs.max() - xs.min() + 1
    h = ys.max() - ys.min() + 1
    return float(w) / float(max(h, 1))


def compare(reference_png: str, generated_png: str,
            thresholds: dict | None = None, size=(512, 512)) -> dict:
    """Compare two images and return metrics plus a verdict."""
    thr = dict(DEFAULT_THRESHOLDS)
    if thresholds:
        thr.update(thresholds)

    rb, ra = load_bgra_or_rgb(reference_png)
    gb, ga = load_bgra_or_rgb(generated_png)
    rm = silhouette(rb, ra)
    gm = silhouette(gb, ga)

    ra_ar = bbox_aspect(rm)
    ga_ar = bbox_aspect(gm)
    ra_area = int(rm.sum())
    ga_area = int(gm.sum())

    ab, am, bb, bm = align_pair(rb, rm, gb, gm, size)

    inter = np.logical_and(am, bm).sum()
    union = np.logical_or(am, bm).sum()
    iou = float(inter) / float(union) if union else 0.0

    ha = palette_distribution(ab, am)
    hb = palette_distribution(bb, bm)
    emd = emd_rgb(ha, hb)
    dlab = lab_mean_absdiff(ab, am, bb, bm)

    ar_delta = abs(ra_ar - ga_ar)
    if ra_area and ga_area:
        area_ratio = 1.0 - min(ra_area, ga_area) / float(max(ra_area, ga_area))
    else:
        area_ratio = 1.0

    checks = {
        "palette": dict(value=round(emd, 4), threshold=thr["palette_emd"],
                        passed=emd <= thr["palette_emd"],
                        note="normalised EMD in RGB; 0 = identical palettes"),
        "silhouette": dict(value=round(iou, 4), threshold=thr["silhouette_iou"],
                           passed=iou >= thr["silhouette_iou"],
                           note="IoU of aligned subject masks"),
        "aspect_ratio": dict(value=round(ar_delta, 4),
                             threshold=thr["aspect_ratio_delta"],
                             passed=ar_delta <= thr["aspect_ratio_delta"],
                             note="|AR_ref - AR_gen|; appendage PROXY, not detection"),
        "area": dict(value=round(area_ratio, 4), threshold=thr["area_ratio"],
                     passed=area_ratio <= thr["area_ratio"],
                     note="1 - min/max silhouette area; appendage PROXY"),
        "perceptual": dict(value=round(dlab, 3), threshold=thr["perceptual_lab"],
                           passed=dlab <= thr["perceptual_lab"],
                           note="mean |dLab| over the union of masks"),
    }
    failed = [k for k, v in checks.items() if not v["passed"]]

    return dict(
        reference=os.path.abspath(reference_png),
        generated=os.path.abspath(generated_png),
        verdict="PASS" if not failed else "REVIEW",
        failed_checks=failed,
        reference_stats=dict(
            size=[int(rb.shape[1]), int(rb.shape[0])],
            had_alpha=ra is not None,
            silhouette_px=ra_area, aspect_ratio=round(ra_ar, 4),
            mean_colour=hex_of(rb[rm].mean(axis=0)) if rm.any() else None,
        ),
        generated_stats=dict(
            size=[int(gb.shape[1]), int(gb.shape[0])],
            had_alpha=ga is not None,
            silhouette_px=ga_area, aspect_ratio=round(ga_ar, 4),
            mean_colour=hex_of(gb[gm].mean(axis=0)) if gm.any() else None,
        ),
        metrics=checks,
        thresholds=thr,
        limitations=[
            "Extra-limb detection is a PROXY only: bounding-box aspect ratio and "
            "silhouette area. It CANNOT detect an appendage contained within the "
            "existing silhouette (a sixth limb held against the body, or one "
            "occluded by another).",
            "The proxy FIRES on legitimate pose and framing differences. A "
            "turnaround front view versus a laughing head WILL fail area and "
            "aspect ratio; that is the measurement working, not a defect.",
            "IoU here is shape agreement after size normalisation, not identity. "
            "Two different characters of similar build can score high.",
            "Nothing here evaluates facial identity, costume detail changes "
            "smaller than a colour bin, or anything semantic. It is a triage "
            "tool to point a human at likely drift, not a pass/fail oracle.",
        ],
    )


def format_report(res: dict) -> str:
    L = []
    L.append("reference : %s" % res["reference"])
    L.append("generated : %s" % res["generated"])
    rs, gs = res["reference_stats"], res["generated_stats"]
    L.append("  ref  %dx%d  alpha=%-5s  silhouette=%7d px  AR=%.3f  mean %s"
             % (rs["size"][0], rs["size"][1], rs["had_alpha"], rs["silhouette_px"],
                rs["aspect_ratio"], rs["mean_colour"]))
    L.append("  gen  %dx%d  alpha=%-5s  silhouette=%7d px  AR=%.3f  mean %s"
             % (gs["size"][0], gs["size"][1], gs["had_alpha"], gs["silhouette_px"],
                gs["aspect_ratio"], gs["mean_colour"]))
    L.append("")
    L.append("  %-14s %10s %10s  %s" % ("metric", "value", "threshold", "result"))
    L.append("  " + "-" * 66)
    for name, c in res["metrics"].items():
        L.append("  %-14s %10.4f %10.4f  %s"
                 % (name, c["value"], c["threshold"],
                    "ok" if c["passed"] else "FAIL"))
    L.append("")
    for name, c in res["metrics"].items():
        L.append("  %-14s %s" % (name, c["note"]))
    L.append("")
    L.append("VERDICT: %s%s" % (res["verdict"],
             "" if res["verdict"] == "PASS"
             else "  (failed: %s)" % ", ".join(res["failed_checks"])))
    return "\n".join(L)


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(
        description="Compare a generated shot against a reference for continuity drift.")
    ap.add_argument("--reference", help="reference PNG")
    ap.add_argument("--generated", help="generated PNG")
    ap.add_argument("--pair", nargs=2, action="append", metavar=("REF", "GEN"),
                    help="additional pair (repeatable)")
    ap.add_argument("--palette-emd", type=float, default=DEFAULT_THRESHOLDS["palette_emd"])
    ap.add_argument("--silhouette-iou", type=float, default=DEFAULT_THRESHOLDS["silhouette_iou"])
    ap.add_argument("--aspect-ratio-delta", type=float, default=DEFAULT_THRESHOLDS["aspect_ratio_delta"])
    ap.add_argument("--area-ratio", type=float, default=DEFAULT_THRESHOLDS["area_ratio"])
    ap.add_argument("--perceptual-lab", type=float, default=DEFAULT_THRESHOLDS["perceptual_lab"])
    ap.add_argument("--out", default=None, help="write the JSON report here")
    args = ap.parse_args(argv)

    thr = dict(palette_emd=args.palette_emd, silhouette_iou=args.silhouette_iou,
               aspect_ratio_delta=args.aspect_ratio_delta,
               area_ratio=args.area_ratio, perceptual_lab=args.perceptual_lab)

    pairs = list(args.pair or [])
    if args.reference and args.generated:
        pairs.insert(0, [args.reference, args.generated])
    if not pairs:
        ap.error("supply --reference/--generated or at least one --pair")

    results = []
    worst = "PASS"
    for i, (ref, gen) in enumerate(pairs):
        if i:
            print()
        res = compare(ref, gen, thr)
        print(format_report(res))
        results.append(res)
        if res["verdict"] != "PASS":
            worst = "REVIEW"

    if args.out:
        save_json(args.out, dict(generated_by="continuity.py", thresholds=thr,
                                 pairs=results))
        print("\nwrote %s" % args.out)
    return 0 if worst == "PASS" else 1


if __name__ == "__main__":
    raise SystemExit(main())