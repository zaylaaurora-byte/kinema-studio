/**
 * The executor.
 *
 * It walks a {@link TaskGraph} and dispatches each task only when its parents have
 * succeeded, holding the four governance promises the spec makes:
 *
 *   1. **Approval gates.** A task marked `required` stops and reports
 *      `awaiting_approval`. It does not run, and its descendants do not run either.
 *   2. **Budget caps.** If dispatching a task would take cumulative estimated cost past the
 *      cap, dispatch is refused. The task never runs — no partial spend, no "it was only a
 *      little over".
 *   3. **Bounded retries, only for retryable errors.** A moderation block or a quota error
 *      is not retried, because the second attempt is guaranteed to fail and costs money to
 *      prove it.
 *   4. **Cancellation.** Queued work stops; nothing new starts.
 *
 * And one property that is less visible but load-bearing: given deterministic tools, the
 * whole run is deterministic. Every decision is a pure function of the graph and the
 * results so far. Time appears only in the audit trail, never in a branch.
 */

import { asToolError, ToolError, type ToolContext, type ToolRegistry } from "./tool.js";
import type { ToolName } from "./tool-names.js";
import {
  assertTaskWellFormed,
  type AgentTask,
  type TaskGraph,
  type TaskStatus,
} from "./task.js";
import { assertToolPermitted } from "./roles.js";

// ---------------------------------------------------------------------------
// Audit trail
// ---------------------------------------------------------------------------

/**
 * What happened, in the order it happened.
 *
 * The spec requires an audit trail; the Bad Example pilot requires "job costs, selected
 * provider, input settings, outputs and failures recorded". Both are the same artifact, so
 * there is one event type rather than a log plus a separate report.
 */
export type AuditEventKind =
  | "run_started"
  | "task_ready"
  | "dispatch_refused"
  | "budget_refused"
  | "approval_required"
  | "approval_granted"
  | "task_started"
  | "attempt_failed"
  | "retry_scheduled"
  | "task_succeeded"
  | "task_failed"
  | "task_skipped"
  | "task_cancelled"
  | "run_cancelled"
  | "run_finished";

export interface AuditEvent {
  /** Monotonic per-run sequence number. Ties are impossible, unlike with timestamps. */
  readonly sequence: number;
  readonly kind: AuditEventKind;
  readonly taskId?: string;
  readonly role?: string;
  readonly tool?: string;
  /** ISO-8601. */
  readonly at: string;
  /** Milliseconds since the run began. The number a user actually complains about. */
  readonly elapsedMs: number;
  readonly attempt?: number;
  /** Cost attributed by this event, when it concerns money. */
  readonly cost?: number;
  readonly message: string;
  readonly data?: Readonly<Record<string, unknown>>;
}

/**
 * A cap on spend.
 *
 * Three limits rather than one, because they guard genuinely different failures:
 * per-task catches a task whose estimate was wrong, total catches a plan whose estimates
 * were fine individually, and `maxApprovals` catches a plan that would otherwise stop for a
 * human twenty times.
 */
export interface BudgetCap {
  /** Hard ceiling on cumulative estimated cost. Dispatch past this is refused. */
  readonly totalCost?: number;
  /** Hard ceiling on any single task's estimated cost. */
  readonly perTaskCost?: number;
  /** How many tasks may sit awaiting approval at once. */
  readonly maxPendingApprovals?: number;
  readonly currency: "USD" | "GBP" | "EUR";
}

// ---------------------------------------------------------------------------
// Options, callbacks, results
// ---------------------------------------------------------------------------

