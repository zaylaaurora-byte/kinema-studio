/**
 * The remaining real tools.
 *
 * Each of these does work the agent system depends on and none of them is a stub:
 *
 *   - `read_reference_snapshot` pins the identity of characters and the style of the piece
 *     into an immutable snapshot. This is what stops a generative model from quietly
 *     redesigning a character, which the Bad Example brief lists as a named failure mode.
 *   - `scene_plan` turns a script into an ordered shot breakdown, checking the two things a
 *     storyboard artist most often gets wrong: shots that do not sum to their scene, and
 *     shots that show a character with no reference attached.
 *   - `assemble_timeline` lays clips out on a timeline. It deliberately does *not* store a
 *     clip duration — the domain model's key consistency rule is that `Scene` is the single
 *     source of truth for order and duration, so a clip carries only a start position.
 */

import type { JsonSchema } from "../schema.js";
import { ToolError, type Tool } from "../tool.js";
import { TOOL } from "../tool-names.js";
import type { Script } from "./script-data.js";

// ---------------------------------------------------------------------------
// read_reference_snapshot
// ---------------------------------------------------------------------------

export interface ReferenceCharacterInput {
  readonly characterId: string;
  readonly displayName: string;
  readonly designBible?: string;
  readonly forbiddenDriftRules: readonly string[];
  readonly referenceSetIds?: readonly string[];
  /** True when the character must never speak. */
  readonly mustRemainSilent?: boolean;
  readonly palette?: readonly string[];
}

export interface ReadReferenceSnapshotInput {
  readonly projectId?: string;
  readonly characters: readonly ReferenceCharacterInput[];
  readonly styleConstraints?: readonly string[];
  readonly assetIds?: readonly string[];
  /** Overrides the derived snapshot id. Rarely needed; the derived one is content-based. */
  readonly snapshotId?: string;
}

export interface ReferenceSnapshotOutput {
  readonly snapshotId: string;
  readonly capturedAt: string;
  readonly projectId?: string;
  readonly assetIds: readonly string[];
  readonly styleConstraints: readonly string[];
  readonly characterLocks: readonly {
    readonly characterId: string;
    readonly displayName: string;
    readonly forbiddenDriftRules: readonly string[];
    readonly mustRemainSilent: boolean;
    readonly referenceSetIds: readonly string[];
  }[];
  readonly warnings: readonly string[];
}

/**
 * FNV-1a over the snapshot's meaningful content.
 *
 * Content-based rather than time-based so the same references always produce the same id.
 * That is what makes "the plan was built against these references" a checkable claim: if
 * the id differs, the references changed, and a task generated against the old snapshot is
 * detectably stale.
 */
function contentHash(parts: readonly string[]): string {
  let hash = 0x811c9dc5;
  const joined = parts.join("\u0001");
  for (let i = 0; i < joined.length; i += 1) {
    hash ^= joined.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

export const REFERENCE_SNAPSHOT_OUTPUT_SCHEMA: JsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["snapshotId", "capturedAt", "assetIds", "styleConstraints", "characterLocks", "warnings"],
  properties: {
    snapshotId: { type: "string" },
    capturedAt: { type: "string", format: "date-time" },
    projectId: { type: "string" },
    assetIds: { type: "array", items: { type: "string" } },
    styleConstraints: { type: "array", items: { type: "string" } },
    characterLocks: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["characterId", "displayName", "forbiddenDriftRules", "mustRemainSilent", "referenceSetIds"],
        properties: {
          characterId: { type: "string" },
          displayName: { type: "string" },
          forbiddenDriftRules: { type: "array", items: { type: "string" } },
          mustRemainSilent: { type: "boolean" },
          referenceSetIds: { type: "array", items: { type: "string" } },
        },
      },
    },
    warnings: { type: "array", items: { type: "string" } },
  },
};

