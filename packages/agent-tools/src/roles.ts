/**
 * The specialist roles.
 *
 * The AI Director decomposes a creative goal into typed tasks and delegates each to one
 * of these. Two properties are structural rather than advisory, because the spec's
 * "Agent tool allowlists" is only meaningful if it is enforced in code:
 *
 *   1. **A role may only invoke tools on its allowlist.** {@link assertToolPermitted} is
 *      the single gate; the executor calls it before dispatch and the registry is never
 *      reached without passing through it.
 *
 *   2. **Each role declares the output shape it must produce.** This is what a
 *      provider-backed planner's JSON schema is built from, so the model is asked for the
 *      shape the role actually owes — not a generic blob that a later stage has to guess
 *      at.
 *
 * Note the deliberate omissions. `qc_reviewer` cannot write, and `writer` cannot touch
 * the timeline. A reviewer that can edit the thing it reviews is not a reviewer, and the
 * separation is worth more than the convenience.
 */

import type { JsonSchema } from "./schema.js";
import { ToolError } from "./tool.js";
import { registerRoleSchemaProvider } from "./task.js";
import { TOOL, type ToolName } from "./tool-names.js";

// ---------------------------------------------------------------------------
// Role identity
// ---------------------------------------------------------------------------

export type RoleName =
  | "researcher"
  | "writer"
  | "character_designer"
  | "storyboard_artist"
  | "animator"
  | "audio_director"
  | "editor"
  | "qc_reviewer";

/**
 * A specialist the Director may delegate to.
 *
 * `systemPrompt` states the role's *constraints*, not its personality. Its job is to keep
 * a model from drifting into a neighbouring role's work — the failure mode where an
 * animator rewrites the script and the Director never notices.
 */
export interface Role {
  readonly name: RoleName;
  readonly displayName: string;
  /** One sentence: what this role owns. Appears in plan prose and audit records. */
  readonly responsibility: string;
  /**
   * The complete set of tools this role may invoke. Enforced, not advisory.
   * An empty array means the role reasons and produces structured output but calls no
   * tools — which is a legitimate and useful constraint for a reviewer.
   */
  readonly allowedTools: readonly ToolName[];
  /** JSON Schema for what this role must return. */
  readonly outputSchema: JsonSchema;
  /**
   * Whether this role's output is a candidate that a human should see before it is
   * treated as settled. Drives the default approval policy when a task is created.
   */
  readonly outputRequiresReview: boolean;
  /** Constraints given to a model playing this role. */
  readonly systemPrompt: string;
}

// ---------------------------------------------------------------------------
// Shared schema fragments
// ---------------------------------------------------------------------------

const nonEmptyString = (description: string, maxLength = 4000): JsonSchema => ({
  type: "string",
  minLength: 1,
  maxLength,
  description,
});

const stringList = (description: string): JsonSchema => ({
  type: "array",
  items: { type: "string", minLength: 1, maxLength: 500 },
  description,
});

/**
 * A character's locked design.
 *
 * `forbiddenDriftRules` is copied from `VisualTraitProfile` in `@kinema/types` and is the
 * practically important field: it records what must *never* change, which is the only
 * form of the design a QC pass can actually check against a generated frame.
 */
const characterDesignSchema: JsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["characterId", "displayName", "designBible", "palette", "forbiddenDriftRules"],
  properties: {
    characterId: nonEmptyString("Stable id for the character.", 120),
    displayName: nonEmptyString("Name as it appears to the user.", 120),
    designBible: nonEmptyString(
      "Prose design description precise enough to prompt from. Must describe silhouette, " +
        "palette, proportions and any signature feature.",
      4000,
    ),
    palette: {
      type: "array",
      minItems: 1,
      items: { type: "string", pattern: "^#?[0-9a-fA-F]{3,8}$" },
      description: "Hex colours, most dominant first.",
    },
    forbiddenDriftRules: {
      ...stringList("Things that must never change between shots. QC checks each one."),
    },
    referenceSetIds: stringList("Approved reference-sheet asset ids this design is pinned to."),
  },
};

const qcFindingSchema: JsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["check", "severity", "sceneId", "message"],
  properties: {
    check: nonEmptyString("Which check produced this finding.", 80),
    severity: { type: "string", enum: ["info", "warning", "error"] },
    sceneId: nonEmptyString("The scene the finding is about.", 120),
    message: nonEmptyString("What is wrong, in terms the user can act on.", 1000),
    suggestion: nonEmptyString("A concrete fix, when one exists.", 1000),
  },
};