export interface ExecutorOptions {
  /** The tools tasks may invoke. */
  readonly registry: ToolRegistry;
  readonly budget?: BudgetCap;
  /** Injected clock, so the audit trail is reproducible in tests. */
  readonly now?: () => string;
  /**
   * Slept between retries.
   *
   * Injected because a real backoff makes a test suite take minutes for no added
   * confidence. Tests pass a recorder; production leaves it unset and real backoff applies.
   */
  readonly sleep?: (ms: number) => Promise<void>;
  /**
   * Decision callback for an approval gate.
   *
   * Called *before* dispatch. Returning a denial marks the task `skipped` and its
   * descendants `blocked` — the run continues, because a user saying no to one step is not
   * a reason to abandon the rest.
   */
  readonly onApprovalRequired?: (request: ApprovalRequest) => Promise<ApprovalDecision> | ApprovalDecision;
  /** Progress callback. Never awaited for correctness; a throw here is swallowed. */
  readonly onEvent?: (event: AuditEvent) => void;
  /**
   * Whether a failed task blocks its descendants (default) or is treated as recoverable.
   * `block` is the default because silently proceeding with missing input is how a build
   * produces something plausible and wrong.
   */
  readonly onFailure?: "block" | "continue";
  /** Cap on total attempts across all tasks, a circuit breaker for runaway plans. */
  readonly maxTotalAttempts?: number;
  /** Cost ceiling override applied even when no `budget` is supplied. */
  readonly maxTotalCost?: number;
}

export interface ApprovalRequest {
  readonly taskId: string;
  readonly role: string;
  readonly goal: string;
  readonly tool?: ToolName;
  readonly reason: string;
  readonly gates: readonly string[];
  readonly estimatedCost: number;
  readonly currency: string;
  readonly cumulativeEstimatedCost: number;
}

export type ApprovalDecision =
  | { readonly approved: true; readonly decidedBy?: string; readonly note?: string }
  | { readonly approved: false; readonly decidedBy?: string; readonly note?: string };

export interface TaskOutcome {
  readonly taskId: string;
  readonly role: string;
  readonly status: TaskStatus;
  /** What the tool returned, when it ran. */
  readonly output?: unknown;
  /** Attempts made, counting the first. 0 when the task was never dispatched. */
  readonly attempts: number;
  /** Cost attributed to this task, from the tool's own estimate. */
  readonly cost: number;
  /** Populated for `failed` and `cancelled`. */
  readonly error?: ToolError;
  /** Why a task was skipped or blocked. */
  readonly reason?: string;
  readonly startedAt?: string;
  readonly finishedAt?: string;
}

export interface ExecutionResult {
  readonly runId: string;
  readonly goal: string;
  readonly status: "completed" | "awaiting_approval" | "cancelled" | "failed";
  readonly graph: TaskGraph;
  readonly outcomes: ReadonlyMap<string, TaskOutcome>;
  /** The order tasks were actually dispatched in. Asserted against by the ordering test. */
  readonly dispatchOrder: readonly string[];
  readonly audit: readonly AuditEvent[];
  readonly totalEstimatedCost: number;
  readonly totalActualCost: number;
  /** Present when `status` is `awaiting_approval`. */
  readonly pendingApprovals: readonly ApprovalRequest[];
  /** Present when `status` is `failed`. */
  readonly failure?: { readonly taskId: string; readonly error: ToolError };
}

// ---------------------------------------------------------------------------
// Executor
// ---------------------------------------------------------------------------

interface RunState {
  readonly statuses: Map<string, TaskStatus>;
  readonly outcomes: Map<string, TaskOutcome>;
  readonly dispatchOrder: string[];
  readonly audit: AuditEvent[];
  sequence: number;
  spent: number;
  attempts: number;
  cancelled: boolean;
  startedAtMs: number;
}

/**
 * Executes a task graph under the Director's governance rules.
 *
 * Stateless between runs: `execute` takes everything it needs and returns everything it
 * did, so two runs of the same graph with the same registry cannot influence each other.
 * That is what makes the run replayable and the tests honest.
 */
export class Executor {
  readonly #options: ExecutorOptions;

  constructor(options: ExecutorOptions) {
    this.#options = options;
  }

  /** The effective cap: `budget.totalCost`, else `maxTotalCost`, else none. */
  get budgetCap(): number | undefined {
    return this.#options.budget?.totalCost ?? this.#options.maxTotalCost;
  }

