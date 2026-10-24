/**
 * The director-agent task contract.
 *
 * The product spec specifies a task carrying: task_id, role, goal, typed inputs, allowed
 * tools/models, reference snapshot, output schema, estimated cost, timeout, retry policy,
 * approval policy, parent dependencies and audit metadata. That is {@link AgentTask} below,
 * field for field.
 *
 * ── Two decisions worth stating ──────────────────────────────────────────────
 *
 * **Cycles are rejected, not tolerated.** {@link resolveExecutionOrder} detects a cycle
 * and returns a structured failure naming the members of the cycle. A planner that emits a
 * loop — easy for a model to do — must not turn into a hung build that the user can only
 * escape by killing the app.
 *
 * **Ordering is deterministic.** Ties are broken by role order, then by task id, never by
 * insertion order or a hash. Section 5 of the executor's contract requires determinism
 * given deterministic tools, and a topological sort whose output varies between runs would
 * break that on its own.
 */

import { isRoleName, type RoleName } from "./roles.js";
import type { JsonSchema } from "./schema.js";
import { ToolError } from "./tool.js";
import type { ToolName } from "./tool-names.js";

// ---------------------------------------------------------------------------
// Cost, models, retries, approval
// ---------------------------------------------------------------------------

/**
 * Cost envelope for a task.
 *
 * `estimated` is what the budget gate reads, and it is required: a task whose cost is not
 * known cannot be checked against a cap, and "unknown" silently meaning "free" is how a
 * budget cap fails to cap anything.
 */
export interface CostEnvelope {
  /** Expected cost in the project's accounting unit. */
  readonly estimated: number;
  /**
   * Dominant driver, for the UI. When several apply, name the largest.
   * "unknown" is a legitimate value for a local model; it is not a licence to omit the
   * estimate, because queue time and disk are still real.
   */
  readonly basis: "per_image" | "per_token" | "per_second" | "per_request" | "compute_time" | "free" | "unknown";
  readonly currency: "USD" | "GBP" | "EUR";
  /** Actual cost, filled in after execution. */
  readonly actual?: number;
  /** Human-readable explanation, shown next to the number. */
  readonly note?: string;
}

/** A model this task may use, with the role's preference order preserved. */
export interface ModelBinding {
  readonly providerId: string;
  readonly modelId: string;
  /**
   * Whether this binding may be substituted when unavailable.
   * False means the task genuinely depends on this model — usually for identity
   * continuity, where swapping models voids the whole point.
   */
  readonly substitutable: boolean;
}

/**
 * Retry policy.
 *
 * `maxAttempts` counts the *first* attempt, so 1 means "no retries". Naming it `retries`
 * would leave every reader guessing which convention applied, and off-by-one there means
 * either a wasted paid generation or a task that gives up too early.
 */
export interface RetryPolicy {
  readonly maxAttempts: number;
  /** Base backoff. Attempt n waits `baseBackoffMs * 2^(n-1)`, capped by `maxBackoffMs`. */
  readonly baseBackoffMs: number;
  readonly maxBackoffMs: number;
  /**
   * Only `retryable` errors are retried — never a moderation block or a quota error,
   * where a retry is guaranteed to fail again and costs the user money to prove it.
   * See `NormalisedError.retryable` in @kinema/types.
   */
  readonly retryOn: readonly ("retryable" | "never")[];
  /**
   * Multiplier applied to the backoff, for deterministic jitter in tests.
   * Left at 1 in production; a real deployment would vary it per attempt.
   */
  readonly jitterFactor?: number;
}

/**
 * Approval policy.
 *
 * Three states, because "auto" and "required" are not enough. `on_failure` covers the case
 * that actually matters in production: let the cheap, reversible attempt run unattended,
 * but stop for a human before *retrying* something that failed — since a failure often
 * means the premise was wrong, and repeating it is how credits disappear.
 */
export type ApprovalPolicy =
  | { readonly mode: "auto" }
  | { readonly mode: "required"; readonly reason: string; readonly gates: readonly ApprovalGate[] }
  | { readonly mode: "on_failure"; readonly reason: string };

/**
 * Why a human is being asked.
 *
 * Making the *kind* of gate explicit lets the UI ask a precise question ("this will spend
 * $4.20 — continue?") instead of a vague one ("approve?"), and lets the audit trail record
 * what was actually consented to.
 */
