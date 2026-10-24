/**
 * BAD EXAMPLE — Pilot 01 timeline.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE PROJECTION RULE
 * ─────────────────────────────────────────────────────────────────────────────
 * A timeline is a PROJECTION of the scene list, not a second source of truth.
 *
 * Concretely, this module stores no duration anywhere:
 *
 *   - `Timeline` has no `durationSeconds` field. There is no way to write one, so
 *     the "timeline says 85, scenes say 88" class of bug cannot be represented.
 *   - `Clip` carries `offsetSeconds` — a position RELATIVE to its own scene — and
 *     never an absolute time. Absolute placement is computed at read time from the
 *     scene's `startSeconds`.
 *   - Total length is `computeTotalDuration(scenes)`, derived from the scenes.
 *
 * Why this is the right shape rather than pedantry: the pack's acceptance test
 * requires "A live scene/storyboard-to-timeline relationship is demonstrated". A
 * live relationship is only possible if editing a scene propagates. If the timeline
 * cached its own length, dragging a scene would leave the timeline disagreeing with
 * the picture and the disagreement would be silent. Here it is unrepresentable.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY CLIPS LIVE ON FOUR TRACKS
 * ─────────────────────────────────────────────────────────────────────────────
 * The four tracks are not decoration — they are the four things the pack demands
 * be produced and kept in sync:
 *
 *   video     — the shots. One per scene minimum, carrying the scene plan.
 *   dialogue  — host performance, with the direction the voice provider needs.
 *   sfx       — the human's nonverbal layer. He has no dialogue track; this IS his
 *               performance, which is why every clip here is `nonverbal`.
 *   music     — score and stings.
 *
 * A clip's `sceneId` is the only link and it is mandatory, so a clip can never be
 * orphaned from the scene it belongs to.
 */

import type { DialogueLine, HostLine, NonverbalLine, Scene } from "./script.js";
import { SCENES, sceneEndSeconds } from "./script.js";
import type { ScenePlan } from "./scene-plan.js";
import { SCENE_PLANS } from "./scene-plan.js";

// ---------------------------------------------------------------------------
// Tracks
// ---------------------------------------------------------------------------

export type TrackKind = "video" | "dialogue" | "sfx" | "music";

export interface Track {
  readonly id: string;
  readonly kind: TrackKind;
  readonly name: string;
  /** Stacking order within the timeline UI. Video is the base layer. */
  readonly order: number;
  /**
   * Whether clips on this track may overlap each other in time. Dialogue and music
   * may (a line over a held sting); video and sfx may not, because two simultaneous
   * shots or two conflicting impacts on one track is a mistake, not a choice.
   */
  readonly allowsOverlap: boolean;
}

export const TRACKS: readonly Track[] = [
  { id: "track-video", kind: "video", name: "Picture", order: 0, allowsOverlap: false },
  { id: "track-dialogue", kind: "dialogue", name: "Host Dialogue", order: 1, allowsOverlap: true },
  { id: "track-sfx", kind: "sfx", name: "Contestant SFX (nonverbal)", order: 2, allowsOverlap: true },
  { id: "track-music", kind: "music", name: "Music and Stings", order: 3, allowsOverlap: true },
] as const;

// ---------------------------------------------------------------------------
// Clips
// ---------------------------------------------------------------------------

/** Fields every clip has. */
export interface ClipBase {
  readonly id: string;
  /** The scene this clip belongs to. Required — a clip cannot be orphaned. */
  readonly sceneId: string;
  readonly trackId: string;
  /** Human-readable label for the timeline UI. */
  readonly label: string;
  /**
   * Position within the SCENE, in seconds. Deliberately not an absolute time:
   * absolute placement is derived from the scene's `startSeconds`.
   */
  readonly offsetSeconds: number;
  /** Length in seconds. This is a clip's own extent, not the timeline's. */
  readonly lengthSeconds: number;
}

export interface VideoClip extends ClipBase {
  readonly kind: "video";
  /** The visual plan this shot realises. */
  readonly plan: ScenePlan;
}

export interface HostDialogueClip extends ClipBase {
  readonly kind: "dialogue";
  readonly line: HostLine;
}

/**
 * The human's performance. There is no `SpokenDialogueClip` variant that accepts a
 * human line, so his performance cannot accidentally be routed to a TTS provider.
 */
export interface NonverbalClip extends ClipBase {
  readonly kind: "nonverbal";
  readonly line: NonverbalLine;
}

export interface MusicClip extends ClipBase {
  readonly kind: "music";
  readonly cue: string;
}

export type Clip = VideoClip | HostDialogueClip | NonverbalClip | MusicClip;