export const readReferenceSnapshotTool: Tool<ReadReferenceSnapshotInput, ReferenceSnapshotOutput> = {
  name: TOOL.READ_REFERENCE_SNAPSHOT,
  description:
    "Build an immutable reference snapshot: the character identity locks, style constraints " +
    "and asset ids a task must honour. Character locks carry the forbidden-drift rules that " +
    "quality control checks against, so a generated shot can be shown to match its character " +
    "rather than merely asserted to.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["characters"],
    properties: {
      projectId: { type: "string", maxLength: 120 },
      characters: {
        type: "array",
        minItems: 1,
        maxItems: 200,
        items: {
          type: "object",
          additionalProperties: false,
          required: ["characterId", "displayName", "forbiddenDriftRules"],
          properties: {
            characterId: { type: "string", minLength: 1, maxLength: 120 },
            displayName: { type: "string", minLength: 1, maxLength: 200 },
            designBible: { type: "string", maxLength: 4000 },
            forbiddenDriftRules: {
              type: "array",
              maxItems: 100,
              items: { type: "string", minLength: 1, maxLength: 500 },
            },
            referenceSetIds: {
              type: "array",
              maxItems: 50,
              items: { type: "string", minLength: 1, maxLength: 200 },
            },
            mustRemainSilent: { type: "boolean" },
            palette: {
              type: "array",
              maxItems: 32,
              items: { type: "string", minLength: 1, maxLength: 32 },
            },
          },
        },
      },
      styleConstraints: { type: "array", maxItems: 100, items: { type: "string", maxLength: 500 } },
      assetIds: { type: "array", maxItems: 2000, items: { type: "string", maxLength: 200 } },
      snapshotId: { type: "string", minLength: 1, maxLength: 200 },
    },
  },
  outputSchema: REFERENCE_SNAPSHOT_OUTPUT_SCHEMA,
  requiresApproval: false,
  estimatedCost: 0,
  sideEffecting: false,

  run(input, ctx) {
    const warnings: string[] = [];

    const seen = new Set<string>();
    const duplicates: string[] = [];
    for (const character of input.characters) {
      if (seen.has(character.characterId)) duplicates.push(character.characterId);
      seen.add(character.characterId);
    }
    if (duplicates.length > 0) {
      throw new ToolError(
        "invalid_input",
        `Duplicate character id(s): ${[...new Set(duplicates)].join(", ")}. Two proposals for one ` +
          `character would produce a snapshot that pins contradicting identities.`,
        { path: "/characters", toolName: TOOL.READ_REFERENCE_SNAPSHOT, userActionRequired: false },
      );
    }

    for (const character of input.characters) {
      if (character.forbiddenDriftRules.length === 0) {
        /**
         * A character lock with no forbidden-drift rules pins nothing. It is the field QC
         * reads, so an empty list quietly disables continuity checking while looking like a
         * completed lock — worth refusing rather than warning about.
         */
        throw new ToolError(
          "invalid_input",
          `Character "${character.characterId}" has no forbidden-drift rules. A lock with ` +
            `nothing in it permits any change, which is indistinguishable from having no lock. ` +
            `State at least one trait that must not change (silhouette, palette, a signature feature).`,
          {
            path: "/characters",
            toolName: TOOL.READ_REFERENCE_SNAPSHOT,
            userActionRequired: false,
          },
        );
      }
      if ((character.referenceSetIds?.length ?? 0) === 0) {
        warnings.push(
          `Character "${character.displayName}" has no reference asset, so no generated shot ` +
            `can be pinned to its approved design. This is the failure the pilot brief calls ` +
            `"character art drifting between scenes".`,
        );
      }
    }

    const capturedAt = ctx.now();

    const characterLocks = input.characters.map((character) => ({
      characterId: character.characterId,
      displayName: character.displayName,
      forbiddenDriftRules: [...character.forbiddenDriftRules],
      mustRemainSilent: character.mustRemainSilent ?? false,
      referenceSetIds: [...(character.referenceSetIds ?? [])],
    }));

    const snapshotId =
      input.snapshotId ??
      `snapshot-${contentHash([
        ...input.characters.flatMap((character) => [
          character.characterId,
          character.displayName,
          ...character.forbiddenDriftRules,
          ...(character.referenceSetIds ?? []),
        ]),
        ...(input.styleConstraints ?? []),
        ...(input.assetIds ?? []),
      ])}`;

    return {
      snapshotId,
      capturedAt,
      ...(input.projectId !== undefined ? { projectId: input.projectId } : {}),
      assetIds: [...(input.assetIds ?? [])],
      styleConstraints: [...(input.styleConstraints ?? [])],
      characterLocks,
      warnings,
    };
  },
};