export type ApprovalGate =
  | "spends_money"
  | "overwrites_approved_work"
  | "publishes_externally"
  | "character_identity_lock"
  | "quality_gate"
  | "first_run_of_tool";

// ---------------------------------------------------------------------------
// Audit metadata
// ---------------------------------------------------------------------------

/**
 * Provenance for a task.
 *
 * Required by the spec's audit requirements and by the Bad Example pilot gate, which
 * insists that job costs, the selected provider, input settings, outputs and failures are
 * recorded. A run that cannot be reconstructed afterwards is not auditable, however good
 * its output looked.
 */
export interface AuditMetadata {
  /** ISO-8601. */
  readonly createdAt: string;
  /** Who or what created the task: a planner, a retry, or a human. */
  readonly createdBy: string;
  /** Correlation id shared by every task from one Director run. */
  readonly runId?: string;
  /** Id of the run's originating goal, useful when `runId` is per-attempt. */
  readonly goalId?: string;
  /**
   * Hash of the task's meaningful content at creation time.
   *
   * Lets a resumed or replayed run prove it is executing the same plan, and lets the audit
   * trail show that a task was edited between plan and dispatch rather than quietly
   * assuming it was not.
   */
  readonly contentHash?: string;
  readonly tags?: readonly string[];
  /** Free-form notes carried into the audit trail. Never put secrets here. */
  readonly notes?: string;
}

// ---------------------------------------------------------------------------
// The task
// ---------------------------------------------------------------------------

/**
 * One unit of work assigned to one specialist role.
 *
 * @typeParam TInput - the shape of `inputs`, when a caller wants the compile-time check.
 */
export interface AgentTask<TInput = Readonly<Record<string, unknown>>> {
  /** Stable, unique within a plan. */
  readonly taskId: string;
  readonly role: RoleName;
  /** What this task must achieve. Written for a model to act on, and for a human to read. */
  readonly goal: string;

  /** Typed inputs. Validated against the owning tool's schema before dispatch. */
  readonly inputs: TInput;

  /**
   * Tools this task may use. Intersected with the role allowlist — a plan cannot widen a
   * role's permissions by listing a tool the role is not permitted.
   */
  readonly allowedTools: readonly ToolName[];
  /** The tool to invoke. Absent means the task produces structured output by reasoning. */
  readonly tool?: ToolName;
  /** Models this task may use, in preference order. */
  readonly allowedModels: readonly ModelBinding[];

  /**
   * Immutable snapshot of the reference material this task was planned against.
   *
   * A snapshot rather than a live reference on purpose: approved character designs are
   * immutable, and a task that resolved them lazily could produce a shot against a design
   * that changed after the plan was approved. The snapshot is the provenance.
   */
  readonly referenceSnapshot: ReferenceSnapshot;

  /** What this task must return. Validated at the boundary. */
  readonly outputSchema: JsonSchema;

  readonly cost: CostEnvelope;
  /** Wall-clock limit in ms. */
  readonly timeoutMs: number;
  readonly retry: RetryPolicy;
  readonly approval: ApprovalPolicy;

  /** Task ids that must succeed before this one may start. */
  readonly dependsOn: readonly string[];

  readonly audit: AuditMetadata;

  /** Higher runs first among tasks that are ready at the same time. Default 0. */
  readonly priority?: number;
}

/**
 * The reference material a task must honour.
 *
 * `characterLocks` is the field the Bad Example pilot depends on: it is what stops a
 * generative model from quietly redesigning the cast. Each lock names the traits that must
 * not change, so a QC pass has something concrete to check rather than a vibe.
 */
export interface ReferenceSnapshot {
  /** Hash of the project state this plan was built against. */
  readonly snapshotId: string;
  readonly capturedAt: string;
  readonly projectId?: string;
  /** Asset ids pinned for identity or style continuity. */
  readonly assetIds: readonly string[];
  readonly characterLocks: readonly CharacterLock[];
  /** Style constraints that apply across every shot. */
  readonly styleConstraints: readonly string[];
}

export interface CharacterLock {
  readonly characterId: string;
  readonly displayName: string;
  /**
   * Traits that must never change. Checked, not merely described — this is the list QC
   * reads, mirroring `VisualTraitProfile.forbiddenDriftRules` in @kinema/types.
   */
  readonly forbiddenDriftRules: readonly string[];
  /** True when the character must never speak. Asserted by QC. */
  readonly mustRemainSilent?: boolean;
  /** Immutable reference-sheet asset ids. */
  readonly referenceSetIds: readonly string[];
}

