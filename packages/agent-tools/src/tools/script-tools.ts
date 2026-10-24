/**
 * Script reading and writing.
 *
 * These two tools are the whole of the Writer's authority. The split exists so that a role
 * can read a script without being able to change it — the QC reviewer holds `read_script`
 * and not `write_script`, so a review cannot silently alter the thing it reviewed.
 *
 * Neither tool touches the filesystem or the network. "Writing" a script means producing a
 * validated `Script` value that the executor records as an artifact; persistence belongs to
 * the project store, not to an agent tool. That keeps this package offline by construction,
 * and keeps a model's output from reaching a disk path it chose.
 */

import type { JsonSchema } from "../schema.js";
import { ToolError, type Tool } from "../tool.js";
import {
  SCRIPT_SCHEMA,
  scriptDurationSeconds,
  type Script,
  type ScriptScene,
} from "./script-data.js";
import { TOOL } from "../tool-names.js";

// ---------------------------------------------------------------------------
// read_script
// ---------------------------------------------------------------------------

export interface ReadScriptInput {
  /** The script to read. Supplied inline: there is no ambient project store here. */
  readonly script: Script;
  /**
   * Restrict the answer to these scene ids.
   *
   * A real production script runs to dozens of scenes, and a role that needs scene 7 should
   * not spend its context on scenes 1–6. Empty or absent means "all of them".
   */
  readonly sceneIds?: readonly string[];
  /** Include the full scene bodies. False returns the outline only. */
  readonly includeScenes?: boolean;
}

export interface ScriptOutlineScene {
  readonly id: string;
  readonly order: number;
  readonly title: string;
  readonly durationSeconds: number;
  readonly dialogueLineCount: number;
  readonly hasVisualDirection: boolean;
}

export interface ReadScriptOutput {
  readonly title: string;
  readonly logline: string;
  readonly revision: number;
  readonly sceneCount: number;
  readonly totalDurationSeconds: number;
  readonly silentCharacterIds: readonly string[];
  readonly outline: readonly ScriptOutlineScene[];
  /** Full scenes, when requested. Absent rather than empty when not. */
  readonly scenes?: readonly ScriptScene[];
}

export const READ_SCRIPT_OUTPUT_SCHEMA: JsonSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "title",
    "logline",
    "revision",
    "sceneCount",
    "totalDurationSeconds",
    "silentCharacterIds",
    "outline",
  ],
  properties: {
    title: { type: "string" },
    logline: { type: "string" },
    revision: { type: "integer", minimum: 0 },
    sceneCount: { type: "integer", minimum: 0 },
    totalDurationSeconds: { type: "number", minimum: 0 },
    silentCharacterIds: { type: "array", items: { type: "string" } },
    outline: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "order", "title", "durationSeconds", "dialogueLineCount", "hasVisualDirection"],
        properties: {
          id: { type: "string" },
          order: { type: "integer" },
          title: { type: "string" },
          durationSeconds: { type: "number" },
          dialogueLineCount: { type: "integer", minimum: 0 },
          hasVisualDirection: { type: "boolean" },
        },
      },
    },
    scenes: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: true,
      },
    },
  },
};

export const readScriptTool: Tool<ReadScriptInput, ReadScriptOutput> = {
  name: TOOL.READ_SCRIPT,
  description:
    "Read a script: returns a scene outline with durations and dialogue counts, and " +
    "optionally the full scene bodies. Use it before writing, storyboarding, animating or " +
    "reviewing, so the work is based on the actual script rather than an assumption about it.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["script"],
    properties: {
      script: SCRIPT_SCHEMA,
      sceneIds: {
        type: "array",
        items: { type: "string", minLength: 1, maxLength: 120 },
        description: "Restrict the result to these scene ids. Absent means every scene.",
      },
      includeScenes: {
        type: "boolean",
        description: "Include full scene bodies. Default false — the outline is usually enough.",
      },
    },
  },
  outputSchema: READ_SCRIPT_OUTPUT_SCHEMA,
  requiresApproval: false,
  estimatedCost: 0,
  sideEffecting: false,

  run(input) {
    const script = input.script;

    /**
     * Requesting a scene that does not exist is an error, not an empty result. A silent
     * empty list would let a downstream role conclude "this scene has no dialogue" when the
     * truth is "that scene id was wrong" — the kind of failure that produces a confident,
     * wrong storyboard.
     */
    if (input.sceneIds !== undefined && input.sceneIds.length > 0) {
      const known = new Set(script.scenes.map((scene) => scene.id));
      const unknown = input.sceneIds.filter((id) => !known.has(id));
      if (unknown.length > 0) {
        throw new ToolError(
          "invalid_input",
          `No scene(s) with id ${unknown.join(", ")} in this script. Known ids: ${[...known].sort().join(", ")}.`,
          {
            path: "/sceneIds",
            toolName: TOOL.READ_SCRIPT,
            userActionRequired: false,
          },
        );
      }
    }

    const selected =
      input.sceneIds === undefined || input.sceneIds.length === 0
        ? [...script.scenes]
        : script.scenes.filter((scene) => input.sceneIds?.includes(scene.id) === true);

    const ordered = [...selected].sort((a, b) => a.order - b.order);

    const output: ReadScriptOutput = {
      title: script.title,
      logline: script.logline,
      revision: script.revision ?? 0,
      sceneCount: ordered.length,
      // Deliberately the *selected* scenes' duration, not the whole script's, so the number
      // always answers the question the caller actually asked.
      totalDurationSeconds: scriptDurationSeconds({ ...script, scenes: ordered }),
      silentCharacterIds: script.silentCharacterIds,
      outline: ordered.map((scene) => ({
        id: scene.id,
        order: scene.order,
        title: scene.title,
        durationSeconds: scene.durationSeconds,
        dialogueLineCount: scene.dialogue.length,
        hasVisualDirection:
          scene.visualDirection !== undefined && scene.visualDirection.trim().length > 0,
      })),
      ...(input.includeScenes === true ? { scenes: ordered } : {}),
    };

    return output;
  },
};