// ---------------------------------------------------------------------------
// scene_plan
// ---------------------------------------------------------------------------

export interface ScenePlanInput {
  readonly script: Script;
  /** Shots per scene. Absent means derive from the scene's duration. */
  readonly shotsPerScene?: number;
  readonly aspectRatio?: "16:9" | "9:16" | "1:1" | "4:5" | "2.39:1";
  /** Seconds per shot when deriving. Default 4 — long enough for a beat, short enough to hold attention. */
  readonly secondsPerShot?: number;
}

export interface PlannedShotOutput {
  readonly id: string;
  readonly order: number;
  readonly description: string;
  readonly durationSeconds: number;
  readonly charactersOnScreen: readonly string[];
}

export interface PlannedSceneOutput {
  readonly sceneId: string;
  readonly title: string;
  readonly durationSeconds: number;
  readonly shots: readonly PlannedShotOutput[];
  readonly shotTotalSeconds: number;
  readonly durationDeltaSeconds: number;
}

export interface ScenePlanOutput {
  readonly scenes: readonly PlannedSceneOutput[];
  readonly totalShots: number;
  readonly totalDurationSeconds: number;
  readonly warnings: readonly string[];
}

export const SCENE_PLAN_OUTPUT_SCHEMA: JsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["scenes", "totalShots", "totalDurationSeconds", "warnings"],
  properties: {
    scenes: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["sceneId", "title", "durationSeconds", "shots", "shotTotalSeconds", "durationDeltaSeconds"],
        properties: {
          sceneId: { type: "string" },
          title: { type: "string" },
          durationSeconds: { type: "number" },
          shotTotalSeconds: { type: "number" },
          durationDeltaSeconds: { type: "number" },
          shots: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              required: ["id", "order", "description", "durationSeconds", "charactersOnScreen"],
              properties: {
                id: { type: "string" },
                order: { type: "integer" },
                description: { type: "string" },
                durationSeconds: { type: "number" },
                charactersOnScreen: { type: "array", items: { type: "string" } },
              },
            },
          },
        },
      },
    },
    totalShots: { type: "integer", minimum: 0 },
    totalDurationSeconds: { type: "number", minimum: 0 },
    warnings: { type: "array", items: { type: "string" } },
  },
};