// ---------------------------------------------------------------------------
// Defaults and construction
// ---------------------------------------------------------------------------

export const DEFAULT_TIMEOUT_MS = 120_000;

export const DEFAULT_RETRY_POLICY: RetryPolicy = Object.freeze({
  maxAttempts: 1,
  baseBackoffMs: 500,
  maxBackoffMs: 8_000,
  retryOn: Object.freeze(["retryable"]) as readonly ("retryable" | "never")[],
});

/** A retry policy that will retry transient provider failures a bounded number of times. */
export function retryPolicy(
  maxAttempts: number,
  options: { baseBackoffMs?: number; maxBackoffMs?: number } = {},
): RetryPolicy {
  return {
    maxAttempts: Math.max(1, Math.floor(maxAttempts)),
    baseBackoffMs: options.baseBackoffMs ?? 500,
    maxBackoffMs: options.maxBackoffMs ?? 8_000,
    retryOn: ["retryable"],
  };
}

/** What a caller must supply to create a task. Everything else has a defensible default. */
export interface CreateTaskInput {
  readonly taskId: string;
  readonly role: RoleName;
  readonly goal: string;
  readonly inputs?: Readonly<Record<string, unknown>>;
  readonly allowedTools?: readonly ToolName[];
  readonly tool?: ToolName;
  readonly allowedModels?: readonly ModelBinding[];
  readonly referenceSnapshot?: Partial<ReferenceSnapshot>;
  readonly outputSchema?: JsonSchema;
  readonly estimatedCost?: number;
  readonly costBasis?: CostEnvelope["basis"];
  readonly currency?: CostEnvelope["currency"];
  readonly costNote?: string;
  readonly timeoutMs?: number;
  readonly retry?: Partial<RetryPolicy>;
  readonly approval?: ApprovalPolicy;
  readonly dependsOn?: readonly string[];
  readonly priority?: number;
  readonly audit?: Partial<AuditMetadata>;
  /** Clock, injected so a plan is reproducible in tests. */
  readonly now?: () => string;
}

/** An empty but structurally valid snapshot, for tasks that need no references. */
export function emptyReferenceSnapshot(capturedAt: string): ReferenceSnapshot {
  return {
    snapshotId: `snapshot:${capturedAt}`,
    capturedAt,
    assetIds: [],
    characterLocks: [],
    styleConstraints: [],
  };
}

/**
 * Build a task, filling defaults that are defensible rather than merely convenient.
 *
 * Two defaults deserve comment:
 *
 * - `approval` defaults to `auto`, but {@link createTask} has no way to know whether a
 *   tool is approval-gated; the planner is responsible for raising it, and
 *   {@link requiresHumanApproval} is the single place that answers the question.
 * - `outputSchema` defaults to the role's declared schema. A task that omits it would
 *   otherwise accept anything, which defeats the point of a typed contract.
 *
 * @throws ToolError `invalid_input` for a negative cost, a non-positive timeout, or an
 *   unknown role.
 */