// ---------------------------------------------------------------------------
// write_script
// ---------------------------------------------------------------------------

export interface WriteScriptInput {
  readonly projectId?: string;
  readonly title: string;
  readonly logline: string;
  readonly scenes: readonly ScriptScene[];
  readonly silentCharacterIds?: readonly string[];
  /** Target runtime. When present, the tool refuses a script that misses it. */
  readonly targetDurationSeconds?: number;
  /**
   * How far the total may drift from the target before it is refused.
   * Defaults to 0 — a duration target is a requirement, not a preference.
   */
  readonly durationToleranceSeconds?: number;
  /** Increment the revision. Defaults to a first revision. */
  readonly previousRevision?: number;
}

export interface WriteScriptOutput {
  readonly script: Script;
  readonly revision: number;
  readonly sceneCount: number;
  readonly totalDurationSeconds: number;
  readonly durationDeltaSeconds: number;
  readonly warnings: readonly string[];
}

export const WRITE_SCRIPT_OUTPUT_SCHEMA: JsonSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "script",
    "revision",
    "sceneCount",
    "totalDurationSeconds",
    "durationDeltaSeconds",
    "warnings",
  ],
  properties: {
    script: SCRIPT_SCHEMA,
    revision: { type: "integer", minimum: 0 },
    sceneCount: { type: "integer", minimum: 1 },
    totalDurationSeconds: { type: "number", exclusiveMinimum: 0 },
    durationDeltaSeconds: { type: "number" },
    warnings: { type: "array", items: { type: "string" } },
  },
};