  /**
   * Run a graph to completion, a gate, a failure or a cancellation.
   *
   * @param graph - the plan. Not mutated: returned inside the result with final statuses.
   * @param signal - cancellation. Structurally typed so tests pass a stub.
   */
  async execute(graph: TaskGraph, signal?: { readonly aborted: boolean }): Promise<ExecutionResult> {
    const now = this.#options.now ?? (() => new Date().toISOString());
    const startedAtMs = Date.parse(now());
    const runId = `exec-${startedAtMs.toString(36)}`;

    const state: RunState = {
      statuses: new Map(graph.tasks.map((task) => [task.taskId, "pending" as TaskStatus])),
      outcomes: new Map(),
      dispatchOrder: [],
      audit: [],
      sequence: 0,
      spent: 0,
      attempts: 0,
      cancelled: false,
      startedAtMs: Number.isNaN(startedAtMs) ? 0 : startedAtMs,
    };

    const emit = (
      event: Omit<AuditEvent, "sequence" | "elapsedMs" | "at"> & { readonly at?: string },
    ): void => {
      state.sequence += 1;
      const at = event.at ?? now();
      const full: AuditEvent = {
        ...event,
        sequence: state.sequence,
        at,
        elapsedMs: Math.max(0, Date.parse(at) - state.startedAtMs),
      };
      state.audit.push(full);
      try {
        this.#options.onEvent?.(full);
      } catch {
        // A progress listener must never break a run. Nothing is more annoying than a
        // logging bug that kills a twenty-minute render.
      }
    };

    emit({
      kind: "run_started",
      message: `Executing "${graph.goal}" — ${graph.tasks.length} tasks in ${graph.waves.length} waves.`,
      data: { taskCount: graph.tasks.length, waveCount: graph.waves.length },
    });

    const pendingApprovalRequests: ApprovalRequest[] = [];

    /**
     * The main loop: repeatedly take everything that is ready, dispatch it, and repeat.
     *
     * Waves are recomputed each pass rather than taken from `graph.waves`, because a
     * refusal or a failure changes what is ready. Walking the precomputed waves would keep
     * dispatching a task whose parent was just refused.
     */
    for (;;) {
      /**
       * `signal?.aborted` is typed as `boolean | undefined`; TypeScript narrows `=== true`
       * to a false-only branch when the union collapses, so the check is written as a
       * plain truthiness test over a normalised value.
       */
      if (state.cancelled || signal?.aborted === true) {
        this.#cancelRemaining(state, graph, emit, now);
        break;
      }

      const ready = graph.tasks.filter(
        (task) =>
          state.statuses.get(task.taskId) === "pending" &&
          task.dependsOn.every((dependency) => state.statuses.get(dependency) === "succeeded"),
      );

      if (ready.length === 0) {
        // Nothing ready. Either we are done, or something is stuck.
        const unfinished = graph.tasks.filter((task) => {
          const status = state.statuses.get(task.taskId);
          return status === "pending" || status === "running" || status === "awaiting_approval";
        });

        if (unfinished.length === 0) break;

        const awaiting = unfinished.filter((task) => state.statuses.get(task.taskId) === "awaiting_approval");
        if (awaiting.length > 0) {
          emit({
            kind: "dispatch_refused",
            message:
              `${awaiting.length} task(s) are awaiting approval and ${unfinished.length - awaiting.length} ` +
              `are blocked behind them. Resume with an approval decision to continue.`,
            data: { awaiting: awaiting.map((task) => task.taskId) },
          });
          break;
        }

        /**
         * Nothing ready and nothing awaiting approval means a dependency failed. Mark the
         * remainder blocked rather than leaving them pending, so the report says "these
         * could not run because of that failure" rather than "these never ran", which reads
         * as a bug in the executor.
         */
        for (const task of unfinished) {
          if (state.statuses.get(task.taskId) !== "pending") continue;
          const failedDeps = task.dependsOn.filter((dependency) => {
            const status = state.statuses.get(dependency);
            return status !== "succeeded";
          });
          state.statuses.set(task.taskId, "blocked");
          state.outcomes.set(task.taskId, {
            taskId: task.taskId,
            role: task.role,
            status: "blocked",
            attempts: 0,
            cost: 0,
            reason: `Dependency not satisfied: ${failedDeps.join(", ")}`,
          });
          emit({
            kind: "task_skipped",
            taskId: task.taskId,
            role: task.role,
            message: `Blocked: ${failedDeps.join(", ")} did not succeed.`,
          });
        }
        break;
      }

      for (const task of ready) {
        // After the loop above, `signal?.aborted === true` has been proven false, so only a
        // cancellation raised *during* a dispatch needs re-checking here.
        if (state.cancelled) break;
        await this.#dispatch(task, graph, state, emit, now, runId, pendingApprovalRequests, signal);
      }
    }

    // A cancellation observed mid-flight must still mark the queue stopped, so the result
    // reports `cancelled` rather than looking like a run that simply ran out of work.
    if (signal?.aborted === true && !state.cancelled) {
      this.#cancelRemaining(state, graph, emit, now);
    }

    const finalStatus = this.#finalStatus(state, graph);
    emit({
      kind: finalStatus === "cancelled" ? "run_cancelled" : "run_finished",
      message:
        `Run ${finalStatus}. ${state.dispatchOrder.length} task(s) dispatched, ` +
        `estimated spend ${state.spent.toFixed(4)}.`,
      cost: state.spent,
      data: { dispatchOrder: [...state.dispatchOrder] },
    });

    const failure = this.#firstFailure(state);
    return {
      runId,
      goal: graph.goal,
      status: finalStatus,
      graph: graph.withStatuses(state.statuses),
      outcomes: state.outcomes,
      dispatchOrder: state.dispatchOrder,
      audit: state.audit,
      totalEstimatedCost: graph.tasks.reduce((sum, task) => sum + task.cost.estimated, 0),
      totalActualCost: state.spent,
      pendingApprovals: pendingApprovalRequests,
      ...(failure !== undefined ? { failure } : {}),
    };
  }

