/**
 * Task contract and dependency resolution.
 *
 * The assertions that matter most here are the two failure modes that make a planner
 * untrustworthy: a cycle, which must be rejected rather than hung on, and an unresolvable
 * dependency, which must be reported rather than left to block forever.
 */

import { describe, expect, it } from "vitest";

import { ROLES, type RoleName } from "../roles.js";
import { ToolError } from "../tool.js";
import { TOOL } from "../tool-names.js";
import {
  approvalGates,
  approvalReason,
  assertTaskWellFormed,
  createTask,
  createTaskGraph,
  DEFAULT_RETRY_POLICY,
  describeGraph,
  descendantsOf,
  requiresHumanApproval,
  resolveExecutionOrder,
  retryPolicy,
  totalEstimatedCost,
  topologicalOrder,
  tryCreateTaskGraph,
  type AgentTask,
  type CreateTaskInput,
} from "../task.js";
import { makeClock } from "./helpers.js";

/** Immediate dependencies and priors are fully specified, so a task is easy to read. */
function task(overrides: Partial<CreateTaskInput> & { taskId: string; role: RoleName }): AgentTask {
  return createTask({
    goal: `Do the ${overrides.role} work.`,
    now: makeClock(),
    ...overrides,
  });
}

describe("createTask", () => {
  it("fills the role's own output schema when none is given", () => {
    const created = task({ taskId: "t1", role: "writer" });
    // Not an unconstrained schema: a task that accepts anything defeats the contract.
    expect(created.outputSchema).toEqual(ROLES.writer.outputSchema);
  });

  it("defaults to no retries and a 120-second timeout", () => {
    const created = task({ taskId: "t1", role: "writer" });
    expect(created.retry).toEqual(DEFAULT_RETRY_POLICY);
    expect(created.retry.maxAttempts).toBe(1);
    expect(created.timeoutMs).toBe(120_000);
  });

  it("carries every field the spec's task contract names", () => {
    const created = task({
      taskId: "t1",
      role: "animator",
      goal: "Animate shot 1.",
      inputs: { shotId: "s1" },
      allowedTools: [TOOL.READ_SCRIPT],
      tool: TOOL.READ_SCRIPT,
      outputSchema: { type: "object" },
      estimatedCost: 0.04,
      costBasis: "per_image",
      timeoutMs: 5_000,
      retry: retryPolicy(3),
      approval: { mode: "required", reason: "spends money", gates: ["spends_money"] },
      dependsOn: ["t0"],
      audit: { createdBy: "test", runId: "run-1" },
    });

    // task_id, role, goal, typed inputs, allowed tools/models, reference snapshot, output
    // schema, estimated cost, timeout, retry policy, approval policy, parent dependencies,
    // audit metadata.
    expect(created.taskId).toBe("t1");
    expect(created.role).toBe("animator");
    expect(created.goal).toBe("Animate shot 1.");
    expect(created.inputs).toEqual({ shotId: "s1" });
    expect(created.allowedTools).toEqual([TOOL.READ_SCRIPT]);
    expect(created.tool).toBe(TOOL.READ_SCRIPT);
    expect(created.referenceSnapshot.snapshotId).toContain("snapshot");
    expect(created.outputSchema).toBeDefined();
    expect(created.cost.estimated).toBe(0.04);
    expect(created.timeoutMs).toBe(5_000);
    expect(created.retry.maxAttempts).toBe(3);
    expect(created.approval.mode).toBe("required");
    expect(created.dependsOn).toEqual(["t0"]);
    expect(created.audit.createdBy).toBe("test");
    expect(created.audit.runId).toBe("run-1");
  });

  it("is frozen, so an approved plan cannot be edited in place", () => {
    const created = task({ taskId: "t1", role: "writer" });
    expect(Object.isFrozen(created)).toBe(true);
  });

  it("refuses a negative cost rather than treating it as free", () => {
    expect(() => task({ taskId: "t1", role: "writer", estimatedCost: -1 })).toThrowError(
      /negative estimated cost/,
    );
  });

  it("refuses a non-positive timeout", () => {
    expect(() => task({ taskId: "t1", role: "writer", timeoutMs: 0 })).toThrowError(
      /non-positive timeout/,
    );
  });

  it("refuses an unknown role", () => {
    expect(() =>
      createTask({ taskId: "t1", role: "showrunner" as RoleName, goal: "x", now: makeClock() }),
    ).toThrowError(/unknown role/);
  });
});