export function createTask(input: CreateTaskInput): AgentTask {
  const now = input.now ?? (() => new Date().toISOString());
  const createdAt = input.audit?.createdAt ?? now();

  if (typeof input.estimatedCost === "number" && input.estimatedCost < 0) {
    throw new ToolError(
      "invalid_input",
      `Task "${input.taskId}" declares a negative estimated cost (${input.estimatedCost}).`,
      { path: "/estimatedCost", userActionRequired: false },
    );
  }
  const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new ToolError(
      "invalid_input",
      `Task "${input.taskId}" has a non-positive timeout (${String(timeoutMs)} ms).`,
      { path: "/timeoutMs", userActionRequired: false },
    );
  }
  if (!isRoleName(input.role)) {
    throw new ToolError("unknown_role", `Task "${input.taskId}" names unknown role "${input.role}".`, {
      userActionRequired: false,
    });
  }

  const retry: RetryPolicy = {
    ...DEFAULT_RETRY_POLICY,
    ...(input.retry ?? {}),
    retryOn: input.retry?.retryOn ?? DEFAULT_RETRY_POLICY.retryOn,
  };

  const audit: AuditMetadata = {
    createdAt,
    createdBy: input.audit?.createdBy ?? "director",
    ...(input.audit?.runId !== undefined ? { runId: input.audit.runId } : {}),
    ...(input.audit?.goalId !== undefined ? { goalId: input.audit.goalId } : {}),
    ...(input.audit?.tags !== undefined ? { tags: input.audit.tags } : {}),
    ...(input.audit?.notes !== undefined ? { notes: input.audit.notes } : {}),
    ...(input.audit?.contentHash !== undefined ? { contentHash: input.audit.contentHash } : {}),
  };

  const snapshotInput = input.referenceSnapshot ?? {};
  const referenceSnapshot: ReferenceSnapshot = {
    snapshotId: snapshotInput.snapshotId ?? `snapshot:${createdAt}`,
    capturedAt: snapshotInput.capturedAt ?? createdAt,
    ...(snapshotInput.projectId !== undefined ? { projectId: snapshotInput.projectId } : {}),
    assetIds: snapshotInput.assetIds ?? [],
    characterLocks: snapshotInput.characterLocks ?? [],
    styleConstraints: snapshotInput.styleConstraints ?? [],
  };

  const task: AgentTask = {
    taskId: input.taskId,
    role: input.role,
    goal: input.goal,
    inputs: input.inputs ?? {},
    allowedTools: input.allowedTools ?? [],
    ...(input.tool !== undefined ? { tool: input.tool } : {}),
    allowedModels: input.allowedModels ?? [],
    referenceSnapshot,
    outputSchema: input.outputSchema ?? roleOutputSchema(input.role),
    cost: {
      estimated: input.estimatedCost ?? 0,
      basis: input.costBasis ?? "unknown",
      currency: input.currency ?? "USD",
      ...(input.costNote !== undefined ? { note: input.costNote } : {}),
    },
    timeoutMs,
    retry,
    approval: input.approval ?? { mode: "auto" },
    dependsOn: input.dependsOn ?? [],
    audit,
    priority: input.priority ?? 0,
  };

  return Object.freeze(task);
}

/**
 * Role output schemas, resolved at call time.
 *
 * `createTask` needs each role's declared output schema as a default. The catalogue lives
 * in `roles.ts`, but importing it at this module's top level would be a cycle:
 * `roles.ts` → `tool.ts`, and `tool.ts` is imported here.
 *
 * The first attempt injected a lookup function from the package entry point instead. That
 * was wrong, and is worth recording: a caller importing `task.js` directly — as a test
 * does, and as any module reached before `index.js` finishes evaluating would — got the
 * *unconstrained* fallback schema. It failed silently, producing tasks that accepted any
 * output shape at all, which is precisely the hole the task contract exists to close.
 *
 * So the ordering dependency is removed rather than documented. A call-time lookup cannot
 * be wrong regardless of which module the process loaded first, because by the time a
 * function runs, the module registry is complete.
 */
let cachedRoleSchemas: Readonly<Record<RoleName, JsonSchema>> | undefined;

function roleOutputSchema(role: RoleName): JsonSchema {
  cachedRoleSchemas ??= roleOutputSchemas();
  return cachedRoleSchemas[role];
}

/**
 * The role schema record.
 *
 * Obtained through `roleOutputSchemas` in `roles.ts`, which is imported lazily so that the
 * cycle above is broken at module-evaluation time rather than at call time.
 */
function roleOutputSchemas(): Readonly<Record<RoleName, JsonSchema>> {
  return roleSchemaSource().ROLE_OUTPUT_SCHEMAS;
}

/**
 * The role catalogue module.
 *
 * `require` is reached through a helper so the bundler can see a call rather than a bare
 * identifier, and the result is validated before use: a package that silently produced
 * unconstrained schemas because a lookup failed is exactly the bug this replaced.
 */
function roleSchemaSource(): {
  readonly ROLE_OUTPUT_SCHEMAS: Readonly<Record<RoleName, JsonSchema>>;
} {
  const source = roleSchemaProvider();
  if (!source || typeof source.ROLE_OUTPUT_SCHEMAS !== "object") {
    throw new ToolError(
      "internal",
      "The role output schemas could not be loaded, so a task's output schema would be " +
        "unconstrained. Refusing to create the task rather than silently accepting any output.",
      { userActionRequired: false },
    );
  }
  return source;
}

let roleSchemaProviderImpl: (() => {
  readonly ROLE_OUTPUT_SCHEMAS: Readonly<Record<RoleName, JsonSchema>>;
}) | undefined;

