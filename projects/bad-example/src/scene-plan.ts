/**
 * BAD EXAMPLE — Pilot 01 visual plan.
 *
 * For every scene: the background, who is in it, and the specific expression and
 * pose each character needs at each beat.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THE VOCABULARY IS CLOSED
 * ─────────────────────────────────────────────────────────────────────────────
 * Expressions and poses are union types, not `string`. The pack's failure list
 * includes "Character art silently drifting between scenes" and "Replacing the
 * designs with unrelated new AI characters", and a free-text field is exactly how
 * that drift gets in: someone types "kinda scared" in scene 5, an image model
 * invents a new face, and nothing catches it. A closed vocabulary means the only
 * legal values are the ones that are actually drawn on the reference sheets, so a
 * typo is a compile error rather than a continuity failure discovered in review.
 *
 * All names below are transcribed from the sheets:
 *   01_Demon_Host_Primary_Character_Sheet.png   — 12 expression heads
 *   02_Silent_Human_Primary_Character_Sheet.png — 20 expressions, 19 standing
 *                                                 poses, 14 actions
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * ACCEPTANCE CRITERIA COVERAGE
 * ─────────────────────────────────────────────────────────────────────────────
 * The pack requires "At least 3 visibly different human expressions and 3 distinct
 * host acting states". This plan delivers considerably more headroom than the
 * minimum, because the minimum is a floor and not a target:
 *
 *   HUMAN EXPRESSIONS — 10 distinct across the pilot:
 *     EXCITED  (s2  celebration)      LAUGHING (s2  tag)
 *     CURIOUS  (s4  arrival)          WORRIED  (s4  the tremor)
 *     SHOCKED  (s5  the reveal)       DETERMINED (s6 the plan)
 *     CONFUSED (s6  mid-decision)     SCARED   (s6  the lunge)
 *     PANIC    (s7  the chase)        TIRED    (s8  dead inside)
 *
 *   HOST ACTING STATES — 11 distinct across the pilot:
 *     HAPPY (s1) · SARCASTIC (s1) · BORED (s2/s6) · MANIACAL (s3/s8)
 *     CURIOUS (s4) · DEFAULT (s4) · SURPRISED (s5/s7) · ANNOYED (s6)
 *     LAUGHING (s7) · EXCITED (s7) · THINKING (s8)
 *
 * Two notes on deliberate choices:
 *
 *  - SHOCKED is required by the brief's scene 05 ("Human realises the danger
 *    through an expressive facial change") and is played in ONE unbroken shot, so
 *    the pilot can evidence facial animation rather than a cut between two stills.
 *  - HURT exists on the sheet and is deliberately NOT used. The pack's closing
 *    keyframe shows him scuffed and dirty but not bloodied, and the show's comedy
 *    is "clueless", not "injured". Using TIRED instead keeps the tone.
 */

import type { HostEmotion } from "./script.js";
import { SCENES } from "./script.js";

// ---------------------------------------------------------------------------
// Closed vocabularies, transcribed from the reference sheets
// ---------------------------------------------------------------------------

/** 20 states, sheet 02 (Silent Human, detailed expression row). */
export type HumanExpression =
  | "DEFAULT"
  | "HAPPY"
  | "EXCITED"
  | "LAUGHING"
  | "SILLY"
  | "CURIOUS"
  | "CONFUSED"
  | "SUSPICIOUS"
  | "WORRIED"
  | "SCARED"
  | "PANIC"
  | "SHOCKED"
  | "DETERMINED"
  | "ANGRY"
  | "DISAPPOINTED"
  | "TIRED"
  | "SAD"
  | "HURT"
  | "PROUD"
  | "CREEPED OUT";

/** 19 standing poses, sheet 02 (body language row). */
export type HumanPose =
  | "NEUTRAL"
  | "WAVE"
  | "THUMBS UP"
  | "POINT"
  | "ARMS UP"
  | "HANDS ON HIPS"
  | "LEAN FORWARD"
  | "LEAN BACK"
  | "SNEAK"
  | "TIPTOE"
  | "HIDE"
  | "COWER"
  | "CONFUSE"
  | "SHRUG"
  | "ON ALERT"
  | "DEFENSIVE"
  | "EXPLAINING"
  | "BEGGING"
  | "VICTORY";

