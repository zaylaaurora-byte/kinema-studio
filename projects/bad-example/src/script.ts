/**
 * BAD EXAMPLE — Pilot 01: "Can You Survive 60 Seconds With a T. rex?"
 *
 * Authoritative production script. ~85 seconds of programme.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * SOURCES
 * ─────────────────────────────────────────────────────────────────────────────
 * Two supplied sources describe this pilot and they disagree on structure:
 *
 *   A. `BRIEF.md` / the reference pack PDF (pp.11) — the WRITTEN BRIEF.
 *      Eight scenes, 00-08 / 08-16 / 16-25 / 25-35 / 35-45 / 45-58 / 58-72 / 72-85.
 *
 *   B. `06_Trex_Pilot_Storyboard_Exploration.png` — ten panels with dialogue and
 *      timings, 0:00-0:08 through 1:22-1:30.
 *
 * Per the pack ("The script is editable; do not blindly reproduce incidental
 * AI-generated text or continuity errors") and the precedence rule already recorded
 * in `CAST.md` and `BRIEF.md` — **written brief > primary sheets > exploratory
 * sheets** — the eight-scene brief supplies the STRUCTURE and TIMINGS, and the
 * storyboard supplies the DIALOGUE and JOKES. Where the storyboard's dialogue
 * contains a continuity error, it is corrected; every correction is listed below.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * RECONCILIATION LOG — brief (8 scenes) vs storyboard (10 panels)
 * ─────────────────────────────────────────────────────────────────────────────
 * The two structures are the same story. The storyboard simply splits the brief's
 * scene 07 in two and adds a mid-chase beat. Mapped:
 *
 *   brief 01 (00-08)  <- storyboard 01 INTRO
 *   brief 02 (08-16)  <- storyboard 02 THE CHALLENGE
 *   brief 03 (16-25)  <- storyboard 03 PREP + 04 SEND HIM IN (merged)
 *   brief 04 (25-35)  <- storyboard 05 ARRIVAL
 *   brief 05 (35-45)  <- storyboard 06 FIRST ENCOUNTER
 *   brief 06 (45-58)  <- storyboard 07 BAD DECISION #1 (extended, see R2)
 *   brief 07 (58-72)  <- storyboard 08 ACCIDENTAL SUCCESS + 09 FINAL TEN SECONDS
 *   brief 08 (72-85)  <- storyboard 10 RESULT
 *
 * Resolutions applied. Each one is a deliberate production decision:
 *
 *   R1. TIMING. The storyboard runs 0:00-1:30 (90 s) across ten panels; the brief
 *       runs 00-85 s across eight. The brief governs, so all scenes use the brief's
 *       boundaries. Net effect: 85 s, inside the brief's stated "approximately
 *       60-90 seconds of programme duration" and the 80-90 s test band. The two
 *       mid-reel panels (SEND HIM IN, FINAL TEN SECONDS) are folded into their
 *       parent scenes rather than deleted, so no dialogue or gag is lost.
 *
 *   R2. "ACCIDENTAL SUCCESS" DOES NOT FIT SCENE 07. The storyboard gives the
 *       dinosaur ride its own 10-second panel at 1:00-1:10, inside what the brief
 *       calls "Chase / near miss". Ten seconds of success mid-chase would break the
 *       chase and contradict the brief's own description of the scene. The ride is
 *       therefore compressed to a single cutaway beat (~3 s) inside scene 07: the
 *       run continues, the ride happens, the dinosaur wakes up, and the run resumes.
 *       The joke survives; the chase does not stop.
 *
 *   R3. THE HUMAN DOES NOT SPEAK. Storyboard panel 08 renders the host line
 *       "...you're petting it." An earlier draft of that panel reads as though the
 *       HUMAN says "just petting it." It does not, and he cannot. The line is
 *       assigned to the host and reworded, and the type system makes the alternative
 *       unrepresentable (see `HumanLine` below). This is the brief's hardest
 *       constraint and the one the storyboard art demonstrably gets wrong.
 *
 *   R4. THE HUMAN NEVER CONTROLS THE DINOSAUR. Storyboard panels 07 and 08 read as
 *       cheerful interspecies friendship: the human approaches a calm animal,
 *       deliberately climbs on, and rides it. That contradicts three other sources:
 *       the brief's "Bad decision / Human tries something foolish" then
 *       "Chase / near miss"; the pack's own closing keyframe, which reads
 *       "SURVIVAL: FAILED", "COMMON SENSE: PENDING" and "T.REX: 2  HUMAN: 0"; and
 *       the storyboard's own final host line, "...you lose three points for
 *       attempted dinosaur assault". A dinosaur that is happy to be ridden cannot
 *       end the episode 2-0 and cannot be the victim of an "assault". Resolution:
 *       the animal is ASLEEP when the human finds it, and he mistakes sleep for
 *       consent. The dinosaur does not consent; it wakes up mid-ride and escalates
 *       all the way to the final chase. This preserves every storyboard line AND
 *       every brief beat, and it is what makes the human's survival accidental
 *       rather than heroic.
 *
 *   R5. TIMER CONTINUITY. The storyboard shows an on-screen timer reading 00:07
 *       during panel 09, which it places at 1:10-1:22. Its own panel sequence
 *       starts the challenge at 0:26. 1:15 minus 0:26 is 49 seconds, not 53. The
 *       on-screen clock is the reason the third act works, so it is recomputed
 *       against the brief's structure rather than copied. Derived beats (see
 *       `CHALLENGE_SECONDS` and `TIMER_READINGS` below) are consistent with the
 *       scene timings, and a test asserts the arithmetic.
 *
 *   R6. DEAD AIR. The brief gives scene 06 fourteen seconds (45-58) but the
 *       storyboard supplies only three short lines for the panel occupying it.
 *       Played straight that is a long silence in a comedy pilot. Added: the
 *       "common sense is optional" run, which is in the host's established voice
 *       and fills the scene's second half without inventing a new story beat.
 *
 *   R7. HOST VOICE. The host's accent is neutral American. The exploratory sheets
 *       carry a contradictory British label; `BRIEF.md` records that the written
 *       requirement overrides the sheets. Nothing in this script is written to a
 *       British idiom.
 *
 *   R8. THE HUMAN'S COSTUME IS AN OVERLAY. The explorer hat and backpack are
 *       removable props, not anatomy. He loses the backpack in scene 07 and he is
 *       holding — not wearing — the hat in scene 08. This matches the pack's
 *       closing keyframe.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE CENTRAL TYPE CONSTRAINT
 * ─────────────────────────────────────────────────────────────────────────────
 * Every human line is `NonverbalLine`, which has no `text` field at all. There is
 * therefore no way to write a spoken word for him: `{ speaker: "human", text: "hi" }`
 * does not typecheck, and a value carrying `kind: "nonverbal"` cannot also carry
 * `text` (excess-property checking plus the discriminated union). He can gasp,
 * yelp and wheeze. He cannot talk. This is the brief's "Contestant remains
 * speechless" gate, expressed in the type system rather than in a comment.
 */

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Frame rate the pilot is authored and rendered at. */
export const PILOT_FPS = 30;

