/**
 * The tool contract.
 *
 * ── The design decision that matters ─────────────────────────────────────────
 *
 * The spec's approval model depends on the Director knowing, *before dispatch*, which
 * actions require a human's consent. That is why `requiresApproval` is a property of the
 * tool rather than a runtime decision: a tool that can spend money, overwrite approved
 * work, or reach outside the app must be recognisable as such from its declaration
 * alone, by any planner, in any process, without executing it.
 *
 * The second decision: invalid input produces a structured {@link ToolError}, never a
 * thrown string. An agent loop runs unattended for minutes at a time; a raw string throw
 * gives the Director nothing to reason about or repair. Every failure here carries a
 * machine-readable `code`, a JSON Pointer `path`, and whether a bounded retry could
 * plausibly help — the same distinction `NormalisedError.retryable` makes for providers,
 * mirrored so the executor has one rule to follow.
 */

import type { JsonSchema } from "./schema.js";
import { assertSupportedSchema, describeValue, validateAgainstSchema } from "./schema.js";

// ---------------------------------------------------------------------------
// Execution context
// ---------------------------------------------------------------------------

/**
 * What a tool is allowed to know about the run it is part of.
 *
 * Deliberately narrow. A tool receives ids and a clock — not the registry, not the
 * executor, not the provider adapters. A tool that could dispatch further tasks would be
 * able to bypass the budget cap, the approval gate and the audit trail in one line, so
 * the shape of this interface prevents it structurally rather than by convention.
 */
export interface ToolContext {
  /** Unique id for the single invocation, for correlating logs and audit entries. */
  readonly invocationId: string;
  /** The task this invocation belongs to. */
  readonly taskId: string;
  /** The role that requested it, when the call came from a role-bound agent. */
  readonly role?: string;
  readonly projectId?: string;
  /**
   * Read-only view of what earlier tasks produced, keyed by task id.
   *
   * This is how `assembly` sees the `script` without the two being coupled — the
   * executor is the only thing that knows the order.
   */
  readonly artifacts: Readonly<Record<string, unknown>>;
  /**
   * Aborts when the run is cancelled.
   *
   * Structurally typed so this package needs no DOM lib and tests can pass a trivial
   * stub, matching how `@kinema/types` declares `CancellationSignal`.
   */
  readonly signal?: { readonly aborted: boolean };
  /**
   * Clock, injected so tests and replay are deterministic.
   * @returns an ISO-8601 timestamp.
   */
  readonly now: () => string;
  /** Structured progress, for the UI. Never throws; a no-op by default. */
  readonly report?: (message: string, data?: Readonly<Record<string, unknown>>) => void;
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export type ToolErrorCode =
  | "invalid_input"
  | "invalid_output"
  | "unknown_tool"
  | "duplicate_tool"
  | "unknown_role"
  | "tool_not_permitted"
  | "budget_exceeded"
  | "precondition_failed"
  | "cancelled"
  | "timeout"
  | "internal";

/**
 * A structured tool failure.
 *
 * Carries enough for three different consumers at once: the executor decides whether to
 * retry (`retryable`), the UI decides what to say (`message`), and the audit trail
 * records what happened (`code`, `path`).
 */
export class ToolError extends Error {
  readonly code: ToolErrorCode;
  /** JSON Pointer to the offending field, when the failure is about one. */
  readonly path?: string;
  /** Whether an unchanged retry could plausibly succeed. Defaults to false. */
  readonly retryable: boolean;
  /**
   * Whether the *user* must change something before retrying.
   * Mirrors `NormalisedError.userActionRequired` so the two taxonomies agree.
   */
  readonly userActionRequired: boolean;
  readonly toolName?: string;
  readonly detail?: string;
  readonly issues?: readonly string[];

  constructor(
    code: ToolErrorCode,
    message: string,
    options: {
      path?: string;
      retryable?: boolean;
      userActionRequired?: boolean;
      toolName?: string;
      detail?: string;
      issues?: readonly string[];
      cause?: unknown;
    } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "ToolError";
    this.code = code;
    this.retryable = options.retryable ?? false;
    this.userActionRequired = options.userActionRequired ?? false;
    if (options.path !== undefined) this.path = options.path;
    if (options.toolName !== undefined) this.toolName = options.toolName;
    if (options.detail !== undefined) this.detail = options.detail;
    if (options.issues !== undefined) this.issues = options.issues;
  }

