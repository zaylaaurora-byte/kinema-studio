/**
 * Tool contract tests.
 *
 * These assert the behaviours the Director depends on to be trustworthy: that invalid input
 * is refused with something a caller can act on rather than a thrown string, that a role
 * cannot exceed its allowlist, and that a tool which lies about its own output shape is
 * caught at the boundary rather than corrupting a downstream task.
 */

import { describe, expect, it, vi } from "vitest";

import {
  assertToolPermitted,
  isToolPermitted,
  rolesPermittedToUse,
  ROLES,
  toolsUsedByRoles,
} from "../roles.js";
import { validateAgainstSchema } from "../schema.js";
import { asToolError, ToolError, ToolRegistry, type Tool, type ToolContext } from "../tool.js";
import { TOOL } from "../tool-names.js";
import { makeContext } from "./helpers.js";

// ---------------------------------------------------------------------------
// A fixture tool, defined exactly as a real one is
// ---------------------------------------------------------------------------

interface EchoInput {
  readonly message: string;
  readonly repeat?: number;
}

interface EchoOutput {
  readonly echoed: string;
  readonly repeats: number;
}

const echoTool: Tool<EchoInput, EchoOutput> = {
  name: "echo",
  description: "Echo a message a number of times. Used only in tests.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["message"],
    properties: {
      message: { type: "string", minLength: 1, maxLength: 100 },
      repeat: { type: "integer", minimum: 1, maximum: 10 },
    },
  },
  outputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["echoed", "repeats"],
    properties: {
      echoed: { type: "string", minLength: 1 },
      repeats: { type: "integer", minimum: 1 },
    },
  },
  requiresApproval: false,
  estimatedCost: 0,
  sideEffecting: false,
  run: (input) => {
    const repeat = input.repeat ?? 1;
    return { echoed: input.message.repeat(repeat), repeats: repeat };
  },
};

