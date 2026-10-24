# ADR 0003 — Limited 2D animation: pose swaps, not interpolation

- **Status:** Accepted — **supersedes the interpolation-centric emphasis in the scene model**
- **Date:** 2026-10-24
- **Deciders:** Project owner

## Context

The owner clarified the actual production style after seeing the initial scene model:

> "bad example is video animation its like slideshow or frame by frame so we have poses and
> then mouth moving"

with the reference point being YouTube compilation channels of the
**"Trust Me Bro / Chat History"** style — narrated, faceless, character-driven compilations
built from drawn poses.

This is **limited 2D animation** (also called pose-to-pose, cut-out, or Cel animation),
not the smoothly-interpolated motion the scene model was oriented toward. Getting this
wrong would produce animation that looks *worse* than the reference, because smooth
tweening of a character designed for pose swaps reads as uncanny sliding rather than as
performance.

## What was built versus what is needed

| Scene model as built | What the style actually requires |
|---|---|
| Continuous keyframe interpolation between values | **Discrete pose selection** — hold one pose, then switch |
| Smooth limb rotation | **Pose A ↔ Pose B cycles** at a fixed cadence |
| Any frame is meaningfully interpolable | Most frames are **held**; change happens at switch points |
| Camera moves as a continuous transform | Camera is often **static** or does slow pushes |
| Lip-sync via mouth shape interpolation | **Mouth flaps** — a small closed set of shapes swapped on a beat |

The scene model's `step` easing already provides the discrete behaviour, and its channel
system can express holds. So this is a **change of authoring convention and tooling
emphasis, not a rewrite.** That is worth stating plainly so nobody tears up working code.

## Decision

### 1. Pose swaps are the primitive, not interpolation

The primary animation operation is: **at time T, show pose P**, and hold until the next
switch. Keyframed interpolation remains available for the things it genuinely suits —
camera pushes, a character entering frame, a comedic fall — but it is not the default.

Implementation: a `PoseTrack` — an ordered list of `{ time, poseId }` with implicit holds.
Sampling is a lookup, not a curve evaluation. This is both simpler and faster.

### 2. The reference sheets are the pose library

This was the missing realisation. The supplied sheets are **not** concept art to be
re-drawn; they are a **ready-made swap library**:

| Sheet | Provides | Use |
|---|---|---|
| 02 — Human primary | **20 expression heads** | Mouth/face swaps |
| 02 — Human primary | **18 standing poses**, 14 dynamic actions | Body swaps |
| 02 — Human primary | Turnaround (front/3-4/side/back) | Angle changes |
| 01 — Host primary | **12 expression heads** | Host face swaps |
| 01 — Host primary | Pose studies (sitting, lounging, pointing, leaning) | Host body swaps |
| 04 — Human poses/outfits | 10 scenario outfits incl. **Explorer** | Costume overlays |

Sheet 02's own annotation — "OPTIMISED FOR EASY ANIMATION IN SOFTWARE" (visible on sheet
03) and "Works in any scenario" — confirms the sheets were authored in anticipation of
exactly this technique.

### 3. Mouth flaps as a closed set

Talking is achieved by cycling a small set of mouth shapes on a beat derived from the
audio, plus a closed/idle shape. This is the standard approach and is what makes the style
readable. Required shapes, derived from the sheets' "MOUTH (VARIETY)" studies:

- **closed** (idle, and between syllables)
- **open-small** (short vowels)
- **open-wide** (long vowels, shouting)
- **o-shape** (rounded vowels)
- **teeth/grimace** (fricatives, effort)
- **smile/laugh** (held for laughter)

A viseme-to-shape mapping is what drives this; the audio subsystem's alignment work feeds
it. **The mapping must be authored per character**, because the human's mouth is an
elastic shape and the host's is a fanged anime mouth — the same phoneme does not look the
same on both.

### 4. Cadence matters more than smoothness

These channels hold poses for roughly **0.3–0.8 s** and change on the beat. A pose held
for one frame reads as a glitch; a pose held too long reads as a freeze. The editor should
therefore work in **beats and holds** rather than raw frame counts, and default to sensible
durations.

### 5. What this means for the "not a Ken Burns zoom" requirement

The pilot brief forbids passing off a still-image zoom as animation. Pose swap **satisfies
this honestly**: swapping a body pose and cycling mouth shapes is real animation of a real
rig, and it is the technique the reference channels use. It is not a workaround, and it
should be described as limited 2D animation rather than apologised for.

However, the brief also says "at least one actual animated human movement". A pose swap
between two distinct drawn poses — NEUTRAL to RUN — genuinely delivers this. A slow zoom on
the NEUTRAL pose does not.

### 6. Consequences for the scene model and rig builder

- Add a **`PoseTrack`** primitive: discrete `{time, poseId}` with holds, sampled by lookup.
- The rig builder should produce a **pose set** (named poses referencing shape/channel
  sets) rather than only a continuous channel graph. The in-flight character rig work is
  still valuable — it provides the skeleton that poses are expressed against — but it must
  expose named poses as first-class values.
- The renderer is **unchanged**. It already evaluates a scene at a time; whether a value
  came from a curve or a lookup is invisible to it.
- Determinism is preserved and in fact improved, since lookups have no floating-point
  accumulation.

## Verification

- The owner's clarification is the authority for the style. This ADR records it so the
  technique is not re-litigated.
- The reference sheets were inspected directly and their pose/expression counts are
  recorded in `projects/bad-example/CAST.md`.
- The specific YouTube channels could not be fetched (consent redirect), so the style is
  characterised from the owner's description and from the supplied sheets rather than from
  direct analysis of those videos. **This is a stated limitation.** If precise reference is
  needed, the owner should provide a downloaded clip or screenshots.