  /**
   * A flat, JSON-serialisable form for logs and audit entries.
   *
   * `detail` is included because this stays inside the app; it is not the shape sent to
   * an end user. See SECURITY.md — never put credentials in `detail`.
   */
  toJSON(): {
    code: ToolErrorCode;
    message: string;
    path?: string;
    retryable: boolean;
    userActionRequired: boolean;
    toolName?: string;
    detail?: string;
  } {
    const base = {
      code: this.code,
      message: this.message,
      retryable: this.retryable,
      userActionRequired: this.userActionRequired,
    };
    return {
      ...base,
      ...(this.path !== undefined ? { path: this.path } : {}),
      ...(this.toolName !== undefined ? { toolName: this.toolName } : {}),
      ...(this.detail !== undefined ? { detail: this.detail } : {}),
    };
  }
}

/** Narrow an unknown thrown value to a ToolError, wrapping anything else. */
export function asToolError(error: unknown, toolName?: string): ToolError {
  if (error instanceof ToolError) return error;
  const message = error instanceof Error ? error.message : String(error);
  return new ToolError("internal", message, {
    retryable: false,
    userActionRequired: false,
    ...(toolName !== undefined ? { toolName } : {}),
    cause: error,
  });
}

// ---------------------------------------------------------------------------
// Tool definition
// ---------------------------------------------------------------------------

/**
 * A single capability an agent may invoke.
 *
 * `run` returns `unknown` rather than a generic because tools are heterogeneous and the
 * executor only ever passes the result onward as an artifact. The *contract* is the
 * pair of schemas: input is validated before `run`, output is validated after it. Both
 * are enforced by the registry, so a tool that lies about its output shape is caught at
 * the boundary rather than corrupting a downstream task.
 */
export interface Tool<TInput = unknown, TOutput = unknown> {
  /** Stable, unique, snake_case identifier used in plans and audit records. */
  readonly name: string;
  /** One sentence for a model to decide whether this tool is relevant. */
  readonly description: string;
  /** JSON Schema for the input. Validated before `run`. */
  readonly inputSchema: JsonSchema;
  /** JSON Schema for the output. Validated after `run`. */
  readonly outputSchema: JsonSchema;
  /**
   * Whether a human must consent before this tool runs.
   *
   * True for anything that spends money, publishes, overwrites approved work, or acts
   * outside the application. The executor refuses to dispatch an approval-gated task
   * without an explicit approval record.
   */
  readonly requiresApproval: boolean;
  /**
   * Nominal cost in the project's accounting unit, before the call.
   *
   * A declaration, not a promise: it is what lets the executor refuse dispatch when the
   * cumulative estimate would cross a cap. Tools whose cost depends on their input
   * should implement `estimateCost`.
   */
  readonly estimatedCost: number;
  /**
   * Input-dependent cost, when the flat `estimatedCost` is not good enough.
   * Falls back to `estimatedCost` when absent.
   */
  readonly estimateCost?: (input: TInput) => number;
  /**
   * True when the tool touches the filesystem, the network, or bespoke hardware.
   * Used to explain *why* an approval is needed, and to gate tools behind safe mode.
   */
  readonly sideEffecting: boolean;
  readonly run: (input: TInput, ctx: ToolContext) => Promise<TOutput> | TOutput;
}

// ---------------------------------------------------------------------------
// Invocation results
// ---------------------------------------------------------------------------

export interface ToolInvocationSuccess {
  readonly ok: true;
  readonly tool: string;
  readonly output: unknown;
  /** Cost actually attributed to this invocation. */
  readonly cost: number;
  readonly durationMs: number;
}

export interface ToolInvocationFailure {
  readonly ok: false;
  readonly tool: string;
  readonly error: ToolError;
  readonly durationMs: number;
}

export type ToolInvocationResult = ToolInvocationSuccess | ToolInvocationFailure;

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

/**
 * Where every tool an agent may use lives.
 *
 * Registration validates each schema once, up front, so that a broken schema fails on
 * the developer's machine rather than in front of a user. Invocation validates twice —
 * input before `run`, output after — because both boundaries are places where a plan or
 * a tool can be wrong, and neither is safe to assume.
 */
export class ToolRegistry {
  readonly #tools = new Map<string, Tool<never, unknown>>();