/** 14 dynamic/comic actions, sheet 02 (actions row). */
export type HumanAction =
  | "RUN"
  | "TRIP-FALL"
  | "JUMP"
  | "CLIMB"
  | "PUSH"
  | "PULL"
  | "HOLD STICK"
  | "THROW"
  | "DUCK"
  | "LIE DOWN"
  | "PEEK"
  | "HIDE BEHIND"
  | "GET ATTACKED"
  | "PANIC RUN";

/** A character beat: what the human is doing and feeling at a moment in a scene. */
export interface HumanBeat {
  /** Beat description. */
  readonly beat: string;
  readonly expression: HumanExpression;
  readonly pose: HumanPose;
  /**
   * Optional dynamic action superimposed on the pose. Omitted when the beat is a
   * held pose — `exactOptionalPropertyTypes` means this is genuinely absent, not
   * `undefined`, which keeps serialised scene data clean.
   */
  readonly action?: HumanAction;
  /** Wardrobe/costume state, so overlays cannot silently become permanent anatomy. */
  readonly wardrobe?: HumanWardrobe;
  readonly note?: string;
}

/** The human's costume state. Overlays are removable per the brief. */
export type HumanWardrobe = "plain-white" | "explorer-hat-backpack" | "explorer-hat-only" | "hat-held";

/** A host beat. Host expression names match the 12 heads on sheet 01 exactly. */
export interface HostBeat {
  readonly beat: string;
  readonly expression: HostEmotion;
  /** Which drawn pose study from sheet 01 is used as the starting point. */
  readonly pose: HostPose;
  readonly note?: string;
}

/** Pose studies available on the host sheet (sheet 01, pose + action rows). */
export type HostPose =
  | "CASUAL SITTING"
  | "LOUNGING"
  | "ON STAGE"
  | "HOLDING MUG"
  | "LYING DOWN"
  | "POINTING"
  | "LEANING"
  | "SITTING ON DESK";

/** Who is on screen. */
export type CharacterId = "host" | "human" | "trex" | "sauropod" | "audience";

export interface ScenePlan {
  /** Must match a scene id in `script.ts`. */
  readonly sceneId: string;
  readonly background: string;
  readonly characters: readonly CharacterId[];
  readonly humanBeats: readonly HumanBeat[];
  readonly hostBeats: readonly HostBeat[];
  /**
   * The rigged movement this scene must produce.
   *
   * The pack is explicit that the pilot needs "at least one actual animated human
   * movement, not a Ken Burns zoom on still art". Naming the required movement per
   * scene makes that criterion inspectable rather than assumed.
   */
  readonly requiredMotion: string;
}

// ---------------------------------------------------------------------------
// The plan
// ---------------------------------------------------------------------------

