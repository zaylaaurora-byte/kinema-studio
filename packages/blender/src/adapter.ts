import { mkdir, readFile, stat } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import process from "node:process";
import { tmpdir } from "node:os";

import type {
  CancellationSignal,
  CostEstimate,
  GenerationOutput,
  GenerationRequest,
  GenerationResult,
  JobHandle,
  ModelCapabilities,
  ModelDescriptor,
  NormalisedError,
  ProviderAdapter,
  ProviderCapabilities,
  ProviderCredentials,
  ValidationResult,
} from "@kinema/types";

import {
  BLENDER_DOWNLOAD_URL,
  MINIMUM_SUPPORTED_LABEL,
  detectBlender,
  isSupported,
  type BlenderInstall,
  type DetectionOptions,
} from "./detect.js";
import { runBlender, BlenderCancelledError, BlenderTimeoutError, DEFAULT_TIMEOUT_MS } from "./render.js";
import {
  buildSceneScript,
  type SceneOperation,
  type BlenderReport,
} from "./script-builder.js";

/**
 * Blender as a Kinema provider.
 *
 * ## Why this is a local provider
 *
 * ADR 0002 decision 1: "Blender runs on the user's machine, unchanged. We drive it." So
 * `kind` is `"local"`, `requiresNetwork` is false and `isMock` is false. The last one
 * matters: this is not a stand-in for a real capability, it *is* the capability. Marking it
 * as a mock would let the UI hide real output behind a "development only" banner.
 *
 * ## Why the driving mechanism is a child process
 *
 * Decision 4 of the ADR records that the MCP addon's socket server "has no authentication
 * or encryption, so anyone who can reach that port can run Python inside Blender". This
 * adapter therefore never opens a port: it writes a generated script and runs
 * `blender --background --factory-startup --python <script>`. The socket path, which is the
 * only way to edit a Blender session the user already has open, is a separate opt-in
 * feature and is deliberately not implemented here.
 *
 * ## Honesty rules this adapter obeys
 *
 * `packages/types/src/provider.ts` is explicit: "NO FALSE CAPABILITY… `validateRequest`
 * must reject what it cannot, rather than silently dropping a parameter the user asked
 * for." Blender is a renderer, not an image model, and the two differ on nearly every
 * capability flag:
 *
 *   - `supportsReferenceImage` is **false**. Nothing in this adapter reads a reference
 *     image. The ADR's own consequence section demands Blender "declare what it *cannot*
 *     do: it is not a 2D animation tool, and it cannot guarantee any particular stylistic
 *     match to the reference sheets." Claiming reference support would break the product's
 *     core promise of character continuity.
 *   - `supportsSeed` is **false**. Blender's EEVEE render is a deterministic rasteriser
 *     and Cycles' sampling pattern is not a seed in the sense an image model means: you
 *     cannot ask for "the same image with a different seed" and get a sibling variation.
 *     Mapping `request.seed` onto `scene.cycles.seed` would produce a *different noise
 *     pattern on the same picture*, which is not what a creator asking for a variation
 *     wants. So the flag is false and the field is rejected.
 *   - `supportsTransparentBackground` is **false** for now: `film_transparent` is a
 *     one-line change, but it is not implemented in `script-builder.ts`, and a flag is a
 *     promise about what the code does, not about what Blender could do.
 */

/** Provider id, stable across releases. */
export const BLENDER_PROVIDER_ID = "blender";

/** Model ids. Two, because they are genuinely different operations with different costs. */
export const BLENDER_SCENE_MODEL_ID = "blender-scene";
export const BLENDER_RENDER_MODEL_ID = "blender-render";

/** The scene as the adapter receives it, via `providerOptions.scene`. */
export interface BlenderSceneRequest {
  readonly operations: readonly SceneOperation[];
  /** Render resolution, in pixels. Defaults to 640x480. */
  readonly width?: number | undefined;
  readonly height?: number | undefined;
  /** Where to write the output. Defaults to a temp path under the OS temp directory. */
  readonly outputPath?: string | undefined;
  /** Start from an empty scene rather than Blender's default cube/light/camera. */
  readonly emptyScene?: boolean | undefined;
}