export interface Timeline {
  readonly id: string;
  readonly name: string;
  readonly fps: number;
  readonly tracks: readonly Track[];
  readonly clips: readonly Clip[];
  /**
   * NOTE THE DELIBERATE ABSENCE: there is no `durationSeconds` here.
   *
   * The product spec forbids a projection from storing its own duration. Add the
   * field and this comment becomes a lie, so it is a type error to try.
   */
}

// ---------------------------------------------------------------------------
// Music cues, per scene
// ---------------------------------------------------------------------------

const MUSIC_CUES: Readonly<Record<string, readonly { cue: string; lengthSeconds: number }[]>> = {
  "scene-01-studio-intro": [{ cue: "Upbeat gameshow theme, warm brass, under the whole scene", lengthSeconds: 8 }],
  "scene-02-the-dare": [{ cue: "Dramatic challenge chime, then a sparkle on the biscuit", lengthSeconds: 8 }],
  "scene-03-gear-and-send-off": [{ cue: "Playful prop-comedy underscore into a portal whoosh and a hard cut to silence", lengthSeconds: 9 }],
  "scene-04-arrival": [{ cue: "Documentary strings and woodwind; drop out entirely on the tremor, leaving sub-bass", lengthSeconds: 10 }],
  "scene-05-reveal": [{ cue: "Low sustained string on the reveal; no sting on the face change, let the animation carry it", lengthSeconds: 10 }],
  "scene-06-bad-decision": [{ cue: "Comedy suspense pizzicato, thinning out for the host's lines so her voice is dry", lengthSeconds: 13 }],
  "scene-07-chase-and-near-miss": [{ cue: "Full chase percussion, thinning to near-silence inside the log, then a timer-tick pulse in the final ten seconds", lengthSeconds: 14 }],
  "scene-08-result-and-callback": [{ cue: "Confetti fanfare, cut off hard on the deduction; minor-key reprise of the scene-01 theme under the closer", lengthSeconds: 13 }],
};

/** Distribute a scene's dialogue across its own duration, in order, with breathing room. */
function dialogueOffsets(scene: Scene, index: number, count: number): number {
  if (count <= 1) return Math.min(1, scene.durationSeconds / 4);
  // Lines are spread evenly but leave a tail, so the last beat of a scene always has
  // air after the final line — comedy needs the silence more than it needs the words.
  const usable = scene.durationSeconds * 0.8;
  const stride = usable / count;
  return Math.round((index * stride + Math.min(0.6, stride * 0.25)) * 100) / 100;
}

// ---------------------------------------------------------------------------
// Building the projection
// ---------------------------------------------------------------------------

/**
 * Build the timeline from scenes.
 *
 * Pass scenes explicitly to project a different cut; the default is the pilot.
 */
export function buildTimeline(
  scenes: readonly Scene[] = SCENES,
  plans: readonly ScenePlan[] = SCENE_PLANS,
): Timeline {
  const plansByScene = new Map(plans.map((plan) => [plan.sceneId, plan]));
  const clips: Clip[] = [];

  const ordered = [...scenes].sort((a, b) => a.order - b.order);

  for (const scene of ordered) {
    // --- video -------------------------------------------------------------
    const plan = plansByScene.get(scene.id);
    if (plan) {
      clips.push({
        kind: "video",
        id: `clip-video-${scene.id}`,
        sceneId: scene.id,
        trackId: "track-video",
        label: `${String(scene.order).padStart(2, "0")} ${scene.title}`,
        offsetSeconds: 0,
        lengthSeconds: scene.durationSeconds,
        plan,
      });
    }

    // --- dialogue + sfx ----------------------------------------------------
    const lines = scene.dialogue;
    lines.forEach((line: DialogueLine, index) => {
      const offset = dialogueOffsets(scene, index, lines.length);
      const length = Math.max(
        0.8,
        Math.min(scene.durationSeconds - offset, scene.durationSeconds / (lines.length + 1)),
      );

      if (line.speaker === "host") {
        clips.push({
          kind: "dialogue",
          id: `clip-dialogue-${scene.id}-${index + 1}`,
          sceneId: scene.id,
          trackId: "track-dialogue",
          label: line.text.length > 48 ? `${line.text.slice(0, 45)}...` : line.text,
          offsetSeconds: offset,
          lengthSeconds: length,
          line,
        });
      } else {
        clips.push({
          kind: "nonverbal",
          id: `clip-sfx-${scene.id}-${index + 1}`,
          sceneId: scene.id,
          trackId: "track-sfx",
          label: line.sound.length > 48 ? `${line.sound.slice(0, 45)}...` : line.sound,
          offsetSeconds: offset,
          lengthSeconds: length,
          line,
        });
      }
    });

    // --- music -------------------------------------------------------------
    const cues = MUSIC_CUES[scene.id] ?? [];
    cues.forEach((entry, index) => {
      clips.push({
        kind: "music",
        id: `clip-music-${scene.id}-${index + 1}`,
        sceneId: scene.id,
        trackId: "track-music",
        label: entry.cue,
        offsetSeconds: 0,
        lengthSeconds: entry.lengthSeconds,
        cue: entry.cue,
      });
    });
  }

  return {
    id: "timeline-bad-example-pilot-01",
    name: "Bad Example — Pilot 01 — Can You Survive 60 Seconds With a T. rex?",
    fps: 30,
    tracks: TRACKS,
    clips,
  };
}