  // ── Dispatch ────────────────────────────────────────────────────────────

  async #dispatch(
    task: AgentTask,
    graph: TaskGraph,
    state: RunState,
    emit: Emit,
    now: () => string,
    runId: string,
    pendingApprovals: ApprovalRequest[],
    /**
     * The run-level cancellation signal, threaded down so a tool's `ctx.signal` can
     * reflect BOTH it and run-state cancellation.
     *
     * It is passed explicitly rather than captured from `execute`'s closure because tools
     * need a live view: a long-running tool that reads `ctx.signal.aborted` mid-execution
     * must see cancellation that happened after it started.
     */
    signal?: { readonly aborted: boolean },
  ): Promise<void> {
    const nowIso = now();

    // ── Well-formedness ───────────────────────────────────────────────────
    try {
      assertTaskWellFormed(task);
    } catch (error) {
      this.#fail(state, task, asToolError(error, task.tool), 0, emit, now, "block");
      return;
    }

    // ── Role allowlist ────────────────────────────────────────────────────
    if (task.tool !== undefined) {
      try {
        assertToolPermitted(task.role, task.tool);
      } catch (error) {
        /**
         * Refused, not failed-with-retry. An allowlist violation is a planning error: the
         * same task will be refused identically however many times it is attempted, so
         * retrying would only waste time.
         */
        this.#fail(state, task, asToolError(error, task.tool), 0, emit, now, "block");
        return;
      }
    }

    // ── Per-task budget ───────────────────────────────────────────────────
    const perTaskCap = this.#options.budget?.perTaskCost;
    if (perTaskCap !== undefined && task.cost.estimated > perTaskCap) {
      const error = new ToolError(
        "budget_exceeded",
        `Task "${task.taskId}" is estimated at ${task.cost.estimated.toFixed(4)} ` +
          `${task.cost.currency}, above the per-task cap of ${perTaskCap.toFixed(4)}. ` +
          `Dispatch refused; the task did not run.`,
        {
          userActionRequired: true,
          ...(task.tool !== undefined ? { toolName: task.tool } : {}),
        },
      );
      this.#fail(state, task, error, 0, emit, now, "block", "budget_refused");
      return;
    }

    // ── Total budget ──────────────────────────────────────────────────────
    /**
     * The check the spec names explicitly: "budget cap prevents dispatch".
     *
     * It compares the *cumulative* spend plus this task's estimate against the cap, and
     * refuses rather than allowing an overshoot to be discovered afterwards. Note that the
     * refused task is marked failed, not skipped: it was not declined by a human, it was
     * prevented by the cap, and those must look different in the report.
     */
    const cap = this.budgetCap;
    if (cap !== undefined && state.spent + task.cost.estimated > cap) {
      const error = new ToolError(
        "budget_exceeded",
        `Budget cap reached: ${state.spent.toFixed(4)} already committed, and ` +
          `"${task.taskId}" is estimated at a further ${task.cost.estimated.toFixed(4)}, ` +
          `which would exceed the cap of ${cap.toFixed(4)} ${task.cost.currency}. ` +
          `Dispatch refused; the task did not run.`,
        {
          userActionRequired: true,
          ...(task.tool !== undefined ? { toolName: task.tool } : {}),
          detail:
            `Raise the cap, or reduce the scope of the plan. The cap is checked before ` +
            `dispatch rather than after, so this run has not spent the money.`,
        },
      );
      this.#fail(state, task, error, 0, emit, now, "block", "budget_refused");
      return;
    }

    // ── Approval gate ─────────────────────────────────────────────────────
    if (task.approval.mode === "required") {
      const request: ApprovalRequest = {
        taskId: task.taskId,
        role: task.role,
        goal: task.goal,
        ...(task.tool !== undefined ? { tool: task.tool } : {}),
        reason: task.approval.reason,
        gates: task.approval.gates,
        estimatedCost: task.cost.estimated,
        currency: task.cost.currency,
        cumulativeEstimatedCost: state.spent + task.cost.estimated,
      };

      /**
       * The cap on outstanding approvals. Without it, a plan that gates every step stops
       * twenty times, and a user approves reflexively — which is worse than no gate at all,
       * because it produces a consent record that means nothing.
       */
      const maxPending = this.#options.budget?.maxPendingApprovals;
      if (maxPending !== undefined && pendingApprovals.length >= maxPending) {
        state.statuses.set(task.taskId, "awaiting_approval");
        state.outcomes.set(task.taskId, {
          taskId: task.taskId,
          role: task.role,
          status: "awaiting_approval",
          attempts: 0,
          cost: 0,
          reason: `Held back: ${pendingApprovals.length} approval(s) are already outstanding (limit ${maxPending}).`,
        });
        emit({
          kind: "approval_required",
          taskId: task.taskId,
          role: task.role,
          message: `Awaiting approval, but ${maxPending} are already outstanding.`,
          data: { gates: request.gates, estimatedCost: request.estimatedCost },
        });
        return;
      }

      pendingApprovals.push(request);
      emit({
        kind: "approval_required",
        taskId: task.taskId,
        role: task.role,
        ...(task.tool !== undefined ? { tool: task.tool } : {}),
        message: `${request.reason} (estimated ${request.estimatedCost.toFixed(4)} ${request.currency}).`,
        cost: request.estimatedCost,
        data: { gates: request.gates },
      });

      const decision = this.#options.onApprovalRequired
        ? await this.#options.onApprovalRequired(request)
        : ({ approved: false, note: "No approval handler is configured." } as const);

      if (!decision.approved) {
        state.statuses.set(task.taskId, "skipped");
        state.outcomes.set(task.taskId, {
          taskId: task.taskId,
          role: task.role,
          status: "skipped",
          attempts: 0,
          cost: 0,
          reason:
            `Approval denied${decision.decidedBy !== undefined ? ` by ${decision.decidedBy}` : ""}` +
            `${decision.note !== undefined ? `: ${decision.note}` : "."}`,
        });
        emit({
          kind: "task_skipped",
          taskId: task.taskId,
          role: task.role,
          message: `Approval denied. Task skipped and its dependants will be blocked.`,
        });
        pendingApprovals.splice(pendingApprovals.indexOf(request), 1);
        return;
      }

      pendingApprovals.splice(pendingApprovals.indexOf(request), 1);
      emit({
        kind: "approval_granted",
        taskId: task.taskId,
        role: task.role,
        message: `Approved${decision.decidedBy !== undefined ? ` by ${decision.decidedBy}` : ""}.`,
      });
    }

    // ── Run ───────────────────────────────────────────────────────────────
    state.statuses.set(task.taskId, "running");
    state.dispatchOrder.push(task.taskId);

    const startedAt = nowIso;
    const startedMs = Date.now();

    const maxAttempts = Math.max(1, task.retry.maxAttempts);
    let attempt = 0;
    let lastError: ToolError | undefined;

    emit({
      kind: "task_started",
      taskId: task.taskId,
      role: task.role,
      ...(task.tool !== undefined ? { tool: task.tool } : {}),
      message: task.tool !== undefined
        ? `Running ${task.tool}.`
        : `Running ${task.role} reasoning step (no tool).`,
      data: { goal: task.goal, maxAttempts },
    });

    while (attempt < maxAttempts) {
      attempt += 1;
      state.attempts += 1;

      if (state.cancelled || this.#options.registry === undefined) {
        // Unreachable in practice; kept so the loop body is total.
      }

      if (this.#totalAttemptsExceeded(state)) {
        lastError = new ToolError(
          "internal",
          `Run-wide attempt limit (${this.#options.maxTotalAttempts ?? 0}) reached. ` +
            `Stopping to avoid an unbounded retry loop.`,
          { userActionRequired: true },
        );
        break;
      }

      /**
       * No tool means a reasoning-only step. The role still owes a structured output, but
       * this package has no model to produce it — so the step yields a well-formed
       * placeholder that names what is missing. Fabricating content here would be exactly
       * the "hard-coded generation results" the pilot brief lists as a failure mode.
       */
      if (task.tool === undefined) {
        state.statuses.set(task.taskId, "succeeded");
        state.outcomes.set(task.taskId, {
          taskId: task.taskId,
          role: task.role,
          status: "succeeded",
          attempts: attempt,
          cost: 0,
          output: {
            taskId: task.taskId,
            role: task.role,
            note:
              "Reasoning-only task: no tool was assigned, so the executor produced no content. " +
              "Attach a model-backed agent to fill this in.",
          },
          startedAt,
          finishedAt: now(),
        });
        emit({
          kind: "task_succeeded",
          taskId: task.taskId,
          role: task.role,
          attempt,
          message: `Completed with no tool assigned.`,
        });
        return;
      }

      const registry = this.#options.registry;
      const invocationId = `${task.taskId}#${attempt}`;

      const ctx: ToolContext = {
        invocationId,
        taskId: task.taskId,
        role: task.role,
        ...(task.referenceSnapshot.projectId !== undefined
          ? { projectId: task.referenceSnapshot.projectId }
          : {}),
        artifacts: this.#artifactsFor(task, state),
        now,
        /**
         * A live view of cancellation, not a snapshot.
         *
         * `state` is mutated by the run loop, and a tool that reads `ctx.signal.aborted`
         * mid-execution must see the *current* value. Capturing a boolean here would hand a
         * long-running tool a stale `false` and let it keep working after the user cancelled.
         */
        signal: { get aborted() { return state.cancelled || signal?.aborted === true; } },
        ...(this.#options.onEvent !== undefined
          ? {
              report: (message: string, data?: Readonly<Record<string, unknown>>): void => {
                emit({
                  kind: "task_started",
                  taskId: task.taskId,
                  role: task.role,
                  message,
                  ...(data !== undefined ? { data } : {}),
                });
              },
            }
          : {}),
      };

      const result = await registry.invoke(task.tool, task.inputs, ctx);

      if (result.ok) {
        const cost = result.cost;
        state.spent += cost;
        state.statuses.set(task.taskId, "succeeded");
        state.outcomes.set(task.taskId, {
          taskId: task.taskId,
          role: task.role,
          status: "succeeded",
          attempts: attempt,
          cost,
          output: result.output,
          startedAt,
          finishedAt: now(),
        });
        emit({
          kind: "task_succeeded",
          taskId: task.taskId,
          role: task.role,
          tool: task.tool,
          attempt,
          cost,
          message: `Succeeded on attempt ${attempt} (${result.durationMs} ms).`,
        });
        return;
      }

      lastError = result.error;

      emit({
        kind: "attempt_failed",
        taskId: task.taskId,
        role: task.role,
        tool: task.tool,
        attempt,
        message: `Attempt ${attempt} failed: ${result.error.message}`,
        data: { code: result.error.code, retryable: result.error.retryable },
      });

      /**
       * The retry rule, in one place.
       *
       * `retryable` on the error is the only thing consulted, and `retryOn` must include
       * "retryable". So a moderation block or a quota error — both of which carry
       * `retryable: false` from the provider taxonomy — is never retried, while a transient
       * 5xx is. Attempts are bounded by `maxAttempts`, and the backoff is capped.
       */
      const shouldRetry =
        attempt < maxAttempts &&
        result.error.retryable &&
        task.retry.retryOn.includes("retryable");

      if (!shouldRetry) {
        if (attempt < maxAttempts && !result.error.retryable) {
          emit({
            kind: "attempt_failed",
            taskId: task.taskId,
            role: task.role,
            attempt,
            message:
              `Not retrying: the error is marked non-retryable (${result.error.code}). ` +
              `Retrying it would fail identically and spend the user's money to prove it.`,
          });
        }
        break;
      }

      const delay = this.#backoffMs(task, attempt);
      emit({
        kind: "retry_scheduled",
        taskId: task.taskId,
        role: task.role,
        attempt: attempt + 1,
        message: `Retrying in ${delay} ms (attempt ${attempt + 1} of ${maxAttempts}).`,
        data: { delayMs: delay },
      });

      if (this.#options.sleep) {
        await this.#options.sleep(delay);
      } else {
        await defaultSleep(delay);
      }

      if (state.cancelled) break;
    }

    this.#fail(
      state,
      task,
      lastError ??
        new ToolError("internal", `Task "${task.taskId}" ended without a result.`, {
          ...(task.tool !== undefined ? { toolName: task.tool } : {}),
        }),
      attempt,
      emit,
      now,
      this.#options.onFailure ?? "block",
      undefined,
      startedAt,
    );
  }

  // ── Helpers ─────────────────────────────────────────────────────────────

  #backoffMs(task: AgentTask, attempt: number): number {
    const base = Math.max(0, task.retry.baseBackoffMs);
    const cap = Math.max(base, task.retry.maxBackoffMs);
    const exponential = base * 2 ** (attempt - 1);
    const jitter = task.retry.jitterFactor ?? 1;
    return Math.min(cap, Math.round(exponential * jitter));
  }

  #totalAttemptsExceeded(state: RunState): boolean {
    const limit = this.#options.maxTotalAttempts;
    return limit !== undefined && state.attempts > limit;
  }

  /**
   * Artifacts visible to a task: the outputs of its *direct* dependencies only.
   *
   * Deliberately not everything. Handing a task the whole run's output would let a
   * downstream role read something it never declared a dependency on, which would make the
   * dependency graph a lie and the audit trail unable to explain why a task produced what
   * it did.
   */
  #artifactsFor(task: AgentTask, state: RunState): Readonly<Record<string, unknown>> {
    const artifacts: Record<string, unknown> = {};
    for (const dependency of task.dependsOn) {
      const outcome = state.outcomes.get(dependency);
      if (outcome?.output !== undefined) artifacts[dependency] = outcome.output;
    }
    return artifacts;
  }

  #fail(
    state: RunState,
    task: AgentTask,
    error: ToolError,
    attempts: number,
    emit: Emit,
    now: () => string,
    onFailure: "block" | "continue",
    kindOverride?: AuditEventKind,
    startedAt?: string,
  ): void {
    state.statuses.set(task.taskId, "failed");
    state.outcomes.set(task.taskId, {
      taskId: task.taskId,
      role: task.role,
      status: "failed",
      attempts,
      cost: 0,
      error,
      ...(startedAt !== undefined ? { startedAt } : {}),
      finishedAt: now(),
    });
    emit({
      kind: kindOverride ?? "task_failed",
      taskId: task.taskId,
      role: task.role,
      ...(task.tool !== undefined ? { tool: task.tool } : {}),
      message: error.message,
      data: { code: error.code, retryable: error.retryable, onFailure },
    });
  }

  #cancelRemaining(state: RunState, graph: TaskGraph, emit: Emit, now: () => string): void {
    if (state.cancelled) return;
    state.cancelled = true;
    for (const task of graph.tasks) {
      const status = state.statuses.get(task.taskId);
      if (status !== "pending" && status !== "awaiting_approval") continue;
      state.statuses.set(task.taskId, "cancelled");
      state.outcomes.set(task.taskId, {
        taskId: task.taskId,
        role: task.role,
        status: "cancelled",
        attempts: 0,
        cost: 0,
        reason: "Cancelled before dispatch.",
        finishedAt: now(),
      });
      emit({
        kind: "task_cancelled",
        taskId: task.taskId,
        role: task.role,
        message: "Cancelled before dispatch.",
      });
    }
  }

  #finalStatus(state: RunState, graph: TaskGraph): ExecutionResult["status"] {
    if (state.cancelled) return "cancelled";
    const anyAwaiting = [...state.statuses.values()].some((status) => status === "awaiting_approval");
    if (anyAwaiting) return "awaiting_approval";
    const anyFailed = [...state.statuses.values()].some((status) => status === "failed");
    if (anyFailed) return "failed";
    const allSucceeded = graph.tasks.every((task) => state.statuses.get(task.taskId) === "succeeded");
    return allSucceeded ? "completed" : "failed";
  }

  #firstFailure(state: RunState): { taskId: string; error: ToolError } | undefined {
    for (const [taskId, outcome] of state.outcomes) {
      if (outcome.status === "failed" && outcome.error) return { taskId, error: outcome.error };
    }
    return undefined;
  }
}

