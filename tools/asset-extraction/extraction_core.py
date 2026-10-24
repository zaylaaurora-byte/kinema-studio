"""
Shared core for the Bad Example reference-asset toolkit.

WHY THIS FILE EXISTS
--------------------
`extract.py`, `verify_extraction.py` and `palette.py` all need the same two
opinions about the source sheets:

  1. What counts as "background" on a flat reference sheet, and how do we turn
     the distance from it into an *anti-aliased* alpha rather than a hard cut?
  2. Where are the panels?

Keeping those in one module means the verifier cannot accidentally use a
different definition of "outline" or "background" than the extractor did. If
the two disagreed, the verification numbers would be meaningless.

MEASURED FACTS ABOUT THE SOURCE SHEETS (probed, not assumed)
-----------------------------------------------------------
These drove every threshold below. They were obtained by sampling the actual
pixels of `bad-example/*.png`, and they contradict the obvious assumptions:

  * Sheets 01/02/03/04/06 are 1536x1024 flat RGB composites. Their page
    background is a warm grey/beige around #C8BEB2 - and critically it is *not
    uniform*: a single sheet spans roughly #C4BAAF .. #CBC1B4, plus large soft
    vignettes. A single hard-coded background colour leaves a halo.
  * The individual cells are separated by black rules that are only ~1-2 px
    wide and frequently *broken* where a figure overlaps the rule. Longest
    continuous dark horizontal run found on sheet 01 was 137 px. There is no
    such thing as a clean full-width grid line to project onto.
  * Most cells are filled with a near-white panel colour that is only ~10-15
    levels away from the page beige. Naive "distance from background" matting
    therefore does not see cell edges at all.
  * Sheet 05 is NOT a reference sheet. Its corner pixel is #251C30 - a dark
    stage illustration with no flat background whatsoever, so there is nothing
    to remove and any "extraction" of it would be a lie. It is classified
    `is_reference=False` and skipped.
  * Sheet 06 is a storyboard: cells carry real illustrated backgrounds, so a
    global matte is wrong there too. It is extracted by crop only.

The consequence, stated plainly: on these sheets the *panel* is the reliable
primitive and the *figure* is not. Finding figures inside cells would require
semantic segmentation; we deliberately do not pretend to do that.
"""

from __future__ import annotations

import json
import os
from dataclasses import dataclass, asdict, field
from typing import Iterable, Sequence

import cv2
import numpy as np

# --------------------------------------------------------------------------
# Paths. Everything is resolved relative to this file so the toolkit can be
# run from any working directory.
# --------------------------------------------------------------------------
TOOLS_DIR = os.path.dirname(os.path.abspath(__file__))
KINEMA_ROOT = os.path.abspath(os.path.join(TOOLS_DIR, "..", ".."))
DEFAULT_SOURCE_DIR = os.path.join(KINEMA_ROOT, "projects", "bad-example", "reference")
DEFAULT_OUT_DIR = os.path.join(KINEMA_ROOT, "projects", "bad-example", "assets", "extracted")

# Some checkouts keep the sheets elsewhere; these are probed in order.
SOURCE_FALLBACKS = (
    DEFAULT_SOURCE_DIR,
    r"C:\Users\zayla\Documents\deepseek-harness\default-workspace\bad-example",
)

LAYOUTS_PATH = os.path.join(TOOLS_DIR, "layouts.json")
PROJECTS_PATH = os.path.join(TOOLS_DIR, "projects.json")


# --------------------------------------------------------------------------
# Small utilities
# --------------------------------------------------------------------------
def hex_of(bgr: Sequence[int]) -> str:
    """OpenCV is BGR; humans and CSS are RGB. Convert once, here."""
    b, g, r = (int(v) for v in bgr[:3])
    return "#%02X%02X%02X" % (r, g, b)


def bgr_of(hexstr: str) -> np.ndarray:
    h = hexstr.lstrip("#")
    return np.array([int(h[4:6], 16), int(h[2:4], 16), int(h[0:2], 16)], np.float32)


