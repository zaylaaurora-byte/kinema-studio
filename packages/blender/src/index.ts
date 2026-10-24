/**
 * @kinema/blender — Blender as a local provider.
 *
 * Kinema drives Blender headlessly, as a child process. It never connects to the MCP
 * addon's socket server: that server opens a port with no authentication and executes the
 * Python it receives, whereas a child process opens no port, is deterministic under
 * `--factory-startup`, and can be killed. See ADR 0002.
 *
 * The three pieces fit together like this:
 *
 *   detect.ts         find a usable Blender, without hardcoding a path
 *   script-builder.ts turn typed operations into safe Python, and a JSON report back out
 *   render.ts         run it, with a timeout and cancellation, and parse the report
 *   adapter.ts        present the whole thing as a ProviderAdapter
 */

export {
  BLENDER_DOWNLOAD_URL,
  MINIMUM_SUPPORTED_LABEL,
  MINIMUM_SUPPORTED_MAJOR,
  MINIMUM_SUPPORTED_MINOR,
  BlenderNotFoundError,
  compareInstallDirs,
  detectBlender,
  executableName,
  extractVersionFromDirName,
  isSupported,
  parseBlenderVersion,
  parseVersionParts,
  requireBlenderPath,
  standardInstallCandidates,
  windowsInstallCandidates,
  type BlenderInstall,
  type DetectionOptions,
  type DetectionResult,
  type ParsedVersion,
  type ProbeAttempt,
} from "./detect.js";

export {
  DEFAULT_FRAME_RATE,
  REPORT_END_MARKER,
  REPORT_START_MARKER,
  ScriptBuildError,
  buildSceneScript,
  parseHexColour,
  pythonNumber,
  pythonStringLiteral,
  pythonVector,
  type AddCameraOperation,
  type AddLightOperation,
  type AddPrimitiveOperation,
  type BlenderReport,
  type BuildSceneScriptOptions,
  type LightKind,
  type PrimitiveKind,
  type RenderOperation,
  type SceneOperation,
  type SetMaterialOperation,
  type SetRenderSettingsOperation,
  type Vector3,
} from "./script-builder.js";

export {
  DEFAULT_TIMEOUT_MS,
  BlenderCancelledError,
  BlenderError,
  BlenderTimeoutError,
  hasPythonTraceback,
  parseReport,
  runBlender,
  type BlenderRunResult,
  type RunBlenderOptions,
} from "./render.js";

export {
  BLENDER_PROVIDER_ID,
  BLENDER_RENDER_MODEL_ID,
  BLENDER_SCENE_MODEL_ID,
  BlenderAdapter,
  ensureOutputDir,
  resolveOutputPath,
  type BlenderSceneRequest,
} from "./adapter.js";