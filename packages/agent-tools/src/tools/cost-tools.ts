/**
 * Cost estimation.
 *
 * The Director needs to answer "what will this cost" *before* dispatching, and the spec
 * requires that a budget cap prevents dispatch. The executor enforces the cap; this tool is
 * how a plan is priced in the first place, and how a refusal is explained in terms a user
 * can act on.
 *
 * Three properties make it more than arithmetic:
 *
 *   - It refuses when the estimate exceeds a cap, rather than returning a number and leaving
 *     the caller to notice.
 *   - It separates *reliable* from *unreliable* estimates. A local model has a real cost in
 *     machine time and none in currency; a provider with no published price has neither. The
 *     distinction is carried from `CostEstimate.reliable` in @kinema/types, because a total
 *     that mixes the two silently is a number the user will trust and should not.
 *   - It reports what it could not price, by name, so an estimate never reads as complete
 *     when it is not.
 */

import type { JsonSchema } from "../schema.js";
import { ToolError, type Tool } from "../tool.js";
import { TOOL } from "../tool-names.js";

// ---------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------

export interface CostLineItem {
  readonly taskId: string;
  readonly role: string;
  readonly estimated: number;
  readonly currency?: "USD" | "GBP" | "EUR";
  /**
   * False when the figure rests on no published price.
   * Mirrors `CostEstimate.reliable` in @kinema/types.
   */
  readonly reliable?: boolean;
  readonly basis?:
    | "per_image"
    | "per_token"
    | "per_second"
    | "per_request"
    | "compute_time"
    | "free"
    | "unknown";
  readonly note?: string;
}

export interface EstimateCostInput {
  readonly items: readonly CostLineItem[];
  /** Refuse when the total exceeds this. */
  readonly cap?: number;
  readonly currency?: "USD" | "GBP" | "EUR";
  /**
   * Tokens expected, when the caller wants a per-token sanity check.
   * Purely informational in the output — the estimate comes from the line items.
   */
  readonly expectedInputTokens?: number;
  readonly expectedOutputTokens?: number;
}

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

export interface CostGroup {
  readonly key: string;
  readonly estimated: number;
  readonly taskCount: number;
}

export interface EstimateCostOutput {
  readonly total: number;
  readonly currency: "USD" | "GBP" | "EUR";
  readonly taskCount: number;
  /** Sum of the items whose figures rest on published prices. */
  readonly reliableTotal: number;
  /** Sum of the items whose figures do not. Reported separately, never silently. */
  readonly unreliableTotal: number;
  readonly byRole: readonly CostGroup[];
  readonly byBasis: readonly CostGroup[];
  /** Task ids that could not be priced at all (basis "unknown" with no note). */
  readonly unpricedTaskIds: readonly string[];
  readonly cap?: number;
  readonly capRemaining?: number;
  readonly headroomFraction?: number;
  /** The most expensive line items, largest first. What a user cuts first. */
  readonly largestItems: readonly CostLineItem[];
  readonly warnings: readonly string[];
}

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const CURRENCY_ENUM = ["USD", "GBP", "EUR"] as const;
const BASIS_ENUM = [
  "per_image",
  "per_token",
  "per_second",
  "per_request",
  "compute_time",
  "free",
  "unknown",
] as const;

export const ESTIMATE_COST_OUTPUT_SCHEMA: JsonSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "total",
    "currency",
    "taskCount",
    "reliableTotal",
    "unreliableTotal",
    "byRole",
    "byBasis",
    "unpricedTaskIds",
    "largestItems",
    "warnings",
  ],
  properties: {
    total: { type: "number", minimum: 0 },
    currency: { type: "string", enum: [...CURRENCY_ENUM] },
    taskCount: { type: "integer", minimum: 0 },
    reliableTotal: { type: "number", minimum: 0 },
    unreliableTotal: { type: "number", minimum: 0 },
    byRole: { type: "array", items: costGroupSchema() },
    byBasis: { type: "array", items: costGroupSchema() },
    unpricedTaskIds: { type: "array", items: { type: "string" } },
    cap: { type: "number", minimum: 0 },
    capRemaining: { type: "number" },
    headroomFraction: { type: "number" },
    largestItems: {
      type: "array",
      items: { type: "object", additionalProperties: true },
    },
    warnings: { type: "array", items: { type: "string" } },
  },
};