def read_image(path: str) -> np.ndarray:
    """cv2.imread returns None on failure and raises nothing, which makes
    downstream errors confusing. Fail loudly with the path instead."""
    im = cv2.imread(path, cv2.IMREAD_COLOR)
    if im is None:
        raise FileNotFoundError("could not read image: %s" % path)
    return im


def imwrite_png(path: str, bgra: np.ndarray) -> None:
    os.makedirs(os.path.dirname(path), exist_ok=True)
    if not cv2.imwrite(path, bgra):
        raise IOError("failed to write %s" % path)


def ensure_dir(path: str) -> str:
    os.makedirs(path, exist_ok=True)
    return path


def resolve_source_dir(explicit: str | None = None) -> str:
    if explicit:
        return explicit
    for cand in SOURCE_FALLBACKS:
        if os.path.isdir(cand) and any(
            f.lower().endswith(".png") for f in os.listdir(cand)
        ):
            return cand
    return DEFAULT_SOURCE_DIR


def load_json(path: str):
    with open(path, "r", encoding="utf-8") as fh:
        return json.load(fh)


def save_json(path: str, obj) -> None:
    ensure_dir(os.path.dirname(path))
    with open(path, "w", encoding="utf-8") as fh:
        json.dump(obj, fh, indent=2, sort_keys=False)
        fh.write("\n")


# --------------------------------------------------------------------------
# Background estimation
# --------------------------------------------------------------------------
@dataclass
class BackgroundModel:
    """An estimated page background.

    `mode` decides how `distance()` is computed:

      'flat'    - one colour, per-pixel max-abs deviation across BGR. Fast and
                  correct for sheet 06, which really is one flat colour.
      'gradient' - a low-order polynomial fit to the page background, evaluated
                  per pixel. Needed for sheets 01-04 because their beige drifts
                  by 10-20 levels across the sheet; a single colour would leave
                  a visible halo on one side.

    Thresholds are expressed as *signed* distances, not "distance > t":

        d <= T_lo   fully background   (alpha 0)
        d >= T_hi   fully content      (alpha 1)
        between     linear ramp        (alpha = (d-T_lo)/(T_hi-T_lo))

    The ramp is the whole point: hard-thresholding a matte turns every
    anti-aliased ink edge into a staircase, which is exactly the jaggies that
    make an extraction useless for compositing.
    """

    mode: str
    colour: tuple[float, float, float]          # BGR
    coeffs: list[float] | None = None           # polynomial, if mode == 'gradient'
    poly_degree: int = 2
    t_lo: float = 6.0
    t_hi: float = 16.0
    residual_p95: float = 0.0                   # fit quality, reported to the user

    def evaluate(self, bgr: np.ndarray) -> np.ndarray:
        """Per-pixel background colour, same shape as input."""
        if self.mode == "gradient" and self.coeffs is not None:
            h, w = bgr.shape[:2]
            ys, xs = np.mgrid[0:h, 0:w]
            xn = xs / max(w - 1, 1)
            yn = ys / max(h - 1, 1)
            base = np.empty((h, w, 3), np.float32)
            deg = self.poly_degree
            for c in range(3):
                acc = np.zeros((h, w), np.float32)
                k = 0
                for i in range(deg + 1):
                    for j in range(deg + 1 - i):
                        acc += self.coeffs[c][k] * (xn ** i) * (yn ** j)
                        k += 1
                base[:, :, c] = acc
            return base
        return np.broadcast_to(
            np.asarray(self.colour, np.float32), bgr.shape
        ).astype(np.float32)

    def distance(self, bgr: np.ndarray) -> np.ndarray:
        """Signed-ish deviation from background, in 0-255 levels.

        We use max-abs across channels rather than Euclidean distance because
        the background is a *colour* not a point in space: a pixel that is the
        right luminance but the wrong hue (e.g. pale skin vs beige page) must
        still read as content. Max-abs punishes any single channel moving.
        """
        f = bgr.astype(np.float32)
        return np.abs(f - self.evaluate(bgr)).max(axis=2)

    def alpha(self, bgr: np.ndarray, t_lo: float | None = None,
              t_hi: float | None = None, gamma: float = 1.0) -> np.ndarray:
        lo = self.t_lo if t_lo is None else t_lo
        hi = self.t_hi if t_hi is None else t_hi
        d = self.distance(bgr)
        a = (d - lo) / max(hi - lo, 1e-6)
        a = np.clip(a, 0.0, 1.0)
        if gamma != 1.0:
            # gamma < 1 thickens the ramp (keeps more faint edge); > 1 thins it.
            a = np.power(a, gamma)
        return a

    def to_json(self) -> dict:
        return dict(mode=self.mode, colour=[float(v) for v in self.colour],
                    coeffs=self.coeffs, poly_degree=self.poly_degree,
                    t_lo=self.t_lo, t_hi=self.t_hi,
                    residual_p95=self.residual_p95)