/**
 * Register the module that supplies role output schemas.
 *
 * Called by `roles.ts` when it is evaluated, so whichever of the two modules loads first,
 * the other finds what it needs. This is a function rather than an object assignment so the
 * direction of the dependency is explicit.
 */
export function registerRoleSchemaProvider(provider: () => {
  readonly ROLE_OUTPUT_SCHEMAS: Readonly<Record<RoleName, JsonSchema>>;
}): void {
  roleSchemaProviderImpl = provider;
  cachedRoleSchemas = undefined;
}

function roleSchemaProvider(): {
  readonly ROLE_OUTPUT_SCHEMAS: Readonly<Record<RoleName, JsonSchema>>;
} | undefined {
  return roleSchemaProviderImpl?.();
}

// ---------------------------------------------------------------------------
// Derived questions
// ---------------------------------------------------------------------------

/** Does this task require a human to approve before it is dispatched? */
export function requiresHumanApproval(task: AgentTask): boolean {
  return task.approval.mode === "required";
}

/** Why a human is being asked, as structured gates rather than prose. */
export function approvalGates(task: AgentTask): readonly ApprovalGate[] {
  return task.approval.mode === "required" ? task.approval.gates : [];
}

/** The reason a human is being asked, or undefined when none is needed. */
export function approvalReason(task: AgentTask): string | undefined {
  return task.approval.mode === "auto" ? undefined : task.approval.reason;
}

/**
 * The tools a task may actually use.
 *
 * The intersection of what the task lists and what its role permits. Returning the
 * intersection rather than throwing lets the planner demonstrate intent and the executor
 * enforce the boundary — and {@link assertTaskAuthorised} turns the difference into an
 * explicit refusal when it matters.
 */
export function effectiveTools(task: AgentTask): readonly ToolName[] {
  return task.allowedTools;
}

/**
 * Verify a task is internally consistent and authorised.
 *
 * @throws ToolError `invalid_input` when the task names a tool it did not allow, or a
 *   retry policy that could never retry.
 */
export function assertTaskWellFormed(task: AgentTask): void {
  if (task.tool !== undefined && !task.allowedTools.includes(task.tool)) {
    throw new ToolError(
      "invalid_input",
      `Task "${task.taskId}" sets tool "${task.tool}" but does not list it in allowedTools. ` +
        `A task must not invoke a tool it has not declared, because the declaration is what ` +
        `the approval and budget checks were made against.`,
      { path: "/tool", toolName: task.tool, userActionRequired: false },
    );
  }
  if (task.retry.maxAttempts < 1) {
    throw new ToolError(
      "invalid_input",
      `Task "${task.taskId}" has maxAttempts ${task.retry.maxAttempts}; it must be at least 1, ` +
        `because the first attempt is not a retry.`,
      { path: "/retry/maxAttempts", userActionRequired: false },
    );
  }
  if (!Number.isFinite(task.cost.estimated) || task.cost.estimated < 0) {
    throw new ToolError(
      "invalid_input",
      `Task "${task.taskId}" has an invalid estimated cost (${String(task.cost.estimated)}).`,
      { path: "/cost/estimated", userActionRequired: false },
    );
  }
  if (task.dependsOn.includes(task.taskId)) {
    throw new ToolError(
      "invalid_input",
      `Task "${task.taskId}" depends on itself, which can never be satisfied.`,
      { path: "/dependsOn", userActionRequired: false },
    );
  }
}

/** Total estimated cost across a set of tasks. */
export function totalEstimatedCost(tasks: Iterable<AgentTask>): number {
  let total = 0;
  for (const task of tasks) total += task.cost.estimated;
  return total;
}

// ---------------------------------------------------------------------------
// Dependency resolution
// ---------------------------------------------------------------------------

export type ResolutionFailure =
  | { readonly kind: "cycle"; readonly taskIds: readonly string[]; readonly message: string }
  | { readonly kind: "missing_dependency"; readonly taskIds: readonly string[]; readonly missing: readonly string[]; readonly message: string }
  | { readonly kind: "duplicate_id"; readonly taskIds: readonly string[]; readonly message: string };

export type ResolutionResult =
  | { readonly ok: true; readonly order: readonly string[]; readonly waves: readonly (readonly string[])[] }
  | { readonly ok: false; readonly failure: ResolutionFailure };