// ---------------------------------------------------------------------------
// The eight roles
// ---------------------------------------------------------------------------

const RESEARCHER: Role = {
  name: "researcher",
  displayName: "Researcher",
  responsibility:
    "Gathers the factual and stylistic grounding a goal needs before anything is written or drawn, and states plainly what could not be established.",
  allowedTools: [TOOL.READ_REFERENCE_SNAPSHOT, TOOL.READ_SCRIPT],
  outputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["findings", "openQuestions"],
    properties: {
      findings: {
        type: "array",
        minItems: 1,
        items: {
          type: "object",
          additionalProperties: false,
          required: ["topic", "detail", "confidence"],
          properties: {
            topic: nonEmptyString("Subject of the finding.", 200),
            detail: nonEmptyString("What was established.", 2000),
            confidence: { type: "string", enum: ["high", "medium", "low"] },
            source: nonEmptyString("Where it came from. 'asserted' is not a source.", 500),
          },
        },
        description: "Findings relevant to the goal.",
      },
      openQuestions: stringList("Things that could not be established and need a human decision."),
    },
  },
  outputRequiresReview: true,
  systemPrompt:
    "You are the Researcher. Establish facts and stylistic references for the goal. " +
    "Mark anything you cannot verify as low confidence and record it in openQuestions " +
    "rather than guessing. Never write script lines, design characters, or plan shots.",
};

const WRITER: Role = {
  name: "writer",
  displayName: "Writer",
  responsibility:
    "Turns research and the creative goal into a script: scenes, dialogue, action and timing.",
  allowedTools: [TOOL.READ_SCRIPT, TOOL.WRITE_SCRIPT, TOOL.SCENE_PLAN, TOOL.READ_REFERENCE_SNAPSHOT],
  outputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["title", "logline", "scenes"],
    properties: {
      title: nonEmptyString("Working title.", 200),
      logline: nonEmptyString("One sentence describing the piece.", 600),
      scenes: {
        type: "array",
        minItems: 1,
        items: {
          type: "object",
          additionalProperties: false,
          required: ["id", "order", "title", "durationSeconds", "action", "dialogue"],
          properties: {
            id: nonEmptyString("Scene id, stable across rewrites.", 120),
            order: { type: "integer", minimum: 0, description: "Authoritative order." },
            title: nonEmptyString("Scene title.", 200),
            durationSeconds: {
              type: "number",
              exclusiveMinimum: 0,
              maximum: 600,
              description: "Authoritative duration in seconds.",
            },
            action: nonEmptyString(
              "What happens on screen. A scene with no action must be intentional, not empty.",
              4000,
            ),
            dialogue: {
              type: "array",
              items: {
                type: "object",
                additionalProperties: false,
                required: ["characterId", "line"],
                properties: {
                  characterId: nonEmptyString("Who speaks.", 120),
                  line: nonEmptyString("The spoken line.", 2000),
                  direction: nonEmptyString("Performance direction: pace, intensity, pauses.", 500),
                },
              },
              description: "Spoken lines. A silent character must never appear here.",
            },
            visualDirection: nonEmptyString(
              "Camera, framing, lighting and colour intent.",
              2000,
            ),
          },
        },
      },
    },
  },
  outputRequiresReview: true,
  systemPrompt:
    "You are the Writer. Produce a script with explicit per-scene durations that sum to the " +
    "requested runtime. Every scene needs action and visual direction. Respect any character " +
    "who is established as non-speaking: they must have no dialogue entries at all, however " +
    "tempting the storyboard art makes it to give them a line. Never generate images or " +
    "make claims about what a render will look like.",
};

const CHARACTER_DESIGNER: Role = {
  name: "character_designer",
  displayName: "Character Designer",
  responsibility:
    "Pins each character's visual identity — silhouette, palette, proportions and forbidden drift — so later shots stay recognisably the same character.",
  allowedTools: [TOOL.READ_REFERENCE_SNAPSHOT, TOOL.READ_SCRIPT],
  outputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["characters"],
    properties: {
      characters: {
        type: "array",
        minItems: 1,
        items: characterDesignSchema,
        description: "One entry per character in the script.",
      },
    },
  },
  outputRequiresReview: true,
  systemPrompt:
    "You are the Character Designer. For every character in the script, write a design bible " +
    "and an explicit list of forbidden drift rules. Never redesign a character that already " +
    "has an approved design — extend or clarify it instead. Never write dialogue.",
};