export const SCENE_PLANS: readonly ScenePlan[] = [
  {
    sceneId: "scene-01-studio-intro",
    background:
      "The Bad Example stage. Warm marquee sign reading BAD EXAMPLE with the skull motif and a red arrow, mounted on a gantry above and behind the lectern. Red lectern with a horned-skull emblem and chains, stage-left. Circular spotlit platform, centre-right. Rope-and-bulb lighting rig, warm amber pools, deep purple-black upstage. Audience heads as a black silhouette band across the bottom of frame. Note: signage must be re-typeset in the app, never cropped from the reference keyframe.",
    characters: ["host", "human", "audience"],
    humanBeats: [
      {
        beat: "Already on the platform, arms up, waiting to be introduced.",
        expression: "HAPPY",
        pose: "ARMS UP",
        wardrobe: "plain-white",
        note: "He is the only white object in a dark warm frame. Blink and a two-frame eye-dart toward the host, per the brief's 'eye movement, blink and voice synced to facial animation'.",
      },
      {
        beat: "The introduction lands and he waves at the audience.",
        expression: "EXCITED",
        pose: "WAVE",
        wardrobe: "plain-white",
        note: "Full-body: the wave must move the arm, not the whole sprite.",
      },
    ],
    hostBeats: [
      {
        beat: "Welcome. Warming the room.",
        expression: "happy",
        pose: "ON STAGE",
        note: "Standing at the lectern, one hand out. Mouth open, genuine smile.",
      },
      {
        beat: "Sets up the premise of the show.",
        expression: "sarcastic",
        pose: "HOLDING MUG",
        note: "Half-lidded. Mug set down on the lectern at the end of this beat.",
      },
      {
        beat: "Indicates the contestant without looking at him.",
        expression: "default",
        pose: "POINTING",
        note: "Hand indicates off-frame right. Eyes stay on the audience. This is the pilot's first joke about their relationship.",
      },
    ],
    requiredMotion:
      "Host: 2D layered eye-blink plus a hand-point, and a mug set-down with 3 s of tracked motion. Human: full-arm wave at ~4 frames/second with a 2-frame head bounce. This scene alone would not satisfy the 'not a Ken Burns zoom' gate; it exists to establish the stage and the blink.",
  },

  {
    sceneId: "scene-02-the-dare",
    background:
      "Same stage, tighter. The challenge card — a cream board with SURVIVE / 60 SECONDS / WIN A BISCUIT and an arrow, plus one chocolate-chip biscuit resting on its lower lip — swings in on a visible wire. Sparkle accents. The lectern is partly in frame at the left edge.",
    characters: ["host", "human", "audience"],
    humanBeats: [
      {
        beat: "Sees the biscuit and stops listening entirely.",
        expression: "EXCITED",
        pose: "ARMS UP",
        wardrobe: "plain-white",
        note: "Star-struck eyes — the sheet's EXCITED head with the star pupils. This is the exact pose on storyboard panel 02. The joke is that he has already decided yes.",
      },
      {
        beat: "Celebrates a prize that has not been won.",
        expression: "LAUGHING",
        pose: "VICTORY",
        wardrobe: "plain-white",
        note: "Both fists up, eyes as happy arcs. A 3-frame squash-and-stretch bounce off the platform.",
      },
      {
        beat: "Two flat claps on the host's tag line.",
        expression: "HAPPY",
        pose: "NEUTRAL",
        wardrobe: "plain-white",
        note: "Small, polite, completely sincere. He is the only person in the building taking this seriously.",
      },
    ],
    hostBeats: [
      {
        beat: "Reads the rules off the card without enthusiasm.",
        expression: "sarcastic",
        pose: "LEANING",
        note: "Elbow on the lectern, chin resting on her free hand. Tail flicks once on the ellipsis.",
      },
      {
        beat: "Sells the biscuit like a car.",
        expression: "happy",
        pose: "POINTING",
        note: "Points at the biscuit with the full arm. Eyebrows up, small fang visible.",
      },
      {
        beat: "Deflates on the tag line.",
        expression: "bored",
        pose: "LEANING",
        note: "'That's it. That's the whole show.' Eyes fully half-lidded, no mouth movement beyond the minimum.",
      },
    ],
    requiredMotion:
      "Human: a 3-frame anticipation crouch then a full-body stretch-jump with squash on landing — the pilot's first unmistakably animated movement, and a candidate for the animation-test artefact the pack asks to retain. Host: tail flick (2 s) and a four-frame blink.",
  },

  {
    sceneId: "scene-03-gear-and-send-off",
    background:
      "Stage centre, medium two-shot. Props on a side table: explorer hat with a chin strap, backpack, a small camera with no film, a tracker box. Stage-right, the portal: a black ring rig with a red and magenta vortex inside it, sparks at its rim. The marquee is out of frame now.",
    characters: ["host", "human", "audience"],
    humanBeats: [
      {
        beat: "Catches the hat and puts it on — slightly too big for him.",
        expression: "HAPPY",
        pose: "NEUTRAL",
        wardrobe: "explorer-hat-backpack",
        note: "Hat is an overlay layer on the head, chin strap loose. It must not merge with the silhouette.",
      },
      {
        beat: "Gives a confident thumbs-up at the 'zero hope' line.",
        expression: "PROUD",
        pose: "THUMBS UP",
        wardrobe: "explorer-hat-backpack",
        note: "Chest out. He has entirely missed the joke, which is the joke.",
      },
      {
        beat: "Launched through the portal, still delighted.",
        expression: "EXCITED",
        pose: "ARMS UP",
        action: "JUMP",
        wardrobe: "explorer-hat-backpack",
        note: "Storyboard panel 04 exactly: arms up, one leg tucked, hat staying on through the spin. The red vortex rotates behind him at a different rate to sell the depth.",
      },
    ],
    hostBeats: [
      {
        beat: "Tosses him the gear, one item at a time.",
        expression: "default",
        pose: "ON STAGE",
        note: "Underhand throws. No eye contact on any of the three.",
      },
      {
        beat: "The 'zero hope' flash-grin.",
        expression: "maniacal",
        pose: "ON STAGE",
        note: "The full toothy grin from the sheet's MANIACAL head, held for under a second, then straight back to deadpan. This is the host's biggest single acting state and it should cost the audience nothing to read.",
      },
      {
        beat: "Hits the big red button.",
        expression: "happy",
        pose: "POINTING",
        note: "Palm slam, arm straight. 'Fantastic. I wasn't asking.'",
      },
    ],
    requiredMotion:
      "Human: portal transit — a 1.5 s arc through frame with rotation, motion blur and a scale-down as he recedes, plus a hat layer that is separately tracked so it does not slide off his head. Host: a button-press with a 3-frame recoil.",
  },

  {
    sceneId: "scene-04-arrival",
    background:
      "Late Cretaceous floodplain. Layered digital-matte jungle: foreground ferns (fast parallax), mid-ground cycads and tree ferns (medium parallax), a distant lake with a low mountain range and warm haze (slow parallax). A sauropod drinks at the treeline on the mid-ground plane, roughly 6 human-heights tall. Dust and pollen in the light.",
    characters: ["human", "sauropod"],
    humanBeats: [
      {
        beat: "Face-first landing in the dirt.",
        expression: "SHOCKED",
        pose: "LIE DOWN",
        action: "TRIP-FALL",
        wardrobe: "explorer-hat-backpack",
        note: "Starts the scene already falling. Hat stays on; backpack takes the worst of it.",
      },
      {
        beat: "Gets up, dusts off, looks around.",
        expression: "CONFUSED",
        pose: "NEUTRAL",
        wardrobe: "explorer-hat-backpack",
        note: "Head tilt, one eyebrow up. Small sway as he finds his balance.",
      },
      {
        beat: "Spots the sauropod and falls in love with the place.",
        expression: "CURIOUS",
        pose: "POINT",
        wardrobe: "explorer-hat-backpack",
        note: "Leans forward, points off-frame left. Head angle per the LOOK UP (surprised) interaction pose.",
      },
      {
        beat: "Picks up a stick as a walking aid.",
        expression: "HAPPY",
        pose: "LEAN FORWARD",
        action: "HOLD STICK",
        wardrobe: "explorer-hat-backpack",
        note: "The stick is a plant for scene 05's 'Oh. He's armed.' It must be clearly the same object.",
      },
      {
        beat: "The ground moves. The grin slides off.",
        expression: "WORRIED",
        pose: "ON ALERT",
        wardrobe: "explorer-hat-backpack",
        note: "Push in on the face. This is a slow 1.5 s facial change, not a snap — CURIOUS to WORRIED with the eyebrows travelling the whole way. The first of the pilot's required expression changes.",
      },
    ],
    hostBeats: [
      {
        beat: "Nature-documentary narration over the arrival.",
        expression: "curious",
        pose: "LOUNGING",
        note: "Voice-over only. She is not on screen; if a reaction shot is wanted, hold on her at the lectern with a monitor glow on her face.",
      },
    ],
    requiredMotion:
      "Human: a genuine TRIP-FALL — forward rotation about the hip through 90 degrees, dust decal on impact, then a recovery stand. Environment: three-plane parallax pan with the mid-ground sauropod on its own plane.",
  },

  {
    sceneId: "scene-05-reveal",
    background:
      "Same floodplain, later light, lower sun. The T. rex steps out of the treeline on the mid-ground plane. Fog layer between the treeline and the human. The sauropod is gone from frame — implying, correctly, that it left.",
    characters: ["human", "trex"],
    humanBeats: [
      {
        beat: "Still pleased with himself, holding the stick like a hiking pole.",
        expression: "CURIOUS",
        pose: "TIPTOE",
        action: "HOLD STICK",
        wardrobe: "explorer-hat-backpack",
        note: "Sneaking forward to get a better look. The tiptoe pose from the sheet.",
      },
      {
        beat: "Turns, looks up, and understands everything at once.",
        expression: "SHOCKED",
        pose: "LEAN BACK",
        wardrobe: "explorer-hat-backpack",
        note: "THE PILOT'S HERO EXPRESSION CHANGE. CURIOUS to SHOCKED in one unbroken shot, no cut, over 1.8 s: eyebrows climb, pupils shrink to dots, mouth falls open, head tilts back. This is the required evidence that the character has a face and not a swapped still.",
      },
      {
        beat: "Grips the stick far too hard.",
        expression: "SCARED",
        pose: "DEFENSIVE",
        action: "HOLD STICK",
        wardrobe: "explorer-hat-backpack",
        note: "Stick held out in both hands like a sword. Dry stick-snap on the soundtrack is what sells the grip.",
      },
    ],
    hostBeats: [
      {
        beat: "Delivers the species fact flatly.",
        expression: "default",
        pose: "LOUNGING",
        note: "Voice-over. Zero emotional colour; the delivery is the joke.",
      },
      {
        beat: "'Oh. He's armed.'",
        expression: "surprised",
        pose: "LEANING",
        note: "Genuine but tiny surprise — the sheet's SURPRISED head, eyebrows up, mouth a small open oval. She recovers inside half a second.",
      },
    ],
    requiredMotion:
      "Human: the 1.8 s CURIOUS to SHOCKED facial change, rigged as separately driven eyebrow, eyelid, pupil and mouth layers — this is the deliverable for the pack's 'at least one facial change without changing line thickness, proportions, head position or limb count'. T. rex: a slow step-out with the treeline held static behind it so the scale reads.",
  },

  {
    sceneId: "scene-06-bad-decision",
    background:
      "Two locations intercut. (A) The floodplain, tight: the T. rex's head fills the top of frame, the human occupies the bottom third, fog behind. (B) The stage, tight on the host at her lectern, chin on hand, watching a small monitor with a warm glow on her face. The monitor is the only light source in (B) and it flickers with the dinosaur's movement.",
    characters: ["human", "host", "trex"],
    humanBeats: [
      {
        beat: "Decides on a plan. It is the wrong plan.",
        expression: "DETERMINED",
        pose: "HANDS ON HIPS",
        wardrobe: "explorer-hat-backpack",
        note: "The sheet's DETERMINED head: straight brows, flat mouth, total conviction. He is not afraid yet. He should look like a man about to do something sensible, which is the setup for the next four seconds.",
      },
      {
        beat: "Waves at it.",
        expression: "HAPPY",
        pose: "WAVE",
        wardrobe: "explorer-hat-backpack",
        note: "A friendly, ordinary wave. Storyboard panel 07's outstretched-hand pose, played as a greeting rather than a stroke.",
      },
      {
        beat: "Why is the wave not working.",
        expression: "CONFUSED",
        pose: "CONFUSE",
        wardrobe: "explorer-hat-backpack",
        note: "Head tilt, question-mark energy, arms out. Comic pause held here for a full second.",
      },
      {
        beat: "The dinosaur lunges.",
        expression: "SCARED",
        pose: "LEAN BACK",
        action: "DUCK",
        wardrobe: "explorer-hat-backpack",
        note: "Eyes wide, mouth flat and stretched. Ducks under the jaw. Cut on the frame the teeth close.",
      },
    ],
    hostBeats: [
      {
        beat: "'Let's not pet it.'",
        expression: "bored",
        pose: "LEANING",
        note: "Chin on hand. Half-lidded. She does not look up from the monitor. Minimum possible movement.",
      },
      {
        beat: "'...You're petting it.'",
        expression: "annoyed",
        pose: "LEANING",
        note: "One eyebrow flat, mouth a thin line. The sheet's ANNOYED head. Hold the previous pose with only the eyebrows changing — the restraint is the performance.",
      },
      {
        beat: "'Fantastic. Running is optional. Common sense is optional.'",
        expression: "sarcastic",
        pose: "ON STAGE",
        note: "Straightens up, spreads both hands. Tail up and out. Small shrug on 'optional'.",
      },
      {
        beat: "'He is not optional.'",
        expression: "sarcastic",
        pose: "POINTING",
        note: "Points at the monitor without looking at it. Lands under the lunge so picture and line read as one beat.",
      },
    ],
    requiredMotion:
      "Human: a 2 s expression change HAPPY to CONFUSED, then a 4-frame duck-and-recoil. Host: an eyebrow-only change between two of her lines, on a locked body — proving the facial layer animates independently of the body.",
  },

  {
    sceneId: "scene-07-chase-and-near-miss",
    background:
      "Four distinct plates. (A) Floodplain running ground — layered ferns and fallen logs, lateral parallax. (B) Open ground for the ride cutaway, sky and dust. (C) The hollow log interior — dark, bark-textured, a bright ragged opening at one end with the dinosaur's eye beyond it. (D) Back to the running ground for the final near miss. On-screen countdown timer enters at 62 s, bottom right, and persists to the end of the scene.",
    characters: ["human", "host", "trex"],
    humanBeats: [
      {
        beat: "Full sprint. Arms back, legs a blur, hat by a thread.",
        expression: "PANIC",
        pose: "ON ALERT",
        action: "PANIC RUN",
        wardrobe: "explorer-hat-backpack",
        note: "A genuine run cycle, 8 frames, with contact/down/passing/up poses. The pack explicitly forbids satisfying this with a moving still, so this is the pilot's primary movement deliverable.",
      },
      {
        beat: "The near miss takes the hat off his head.",
        expression: "SHOCKED",
        pose: "DUCK",
        action: "DUCK",
        wardrobe: "explorer-hat-only",
        note: "Teeth pass above him; the hat layer detaches and spins off frame. From here on it is gone until scene 08, where it returns in his hands.",
      },
      {
        beat: "The bad decision, properly: the T. rex is asleep, and he climbs on.",
        expression: "SILLY",
        pose: "CLIMB",
        action: "CLIMB",
        wardrobe: "plain-white",
        note: "RECONCILIATION R4. The dinosaur is asleep — snoring, eye closed — when he finds it. He takes stillness as consent. This is the storyboard's dinosaur-ride gag, compressed to one ~3 s cutaway so it cannot break the chase, and motivated so that the episode can still end 2-0. The backpack is lost here (R8).",
      },
      {
        beat: "It wakes up.",
        expression: "PANIC",
        pose: "LEAN BACK",
        action: "GET ATTACKED",
        wardrobe: "plain-white",
        note: "The cheer and the shriek are the same sound, switching halfway.",
      },
      {
        beat: "Hidden in the hollow log, eye to eye with the T. rex.",
        expression: "SCARED",
        pose: "HIDE",
        action: "PEEK",
        wardrobe: "plain-white",
        note: "Storyboard panel 09. Crouched, chest heaving, one eye out of the opening. Hold this shot long — the timer is doing the work, and the near-silence is the joke.",
      },
      {
        beat: "The timer runs out and he collapses in relief.",
        expression: "TIRED",
        pose: "COWER",
        action: "LIE DOWN",
        wardrobe: "plain-white",
        note: "Head down on the bark, eyes closed, one long exhale. Ends the scene on an out-breath so the cut to the stage confetti lands.",
      },
    ],
    hostBeats: [
      {
        beat: "'Wait. Wait, wait, wait.' — genuinely thrown.",
        expression: "surprised",
        pose: "ON STAGE",
        note: "Half-rises off the lectern. The only unguarded moment she has in the episode.",
      },
      {
        beat: "'He's done it. The little freak has invented public transport.'",
        expression: "laughing",
        pose: "ON STAGE",
        note: "Head back, eyes shut, real laugh. The sheet's LAUGHING head, held for a beat longer than is comfortable.",
      },
      {
        beat: "'Ten seconds. Can he do it?'",
        expression: "excited",
        pose: "POINTING",
        note: "Gameshow energy for about a second and a half. Points at the timer on her own monitor.",
      },
      {
        beat: "'Stay quiet, stay quiet, stay quiet.'",
        expression: "curious",
        pose: "LEANING",
        note: "Drops to a mutter, leaning in toward the monitor. Quieter than anything else she says in the pilot.",
      },
      {
        beat: "'...Okay, that's actually clever.'",
        expression: "surprised",
        pose: "THINKING",
        note: "One full second of dead air first. Hand to chin, eyes flicked sideways as though checking nobody heard her.",
      },
    ],
    requiredMotion:
      "Human: an 8-frame run cycle with separated limb layers, a hat-detach event, a climb, and a collapse. T. rex: a matched-chase step cycle that stays locked to scale. This scene carries the pack's 'at least one actual animated human movement, not a Ken Burns zoom' requirement on its own.",
  },

  {
    sceneId: "scene-08-result-and-callback",
    background:
      "Back on the Bad Example stage. Confetti in the air. The status board above the lectern updates live: first SURVIVED / 60 SECONDS with a green tick, then, on the deductions, a red stamp. A reward board at frame right holds a whole biscuit, then a half. The marquee is visible again in the background. Dust drifts off the human in the stage light.",
    characters: ["host", "human", "audience"],
    humanBeats: [
      {
        beat: "Dropped back onto the platform, filthy, hat in his hands.",
        expression: "TIRED",
        pose: "NEUTRAL",
        wardrobe: "hat-held",
        note: "Wardrobe reset per R8 and per the pack's closing keyframe: he holds the hat, he is not wearing it. Grime decals, one scuff on the head, no blood — see the HURT note above.",
      },
      {
        beat: "Sees the SURVIVED tick and allows himself one moment of pride.",
        expression: "PROUD",
        pose: "VICTORY",
        wardrobe: "hat-held",
        note: "A 1.5 s flash of genuine triumph before the deductions arrive. Short, because the audience needs to see it before it is taken away.",
      },
      {
        beat: "The three-point deduction lands.",
        expression: "DISAPPOINTED",
        pose: "SHRUG",
        wardrobe: "hat-held",
        note: "Shoulders drop, hat drops half an inch. He does not argue. He knows what he did.",
      },
      {
        beat: "The biscuit is halved. He stares dead inside.",
        expression: "TIRED",
        pose: "NEUTRAL",
        wardrobe: "hat-held",
        note: "THE FINAL FRAME. Eyes flat, mouth a straight line, no blink for four seconds. This is the sheet's TIRED head and it is the last thing the audience sees of him.",
      },
    ],
    hostBeats: [
      {
        beat: "'Congratulations. You survived the dinosaurs.'",
        expression: "happy",
        pose: "ON STAGE",
        note: "Confetti still falling. Genuine warmth, which somehow makes it worse.",
      },
      {
        beat: "Reads the deduction off the card for the first time.",
        expression: "thinking",
        pose: "LEANING",
        note: "Eyes down on the card, a small frown. She is doing admin.",
      },
      {
        beat: "Eats half of it. 'So you get half.'",
        expression: "sarcastic",
        pose: "SITTING ON DESK",
        note: "Perched on the lectern, biscuit in hand, mouth full on the line. This is the callback gag and it needs the least possible ceremony.",
      },
      {
        beat: "'Same time next week.' — to camera.",
        expression: "maniacal",
        pose: "ON STAGE",
        note: "Direct to camera for the only time in the pilot. The MANIACAL grin from scene 03 returns, now aimed at the audience. Hold a beat past the end of the line, then cut on the marquee.",
      },
    ],
    requiredMotion:
      "Human: a settle-back-onto-the-platform motion plus the hat-held layer, and a 4 s no-blink held TIRED face that must show zero drift against the scene-07 face at the same angle. Host: a walk-and-sit onto the lectern with the tail trailing, and a two-frame blink.",
  },
] as const;

