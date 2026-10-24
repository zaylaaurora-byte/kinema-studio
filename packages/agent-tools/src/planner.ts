/**
 * The planner: how a creative goal becomes a typed task graph.
 *
 * Two implementations, deliberately different in kind:
 *
 * - {@link MockPlanner} decomposes a goal with no model at all. It is deterministic: the
 *   same goal and context always produce a byte-identical plan. That is not a convenience
 *   — it is what makes the planner testable, what lets the cost of a run be predicted
 *   before a single credit is spent, and what makes "did the plan change?" a meaningful
 *   question when a user reruns a build.
 *
 * - {@link ProviderPlanner} asks a language model through the `ProviderAdapter` interface
 *   and validates the answer against a JSON schema. It never touches the network in tests;
 *   it takes an adapter, so a fake one exercises the whole path offline.
 *
 * Both produce the same artifact — a {@link TaskGraph} — so nothing downstream needs to
 * know which one built it. That is the point: the Director's approval, budget and audit
 * machinery cannot be bypassed by swapping the brain.
 */

import type {
  GenerationRequest,
  ModelDescriptor,
  NormalisedError,
  ProviderAdapter,
  ProviderCredentials,
} from "@kinema/types";

import { deterministicInt, shortHash } from "./deterministic.js";
import { assertToolPermitted, ROLES, type RoleName } from "./roles.js";
import type { JsonSchema } from "./schema.js";
import { validateAgainstSchema } from "./schema.js";
import {
  createTask,
  createTaskGraph,
  DEFAULT_TIMEOUT_MS,
  type AgentTask,
  type ApprovalGate,
  type ModelBinding,
  type ReferenceSnapshot,
  type TaskGraph,
} from "./task.js";
import { ToolError } from "./tool.js";
import { TOOL, type ToolName } from "./tool-names.js";

// ---------------------------------------------------------------------------
// Plan context
// ---------------------------------------------------------------------------

export interface PlanContext {
  /**
   * Target runtime in seconds. The single most load-bearing number in the plan: it
   * decides scene count, shot count and roughly half the cost.
   */
  readonly targetDurationSeconds?: number;
  readonly projectId?: string;
  readonly aspectRatio?: string;
  /** Models the Director may assign, by role. Reflections are kept as given. */
  readonly models?: Readonly<Record<string, readonly ModelBinding[]>>;
  /** Character locks carried into every task's reference snapshot. */
  readonly characterLocks?: ReferenceSnapshot["characterLocks"];
  readonly styleConstraints?: readonly string[];
  readonly assetIds?: readonly string[];
  /** Hash of the project state this plan is built against. */
  readonly snapshotId?: string;
  /** Ceiling the plan must fit inside. Nothing is dispatched over it. */
  readonly budgetCap?: number;
  readonly currency?: "USD" | "GBP" | "EUR";
  /**
   * Tasks that must be approved before dispatch, overriding the default policy.
   * Lets a cautious user gate every paid step without changing any role.
   */
  readonly requireApprovalFor?: readonly RoleName[];
  /**
   * Clock. Injected so that a plan's `createdAt` is reproducible in tests.
   * Defaults to the real clock.
   */
  readonly now?: () => string;
  readonly runId?: string;
  readonly goalId?: string;
}

/** What a planner is. The Director holds one of these and nothing more. */
export interface Planner {
  /** Stable identifier, recorded in the audit trail. */
  readonly id: string;
  /**
   * Decompose a goal into a task graph.
   *
   * @throws ToolError `precondition_failed` when the goal cannot be planned — a cyclic
   *   decomposition, or a plan that cannot fit the budget. Returning a bad graph would
   *   push the failure into the executor, where it is far more expensive to discover.
   */
  plan(goal: string, context: PlanContext): Promise<TaskGraph>;
}

// ---------------------------------------------------------------------------
// Goal analysis
// ---------------------------------------------------------------------------

export type VideoFormat = "2d_animation" | "faceless_video";

/**
 * What the planner understood from the goal.
 *
 * Exposed because it is the first thing a user should be shown when a plan looks wrong.
 * "It made eight scenes because you asked for 90 seconds" is a far better answer than a
 * plan that silently disagrees with the brief.
 */
export interface GoalAnalysis {
  readonly goal: string;
  readonly format: VideoFormat;
  readonly targetDurationSeconds: number;
  /** Why that duration: read from the goal, or defaulted. */
  readonly durationSource: "stated" | "default";
  readonly sceneCount: number;
  readonly style: string;
  readonly subject: string;
  readonly characterNames: readonly string[];
  /** True when the goal uses words like "series" or "episode". */
  readonly isSeries: boolean;
}

const DEFAULT_DURATION_SECONDS = 30;
const MIN_SCENE_SECONDS = 3;
const MAX_SCENE_SECONDS = 20;

/** Words that indicate the goal describes a faceless piece rather than animation. */
const FACELESS_MARKERS = [
  "faceless",
  "voiceover",
  "voice-over",
  "documentary",
  "explainer",
  "narrated",
  "essay",
];

const ANIMATION_MARKERS = [
  "animated",
  "animation",
  "animated short",
  "cartoon",
  "anime",
  "character",
  "cast",
  "rig",
  "sprite",
];

/**
 * Parse a goal for the numbers and intentions that shape the plan.
 *
 * Deliberately conservative. It reads durations and a handful of structural words, and
 * never tries to infer plot. Everything it cannot establish it records as a default so the
 * user can see and correct it, rather than inventing detail that reads as confident.
 */