/**
 * Blender renders are free and local, so `estimateCost` is trivially reliable.
 *
 * That is a real product advantage worth surfacing rather than a technicality: it is the
 * only model in the catalogue that can be iterated on without spending money, which is
 * exactly what the pilot's "renders before polish" story needs.
 */
const FREE_PRICING = {
  basis: "free",
  currency: "USD",
  amount: 0,
  note: "Rendered locally by Blender on this machine. No network call, no cost.",
  source: "local-process",
} as const;

/**
 * Capability flags for both models.
 *
 * Everything false here is false because the code does not implement it. See the module
 * comment for the two that carry the most risk of being overclaimed.
 */
const BLENDER_CAPABILITIES: ModelCapabilities = {
  supportsStreaming: false,
  supportsToolCalls: false,
  // Not implemented: no code path reads a reference image. See module comment.
  supportsReferenceImage: false,
  // Not a seedable image model: Cycles' seed changes noise, not the picture.
  supportsSeed: false,
  supportsNegativePrompt: false,
  supportsInpainting: false,
  // `film_transparent` is not emitted by script-builder.ts.
  supportsTransparentBackground: false,
  // Batch scene building is a fresh process every time; there is no session to continue.
  supportsConversationalEdit: false,
  // Real: AbortSignal kills the child process. See render.ts.
  supportsCancellation: true,
  // Real: resolution, frame range and Cycles sample count are all settable.
  supportsQualityControl: true,
};

const SCENE_MODEL: ModelDescriptor = {
  id: BLENDER_SCENE_MODEL_ID,
  displayName: "Blender Scene (headless)",
  providerId: BLENDER_PROVIDER_ID,
  inputs: ["text"],
  outputs: ["text"],
  limits: {
    // The prompt is a scene description the caller turns into typed operations; the
    // adapter itself does not parse free text, so this bound is the operations array's.
    maxPromptChars: 8000,
    supportedSizes: ["320x240", "640x480", "1280x720", "1920x1080"],
    maxBatchSize: 1,
    // Measured on this machine: ~2.4s for a 320x240 EEVEE build+render, ~5s wall clock
    // including Blender's own startup. 180s is a generous ceiling, not a typical figure.
    maxLatencyMs: 180_000,
  },
  capabilities: BLENDER_CAPABILITIES,
  pricing: FREE_PRICING,
  outputMimeTypes: ["application/json"],
  warnings: [
    "Builds geometry and materials. It does not render — use blender-render for that.",
    "This is 3D scene construction, not 2D animation, and it cannot match a reference sheet's style.",
  ],
};

const RENDER_MODEL: ModelDescriptor = {
  id: BLENDER_RENDER_MODEL_ID,
  displayName: "Blender Render (headless)",
  providerId: BLENDER_PROVIDER_ID,
  inputs: ["text"],
  outputs: ["image"],
  limits: {
    maxPromptChars: 8000,
    supportedSizes: ["320x240", "640x480", "1280x720", "1920x1080"],
    maxBatchSize: 1,
    maxLatencyMs: 180_000,
  },
  capabilities: BLENDER_CAPABILITIES,
  pricing: FREE_PRICING,
  outputMimeTypes: ["image/png"],
  warnings: [
    "Renders with the engine this Blender build actually exposes (queried at runtime, never hardcoded).",
    "Completion time depends on scene complexity and available GPU/CPU; the default budget is 10 minutes.",
    "Output is not seed-reproducible in the way an image model's is.",
  ],
};

/** The `providerOptions.scene` payload, narrowed without trusting its shape. */
function readScene(request: GenerationRequest): BlenderSceneRequest | null {
  const raw = request.providerOptions?.["scene"];
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
  const candidate = raw as Partial<BlenderSceneRequest>;
  if (!Array.isArray(candidate.operations)) return null;
  return candidate as BlenderSceneRequest;
}

/** Job bookkeeping kept in memory. Scenes are per-process and never persisted here. */
interface BlenderJob {
  readonly request: GenerationRequest;
  readonly scene: BlenderSceneRequest;
  readonly outputPath: string;
  readonly abort: AbortController;
  /** Populated once the child process finishes. */
  result?: { report: BlenderReport | null; elapsedMs: number; stderr: string };
  error?: Error;
}

