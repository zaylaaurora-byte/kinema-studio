# Bad Example — Pilot 01 production test

A real acceptance test for Kinema Studio, using the owner's original animated series.
**This is not a feature request. It is a pass/fail gate.**

Source pack: `Bad_Example_Kinema_Character_Pilot_Reference_Pack.pdf` (v1.0),
plus `Bad_Example_Original_Reference_Images.zip`.

---

## The rule that governs everything here

From the pack, verbatim:

> Do not restart Kinema Studio, rebuild the homepage, create another pricing page, or
> treat a static UI mock-up as successful delivery.

And:

> **Definition of done:** A playable pilot clip has been rendered and inspected.
> Everything else, including a polished UI and agent-produced prose, is supporting
> evidence rather than a substitute.

So: no monetisation work. No marketing. No decorative pages. The only measure of
success is a rendered, playable MP4 in which the characters are recognisably the ones
in the reference sheets.

---

## Explicitly NOT acceptable as completion

These are listed as failures in the pack, and are treated as failures here:

| Failure mode | Why it is tempting | Guard |
|---|---|---|
| Screenshots pretending to be video output | Fast to produce, looks like progress | Acceptance test requires a decodable MP4 with correct duration and audio stream |
| Hard-coded or fake generation results | Avoids needing a provider | Every asset carries provenance naming the model that produced it |
| Character art drifting between scenes | Unnoticed without comparison | Side-by-side reference-vs-generated comparison is a required artefact |
| Replacing designs with unrelated new AI characters | Generative models default to this | Reference-pinned identity; drift is a QC failure, not a style choice |
| Claiming integrations work without verified output | Cheap to assert | An integration is "done" only once it has produced a real file inspected by a human |

---

## Fixed cast

Both characters are locked. Do not redesign.

### Demon host

| | |
|---|---|
| Build | Adult-looking female demon, warm pale skin, gold/amber eyes |
| Horns | Large, curved, black |
| Ears | Pointed |
| Tail | Spade-tipped |
| Hair | Long, messy, dark brown-to-black. **Never redesign per shot.** |
| Wardrobe | Oversized cream/off-white jumper; casual dark bottoms/boots when visible |
| Linework | Readable 2D hand-drawn cartoon/anime-influenced |
| Voice | Warm, slightly low, soft, subtly sleepy, charismatic. **Neutral American accent.** |
| Performance | Dry, sarcastic, mischievous, relaxed — not hyperactive. Half-lidded looks, slight smirks, long pauses, understated reactions. |

> **Contradiction resolution.** The pack states the source sheets may contain
> conflicting accent labels. `04_Demon_Host...` sheets reportedly show a *British*
> descriptor in places. **The written requirement — neutral American — overrides the
> sheets.** This is recorded because it is exactly the kind of detail that silently
> drifts if not pinned.

### Silent human

| | |
|---|---|
| Body | Pure white / near-white rounded body, thick simple black outline |
| Head | Round; no detailed hair, no realistic facial rendering |
| Face | Highly expressive: eyes, thick eyebrows, elastic mouth, blinks |
| Personality | Sweet, absurdly trusting, confident without justification, physically clumsy |
| Speech | **NONE. Zero spoken words.** Only nonverbal sounds: gasp, yelp, breath, scream, wheeze, impact |
| Pilot costume | Removable explorer/safari hat + backpack. **Must not become permanent anatomy.** |

> **Continuity trap.** The pack warns that storyboard image text may *inaccurately imply
> spoken dialogue* for the human. The model must keep him silent regardless of what the
> storyboard art appears to show. A test asserts this.

---

## Shot list — the production target

8 scenes, ~85 seconds of programme. The survival challenge itself is 60 seconds.

| # | Time | Scene | Content |
|---|---|---|---|
| 01 | 00–08s | Studio intro | Host at her desk. Eye movement, blink, voice synced to facial animation. |
| 02 | 08–16s | The dare | Host pitches the 60-second T. rex challenge; human celebrates naively. |
| 03 | 16–25s | Gear and send-off | Explorer hat and backpack; silent human approves. Portal/scene transition. |
| 04 | 25–35s | Arrival | Prehistoric environment. Human notices wildlife, then an ominous tremor. |
| 05 | 35–45s | Reveal | T. rex appears. Human's expressive facial change realises the danger. |
| 06 | 45–58s | Bad decision | Human tries something foolish. Host comments over the action; comic pause. |
| 07 | 58–72s | Chase / near miss | Run cycle, environment motion, dinosaur scale, sound effects. |
| 08 | 72–85s | Result + callback | Return to stage. Status/result gag and host closing one-liner. |

---

## Acceptance criteria (the quality gate)

Copied from the pack. Each becomes a verifiable check.

### Minimum verified output

1. Original character assets imported in the app and openable/viewable.
2. Character references stay connected to their scenes, prompts and candidates.
3. **At least 3 visibly different human expressions** and **3 distinct host acting states.**
4. **At least one actual animated human movement** — explicitly *not* a Ken Burns zoom
   on still art.
5. At least one host voice performance with editable timing and audio playback.
6. A live scene/storyboard-to-timeline relationship demonstrated.
7. **One real exported MP4** with intelligible audio and non-placeholder moving images.

### Review and traceability

8. Side-by-side reference vs. generated shots for continuity checks.
9. No unexpected extra arms, horns, tails, fingers, or missing costume pieces.
10. Same style, linework and silhouette across the selected sequence.
11. **Contestant remains speechless; host keeps one recognisable voice identity.**
12. Known imperfections openly listed with timestamp and reproducible steps.
13. Job costs, selected provider, input settings, outputs and failures recorded.

### Also required

14. Use the local machine where possible; explain clearly what requires a paid external API.
15. Save the editable production project and logs.

---

## The central engineering problem

**The reference sheets are not rig layers.** This is stated in the pack and confirmed by
inspection:

```
01_Demon_Host...     1536x1024  RGB  NO alpha channel
02_Silent_Human...   1536x1024  RGB  NO alpha channel
03_Paired...         1536x1024  RGB  NO alpha channel
04_Human_Poses...    1536x1024  RGB  NO alpha channel
05_Pilot_Open_End... 1672x941   RGB  NO alpha channel
06_Trex_Storyboard.. 1536x1024  RGB  NO alpha channel
```

All six are flat, fully-opaque composites. Colour histograms are extremely flat (no
single colour exceeds 4% of pixels), which is characteristic of detailed illustration
rather than separable flat-colour sprites.

The pack is blunt about the consequence:

> These are reference sheets and composite artwork, not ready-to-rig transparent
> character sprite layers. Extract or redraw clean production assets as needed, verify
> them against the originals, and never assume that cropped artwork is already a
> complete animation rig.

**Therefore cut-out animation requires constructing the rig, not merely cropping.** The
acceptance criterion "at least one actual animated human movement, not a Ken Burns
zoom" cannot be satisfied by moving the sheet around. Parts must be separated, cleaned
and verified.

This is the riskiest item in the whole test and is the natural first milestone.

---

## Environment constraints

The local machine is a 2014-era i7-4790 with 16 GB RAM and an RTX 2060 (6 GB VRAM).
That is adequate for 2D compositing and FFmpeg encoding at 1080p, and adequate for
7–9B text models. It is **not** adequate for local video diffusion.

The pack anticipates this: "Use the local machine where possible. Explain what requires
a paid external API."

---

## Honest status

Tracked in [`STATUS.md`](STATUS.md) in this folder. Kept deliberately blunt: what works,
what does not, and what has not been attempted. The pack requires open listing of
imperfections, so this is a deliverable rather than an internal note.