describe("approval policy", () => {
  it("reports auto tasks as needing no human", () => {
    const created = task({ taskId: "t1", role: "writer", approval: { mode: "auto" } });
    expect(requiresHumanApproval(created)).toBe(false);
    expect(approvalReason(created)).toBeUndefined();
    expect(approvalGates(created)).toEqual([]);
  });

  it("reports a required task with its structured gates", () => {
    const created = task({
      taskId: "t1",
      role: "animator",
      approval: { mode: "required", reason: "spends money", gates: ["spends_money"] },
    });
    expect(requiresHumanApproval(created)).toBe(true);
    expect(approvalGates(created)).toEqual(["spends_money"]);
    expect(approvalReason(created)).toBe("spends money");
  });

  it("treats on_failure as needing a reason but not blocking the first attempt", () => {
    const created = task({
      taskId: "t1",
      role: "animator",
      approval: { mode: "on_failure", reason: "review a failed render" },
    });
    expect(requiresHumanApproval(created)).toBe(false);
    expect(approvalReason(created)).toBe("review a failed render");
  });
});

describe("retryPolicy", () => {
  it("floors maxAttempts at 1, because the first attempt is not a retry", () => {
    expect(retryPolicy(0).maxAttempts).toBe(1);
    expect(retryPolicy(3).maxAttempts).toBe(3);
  });

  it("retries only errors marked retryable by default", () => {
    expect(retryPolicy(3).retryOn).toEqual(["retryable"]);
  });
});