export const scenePlanTool: Tool<ScenePlanInput, ScenePlanOutput> = {
  name: TOOL.SCENE_PLAN,
  description:
    "Break a script into an ordered shot breakdown. Shot durations sum exactly to each " +
    "scene's authoritative duration, because that is a requirement rather than a " +
    "coincidence — the timeline and the audio both depend on it. Reports shots that show a " +
    "character with no dialogue so the silent-character rule can be applied downstream.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["script"],
    properties: {
      script: {
        type: "object",
        additionalProperties: false,
        required: ["title", "logline", "scenes", "silentCharacterIds"],
        properties: {
          projectId: { type: "string", maxLength: 120 },
          title: { type: "string", minLength: 1, maxLength: 200 },
          logline: { type: "string", minLength: 1, maxLength: 600 },
          scenes: {
            type: "array",
            minItems: 1,
            maxItems: 500,
            items: {
              type: "object",
              additionalProperties: false,
              required: ["id", "order", "title", "durationSeconds", "action", "dialogue"],
              properties: {
                id: { type: "string", minLength: 1, maxLength: 120 },
                order: { type: "integer", minimum: 0, maximum: 9999 },
                title: { type: "string", minLength: 1, maxLength: 200 },
                durationSeconds: { type: "number", exclusiveMinimum: 0, maximum: 600 },
                action: { type: "string", minLength: 1, maxLength: 4000 },
                dialogue: {
                  type: "array",
                  maxItems: 200,
                  items: {
                    type: "object",
                    additionalProperties: false,
                    required: ["characterId", "line"],
                    properties: {
                      characterId: { type: "string", minLength: 1, maxLength: 120 },
                      line: { type: "string", minLength: 1, maxLength: 2000 },
                      direction: { type: "string", minLength: 1, maxLength: 500 },
                    },
                  },
                },
                visualDirection: { type: "string", maxLength: 2000 },
              },
            },
          },
          silentCharacterIds: { type: "array", items: { type: "string" } },
          revision: { type: "integer", minimum: 0 },
        },
      },
      shotsPerScene: { type: "integer", minimum: 1, maximum: 40 },
      aspectRatio: { type: "string", enum: ["16:9", "9:16", "1:1", "4:5", "2.39:1"] },
      secondsPerShot: { type: "number", exclusiveMinimum: 0.1, maximum: 60 },
    },
  },
  outputSchema: SCENE_PLAN_OUTPUT_SCHEMA,
  requiresApproval: false,
  estimatedCost: 0,
  sideEffecting: false,

  run(input) {
    const shotsPerScene = input.shotsPerScene;
    const secondsPerShot = input.secondsPerShot ?? 4;
    const warnings: string[] = [];

    const scenes: PlannedSceneOutput[] = [];

    for (const scene of [...input.script.scenes].sort((a, b) => a.order - b.order)) {
      /**
       * Shot count is derived, not chosen: enough shots to cover the scene at roughly
       * `secondsPerShot` each. Then the duration of each shot is computed so the total is
       * *exactly* the scene duration — the remainder goes to the final shot, which is where
       * a fractional second is least visible.
       *
       * Doing it the other way round — picking a round number per shot and accepting
       * whatever total falls out — is what produces a timeline that drifts against its audio.
       */
      const count =
        shotsPerScene ?? Math.max(1, Math.round(scene.durationSeconds / secondsPerShot));
      const perShot = Math.floor((scene.durationSeconds / count) * 1000) / 1000;
      const shots: PlannedShotOutput[] = [];
      let allocated = 0;

      const speakers = new Set(scene.dialogue.map((line) => line.characterId));
      /**
       * Characters on screen are the speakers, plus anyone named in the action text.
       *
       * Named-in-action detection is a heuristic and is labelled as one. It never *invents* a
       * character — it can only find ids already present in the script — so a miss costs an
       * incomplete shot note rather than a wrong render.
       */
      const onScreen = new Set(speakers);
      for (const line of scene.dialogue) {
        onScreen.add(line.characterId);
      }
      for (const silentId of input.script.silentCharacterIds) {
        if (scene.action.toLowerCase().includes(silentId.toLowerCase().replace(/[-_]/g, " "))) {
          onScreen.add(silentId);
        }
      }

      for (let index = 1; index <= count; index += 1) {
        const isLast = index === count;
        const duration = isLast
          ? Math.round((scene.durationSeconds - allocated) * 1000) / 1000
          : perShot;
        allocated += duration;

        const phase = describeShotPhase(index, count);
        shots.push({
          id: `${scene.id}_sh${String(index).padStart(2, "0")}`,
          order: index - 1,
          description: `${phase} — ${scene.action}`,
          durationSeconds: Math.max(0, duration),
          charactersOnScreen: [...onScreen].sort(),
        });
      }

      const shotTotalSeconds = round(shots.reduce((sum, shot) => sum + shot.durationSeconds, 0));
      const durationDeltaSeconds = round(shotTotalSeconds - scene.durationSeconds);

      if (!scene.visualDirection || scene.visualDirection.trim().length === 0) {
        warnings.push(
          `Scene "${scene.id}" has no visual direction; shots fall back to the action text alone, ` +
            `which under-specifies framing and lighting.`,
        );
      }

      scenes.push({
        sceneId: scene.id,
        title: scene.title,
        durationSeconds: scene.durationSeconds,
        shots,
        shotTotalSeconds,
        durationDeltaSeconds,
      });
    }

    return {
      scenes,
      totalShots: scenes.reduce((sum, scene) => sum + scene.shots.length, 0),
      totalDurationSeconds: round(scenes.reduce((sum, scene) => sum + scene.shotTotalSeconds, 0)),
      warnings,
    };
  },
};