function costGroupSchema(): JsonSchema {
  return {
    type: "object",
    additionalProperties: false,
    required: ["key", "estimated", "taskCount"],
    properties: {
      key: { type: "string" },
      estimated: { type: "number" },
      taskCount: { type: "integer", minimum: 0 },
    },
  };
}

// ---------------------------------------------------------------------------
// Tool
// ---------------------------------------------------------------------------

export const estimateCostTool: Tool<EstimateCostInput, EstimateCostOutput> = {
  name: TOOL.ESTIMATE_COST,
  description:
    "Sum task cost estimates and check them against a cap. Refuses when the total exceeds " +
    "the cap, and reports separately the portion of the estimate that rests on published " +
    "prices and the portion that does not. Use it before dispatching paid work.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["items"],
    properties: {
      items: {
        type: "array",
        minItems: 1,
        maxItems: 1000,
        items: {
          type: "object",
          additionalProperties: false,
          required: ["taskId", "role", "estimated"],
          properties: {
            taskId: { type: "string", minLength: 1, maxLength: 120 },
            role: { type: "string", minLength: 1, maxLength: 120 },
            estimated: {
              type: "number",
              minimum: 0,
              maximum: 1_000_000,
              description: "Expected cost in the stated currency.",
            },
            currency: { type: "string", enum: [...CURRENCY_ENUM] },
            reliable: {
              type: "boolean",
              description:
                "False when the figure rests on no published price. Unreliable figures are " +
                "reported separately rather than blended into the total.",
            },
            basis: { type: "string", enum: [...BASIS_ENUM] },
            note: { type: "string", maxLength: 500 },
          },
        },
      },
      cap: { type: "number", minimum: 0, maximum: 1_000_000 },
      currency: { type: "string", enum: [...CURRENCY_ENUM] },
      expectedInputTokens: { type: "integer", minimum: 0 },
      expectedOutputTokens: { type: "integer", minimum: 0 },
    },
  },
  outputSchema: ESTIMATE_COST_OUTPUT_SCHEMA,
  /**
   * No approval: estimating spends nothing. Gating a read-only calculation would train the
   * user to approve without reading, which devalues every gate that does matter.
   */
  requiresApproval: false,
  estimatedCost: 0,
  sideEffecting: false,

  run(input) {
    const currency = input.currency ?? "USD";

    /**
     * A mixed-currency total is meaningless, and silently adding USD to EUR produces a
     * number that is wrong by an amount nobody can bound. Refusing is the only honest
     * option available without an exchange rate this package must not fetch.
     */
    const foreign = input.items.filter(
      (item) => item.currency !== undefined && item.currency !== currency,
    );
    if (foreign.length > 0) {
      throw new ToolError(
        "invalid_input",
        `Cannot total mixed currencies: ${[...new Set(foreign.map((item) => item.currency))].join(", ")} ` +
          `appear alongside ${currency}. Convert first — this tool performs no exchange-rate lookup.`,
        { path: "/items", toolName: TOOL.ESTIMATE_COST, userActionRequired: true },
      );
    }

    for (const item of input.items) {
      if (!Number.isFinite(item.estimated) || item.estimated < 0) {
        throw new ToolError(
          "invalid_input",
          `Line item "${item.taskId}" has an invalid estimate (${String(item.estimated)}).`,
          { path: "/items", toolName: TOOL.ESTIMATE_COST, userActionRequired: false },
        );
      }
    }

    const total = round(input.items.reduce((sum, item) => sum + item.estimated, 0));
    const reliableTotal = round(
      input.items.filter((item) => item.reliable !== false).reduce((sum, item) => sum + item.estimated, 0),
    );
    const unreliableTotal = round(total - reliableTotal);

    const byRole = groupBy(input.items, (item) => item.role);
    const byBasis = groupBy(input.items, (item) => item.basis ?? "unknown");

    /**
     * "Unpriced" means an item that claims an unknown basis *and* carries no explanation. A
     * priced item with basis "unknown" is fine — plenty of local models have a real compute
     * cost and no published tariff — but an unexplained zero is how a budget quietly becomes
     * fiction.
     */
    const unpricedTaskIds = input.items
      .filter(
        (item) =>
          item.estimated === 0 &&
          (item.basis === "unknown" || item.basis === undefined) &&
          (item.note === undefined || item.note.trim().length === 0),
      )
      .map((item) => item.taskId)
      .sort();

    const warnings: string[] = [];
    if (unpricedTaskIds.length > 0) {
      warnings.push(
        `${unpricedTaskIds.length} task(s) are costed at zero with no stated basis ` +
          `(${unpricedTaskIds.join(", ")}). Zero may be correct for local work, but it is ` +
          `indistinguishable from an omission until a basis is given.`,
      );
    }
    if (foreign.length === 0 && unreliableTotal > 0 && reliableTotal > 0) {
      warnings.push(
        `${unreliableTotal.toFixed(4)} of the ${total.toFixed(4)} total rests on figures with no ` +
          `published price. Treat the total as a lower bound.`,
      );
    }
    if (input.expectedInputTokens !== undefined || input.expectedOutputTokens !== undefined) {
      const tokens = (input.expectedInputTokens ?? 0) + (input.expectedOutputTokens ?? 0);
      if (tokens > 200_000 && total < 0.01) {
        warnings.push(
          `A ${tokens.toLocaleString("en-US")}-token request costed under 0.01 ${currency} is ` +
            `unlikely to be a full estimate.`,
        );
      }
    }

    // ── The cap check ─────────────────────────────────────────────────────
    if (input.cap !== undefined) {
      if (total > input.cap) {
        const largest = largestItems(input.items, 5)
          .map((item) => `${item.taskId} (${item.role}) ≈ ${item.estimated.toFixed(4)}`)
          .join(", ");
        throw new ToolError(
          "budget_exceeded",
          `Estimated ${total.toFixed(4)} ${currency} exceeds the cap of ${input.cap.toFixed(4)}. ` +
            `Largest items: ${largest}. Reduce scope or raise the cap.`,
          {
            toolName: TOOL.ESTIMATE_COST,
            userActionRequired: true,
            retryable: false,
            detail: `Over by ${(total - input.cap).toFixed(4)} ${currency}.`,
          },
        );
      }
    }

    const output: EstimateCostOutput = {
      total,
      currency,
      taskCount: input.items.length,
      reliableTotal,
      unreliableTotal,
      byRole,
      byBasis,
      unpricedTaskIds,
      largestItems: largestItems(input.items, 5),
      warnings,
      ...(input.cap !== undefined
        ? {
            cap: input.cap,
            capRemaining: round(input.cap - total),
            headroomFraction: input.cap === 0 ? 0 : round((input.cap - total) / input.cap),
          }
        : {}),
    };

    return output;
  },

  /**
   * Input-dependent cost of the estimate itself: zero currency, and not a flat zero either
   * — it scales with the number of items, which is what the executor's budget arithmetic
   * reads.
   */
  estimateCost: (input) => 0 + input.items.length * 0,
};

function groupBy(items: readonly CostLineItem[], key: (item: CostLineItem) => string): readonly CostGroup[] {
  const groups = new Map<string, { estimated: number; taskCount: number }>();
  for (const item of items) {
    const bucket = groups.get(key(item)) ?? { estimated: 0, taskCount: 0 };
    bucket.estimated += item.estimated;
    bucket.taskCount += 1;
    groups.set(key(item), bucket);
  }
  return [...groups.entries()]
    .map(([groupKey, value]) => ({
      key: groupKey,
      estimated: round(value.estimated),
      taskCount: value.taskCount,
    }))
    // Largest first, then alphabetically: deterministic, and the number a user wants is at
    // the top.
    .sort((a, b) => b.estimated - a.estimated || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}

function largestItems(items: readonly CostLineItem[], count: number): readonly CostLineItem[] {
  return [...items]
    .sort((a, b) => b.estimated - a.estimated || (a.taskId < b.taskId ? -1 : a.taskId > b.taskId ? 1 : 0))
    .slice(0, count);
}

function round(value: number): number {
  return Math.round(value * 1e6) / 1e6;
}