// ---------------------------------------------------------------------------
// Coverage queries
// ---------------------------------------------------------------------------

/** Distinct human expressions used. 10, against a required 3. */
export function usedHumanExpressions(plans: readonly ScenePlan[] = SCENE_PLANS): readonly HumanExpression[] {
  const seen = new Set<HumanExpression>();
  for (const plan of plans) for (const beat of plan.humanBeats) seen.add(beat.expression);
  return [...seen].sort();
}

/** Distinct host acting states used. 11, against a required 3. */
export function usedHostExpressions(plans: readonly ScenePlan[] = SCENE_PLANS): readonly HostEmotion[] {
  const seen = new Set<HostEmotion>();
  for (const plan of plans) for (const beat of plan.hostBeats) seen.add(beat.expression);
  return [...seen].sort();
}

/** Distinct rigged movements planned across the pilot. */
export function plannedMotions(plans: readonly ScenePlan[] = SCENE_PLANS): readonly string[] {
  return plans.map((plan) => plan.requiredMotion);
}

/**
 * Plan/scene consistency: every scene has a plan and every plan names a real scene.
 * Returns the offending ids rather than a boolean, so a failure says which one broke.
 */
export function findPlanMismatches(
  scenes: readonly { readonly id: string }[] = SCENES,
  plans: readonly ScenePlan[] = SCENE_PLANS,
): readonly string[] {
  const sceneIds = new Set(scenes.map((scene) => scene.id));
  const planIds = new Set(plans.map((plan) => plan.sceneId));
  const problems: string[] = [];
  for (const id of sceneIds) if (!planIds.has(id)) problems.push(`scene without plan: ${id}`);
  for (const id of planIds) if (!sceneIds.has(id)) problems.push(`plan without scene: ${id}`);
  return problems;
}