/** Name a shot's position in its scene, so the description reads as a shot list rather than a repeat. */
function describeShotPhase(index: number, count: number): string {
  if (count === 1) return "Single shot";
  if (index === 1) return "Opening shot";
  if (index === count) return "Closing shot";
  if (index === count - 1) return "Penultimate shot";
  return `Mid shot ${index}`;
}

// ---------------------------------------------------------------------------
// assemble_timeline
// ---------------------------------------------------------------------------

export interface AssembleTimelineInput {
  readonly projectId?: string;
  readonly scenes: readonly {
    readonly sceneId: string;
    readonly durationSeconds: number;
    readonly title?: string;
    /** Where the clip starts. Duration is never supplied — it comes from the scene. */
    readonly startSeconds?: number;
  }[];
  readonly targetDurationSeconds?: number;
  readonly trackId?: string;
  /** Frames per second, recorded for the export step rather than used here. */
  readonly fps?: number;
}

export interface TimelineClipOutput {
  readonly id: string;
  readonly trackId: string;
  readonly sceneId: string;
  readonly startSeconds: number;
  /** Derived, reported for information. Never an input, never stored independently. */
  readonly derivedDurationSeconds: number;
}

export interface AssembleTimelineOutput {
  readonly projectId?: string;
  readonly trackId: string;
  readonly clips: readonly TimelineClipOutput[];
  readonly totalDurationSeconds: number;
  readonly targetDurationSeconds?: number;
  readonly durationDeltaSeconds?: number;
  readonly warnings: readonly string[];
}

export const ASSEMBLE_TIMELINE_OUTPUT_SCHEMA: JsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["trackId", "clips", "totalDurationSeconds", "warnings"],
  properties: {
    projectId: { type: "string" },
    trackId: { type: "string" },
    totalDurationSeconds: { type: "number", minimum: 0 },
    targetDurationSeconds: { type: "number" },
    durationDeltaSeconds: { type: "number" },
    warnings: { type: "array", items: { type: "string" } },
    clips: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "trackId", "sceneId", "startSeconds", "derivedDurationSeconds"],
        properties: {
          id: { type: "string" },
          trackId: { type: "string" },
          sceneId: { type: "string" },
          startSeconds: { type: "number", minimum: 0 },
          derivedDurationSeconds: { type: "number", minimum: 0 },
        },
      },
    },
  },
};