type Emit = (
  event: Omit<AuditEvent, "sequence" | "elapsedMs" | "at"> & { at?: string },
) => void;

/** Real backoff. Tests inject `sleep` instead; this exists for production. */
function defaultSleep(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

/**
 * Render a run as text.
 *
 * Deliberately blunt, following the pilot brief's "kept deliberately blunt: what works,
 * what does not, and what has not been attempted". A report that only lists successes is
 * how a build looks finished when it is not.
 */
export function describeExecution(result: ExecutionResult): string {
  const lines: string[] = [
    `Run ${result.runId}: ${result.status}`,
    `Goal: ${result.goal}`,
    `Dispatched: ${result.dispatchOrder.length} of ${result.graph.tasks.length} task(s)`,
    `Estimated spend: ${result.totalEstimatedCost.toFixed(4)}`,
    `Actual spend: ${result.totalActualCost.toFixed(4)}`,
    "",
    "Outcomes:",
  ];

  for (const task of result.graph.tasks) {
    const outcome = result.outcomes.get(task.taskId);
    if (!outcome) {
      lines.push(`  - ${task.taskId} (${task.role}): not reached`);
      continue;
    }
    const suffix = outcome.error
      ? ` — ${outcome.error.code}: ${outcome.error.message}`
      : outcome.reason
        ? ` — ${outcome.reason}`
        : "";
    lines.push(
      `  - ${task.taskId} (${task.role}): ${outcome.status}, attempts ${outcome.attempts}, ` +
        `cost ${outcome.cost.toFixed(4)}${suffix}`,
    );
  }

  if (result.pendingApprovals.length > 0) {
    lines.push("", "Awaiting approval:");
    for (const request of result.pendingApprovals) {
      lines.push(
        `  - ${request.taskId} (${request.role}): ${request.reason} ` +
          `[${request.gates.join(", ")}] ≈ ${request.estimatedCost.toFixed(4)} ${request.currency}`,
      );
    }
  }

  lines.push("", `Audit trail: ${result.audit.length} event(s).`);
  return lines.join("\n");
}