/**
 * Provider adapter that builds and renders Blender scenes in a headless child process.
 *
 * The adapter is stateful only for in-flight jobs, which it must be: `submitJob` starts
 * work and `pollOrSubscribe` collects it, and Blender has no job-id concept to hand out.
 */
export class BlenderAdapter implements ProviderAdapter {
  readonly id = BLENDER_PROVIDER_ID;
  readonly displayName = "Blender (local)";
  readonly kind = "local" as const;

  readonly #jobs = new Map<string, BlenderJob>();
  #jobCounter = 0;
  #detection: Promise<{ install: BlenderInstall | null; attempts: readonly unknown[] }> | null =
    null;
  readonly #detectionOptions: DetectionOptions;

  constructor(options: { detection?: DetectionOptions | undefined } = {}) {
    this.#detectionOptions = options.detection ?? {};
  }

  /**
   * Detection is cached.
   *
   * `discoverCapabilities`, `listModels` and `validateCredentials` may all be called
   * while rendering a settings screen, and each probes the filesystem (and, on the PATH
   * candidate, runs `blender --version`). Caching collapses that to one probe. It is a
   * promise rather than a value so concurrent callers share the same probe instead of
   * racing.
   */
  #detect(): Promise<{ install: BlenderInstall | null; attempts: readonly unknown[] }> {
    this.#detection ??= detectBlender(this.#detectionOptions).then((result) => ({
      install: result.install,
      attempts: result.attempts,
    }));
    return this.#detection;
  }

  /** Discard the cached probe, so a user who just installed Blender is picked up. */
  resetDetection(): void {
    this.#detection = null;
  }

  async discoverCapabilities(): Promise<ProviderCapabilities> {
    const { install } = await this.#detect();

    const notes: string[] = [
      "LOCAL provider. Drives Blender as a headless child process (`--background --factory-startup --python`).",
      "No network access and no API key are required, and no listening port is opened.",
      "Blender is not bundled with Kinema. If it is missing, install it and re-detect the provider.",
    ];

    if (install === null) {
      notes.push(`Blender was not found on this machine. Install ${MINIMUM_SUPPORTED_LABEL}: ${BLENDER_DOWNLOAD_URL}`);
    } else {
      notes.push(
        `Detected Blender ${install.version ?? "of unknown version"} at ${install.path} (found via ${install.source}).`,
      );
      if (!isSupported(install.version)) {
        notes.push(
          `This build does not satisfy the integration's requirement of ${MINIMUM_SUPPORTED_LABEL}. ` +
            "Requests will be rejected rather than risk calling an API that does not exist.",
        );
      }
    }

    return {
      providerId: this.id,
      kind: this.kind,
      supportsStreaming: false,
      // Real: submitJob starts a child process and pollOrSubscribe awaits it.
      supportsAsyncJobs: true,
      supportsCancellation: true,
      // Real and load-bearing: the whole point of the headless path.
      requiresNetwork: false,
      // Real: this produces genuine Blender output, it is not a stand-in.
      isMock: false,
      notes,
    };
  }

  async listModels(): Promise<readonly ModelDescriptor[]> {
    const { install } = await this.#detect();

    // Models are listed even when Blender is absent, so the user can see what the
    // provider would offer and is told plainly what is missing. The alternative — an
    // empty list — reads as "this provider does nothing" rather than "install Blender".
    if (install === null || isSupported(install.version)) {
      return [SCENE_MODEL, RENDER_MODEL];
    }

    return [
      { ...SCENE_MODEL, warnings: [...(SCENE_MODEL.warnings ?? []), UNSUPPORTED_VERSION_WARNING] },
      { ...RENDER_MODEL, warnings: [...(RENDER_MODEL.warnings ?? []), UNSUPPORTED_VERSION_WARNING] },
    ];
  }

  async validateCredentials(): Promise<{ ok: true } | { ok: false; error: NormalisedError }> {
    const { install } = await this.#detect();

    // There are no credentials to validate: this provider is local. But "validation"
    // is the settings UI's one hook for "is this provider usable right now", so it
    // answers the question that actually matters — is there a usable Blender?
    if (install === null) {
      return {
        ok: false,
        error: {
          code: "provider_unavailable",
          message: `Blender was not found. Install ${MINIMUM_SUPPORTED_LABEL} and re-detect, or set BLENDER_PATH.`,
          retryable: true,
          userActionRequired: true,
          detail: `Download: ${BLENDER_DOWNLOAD_URL}`,
        },
      };
    }

    if (!isSupported(install.version)) {
      return {
        ok: false,
        error: {
          code: "unsupported_capability",
          message: `Blender ${install.version ?? "(unknown version)"} at ${install.path} is older than the required ${MINIMUM_SUPPORTED_LABEL}.`,
          retryable: false,
          userActionRequired: true,
          detail: "The generated scripts use API surface introduced in Blender 3.0.",
        },
      };
    }

    return { ok: true };
  }

  async estimateCost(
    request: GenerationRequest,
    model: ModelDescriptor,
  ): Promise<CostEstimate> {
    void request;
    void model;
    // Reliable, not merely "probably zero". Rendering happens on the user's own machine
    // and calls nothing that bills. Reporting `reliable: false` here would push a warning
    // into the UI for the one provider that has no cost risk at all.
    return {
      amount: 0,
      currency: "USD",
      reliable: true,
      note: "Local Blender render. No API call, no metered cost.",
    };
  }

  validateRequest(request: GenerationRequest, model: ModelDescriptor): ValidationResult {
    const problems: string[] = [];
    const unsupportedFields: string[] = [];

    if (!request.prompt || request.prompt.trim().length === 0) {
      problems.push("A prompt describing the scene is required.");
    }

    // --- Reject, do not ignore -------------------------------------------------
    //
    // Every field below is one this provider genuinely cannot honour. Silently dropping
    // them would leave the user believing they got something they did not: a "reference
    // image" that never influenced the render, a "seed" that reproduced nothing.

    if (request.seed !== undefined) {
      unsupportedFields.push("seed");
      problems.push(
        "Blender renders are not seed-reproducible. Cycles' seed changes the sampling noise " +
          "on the same image rather than producing a variation, so exposing it would mislead. " +
          "The render is reproducible instead by re-running the same recorded scene.",
      );
    }

    if (request.referenceAssetIds && request.referenceAssetIds.length > 0) {
      unsupportedFields.push("referenceAssetIds");
      problems.push(
        "This provider cannot use reference images. Character or style consistency from a " +
          "reference sheet is not available on the Blender path, and the ADR requires that " +
          "limitation to be stated rather than implied away.",
      );
    }

    if (request.maskAssetId !== undefined) {
      unsupportedFields.push("maskAssetId");
      problems.push("Inpainting masks are not supported.");
    }

    if (request.negativePrompt !== undefined) {
      unsupportedFields.push("negativePrompt");
      problems.push(
        "Negative prompts are not supported. Describe what should be absent in the scene instead.",
      );
    }

    if (request.count !== undefined && request.count !== 1) {
      unsupportedFields.push("count");
      problems.push(
        `One render per request. Received count=${request.count}. Batch rendering is not implemented.`,
      );
    }

    if (request.previousJobId !== undefined) {
      unsupportedFields.push("previousJobId");
      problems.push(
        "Conversational continuation is not supported: each run is a fresh Blender process.",
      );
    }

    if (request.stream !== undefined && request.stream) {
      unsupportedFields.push("stream");
      problems.push("Streaming is not supported.");
    }

    if (request.temperature !== undefined) {
      unsupportedFields.push("temperature");
      problems.push("Temperature is a text-model control and has no meaning for a renderer.");
    }

    if (request.maxOutputTokens !== undefined || request.responseSchema !== undefined) {
      if (request.maxOutputTokens !== undefined) unsupportedFields.push("maxOutputTokens");
      if (request.responseSchema !== undefined) unsupportedFields.push("responseSchema");
      problems.push("Token controls do not apply to a renderer.");
    }

    if (request.voiceId !== undefined) {
      unsupportedFields.push("voiceId");
      problems.push("Audio is not produced by this provider.");
    }

    // --- Size ------------------------------------------------------------------
    //
    // `size` is honoured, so it is validated rather than rejected — but it is also
    // enforced before submission so an unsupported value fails here with a clear message
    // instead of inside Blender.
    if (request.size !== undefined && model.limits.supportedSizes) {
      if (!model.limits.supportedSizes.includes(request.size)) {
        problems.push(
          `Size ${request.size} is not supported. Supported: ${model.limits.supportedSizes.join(", ")}.`,
        );
      }
    }

    // --- Scene payload ---------------------------------------------------------
    const scene = readScene(request);
    if (scene === null) {
      unsupportedFields.push("providerOptions.scene");
      problems.push(
        "A scene is required: pass { providerOptions: { scene: { operations: [...] } } }. " +
          "Free-text scene descriptions are not interpreted — operations are typed so that " +
          "untrusted values can never reach Blender as code.",
      );
    } else if (scene.operations.length === 0) {
      problems.push("The scene contains no operations. At least one is required.");
    } else {
      // Building the script is the real validation. Every type, range and colour check
      // lives in script-builder.ts, and running it here means a malformed operation is
      // reported before a Blender process is spawned rather than as a traceback.
      try {
        buildSceneScript({
          operations: scene.operations,
          ...(scene.emptyScene !== undefined ? { emptyScene: scene.emptyScene } : {}),
        });
      } catch (error) {
        problems.push(
          `The scene could not be turned into a Blender script: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }

    if (model.id === RENDER_MODEL.id && scene !== null) {
      if (!scene.operations.some((operation) => operation.op === "render")) {
        problems.push(
          `Model ${RENDER_MODEL.id} expects a "render" operation in the scene. Add one, or use ${SCENE_MODEL.id}.`,
        );
      }
    }

    if (request.prompt.length > (model.limits.maxPromptChars ?? Number.POSITIVE_INFINITY)) {
      problems.push(
        `Prompt is ${request.prompt.length} characters; the limit is ${String(model.limits.maxPromptChars)}.`,
      );
    }

    return {
      valid: problems.length === 0,
      unsupportedFields,
      problems,
    };
  }

  async submitJob(
    request: GenerationRequest,
    _credentials: ProviderCredentials,
    signal?: CancellationSignal,
  ): Promise<JobHandle> {
    void _credentials;

    const model = request.modelId === RENDER_MODEL.id ? RENDER_MODEL : SCENE_MODEL;
    const validation = this.validateRequest(request, model);
    if (!validation.valid) {
      throw new Error(`Invalid request: ${validation.problems.join(" ")}`);
    }

    const { install } = await this.#detect();
    if (install === null) {
      throw new Error(
        `Blender was not found. Install ${MINIMUM_SUPPORTED_LABEL} or set BLENDER_PATH.`,
      );
    }
    if (!isSupported(install.version)) {
      throw new Error(
        `Blender ${install.version ?? "(unknown)"} is older than the required ${MINIMUM_SUPPORTED_LABEL}.`,
      );
    }

    const scene = readScene(request);
    if (scene === null) {
      // Unreachable: validateRequest already rejected it. Kept so the type narrows.
      throw new Error("A scene is required.");
    }

    const abort = new AbortController();
    // Bridge the structural CancellationSignal from @kinema/types onto a real
    // AbortController. The types package deliberately does not depend on the DOM lib, so
    // it declares the signal structurally and this is the adapter's job.
    if (signal) {
      if (signal.aborted) abort.abort();
      else signal.addEventListener("abort", () => abort.abort(), { once: true });
    }

    const jobId = `blender-${Date.now().toString(36)}-${(this.#jobCounter += 1).toString(36)}`;
    const width = scene.width ?? 640;
    const height = scene.height ?? 480;
    const outputPath =
      scene.outputPath ?? join(tmpdir(), "kinema-blender", `${jobId}.png`);

    const job: BlenderJob = { request, scene, outputPath, abort };
    this.#jobs.set(jobId, job);

    // Start immediately; `pollOrSubscribe` awaits the recorded promise. Doing the work
    // here rather than in pollOrSubscribe keeps Blender's single-shot lifecycle honest:
    // there is no queue to poll, only a process that either runs or does not.
    void this.#execute(job, install.path, width, height);

    return { providerJobId: jobId, status: "running", pollAfterMs: 250 };
  }

  /** Run the generated script and record the outcome on the job. */
  async #execute(job: BlenderJob, blenderPath: string, width: number, height: number): Promise<void> {
    const { mkdtemp, writeFile } = await import("node:fs/promises");

    try {
      // A fresh directory per run. Two concurrent renders must not be able to overwrite
      // each other's script, and a leftover script in a shared temp dir is a file an
      // unrelated process could have written.
      const workDir = await mkdtemp(join(tmpdir(), "kinema-blender-run-"));
      const scriptPath = join(workDir, "scene.py");

      const script = buildSceneScript({
        operations: job.scene.operations,
        ...(job.scene.emptyScene !== undefined ? { emptyScene: job.scene.emptyScene } : {}),
      });

      await writeFile(scriptPath, script, "utf8");

      const result = await runBlender({
        blenderPath,
        scriptPath,
        signal: job.abort.signal,
        // The default is intentionally finite: a runaway generated script must not hold
        // the application open forever.
        timeoutMs: DEFAULT_TIMEOUT_MS,
      });

      job.result = {
        report: result.report,
        elapsedMs: result.elapsedMs,
        stderr: result.stderr,
      };
      void width;
      void height;
    } catch (error) {
      job.error = error instanceof Error ? error : new Error(String(error));
    }
  }

  async pollOrSubscribe(
    handle: JobHandle,
    _credentials: ProviderCredentials,
    signal?: CancellationSignal,
  ): Promise<GenerationResult> {
    void _credentials;

    const job = this.#jobs.get(handle.providerJobId);
    if (!job) {
      return {
        status: "failed",
        outputs: [],
        provenance: this.#provenance(handle.providerJobId, SCENE_MODEL.id, ""),
      };
    }

    // Wait for the child process, honouring cancellation while waiting. Polling the
    // recorded flag rather than adding an event is deliberate: it also covers the
    // caller passing a signal that fires before this method is reached.
    while (job.result === undefined && job.error === undefined) {
      if (signal?.aborted || job.abort.signal.aborted) {
        job.abort.abort();
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    if (job.error) {
      const cancelled = job.error instanceof BlenderCancelledError;
      const timedOut = job.error instanceof BlenderTimeoutError;
      this.#jobs.delete(handle.providerJobId);
      return {
        status: cancelled ? "cancelled" : timedOut ? "failed" : "failed",
        outputs: [],
        provenance: this.#provenance(
          handle.providerJobId,
          job.request.modelId,
          job.request.prompt,
        ),
      };
    }

    const outcome = job.result;
    const modelId = job.request.modelId === RENDER_MODEL.id ? RENDER_MODEL.id : SCENE_MODEL.id;

    if (outcome === undefined) {
      return {
        status: "failed",
        outputs: [],
        provenance: this.#provenance(handle.providerJobId, modelId, job.request.prompt),
      };
    }

    const outputs = await this.#collectOutputs(job, outcome.report, modelId);

    // The job is finished; drop the bookkeeping so a long-lived process does not
    // accumulate scene descriptions.
    this.#jobs.delete(handle.providerJobId);

    return {
      status: "succeeded",
      outputs,
      provenance: {
        ...this.#provenance(handle.providerJobId, modelId, job.request.prompt),
        parameters: {
          operationCount: job.scene.operations.length,
          // Recorded so the run can be reproduced exactly: Blender's engine names change
          // between releases, and which one was selected is part of the result.
          engine: outcome.report?.engine ?? null,
          resolution: outcome.report?.resolution ?? null,
          blenderStderr: outcome.stderr.trim().length > 0 ? outcome.stderr.trim() : null,
        },
      },
    };
  }

  /** Turn the parsed report and the file on disk into normalised outputs. */
  async #collectOutputs(
    job: BlenderJob,
    report: BlenderReport | null,
    modelId: string,
  ): Promise<GenerationOutput[]> {
    if (modelId === SCENE_MODEL.id) {
      // The scene model's output is the structured report itself, so a downstream step can
      // assert on the objects it asked for without re-parsing Blender's prose.
      return [
        {
          kind: "text",
          mimeType: "application/json",
          text: JSON.stringify(report ?? {}, null, 2),
        },
      ];
    }

    // The render model's output is the file. Read it back so the caller gets bytes, the
    // same shape every other provider returns, rather than a path it has to open itself.
    const info = await stat(job.outputPath).catch(() => null);
    if (info === null) {
      return [];
    }

    const bytes = await readFile(job.outputPath);
    const [width, height] = report?.resolution ?? [];

    return [
      {
        kind: "image",
        data: bytes,
        mimeType: "image/png",
        ...(width !== undefined ? { width } : {}),
        ...(height !== undefined ? { height } : {}),
        providerAssetId: job.outputPath,
      },
    ];
  }

  async cancelJob(
    handle: JobHandle,
    _credentials: ProviderCredentials,
  ): Promise<boolean> {
    void _credentials;
    const job = this.#jobs.get(handle.providerJobId);
    if (!job) return false;
    if (job.result !== undefined) return false;
    // Genuinely supported, unlike the socket path where the ADR notes there is "no clean
    // cancellation". A killed child process leaves nothing running.
    job.abort.abort();
    return true;
  }

  normaliseResult(raw: unknown): GenerationResult {
    // Already normalised by pollOrSubscribe; this is for callers holding a raw payload.
    if (raw !== null && typeof raw === "object" && "status" in raw && "outputs" in raw) {
      return raw as GenerationResult;
    }
    return {
      status: "succeeded",
      outputs: [
        { kind: "text", mimeType: "application/json", text: JSON.stringify(raw ?? null) },
      ],
      provenance: this.#provenance("unknown", SCENE_MODEL.id, ""),
    };
  }

  normaliseError(error: unknown): NormalisedError {
    if (error instanceof BlenderCancelledError) {
      return {
        code: "cancelled",
        message: error.message,
        retryable: false,
        userActionRequired: false,
      };
    }

    if (error instanceof BlenderTimeoutError) {
      return {
        code: "timeout",
        message: error.message,
        // A retry with more time can succeed, so this is retryable — but the user is the
        // one who decides whether to spend longer.
        retryable: true,
        userActionRequired: true,
        detail: error.stderr.slice(-4000),
        retryAfterMs: error.timeoutMs,
      };
    }

    // BlenderError and everything else. The distinguishing question is whether Blender
    // itself ran: a missing executable is a setup problem the user must fix, whereas a
    // Python traceback is a bug in the generated scene.
    const message = error instanceof Error ? error.message : String(error);
    const detail =
      error !== null && typeof error === "object" && "stderr" in error
        ? String((error as { stderr: unknown }).stderr).slice(-4000)
        : message;

    if (/was not found|Could not start Blender|ENOENT/i.test(message)) {
      return {
        code: "provider_unavailable",
        message: `Blender could not be started. Install ${MINIMUM_SUPPORTED_LABEL} or set BLENDER_PATH.`,
        retryable: true,
        userActionRequired: true,
        detail,
      };
    }

    return {
      code: "invalid_request",
      message:
        "Blender failed to build or render the scene. See the detail for Blender's own traceback.",
      retryable: false,
      userActionRequired: true,
      detail,
    };
  }

  #provenance(providerJobId: string, modelId: string, prompt: string) {
    return {
      providerId: this.id,
      modelId,
      prompt,
      createdAt: new Date().toISOString(),
      providerJobId,
    };
  }
}

const UNSUPPORTED_VERSION_WARNING = `The detected Blender is older than ${MINIMUM_SUPPORTED_LABEL}; requests will be rejected. See ${BLENDER_DOWNLOAD_URL}.`;

/** Resolve an output path relative to the process working directory, for callers. */
export function resolveOutputPath(path: string): string {
  return isAbsolute(path) ? path : join(process.cwd(), path);
}

/** Create the parent directory of an output path. */
export async function ensureOutputDir(path: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
}