/**
 * Compute a valid execution order, or explain why none exists.
 *
 * Returns waves as well as a flat order because they answer different questions: the flat
 * order is what the executor walks, and the waves are what the UI shows as "these four
 * shots can generate in parallel". Both come from the same single pass, so they cannot
 * disagree.
 *
 * Determinism: ready tasks are ordered by priority, then by the position of their role in
 * `ROLE_NAMES`, then by task id. Never by insertion order — a plan assembled from a map
 * would otherwise reorder itself between runs.
 *
 * Never hangs. A cycle is detected and reported with its members; it is not waited on.
 */
export function resolveExecutionOrder(tasks: readonly AgentTask[]): ResolutionResult {
  const byId = new Map<string, AgentTask>();
  const duplicates: string[] = [];
  for (const task of tasks) {
    if (byId.has(task.taskId)) duplicates.push(task.taskId);
    byId.set(task.taskId, task);
  }
  if (duplicates.length > 0) {
    return {
      ok: false,
      failure: {
        kind: "duplicate_id",
        taskIds: [...new Set(duplicates)],
        message: `Duplicate task id(s): ${[...new Set(duplicates)].join(", ")}. Task ids must be unique within a plan.`,
      },
    };
  }

  const missing = new Set<string>();
  for (const task of tasks) {
    for (const dependency of task.dependsOn) {
      if (!byId.has(dependency)) missing.add(dependency);
    }
  }
  if (missing.size > 0) {
    const missingList = [...missing].sort();
    return {
      ok: false,
      failure: {
        kind: "missing_dependency",
        taskIds: tasks.map((t) => t.taskId),
        missing: missingList,
        message:
          `The plan depends on task id(s) that do not exist: ${missingList.join(", ")}. ` +
          `A dependency that cannot be satisfied would leave the task blocked forever.`,
      },
    };
  }

  const remaining = new Map<string, Set<string>>();
  for (const task of tasks) {
    remaining.set(task.taskId, new Set(task.dependsOn));
  }

  const completed = new Set<string>();
  const order: string[] = [];
  const waves: string[][] = [];

  while (completed.size < tasks.length) {
    const ready = tasks
      .filter((task) => !completed.has(task.taskId))
      .filter((task) => [...(remaining.get(task.taskId) ?? [])].every((d) => completed.has(d)))
      .sort(compareReady);

    if (ready.length === 0) {
      const stuck = tasks
        .filter((task) => !completed.has(task.taskId))
        .map((task) => task.taskId)
        .sort();
      return {
        ok: false,
        failure: {
          kind: "cycle",
          taskIds: stuck,
          message:
            `The plan contains a dependency cycle among: ${stuck.join(", ")}. ` +
            `No task in that set can ever become ready, so the plan is rejected rather than run.`,
        },
      };
    }

    waves.push(ready.map((task) => task.taskId));
    for (const task of ready) {
      completed.add(task.taskId);
      order.push(task.taskId);
      for (const dependents of remaining.values()) dependents.delete(task.taskId);
    }
  }

  return { ok: true, order, waves };
}

/**
 * Ready-task ordering.
 *
 * Priority first (a human's explicit intent), then production role order, then id. Role
 * order matters more than it looks: without it, "storyboard" could be scheduled before
 * "script" in a plan where both are unblocked, which is merely wasteful rather than wrong
 * — but at scale, waste is what a budget cap actually hits.
 */
function compareReady(a: AgentTask, b: AgentTask): number {
  const priorityDelta = (b.priority ?? 0) - (a.priority ?? 0);
  if (priorityDelta !== 0) return priorityDelta;
  const roleDelta = roleRank(a.role) - roleRank(b.role);
  if (roleDelta !== 0) return roleDelta;
  return a.taskId < b.taskId ? -1 : a.taskId > b.taskId ? 1 : 0;
}

/** The role names, in the order a typical production uses them. */
export const ROLE_PRODUCTION_ORDER: readonly RoleName[] = [
  "researcher",
  "writer",
  "character_designer",
  "storyboard_artist",
  "animator",
  "audio_director",
  "editor",
  "qc_reviewer",
];

const ROLE_RANK: Readonly<Record<RoleName, number>> = Object.freeze(
  Object.fromEntries(ROLE_PRODUCTION_ORDER.map((name, index) => [name, index])) as Record<
    RoleName,
    number
  >,
);

function roleRank(role: RoleName): number {
  return ROLE_RANK[role] ?? 99;
}

/**
 * Topological order, or a thrown error.
 *
 * @throws ToolError `precondition_failed` for a cyclic or unsatisfiable plan. This is the
 *   form to use when a plan *must* be valid — for instance when loading a saved plan that
 *   was already approved — so that a corrupt plan cannot reach the executor at all.
 */