// ---------------------------------------------------------------------------
// Derived reads
// ---------------------------------------------------------------------------

/**
 * Total programme duration.
 *
 * Derived from the scenes. This is the ONLY definition of "how long is the pilot"
 * in the codebase, and it lives on the scene data rather than on the timeline.
 */
export function computeTotalDuration(scenes: readonly Scene[] = SCENES): number {
  return scenes.reduce((total, scene) => total + scene.durationSeconds, 0);
}

/** Convert a clip's scene-relative offset into an absolute programme time. */
export function clipStartSeconds(clip: Clip, scenes: readonly Scene[] = SCENES): number {
  const scene = scenes.find((candidate) => candidate.id === clip.sceneId);
  if (!scene) throw new Error(`Clip ${clip.id} references unknown scene ${clip.sceneId}`);
  return scene.startSeconds + clip.offsetSeconds;
}

/** Absolute end of a clip. */
export function clipEndSeconds(clip: Clip, scenes: readonly Scene[] = SCENES): number {
  return clipStartSeconds(clip, scenes) + clip.lengthSeconds;
}

/** Clips on one track, in programme order. */
export function clipsOnTrack(
  timeline: Timeline,
  trackId: string,
  scenes: readonly Scene[] = SCENES,
): readonly Clip[] {
  return timeline.clips
    .filter((clip) => clip.trackId === trackId)
    .sort((a, b) => clipStartSeconds(a, scenes) - clipStartSeconds(b, scenes));
}

/** Every clip belonging to one scene — the storyboard-card-to-timeline link. */
export function clipsForScene(timeline: Timeline, sceneId: string): readonly Clip[] {
  return timeline.clips.filter((clip) => clip.sceneId === sceneId);
}

/**
 * Validate the projection against its source.
 *
 * Returns a list of problems, empty when the projection is faithful. Kept here so
 * the editor can call it after every edit rather than only in tests.
 */
export function findTimelineProblems(
  timeline: Timeline,
  scenes: readonly Scene[] = SCENES,
): readonly string[] {
  const problems: string[] = [];
  const byId = new Map(scenes.map((scene) => [scene.id, scene]));
  const trackIds = new Set(timeline.tracks.map((track) => track.id));

  for (const clip of timeline.clips) {
    const scene = byId.get(clip.sceneId);
    if (!scene) {
      problems.push(`clip ${clip.id} references unknown scene ${clip.sceneId}`);
      continue;
    }
    if (!trackIds.has(clip.trackId)) {
      problems.push(`clip ${clip.id} references unknown track ${clip.trackId}`);
      continue;
    }
    if (clip.offsetSeconds < 0) {
      problems.push(`clip ${clip.id} starts before its scene`);
    }
    if (clip.offsetSeconds + clip.lengthSeconds > scene.durationSeconds + 1e-6) {
      problems.push(
        `clip ${clip.id} runs ${clip.offsetSeconds + clip.lengthSeconds}s into a ${scene.durationSeconds}s scene`,
      );
    }
    if (clip.kind === "nonverbal" && clip.line.speaker !== "human") {
      problems.push(`clip ${clip.id} is nonverbal but not a human line`);
    }
    if (clip.kind === "dialogue" && clip.line.speaker !== "host") {
      problems.push(`clip ${clip.id} is host dialogue but not a host line`);
    }
  }

  for (const scene of scenes) {
    const hasVideo = timeline.clips.some(
      (clip) => clip.sceneId === scene.id && clip.kind === "video",
    );
    if (!hasVideo) problems.push(`scene ${scene.id} has no picture clip`);
  }

  return problems;
}

/** Programme-order scenes with their derived end times, for the editor gutter. */
export function sceneSpans(scenes: readonly Scene[] = SCENES): readonly {
  id: string;
  title: string;
  startSeconds: number;
  endSeconds: number;
  durationSeconds: number;
}[] {
  return [...scenes]
    .sort((a, b) => a.order - b.order)
    .map((scene) => ({
      id: scene.id,
      title: scene.title,
      startSeconds: scene.startSeconds,
      endSeconds: sceneEndSeconds(scene),
      durationSeconds: scene.durationSeconds,
    }));
}

/** The default pilot timeline. */
export const PILOT_TIMELINE: Timeline = buildTimeline(SCENES, SCENE_PLANS);