  /**
   * Add a tool.
   *
   * @throws ToolError `duplicate_tool` if the name is taken — silently replacing a tool
   *   would change what an existing plan does, which is unacceptable for a system whose
   *   audit trail is meant to be reproducible.
   * @throws SchemaDefinitionError if either schema uses unsupported keywords.
   */
  register<TInput, TOutput>(tool: Tool<TInput, TOutput>): this {
    if (!/^[a-z][a-z0-9_]*$/.test(tool.name)) {
      throw new ToolError(
        "invalid_input",
        `Tool name "${tool.name}" is not valid. Use lower snake_case starting with a letter.`,
        { toolName: tool.name, userActionRequired: false },
      );
    }
    if (this.#tools.has(tool.name)) {
      throw new ToolError(
        "duplicate_tool",
        `A tool named "${tool.name}" is already registered. Tool names must be unique.`,
        { toolName: tool.name },
      );
    }
    if (!tool.description || tool.description.trim().length === 0) {
      throw new ToolError(
        "invalid_input",
        `Tool "${tool.name}" has no description. A model cannot choose a tool it cannot read.`,
        { toolName: tool.name },
      );
    }
    if (!Number.isFinite(tool.estimatedCost) || tool.estimatedCost < 0) {
      throw new ToolError(
        "invalid_input",
        `Tool "${tool.name}" declares an invalid estimatedCost (${String(tool.estimatedCost)}).`,
        { toolName: tool.name },
      );
    }

    assertSupportedSchema(tool.inputSchema, `${tool.name}.inputSchema`);
    assertSupportedSchema(tool.outputSchema, `${tool.name}.outputSchema`);

    this.#tools.set(tool.name, tool as unknown as Tool<never, unknown>);
    return this;
  }

  /** Register several tools in one call. */
  registerAll(tools: readonly Tool<never, unknown>[]): this {
    for (const tool of tools) this.register(tool);
    return this;
  }

  has(name: string): boolean {
    return this.#tools.has(name);
  }

  /**
   * Look up a tool.
   * @throws ToolError `unknown_tool`, listing what *is* available — an agent that asked
   *   for a tool that does not exist can often recover if it is told the real names.
   */
  require(name: string): Tool<never, unknown> {
    const tool = this.#tools.get(name);
    if (!tool) {
      throw new ToolError(
        "unknown_tool",
        `No tool named "${name}" is registered. Available tools: ${this.list().map((t) => t.name).join(", ") || "(none)"}.`,
        { toolName: name, userActionRequired: false },
      );
    }
    return tool;
  }

  get(name: string): Tool<never, unknown> | undefined {
    return this.#tools.get(name);
  }