describe("assertTaskWellFormed", () => {
  it("refuses a task whose tool is not in its own allowedTools", () => {
    const created = task({
      taskId: "t1",
      role: "writer",
      allowedTools: [TOOL.READ_SCRIPT],
      tool: TOOL.WRITE_SCRIPT,
    });
    expect(() => assertTaskWellFormed(created)).toThrowError(/does not list it in allowedTools/);
  });

  it("refuses a task that depends on itself", () => {
    const created = task({ taskId: "t1", role: "writer", dependsOn: ["t1"] });
    expect(() => assertTaskWellFormed(created)).toThrowError(/depends on itself/);
  });

  it("accepts a well-formed task", () => {
    const created = task({ taskId: "t1", role: "writer", allowedTools: [TOOL.WRITE_SCRIPT], tool: TOOL.WRITE_SCRIPT });
    expect(() => assertTaskWellFormed(created)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Dependency resolution
// ---------------------------------------------------------------------------

describe("resolveExecutionOrder", () => {
  it("computes the order implied by dependencies, not the order given", () => {
    // Deliberately supplied back-to-front.
    const tasks = [
      task({ taskId: "c", role: "editor", dependsOn: ["b"] }),
      task({ taskId: "b", role: "writer", dependsOn: ["a"] }),
      task({ taskId: "a", role: "researcher" }),
    ];

    const result = resolveExecutionOrder(tasks);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.order).toEqual(["a", "b", "c"]);
    expect(result.waves).toEqual([["a"], ["b"], ["c"]]);
  });

  it("groups independent tasks into one wave", () => {
    const tasks = [
      task({ taskId: "root", role: "researcher" }),
      task({ taskId: "x", role: "writer", dependsOn: ["root"] }),
      task({ taskId: "y", role: "storyboard_artist", dependsOn: ["root"] }),
      task({ taskId: "z", role: "editor", dependsOn: ["x", "y"] }),
    ];

    const result = resolveExecutionOrder(tasks);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.waves).toEqual([["root"], ["x", "y"], ["z"]]);
    expect(result.order.indexOf("z")).toBe(3);
  });

  it("REJECTS a cyclic plan rather than hanging", () => {
    const tasks = [
      task({ taskId: "a", role: "writer", dependsOn: ["c"] }),
      task({ taskId: "b", role: "editor", dependsOn: ["a"] }),
      task({ taskId: "c", role: "animator", dependsOn: ["b"] }),
    ];

    const result = resolveExecutionOrder(tasks);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.kind).toBe("cycle");
    expect(result.failure.taskIds).toEqual(["a", "b", "c"]);
    expect(result.failure.message).toContain("cycle");
  });

  it("rejects a two-task cycle too", () => {
    const tasks = [
      task({ taskId: "a", role: "writer", dependsOn: ["b"] }),
      task({ taskId: "b", role: "editor", dependsOn: ["a"] }),
    ];
    const result = resolveExecutionOrder(tasks);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.kind).toBe("cycle");
  });

  it("returns promptly on a cycle — no infinite loop", () => {
    const tasks = Array.from({ length: 200 }, (_, index) =>
      task({
        taskId: `t${index}`,
        role: "writer",
        dependsOn: [`t${(index + 1) % 200}`],
      }),
    );

    const started = Date.now();
    const result = resolveExecutionOrder(tasks);
    const elapsed = Date.now() - started;

    expect(result.ok).toBe(false);
    // Generous, but it proves the detection is not waiting for something.
    expect(elapsed).toBeLessThan(2_000);
  });

  it("reports a dependency that does not exist", () => {
    const tasks = [task({ taskId: "a", role: "writer", dependsOn: ["ghost"] })];
    const result = resolveExecutionOrder(tasks);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.kind).toBe("missing_dependency");
    if (result.failure.kind !== "missing_dependency") return;
    expect(result.failure.missing).toEqual(["ghost"]);
  });

  it("reports duplicate task ids", () => {
    const tasks = [task({ taskId: "a", role: "writer" }), task({ taskId: "a", role: "editor" })];
    const result = resolveExecutionOrder(tasks);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.kind).toBe("duplicate_id");
  });

  it("is deterministic when several tasks are ready at once", () => {
    // Same set, different input order — the output must not vary.
    const tasks = [
      task({ taskId: "z_editor", role: "editor" }),
      task({ taskId: "a_writer", role: "writer" }),
      task({ taskId: "m_researcher", role: "researcher" }),
    ];
    const shuffled = [tasks[1], tasks[2], tasks[0]] as AgentTask[];

    const first = resolveExecutionOrder(tasks);
    const second = resolveExecutionOrder(shuffled);
    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    // Role order decides, so the writer comes before the editor regardless of input order.
    expect(first.order).toEqual(second.order);
    expect(first.order).toEqual(["m_researcher", "a_writer", "z_editor"]);
  });

  it("honours priority above role order", () => {
    const tasks = [
      task({ taskId: "low", role: "researcher" }),
      task({ taskId: "urgent", role: "editor", priority: 10 }),
    ];
    const result = resolveExecutionOrder(tasks);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.order).toEqual(["urgent", "low"]);
  });
});