/** The challenge itself: the brief states "The survival challenge itself is 60 seconds." */
export const CHALLENGE_SECONDS = 60;

/**
 * In-world moment the challenge clock starts: inside scene 03, on the button press.
 * Scene 03 runs 16-25 s, and the button is hit at +7 s.
 */
export const CHALLENGE_START_SECONDS = 23;

/**
 * On-screen timer readings, reconciled per R5.
 *
 * The storyboard's "00:07" placed at 1:10-1:22 does not agree with its own panel
 * timings. After reconciling to the brief's structure, the on-screen clock is a
 * function of absolute programme time:
 *
 *   remaining = CHALLENGE_SECONDS - (t - CHALLENGE_START_SECONDS)
 */
export const TIMER_READINGS: readonly { readonly atSeconds: number; readonly display: string }[] = [
  { atSeconds: 34, display: "00:49" },
  { atSeconds: 42, display: "00:41" },
  { atSeconds: 52, display: "00:31" },
  { atSeconds: 62, display: "00:21" },
  { atSeconds: 70, display: "00:13" },
  { atSeconds: 76, display: "00:07" },
] as const;

/** Seconds shown on the on-screen clock at a given absolute programme time. */
export function challengeSecondsRemaining(timeSeconds: number): number {
  const elapsed = timeSeconds - CHALLENGE_START_SECONDS;
  return Math.max(0, Math.round(CHALLENGE_SECONDS - elapsed));
}