const STORYBOARD_ARTIST: Role = {
  name: "storyboard_artist",
  displayName: "Storyboard Artist",
  responsibility:
    "Breaks each scene into ordered shots with framing, composition and per-shot duration, and states the identity constraints each shot must honour.",
  allowedTools: [TOOL.READ_SCRIPT, TOOL.READ_REFERENCE_SNAPSHOT, TOOL.SCENE_PLAN],
  outputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["scenes"],
    properties: {
      scenes: {
        type: "array",
        minItems: 1,
        items: {
          type: "object",
          additionalProperties: false,
          required: ["sceneId", "shots"],
          properties: {
            sceneId: nonEmptyString("The script scene this board covers.", 120),
            shots: {
              type: "array",
              minItems: 1,
              items: {
                type: "object",
                additionalProperties: false,
                required: ["id", "order", "description", "durationSeconds"],
                properties: {
                  id: nonEmptyString("Shot id.", 120),
                  order: { type: "integer", minimum: 0 },
                  description: nonEmptyString("Framing, subject, action.", 1000),
                  durationSeconds: { type: "number", exclusiveMinimum: 0, maximum: 120 },
                  charactersOnScreen: stringList("Character ids visible in this shot."),
                  continuityNotes: nonEmptyString(
                    "The identity constraints this shot must honour.",
                    1000,
                  ),
                },
              },
            },
          },
        },
      },
    },
  },
  outputRequiresReview: true,
  systemPrompt:
    "You are the Storyboard Artist. Break each scene into ordered shots whose durations sum " +
    "to the scene duration. State which characters are on screen and what must stay " +
    "consistent. Never invent new characters and never change a scene's duration — if the " +
    "shots will not fit, say so rather than silently retiming the scene.",
};

const ANIMATOR: Role = {
  name: "animator",
  displayName: "Animator",
  responsibility:
    "Specifies the motion for each shot: what actually moves, how, and what the generation request must carry to achieve it.",
  allowedTools: [TOOL.READ_SCRIPT, TOOL.READ_REFERENCE_SNAPSHOT],
  outputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["shots"],
    properties: {
      shots: {
        type: "array",
        minItems: 1,
        items: {
          type: "object",
          additionalProperties: false,
          required: ["shotId", "animationMode", "motionDescription"],
          properties: {
            shotId: nonEmptyString("The storyboard shot this motion belongs to.", 120),
            animationMode: {
              type: "string",
              enum: ["layered_2d", "generated_video", "hybrid", "static"],
              description: "Mirrors AnimationMode in @kinema/types.",
            },
            motionDescription: nonEmptyString(
              "What moves, and how. 'Ken Burns zoom on a still' is a valid but weak answer " +
                "and must be flagged when the brief demands real movement.",
              2000,
            ),
            /**
             * Present so the animator can be *held to* the brief's requirement of real
             * movement rather than a pan over a still. A QC check reads this field.
             */
            isRealMovement: {
              type: "boolean",
              description:
                "True only when something other than the camera moves. A pan, zoom or " +
                "truck over static artwork is NOT real movement.",
            },
            referenceAssetIds: stringList("Identity references this shot must be generated against."),
            generationRequest: {
              type: "object",
              additionalProperties: false,
              properties: {
                modelId: nonEmptyString("Provider-local model id.", 200),
                prompt: nonEmptyString("Positive prompt.", 4000),
                negativePrompt: nonEmptyString("Negative prompt.", 2000),
                seed: { type: "integer", minimum: 0 },
              },
            },
          },
        },
      },
    },
  },
  outputRequiresReview: true,
  systemPrompt:
    "You are the Animator. For each shot, say what moves. Set isRealMovement true only if " +
    "something other than the camera moves; a pan or zoom over static art is false and you " +
    "must say so. Prefer reference-pinned generation for character continuity. Never rewrite " +
    "the script or reorder shots.",
};