export const writeScriptTool: Tool<WriteScriptInput, WriteScriptOutput> = {
  name: TOOL.WRITE_SCRIPT,
  description:
    "Validate and record a script. Checks that scene ids are unique, that order is " +
    "unambiguous, that durations are positive, that no scene is empty, and — when a target " +
    "runtime is given — that the scenes actually sum to it. Refuses a script that fails " +
    "rather than storing something the rest of the production would be built on.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["title", "logline", "scenes"],
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
      silentCharacterIds: {
        type: "array",
        maxItems: 100,
        items: { type: "string", minLength: 1, maxLength: 120 },
        uniqueItems: true,
      },
      targetDurationSeconds: { type: "number", exclusiveMinimum: 0, maximum: 36000 },
      durationToleranceSeconds: { type: "number", minimum: 0, maximum: 600 },
      previousRevision: { type: "integer", minimum: 0 },
    },
  },
  outputSchema: WRITE_SCRIPT_OUTPUT_SCHEMA,
  requiresApproval: false,
  estimatedCost: 0,
  sideEffecting: false,

  run(input) {
    const silent = new Set(input.silentCharacterIds ?? []);
    const warnings: string[] = [];

    // ── Structural validity ───────────────────────────────────────────────
    const seenIds = new Set<string>();
    const duplicateIds: string[] = [];
    for (const scene of input.scenes) {
      if (seenIds.has(scene.id)) duplicateIds.push(scene.id);
      seenIds.add(scene.id);
    }
    if (duplicateIds.length > 0) {
      throw new ToolError(
        "invalid_input",
        `Duplicate scene id(s): ${[...new Set(duplicateIds)].join(", ")}. Scene ids must be ` +
          `unique, because a storyboard card and a timeline clip both reference a scene by id ` +
          `and would otherwise be ambiguous.`,
        { path: "/scenes", toolName: TOOL.WRITE_SCRIPT, userActionRequired: false },
      );
    }

    const seenOrders = new Map<number, string[]>();
    for (const scene of input.scenes) {
      const list = seenOrders.get(scene.order) ?? [];
      list.push(scene.id);
      seenOrders.set(scene.order, list);
    }
    const collidingOrders = [...seenOrders.entries()].filter(([, ids]) => ids.length > 1);
    if (collidingOrders.length > 0) {
      throw new ToolError(
        "invalid_input",
        `Scene order is ambiguous: order value(s) ${collidingOrders
          .map(([order, ids]) => `${order} used by ${ids.join(" and ")}`)
          .join("; ")}. Order is authoritative for the whole production, so a tie cannot be resolved later.`,
        { path: "/scenes", toolName: TOOL.WRITE_SCRIPT, userActionRequired: false },
      );
    }

    for (const scene of input.scenes) {
      if (!Number.isFinite(scene.durationSeconds) || scene.durationSeconds <= 0) {
        throw new ToolError(
          "invalid_input",
          `Scene "${scene.id}" has a non-positive duration (${String(scene.durationSeconds)}).`,
          { path: "/scenes", toolName: TOOL.WRITE_SCRIPT, userActionRequired: false },
        );
      }
    }

    const ordered = [...input.scenes].sort((a, b) => a.order - b.order);
    const totalDurationSeconds = scriptDurationSeconds({ ...EMPTY_SCRIPT, scenes: ordered });

    // ── Duration target ───────────────────────────────────────────────────
    let durationDeltaSeconds = 0;
    if (input.targetDurationSeconds !== undefined) {
      durationDeltaSeconds = totalDurationSeconds - input.targetDurationSeconds;
      const tolerance = input.durationToleranceSeconds ?? 0;
      if (Math.abs(durationDeltaSeconds) > tolerance) {
        throw new ToolError(
          "invalid_input",
          `The script runs ${totalDurationSeconds.toFixed(2)}s against a target of ` +
            `${input.targetDurationSeconds.toFixed(2)}s — off by ${durationDeltaSeconds.toFixed(2)}s, ` +
            `beyond the ${tolerance.toFixed(2)}s tolerance. Adjust the scenes rather than ` +
            `accepting a runtime the brief did not ask for.`,
          {
            path: "/scenes",
            toolName: TOOL.WRITE_SCRIPT,
            userActionRequired: true,
          },
        );
      }
    }

    // ── Content warnings ──────────────────────────────────────────────────
    /**
     * Warnings, not refusals: a scene with no dialogue is legitimate (a chase has none), so
     * refusing it would reject correct work. The checks that *must* fail the write are the
     * structural ones above. These are surfaced so the Writer can decide.
     */
    for (const scene of ordered) {
      const hasDirection =
        scene.visualDirection !== undefined && scene.visualDirection.trim().length > 0;
      if (scene.dialogue.length === 0 && !hasDirection) {
        warnings.push(
          `Scene "${scene.id}" has no dialogue and no visual direction. Nothing tells the ` +
            `storyboard artist what to draw.`,
        );
      }
      if (scene.dialogue.length > 0 && !hasDirection && scene.action.trim().length < 20) {
        warnings.push(
          `Scene "${scene.id}" has dialogue but almost no action or direction; the shot is ` +
            `under-specified.`,
        );
      }
      for (const entry of scene.dialogue) {
        if (silent.has(entry.characterId)) {
          warnings.push(
            `Scene "${scene.id}" gives a line to "${entry.characterId}", who is marked silent. ` +
              `This is a continuity violation, not a style choice.`,
          );
        }
      }
    }

    if (ordered.length > 1) {
      const gaps: string[] = [];
      for (let i = 1; i < ordered.length; i += 1) {
        const previous = ordered[i - 1];
        const current = ordered[i];
        if (previous === undefined || current === undefined) continue;
        if (current.order !== previous.order + 1) gaps.push(`${current.id} follows ${previous.id}`);
      }
      if (gaps.length > 0) {
        // Not an error: sparse ordering is explicitly allowed by the domain model, where a
        // reorder should touch one row rather than renumber the project.
        warnings.push(
          `Scene order is sparse or non-consecutive (${gaps.join("; ")}). This is allowed, ` +
            `but confirm it is intentional.`,
        );
      }
    }

    const revision = (input.previousRevision ?? 0) + 1;
    const script: Script = {
      ...(input.projectId !== undefined ? { projectId: input.projectId } : {}),
      title: input.title,
      logline: input.logline,
      scenes: ordered,
      silentCharacterIds: [...silent].sort(),
      revision,
    };

    return {
      script,
      revision,
      sceneCount: ordered.length,
      totalDurationSeconds,
      durationDeltaSeconds,
      warnings,
    };
  },
};

const EMPTY_SCRIPT: Script = {
  title: "",
  logline: "",
  scenes: [],
  silentCharacterIds: [],
};