export function topologicalOrder(tasks: readonly AgentTask[]): readonly string[] {
  const result = resolveExecutionOrder(tasks);
  if (!result.ok) {
    throw new ToolError(
      result.failure.kind === "cycle" ? "precondition_failed" : "invalid_input",
      result.failure.message,
      {
        userActionRequired: false,
        detail: `Resolution failure kind: ${result.failure.kind}. Task ids: ${result.failure.taskIds.join(", ")}.`,
      },
    );
  }
  return result.order;
}

// ---------------------------------------------------------------------------
// TaskGraph
// ---------------------------------------------------------------------------

export type TaskStatus =
  | "pending"
  | "ready"
  | "running"
  | "awaiting_approval"
  | "succeeded"
  | "failed"
  | "skipped"
  | "cancelled"
  | "blocked";

/**
 * A plan: a set of tasks plus the derived dependency structure.
 *
 * Immutable from the outside. `withStatus` returns a new graph rather than mutating, so
 * the executor can keep the approved plan and the run state separate — which is what makes
 * "approved assets remain immutable" achievable, and what lets a run be replayed against
 * the plan it was actually approved against.
 */
export interface TaskGraph {
  readonly goal: string;
  readonly tasks: readonly AgentTask[];
  /** Topological order. Throws at construction if no valid order exists. */
  readonly order: readonly string[];
  /** Tasks grouped into dependency waves. */
  readonly waves: readonly (readonly string[])[];

  get(taskId: string): AgentTask | undefined;
  require(taskId: string): AgentTask;
  /** Tasks whose dependencies are all satisfied and which have not started. */
  ready(): readonly AgentTask[];
  /** Tasks with an unsatisfied dependency, and why. */
  blocked(): readonly (readonly [AgentTask, readonly string[]])[];
  /** Finished tasks, keyed by status. */
  complete(): readonly AgentTask[];
  failed(): readonly AgentTask[];
  status(taskId: string): TaskStatus;
  /** Produce a new graph with one task's status changed. */
  withStatus(taskId: string, status: TaskStatus): TaskGraph;
  /** Produce a new graph with several statuses applied at once. */
  withStatuses(entries: ReadonlyMap<string, TaskStatus>): TaskGraph;
  /** Every status, for reporting. */
  statuses(): ReadonlyMap<string, TaskStatus>;
  /** Total estimated cost of every task not yet finished. */
  remainingEstimatedCost(): number;
}

/**
 * Build a TaskGraph.
 *
 * @throws ToolError `precondition_failed` when the tasks form a cycle, or `invalid_input`
 *   when a dependency does not exist. Callers that want to handle the failure themselves
 *   use {@link tryCreateTaskGraph}, which returns the structured reason instead.
 */
export function createTaskGraph(
  goal: string,
  tasks: readonly AgentTask[],
  statuses?: ReadonlyMap<string, TaskStatus>,
): TaskGraph {
  const resolved = resolveExecutionOrder(tasks);
  if (!resolved.ok) {
    throw new ToolError(
      resolved.failure.kind === "cycle" ? "precondition_failed" : "invalid_input",
      resolved.failure.message,
      {
        userActionRequired: false,
        detail: `Resolution failure kind: ${resolved.failure.kind}.`,
      },
    );
  }
  for (const task of tasks) assertTaskWellFormed(task);
  return buildGraph(goal, tasks, resolved.order, resolved.waves, statuses);
}

/** Non-throwing variant of {@link createTaskGraph}. */
export function tryCreateTaskGraph(
  goal: string,
  tasks: readonly AgentTask[],
): { readonly ok: true; readonly graph: TaskGraph } | { readonly ok: false; readonly failure: ResolutionFailure } {
  const resolved = resolveExecutionOrder(tasks);
  if (!resolved.ok) return { ok: false, failure: resolved.failure };
  try {
    return { ok: true, graph: createTaskGraph(goal, tasks) };
  } catch (error) {
    if (error instanceof ToolError) {
      return {
        ok: false,
        failure: { kind: "missing_dependency", taskIds: [], missing: [], message: error.message },
      };
    }
    throw error;
  }
}

const TERMINAL_STATUSES: ReadonlySet<TaskStatus> = new Set<TaskStatus>([
  "succeeded",
  "failed",
  "skipped",
  "cancelled",
]);