def estimate_flat_background(im: np.ndarray, ring: int = 4) -> BackgroundModel:
    """Median of the outer `ring` px. The page border of every reference sheet
    is background by construction, which makes the border ring a free and very
    robust background sample."""
    h, w = im.shape[:2]
    r = max(1, min(ring, h // 8, w // 8))
    samples = np.concatenate([
        im[0:r].reshape(-1, 3), im[h - r:h].reshape(-1, 3),
        im[:, 0:r].reshape(-1, 3), im[:, w - r:w].reshape(-1, 3),
    ]).astype(np.float32)
    med = np.median(samples, axis=0)
    return BackgroundModel(mode="flat", colour=tuple(float(v) for v in med),
                           t_lo=10.0, t_hi=26.0)


def estimate_gradient_background(im: np.ndarray, degree: int = 2,
                                 ring: int = 4, max_px: int = 400_000,
                                 robust_iters: int = 3) -> BackgroundModel:
    """Fit a low-order polynomial to the page background.

    WHY a polynomial: the beige drifts smoothly across these sheets (paper
    texture + vignette). A plane would not capture the corners, and per-tile
    constants would produce visible seams at tile boundaries. A degree-2 fit is
    smooth everywhere and has only 6 coefficients per channel, so it cannot
    overfit into the artwork.

    Robustness: we fit on all pixels that are currently *close* to the flat
    median, then re-fit, dropping pixels that the previous fit explains badly.
    Without this the dark outline pixels drag the surface down and the estimate
    starts eating the linework.
    """
    h, w = im.shape[:2]
    flat = estimate_flat_background(im, ring=ring)

    ys, xs = np.mgrid[0:h, 0:w]
    xn = (xs / max(w - 1, 1)).astype(np.float32).ravel()
    yn = (ys / max(h - 1, 1)).astype(np.float32).ravel()

    # Design matrix for a total-degree `degree` polynomial in (x, y).
    cols, terms = [], []
    for i in range(degree + 1):
        for j in range(degree + 1 - i):
            cols.append((xn ** i) * (yn ** j))
            terms.append((i, j))
    A = np.stack(cols, axis=1)
    del terms

    f = im.astype(np.float32).reshape(-1, 3)
    if f.shape[0] > max_px:                       # subsample purely for speed
        idx = np.random.RandomState(0).choice(f.shape[0], max_px, replace=False)
        As, fs = A[idx], f[idx]
    else:
        As, fs = A, f

    keep = np.abs(fs - flat.colour).max(axis=1) <= 22.0
    if keep.sum() < 1000:                        # pathological sheet
        keep = np.ones(fs.shape[0], bool)

    coeffs, resid = None, np.zeros(3)
    for _ in range(max(1, robust_iters)):
        Ak = As[keep]
        coeffs = []
        for c in range(3):
            sol, *_ = np.linalg.lstsq(Ak, fs[keep, c], rcond=None)
            coeffs.append(sol)
        pred = np.stack([As @ np.asarray(coeffs[c], np.float32) for c in range(3)], 1)
        resid = np.abs(pred - fs).max(axis=1)
        newkeep = resid <= max(12.0, np.percentile(resid, 70))
        if newkeep.sum() < 1000:
            break
        if np.array_equal(newkeep, keep):
            break
        keep = newkeep

    model = BackgroundModel(
        mode="gradient", colour=tuple(float(v) for v in flat.colour),
        coeffs=[[float(v) for v in c] for c in coeffs], poly_degree=degree,
        t_lo=10.0, t_hi=26.0,
    )
    # residual_p95 tells the user how well we actually modelled the paper. If
    # it is large, the matte deserves less trust - so we surface it.
    model.residual_p95 = float(np.percentile(resid[keep], 95)) if keep.any() else 0.0
    return model


# --------------------------------------------------------------------------
# Matte post-processing
# --------------------------------------------------------------------------
def clean_alpha(a: np.ndarray, min_blob: int = 12,
                close_radius: int = 1, open_radius: int = 0,
                keep_largest: bool = False) -> np.ndarray:
    """Morphological tidy-up of a soft alpha.

    ORDER MATTERS and is deliberate:
      1. CLOSE first (dilate then erode) - a 1px speckle gap inside a solid
         black outline is a *hole*, and closing fills it without moving the
         outer silhouette. Doing this after opening would re-introduce specks.
      2. OPEN (erode then dilate) - removes isolated background speckle that
         survived the ramp. Optional, because opening also shaves thin ink.
      3. Drop tiny connected components - stray matte noise.

    We deliberately do NOT use a hard threshold anywhere here; everything is
    done on the grayscale alpha so the ramp survives.
    """
    if close_radius > 0:
        k = cv2.getStructuringElement(cv2.MORPH_ELLIPSE,
                                      (2 * close_radius + 1,) * 2)
        a = cv2.morphologyEx(a, cv2.MORPH_CLOSE, k)
    if open_radius > 0:
        k = cv2.getStructuringElement(cv2.MORPH_ELLIPSE,
                                      (2 * open_radius + 1,) * 2)
        a = cv2.morphologyEx(a, cv2.MORPH_OPEN, k)

    if min_blob > 0:
        solid = (a > 0.5).astype(np.uint8)
        n, lab, stats, _ = cv2.connectedComponentsWithStats(solid, 8)
        if n > 2:
            order = np.argsort(-stats[1:, cv2.CC_STAT_AREA]) + 1
            if keep_largest:
                order = order[:1]
            kill = [i for i in order if stats[i, cv2.CC_STAT_AREA] < min_blob]
            if kill:
                mask = np.isin(lab, kill)
                a = a.copy()
                a[mask] = 0.0
    return np.clip(a, 0.0, 1.0)


def alpha_to_bgra(bgr: np.ndarray, alpha: np.ndarray) -> np.ndarray:
    """Pack into BGRA. Colour channels are left untouched, including where
    alpha==0: premultiplying or zeroing RGB there destroys the anti-aliased
    edge colour and is a classic cause of dark fringing on compositing."""
    a = np.clip(alpha * 255.0, 0, 255).astype(np.uint8)
    return np.dstack([bgr, a])


def unassociate_rgb(bgr: np.ndarray, alpha: np.ndarray,
                    bg_bgr: np.ndarray | None = None) -> np.ndarray:
    """Recover the *true* foreground colour on partially transparent pixels.

    WHY: the source PNGs are flat composites, so a pixel at alpha=0.5 is
    literally `0.5*fg + 0.5*bg`. If we ship that RGB next to alpha=0.5, any
    compositor applies alpha again and the edge comes out too light AND carries
    a beige tint. Solving fg = (observed - (1-a)*bg) / a removes both.

    `bg_bgr` may be a single colour or a per-pixel array of the same shape as
    `bgr`, which lets callers pass the fitted background surface. We only do
    this where alpha is meaningfully above zero; near alpha=0 the division is
    numerically hopeless and the colour is invisible anyway.
    """
    a = np.clip(alpha, 0.0, 1.0)[..., None]
    bg = (BACKGROUND_NEUTRAL if bg_bgr is None
          else np.asarray(bg_bgr, np.float32))
    safe = a > 0.15
    fg = np.where(safe,
                  (bgr.astype(np.float32) - (1.0 - a) * bg) / np.maximum(a, 1e-3),
                  bgr.astype(np.float32))
    return np.clip(fg, 0, 255).astype(np.uint8)


def background_neutral_for(hexstr: str) -> np.ndarray:
    """BGR float array for a background hex, used as the fallback blend target."""
    return bgr_of(hexstr)


# Placeholder used only by unassociate_rgb; callers that care pass their own.
BACKGROUND_NEUTRAL = np.array([178.0, 190.0, 200.0], np.float32)  # BGR of #C8BEB2


# --------------------------------------------------------------------------
# Outline metrics - shared by extract (as a guard) and verify (as a check)
# --------------------------------------------------------------------------
# These constants encode the specific failure the brief warns about, so they
# live in exactly one place.
OUTLINE_MAX_CHANNEL = 90     # a pixel this dark in every channel is ink
OUTLINE_MIN_ALPHA_RETAINED = 0.92   # if we drop >8% of ink pixels, the matte ate
                                    # the linework; this is the headline check.


def outline_mask(bgr: np.ndarray, thresh: int = OUTLINE_MAX_CHANNEL) -> np.ndarray:
    """Boolean mask of dark linework.

    WHY max-channel < t rather than luminance: the hair here is a very dark
    warm brown (#2A1B18-ish). A luminance threshold lets the reddish-brown hair
    masquerade as outline, which would flatter the score. Requiring *every*
    channel to be dark isolates true black ink.
    """
    return bgr.max(axis=2) < thresh


def outline_retention(src_bgr: np.ndarray, alpha: np.ndarray,
                      thresh: int = OUTLINE_MAX_CHANNEL) -> dict:
    """Fraction of source ink pixels that survived the matte.

    A pixel 'survives' if its alpha is at least half. We measure against the
    *source crop*, so this is a like-for-like statement: "of the black pixels
    present in the crop, how many are still present in the output".
    """
    m = outline_mask(src_bgr, thresh)
    n = int(m.sum())
    if n == 0:
        return dict(outline_px=0, retained_px=0, retention=None,
                    mean_alpha_on_outline=None)
    kept = int((alpha[m] >= 0.5).sum())
    return dict(
        outline_px=n,
        retained_px=kept,
        retention=kept / float(n),
        mean_alpha_on_outline=float(alpha[m].mean()),
    )


# --------------------------------------------------------------------------
# Panel model
# --------------------------------------------------------------------------
@dataclass
class Panel:
    """One crop region on a sheet, in *source pixel* coordinates."""
    index: int
    label: str
    x: int
    y: int
    w: int
    h: int
    group: str = "misc"
    alpha_mode: str = "global"     # 'global' | 'none'
    confidence: float = 1.0
    notes: str = ""

    def rect(self):
        return (int(self.x), int(self.y), int(self.w), int(self.h))

    def to_json(self) -> dict:
        return asdict(self)


@dataclass
class SheetLayout:
    """How one source sheet is organised.

    `origin` records provenance, because it changes how much the derived
    rectangles should be trusted. A layout with origin='derived' has been
    walked onto the real ink profile; origin='authored' is an eyeball estimate.
    We never hide which one the user is looking at.
    """
    sheet: str
    title: str
    is_reference: bool = True
    background_mode: str = "gradient"
    alpha_mode: str = "global"     # 'global' | 'none' (storyboard/composite)
    origin: str = "authored"
    panels: list = field(default_factory=list)

    def to_json(self) -> dict:
        d = asdict(self)
        return d

    @staticmethod
    def from_json(d: dict) -> "SheetLayout":
        panels = [Panel(**p) for p in d.get("panels", [])]
        d = dict(d)
        d["panels"] = panels
        return SheetLayout(**d)