  /** All tools, in registration order — deliberately stable so listings are diffable. */
  list(): readonly Tool<never, unknown>[] {
    return [...this.#tools.values()];
  }

  /** Names only, in registration order. */
  names(): readonly string[] {
    return this.list().map((tool) => tool.name);
  }

  /** Tools that require human consent before dispatch. */
  listApprovalGated(): readonly Tool<never, unknown>[] {
    return this.list().filter((tool) => tool.requiresApproval);
  }

  /**
   * The subset of this registry named by `names`.
   * @throws ToolError `unknown_tool` for any name that is not registered.
   */
  subset(names: readonly string[]): ToolRegistry {
    const registry = new ToolRegistry();
    for (const name of names) registry.register(this.require(name) as Tool<never, unknown>);
    return registry;
  }

  /** Cost estimate for a tool call, honouring an input-dependent `estimateCost`. */
  estimateCost(name: string, input: unknown): number {
    const tool = this.require(name);
    if (tool.estimateCost) {
      const estimate = tool.estimateCost(input as never);
      if (!Number.isFinite(estimate) || estimate < 0) {
        throw new ToolError(
          "invalid_input",
          `Tool "${name}" returned an invalid cost estimate (${String(estimate)}).`,
          { toolName: name },
        );
      }
      return estimate;
    }
    return tool.estimatedCost;
  }

  /**
   * Validate input without running anything.
   *
   * Used by the executor and the planner to reject a bad plan before any cost is
   * incurred, and by the UI to explain a problem before the user commits.
   */
  validateInput(name: string, input: unknown): ToolInvocationResult | undefined {
    const tool = this.require(name);
    const started = Date.now();
    const outcome = validateAgainstSchema(input, tool.inputSchema, `${name}.inputSchema`);
    if (outcome.valid) return undefined;
    return {
      ok: false,
      tool: name,
      durationMs: Date.now() - started,
      error: new ToolError(
        "invalid_input",
        `Input for tool "${name}" is invalid: ` +
          outcome.issues.map((i) => `${i.path || "/"} ${i.message}`).join(" "),
        {
          toolName: name,
          userActionRequired: false,
          retryable: false,
          issues: outcome.issues.map((i) => `${i.path || "/"}: ${i.message}`),
          detail: JSON.stringify(outcome.issues),
        },
      ),
    };
  }

  /**
   * Invoke a tool by name, with input and output validation.
   *
   * Returns a result rather than throwing, so an agent loop can reason about a failure
   * instead of unwinding. The only thing this method throws is a genuinely broken
   * registry call (an unknown tool), because that is a caller bug, not a run outcome —
   * and callers that want a result for that case use {@link tryInvoke}.
   */
  async invoke(
    name: string,
    input: unknown,
    ctx: ToolContext,
  ): Promise<ToolInvocationResult> {
    const tool = this.require(name);
    const started = Date.now();

    if (ctx.signal?.aborted === true) {
      return {
        ok: false,
        tool: name,
        durationMs: Date.now() - started,
        error: new ToolError("cancelled", `Tool "${name}" was not run because the task was cancelled.`, {
          toolName: name,
        }),
      };
    }

    const invalid = this.validateInput(name, input);
    if (invalid) return invalid;

    let output: unknown;
    try {
      output = await tool.run(input as never, ctx);
    } catch (error) {
      const toolError = asToolError(error, name);
      return { ok: false, tool: name, durationMs: Date.now() - started, error: toolError };
    }

    const outcome = validateAgainstSchema(output, tool.outputSchema, `${name}.outputSchema`);
    if (!outcome.valid) {
      // A tool that misdeclares its output is a bug in this codebase, not a bad plan.
      // Surfacing it as a failure is what stops the corruption travelling downstream.
      return {
        ok: false,
        tool: name,
        durationMs: Date.now() - started,
        error: new ToolError(
          "invalid_output",
          `Tool "${name}" produced output that does not match its declared schema: ` +
            outcome.issues.map((i) => `${i.path || "/"} ${i.message}`).join(" "),
          {
            toolName: name,
            userActionRequired: false,
            issues: outcome.issues.map((i) => `${i.path || "/"}: ${i.message}`),
            detail: `output was ${describeValue(output, 120)}`,
          },
        ),
      };
    }

    const cost = tool.estimateCost
      ? tool.estimateCost(input as never)
      : tool.estimatedCost;

    return {
      ok: true,
      tool: name,
      output,
      cost: Number.isFinite(cost) && cost >= 0 ? cost : 0,
      durationMs: Date.now() - started,
    };
  }

  /**
   * Like {@link invoke}, but also turns an unknown tool into a failure result.
   *
   * This is the form agent code should use: an LLM-backed planner proposes a tool name
   * from a catalogue it was given, and "the model invented a tool" is an expected,
   * recoverable outcome rather than a crash.
   */
  async tryInvoke(
    name: string,
    input: unknown,
    ctx: ToolContext,
  ): Promise<ToolInvocationResult> {
    if (!this.has(name)) {
      return {
        ok: false,
        tool: name,
        durationMs: 0,
        error: new ToolError(
          "unknown_tool",
          `No tool named "${name}" is registered. Available tools: ${this.names().join(", ") || "(none)"}.`,
          { toolName: name },
        ),
      };
    }
    return this.invoke(name, input, ctx);
  }
}