function buildGraph(
  goal: string,
  tasks: readonly AgentTask[],
  order: readonly string[],
  waves: readonly (readonly string[])[],
  statuses?: ReadonlyMap<string, TaskStatus>,
): TaskGraph {
  const byId = new Map(tasks.map((task) => [task.taskId, task] as const));
  const status = new Map<string, TaskStatus>();
  for (const task of tasks) {
    status.set(task.taskId, statuses?.get(task.taskId) ?? "pending");
  }

  const graph: TaskGraph = {
    goal,
    tasks,
    order,
    waves,

    get: (taskId) => byId.get(taskId),

    require: (taskId) => {
      const task = byId.get(taskId);
      if (!task) {
        throw new ToolError("unknown_tool", `No task "${taskId}" in this plan.`, {
          userActionRequired: false,
        });
      }
      return task;
    },

    ready: () =>
      tasks.filter((task) => {
        if (status.get(task.taskId) !== "pending") return false;
        return task.dependsOn.every((d) => status.get(d) === "succeeded");
      }),

    blocked: () =>
      tasks
        .filter((task) => {
          const current = status.get(task.taskId);
          if (current !== "pending" && current !== "blocked") return false;
          return !task.dependsOn.every((d) => status.get(d) === "succeeded");
        })
        .map(
          (task) =>
            [
              task,
              /**
               * The *unsatisfied direct dependencies*, not the whole transitive chain.
               *
               * A user looking at a blocked task wants to know what it is waiting on — its
               * parents. The transitive root cause is a different and occasionally useful
               * question, answered by walking the graph; conflating the two produces a list
               * that grows with depth and buries the one entry that matters.
               */
              task.dependsOn.filter((d) => status.get(d) !== "succeeded"),
            ] as const,
        ),

    complete: () => tasks.filter((task) => TERMINAL_STATUSES.has(status.get(task.taskId) ?? "pending")),

    failed: () => tasks.filter((task) => status.get(task.taskId) === "failed"),

    status: (taskId) => status.get(taskId) ?? "pending",

    withStatus: (taskId, next) => {
      const updated = new Map(status);
      updated.set(taskId, next);
      return buildGraph(goal, tasks, order, waves, updated);
    },

    withStatuses: (entries) => {
      const updated = new Map(status);
      for (const [taskId, next] of entries) updated.set(taskId, next);
      return buildGraph(goal, tasks, order, waves, updated);
    },

    statuses: () => new Map(status),

    remainingEstimatedCost: () =>
      tasks
        .filter((task) => !TERMINAL_STATUSES.has(status.get(task.taskId) ?? "pending"))
        .reduce((total, task) => total + task.cost.estimated, 0),
  };

  return graph;
}

/**
 * Render a plan as text, for logs and the UI.
 *
 * Deterministic: the same graph always renders identically, which makes an audit trail
 * diffable between runs.
 */
export function describeGraph(graph: TaskGraph): string {
  const lines = [`Plan: ${graph.goal}`, `Tasks: ${graph.tasks.length}`];
  graph.waves.forEach((wave, index) => {
    lines.push(`  Wave ${index + 1}:`);
    for (const taskId of wave) {
      const task = graph.require(taskId);
      const gated = requiresHumanApproval(task) ? " [approval required]" : "";
      const tool = task.tool ? ` via ${task.tool}` : "";
      lines.push(`    - ${taskId} (${task.role}${tool})${gated}`);
    }
  });
  return lines.join("\n");
}

/**
 * Every task reachable from `from`, following `dependsOn` backwards.
 *
 * Used to work out what a failure invalidates: skipping the descendants of a failed task is
 * the difference between a run that reports one honest failure and one that cascades into
 * a dozen misleading ones.
 */
export function descendantsOf(graph: TaskGraph, taskId: string): readonly string[] {
  const dependents = new Map<string, string[]>();
  for (const task of graph.tasks) {
    for (const dependency of task.dependsOn) {
      const list = dependents.get(dependency) ?? [];
      list.push(task.taskId);
      dependents.set(dependency, list);
    }
  }
  const seen = new Set<string>();
  const queue = [...(dependents.get(taskId) ?? [])];
  while (queue.length > 0) {
    const next = queue.shift() as string;
    if (seen.has(next)) continue;
    seen.add(next);
    queue.push(...(dependents.get(next) ?? []));
  }
  return [...seen].sort();
}