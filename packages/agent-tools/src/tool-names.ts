/**
 * Tool name constants.
 *
 * The spec requires "Agent tool allowlists" — a per-role list of what that role may
 * invoke. Allowlists written as raw strings rot silently: rename a tool and the allowlist
 * keeps compiling while permitting nothing, and the failure appears at runtime, in
 * production, as a mysterious refusal. Centralising the names here means a rename is one
 * edit and a typo is a compile error.
 */

export const TOOL = {
  /** Read and write the project's script document. */
  READ_SCRIPT: "read_script",
  WRITE_SCRIPT: "write_script",
  /** Sum task cost estimates against a cap — the budget gate as a callable tool. */
  ESTIMATE_COST: "estimate_cost",
  /** Deterministic quality checks over a scene plan. */
  QC_CHECK: "qc_check",
  /** Assemble a shot list / edit decision list from a scene plan. */
  ASSEMBLE_TIMELINE: "assemble_timeline",
  /** Derive a structured reference snapshot for a character or scene. */
  READ_REFERENCE_SNAPSHOT: "read_reference_snapshot",
  /** Split a beat sheet into scenes with orders and durations. */
  SCENE_PLAN: "scene_plan",
} as const;

export type ToolName = (typeof TOOL)[keyof typeof TOOL];

/** Every known tool name, for exhaustiveness checks in tests and the UI. */
export const ALL_TOOL_NAMES: readonly ToolName[] = Object.values(TOOL);