export function analyseGoal(goal: string): GoalAnalysis {
  const lower = goal.toLowerCase();

  const duration = extractDurationSeconds(lower);
  const targetDurationSeconds = duration ?? DEFAULT_DURATION_SECONDS;

  const format: VideoFormat =
    FACELESS_MARKERS.some((marker) => lower.includes(marker)) &&
    !ANIMATION_MARKERS.some((marker) => lower.includes(marker))
      ? "faceless_video"
      : "2d_animation";

  /**
   * Scene count is derived from duration with a deterministic per-goal variation, so two
   * different 30-second goals do not produce identically-shaped plans. The bound is what
   * matters: a 3–20 second scene, then a final short scene to land on the exact runtime.
   */
  const baseSceneCount = Math.max(1, Math.round(targetDurationSeconds / 10));
  const variation = deterministicInt(`scenes:${lower}`, -1, 1);
  const sceneCount = Math.max(1, baseSceneCount + variation);

  // Style is not parsed from prose unless the goal actually names one. Fabricating a
  // style would put words in the user's mouth in every generated prompt.
  const style = extractStylePhrase(lower) ?? "unspecified — to be established by the Writer";

  const characterNames = extractCharacterNames(goal);
  const subject = goal.replace(/\s+/g, " ").trim();

  return {
    goal,
    format,
    targetDurationSeconds,
    durationSource: duration === null ? "default" : "stated",
    sceneCount,
    style,
    subject,
    characterNames,
    isSeries: /\b(series|episode|season|part \d+)\b/.test(lower),
  };
}

/**
 * Read a duration from the goal.
 *
 * Handles "30-second", "30 second", "30s", "90 seconds", "1 minute", "1.5 min" and "2:30".
 * @returns seconds, or null when the goal does not state one.
 */
export function extractDurationSeconds(lower: string): number | null {
  // mm:ss, unambiguous and worth checking first.
  const clock = /(\d{1,2}):([0-5]\d)\b/.exec(lower);
  if (clock?.[1] !== undefined && clock[2] !== undefined) {
    const seconds = Number(clock[1]) * 60 + Number(clock[2]);
    if (seconds > 0) return seconds;
  }

  const minutes = /(\d+(?:\.\d+)?)\s*(?:-|\s)?\s*(?:minute|min)s?\b/.exec(lower);
  if (minutes?.[1] !== undefined) {
    const seconds = Math.round(Number(minutes[1]) * 60);
    if (seconds > 0) return seconds;
  }

  const seconds = /(\d+(?:\.\d+)?)\s*(?:-|\s)?\s*(?:second|sec|s)\b/.exec(lower);
  if (seconds?.[1] !== undefined) {
    const value = Math.round(Number(seconds[1]));
    if (value > 0) return value;
  }

  return null;
}

const STYLE_WORDS = [
  "noir",
  "watercolour",
  "watercolor",
  "pixel art",
  "claymation",
  "anime",
  "cartoon",
  "hand-drawn",
  "hand drawn",
  "storybook",
  "retro",
  "vaporwave",
  "minimalist",
  "flat design",
  "ukiyo-e",
  "comic book",
];

function extractStylePhrase(lower: string): string | null {
  const found = STYLE_WORDS.filter((word) => lower.includes(word));
  return found.length > 0 ? found.join(", ") : null;
}

/**
 * Pull capitalised names out of the goal.
 *
 * A heuristic, and labelled as one: names used this way feed the character-designer task's
 * inputs, and a wrong guess costs a re-plan rather than a bad render. Deliberately excludes
 * sentence-initial words, which are capitalised for grammar rather than for being names.
 */
export function extractCharacterNames(goal: string): readonly string[] {
  const names = new Set<string>();
  const matches = goal.matchAll(/(?<![.!?]\s|^)\b([A-Z][a-z]{2,})\b/g);
  for (const match of matches) {
    const name = match[1];
    if (name !== undefined && !STOP_WORDS.has(name.toLowerCase())) names.add(name);
  }
  return [...names].sort();
}

const STOP_WORDS = new Set([
  "the", "and", "about", "make", "create", "build", "produce", "short", "video", "animated",
  "animation", "second", "seconds", "minute", "minutes", "with", "from", "into", "that",
  "this", "for", "his", "her", "their", "story", "scene", "scenes", "then", "when", "where",
]);

// ---------------------------------------------------------------------------
// Cost model
// ---------------------------------------------------------------------------

/**
 * The plan's cost model, stated in one place.
 *
 * These are *estimates for budgeting*, not prices. Every paid step is also gated behind an
 * approval, precisely because an estimate is not a quote — and the honest answer to "what
 * will this cost" is a range the user can act on, not a false precision.
 *
 * Local compute is modelled as zero currency but non-zero time, which is why
 * `compute_time` is a distinct basis rather than an alias for "free".
 */
export interface CostModel {
  readonly scriptPerScene: number;
  readonly imagePerShot: number;
  readonly audioPerSpokenMinute: number;
  readonly assemblyFlat: number;
  readonly qcFlat: number;
  readonly characterDesignFlat: number;
  readonly researchFlat: number;
  readonly storyboardFlat: number;
  /** Shots generated per animator task, so a long piece is not one monolithic task. */
  readonly shotsPerAnimatorTask: number;
}

export const DEFAULT_COST_MODEL: CostModel = Object.freeze({
  scriptPerScene: 0.02,
  imagePerShot: 0.04,
  audioPerSpokenMinute: 0.15,
  assemblyFlat: 0,
  qcFlat: 0,
  characterDesignFlat: 0.01,
  researchFlat: 0.01,
  storyboardFlat: 0.03,
  shotsPerAnimatorTask: 4,
});

// ---------------------------------------------------------------------------
// MockPlanner
// ---------------------------------------------------------------------------

export interface MockPlannerOptions {
  readonly costModel?: Partial<CostModel>;
  /**
   * Whether the mock should charge money at all.
   *
   * Defaults to true because the budget gate is the thing most worth exercising, and a
   * free plan never trips it. Set false for a demo where every step runs unattended.
   */
  readonly chargeForGeneration?: boolean;
}

