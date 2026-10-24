/**
 * Planner tests.
 *
 * The determinism test is the important one: "same goal → identical plan" is a stated
 * requirement, and it is also the property that makes every other guarantee in this package
 * checkable. A planner that varied between runs could not have its cost predicted, its plan
 * diffed, or its approval reused.
 *
 * The provider-backed planner is exercised entirely through a fake adapter. Nothing here
 * touches a network, and the fake is a real `ProviderAdapter` implementation, so the whole
 * path — model resolution, request validation, schema-constrained parsing, governance — is
 * genuinely covered rather than stubbed.
 */

import { describe, expect, it, vi } from "vitest";

import type {
  CancellationSignal,
  CostEstimate,
  GenerationRequest,
  GenerationResult,
  JobHandle,
  ModelDescriptor,
  NormalisedError,
  ProviderAdapter,
  ProviderCapabilities,
  ProviderCredentials,
  ValidationResult,
} from "@kinema/types";

import {
  analyseGoal,
  extractCharacterNames,
  extractDurationSeconds,
  extractJsonObject,
  MockPlanner,
  ProviderPlanner,
} from "../planner.js";
import { ToolError } from "../tool.js";
import { TOOL } from "../tool-names.js";
import { makeClock } from "./helpers.js";

const GOAL = "Make a 30-second animated short about a lighthouse keeper and a storm";

// ---------------------------------------------------------------------------
// Goal analysis
// ---------------------------------------------------------------------------

describe("analyseGoal", () => {
  it("reads a stated duration and marks the source as stated", () => {
    const analysis = analyseGoal(GOAL);
    expect(analysis.targetDurationSeconds).toBe(30);
    expect(analysis.durationSource).toBe("stated");
  });

  it("defaults to 30 seconds and says so when the goal states no duration", () => {
    const analysis = analyseGoal("Make an animated short about a cat");
    expect(analysis.targetDurationSeconds).toBe(30);
    // Labelled rather than silently applied, so the user can see what was assumed.
    expect(analysis.durationSource).toBe("default");
  });

  it("detects the faceless format from its markers", () => {
    expect(analyseGoal("a faceless voiceover documentary about volcanoes").format).toBe(
      "faceless_video",
    );
    expect(analyseGoal(GOAL).format).toBe("2d_animation");
  });

  it("does not invent a style the goal never named", () => {
    const analysis = analyseGoal("Make a short about a cat");
    expect(analysis.style).toContain("unspecified");
  });

  it("picks up a style the goal does name", () => {
    expect(analyseGoal("a noir animated short about rain").style).toContain("noir");
  });

  it("is deterministic", () => {
    expect(analyseGoal(GOAL)).toEqual(analyseGoal(GOAL));
  });
});

describe("extractDurationSeconds", () => {
  it("reads the several ways a duration is written", () => {
    expect(extractDurationSeconds("a 30-second short")).toBe(30);
    expect(extractDurationSeconds("a 30 second short")).toBe(30);
    expect(extractDurationSeconds("a 45s clip")).toBe(45);
    expect(extractDurationSeconds("about 2 minutes long")).toBe(120);
    expect(extractDurationSeconds("roughly 1.5 minutes")).toBe(90);
    expect(extractDurationSeconds("a 2:30 piece")).toBe(150);
  });

  it("returns null rather than guessing when there is no duration", () => {
    expect(extractDurationSeconds("a short about a cat")).toBeNull();
  });
});