describe("topologicalOrder", () => {
  it("returns the order for a valid plan", () => {
    const tasks = [
      task({ taskId: "b", role: "writer", dependsOn: ["a"] }),
      task({ taskId: "a", role: "researcher" }),
    ];
    expect(topologicalOrder(tasks)).toEqual(["a", "b"]);
  });

  it("throws a ToolError for a cyclic plan", () => {
    const tasks = [
      task({ taskId: "a", role: "writer", dependsOn: ["b"] }),
      task({ taskId: "b", role: "editor", dependsOn: ["a"] }),
    ];

    let thrown: unknown;
    try {
      topologicalOrder(tasks);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(ToolError);
    expect((thrown as ToolError).code).toBe("precondition_failed");
  });
});

// ---------------------------------------------------------------------------
// TaskGraph
// ---------------------------------------------------------------------------

describe("TaskGraph", () => {
  const build = () =>
    createTaskGraph("a small film", [
      task({ taskId: "research", role: "researcher" }),
      task({ taskId: "script", role: "writer", dependsOn: ["research"] }),
      task({ taskId: "board", role: "storyboard_artist", dependsOn: ["script"] }),
    ]);

  it("reports the root as ready and the rest as blocked", () => {
    const graph = build();
    expect(graph.ready().map((t) => t.taskId)).toEqual(["research"]);

    const blocked = graph.blocked();
    expect(blocked.map(([t]) => t.taskId)).toEqual(["script", "board"]);
    expect(blocked[0]?.[1]).toEqual(["research"]);
  });

  it("unblocks a task only once every parent has succeeded", () => {
    let graph = build();
    graph = graph.withStatus("research", "succeeded");
    expect(graph.ready().map((t) => t.taskId)).toEqual(["script"]);

    graph = graph.withStatus("script", "succeeded");
    expect(graph.ready().map((t) => t.taskId)).toEqual(["board"]);

    graph = graph.withStatus("board", "succeeded");
    expect(graph.ready()).toEqual([]);
    expect(graph.complete().map((t) => t.taskId)).toEqual(["research", "script", "board"]);
    expect(graph.failed()).toEqual([]);
  });

  it("does not unblock a child whose parent failed", () => {
    let graph = build();
    graph = graph.withStatus("research", "failed");

    expect(graph.ready()).toEqual([]);
    // Both dependants are blocked: `script` on a failed parent, and `board` on a parent
    // that has not succeeded. Transitive blockage falls out of the same rule rather than
    // needing its own propagation step.
    const blocked = graph.blocked();
    expect(blocked.map(([t]) => t.taskId)).toEqual(["script", "board"]);
    // A blocked task reports what it is *directly* waiting on, not the whole chain.
    expect(blocked.find(([t]) => t.taskId === "board")?.[1]).toEqual(["script"]);
  });

  it("never mutates: withStatus returns a new graph", () => {
    const graph = build();
    const updated = graph.withStatus("research", "succeeded");
    expect(graph.status("research")).toBe("pending");
    expect(updated.status("research")).toBe("succeeded");
  });

  it("rejects a cyclic plan at construction", () => {
    expect(() =>
      createTaskGraph("loop", [
        task({ taskId: "a", role: "writer", dependsOn: ["b"] }),
        task({ taskId: "b", role: "editor", dependsOn: ["a"] }),
      ]),
    ).toThrowError(/cycle/);
  });

  it("tryCreateTaskGraph returns the failure instead of throwing", () => {
    const result = tryCreateTaskGraph("loop", [
      task({ taskId: "a", role: "writer", dependsOn: ["b"] }),
      task({ taskId: "b", role: "editor", dependsOn: ["a"] }),
    ]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.kind).toBe("cycle");
  });

  it("reports remaining estimated cost, excluding finished work", () => {
    const graph = createTaskGraph("cost", [
      task({ taskId: "a", role: "researcher", estimatedCost: 1 }),
      task({ taskId: "b", role: "writer", estimatedCost: 2, dependsOn: ["a"] }),
    ]);
    expect(graph.remainingEstimatedCost()).toBe(3);
    expect(graph.withStatus("a", "succeeded").remainingEstimatedCost()).toBe(2);
    expect(graph.withStatus("a", "failed").remainingEstimatedCost()).toBe(2);
  });

  it("require() names a task that does not exist", () => {
    expect(() => build().require("nope")).toThrowError(/No task "nope"/);
  });

  it("describeGraph renders deterministically and flags gated tasks", () => {
    const graph = createTaskGraph("a film", [
      task({
        taskId: "design",
        role: "character_designer",
        approval: { mode: "required", reason: "locks identity", gates: ["character_identity_lock"] },
      }),
    ]);
    const text = describeGraph(graph);
    expect(text).toContain("Plan: a film");
    expect(text).toContain("design (character_designer) [approval required]");
    expect(describeGraph(graph)).toBe(text);
  });

  it("finds the descendants a failure invalidates", () => {
    const graph = createTaskGraph("a film", [
      task({ taskId: "a", role: "researcher" }),
      task({ taskId: "b", role: "writer", dependsOn: ["a"] }),
      task({ taskId: "c", role: "animator", dependsOn: ["b"] }),
      task({ taskId: "d", role: "audio_director", dependsOn: ["a"] }),
      task({ taskId: "unrelated", role: "editor" }),
    ]);

    expect(descendantsOf(graph, "a")).toEqual(["b", "c", "d"]);
    expect(descendantsOf(graph, "c")).toEqual([]);
  });
});

describe("totalEstimatedCost", () => {
  it("sums the plan", () => {
    const tasks = [
      task({ taskId: "a", role: "researcher", estimatedCost: 0.01 }),
      task({ taskId: "b", role: "writer", estimatedCost: 0.02 }),
    ];
    expect(totalEstimatedCost(tasks)).toBeCloseTo(0.03, 10);
  });
});