const AUDIO_DIRECTOR: Role = {
  name: "audio_director",
  displayName: "Audio Director",
  responsibility:
    "Casts voices, directs performance, and lays out music and effects against the scene timeline.",
  allowedTools: [TOOL.READ_SCRIPT, TOOL.READ_REFERENCE_SNAPSHOT],
  outputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["voiceCues", "audioLayers"],
    properties: {
      voiceCues: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["id", "sceneId", "line", "startSeconds"],
          properties: {
            id: nonEmptyString("Cue id.", 120),
            sceneId: nonEmptyString("Scene the line belongs to.", 120),
            characterId: nonEmptyString("Speaker.", 120),
            line: nonEmptyString("The spoken line.", 2000),
            startSeconds: { type: "number", minimum: 0 },
            direction: nonEmptyString("Emotion, pace, intensity, pauses.", 500),
          },
        },
        description: "One cue per spoken line. Silent characters must have none.",
      },
      audioLayers: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["id", "kind", "startSeconds", "gainDb"],
          properties: {
            id: nonEmptyString("Layer id.", 120),
            kind: { type: "string", enum: ["dialogue", "music", "sfx", "ambience"] },
            startSeconds: { type: "number", minimum: 0 },
            gainDb: { type: "number", minimum: -60, maximum: 12 },
            description: nonEmptyString("What the layer contains.", 500),
          },
        },
      },
    },
  },
  outputRequiresReview: true,
  systemPrompt:
    "You are the Audio Director. Every spoken line gets exactly one voice cue; a character " +
    "established as non-speaking gets none — only nonverbal sounds, which belong in audio " +
    "layers. Keep music and effects below dialogue and never place a cue past its scene's " +
    "end. Never write or alter dialogue text; if a line is missing, report it.",
};

const EDITOR: Role = {
  name: "editor",
  displayName: "Editor",
  responsibility:
    "Orders shots into a timeline, checks the programme duration against the target, and prepares the export.",
  allowedTools: [TOOL.READ_SCRIPT, TOOL.ASSEMBLE_TIMELINE, TOOL.ESTIMATE_COST],
  outputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["clips", "totalDurationSeconds"],
    properties: {
      clips: {
        type: "array",
        minItems: 1,
        items: {
          type: "object",
          additionalProperties: false,
          required: ["id", "sceneId", "startSeconds"],
          properties: {
            id: nonEmptyString("Clip id.", 120),
            sceneId: nonEmptyString("The scene this clip shows.", 120),
            startSeconds: { type: "number", minimum: 0 },
            note: nonEmptyString("Why this clip is here.", 500),
          },
        },
        description:
          "Start positions only. Clip duration is read from the scene and must never be " +
          "restated here — that is the consistency rule.",
      },
      totalDurationSeconds: { type: "number", exclusiveMinimum: 0 },
      targetDurationSeconds: { type: "number", exclusiveMinimum: 0 },
      durationDeltaSeconds: {
        type: "number",
        description: "total minus target. Non-zero means the cut does not hit the brief.",
      },
    },
  },
  outputRequiresReview: true,
  systemPrompt:
    "You are the Editor. Order clips and report the total duration against the target. " +
    "Never restate a clip's duration — it is read from the scene. If the total misses the " +
    "target, report the delta and propose which scene to adjust; do not silently change a " +
    "scene's duration, because that is the Writer's authority.",
};

const QC_REVIEWER: Role = {
  name: "qc_reviewer",
  displayName: "QC Reviewer",
  responsibility:
    "Checks the assembled plan for the failures that are cheap to catch before generation and expensive to catch after: missing content, timing drift, continuity breaks and silent-character violations.",
  /**
   * Explicitly no write tools. A reviewer that can edit the work it reviews cannot be
   * trusted to report on it, and every finding it raised would be unverifiable
   * afterwards because the artifact would have changed underneath it.
   */
  allowedTools: [TOOL.QC_CHECK, TOOL.READ_SCRIPT, TOOL.READ_REFERENCE_SNAPSHOT],
  outputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["passed", "findings", "checkedSceneIds"],
    properties: {
      passed: {
        type: "boolean",
        description: "True only when there are no findings of severity 'error'.",
      },
      findings: { type: "array", items: qcFindingSchema },
      checkedSceneIds: stringList("Every scene id actually examined. Coverage must be complete."),
      notes: nonEmptyString("Anything the checks could not cover.", 1000),
    },
  },
  outputRequiresReview: false,
  systemPrompt:
    "You are the QC Reviewer. Run every available check and report findings honestly, " +
    "including ones that reflect badly on earlier work. Set passed true only when no " +
    "finding has severity 'error'. Never fix anything yourself — you have no write tools, " +
    "and a reviewer that edits the work cannot be trusted to report on it.",
};

// ---------------------------------------------------------------------------
// The catalogue
// ---------------------------------------------------------------------------