/**
 * A planner that decomposes a goal with no model whatsoever.
 *
 * The production shape it emits is the one the brief describes — research → script →
 * character design → storyboard → animation per group of shots → audio → assembly → QC —
 * with each task carrying the role's real output schema, the role's real allowlist, and an
 * explicit dependency on the task before it.
 *
 * Deterministic by construction: the only variation comes from {@link fnv1a}, which is a
 * pure function of the goal string.
 */
export class MockPlanner implements Planner {
  readonly id = "mock-planner";
  readonly #costModel: CostModel;
  readonly #charge: boolean;

  constructor(options: MockPlannerOptions = {}) {
    this.#costModel = { ...DEFAULT_COST_MODEL, ...(options.costModel ?? {}) };
    this.#charge = options.chargeForGeneration ?? true;
  }

  async plan(goal: string, context: PlanContext = {}): Promise<TaskGraph> {
    const analysis = analyseGoal(goal);
    const targetDurationSeconds = context.targetDurationSeconds ?? analysis.targetDurationSeconds;
    const now = context.now ?? (() => new Date().toISOString());
    const createdAt = now();
    const currency = context.currency ?? "USD";

    const runId = context.runId ?? `run-${shortHash(`${goal}|${createdAt}`, 10)}`;
    const goalId = context.goalId ?? `goal-${shortHash(goal, 10)}`;

    const snapshot: ReferenceSnapshot = {
      snapshotId: context.snapshotId ?? `snapshot-${shortHash(`${goal}|${targetDurationSeconds}`, 10)}`,
      capturedAt: createdAt,
      ...(context.projectId !== undefined ? { projectId: context.projectId } : {}),
      assetIds: context.assetIds ?? [],
      characterLocks: context.characterLocks ?? [],
      styleConstraints: context.styleConstraints ?? [],
    };

    const tasks: AgentTask[] = [];

    const add = (task: AgentTask): void => {
      tasks.push(task);
    };

    const audit = { createdAt, createdBy: `planner:${this.id}`, runId, goalId } as const;

    const modelsFor = (role: RoleName): readonly ModelBinding[] => context.models?.[role] ?? [];

    const gateFor = (role: RoleName, cost: number, gates: readonly ApprovalGate[]): AgentTask["approval"] => {
      if (context.requireApprovalFor?.includes(role) === true) {
        return { mode: "required", reason: `Approval requested for every ${role} task in this run.`, gates };
      }
      if (gates.length === 0) return { mode: "auto" };
      return {
        mode: "required",
        reason: `This ${role} step will ${describeGates(gates)}.`,
        gates,
      };
    };

    const cost = (amount: number): number => (this.#charge ? amount : 0);

    // ── 1. Research ─────────────────────────────────────────────────────────
    const researchId = "t01_research";
    const researchCost = cost(this.#costModel.researchFlat);
    add(
      createTask({
        taskId: researchId,
        role: "researcher",
        goal:
          `Establish the factual and stylistic grounding for: ${analysis.subject}. ` +
          `Identify the visual register the piece should sit in, and record anything that ` +
          `cannot be established as an open question.`,
        inputs: {
          goal,
          styleHint: analysis.style,
          format: analysis.format,
          targetDurationSeconds,
        },
        allowedTools: ROLES.researcher.allowedTools,
        tool: TOOL.READ_REFERENCE_SNAPSHOT,
        outputSchema: ROLES.researcher.outputSchema,
        allowedModels: modelsFor("researcher"),
        referenceSnapshot: snapshot,
        estimatedCost: researchCost,
        costBasis: "per_request",
        currency,
        costNote: "One language-model call.",
        timeoutMs: 45_000,
        retry: { maxAttempts: 3, baseBackoffMs: 250, maxBackoffMs: 4_000 },
        approval: gateFor("researcher", researchCost, []),
        audit,
        now,
      }),
    );

    // ── 2. Script ───────────────────────────────────────────────────────────
    const scriptId = "t02_script";
    const scriptCost = cost(this.#costModel.scriptPerScene * analysis.sceneCount);
    add(
      createTask({
        taskId: scriptId,
        role: "writer",
        goal:
          `Write a script of exactly ${targetDurationSeconds} seconds across ` +
          `${analysis.sceneCount} scenes, summing precisely to the target. Every scene needs ` +
          `action and visual direction. Any character established as non-speaking must have no ` +
          `dialogue entries at all.`,
        inputs: {
          goal,
          targetDurationSeconds,
          sceneCount: analysis.sceneCount,
          format: analysis.format,
          style: analysis.style,
          researchTaskId: researchId,
        },
        allowedTools: ROLES.writer.allowedTools,
        tool: TOOL.WRITE_SCRIPT,
        outputSchema: ROLES.writer.outputSchema,
        allowedModels: modelsFor("writer"),
        referenceSnapshot: snapshot,
        estimatedCost: scriptCost,
        costBasis: "per_token",
        currency,
        costNote: `${analysis.sceneCount} scenes at ~${this.#costModel.scriptPerScene} each.`,
        timeoutMs: 180_000,
        retry: { maxAttempts: 3, baseBackoffMs: 500, maxBackoffMs: 8_000 },
        approval: gateFor("writer", scriptCost, []),
        dependsOn: [researchId],
        audit,
        now,
      }),
    );

    // ── 3. Character design ─────────────────────────────────────────────────
    const characterId = "t03_characters";
    const characterCost = cost(this.#costModel.characterDesignFlat * Math.max(1, snapshot.characterLocks.length));
    add(
      createTask({
        taskId: characterId,
        role: "character_designer",
        goal:
          `Pin the visual identity of every character in the script. For characters that ` +
          `already have an approved design, restate and extend it — never redesign it. State ` +
          `explicit forbidden-drift rules for each.`,
        inputs: {
          scriptTaskId: scriptId,
          lockedCharacterIds: snapshot.characterLocks.map((lock) => lock.characterId),
          candidateNames: analysis.characterNames,
        },
        allowedTools: ROLES.character_designer.allowedTools,
        tool: TOOL.READ_REFERENCE_SNAPSHOT,
        outputSchema: ROLES.character_designer.outputSchema,
        allowedModels: modelsFor("character_designer"),
        referenceSnapshot: snapshot,
        estimatedCost: characterCost,
        costBasis: "per_request",
        currency,
        costNote: "Design bibles are text; the sheets themselves are existing assets.",
        timeoutMs: 120_000,
        retry: { maxAttempts: 2, baseBackoffMs: 500, maxBackoffMs: 4_000 },
        /**
         * Always gated. A character design is the identity anchor every later shot is
         * generated against, so approving it after generation has already begun is too
         * late — this is the one gate that must come first.
         */
        approval: {
          mode: "required",
          reason:
            "Character designs lock identity for every later shot. Approving them after " +
            "generation starts means regenerating everything downstream.",
          gates: ["character_identity_lock"],
        },
        dependsOn: [scriptId],
        audit,
        now,
      }),
    );

    // ── 4. Storyboard ───────────────────────────────────────────────────────
    const storyboardId = "t04_storyboard";
    const storyboardCost = cost(this.#costModel.storyboardFlat);
    add(
      createTask({
        taskId: storyboardId,
        role: "storyboard_artist",
        goal:
          `Break each of the ${analysis.sceneCount} scenes into ordered shots. Shot durations ` +
          `must sum to their scene's duration — if they will not fit, report that rather than ` +
          `retiming the scene. State which characters are on screen per shot.`,
        inputs: {
          scriptTaskId: scriptId,
          characterTaskId: characterId,
          sceneCount: analysis.sceneCount,
          aspectRatio: context.aspectRatio ?? "16:9",
        },
        allowedTools: ROLES.storyboard_artist.allowedTools,
        tool: TOOL.SCENE_PLAN,
        outputSchema: ROLES.storyboard_artist.outputSchema,
        allowedModels: modelsFor("storyboard_artist"),
        referenceSnapshot: snapshot,
        estimatedCost: storyboardCost,
        costBasis: "per_token",
        currency,
        costNote: "Text shot breakdown.",
        timeoutMs: 180_000,
        retry: { maxAttempts: 3, baseBackoffMs: 500, maxBackoffMs: 8_000 },
        approval: gateFor("storyboard_artist", storyboardCost, []),
        dependsOn: [characterId],
        audit,
        now,
      }),
    );

    // ── 5. Animation (one task per group of shots) ──────────────────────────
    /**
     * Total shots are derived from duration at roughly four seconds each, then split into
     * animator tasks. One task for the whole piece would be a single point of failure and a
     * single unit of approval; splitting them means a bad shot can be regenerated without
     * rerendering everything, which is what the revision model in @kinema/types is for.
     */
    const totalShots = Math.max(
      analysis.sceneCount,
      Math.round(targetDurationSeconds / 4),
    );
    const groupSize = Math.max(1, this.#costModel.shotsPerAnimatorTask);
    const animatorGroups = Math.max(1, Math.ceil(totalShots / groupSize));

    const animatorTaskIds: string[] = [];
    for (let index = 0; index < animatorGroups; index += 1) {
      const firstShot = index * groupSize + 1;
      const lastShot = Math.min(totalShots, (index + 1) * groupSize);
      const taskId = `t05_animate_${String(index + 1).padStart(2, "0")}`;
      animatorTaskIds.push(taskId);

      const shotCount = lastShot - firstShot + 1;
      const animationCost = cost(this.#costModel.imagePerShot * shotCount);

      add(
        createTask({
          taskId,
          role: "animator",
          goal:
            `Specify motion for shots ${firstShot}–${lastShot} (${shotCount} shots). For each ` +
            `shot say what actually moves, and set isRealMovement true only when something ` +
            `other than the camera moves. Generate against the approved character references.`,
          inputs: {
            storyboardTaskId: storyboardId,
            characterTaskId: characterId,
            firstShot,
            lastShot,
            shotCount,
          },
          allowedTools: ROLES.animator.allowedTools,
          tool: TOOL.READ_SCRIPT,
          outputSchema: ROLES.animator.outputSchema,
          allowedModels: modelsFor("animator"),
          referenceSnapshot: snapshot,
          estimatedCost: animationCost,
          costBasis: "per_image",
          currency,
          costNote: `${shotCount} generated shots at ~${this.#costModel.imagePerShot} each.`,
          timeoutMs: 600_000,
          /**
           * Image generation is where a transient provider failure is most likely and
           * where a retry is most expensive, so attempts are bounded at 3 and only
           * `retryable` errors are retried — a moderation block will simply block again.
           */
          retry: { maxAttempts: 3, baseBackoffMs: 1_000, maxBackoffMs: 15_000 },
          approval: gateFor("animator", animationCost, ["spends_money"]),
          dependsOn: [storyboardId],
          audit,
          now,
        }),
      );
    }

    // ── 6. Audio ────────────────────────────────────────────────────────────
    const audioId = "t06_audio";
    const spokenMinutes = targetDurationSeconds / 60;
    const audioCost = cost(this.#costModel.audioPerSpokenMinute * spokenMinutes);
    add(
      createTask({
        taskId: audioId,
        role: "audio_director",
        goal:
          `Cast and direct the voice performance and lay out music and effects against the ` +
          `timeline. Every spoken line gets exactly one cue; a non-speaking character gets ` +
          `none — only nonverbal sounds. Keep music and effects under dialogue.`,
        inputs: {
          scriptTaskId: scriptId,
          characterTaskId: characterId,
          targetDurationSeconds,
          silentCharacterIds: snapshot.characterLocks
            .filter((lock) => lock.mustRemainSilent === true)
            .map((lock) => lock.characterId),
        },
        allowedTools: ROLES.audio_director.allowedTools,
        tool: TOOL.READ_SCRIPT,
        outputSchema: ROLES.audio_director.outputSchema,
        allowedModels: modelsFor("audio_director"),
        referenceSnapshot: snapshot,
        estimatedCost: audioCost,
        costBasis: "per_second",
        currency,
        costNote: `${spokenMinutes.toFixed(2)} minutes of spoken audio.`,
        timeoutMs: 300_000,
        retry: { maxAttempts: 3, baseBackoffMs: 1_000, maxBackoffMs: 10_000 },
        approval: gateFor("audio_director", audioCost, ["spends_money"]),
        dependsOn: [scriptId, characterId],
        audit,
        now,
      }),
    );

    // ── 7. Assembly ─────────────────────────────────────────────────────────
    const assemblyId = "t07_assembly";
    const assemblyCost = cost(this.#costModel.assemblyFlat);
    add(
      createTask({
        taskId: assemblyId,
        role: "editor",
        goal:
          `Order the shots into a timeline and report the total against the ` +
          `${targetDurationSeconds}-second target. Never restate a clip's duration — it is ` +
          `read from the scene.`,
        inputs: {
          storyboardTaskId: storyboardId,
          animationTaskIds: animatorTaskIds,
          audioTaskId: audioId,
          targetDurationSeconds,
        },
        allowedTools: ROLES.editor.allowedTools,
        tool: TOOL.ASSEMBLE_TIMELINE,
        outputSchema: ROLES.editor.outputSchema,
        allowedModels: modelsFor("editor"),
        referenceSnapshot: snapshot,
        estimatedCost: assemblyCost,
        costBasis: "compute_time",
        currency,
        costNote: "Local encode; no API spend, but real machine time.",
        timeoutMs: 900_000,
        retry: { maxAttempts: 2, baseBackoffMs: 2_000, maxBackoffMs: 8_000 },
        approval: gateFor("editor", assemblyCost, []),
        // Every animator group must exist before the cut can be assembled.
        dependsOn: [...animatorTaskIds, audioId],
        audit,
        now,
      }),
    );

    // ── 8. QC ───────────────────────────────────────────────────────────────
    const qcId = "t08_qc";
    const qcCost = cost(this.#costModel.qcFlat);
    add(
      createTask({
        taskId: qcId,
        role: "qc_reviewer",
        goal:
          `Run every check over the assembled plan: scenes with neither dialogue nor visual ` +
          `direction, shot durations that disagree with scene durations, silent characters ` +
          `that were given lines, and camera-only motion presented as real animation. Report ` +
          `findings honestly, including ones that reflect badly on earlier work.`,
        inputs: {
          assemblyTaskId: assemblyId,
          scriptTaskId: scriptId,
          storyboardTaskId: storyboardId,
          targetDurationSeconds,
        },
        allowedTools: ROLES.qc_reviewer.allowedTools,
        tool: TOOL.QC_CHECK,
        outputSchema: ROLES.qc_reviewer.outputSchema,
        allowedModels: modelsFor("qc_reviewer"),
        referenceSnapshot: snapshot,
        estimatedCost: qcCost,
        costBasis: "free",
        currency,
        costNote: "Deterministic local checks.",
        timeoutMs: 120_000,
        /**
         * QC is never retried automatically. A failed quality check is a statement about
         * the work, not a transient condition, and retrying it would only produce the same
         * finding while looking like progress.
         */
        retry: { maxAttempts: 1, baseBackoffMs: 0, maxBackoffMs: 0 },
        approval: gateFor("qc_reviewer", qcCost, []),
        dependsOn: [assemblyId],
        audit,
        now,
      }),
    );

    return buildPlannedGraph(goal, tasks, context);
  }
}

function describeGates(gates: readonly ApprovalGate[]): string {
  const phrases: Record<ApprovalGate, string> = {
    spends_money: "spend money on generation",
    overwrites_approved_work: "overwrite already-approved work",
    publishes_externally: "publish outside the app",
    character_identity_lock: "lock character identity for the rest of the production",
    quality_gate: "act as a quality gate",
    first_run_of_tool: "run a tool for the first time",
  };
  return gates.map((gate) => phrases[gate]).join(", and ");
}

/**
 * Build the graph, enforcing the budget cap at plan time.
 *
 * The cap is checked here, before anything is dispatched, and again by the executor before
 * every dispatch. Both are needed: this one tells the user their plan is unaffordable
 * before they approve it, and the executor's one holds when a plan is edited or a task
 * costs more than estimated. A cap that is only checked once is not a cap.
 *
 * @throws ToolError `budget_exceeded` when the plan cannot fit the cap.
 */
function buildPlannedGraph(goal: string, tasks: readonly AgentTask[], context: PlanContext): TaskGraph {
  const graph = createTaskGraph(goal, tasks);

  if (context.budgetCap !== undefined) {
    const total = tasks.reduce((sum, task) => sum + task.cost.estimated, 0);
    if (total > context.budgetCap) {
      const ranked = [...tasks]
        .sort((a, b) => b.cost.estimated - a.cost.estimated)
        .slice(0, 5)
        .map((task) => `${task.taskId} (${task.role}) ≈ ${task.cost.estimated.toFixed(4)}`);
      throw new ToolError(
        "budget_exceeded",
        `This plan is estimated at ${total.toFixed(4)} ${context.currency ?? "USD"}, which ` +
          `exceeds the cap of ${context.budgetCap.toFixed(4)}. The most expensive steps are: ` +
          `${ranked.join(", ")}. Reduce the target duration, cut shots, or raise the cap.`,
        {
          userActionRequired: true,
          retryable: false,
          detail: `Budget cap is checked at plan time and again before each dispatch.`,
        },
      );
    }
  }

  return graph;
}

// ---------------------------------------------------------------------------
// ProviderPlanner
// ---------------------------------------------------------------------------

/**
 * The schema a model-backed planner must satisfy.
 *
 * Note what it does *not* ask for: costs, timeouts, retry policies, approval modes or
 * reference snapshots. A model is good at deciding what the work is and poor at pricing it
 * or judging its own risk. So the model proposes the decomposition, and this package
 * supplies the governance — which means a model cannot talk its way past a budget cap or an
 * approval gate by emitting a confident-looking plan.
 */
export const PLANNER_RESPONSE_SCHEMA: JsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["tasks"],
  properties: {
    tasks: {
      type: "array",
      minItems: 1,
      maxItems: 40,
      description: "The decomposition. Tasks are ordered; dependencies reference ids.",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["taskId", "role", "goal", "dependsOn"],
        properties: {
          taskId: {
            type: "string",
            pattern: "^[A-Za-z][A-Za-z0-9_-]{0,63}$",
            description: "Stable id, unique within the plan.",
          },
          role: {
            type: "string",
            enum: [
              "researcher",
              "writer",
              "character_designer",
              "storyboard_artist",
              "animator",
              "audio_director",
              "editor",
              "qc_reviewer",
            ],
          },
          goal: { type: "string", minLength: 8, maxLength: 1000 },
          tool: {
            type: "string",
            description:
              "Optional. Must be on the role's allowlist; a tool outside it is refused.",
          },
          dependsOn: {
            type: "array",
            items: { type: "string", minLength: 1, maxLength: 64 },
            description: "Ids of tasks that must succeed first. Must not form a cycle.",
          },
          estimatedSeconds: { type: "number", exclusiveMinimum: 0, maximum: 3600 },
          notes: { type: "string", maxLength: 600 },
        },
      },
    },
  },
};

/** A parsed task proposal from a model, before governance is applied. */
export interface ProposedTask {
  readonly taskId: string;
  readonly role: RoleName;
  readonly goal: string;
  readonly tool?: string;
  readonly dependsOn: readonly string[];
  readonly estimatedSeconds?: number;
  readonly notes?: string;
}

export interface ProviderPlannerOptions {
  readonly adapter: ProviderAdapter;
  readonly credentials?: ProviderCredentials;
  /** Model used for planning. Defaults to the adapter's first tool-capable model. */
  readonly modelId?: string;
  /**
   * Turns a proposal into a governed `AgentTask`.
   *
   * Injected so this class has no opinion about pricing, and so tests can supply a
   * trivial policy without a cost model. The default applies the standard cost model and
   * the standard approval rules.
   */
  readonly governTask?: (proposal: ProposedTask, context: PlanContext, index: number) => AgentTask;
  /** Overrides the planner prompt. Prefer the default unless you have a reason. */
  readonly systemPrompt?: string;
  readonly now?: () => string;
  readonly costModel?: Partial<CostModel>;
}

/**
 * A planner backed by a language model behind the `ProviderAdapter` interface.
 *
 * ── Testability ─────────────────────────────────────────────────────────────
 *
 * The adapter is injected, so a fake adapter exercises the entire path — prompt
 * construction, request validation, schema-constrained response parsing, governance and
 * graph construction — with no network. The class never imports a concrete adapter and
 * never constructs a transport, so there is no code path in it that could reach the
 * internet by accident.
 *
 * ── Failure policy ──────────────────────────────────────────────────────────
 *
 * Every way a model can disappoint is handled explicitly rather than by hoping:
 * malformed JSON, a schema-violating plan, a task naming a tool its role may not use, a
 * dependency on a task that does not exist, and a cycle. Each becomes a `ToolError` with a
 * message the Director can act on. A model that returns nonsense must not produce a plan
 * that half-runs.
 */
export class ProviderPlanner implements Planner {
  readonly id: string;
  readonly #options: ProviderPlannerOptions;
  #model: ModelDescriptor | undefined;

  constructor(options: ProviderPlannerOptions) {
    this.#options = options;
    this.id = `provider-planner:${options.adapter.id}`;
  }

  async plan(goal: string, context: PlanContext = {}): Promise<TaskGraph> {
    const { adapter } = this.#options;
    const now = this.#options.now ?? context.now ?? (() => new Date().toISOString());
    const createdAt = now();

    const model = await this.#resolveModel();
    const request = this.#buildRequest(goal, context, model, createdAt);

    const validation = adapter.validateRequest(request, model);
    if (!validation.valid) {
      throw new ToolError(
        "precondition_failed",
        `The planning model "${model.id}" cannot honour this request: ${validation.problems.join(" ")}`,
        {
          userActionRequired: true,
          detail: `Unsupported fields: ${validation.unsupportedFields.join(", ") || "(none)"}.`,
        },
      );
    }

    const handle = await adapter.submitJob(request, this.#options.credentials ?? {});
    const result = await adapter.pollOrSubscribe(handle, this.#options.credentials ?? {});

    if (result.status !== "succeeded") {
      const normalised: NormalisedError =
        result.outputs.length === 0 && result.status === "failed"
          ? {
              code: "provider_unavailable",
              message: `The planning model returned status "${result.status}" with no output.`,
              retryable: true,
              userActionRequired: false,
            }
          : adapter.normaliseError(new Error(`Planning job ended with status "${result.status}".`));

      /**
       * `retryable` is passed through unchanged. A rate-limited planner call is worth
       * retrying by the executor; a moderation block or a quota error is not, and
       * flattening the two here would make the executor's retry rule wrong for planners
       * specifically.
       */
      throw new ToolError(
        normalised.code === "rate_limited" ? "internal" : "precondition_failed",
        `Planning failed: ${normalised.message}`,
        {
          retryable: normalised.retryable,
          userActionRequired: normalised.userActionRequired,
          detail: normalised.detail,
        },
      );
    }

    const text = result.outputs.map((output) => output.text ?? "").join("\n").trim();
    if (text.length === 0) {
      throw new ToolError(
        "precondition_failed",
        "The planning model returned no text. A plan cannot be built from an empty response.",
        { retryable: true, userActionRequired: false },
      );
    }

    const proposals = this.#parseProposals(text);
    const governed = this.#govern(proposals, context, now, createdAt);

    return buildPlannedGraph(goal, governed, context);
  }

  // ── Internals ───────────────────────────────────────────────────────────

  async #resolveModel(): Promise<ModelDescriptor> {
    if (this.#model) return this.#model;
    const models = await this.#options.adapter.listModels();
    const chosen =
      this.#options.modelId !== undefined
        ? models.find((candidate) => candidate.id === this.#options.modelId)
        : models.find((candidate) => candidate.outputs.includes("text"));
    if (!chosen) {
      throw new ToolError(
        "precondition_failed",
        this.#options.modelId !== undefined
          ? `Model "${this.#options.modelId}" is not offered by provider "${this.#options.adapter.id}".`
          : `Provider "${this.#options.adapter.id}" offers no text-output model, so it cannot plan.`,
        { userActionRequired: true },
      );
    }
    this.#model = chosen;
    return chosen;
  }

  #buildRequest(
    goal: string,
    context: PlanContext,
    model: ModelDescriptor,
    createdAt: string,
  ): GenerationRequest {
    const roleCatalogue = Object.values(ROLES)
      .map((role) => `- ${role.name}: ${role.responsibility} Allowed tools: ${role.allowedTools.join(", ") || "(none)"}.`)
      .join("\n");

    const prompt = [
      this.#options.systemPrompt ?? DEFAULT_PLANNER_SYSTEM_PROMPT,
      "",
      `GOAL: ${goal}`,
      context.targetDurationSeconds !== undefined
        ? `TARGET DURATION: ${context.targetDurationSeconds} seconds`
        : "",
      context.budgetCap !== undefined
        ? `BUDGET CAP: ${context.budgetCap} ${context.currency ?? "USD"} (estimates only; costs are applied by the Director, not by you)`
        : "",
      "",
      "ROLES:",
      roleCatalogue,
      "",
      "Return one JSON object matching the provided schema. No prose, no markdown fences.",
    ]
      .filter((line) => line !== "")
      .join("\n");

    const request: GenerationRequest = {
      modelId: model.id,
      prompt,
      temperature: 0,
      responseSchema: PLANNER_RESPONSE_SCHEMA,
      ...(context.runId !== undefined ? {} : {}),
    };

    /**
     * Temperature 0 matters more than it looks. Determinism is a stated requirement, and
     * sampling temperature is the one knob this layer controls directly. Even so, a provider
     * is not obliged to honour it — which is exactly why {@link MockPlanner} exists and why
     * the determinism test runs against that, not against a model.
     */
    void createdAt;
    return request;
  }

  /**
   * Parse the model's text into proposals.
   *
   * Tolerates a fenced code block or leading prose, because models emit them despite a
   * schema-constrained request, and rejecting an otherwise-correct plan over a stray
   * backtick helps nobody. Everything else is strict: a plan that does not satisfy the
   * schema is refused rather than partially accepted.
   *
   * @throws ToolError `precondition_failed` on unparseable or schema-violating output.
   */
  #parseProposals(text: string): readonly ProposedTask[] {
    const json = extractJsonObject(text);
    if (json === null) {
      throw new ToolError(
        "precondition_failed",
        "The planning model's response contained no JSON object. Expected a plan matching the " +
          "planner schema; got prose instead.",
        {
          retryable: true,
          userActionRequired: false,
          detail: `First 200 characters: ${text.slice(0, 200)}`,
        },
      );
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(json) as unknown;
    } catch (error) {
      throw new ToolError(
        "precondition_failed",
        `The planning model's response was not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
        { retryable: true, userActionRequired: false },
      );
    }

    const outcome = validateAgainstSchema(parsed, PLANNER_RESPONSE_SCHEMA, "planner.response");
    if (!outcome.valid) {
      throw new ToolError(
        "precondition_failed",
        `The planning model's response did not match the planner schema: ` +
          outcome.issues.map((issue) => `${issue.path || "/"} ${issue.message}`).join(" "),
        {
          retryable: true,
          userActionRequired: false,
          issues: outcome.issues.map((issue) => `${issue.path || "/"}: ${issue.message}`),
        },
      );
    }

    const body = parsed as { tasks: readonly Record<string, unknown>[] };
    return body.tasks.map((raw) => {
      const proposal: ProposedTask = {
        taskId: String(raw["taskId"]),
        role: raw["role"] as RoleName,
        goal: String(raw["goal"]),
        dependsOn: Array.isArray(raw["dependsOn"]) ? (raw["dependsOn"] as readonly string[]) : [],
        ...(typeof raw["tool"] === "string" ? { tool: raw["tool"] } : {}),
        ...(typeof raw["estimatedSeconds"] === "number"
          ? { estimatedSeconds: raw["estimatedSeconds"] }
          : {}),
        ...(typeof raw["notes"] === "string" ? { notes: raw["notes"] } : {}),
      };
      return proposal;
    });
  }

  /**
   * Apply governance to raw proposals.
   *
   * Each proposal is turned into a real task through the injected policy, and every
   * proposal is checked against its role's allowlist before it is accepted. A model that
   * assigns `write_script` to the QC reviewer is refused here, with the role's permitted
   * tools named, rather than at dispatch time when the failure is more expensive.
   */
  #govern(
    proposals: readonly ProposedTask[],
    context: PlanContext,
    now: () => string,
    createdAt: string,
  ): readonly AgentTask[] {
    const govern = this.#options.governTask ?? defaultGovernance(this.#options.costModel);

    return proposals.map((proposal, index) => {
      const role = ROLES[proposal.role];
      if (!role) {
        throw new ToolError(
          "unknown_role",
          `The planning model assigned work to unknown role "${proposal.role}".`,
          { retryable: true, userActionRequired: false },
        );
      }

      if (proposal.tool !== undefined) {
        try {
          assertToolPermitted(proposal.role, proposal.tool);
        } catch (error) {
          const reason = error instanceof ToolError ? error.message : String(error);
          throw new ToolError("tool_not_permitted", reason, {
            retryable: true,
            userActionRequired: false,
            toolName: proposal.tool,
            detail:
              `The plan was refused rather than silently dropping the tool, because a task ` +
              `that quietly loses its tool does not do what the plan says it does.`,
          });
        }
      }

      const task = govern(proposal, context, index);

      /**
       * The model does not get to choose its own governance. Whatever it proposed, the
       * cost, retry, approval and audit fields come from this package — otherwise a
       * confident plan could set its own budget to zero or mark itself auto-approved, and
       * the cap and the gate would both be decorative.
       */
      void createdAt;
      void now;
      return task;
    });
  }
}

const DEFAULT_PLANNER_SYSTEM_PROMPT = [
  "You are the planning half of an AI Director for a video production tool.",
  "Decompose the goal into the smallest set of tasks that a specialist team can execute,",
  "then wire their dependencies. Use only the roles listed. Assign a tool only when the",
  "role's allowlist permits it.",
  "",
  "Constraints you must respect:",
  "- Dependencies must form a directed acyclic graph.",
  "- A quality-review task must depend on whatever produces the work it reviews.",
  "- Do not price the work, set timeouts, or decide what needs approval. The Director does",
  "  that, and anything you write about cost will be ignored.",
].join("\n");

/**
 * Pull the first balanced JSON object out of a model response.
 *
 * Scans with a depth counter rather than a regular expression, because a regex would either
 * stop at the first `}` inside a string or need a backtracking pattern that is worse than
 * this loop. Braces inside string literals are tracked so `"a } brace"` cannot end the scan
 * early.
 *
 * @returns the JSON text, or null when the response contains no object at all.
 */
export function extractJsonObject(text: string): string | null {
  const start = text.indexOf("{");
  if (start === -1) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < text.length; i += 1) {
    const char = text[i];
    if (char === undefined) break;

    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === "\\") {
      if (inString) escaped = true;
      continue;
    }
    if (char === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;

    if (char === "{") depth += 1;
    else if (char === "}") {
      depth -= 1;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }

  return null;
}

/**
 * The default governance policy.
 *
 * Turns a proposal into a fully-specified task: the role's declared output schema, the
 * role's allowlist, a cost estimate from the shared model, a bounded retry policy, and an
 * approval gate wherever money is involved.
 */
export function defaultGovernance(
  costOverrides?: Partial<CostModel>,
): (proposal: ProposedTask, context: PlanContext, index: number) => AgentTask {
  const costModel: CostModel = { ...DEFAULT_COST_MODEL, ...(costOverrides ?? {}) };

  return (proposal, context, index) => {
    const role = ROLES[proposal.role];
    const snapshot: ReferenceSnapshot = {
      snapshotId: context.snapshotId ?? `snapshot-${shortHash(context.projectId ?? "unbound", 8)}`,
      capturedAt: context.now?.() ?? new Date().toISOString(),
      ...(context.projectId !== undefined ? { projectId: context.projectId } : {}),
      assetIds: context.assetIds ?? [],
      characterLocks: context.characterLocks ?? [],
      styleConstraints: context.styleConstraints ?? [],
    };

    const estimated =
      role.name === "animator" || role.name === "storyboard_artist"
        ? costModel.imagePerShot * 4
        : role.name === "writer"
          ? costModel.scriptPerScene * 4
          : costModel.researchFlat;

    const gates: readonly ApprovalGate[] =
      role.name === "character_designer"
        ? ["character_identity_lock"]
        : role.name === "animator" || role.name === "audio_director"
          ? ["spends_money"]
          : [];

    const forced = context.requireApprovalFor?.includes(role.name) === true;

    return createTask({
      taskId: proposal.taskId,
      role: proposal.role,
      goal: proposal.goal,
      inputs: { proposalIndex: index, ...(proposal.notes !== undefined ? { notes: proposal.notes } : {}) },
      allowedTools: role.allowedTools,
      ...(proposal.tool !== undefined ? { tool: proposal.tool as ToolName } : {}),
      outputSchema: role.outputSchema,
      allowedModels: context.models?.[role.name] ?? [],
      referenceSnapshot: snapshot,
      estimatedCost: estimated,
      costBasis: role.name === "animator" ? "per_image" : "per_request",
      currency: context.currency ?? "USD",
      timeoutMs: proposal.estimatedSeconds !== undefined
        ? Math.min(3_600_000, Math.max(1_000, proposal.estimatedSeconds * 1_000))
        : DEFAULT_TIMEOUT_MS,
      retry: { maxAttempts: 3, baseBackoffMs: 500, maxBackoffMs: 8_000 },
      approval:
        forced || gates.length > 0
          ? {
              mode: "required",
              reason: forced
                ? `Approval requested for every ${role.name} task in this run.`
                : `This ${role.name} step will ${describeGates(gates)}.`,
              gates: forced && gates.length === 0 ? ["spends_money"] : gates,
            }
          : { mode: "auto" },
      dependsOn: proposal.dependsOn,
      ...(context.now !== undefined ? { now: context.now } : {}),
      audit: {
        createdBy: "planner:provider",
        ...(context.runId !== undefined ? { runId: context.runId } : {}),
        ...(context.goalId !== undefined ? { goalId: context.goalId } : {}),
      },
    });
  };
}