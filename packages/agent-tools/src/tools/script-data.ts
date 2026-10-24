/**
 * The script data shape, shared by every script tool.
 *
 * ── Why this is a distinct shape from `Scene` in @kinema/types ───────────────
 *
 * `Scene` is the production source of truth: it owns casting, camera, audio layers,
 * revisions and status. A *script* is the document a writer produces before any of that
 * exists. Conflating them would mean a writer's tool call had to invent asset ids and
 * revision numbers it cannot know.
 *
 * So `ScriptScene` is the pre-production subset, and the mapping into real scenes happens
 * in the scene model, where it belongs. The overlap that matters is kept identical: order
 * and `durationSeconds` are authoritative on both, and the QC checks compare them.
 */

import type { JsonSchema } from "../schema.js";

export interface ScriptLine {
  readonly characterId: string;
  readonly line: string;
  /** Performance direction: pace, intensity, pauses. */
  readonly direction?: string;
}

export interface ScriptScene {
  /** Stable across rewrites, so a storyboard card keeps pointing at the right scene. */
  readonly id: string;
  /** Authoritative order. */
  readonly order: number;
  readonly title: string;
  /** Authoritative duration in seconds. */
  readonly durationSeconds: number;
  /** What happens on screen. */
  readonly action: string;
  readonly dialogue: readonly ScriptLine[];
  /**
   * Camera, framing, lighting and colour intent.
   *
   * Optional in the type but checked by QC when absent — a scene with no dialogue *and* no
   * visual direction is a scene nobody has thought about yet.
   */
  readonly visualDirection?: string;
}

export interface Script {
  readonly projectId?: string;
  readonly title: string;
  readonly logline: string;
  readonly scenes: readonly ScriptScene[];
  /**
   * Characters who must never speak.
   *
   * Carried on the script itself because it is a fact about the production that outlives
   * any one scene, and because it is the field that catches the continuity trap the Bad
   * Example brief warns about: storyboard art implying dialogue for a silent character.
   */
  readonly silentCharacterIds: readonly string[];
  readonly revision?: number;
}

/** Total runtime of a script, from its scenes. Never stored — always derived. */
export function scriptDurationSeconds(script: Script): number {
  return script.scenes.reduce((total, scene) => total + scene.durationSeconds, 0);
}

/** Look up a character's spoken lines across the whole script, in scene order. */
export function linesForCharacter(script: Script, characterId: string): readonly ScriptLine[] {
  return [...script.scenes]
    .sort((a, b) => a.order - b.order)
    .flatMap((scene) => scene.dialogue.filter((entry) => entry.characterId === characterId));
}

// ---------------------------------------------------------------------------
// JSON Schemas
// ---------------------------------------------------------------------------

const scriptLineSchema: JsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["characterId", "line"],
  properties: {
    characterId: { type: "string", minLength: 1, maxLength: 120 },
    line: { type: "string", minLength: 1, maxLength: 2000 },
    direction: { type: "string", minLength: 1, maxLength: 500 },
  },
};

const scriptSceneSchema: JsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["id", "order", "title", "durationSeconds", "action", "dialogue"],
  properties: {
    id: { type: "string", minLength: 1, maxLength: 120 },
    order: { type: "integer", minimum: 0, maximum: 9999 },
    title: { type: "string", minLength: 1, maxLength: 200 },
    durationSeconds: {
      type: "number",
      exclusiveMinimum: 0,
      maximum: 600,
      description: "Authoritative duration in seconds.",
    },
    action: { type: "string", minLength: 1, maxLength: 4000 },
    dialogue: { type: "array", maxItems: 200, items: scriptLineSchema },
    visualDirection: { type: "string", maxLength: 2000 },
  },
};

/**
 * The script schema.
 *
 * `silentCharacterIds` is required and defaults to `[]` rather than being optional. An
 * optional field invites omission, and an omitted silence list is indistinguishable from
 * "nobody is silent" — which is precisely the mistake the brief warns about.
 */
export const SCRIPT_SCHEMA: JsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["title", "logline", "scenes", "silentCharacterIds"],
  properties: {
    projectId: { type: "string", maxLength: 120 },
    title: { type: "string", minLength: 1, maxLength: 200 },
    logline: { type: "string", minLength: 1, maxLength: 600 },
    scenes: { type: "array", minItems: 1, maxItems: 500, items: scriptSceneSchema },
    silentCharacterIds: {
      type: "array",
      maxItems: 100,
      items: { type: "string", minLength: 1, maxLength: 120 },
      uniqueItems: true,
      description:
        "Characters who must never speak. A line attributed to one of these is a QC error.",
    },
    revision: { type: "integer", minimum: 0 },
  },
};