/**
 * Every role, keyed by name.
 *
 * The eight roles named in the product spec, no more and no fewer. Adding a ninth is a
 * product decision, not an implementation detail, so it should be a visible edit here.
 */
export const ROLES: Readonly<Record<RoleName, Role>> = Object.freeze({
  researcher: RESEARCHER,
  writer: WRITER,
  character_designer: CHARACTER_DESIGNER,
  storyboard_artist: STORYBOARD_ARTIST,
  animator: ANIMATOR,
  audio_director: AUDIO_DIRECTOR,
  editor: EDITOR,
  qc_reviewer: QC_REVIEWER,
});

/** The role names, in the order a typical production uses them. */
export const ROLE_NAMES: readonly RoleName[] = [
  "researcher",
  "writer",
  "character_designer",
  "storyboard_artist",
  "animator",
  "audio_director",
  "editor",
  "qc_reviewer",
];

/**
 * Each role's output schema, keyed by role.
 *
 * This is what `createTask` uses when a caller does not supply an explicit `outputSchema`.
 * It is registered with `task.ts` on evaluation so that neither module has to be loaded
 * first — see `registerRoleSchemaProvider` for why that mattered.
 */
export const ROLE_OUTPUT_SCHEMAS: Readonly<Record<RoleName, JsonSchema>> = Object.freeze(
  Object.fromEntries(
    ROLE_NAMES.map((name) => [name, ROLES[name].outputSchema]),
  ) as Record<RoleName, JsonSchema>,
);

registerRoleSchemaProvider(() => ({ ROLE_OUTPUT_SCHEMAS }));

export function listRoles(): readonly Role[] {
  return ROLE_NAMES.map((name) => ROLES[name]);
}

export function isRoleName(value: string): value is RoleName {
  return Object.prototype.hasOwnProperty.call(ROLES, value);
}

/**
 * Look up a role.
 * @throws ToolError `unknown_role`, naming the roles that do exist.
 */
export function requireRole(name: string): Role {
  if (!isRoleName(name)) {
    throw new ToolError(
      "unknown_role",
      `"${name}" is not a known role. Known roles: ${ROLE_NAMES.join(", ")}.`,
      { userActionRequired: false },
    );
  }
  return ROLES[name];
}

/** Can this role invoke this tool? */
export function isToolPermitted(roleName: string, toolName: string): boolean {
  if (!isRoleName(roleName)) return false;
  return ROLES[roleName].allowedTools.includes(toolName as ToolName);
}

/**
 * The allowlist gate.
 *
 * Called by the executor before any dispatch. The error is deliberately explicit about
 * *why* it was refused and what the role may do instead: when this fires in practice it is
 * usually because a planner assigned work to the wrong role, and a message the Director
 * can act on turns a dead run into a re-plan.
 *
 * @throws ToolError `tool_not_permitted` when the role may not use the tool.
 * @throws ToolError `unknown_role` when the role does not exist.
 */
export function assertToolPermitted(roleName: string, toolName: string): void {
  const role = requireRole(roleName);
  if (!role.allowedTools.includes(toolName as ToolName)) {
    const permitted =
      role.allowedTools.length > 0 ? role.allowedTools.join(", ") : "(none — this role has no tools)";
    throw new ToolError(
      "tool_not_permitted",
      `Role "${roleName}" may not use tool "${toolName}". This role's allowlist is: ${permitted}.`,
      {
        toolName,
        retryable: false,
        userActionRequired: false,
        detail:
          `The allowlist exists so a specialist cannot act outside its remit — for example a ` +
          `reviewer editing the work it reviews. Reassign the task to a role that is permitted, ` +
          `or extend the allowlist deliberately.`,
      },
    );
  }
}

/**
 * Every tool any role may use, deduplicated.
 *
 * The executor registers only these: a tool no role may call is unreachable, and
 * shipping it would widen the surface the model sees for no benefit.
 */
export function toolsUsedByRoles(): readonly ToolName[] {
  const used = new Set<ToolName>();
  for (const role of listRoles()) {
    for (const tool of role.allowedTools) used.add(tool);
  }
  return [...used];
}

/**
 * Roles permitted to call a tool, for error messages and the UI's permission view.
 */
export function rolesPermittedToUse(toolName: string): readonly RoleName[] {
  return ROLE_NAMES.filter((name) => ROLES[name].allowedTools.includes(toolName as ToolName));
}