/** Format a remaining-seconds value as the on-screen "MM:SS" clock. */
export function formatTimer(secondsRemaining: number): string {
  const safe = Math.max(0, Math.round(secondsRemaining));
  const minutes = Math.floor(safe / 60);
  const seconds = safe % 60;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

// ---------------------------------------------------------------------------
// Dialogue
// ---------------------------------------------------------------------------

/**
 * Performance direction for a host line.
 *
 * The brief is specific about how this character is directed: "Comedic timing uses
 * half-lidded looks, slight smirks, long pauses and understated reactions", and the
 * voice brief is "warm, slightly low, soft, subtly sleepy and charismatic; neutral
 * American accent". These fields are what a TTS/voice provider needs in order to
 * reproduce that, so they are structured rather than freeform prose.
 */
export interface HostDirection {
  /** Emotional read to perform. */
  readonly emotion: HostEmotion;
  /** How fast the line is delivered relative to the host's default drawl. */
  readonly pace: "slow" | "measured" | "brisk";
  /** Overall loudness/energy. The host is "relaxed rather than hyperactive". */
  readonly volume: "soft" | "conversational" | "projected";
  /** Explicit silences within the line, in seconds, keyed to what they precede. */
  readonly pauses: readonly { readonly afterWords: string; readonly seconds: number }[];
  /**
   * Whether the line is heard as a voice-of-god narration over the prehistoric
   * footage rather than performed on stage. The storyboard marks these "(VO)".
   */
  readonly delivery: "on-stage" | "voice-over";
  /** Optional plain-language note for the voice director. */
  readonly note?: string;
}

/** Acting states the host's primary sheet makes available: 12 discrete heads. */
export type HostEmotion =
  | "default"
  | "happy"
  | "laughing"
  | "sarcastic"
  | "curious"
  | "surprised"
  | "excited"
  | "annoyed"
  | "bored"
  | "sleepy"
  | "thinking"
  | "maniacal";

/** A spoken line. Only the host may have one of these. */
export interface HostLine {
  readonly speaker: "host";
  readonly text: string;
  readonly direction: HostDirection;
}

/**
 * A human line.
 *
 * There is deliberately NO `text` field. The human never speaks — the brief states
 * it three separate times ("He does not speak words", "NONE. Zero spoken words,
 * ever.", "Contestant remains speechless"), and warns that storyboard text may
 * inaccurately imply otherwise.
 *
 * `sound` describes the noise. It is not dialogue and is never rendered as a word.
 */
export interface NonverbalLine {
  readonly speaker: "human";
  readonly kind: "nonverbal";
  /** A description of the noise, for the SFX editor. Never spoken aloud. */
  readonly sound: string;
}

/** Any line in the pilot. Discriminated by `speaker`. */
export type DialogueLine = HostLine | NonverbalLine;

// ---------------------------------------------------------------------------
// Scenes
// ---------------------------------------------------------------------------

/**
 * A scene.
 *
 * NOTE THE SHAPE: a scene declares `startSeconds` and `durationSeconds`, never an
 * end. The end is derived (`sceneEndSeconds`). This mirrors the product's central
 * rule for the timeline — a projection must not store its own derived duration —
 * and it is what makes contiguity checkable rather than merely asserted.
 */
export interface Scene {
  readonly id: string;
  readonly order: number;
  readonly title: string;
  /** Absolute start time in the programme, in seconds. */
  readonly startSeconds: number;
  /** Length of the scene in seconds. */
  readonly durationSeconds: number;
  readonly synopsis: string;
  /** How the shot is framed and what the camera does. */
  readonly camera: string;
  /** What the sound editor must build for this scene. */
  readonly sfx: string;
  readonly dialogue: readonly DialogueLine[];
}

/** Derived end time. Scenes do not store this — it is computed from start + duration. */
export function sceneEndSeconds(scene: Scene): number {
  return scene.startSeconds + scene.durationSeconds;
}

/**
 * Structural invariant: scenes are contiguous from zero, with no gaps and no
 * overlaps. Returns the offending scene id, or `undefined` when the list is sound.
 *
 * This is exported so the timeline builder and the tests share one definition of
 * "contiguous" instead of each re-implementing it slightly differently.
 */
export function findContiguityBreak(scenes: readonly Scene[]): string | undefined {
  const ordered = [...scenes].sort((a, b) => a.order - b.order);
  let expected = 0;
  for (const scene of ordered) {
    if (scene.startSeconds !== expected) return scene.id;
    expected = sceneEndSeconds(scene);
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// The script
// ---------------------------------------------------------------------------

export const SCENES: readonly Scene[] = [
  {
    id: "scene-01-studio-intro",
    order: 1,
    title: "Studio Intro",
    startSeconds: 0,
    durationSeconds: 8,
    synopsis:
      "Warm stage. The BAD EXAMPLE marquee burns overhead and the audience is a black silhouette across the bottom of frame. The host is at her lectern with the horned-skull emblem and a BAD EXAMPLE mug, warming up the room. The human stands on the spotlit circular platform beside her, arms up, thrilled to simply be included. She establishes the premise and the format.",
    camera:
      "Slow push in on the host from a wide stage master. Her horns, tail and the marquee bulbs sit on separate parallax planes so the push reads as depth rather than a zoom. Audience silhouettes stay locked to the bottom of frame as a static foreground matte. Settle on a medium shot as she turns to the contestant.",
    sfx:
      "Upbeat game-show sting under the whole scene. Warm audience murmur and one distant laugh. Lectern thump on the mug set-down. A rising sparkle as the human's arms go up. Everything ducks hard on the final beat to leave her last word dry.",
    dialogue: [
      {
        speaker: "host",
        text: "Welcome to Bad Example.",
        direction: {
          emotion: "happy",
          pace: "measured",
          volume: "conversational",
          pauses: [{ afterWords: "Welcome to", seconds: 0.35 }],
          delivery: "on-stage",
          note: "Warm and low. She has done this a thousand times and it still amuses her.",
        },
      },
      {
        speaker: "human",
        kind: "nonverbal",
        sound: "Delighted gasp, then a small squeak of excitement. Arms up.",
      },
      {
        speaker: "host",
        text: "Today, we find out what would happen if dinosaurs never went extinct.",
        direction: {
          emotion: "sarcastic",
          pace: "slow",
          volume: "conversational",
          pauses: [
            { afterWords: "Today,", seconds: 0.5 },
            { afterWords: "we find out", seconds: 0.3 },
          ],
          delivery: "on-stage",
          note: "Half-lidded. She already knows exactly what would happen. That is the joke.",
        },
      },
      {
        speaker: "host",
        text: "Meet our contestant.",
        direction: {
          emotion: "default",
          pace: "measured",
          volume: "conversational",
          pauses: [{ afterWords: "Meet our", seconds: 0.4 }],
          delivery: "on-stage",
          note: "She indicates him without looking at him. Hand only.",
        },
      },
      {
        speaker: "human",
        kind: "nonverbal",
        sound: "Enthusiastic wave: a soft whoosh of air and a happy little hum.",
      },
    ],
  },

  {
    id: "scene-02-the-dare",
    order: 2,
    title: "The Challenge",
    startSeconds: 8,
    durationSeconds: 8,
    synopsis:
      "The host pitches the format. A challenge card swings into frame: SURVIVE 60 SECONDS. WIN A BISCUIT. The human does not hear a dare — he hears a prize. He celebrates before the rules have finished being read. The biscuit is the single most important object in his life.",
    camera:
      "Zoom onto the challenge card, then whip-pan right to the human's face as he reacts. Hold on the biscuit at the bottom of the card just long enough for the audience to read it as a reward rather than a prop. Cut back to the host for the tag, slightly wider, so both of them are in frame for the punchline.",
    sfx:
      "Dramatic gameshow chime on the card reveal. A single sparkle-chime on the biscuit. Airy crowd 'ooh'. Under the celebration: a tiny brass flourish that is cut off abruptly when the host speaks.",
    dialogue: [
      {
        speaker: "host",
        text: "The rules are simple. Survive sixty seconds in a world where dinosaurs never went extinct...",
        direction: {
          emotion: "sarcastic",
          pace: "slow",
          volume: "conversational",
          pauses: [
            { afterWords: "Survive sixty seconds", seconds: 0.4 },
            { afterWords: "in a world where dinosaurs never went extinct", seconds: 0.7 },
          ],
          delivery: "on-stage",
          note: "She holds the ellipsis. The pause IS the joke. Do not rush it.",
        },
      },
      {
        speaker: "host",
        text: "And you win a biscuit.",
        direction: {
          emotion: "happy",
          pace: "measured",
          volume: "projected",
          pauses: [{ afterWords: "And you win", seconds: 0.3 }],
          delivery: "on-stage",
          note: "Bright, but still underplayed. She is selling a biscuit like it is a car.",
        },
      },
      {
        speaker: "human",
        kind: "nonverbal",
        sound: "Sharp squeal of joy. He bounces once on the spot. Eyebrows shot up, mouth wide open.",
      },
      {
        speaker: "host",
        text: "That's it. That's the whole show.",
        direction: {
          emotion: "bored",
          pace: "slow",
          volume: "soft",
          pauses: [{ afterWords: "That's it.", seconds: 0.5 }],
          delivery: "on-stage",
          note: "Almost a sigh. She is already tired and the challenge has not started.",
        },
      },
      {
        speaker: "human",
        kind: "nonverbal",
        sound: "Two flat hand-claps and a tiny wheeze of pure happiness.",
      },
    ],
  },

  {
    id: "scene-03-gear-and-send-off",
    order: 3,
    title: "Gear And Send-Off",
    startSeconds: 16,
    durationSeconds: 9,
    synopsis:
      "The host outfits him without ceremony: an explorer hat, a backpack, and a camera with no film in it. He receives each item as though it were a knighthood. She hits the big red button and he is flung through a portal. His silhouette stays delighted the entire way through.",
    camera:
      "Medium two-shot, playful and close. Hold on the two-shot for the gear beats, then cut to the button for the press. Swing to the portal and hold on it as he goes through — dynamic angle, motion blur on the transit, and a slight lens shake on the impact. The hat must survive the spin; the backpack must not be visible after this scene (see R8).",
    sfx:
      "Helmet clunk, backpack zip, a hollow 'empty camera' click. Heavy mechanical THUNK on the button, then a portal hum that rises to a whoosh. One distant, muffled scream from inside it. All stage audio cuts to silence the instant he clears the ring.",
    dialogue: [
      {
        speaker: "host",
        text: "I've got you some essentials.",
        direction: {
          emotion: "default",
          pace: "measured",
          volume: "conversational",
          pauses: [{ afterWords: "I've got you", seconds: 0.3 }],
          delivery: "on-stage",
          note: "She tosses each item at him rather than handing it over.",
        },
      },
      {
        speaker: "host",
        text: "A camera, a tracker... and zero hope.",
        direction: {
          emotion: "maniacal",
          pace: "brisk",
          volume: "conversational",
          pauses: [
            { afterWords: "A camera,", seconds: 0.25 },
            { afterWords: "a tracker...", seconds: 0.8 },
          ],
          delivery: "on-stage",
          note: "The long pause before 'zero hope' is the whole line. Land it flat, then flash the grin.",
        },
      },
      {
        speaker: "human",
        kind: "nonverbal",
        sound: "Confident thumbs-up. A proud little 'hm!' through the nose.",
      },
      {
        speaker: "host",
        text: "Ready, sweetheart?",
        direction: {
          emotion: "happy",
          pace: "measured",
          volume: "soft",
          pauses: [{ afterWords: "Ready,", seconds: 0.35 }],
          delivery: "on-stage",
          note: "Genuinely fond. This is the closest she gets to affection and it lasts under a second.",
        },
      },
      {
        speaker: "host",
        text: "Fantastic. I wasn't asking.",
        direction: {
          emotion: "sarcastic",
          pace: "brisk",
          volume: "conversational",
          pauses: [{ afterWords: "Fantastic.", seconds: 0.4 }],
          delivery: "on-stage",
          note: "Button press lands on 'asking'. Do not overlap the two.",
        },
      },
      {
        speaker: "human",
        kind: "nonverbal",
        sound: "A full-throated scream, dopplering away as he falls through the portal.",
      },
    ],
  },

  {
    id: "scene-04-arrival",
    order: 4,
    title: "Arrival",
    startSeconds: 25,
    durationSeconds: 10,
    synopsis:
      "A Late Cretaceous floodplain, played as a nature documentary. The host narrates over the top. The human lands face-first, gets up, and is thrilled by everything: ferns, giant insects, a sauropod drinking at the treeline. Then the ground moves, and his grin does not so much fall as slide off.",
    camera:
      "Wide establishing shot on the floodplain, then a slow pan right to reveal the world before the reveal of any threat. Cut to the human at ground level. Push in slightly on his face for the tremor so the expression change is the subject of the shot. The sauropod must read as enormous but peaceful; the tremor must read as something else entirely.",
    sfx:
      "Rich jungle bed: insects, distant bird-calls, water. A big comedic IMPACT thud on his landing, then a small dust puff. Everything else is quiet so the tremor lands — a low sub-bass rumble that arrives before the picture tells us what it is. Birds stop mid-scene; that silence is the tell.",
    dialogue: [
      {
        speaker: "host",
        text: "Welcome to the Cretaceous. Or at least, a version of it.",
        direction: {
          emotion: "curious",
          pace: "slow",
          volume: "soft",
          pauses: [
            { afterWords: "Welcome to the Cretaceous.", seconds: 0.6 },
            { afterWords: "Or at least,", seconds: 0.35 },
          ],
          delivery: "voice-over",
          note: "Full nature-documentary register. Warm, unhurried, faintly amused by her own hedge.",
        },
      },
      {
        speaker: "host",
        text: "Many of the same species are here. But with modern ecosystems.",
        direction: {
          emotion: "default",
          pace: "measured",
          volume: "soft",
          pauses: [{ afterWords: "Many of the same species are here.", seconds: 0.5 }],
          delivery: "voice-over",
          note: "She is reading this off a card and does not care whether it is true.",
        },
      },
      {
        speaker: "human",
        kind: "nonverbal",
        sound: "Dazed groan. A long inhale as he finds his feet. Then a bright, curious 'oh!'",
      },
      {
        speaker: "human",
        kind: "nonverbal",
        sound: "Excited panting and a small hop, pointing off-screen at the sauropod.",
      },
    ],
  },

  {
    id: "scene-05-reveal",
    order: 5,
    title: "Reveal",
    startSeconds: 35,
    durationSeconds: 10,
    synopsis:
      "The host introduces the Tyrannosaurus rex like a Sunday supplement. It steps out of the treeline at terrible scale. The human, still holding the stick he picked up as a walking aid, turns, looks up, and understands his situation completely — in one continuous facial change, with no cut.",
    camera:
      "Low angle on the T. rex so it towers, then cut to the human's face at eye level. The facial change from CURIOUS to SHOCKED must be held in ONE unbroken shot — this is the pilot's required demonstration of facial animation, so there is no cut and no cheat. Tilt up his body from the feet to sell scale against the low angle.",
    sfx:
      "Low rumble that resolves into a full-throated roar; the roar should sit slightly behind the picture so the silence before it registers. A dry stick-snap as he grips the stick too hard. Under the roar, a single high sustained string note for tension. No music sting on the face — let the animation carry it.",
    dialogue: [
      {
        speaker: "host",
        text: "The Tyrannosaurus rex. One of the largest land predators ever.",
        direction: {
          emotion: "default",
          pace: "measured",
          volume: "soft",
          pauses: [
            { afterWords: "The Tyrannosaurus rex.", seconds: 0.5 },
            { afterWords: "One of the largest", seconds: 0.25 },
          ],
          delivery: "voice-over",
          note: "Completely flat. Information delivered as if it were a weather report.",
        },
      },
      {
        speaker: "host",
        text: "Oh. He's armed.",
        direction: {
          emotion: "surprised",
          pace: "brisk",
          volume: "conversational",
          pauses: [{ afterWords: "Oh.", seconds: 0.6 }],
          delivery: "voice-over",
          note: "The 'Oh.' is deadpan and slightly impressed. Not alarmed. She is watching television.",
        },
      },
      {
        speaker: "human",
        kind: "nonverbal",
        sound: "Sharp intake of breath. A strangled squeak. Nothing else.",
      },
    ],
  },

  {
    id: "scene-06-bad-decision",
    order: 6,
    title: "Bad Decision",
    startSeconds: 45,
    durationSeconds: 13,
    synopsis:
      "Instead of running, the human attempts a plan. He waves at the largest land predator that has ever existed. The host watches it happen and declines to intervene, because intervening is not the format. Running is optional. Common sense is optional. The T. rex is not optional.",
    camera:
      "Medium two-shot of the human and the dinosaur, pitched so the dinosaur's head fills the top of frame and the human occupies the bottom third. Intercut to the host on the stage, watching on a monitor at her lectern, chin on hand. Comic pause held on her half-lidded look. Cut back on the lunge.",
    sfx:
      "A short, warm, friendly-sounding 'hff' from the dinosaur, which is somehow more alarming than a roar. Under the host's line, the monitor's tinny, compressed version of the roar from scene 05 — the sound of the scene she is watching heard through a television. A deep inhale on the lunge.",
    dialogue: [
      {
        speaker: "human",
        kind: "nonverbal",
        sound: "A hopeful, wavering whistle, the kind you would use on a large dog.",
      },
      {
        speaker: "host",
        text: "Let's not pet it.",
        direction: {
          emotion: "bored",
          pace: "slow",
          volume: "soft",
          pauses: [{ afterWords: "Let's not", seconds: 0.4 }],
          delivery: "on-stage",
          note: "Chin on hand. She does not raise her voice. She is not going to save him.",
        },
      },
      {
        speaker: "human",
        kind: "nonverbal",
        sound: "He reaches out. A soft, wet sniff from the dinosaur. Then a tiny 'hm?' of surprise.",
      },
      {
        speaker: "host",
        text: "...You're petting it.",
        direction: {
          emotion: "annoyed",
          pace: "slow",
          volume: "soft",
          pauses: [{ afterWords: "...", seconds: 1.2 }],
          delivery: "on-stage",
          note: "One full second of silence before the line. It is not a question. Keep it dry, level and quiet.",
        },
      },
      {
        speaker: "human",
        kind: "nonverbal",
        sound: "Yelp. A scramble of footsteps. A small, sad 'oh no' with no words in it.",
      },
      {
        speaker: "host",
        text: "Fantastic. Running is optional. Common sense is optional.",
        direction: {
          emotion: "sarcastic",
          pace: "brisk",
          volume: "conversational",
          pauses: [{ afterWords: "Fantastic.", seconds: 0.35 }],
          delivery: "on-stage",
          note: "Barely looking up. This is the \u2018common sense is optional\u2019 run (see R6).",
        },
      },
      {
        speaker: "host",
        text: "He is not optional.",
        direction: {
          emotion: "sarcastic",
          pace: "slow",
          volume: "projected",
          pauses: [{ afterWords: "He", seconds: 0.4 }],
          delivery: "on-stage",
          note: "The button press lands under the dinosaur's lunge, so the two read as one beat.",
        },
      },
    ],
  },

  {
    id: "scene-07-chase-and-near-miss",
    order: 7,
    title: "Chase And Near Miss",
    startSeconds: 58,
    durationSeconds: 14,
    synopsis:
      "A genuine chase: full run cycle, environment motion, dinosaur scale, and one near miss that takes the explorer hat off his head and both of them into a hollow fallen log. Inside it, he is nose to nose with the T. rex and its teeth are directly in front of him. The master shot: the T. rex is asleep when he finds it, and he mistakes that for permission. Everything after that is his own fault and he knows it.",
    camera:
      "Handheld-feel tracking shot on the run — the camera must move laterally with him along the ground plane, not zoom. Rapid cut for the ride cutaway. Static locked shot inside the hollow log, framing him against the dinosaur's eye through the opening. On-screen countdown timer enters bottom right at 62 s and stays until the scene ends. Final whip-pan out of the log as the chase resumes.",
    sfx:
      "Heavy footfalls that get louder and closer; the sub-bass from scene 04 returns at double the rate. Wind past the ears on the run. A heavy WHUMP as the ride mounts, a snore that stops dead, and a roar that is now very close. Inside the log, the world goes muffled and close — his breathing is the loudest thing in the mix.",
    dialogue: [
      {
        speaker: "human",
        kind: "nonverbal",
        sound: "Panicked breathing in a hard, fast rhythm. No words, just air.",
      },
      {
        speaker: "host",
        text: "Wait. Wait, wait, wait.",
        direction: {
          emotion: "surprised",
          pace: "brisk",
          volume: "projected",
          pauses: [{ afterWords: "Wait.", seconds: 0.3 }],
          delivery: "on-stage",
          note: "The only moment in the pilot she is genuinely caught off guard. Then she recovers.",
        },
      },
      {
        speaker: "host",
        text: "He's done it. The little freak has invented public transport.",
        direction: {
          emotion: "laughing",
          pace: "brisk",
          volume: "projected",
          pauses: [{ afterWords: "He's done it.", seconds: 0.5 }],
          delivery: "on-stage",
          note: "Real laugh under the line. This is her favourite thing that has ever happened to anyone.",
        },
      },
      {
        speaker: "human",
        kind: "nonverbal",
        sound: "A cheer that turns into a shriek halfway through as the dinosaur wakes up.",
      },
      {
        speaker: "host",
        text: "Ten seconds. Can he do it?",
        direction: {
          emotion: "excited",
          pace: "brisk",
          volume: "projected",
          pauses: [{ afterWords: "Ten seconds.", seconds: 0.4 }],
          delivery: "on-stage",
          note: "Genuine gameshow host energy, for about a second and a half.",
        },
      },
      {
        speaker: "host",
        text: "Stay quiet, stay quiet, stay quiet.",
        direction: {
          emotion: "curious",
          pace: "slow",
          volume: "soft",
          pauses: [{ afterWords: "Stay quiet,", seconds: 0.5 }],
          delivery: "on-stage",
          note: "Dropping to a mutter. Almost to herself. He cannot hear her and it would not help.",
        },
      },
      {
        speaker: "host",
        text: "...Okay, that's actually clever.",
        direction: {
          emotion: "surprised",
          pace: "slow",
          volume: "soft",
          pauses: [{ afterWords: "...", seconds: 1.0 }],
          delivery: "on-stage",
          note: "One second of dead air first. She will never admit she said this again.",
        },
      },
      {
        speaker: "human",
        kind: "nonverbal",
        sound: "Wet, shuddering breaths in the dark. A tiny whimper on each exhale.",
      },
    ],
  },

  {
    id: "scene-08-result-and-callback",
    order: 8,
    title: "Result And Callback",
    startSeconds: 72,
    durationSeconds: 13,
    synopsis:
      "Back on stage in a flash of confetti, filthy, missing the backpack, holding what is left of the explorer hat. The board updates: SURVIVED — 60 SECONDS. Then the deductions start. He stares dead inside as the host eats half of his biscuit on her way past him. The show resets for next week as though nothing happened.",
    camera:
      "Cut up from black to the stage, wide, with the status board updating live. Push in on the board for the survival figure, then snap to a close-up of his face as the deduction lands. Final move: a long push in on the tiny biscuit crumb in his hands, then rack focus to the host already looking at next week's card. End on the marquee.",
    sfx:
      "Confetti bang and crowd cheer, cut off hard on the deduction. Deflated 'wah-wah' and a single sad slide-whistle as the crumb is revealed. A crisp biscuit snap, magnified. Under the closing line, the game-show sting from scene 01 returns in a minor key.",
    dialogue: [
      {
        speaker: "host",
        text: "Congratulations. You survived the dinosaurs.",
        direction: {
          emotion: "happy",
          pace: "measured",
          volume: "projected",
          pauses: [{ afterWords: "Congratulations.", seconds: 0.45 }],
          delivery: "on-stage",
          note: "Confetti still falling. She is genuinely pleased, which is worse.",
        },
      },
      {
        speaker: "host",
        text: "Unfortunately, you lose three points... for attempted dinosaur assault.",
        direction: {
          emotion: "thinking",
          pace: "slow",
          volume: "conversational",
          pauses: [
            { afterWords: "Unfortunately,", seconds: 0.4 },
            { afterWords: "you lose three points...", seconds: 0.9 },
          ],
          delivery: "on-stage",
          note: "She is reading this off the card for the first time and finds it reasonable.",
        },
      },
      {
        speaker: "human",
        kind: "nonverbal",
        sound: "A long, deflating exhale. No protest. He has nothing left.",
      },
      {
        speaker: "host",
        text: "So you get half.",
        direction: {
          emotion: "sarcastic",
          pace: "slow",
          volume: "soft",
          pauses: [{ afterWords: "So", seconds: 0.4 }],
          delivery: "on-stage",
          note: "She is already eating it. The line is almost thrown away.",
        },
      },
      {
        speaker: "human",
        kind: "nonverbal",
        sound: "Silence. Then one very small, very tired squeak.",
      },
      {
        speaker: "host",
        text: "Same time next week.",
        direction: {
          emotion: "maniacal",
          pace: "measured",
          volume: "conversational",
          pauses: [{ afterWords: "Same time", seconds: 0.4 }],
          delivery: "on-stage",
          note: "Direct to camera for the first time. Hold the grin a beat after the line ends.",
        },
      },
    ],
  },
] as const;

// ---------------------------------------------------------------------------
// Derived values
// ---------------------------------------------------------------------------

/**
 * The sum of every scene's duration. Note that this is a function of the data, not
 * a stored constant — the same anti-duplication rule the timeline follows.
 */
export function computeTotalDuration(scenes: readonly Scene[] = SCENES): number {
  return scenes.reduce((total, scene) => total + scene.durationSeconds, 0);
}

/** Every line in the pilot, flattened, in programme order. */
export function allDialogue(scenes: readonly Scene[] = SCENES): readonly DialogueLine[] {
  return scenes.flatMap((scene) => scene.dialogue);
}

/** Only the host's spoken lines. */
export function hostLines(scenes: readonly Scene[] = SCENES): readonly HostLine[] {
  return allDialogue(scenes).filter((line): line is HostLine => line.speaker === "host");
}

/** Only the human's nonverbal lines. */
export function nonverbalLines(scenes: readonly Scene[] = SCENES): readonly NonverbalLine[] {
  return allDialogue(scenes).filter((line): line is NonverbalLine => line.speaker === "human");
}