describe("extractCharacterNames", () => {
  it("finds capitalised names in the goal", () => {
    expect(extractCharacterNames("a short about Mira and the Storm")).toEqual(["Mira", "Storm"]);
  });

  it("does not treat ordinary capitalised words as names", () => {
    expect(extractCharacterNames("Make a Short Video")).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// MockPlanner — determinism and shape
// ---------------------------------------------------------------------------

describe("MockPlanner determinism", () => {
  it("produces an IDENTICAL plan for the same goal", async () => {
    const planner = new MockPlanner();
    const context = { now: makeClock(), runId: "run-fixed", goalId: "goal-fixed" };

    const first = await planner.plan(GOAL, context);
    const second = await planner.plan(GOAL, context);

    // Compared as serialised data, because that is what "identical plan" means to a user
    // looking at two runs — not merely the same shape.
    expect(JSON.stringify(second.tasks)).toBe(JSON.stringify(first.tasks));
    expect(second.order).toEqual(first.order);
    expect(second.waves).toEqual(first.waves);
  });

  it("produces identical plans across separate planner instances", async () => {
    const context = { now: makeClock(), runId: "run-fixed", goalId: "goal-fixed" };
    const first = await new MockPlanner().plan(GOAL, context);
    const second = await new MockPlanner().plan(GOAL, context);
    expect(JSON.stringify(second.tasks)).toBe(JSON.stringify(first.tasks));
  });

  it("produces a DIFFERENT plan for a different goal", async () => {
    const planner = new MockPlanner();
    const context = { now: makeClock() };
    const first = await planner.plan(GOAL, context);
    const second = await planner.plan("Make a 90-second animated short about a deep sea dive", context);

    expect(second.tasks.length).not.toBe(first.tasks.length);
    expect(second.order).not.toEqual(first.order);
  });

  it("scales the plan with the requested duration", async () => {
    const planner = new MockPlanner();
    const context = { now: makeClock() };
    const short = await planner.plan("an animated short about a cat, 20 seconds", context);
    const long = await planner.plan("an animated short about a cat, 120 seconds", context);

    expect(long.tasks.length).toBeGreaterThan(short.tasks.length);
    expect(
      long.tasks.reduce((sum, task) => sum + task.cost.estimated, 0),
    ).toBeGreaterThan(short.tasks.reduce((sum, task) => sum + task.cost.estimated, 0));
  });
});

describe("MockPlanner plan shape", () => {
  it("contains every role the brief describes for a short film", async () => {
    const graph = await new MockPlanner().plan(GOAL, { now: makeClock() });
    const roles = new Set(graph.tasks.map((task) => task.role));

    // research → script → character design → storyboard → animation → audio → assembly → QC
    expect(roles).toEqual(
      new Set([
        "researcher",
        "writer",
        "character_designer",
        "storyboard_artist",
        "animator",
        "audio_director",
        "editor",
        "qc_reviewer",
      ]),
    );
  });

  it("wires the dependencies the production actually has", async () => {
    const graph = await new MockPlanner().plan(GOAL, { now: makeClock() });

    const script = graph.require("t02_script");
    expect(script.dependsOn).toEqual(["t01_research"]);

    const characters = graph.require("t03_characters");
    expect(characters.dependsOn).toEqual(["t02_script"]);

    const storyboard = graph.require("t04_storyboard");
    expect(storyboard.dependsOn).toEqual(["t03_characters"]);

    const qc = graph.require("t08_qc");
    expect(qc.dependsOn).toEqual(["t07_assembly"]);

    // Every animator group waits for the board, and assembly waits for all of them.
    const animators = graph.tasks.filter((task) => task.role === "animator");
    expect(animators.length).toBeGreaterThan(0);
    for (const animator of animators) {
      expect(animator.dependsOn).toEqual(["t04_storyboard"]);
    }
    const assembly = graph.require("t07_assembly");
    for (const animator of animators) {
      expect(assembly.dependsOn).toContain(animator.taskId);
    }
  });

  it("is acyclic and resolves to the production order", async () => {
    const graph = await new MockPlanner().plan(GOAL, { now: makeClock() });
    expect(graph.order[0]).toBe("t01_research");
    expect(graph.order.at(-1)).toBe("t08_qc");
    expect(graph.order.indexOf("t02_script")).toBeLessThan(graph.order.indexOf("t04_storyboard"));
  });

  it("gives every task its role's real output schema and allowlist", async () => {
    const graph = await new MockPlanner().plan(GOAL, { now: makeClock() });

    for (const task of graph.tasks) {
      expect(task.allowedTools.length, `${task.taskId} has no tools`).toBeGreaterThan(0);
      expect(task.outputSchema.type, `${task.taskId} output schema`).toBe("object");
      expect(task.goal.length, `${task.taskId} goal`).toBeGreaterThan(20);
      expect(task.timeoutMs).toBeGreaterThan(0);
      expect(task.retry.maxAttempts).toBeGreaterThanOrEqual(1);
    }
  });

  it("only assigns a tool the role is actually permitted to use", async () => {
    const graph = await new MockPlanner().plan(GOAL, { now: makeClock() });
    // The allowlist gate, checked against every task the planner produced.
    for (const task of graph.tasks) {
      if (task.tool === undefined) continue;
      expect(task.allowedTools, `${task.taskId} uses ${task.tool}`).toContain(task.tool);
    }
  });

  it("carries the reference snapshot and character locks into every task", async () => {
    const graph = await new MockPlanner().plan(GOAL, {
      now: makeClock(),
      characterLocks: [
        {
          characterId: "keeper",
          displayName: "The Keeper",
          forbiddenDriftRules: ["must keep the brass lantern"],
          referenceSetIds: ["asset-keeper-01"],
        },
      ],
      styleConstraints: ["hand-drawn linework"],
    });

    for (const task of graph.tasks) {
      expect(task.referenceSnapshot.characterLocks).toHaveLength(1);
      expect(task.referenceSnapshot.styleConstraints).toEqual(["hand-drawn linework"]);
    }
  });

  it("gates character design behind approval, because identity is locked there", async () => {
    const graph = await new MockPlanner().plan(GOAL, { now: makeClock() });
    const design = graph.require("t03_characters");
    expect(design.approval.mode).toBe("required");
    if (design.approval.mode !== "required") return;
    expect(design.approval.gates).toContain("character_identity_lock");
  });
});

// ---------------------------------------------------------------------------
// MockPlanner — budget at plan time
// ---------------------------------------------------------------------------

describe("MockPlanner budget", () => {
  it("refuses to return a plan that cannot fit the cap", async () => {
    const planner = new MockPlanner();

    let thrown: unknown;
    try {
      await planner.plan(GOAL, { now: makeClock(), budgetCap: 0.0001 });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(ToolError);
    expect((thrown as ToolError).code).toBe("budget_exceeded");
    // The message names the most expensive steps, so a user knows what to cut.
    expect((thrown as ToolError).message).toContain("t05_animate");
  });

  it("returns a plan that fits a generous cap", async () => {
    const graph = await new MockPlanner().plan(GOAL, { now: makeClock(), budgetCap: 1_000 });
    expect(graph.tasks.length).toBeGreaterThan(0);
  });

  it("produces a free plan when the cost model is switched off", async () => {
    const graph = await new MockPlanner({ chargeForGeneration: false }).plan(GOAL, { now: makeClock() });
    expect(graph.tasks.every((task) => task.cost.estimated === 0)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// ProviderPlanner — through a fake adapter, no network
// ---------------------------------------------------------------------------

const FAKE_MODEL: ModelDescriptor = {
  id: "fake-planner-model",
  displayName: "Fake Planner",
  providerId: "fake",
  inputs: ["text"],
  outputs: ["text"],
  limits: { maxOutputTokens: 4096 },
  capabilities: {
    supportsStreaming: false,
    supportsToolCalls: false,
    supportsReferenceImage: false,
    supportsSeed: false,
    supportsNegativePrompt: false,
    supportsInpainting: false,
    supportsTransparentBackground: false,
    supportsConversationalEdit: false,
    supportsCancellation: false,
    supportsQualityControl: false,
  },
  pricing: { basis: "free" },
  outputMimeTypes: ["application/json"],
};

const VALID_PLAN = JSON.stringify({
  tasks: [
    {
      taskId: "research",
      role: "researcher",
      goal: "Establish the visual register for the piece.",
      dependsOn: [],
    },
    {
      taskId: "script",
      role: "writer",
      goal: "Write a script of exactly thirty seconds.",
      tool: "write_script",
      dependsOn: ["research"],
    },
    {
      taskId: "review",
      role: "qc_reviewer",
      goal: "Check the script for timing and continuity problems.",
      tool: "qc_check",
      dependsOn: ["script"],
    },
  ],
});

interface FakeAdapterOptions {
  readonly responseText?: string;
  readonly status?: GenerationResult["status"];
  readonly validate?: ValidationResult;
}

function makeFakeAdapter(options: FakeAdapterOptions = {}): ProviderAdapter & {
  readonly submitCalls: GenerationRequest[];
} {
  const submitCalls: GenerationRequest[] = [];

  const adapter: ProviderAdapter & { readonly submitCalls: GenerationRequest[] } = {
    id: "fake",
    displayName: "Fake provider",
    kind: "mock",
    submitCalls,

    async discoverCapabilities(): Promise<ProviderCapabilities> {
      return {
        providerId: "fake",
        kind: "mock",
        supportsStreaming: false,
        supportsAsyncJobs: false,
        supportsCancellation: false,
        requiresNetwork: false,
        isMock: true,
      };
    },

    async listModels(): Promise<readonly ModelDescriptor[]> {
      return [FAKE_MODEL];
    },

    async validateCredentials(): Promise<{ ok: true }> {
      return { ok: true };
    },

    async estimateCost(): Promise<CostEstimate> {
      return { amount: 0, currency: "USD", reliable: true };
    },

    validateRequest(): ValidationResult {
      return options.validate ?? { valid: true, unsupportedFields: [], problems: [] };
    },

    async submitJob(request: GenerationRequest): Promise<JobHandle> {
      submitCalls.push(request);
      return { providerJobId: "job-1", status: "succeeded" };
    },

    async pollOrSubscribe(): Promise<GenerationResult> {
      const status = options.status ?? "succeeded";
      return {
        status,
        outputs: [
          { kind: "text", mimeType: "application/json", text: options.responseText ?? VALID_PLAN },
        ],
        provenance: {
          providerId: "fake",
          modelId: FAKE_MODEL.id,
          prompt: "planning",
          createdAt: "2026-01-01T00:00:00.000Z",
        },
      };
    },

    async cancelJob(): Promise<boolean> {
      return true;
    },

    normaliseResult(raw: unknown): GenerationResult {
      return raw as GenerationResult;
    },

    normaliseError(error: unknown): NormalisedError {
      return {
        code: "provider_unavailable",
        message: error instanceof Error ? error.message : String(error),
        retryable: true,
        userActionRequired: false,
      };
    },
  };

  return adapter;
}

describe("ProviderPlanner", () => {
  it("builds a governed task graph from a model's plan", async () => {
    const adapter = makeFakeAdapter();
    const planner = new ProviderPlanner({ adapter, now: makeClock() });

    const graph = await planner.plan(GOAL, { now: makeClock(), runId: "run-1", goalId: "goal-1" });

    expect(graph.order).toEqual(["research", "script", "review"]);
    expect(graph.require("script").role).toBe("writer");
    expect(graph.require("script").tool).toBe(TOOL.WRITE_SCRIPT);
    // Governance comes from this package, not from the model.
    expect(graph.require("script").outputSchema).toBeDefined();
    expect(graph.require("script").retry.maxAttempts).toBeGreaterThanOrEqual(1);
  });

  it("asks the model for a schema-constrained plan at temperature 0", async () => {
    const adapter = makeFakeAdapter();
    await new ProviderPlanner({ adapter, now: makeClock() }).plan(GOAL, { now: makeClock() });

    const request = adapter.submitCalls[0];
    expect(request).toBeDefined();
    expect(request?.responseSchema).toBeDefined();
    // Temperature 0 is the one determinism knob this layer controls directly.
    expect(request?.temperature).toBe(0);
    // The prompt names the roles and the goal.
    expect(request?.prompt).toContain("writer");
    expect(request?.prompt).toContain(GOAL);
  });

  it("refuses a plan that assigns a tool outside the role's allowlist", async () => {
    const adapter = makeFakeAdapter({
      responseText: JSON.stringify({
        tasks: [
          {
            taskId: "review",
            role: "qc_reviewer",
            goal: "Rewrite the script as you review it.",
            // The reviewer has no write tools, deliberately.
            tool: "write_script",
            dependsOn: [],
          },
        ],
      }),
    });

    let thrown: unknown;
    try {
      await new ProviderPlanner({ adapter, now: makeClock() }).plan(GOAL, { now: makeClock() });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(ToolError);
    expect((thrown as ToolError).code).toBe("tool_not_permitted");
    expect((thrown as ToolError).message).toContain("allowlist");
  });

  it("refuses a plan whose dependencies form a cycle", async () => {
    const adapter = makeFakeAdapter({
      responseText: JSON.stringify({
        tasks: [
          { taskId: "a", role: "writer", goal: "Write the script for the piece.", dependsOn: ["b"] },
          { taskId: "b", role: "editor", goal: "Assemble the timeline for the piece.", dependsOn: ["a"] },
        ],
      }),
    });

    await expect(
      new ProviderPlanner({ adapter, now: makeClock() }).plan(GOAL, { now: makeClock() }),
    ).rejects.toThrowError(/cycle/);
  });

  it("refuses a response that does not satisfy the planner schema", async () => {
    const adapter = makeFakeAdapter({
      responseText: JSON.stringify({ tasks: [{ role: "writer" }] }),
    });

    let thrown: unknown;
    try {
      await new ProviderPlanner({ adapter, now: makeClock() }).plan(GOAL, { now: makeClock() });
    } catch (error) {
      thrown = error;
    }
    expect((thrown as ToolError).code).toBe("precondition_failed");
    expect((thrown as ToolError).message).toContain("did not match the planner schema");
  });

  it("refuses a response that is prose rather than JSON", async () => {
    const adapter = makeFakeAdapter({ responseText: "Sure! Here is a great plan for you." });
    await expect(
      new ProviderPlanner({ adapter, now: makeClock() }).plan(GOAL, { now: makeClock() }),
    ).rejects.toThrowError(/no JSON object/);
  });

  it("refuses an unknown role in the model's plan", async () => {
    const adapter = makeFakeAdapter({
      responseText: JSON.stringify({
        tasks: [{ taskId: "x", role: "showrunner", goal: "Take over the production entirely.", dependsOn: [] }],
      }),
    });
    // Caught by the response schema's enum before it reaches the role lookup.
    await expect(
      new ProviderPlanner({ adapter, now: makeClock() }).plan(GOAL, { now: makeClock() }),
    ).rejects.toThrowError(/did not match the planner schema/);
  });

  it("refuses a request the model cannot honour, rather than silently dropping fields", async () => {
    const adapter = makeFakeAdapter({
      validate: {
        valid: false,
        unsupportedFields: ["responseSchema"],
        problems: ["This model does not accept a response schema."],
      },
    });

    await expect(
      new ProviderPlanner({ adapter, now: makeClock() }).plan(GOAL, { now: makeClock() }),
    ).rejects.toThrowError(/cannot honour this request/);
  });

  it("refuses an empty model response instead of inventing a plan", async () => {
    const adapter = makeFakeAdapter({ responseText: "" });
    await expect(
      new ProviderPlanner({ adapter, now: makeClock() }).plan(GOAL, { now: makeClock() }),
    ).rejects.toThrowError(/no text/);
  });

  it("never makes a network call — the adapter is the only I/O", async () => {
    // A tripwire on the global fetch: if anything in this package reached the network, the
    // provider planner path is where it would happen.
    const fetchSpy = vi.fn(() => {
      throw new Error("network access attempted in an offline test");
    });
    const originalFetch = globalThis.fetch;
    (globalThis as { fetch: unknown }).fetch = fetchSpy;

    try {
      const adapter = makeFakeAdapter();
      const graph = await new ProviderPlanner({ adapter, now: makeClock() }).plan(GOAL, {
        now: makeClock(),
      });
      expect(graph.tasks).toHaveLength(3);
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      (globalThis as { fetch: unknown }).fetch = originalFetch;
    }
  });
});

describe("extractJsonObject", () => {
  it("pulls a JSON object out of surrounding prose", () => {
    expect(extractJsonObject('Here you go:\n{"a":1}\nHope that helps!')).toBe('{"a":1}');
  });

  it("strips a markdown fence", () => {
    expect(extractJsonObject('```json\n{"a":1}\n```')).toBe('{"a":1}');
  });

  it("is not fooled by a brace inside a string", () => {
    expect(extractJsonObject('{"a":"} not the end"}')).toBe('{"a":"} not the end"}');
  });

  it("handles nested objects", () => {
    expect(extractJsonObject('{"a":{"b":{"c":1}}}')).toBe('{"a":{"b":{"c":1}}}');
  });

  it("returns null when there is no object", () => {
    expect(extractJsonObject("no json here")).toBeNull();
  });

  it("returns null for an unbalanced object rather than a truncated one", () => {
    expect(extractJsonObject('{"a":1')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Both planners satisfy the same interface
// ---------------------------------------------------------------------------

describe("Planner implementations are interchangeable", () => {
  it("both expose an id and a plan method producing a TaskGraph", async () => {
    const mock = new MockPlanner();
    const provider = new ProviderPlanner({ adapter: makeFakeAdapter(), now: makeClock() });

    expect(typeof mock.id).toBe("string");
    expect(typeof provider.id).toBe("string");
    expect(provider.id).toContain("fake");

    const mockGraph = await mock.plan(GOAL, { now: makeClock() });
    const providerGraph = await provider.plan(GOAL, { now: makeClock() });

    // Same artifact from both, so nothing downstream can tell which brain built it — which
    // is what stops the governance being bypassed by swapping in a model.
    for (const graph of [mockGraph, providerGraph]) {
      expect(graph.goal).toBe(GOAL);
      expect(graph.order.length).toBe(graph.tasks.length);
      expect(graph.waves.length).toBeGreaterThan(0);
    }
  });
});