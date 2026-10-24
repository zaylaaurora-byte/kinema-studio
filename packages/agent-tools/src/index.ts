/**
 * @kinema/agent-tools — the AI Director and the tools its specialists may use.
 *
 * ── What this package is for ─────────────────────────────────────────────────
 *
 * The product spec describes an "AI Director" that decomposes a creative goal into typed
 * tasks, delegates to specialist roles, and respects approval checkpoints and budget caps.
 * This package is that Director, and it is deliberately built so that the governance cannot
 * be bypassed by swapping the brain:
 *
 *   goal ──► Planner ──► TaskGraph ──► Executor ──► artifacts + audit trail
 *              │              │            │
 *              │              │            └─ approval gates, budget caps, retries, cancellation
 *              │              └─ typed task contract, dependency resolution, cycle rejection
 *              └─ deterministic (no model) or provider-backed (model behind ProviderAdapter)
 *
 * The MockPlanner and the ProviderPlanner produce the same artifact, so a plan built with no
 * model at all is subject to exactly the same checks as one an LLM proposed. That is the
 * property worth having: the day someone plugs in a real model, nothing about the approval,
 * cost or audit behaviour changes.
 *
 * ── Offline by construction ──────────────────────────────────────────────────
 *
 * Nothing in this package opens a socket. The provider-backed planner takes an adapter,
 * tests pass a fake one, and no module here imports a transport. The only tools that exist
 * operate on data structures, not the filesystem.
 *
 * ── What is NOT here ─────────────────────────────────────────────────────────
 *
 * No model inference, no image generation, no rendering, no persistence. Those are provider
 * and pipeline concerns. This package decides *what work to do, in what order, under what
 * constraints, and what happened* — and stops there, so it stays testable without a GPU, a
 * key or a network.
 */

import { ROLES } from "./roles.js";
export { ROLES };

// ── Tool contract ───────────────────────────────────────────────────────────
export {
  asToolError,
  ToolError,
  ToolRegistry,
} from "./tool.js";
export type {
  Tool,
  ToolContext,
  ToolErrorCode,
  ToolInvocationFailure,
  ToolInvocationResult,
  ToolInvocationSuccess,
} from "./tool.js";

// ── Schema validation ───────────────────────────────────────────────────────
export {
  appendPointer,
  assertSupportedSchema,
  deepEqual,
  describeSchemaProblems,
  describeValue,
  isValidAgainstSchema,
  SchemaDefinitionError,
  validateAgainstSchema,
} from "./schema.js";
export type { JsonSchema, JsonSchemaTypeName, ValidationIssue, ValidationOutcome } from "./schema.js";

// ── Tool names ──────────────────────────────────────────────────────────────
export { ALL_TOOL_NAMES, TOOL } from "./tool-names.js";
export type { ToolName } from "./tool-names.js";

// ── Roles ───────────────────────────────────────────────────────────────────
export {
  assertToolPermitted,
  isRoleName,
  isToolPermitted,
  listRoles,
  requireRole,
  ROLE_OUTPUT_SCHEMAS,
  ROLE_NAMES,
  rolesPermittedToUse,
  toolsUsedByRoles,
} from "./roles.js";
export type { Role, RoleName } from "./roles.js";

// ── Task contract ───────────────────────────────────────────────────────────
export {
  approvalGates,
  approvalReason,
  assertTaskWellFormed,
  createTask,
  createTaskGraph,
  DEFAULT_RETRY_POLICY,
  DEFAULT_TIMEOUT_MS,
  describeGraph,
  descendantsOf,
  effectiveTools,
  emptyReferenceSnapshot,
  requiresHumanApproval,
  resolveExecutionOrder,
  retryPolicy,
  ROLE_PRODUCTION_ORDER,
  topologicalOrder,
  totalEstimatedCost,
  tryCreateTaskGraph,
} from "./task.js";
export type {
  AgentTask,
  ApprovalGate,
  ApprovalPolicy,
  AuditMetadata,
  CharacterLock,
  CostEnvelope,
  CreateTaskInput,
  ModelBinding,
  ReferenceSnapshot,
  ResolutionFailure,
  ResolutionResult,
  RetryPolicy,
  TaskGraph,
  TaskStatus,
} from "./task.js";

// ── Planning ────────────────────────────────────────────────────────────────
export {
  analyseGoal,
  DEFAULT_COST_MODEL,
  defaultGovernance,
  extractCharacterNames,
  extractDurationSeconds,
  extractJsonObject,
  MockPlanner,
  PLANNER_RESPONSE_SCHEMA,
  ProviderPlanner,
} from "./planner.js";
export type {
  CostModel,
  GoalAnalysis,
  MockPlannerOptions,
  PlanContext,
  Planner,
  ProposedTask,
  ProviderPlannerOptions,
  VideoFormat,
} from "./planner.js";

// ── Execution ───────────────────────────────────────────────────────────────
export { describeExecution, Executor } from "./executor.js";
export type {
  ApprovalDecision,
  ApprovalRequest,
  AuditEvent,
  AuditEventKind,
  BudgetCap,
  ExecutionResult,
  ExecutorOptions,
  TaskOutcome,
} from "./executor.js";

// ── Determinism helpers ─────────────────────────────────────────────────────
export { deterministicInt, deterministicPick, fnv1a, roundTo, shortHash } from "./deterministic.js";

// ── The built-in tools ──────────────────────────────────────────────────────
export {
  ALL_QC_CHECKS,
  assembleTimelineTool,
  assertRoleToolsExist,
  BUILT_IN_TOOLS,
  createDefaultRegistry,
  estimateCostTool,
  KNOWN_TOOL_NAMES,
  linesForCharacter,
  qcCheckTool,
  QC_CHECKS,
  readReferenceSnapshotTool,
  readScriptTool,
  SCRIPT_SCHEMA,
  scenePlanTool,
  scriptDurationSeconds,
  writeScriptTool,
} from "./tools/index.js";
export type {
  AssembleTimelineInput,
  AssembleTimelineOutput,
  CostLineItem,
  EstimateCostInput,
  EstimateCostOutput,
  PlannedScene,
  PlannedShot,
  QcCheckId,
  QcCheckInput,
  QcCheckOutput,
  QcFinding,
  QcSeverity,
  ReadReferenceSnapshotInput,
  ReferenceSnapshotOutput,
  ReadScriptInput,
  ReadScriptOutput,
  ScenePlanInput,
  ScenePlanOutput,
  Script,
  ScriptLine,
  ScriptScene,
  WriteScriptInput,
  WriteScriptOutput,
} from "./tools/index.js";