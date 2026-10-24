/**
 * The built-in tool set.
 *
 * Every role's allowlist resolves to a tool in here, and {@link createDefaultRegistry}
 * asserts that at construction time — a role permitted to use a tool that does not exist is
 * a configuration error that would otherwise surface as a mysterious runtime refusal.
 */

import { ROLES, toolsUsedByRoles } from "../roles.js";
import { ToolError, ToolRegistry } from "../tool.js";
import { ALL_TOOL_NAMES } from "../tool-names.js";
import { estimateCostTool } from "./cost-tools.js";
import { assembleTimelineTool, readReferenceSnapshotTool, scenePlanTool } from "./production-tools.js";
import { qcCheckTool } from "./qc-tools.js";
import { readScriptTool, writeScriptTool } from "./script-tools.js";

export { estimateCostTool } from "./cost-tools.js";
export type { CostGroup, CostLineItem, EstimateCostInput, EstimateCostOutput } from "./cost-tools.js";

export {
  assembleTimelineTool,
  readReferenceSnapshotTool,
  scenePlanTool,
} from "./production-tools.js";
export type {
  AssembleTimelineInput,
  AssembleTimelineOutput,
  PlannedSceneOutput,
  PlannedShotOutput,
  ReadReferenceSnapshotInput,
  ReferenceCharacterInput,
  ReferenceSnapshotOutput,
  ScenePlanInput,
  ScenePlanOutput,
  TimelineClipOutput,
} from "./production-tools.js";

export { qcCheckTool, QC_CHECKS, ALL_QC_CHECKS } from "./qc-tools.js";
export type {
  CharacterLockInput,
  PlannedScene,
  PlannedShot,
  QcCheckId,
  QcCheckInput,
  QcCheckOutput,
  QcFinding,
  QcSeverity,
} from "./qc-tools.js";

export { readScriptTool, writeScriptTool } from "./script-tools.js";
export type {
  ReadScriptInput,
  ReadScriptOutput,
  ScriptOutlineScene,
  WriteScriptInput,
  WriteScriptOutput,
} from "./script-tools.js";

export { SCRIPT_SCHEMA, scriptDurationSeconds, linesForCharacter } from "./script-data.js";
export type { Script, ScriptLine, ScriptScene } from "./script-data.js";

/** Every built-in tool, in a stable order. */
export const BUILT_IN_TOOLS = [
  readScriptTool,
  writeScriptTool,
  estimateCostTool,
  qcCheckTool,
  assembleTimelineTool,
  readReferenceSnapshotTool,
  scenePlanTool,
] as const;

/**
 * Check that the role allowlists and the tool set agree.
 *
 * @throws ToolError `unknown_tool` naming every role/tool pair that does not resolve.
 */
export function assertRoleToolsExist(): void {
  const provided = new Set<string>(BUILT_IN_TOOLS.map((tool) => tool.name));
  const dangling: string[] = [];

  for (const role of Object.values(ROLES)) {
    for (const toolName of role.allowedTools) {
      if (!provided.has(toolName)) dangling.push(`${role.name} → ${toolName}`);
    }
  }

  if (dangling.length > 0) {
    throw new ToolError(
      "unknown_tool",
      `Role allowlists reference tools that do not exist: ${dangling.join(", ")}. ` +
        `A permitted-but-missing tool becomes a runtime refusal with no obvious cause.`,
      { userActionRequired: false },
    );
  }

  /**
   * The reverse direction is a warning rather than an error, but worth reporting: a
   * built-in tool no role may use is dead weight in every prompt that lists the catalogue.
   */
  const used = new Set<string>(toolsUsedByRoles());
  const unreachable = BUILT_IN_TOOLS.filter((tool) => !used.has(tool.name)).map((tool) => tool.name);
  if (unreachable.length > 0) {
    throw new ToolError(
      "tool_not_permitted",
      `Built-in tool(s) reachable by no role: ${unreachable.join(", ")}. Either add them to a ` +
        `role's allowlist or remove them, so the catalogue a model sees contains only reachable tools.`,
      { userActionRequired: false },
    );
  }
}

/**
 * A registry with every built-in tool, validated.
 *
 * @throws SchemaDefinitionError if any tool declares a schema using an unsupported keyword.
 * @throws ToolError if the allowlists and the tool set disagree.
 */
export function createDefaultRegistry(): ToolRegistry {
  assertRoleToolsExist();
  const registry = new ToolRegistry();
  for (const tool of BUILT_IN_TOOLS) registry.register(tool as never);
  return registry;
}

/** All known tool names, whether or not this build registers every one of them. */
export const KNOWN_TOOL_NAMES: readonly string[] = ALL_TOOL_NAMES;