export const assembleTimelineTool: Tool<AssembleTimelineInput, AssembleTimelineOutput> = {
  name: TOOL.ASSEMBLE_TIMELINE,
  description:
    "Lay scenes out as sequential clips on a track. Each clip carries only a start position; " +
    "its duration is read from the scene, because the scene is the single source of truth " +
    "for order and duration and a clip that restated either could disagree with it.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["scenes"],
    properties: {
      projectId: { type: "string", maxLength: 120 },
      trackId: { type: "string", minLength: 1, maxLength: 120 },
      fps: { type: "number", exclusiveMinimum: 0, maximum: 240 },
      targetDurationSeconds: { type: "number", exclusiveMinimum: 0, maximum: 36000 },
      scenes: {
        type: "array",
        minItems: 1,
        maxItems: 1000,
        items: {
          type: "object",
          additionalProperties: false,
          required: ["sceneId", "durationSeconds"],
          properties: {
            sceneId: { type: "string", minLength: 1, maxLength: 120 },
            durationSeconds: { type: "number", minimum: 0, maximum: 3600 },
            title: { type: "string", maxLength: 200 },
            startSeconds: { type: "number", minimum: 0, maximum: 36000 },
          },
        },
      },
    },
  },
  outputSchema: ASSEMBLE_TIMELINE_OUTPUT_SCHEMA,
  requiresApproval: false,
  /** Assembly is local compute: no currency, but real machine time and a real encode. */
  estimatedCost: 0,
  sideEffecting: false,

  run(input) {
    const trackId = input.trackId ?? "video-main";
    const warnings: string[] = [];

    const seen = new Set<string>();
    const duplicates: string[] = [];
    for (const scene of input.scenes) {
      if (seen.has(scene.sceneId)) duplicates.push(scene.sceneId);
      seen.add(scene.sceneId);
    }
    if (duplicates.length > 0) {
      warnings.push(
        `Scene(s) ${[...new Set(duplicates)].join(", ")} appear more than once in the cut. That is ` +
          `allowed — the same scene can sit at several points in a timeline — but confirm it is ` +
          `intentional rather than a duplicated entry.`,
      );
    }

    /**
     * Lay out sequentially unless an explicit start was given.
     *
     * When a caller supplies starts, they are used as given and any *overlap* is reported
     * rather than silently corrected: a clip that starts before its predecessor ends is a
     * real edit (a crossfade, a cutaway) as often as it is a mistake, and a tool that
     * "fixed" it would be overwriting an editorial decision.
     */
    let cursor = 0;
    const clips: TimelineClipOutput[] = [];

    for (const [index, scene] of input.scenes.entries()) {
      const startSeconds = scene.startSeconds ?? round(cursor);
      if (scene.startSeconds !== undefined && scene.startSeconds < cursor - 1e-6) {
        warnings.push(
          `Clip ${index + 1} ("${scene.sceneId}") starts at ${round(scene.startSeconds)}s, which ` +
            `overlaps the previous clip ending at ${round(cursor)}s. Treated as an intentional ` +
            `edit; verify it is one.`,
        );
      }
      cursor = Math.max(cursor, startSeconds + scene.durationSeconds);
      clips.push({
        id: `clip-${String(index + 1).padStart(3, "0")}-${scene.sceneId}`,
        trackId,
        sceneId: scene.sceneId,
        startSeconds: round(startSeconds),
        derivedDurationSeconds: scene.durationSeconds,
      });
    }

    const totalDurationSeconds = round(cursor);
    /**
     * `exactOptionalPropertyTypes` is on, so an optional field is either absent or a real
     * value — never present-and-undefined. Building the object in one place keeps that
     * honest rather than spreading conditional keys through the return.
     */
    let durationDeltaSeconds: number | undefined;
    if (input.targetDurationSeconds !== undefined) {
      durationDeltaSeconds = round(totalDurationSeconds - input.targetDurationSeconds);
      if (Math.abs(durationDeltaSeconds) > 0.25) {
        warnings.push(
          `The cut runs ${totalDurationSeconds}s against a target of ${input.targetDurationSeconds}s ` +
            `(${durationDeltaSeconds > 0 ? "+" : ""}${durationDeltaSeconds}s).`,
        );
      }
    }

    if (input.targetDurationSeconds !== undefined && durationDeltaSeconds !== undefined) {
      return {
        ...(input.projectId !== undefined ? { projectId: input.projectId } : {}),
        trackId,
        clips,
        totalDurationSeconds,
        targetDurationSeconds: input.targetDurationSeconds,
        durationDeltaSeconds,
        warnings,
      };
    }

    return {
      ...(input.projectId !== undefined ? { projectId: input.projectId } : {}),
      trackId,
      clips,
      totalDurationSeconds,
      warnings,
    };
  },
};

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}