function buildRegistry(): ToolRegistry {
  return new ToolRegistry().register(echoTool);
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

describe("ToolRegistry registration", () => {
  it("lists registered tools in a stable order", () => {
    const registry = buildRegistry().register({ ...echoTool, name: "second_tool" });
    expect(registry.names()).toEqual(["echo", "second_tool"]);
  });

  it("refuses a duplicate tool name instead of replacing the first", () => {
    const registry = buildRegistry();
    // Silently replacing would change what an already-approved plan does.
    expect(() => registry.register(echoTool)).toThrowError(ToolError);
    expect(() => registry.register(echoTool)).toThrowError(/already registered/);
  });

  it("refuses a name that is not lower snake_case", () => {
    expect(() => buildRegistry().register({ ...echoTool, name: "Echo-Tool" })).toThrowError(
      /not valid/,
    );
  });

  it("refuses a tool with no description, because a model cannot choose what it cannot read", () => {
    expect(() => buildRegistry().register({ ...echoTool, name: "silent", description: "  " })).toThrowError(
      /no description/,
    );
  });

  it("refuses a schema using a keyword the validator cannot honour", () => {
    // A quietly-ignored keyword would make every "the input was validated" claim false.
    expect(() =>
      buildRegistry().register({
        ...echoTool,
        name: "exotic",
        inputSchema: { type: "object", if: { type: "object" } },
      }),
    ).toThrowError(/unsupported keyword "if"/);
  });

  it("refuses a negative cost declaration", () => {
    expect(() => buildRegistry().register({ ...echoTool, name: "negative", estimatedCost: -1 })).toThrowError(
      /invalid estimatedCost/,
    );
  });
});

// ---------------------------------------------------------------------------
// Unknown tools
// ---------------------------------------------------------------------------

describe("ToolRegistry unknown tools", () => {
  it("rejects an unknown tool by name and lists what is available", async () => {
    const registry = buildRegistry();
    const result = await registry.tryInvoke("no_such_tool", {}, makeContext());

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("unknown_tool");
    expect(result.error.message).toContain("no_such_tool");
    expect(result.error.message).toContain("echo");
  });

  it("require() throws for an unknown tool", () => {
    expect(() => buildRegistry().require("ghost")).toThrowError(ToolError);
  });
});

// ---------------------------------------------------------------------------
// Input validation
// ---------------------------------------------------------------------------

describe("ToolRegistry input validation", () => {
  it("rejects invalid input with a structured error, not a thrown string", async () => {
    const registry = buildRegistry();
    const result = await registry.invoke("echo", { repeat: 3 }, makeContext());

    // `invoke` returns rather than throws, so an agent loop can reason about the failure.
    expect(result.ok).toBe(false);
    if (result.ok) return;

    expect(result.error).toBeInstanceOf(ToolError);
    expect(result.error.code).toBe("invalid_input");
    // The first issue is located with a JSON Pointer, so a UI can highlight the field.
    expect(result.error.issues?.[0]).toContain("/");
    // The message names the offending field and what was expected.
    expect(result.error.message).toContain("message");
    expect(result.error.issues).toBeDefined();
  });

  it("reports the JSON Pointer of the offending field", async () => {
    const registry = buildRegistry();
    const result = await registry.invoke("echo", { message: "hi", repeat: "three" }, makeContext());

    expect(result.ok).toBe(false);
    if (result.ok) return;
    const issue = result.error.issues?.find((entry) => entry.includes("/repeat"));
    expect(issue).toBeDefined();
    expect(issue).toContain("integer");
  });

  it("does NOT run the tool when input is invalid", async () => {
    const run = vi.fn(echoTool.run);
    const registry = new ToolRegistry().register({ ...echoTool, run });

    await registry.invoke("echo", { message: "" }, makeContext());

    expect(run).not.toHaveBeenCalled();
  });

  it("rejects an unknown property when additionalProperties is false", async () => {
    const registry = buildRegistry();
    const result = await registry.invoke("echo", { message: "hi", extra: 1 }, makeContext());

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toContain("extra");
    expect(result.error.message).toContain("unknown property");
  });

  it("accepts valid input and returns the tool's output with its cost", async () => {
    const registry = buildRegistry();
    const result = await registry.invoke("echo", { message: "ab", repeat: 2 }, makeContext());

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.output).toEqual({ echoed: "abab", repeats: 2 });
    expect(result.cost).toBe(0);
  });

  it("validateInput checks without running anything", () => {
    const run = vi.fn(echoTool.run);
    const registry = new ToolRegistry().register({ ...echoTool, run });

    expect(registry.validateInput("echo", { message: "ok" })).toBeUndefined();
    expect(registry.validateInput("echo", { message: 7 })).toBeDefined();
    expect(run).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Output validation
// ---------------------------------------------------------------------------

describe("ToolRegistry output validation", () => {
  it("catches a tool that produces output contradicting its own declared schema", async () => {
    const registry = new ToolRegistry().register({
      ...echoTool,
      name: "liar",
      // Declares `repeats` as an integer, then returns a string. Better caught here than
      // corrupting whatever downstream task consumed it.
      run: () => ({ echoed: "x", repeats: "many" }),
    });

    const result = await registry.invoke("liar", { message: "x" }, makeContext());

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("invalid_output");
    expect(result.error.message).toContain("liar");
  });
});

// ---------------------------------------------------------------------------
// Thrown values inside a tool
// ---------------------------------------------------------------------------

describe("ToolRegistry error normalisation", () => {
  it("wraps a thrown non-ToolError rather than letting it escape", async () => {
    const registry = new ToolRegistry().register({
      ...echoTool,
      name: "thrower",
      run: () => {
        throw new Error("disk on fire");
      },
    });

    const result = await registry.invoke("thrower", { message: "x" }, makeContext());

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("internal");
    expect(result.error.message).toBe("disk on fire");
    expect(result.error.retryable).toBe(false);
  });

  it("preserves a ToolError thrown inside a tool", async () => {
    const registry = new ToolRegistry().register({
      ...echoTool,
      name: "quota_tool",
      run: () => {
        throw new ToolError("budget_exceeded", "quota exhausted", {
          retryable: false,
          userActionRequired: true,
        });
      },
    });

    const result = await registry.invoke("quota_tool", { message: "x" }, makeContext());

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("budget_exceeded");
    expect(result.error.retryable).toBe(false);
    expect(result.error.userActionRequired).toBe(true);
  });

  it("asToolError keeps a ToolError intact and wraps anything else", () => {
    const original = new ToolError("timeout", "too slow", { retryable: true });
    expect(asToolError(original)).toBe(original);

    const wrapped = asToolError(new RangeError("bad range"), "some_tool");
    expect(wrapped.code).toBe("internal");
    expect(wrapped.toolName).toBe("some_tool");
  });
});

// ---------------------------------------------------------------------------
// Approval flag
// ---------------------------------------------------------------------------

describe("tool approval flags", () => {
  it("puts approval-gated tools in their own list", () => {
    const registry = buildRegistry().register({
      ...echoTool,
      name: "spender",
      requiresApproval: true,
      sideEffecting: true,
      estimatedCost: 4.2,
      estimateCost: (input) => (input.repeat ?? 1) * 1.05,
    });

    expect(registry.listApprovalGated().map((tool) => tool.name)).toEqual(["spender"]);
    // The flat declaration is what a planner reads before dispatch.
    expect(registry.require("spender").requiresApproval).toBe(true);
    // The input-dependent estimate is what the budget gate reads.
    expect(registry.estimateCost("spender", { message: "x", repeat: 2 })).toBeCloseTo(2.1, 6);
  });

  it("falls back to the flat estimate when a tool has no estimateCost", () => {
    const registry = new ToolRegistry().register({ ...echoTool, name: "flat", estimatedCost: 3 });
    expect(registry.estimateCost("flat", {})).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// Role allowlists — the spec's "Agent tool allowlists", enforced
// ---------------------------------------------------------------------------

describe("role tool allowlists", () => {
  it("permits a tool on the role's list", () => {
    expect(isToolPermitted("writer", TOOL.WRITE_SCRIPT)).toBe(true);
    expect(() => assertToolPermitted("writer", TOOL.WRITE_SCRIPT)).not.toThrow();
  });

  it("refuses a tool outside the role's list, with a clear reason", () => {
    // A QC reviewer with the pen cannot be trusted to report on what it reviews.
    expect(isToolPermitted("qc_reviewer", TOOL.WRITE_SCRIPT)).toBe(false);

    let thrown: unknown;
    try {
      assertToolPermitted("qc_reviewer", TOOL.WRITE_SCRIPT);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(ToolError);
    const error = thrown as ToolError;
    expect(error.code).toBe("tool_not_permitted");
    expect(error.message).toContain("qc_reviewer");
    expect(error.message).toContain(TOOL.WRITE_SCRIPT);
    // The message names what the role *may* do, so the Director can re-plan.
    expect(error.message).toContain(TOOL.QC_CHECK);
  });

  it("refuses an unknown role", () => {
    expect(() => assertToolPermitted("showrunner", TOOL.READ_SCRIPT)).toThrowError(/not a known role/);
  });

  it("reports which roles may use a tool", () => {
    const roles = rolesPermittedToUse(TOOL.READ_SCRIPT);
    expect(roles).toContain("writer");
    expect(roles).toContain("qc_reviewer");
    // The editor reads the script; it does not write one.
    expect(roles).toContain("editor");
    expect(rolesPermittedToUse(TOOL.WRITE_SCRIPT)).toEqual(["writer"]);
  });

  it("gives the reviewer no write tools at all", () => {
    const reviewer = ROLES.qc_reviewer;
    const writeTools = reviewer.allowedTools.filter((tool) => tool.startsWith("write_"));
    expect(writeTools).toEqual([]);
  });

  it("defines all eight roles named in the spec", () => {
    expect(Object.keys(ROLES).sort()).toEqual([
      "animator",
      "audio_director",
      "character_designer",
      "editor",
      "qc_reviewer",
      "researcher",
      "storyboard_artist",
      "writer",
    ]);
  });

  it("gives every role at least one allowed tool and a real output schema", () => {
    for (const role of Object.values(ROLES)) {
      expect(role.allowedTools.length, `${role.name} has no tools`).toBeGreaterThan(0);
      expect(role.responsibility.length, `${role.name} has no responsibility`).toBeGreaterThan(20);
      expect(role.outputSchema.type, `${role.name} output schema has no type`).toBe("object");
    }
  });

  it("covers every tool with at least one role that may use it", () => {
    const used = new Set(toolsUsedByRoles());
    for (const tool of Object.values(TOOL)) {
      expect(used.has(tool), `${tool} is reachable by no role`).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// Cancellation at the tool boundary
// ---------------------------------------------------------------------------

describe("ToolRegistry cancellation", () => {
  it("does not run a tool when the context signal is already aborted", async () => {
    const run = vi.fn(echoTool.run);
    const registry = new ToolRegistry().register({ ...echoTool, run });

    const result = await registry.invoke("echo", { message: "x" }, makeContext({ aborted: true }));

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("cancelled");
    expect(run).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Schema validator, used directly
// ---------------------------------------------------------------------------

describe("schema validator", () => {
  it("validates a nested structure and locates the failure precisely", () => {
    const outcome = validateAgainstSchema(
      { scenes: [{ id: "a", durationSeconds: 3 }, { id: "b", durationSeconds: -1 }] },
      {
        type: "object",
        required: ["scenes"],
        properties: {
          scenes: {
            type: "array",
            items: {
              type: "object",
              required: ["id", "durationSeconds"],
              properties: {
                id: { type: "string" },
                durationSeconds: { type: "number", exclusiveMinimum: 0 },
              },
            },
          },
        },
      },
    );

    expect(outcome.valid).toBe(false);
    if (outcome.valid) return;
    expect(outcome.issues).toHaveLength(1);
    expect(outcome.issues[0]?.path).toBe("/scenes/1/durationSeconds");
  });

  it("counts string length in code points, so emoji-heavy text is not wrongly rejected", () => {
    const schema = { type: "string", maxLength: 3 } as const;
    expect(validateAgainstSchema("🎬🎬🎬", schema).valid).toBe(true);
    expect(validateAgainstSchema("🎬🎬🎬🎬", schema).valid).toBe(false);
  });

  it("rejects NaN and Infinity as numbers", () => {
    expect(validateAgainstSchema(Number.NaN, { type: "number" }).valid).toBe(false);
    expect(validateAgainstSchema(Number.POSITIVE_INFINITY, { type: "number" }).valid).toBe(false);
  });

  it("distinguishes integer from number", () => {
    expect(validateAgainstSchema(2, { type: "integer" }).valid).toBe(true);
    expect(validateAgainstSchema(2.5, { type: "integer" }).valid).toBe(false);
  });

  it("uses oneOf to reject an ambiguous value", () => {
    const schema = {
      oneOf: [
        { type: "object", required: ["a"], properties: { a: { type: "string" } } },
        { type: "object", required: ["b"], properties: { b: { type: "string" } } },
      ],
    } as const;
    expect(validateAgainstSchema({ a: "x" }, schema).valid).toBe(true);
    expect(validateAgainstSchema({ a: "x", b: "y" }, schema).valid).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Context plumbing
// ---------------------------------------------------------------------------

describe("ToolContext", () => {
  it("gives a tool no way to dispatch further work", async () => {
    let seen: ToolContext | undefined;
    const registry = new ToolRegistry().register({
      ...echoTool,
      name: "spy",
      run: (_input, ctx) => {
        seen = ctx;
        return { echoed: "ok", repeats: 1 };
      },
    });

    await registry.invoke(
      "spy",
      { message: "x" },
      makeContext({ role: "writer", artifacts: { t1: { done: true } } }),
    );

    expect(seen).toBeDefined();
    // Only ids, artifacts and a clock — deliberately no registry, no executor, no adapter.
    // A tool that could dispatch would bypass the budget cap and the approval gate.
    expect(Object.keys(seen ?? {}).sort()).toEqual(
      ["artifacts", "invocationId", "now", "role", "taskId"].sort(),
    );
    expect(seen?.role).toBe("writer");
    expect(seen?.artifacts["t1"]).toEqual({ done: true });
  });
});