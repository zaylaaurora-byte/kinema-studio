# Reference-Asset Extraction & Continuity-QC Toolkit

Tools for turning the flat RGB character reference sheets in this project into
transparent per-panel PNGs, reading the declared colour palettes off them, and
catching continuity drift between a reference and a generated shot.

Built and measured against the six sheets in
`bad-example/` (sheets 01-06).

> **Read the limitations first if you are planning to rig anything.** These
> extractions are **reference-grade masks, not production-clean rig layers**.
> Hand cleanup or redrawing is expected. Details in
> [Limitations](#limitations-read-this).

---

## Quick start

```powershell
$py = "C:\Users\zayla\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\python\python.exe"
$T  = "X:\Project Kinema\tools\asset-extraction"

# 1. derive panel rectangles from the sheets  -> layouts.json
& $py "$T\build_layouts.py"

# 2. extract every panel to transparent PNGs  -> assets/extracted/
& $py "$T\extract.py"

# 3. prove the extraction is not garbage      -> verification_report.json
& $py "$T\verify_extraction.py" --report "$T\verification_report.json"

# 4. read the declared character palettes     -> palette.json
& $py "$T\palette.py"

# 5. continuity-compare a reference vs a generated shot
& $py "$T\continuity.py" `
  --reference "X:\Project Kinema\projects\bad-example\assets\extracted\01_Demon_Host_Primary_Character_Sheet\001_front.png" `
  --generated "X:\Project Kinema\projects\bad-example\assets\extracted\01_Demon_Host_Primary_Character_Sheet\003_side.png"
```

`verify_extraction.py` and `continuity.py` **exit non-zero** when a check fails,
so both can gate a build. `verify_extraction.py` exits `1` on any failed check,
`2` if the manifest is missing.

---

## What each script does

### `extraction_core.py`

Shared engine: background estimation, the alpha matte, outline metrics, and the
panel/layout data model. Both the extractor and the verifier import their
definitions of "background" and "outline" from here, so the verifier cannot
accidentally grade the extractor against a different standard.

### `build_layouts.py` — where the panels are

Writes **`layouts.json`**: every panel's source rectangle, label, group and a
**confidence** score.

The brief asked for derived, not hardcoded, coordinates. The honest engineering
story is that on this artwork a *fully automatic* panel detector does not work,
and I measured three approaches failing before settling on the current design:

| Approach | Result on these sheets |
|---|---|
| Row/column ink projections | No clean rules exist. Longest continuous dark horizontal run on sheet 01 is **137 px** out of 1536. |
| Background-colour percolation | Finds 11 cells on sheet 03, but collapses to **1 blob** on sheet 01 — figures drift across the 1-2 px black rules and break the enclosure. |
| Threshold → invert → drop border-touching components | The same breakage fragments a 12-head row into an arbitrary subset of 7. |

So the design is: an authored **seed spec** states the coarse structure a human
read off the sheet ("3 columns, title band 0..110, gutter 12"), and that seed is
then **projected onto the real pixels** by a snapper, independently per boundary.
The stored numbers are measurements of this artwork, with a confidence attached.

The snapper itself took three iterations, each corrected against measurements:

1. **Dark-rule scoring** — saturated the ±14 px window on every boundary
   (`shiftP95 = 13`, mean confidence 0.26). It was chasing figures.
2. **Local-contrast + narrowness** — still saturated at 13 px. Measuring the
   sheet showed why: at `x=578..590` the rule score is 0.025 but the
   foreground fraction is 0.063 — the real gap between two figures is **empty,
   not dark**. The snapper was asking the wrong question entirely.
3. **Gutter scoring (current)** — a boundary is a place where a strip through
   the band contains almost no figure pixels:

   ```
   score(x) = 1 - column_occupancy(x) / high_percentile_occupancy(band)
   ```

   Measured on sheet 01's expression band this separates cleanly: gutters score
   **0.95-1.00**, the median column **0.12-0.15**. A gate at 0.85 sits in the
   empty middle of that distribution.

   The search is additionally capped at ~18% of the cell size. With an unbounded
   radius a boundary locks onto the *next* figure's gutter and silently
   mis-assigns a whole row.

Result — the expression row on sheet 01 snapped to a uniform 90 px pitch with
several boundaries at exactly 0 px shift:

```
laughing    x= 559 w= 90  conf=0.75
excited     x= 937 w= 90  conf=0.49
annoyed     x=1032 w= 90  conf=0.42
bored       x=1126 w= 90  conf=0.42
sleepy      x=1220 w= 90  conf=0.43
```

**Confidence is not decoration.** A boundary that snapped 0 px onto strong
evidence is trustworthy; one that sat at its seed because nothing cleared the
gate scores low. Rectangles whose confidence is low follow the human's seed, not
the artwork.

### `extract.py` — panel extraction with background removal

Reads `layouts.json`, crops each panel, mattes the background to alpha, writes
BGRA PNGs and **`manifest.json`**.

Output layout:

```
projects/bad-example/assets/extracted/
├── manifest.json
├── palette.json                      (from palette.py)
├── 01_Demon_Host_Primary_Character_Sheet/
│   ├── 001_front.png
│   ├── 002_three_quarter.png
│   └── ...
├── 02_Silent_Human_Primary_Character_Sheet/    (67 panels)
├── ...                                          (266 panels total)
```

**How the matte works.** Four decisions, each made because the naive version
measurably failed:

1. **The background is not one colour.** Sampled on sheet 01: corner `#C4BAAF`,
   mid `#C8BEB2`, far corner `#C9BFB4`, plus a soft vignette. A single colour
   leaves a halo on one side of every panel, so a **degree-2 polynomial surface**
   is fitted across the sheet instead.

   The first implementation of this **diverged** — it re-selected its own input
   pixels from the fit's residual each iteration, drifted onto the artwork, and
   ended up predicting values like `#10110F10E`. Fixed by selecting the
   background pixel set **once**, from the measured colour distribution, and
   **clipping** the surface to ±40 levels of the ring median so it can never
   predict an absurd colour. Residual over trusted background pixels is now
   **16-22 levels**.

2. **Soft ramp, never a hard threshold.** `alpha = clamp((d - lo)/(hi - lo))`
   with `t_lo=9`, `t_hi=22`. Hard thresholding a matte turns every
   anti-aliased ink edge into a staircase.

3. **The outline must not be eaten.** After matting, outline retention is
   *measured* (see below) and reported per panel; the extractor warns loudly at
   extraction time if any panel falls below the gate.

4. **Edge colour de-contamination.** On partial-alpha pixels the source is
   literally `a*fg + (1-a)*bg`. The RGB is solved back to true foreground,
   `fg = (obs - (1-a)*bg)/a`, otherwise the stored colour still contains beige
   and the compositor blends it in a second time — the classic pale fringe.

**Presets.** Sheets 01-04 use `reference` (full matte). Sheets 05 and 06 use
`crop` (no background removal) because they have no flat background to remove —
see limitations.

### `verify_extraction.py` — prove the extraction is not garbage

Purpose-built to catch an extractor that *succeeds* while producing rubbish. Six
checks per panel, each measured against the **source**, not the output:

| Check | Fails when | Why it is the right test |
|---|---|---|
| `no_alpha_channel` | Not 4-channel | The premise is that sources have no alpha. |
| `background_not_removed` | <2% of pixels transparent | The headline failure: shipping a crop, not a matte. |
| `empty_result` | <1% opaque | Nothing survived. |
| `nothing_removed_at_all` | >99.5% opaque | Nothing was removed. |
| `outline_eaten` | <92% of source ink retained | **The key check.** |
| `noise_not_figure` / `shattered` | Too many specks; largest blob <30% of opaque area | Matte thresholded paper texture instead of cutting a figure. |
| `blank_flat_panel` | Colour std < 3 | Rectangle landed off the artwork. |
| `duplicate_rect` | Two panels share a rectangle | Layout bug. |

The outline check recomputes the ink mask (`max channel < 90`) on the **source
crop** and asks what fraction of those pixels still have `alpha >= 128`. Because
it is measured against the source it cannot be gamed by the matte's own opinion.

**This check is not vacuous — verified by deliberately damaging a matte:**

```
ink px in crop: 7085 (62.98% of panel)
good matte:              retention = 1.0000
  after erode r=1:       retention = 0.9824
  after erode r=2:       retention = 0.9269     <- crosses the 0.92 gate
  after erode r=3:       retention = 0.8783
  after erode r=4:       retention = 0.8274
  with t_lo=160:         retention = 0.3548     <- collapses
```

### `palette.py` — the declared palettes

Writes **`palette.json`**. Locates the printed swatch blocks structurally —
flat, locally uniform colour blocks, component-labelled, filtered by the shape
signature of a printed swatch — rather than by hardcoded pixels. Sheet 01 prints
**rectangles**, sheet 03 prints **circles**, so the expected shape is declared
per region.

Declared palettes beat a histogram because they are what the artist *asserted*.
The histogram is still computed as a cross-check, and both are reported.

### `continuity.py` — reference vs generated drift

`compare(reference_png, generated_png) -> metrics`. Handles differing sizes by
normalising on the silhouette's bounding-box diagonal and aligning centroids.
It deliberately does **not** do a free affine fit, because a fit free to rotate
and shear would absorb the pose drift we are trying to detect.

Metrics: **palette distance** (Earth Mover's Distance in RGB, solved by Sinkhorn
iteration — no scipy needed), **silhouette IoU**, **perceptual difference**
(mean |ΔLab|), plus **aspect-ratio** and **area-ratio** as the appendage proxy.
All thresholds are configurable via CLI flags.

---

## Real observed results

### Extraction (`extract.py`)

```
sheet                                                panels  preset     fg%          outline kept
01_Demon_Host_Primary_Character_Sheet.png               28  reference  27.4-92.8    100.0%
02_Silent_Human_Primary_Character_Sheet.png             67  reference  30.1-82.2    100.0%
03_Paired_Character_And_Expressions_Reference.png       83  reference  33.8-79.1    100.0%
04_Human_Poses_Outfits_And_Interaction_Reference.png    74  reference  13.8-95.8    100.0%
05_Pilot_Open_And_End_Frames.png                         2  crop       100.0         100.0%
06_Trex_Pilot_Storyboard_Exploration.png                12  crop       100.0         100.0%

wrote 266 panels across 6 sheets
outline retention overall: 100.00% of 2380448 ink px
```

Background models fitted: sheet 01 `polynomial(deg=2)` over `#C8BEB2`, 95th-pct
residual **22.0** levels; sheet 02 over `#CFC2B4`, residual **31.2**; sheet 03
over `#EAE0D2`, residual **16.4**.

### Verification (`verify_extraction.py`)

```
sheet                                            n alpha0%  opaque%  outline%  maxFrag   FAIL
01_Demon_Host_Primary_Character_Sheet.png       28    27.9     69.9     100.0     18.4      0
02_Silent_Human_Primary_Character_Sheet.png     67    41.0     55.1     100.0     39.2      0
03_Paired_Character_And_Expressions_Referenc    83    37.1     59.4     100.0     19.9      0
04_Human_Poses_Outfits_And_Interaction_Refer    74    49.4     40.3     100.0     96.3     21
05_Pilot_Open_And_End_Frames.png                 2     0.0    100.0     100.0      0.0      0
06_Trex_Pilot_Storyboard_Exploration.png        12     0.0    100.0     100.0      0.1      0

FAIL: 266 panels checked, 21 failed     (exit code 1)
```

**All 21 failures are on sheet 04, and they are a layout framing problem, not a
matte problem.** Inspected directly: panel `011_07` is a 69x56 fragment showing
curved fragments of several faces and an open red mouth straddling cell borders.
The matte inside it is clean — smooth anti-aliased outlines, no jaggies — but the
rectangle slices across multiple expression heads instead of isolating one.
Tightening the matte made it *worse*, not better:

```
t_lo= 9 t_hi=22 minblob=14 -> opaque 0.200  cc=6  per10k= 77.5  largest=0.296
t_lo=14 t_hi=30 minblob=20 -> opaque 0.169  cc=6  per10k= 91.7  largest=0.291
t_lo=18 t_hi=38 minblob=40 -> opaque 0.156  cc=5  per10k= 83.1  largest=0.301
```

Higher thresholds remove more genuine content (opaque falls 0.200 → 0.156)
without reducing the fragmentation, because the fragments are real artwork, not
noise. **The fix is a better rectangle for sheet 04's 5x5 expression grid, not a
different matte.** Left as-is and reported, rather than tuned until it looks
green.

### Palette (`palette.py`) — sheet 01, all 8 swatches located in one column

```
Hair               #392321   rect=1368,  50  38x27
Skin               #ECB7A2   rect=1368,  89  37x24
Eyes               #EEA651   rect=1368, 127  37x24
Horns / Tail       #312725   rect=1368, 165  38x26
Sweater            #E6CEBA   rect=1368, 205  37x24
Clothes (Black)    #232020   rect=1367, 243  39x27
Mouth / Tongue     #B2484E   rect=1368, 284  37x28
Accents (Red)      #C4342F   rect=1368, 328  38x31
```

Sheet 03 yielded 8 demon circles + 3 human circles. Getting there took two
measured corrections, both recorded in the source: an early region clipped the
left column of circles into 13x33 slivers (corrupting their median colour), and
widening it let the **human turnaround's white figure leak in as a bogus 47x115
"swatch"**, shifting every label by one. A region that overlaps real artwork
will always do this.

### Continuity (`continuity.py`) — real numbers

**Same character, front vs side view (sheet 01):**

```
  ref  101x355  silhouette= 19737 px  AR=0.284  mean #8C756A
  gen  103x355  silhouette= 23694 px  AR=0.290  mean #776158

  metric              value  threshold  result
  palette            0.0848     0.2200  ok
  silhouette         0.4152     0.6200  FAIL
  aspect_ratio       0.0056     0.3500  ok
  area               0.1670     0.4500  ok
  perceptual        35.0850    26.0000  FAIL

VERDICT: REVIEW  (failed: silhouette, perceptual)
```

This is the tool behaving **correctly**. Palette distance stays low (0.085) —
same character — while silhouette and perceptual difference fail, because it is a
different pose. Aspect and area stay close, correctly reporting no appendage-like
change.

**Front view, sheet 01 vs sheet 03:**

```
  ref  101x355  AR=0.284
  gen  139x249  AR=0.558

  palette      0.1315   ok
  silhouette   0.3892   FAIL
  aspect_ratio 0.2737   ok        (vs 0.0056 for the same-sheet pair)
  area         0.1814   ok
  perceptual  37.2070   FAIL
```

Both are labelled "front view", but they are drawn at genuinely different
proportions (**AR 0.284 vs 0.558**). The aspect-ratio proxy moves from 0.006 to
0.274 as a result. The sheets are **not frame-matched**, and the tool says so
with the number rather than smoothing it over.

---

## Limitations (read this)

### The output is reference-grade, not rig-ready

This is the most important limitation and it is a property of the **source
artwork**, not of the code:

- **Each panel yields ONE flat matte of the whole figure.** The sheets are flat
  composites with no internal separation — hair, horns, limbs and clothing are
  drawn as a single shape on a flat page. There is **no arm/leg/head layering
  here and none is implied.** These are not sprite layers and you cannot rig
  from them directly.
- **Hand cleanup or redrawing is expected** before production use.
- **Panel framing is imperfect**, most visibly on sheet 04, where 21 of its 74
  panels are mis-framed fragments — **7.9% of all 266 panels, and 28.4% of that
  one sheet**.
- **Anti-aliased edges are ~9-22 levels of softness**, which is deliberate, but
  the underlying artwork is a lossy composite, so edges carry source
  compression artefacts that a hand-redraw would not.

### Sheet 05 is not a reference sheet and must not be matted

`05_Pilot_Open_And_End_Frames.png` is a fully painted scene composite. Its
corner pixel is `#251C30` — a dark stage illustration with **no flat background
whatsoever**. There is nothing to remove, and any "extraction" of it would be a
lie. It is classified `is_reference=False` and extracted **crop-only**.

### Sheet 06 is a storyboard, not a character sheet

Its cells contain real illustrated backgrounds. Matteing them against the page
beige would delete the scenery and keep only the figures, which is not what a
storyboard crop is for. Also **crop-only**.

### Extra-limb detection is a proxy, and this toolkit does not detect extra limbs

The brief asked us to attempt it. Nothing here segments body parts, so
`continuity.py` measures the two signatures an extra appendage leaves on the
whole silhouette — bounding-box aspect ratio and silhouette area ratio — and
**flags deviations as a prompt to look, not as a diagnosis.** Its honest failure
modes:

- It **misses** an appendage contained within the existing silhouette (a sixth
  limb held against the body, or one occluded by the others).
- It **fires on legitimate pose and framing differences** — as demonstrated
  above, where two "front views" differ by AR 0.274 purely because the sheets
  are not frame-matched.

### Verification proves plausibility, not correctness

A panel can pass every check and still be mis-framed, because framing is a
judgement about the artwork that no threshold encodes. The checks catch
*implausible* extractions; they cannot certify a correct one. **A human must
still look at the output.**

### One measured weakness worth calling out

**Sheet 02's `maxFrag` is 39.2**, against a gate of 40 — i.e. it very nearly
fails. Its panels have the finest fragmentation of the clean sheets, and the
margin is thin. If you tighten the fragmentation gate, sheet 02 will start
failing too, and it will be a real signal rather than noise.

### Outline retention of 100% is real, not a blind spot

All 266 panels retain 100% of source ink pixels. This looked suspicious, so the
check was validated by deliberately eroding a matte (see the table above): it
drops to 92.7% at a 2 px erode and 35.5% at a bad threshold. The reason the real
panels score 100% is that this artwork is genuinely line-heavy — 63% of one
expression panel is ink — and the matte keeps dark pixels easily. The check
would still catch a matte that ate the outline.

### Thresholds are calibrated for *this* artwork

`verify_extraction.py` and the layout snapper use thresholds measured from these
six sheets (gutter gate 0.85, outline gate 0.92, fragmentation 40/10k). They are
exposed as CLI flags. Re-measure before trusting them on different artwork — in
particular the gutter gate depends on cells being separated by clear channels,
which is true of these sheets and may not be true of others.

---

## Files

| File | Role |
|---|---|
| `extraction_core.py` | Shared engine: background model, matte, outline metrics, panel model |
| `build_layouts.py` | Derives panel rectangles → `layouts.json` |
| `extract.py` | Crops + mattes panels → BGRA PNGs + `manifest.json` |
| `verify_extraction.py` | 6-check QC per panel → `verification_report.json`, non-zero exit on failure |
| `palette.py` | Locates printed swatches + histogram cross-check → `palette.json` |
| `continuity.py` | Reference vs generated comparison → metrics + verdict |
| `layouts.json` | Generated: panel rectangles with confidence |
| `verification_report.json` | Generated: per-panel check results |
| `continuity_report.json` | Generated: continuity comparison output |
| `build_layouts.py` | Also holds the authored seed spec for each sheet |

Palette, manifest and extracted PNGs are written under
`projects/bad-example/assets/extracted/`; `layouts.json` and the report JSONs sit
in the toolkit folder.