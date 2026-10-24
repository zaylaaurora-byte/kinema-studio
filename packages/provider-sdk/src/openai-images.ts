import type {
  CancellationSignal,
  CostEstimate,
  GenerationOutput,
  GenerationRequest,
  GenerationResult,
  JobHandle,
  ModelDescriptor,
  ModelCapabilities,
  NormalisedError,
  ProviderAdapter,
  ProviderCapabilities,
  ProviderCredentials,
  ValidationResult,
} from "@kinema/types";

import { assessBaseUrl, guardedFetch } from "./ssrf.js";

/**
 * OpenAI Image API adapter.
 *
 * Real requests against `POST /v1/images/generations` and `POST /v1/images/edits`.
 *
 * ===========================================================================
 * MODERATION IS NOT AN ERROR TO RETRY — IT IS A REFUSAL
 * ===========================================================================
 * The single most consequential behaviour in this file. When OpenAI's safety system
 * declines a prompt it returns HTTP 400 with:
 *
 *     error.type = "image_generation_user_error"
 *     error.code = "moderation_blocked"
 *     error.moderation_details = { moderation_stage, categories: [...] }
 *
 * A generic HTTP client maps that onto "400, retryable" or, worse, retries it in a
 * loop. Both are wrong. A moderation block is a *deterministic refusal*: the identical
 * request will be refused identically, forever. Retrying:
 *   - burns the user's money and time,
 *   - can escalate to an account-level rate limit or suspension,
 *   - and, most importantly, tells the user nothing they can act on.
 *
 * So `moderation_blocked` is emitted with `retryable: false` and
 * `userActionRequired: true`, and `shouldAutoRetry()` refuses it outright. The
 * category detail is parsed into `detail` for *developer logs* while `message` stays
 * generic — see `buildModerationMessage` for why that split is deliberate.
 *
 * ===========================================================================
 * BASE64, NOT A URL
 * ===========================================================================
 * `gpt-image-*` models return inline base64 in `data[0].b64_json`. They do NOT return
 * a URL (that was the DALL·E 2/3 shape). The decoded bytes are handed back as a
 * `GenerationOutput.data` ByteBuffer, which is what the asset store expects, so no
 * separate download step exists and therefore no second SSRF surface.
 *
 * ===========================================================================
 * TESTABILITY
 * ===========================================================================
 * `fetchImpl` is injected. There is no default: passing `globalThis.fetch` is an
 * explicit act at the call site. That makes "no network in tests" structurally true
 * rather than a convention someone has to remember.
 */

export const OPENAI_IMAGES_PROVIDER_ID = "openai-images";

/** Documented default API root. Overridable for Azure/OpenAI-compatible gateways. */
export const DEFAULT_OPENAI_BASE_URL = "https://api.openai.com/v1";

/**
 * The two image models. Names are per the product's provider research (PROVIDERS.md).
 *
 * They are NOT interchangeable, and the capability table below says so. `flare`
 * prioritises latency for iteration; `sunburst` prioritises instruction-following
 * fidelity, which is what reference-image editing depends on.
 */
export const OPENAI_IMAGE_MODELS = {
  fast: "gpt-image-2.5-flare",
  precise: "gpt-image-2.5-sunburst",
} as const;

export type OpenAIImageModelId =
  (typeof OPENAI_IMAGE_MODELS)[keyof typeof OPENAI_IMAGE_MODELS];

export const SUPPORTED_SIZES = ["1024x1024", "1536x1024", "1024x1536"] as const;
export type SupportedSize = (typeof SUPPORTED_SIZES)[number];

export const SUPPORTED_QUALITIES = [
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "auto",
] as const;
export type SupportedQuality = (typeof SUPPORTED_QUALITIES)[number];

export const SUPPORTED_FORMATS = ["png", "jpeg", "webp"] as const;
export type SupportedFormat = (typeof SUPPORTED_FORMATS)[number];

/**
 * Documented worst-case latency is up to 2 minutes for the image endpoint.
 *
 * This is a real number from the docs, not a guess, and it is load-bearing: the job
 * runner uses it to size its timeout, and the UI uses it to decide whether to show a
 * progress affordance. Understating it would cause premature timeouts on legitimate
 * requests, which look to the user like a broken provider.
 */
export const MAX_LATENCY_MS = 120_000;

/** Formats permitted with `background: "transparent"`. */
const TRANSPARENT_BACKGROUND_FORMATS: readonly string[] = ["png", "webp"];

const MIME_BY_FORMAT: Readonly<Record<SupportedFormat, string>> = {
  png: "image/png",
  jpeg: "image/jpeg",
  webp: "image/webp",
};

/** Dimensions for each supported size, so outputs carry width/height without decoding. */
const DIMENSIONS_BY_SIZE: Readonly<Record<SupportedSize, { width: number; height: number }>> = {
  "1024x1024": { width: 1024, height: 1024 },
  "1536x1024": { width: 1536, height: 1024 },
  "1024x1536": { width: 1024, height: 1536 },
};

/** Injected transport. Tests pass a fake; production passes `globalThis.fetch`. */
export type FetchLike = (
  input: string,
  init?: RequestInit,
) => Promise<Response>;

/**
 * `guardedFetch` is typed against the platform `fetch`, which accepts a `Request` or
 * `URL` as well as a string. `FetchLike` is deliberately narrower (string only) so a
 * fake in a test cannot be handed anything it would have to parse. This adapter is the
 * bridge between the two, and it is sound because `guardedFetch` only ever passes the
 * string it built from the base URL and path.
 */
type PlatformFetch = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

function asPlatformFetch(fetchImpl: FetchLike): PlatformFetch {
  return (input, init) => fetchImpl(String(input), init);
}

export interface OpenAIImagesAdapterOptions {
  readonly fetchImpl: FetchLike;
  readonly baseUrl?: string;
  /** Correlation id for support tickets. Sent as `X-Client-Request-Id`. */
  readonly clientRequestId?: string;
  readonly organisationId?: string;
  /** Permit loopback/private base URLs (a local OpenAI-compatible gateway). */
  readonly allowLocalEndpoints?: boolean;
  /** Override for tests; defaults to `MAX_LATENCY_MS`. */
  readonly timeoutMs?: number;
}

// ---------------------------------------------------------------------------
// Model descriptors
// ---------------------------------------------------------------------------

/**
 * Capability declarations.
 *
 * Read these as promises. `supportsReferenceImage: true` means the adapter will
 * actually send your reference; a `false` makes `validateRequest` reject the request so
 * the UI hides the control rather than silently dropping the user's intent.
 */
function capabilitiesFor(modelId: OpenAIImageModelId): ModelCapabilities {
  const isPrecise = modelId === OPENAI_IMAGE_MODELS.precise;
  return {
    supportsStreaming: false,
    supportsToolCalls: false,
    // Both models CAN take reference images, but only through /images/edits, which
    // requires a mask or a multi-image payload. `sunburst` is the editing model.
    supportsReferenceImage: true,
    // No seed parameter exists on this endpoint. Declaring one would be a lie the UI
    // would act on by showing a "lock the seed" control that does nothing.
    supportsSeed: false,
    supportsNegativePrompt: false,
    // Inpainting is available via /images/edits with a mask.
    supportsInpainting: isPrecise,
    supportsTransparentBackground: true,
    // Multi-turn conversational editing lives in the Responses API image tool, not
    // this endpoint. The OAuth/SIWC path would provide it; the API-key path does not.
    supportsConversationalEdit: false,
    supportsCancellation: true,
    supportsQualityControl: true,
  };
}

function descriptorFor(modelId: OpenAIImageModelId, providerId: string): ModelDescriptor {
  const isPrecise = modelId === OPENAI_IMAGE_MODELS.precise;
  return {
    id: modelId,
    displayName: isPrecise
      ? "GPT Image 2.5 Sunburst (editing precision)"
      : "GPT Image 2.5 Flare (fast)",
    providerId,
    inputs: ["text", "image"],
    outputs: ["image"],
    limits: {
      maxPromptChars: 32_000,
      supportedSizes: [...SUPPORTED_SIZES],
      maxBatchSize: 10,
      maxLatencyMs: MAX_LATENCY_MS,
    },
    capabilities: capabilitiesFor(modelId),
    pricing: {
      basis: "per_image",
      currency: "USD",
      // Deliberately absent. Per-image price depends on size AND quality, so a single
      // number here would be wrong for most requests. `estimateCost` reports
      // `reliable: false` and the UI warns instead of inventing a figure.
      note: "Priced per image; varies by size and quality. Check the OpenAI pricing page for current rates.",
      source: "OpenAI image API documentation",
    },
    outputMimeTypes: [...SUPPORTED_FORMATS].map((f) => MIME_BY_FORMAT[f]),
    warnings: [
      `Documented worst-case latency is ${MAX_LATENCY_MS / 1000} seconds for a single image.`,
      "Prompts are screened by OpenAI's safety system. A blocked prompt will not succeed on retry.",
    ],
  };
}

// ---------------------------------------------------------------------------
// Response shapes
// ---------------------------------------------------------------------------

interface OpenAIImageData {
  readonly b64_json?: string;
  readonly url?: string;
  readonly revised_prompt?: string;
}

interface OpenAIModerationDetails {
  readonly moderation_stage?: string;
  readonly categories?: readonly string[];
}

interface OpenAIErrorBody {
  readonly type?: string;
  readonly code?: string;
  readonly message?: string;
  readonly param?: string;
  readonly moderation_details?: OpenAIModerationDetails;
}

interface OpenAIImageResponse {
  readonly created?: number;
  readonly data?: readonly OpenAIImageData[];
  readonly error?: OpenAIErrorBody;
  readonly usage?: {
    readonly input_tokens?: number;
    readonly output_tokens?: number;
  };
}

// ---------------------------------------------------------------------------
// Error normalisation
// ---------------------------------------------------------------------------

/**
 * Build the user-facing message for a moderation block.
 *
 * WHY `message` IS GENERIC AND `detail` IS SPECIFIC.
 * The moderation categories are a content-classification signal. They land in `detail`,
 * which is developer-facing and never rendered raw to a user. Echoing "sexual/violent"
 * back into the UI would (a) tell the user things about OpenAI's classifier that we
 * have no business relaying, and (b) be actively harmful in a shared or screen-recorded
 * context. The user gets an actionable statement instead: this prompt, change it.
 *
 * The category list IS logged in `detail` because a developer debugging a false
 * positive genuinely needs it — that is the difference between a report we can act on
 * and "it said no".
 */
function buildModerationMessage(details: OpenAIModerationDetails | undefined): {
  message: string;
  detail: string;
} {
  const stage = details?.moderation_stage ?? "unknown";
  const categories = details?.categories ?? [];

  return {
    message:
      "This prompt was declined by the provider's safety system. Retrying the same " +
      "prompt will be declined again — edit the prompt or the reference images and try once more.",
    detail: [
      `moderation_stage=${stage}`,
      `categories=${categories.length > 0 ? categories.join(",") : "(none reported)"}`,
    ].join(" "),
  };
}

/**
 * Map a non-2xx response onto the shared taxonomy.
 *
 * The retryable/NOT-retryable split is the whole point of this function, so each
 * branch states its reasoning rather than being a table lookup.
 */
export function normaliseOpenAIError(
  status: number,
  body: unknown,
  headers?: Headers,
): NormalisedError {
  const errorBody = extractError(body);
  const requestId = headers?.get("x-request-id") ?? undefined;

  // --- Moderation: deterministic refusal. NEVER retryable. -------------------
  if (errorBody?.code === "moderation_blocked" || errorBody?.type === "image_generation_user_error") {
    const { message, detail } = buildModerationMessage(errorBody.moderation_details);
    return {
      code: "moderation_blocked",
      message,
      // The decisive flags:
      retryable: false,
      userActionRequired: true,
      ...(requestId ? { providerRequestId: requestId } : {}),
      detail,
    };
  }

  // --- Authentication -------------------------------------------------------
  if (status === 401 || status === 403) {
    return {
      code: "invalid_credentials",
      message:
        "The API key was rejected. Check that it is current, has not been revoked, and " +
        "belongs to the right organisation.",
      retryable: false,
      userActionRequired: true,
      ...(requestId ? { providerRequestId: requestId } : {}),
      ...(errorBody?.message ? { detail: errorBody.message } : {}),
    };
  }

  // --- Rate limit: retryable, and the retry delay is knowable ---------------
  if (status === 429) {
    // Distinguish "too many requests" (transient) from "out of credit" (terminal).
    // OpenAI uses `insufficient_quota` for the latter, and it arrives as a 429.
    if (errorBody?.code === "insufficient_quota" || errorBody?.type === "insufficient_quota") {
      return {
        code: "insufficient_quota",
        message:
          "This account has no remaining quota or credit. Add billing details with the " +
          "provider, then try again.",
        // NOT retryable: no number of retries creates credit.
        retryable: false,
        userActionRequired: true,
        ...(requestId ? { providerRequestId: requestId } : {}),
        ...(errorBody?.message ? { detail: errorBody.message } : {}),
      };
    }

    const retryAfterMs = parseRetryAfter(headers?.get("retry-after"));
    return {
      code: "rate_limited",
      message: retryAfterMs
        ? `Rate limited by the provider. Retrying in about ${Math.ceil(retryAfterMs / 1000)} seconds.`
        : "Rate limited by the provider. This request can be retried shortly.",
      retryable: true,
      userActionRequired: false,
      ...(requestId ? { providerRequestId: requestId } : {}),
      ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
      ...(errorBody?.message ? { detail: errorBody.message } : {}),
    };
  }

  // --- Server-side faults: transient by nature ------------------------------
  if (status >= 500) {
    const retryAfterMs = parseRetryAfter(headers?.get("retry-after"));
    return {
      code: "provider_unavailable",
      message: "The provider had a server error. This is usually temporary.",
      retryable: true,
      userActionRequired: false,
      ...(requestId ? { providerRequestId: requestId } : {}),
      ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
      ...(errorBody?.message ? { detail: errorBody.message } : {}),
    };
  }

  // --- Quota also arrives as a 400 in some accounts -------------------------
  if (errorBody?.code === "insufficient_quota" || errorBody?.code === "billing_hard_limit_reached") {
    return {
      code: "insufficient_quota",
      message:
        "This account has reached its billing limit or has no remaining quota. Update " +
        "billing with the provider, then try again.",
      retryable: false,
      userActionRequired: true,
      ...(requestId ? { providerRequestId: requestId } : {}),
      ...(errorBody?.message ? { detail: errorBody.message } : {}),
    };
  }

  if (status === 404) {
    return {
      code: "model_not_found",
      message: "The provider does not recognise this model for your account.",
      retryable: false,
      userActionRequired: true,
      ...(requestId ? { providerRequestId: requestId } : {}),
      ...(errorBody?.message ? { detail: errorBody.message } : {}),
    };
  }

  if (status === 400 || status === 422) {
    return {
      code: "invalid_request",
      message: "The provider rejected this request. Check the size, quality and format settings.",
      retryable: false,
      userActionRequired: true,
      ...(requestId ? { providerRequestId: requestId } : {}),
      ...(errorBody?.message ? { detail: errorBody.message } : {}),
      ...(errorBody?.param ? { detail: `${errorBody.param}: ${errorBody.message ?? ""}` } : {}),
    };
  }

  return {
    code: "unknown",
    message: `The provider returned an unexpected status (${status}).`,
    retryable: status >= 500,
    userActionRequired: false,
    ...(requestId ? { providerRequestId: requestId } : {}),
    ...(errorBody?.message ? { detail: errorBody.message } : {}),
  };
}

function extractError(body: unknown): OpenAIErrorBody | undefined {
  if (typeof body !== "object" || body === null) return undefined;
  const candidate = (body as { error?: unknown }).error;
  if (typeof candidate !== "object" || candidate === null) return undefined;
  return candidate as OpenAIErrorBody;
}

/**
 * Parse `Retry-After` into milliseconds.
 *
 * The header is defined in two forms — delta-seconds and an HTTP-date — and providers
 * use both. Handling only the numeric form means occasionally ignoring the delay and
 * hammering a rate-limited endpoint, which is how a soft limit becomes a hard ban.
 */
export function parseRetryAfter(header: string | null | undefined): number | undefined {
  if (!header) return undefined;
  const trimmed = header.trim();
  if (trimmed.length === 0) return undefined;

  // delta-seconds. The sign is checked explicitly: `Date.parse("-5")` does not return
  // NaN on every engine, so a negative value could otherwise fall through to the
  // HTTP-date branch and be reported as a real delay. A negative delay is meaningless.
  if (/^\d+$/.test(trimmed)) {
    return Number(trimmed) * 1000;
  }

  // HTTP-date. Reject anything that looks numeric but is not a plain non-negative
  // integer, so junk like "-5" or "1e3" cannot be interpreted as a date.
  if (/^[+-]/.test(trimmed) || /^[\d.]+$/.test(trimmed)) return undefined;

  const asDate = Date.parse(trimmed);
  if (!Number.isNaN(asDate)) {
    const delta = asDate - Date.now();
    // A date in the past means "retry now"; surface 0 rather than a negative delay.
    return delta > 0 ? delta : 0;
  }

  return undefined;
}

/**
 * Whether a retry is worth attempting.
 *
 * Every retry loop in the application should consult this rather than checking
 * `error.retryable` directly, because there is one case where the two disagree: a
 * moderation block that some intermediary (a proxy, a gateway) has re-typed as a 5xx.
 * `retryable` follows the status code; this function follows the *semantics*.
 */
export function shouldAutoRetry(error: NormalisedError): boolean {
  if (error.code === "moderation_blocked") return false;
  if (error.code === "insufficient_quota") return false;
  if (error.code === "invalid_credentials") return false;
  if (error.userActionRequired) return false;
  return error.retryable;
}

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

export class OpenAIImagesAdapter implements ProviderAdapter {
  readonly id = OPENAI_IMAGES_PROVIDER_ID;
  readonly displayName = "OpenAI Images";
  readonly kind = "cloud" as const;

  readonly #fetch: FetchLike;
  readonly #baseUrl: string;
  readonly #clientRequestId: string | undefined;
  readonly #organisationId: string | undefined;
  readonly #allowLocalEndpoints: boolean;
  readonly #timeoutMs: number;

  constructor(options: OpenAIImagesAdapterOptions) {
    if (typeof options.fetchImpl !== "function") {
      throw new TypeError(
        "OpenAIImagesAdapter requires an explicit `fetchImpl`. Pass `globalThis.fetch` " +
          "in production; tests must pass a fake so no request leaves the process.",
      );
    }
    this.#fetch = options.fetchImpl;
    this.#baseUrl = (options.baseUrl ?? DEFAULT_OPENAI_BASE_URL).replace(/\/+$/, "");
    this.#clientRequestId = options.clientRequestId;
    this.#organisationId = options.organisationId;
    this.#allowLocalEndpoints = options.allowLocalEndpoints ?? true;
    this.#timeoutMs = options.timeoutMs ?? MAX_LATENCY_MS;
  }

  async discoverCapabilities(): Promise<ProviderCapabilities> {
    return {
      providerId: this.id,
      kind: "cloud",
      supportsStreaming: false,
      supportsAsyncJobs: false,
      supportsCancellation: true,
      requiresNetwork: true,
      isMock: false,
      notes: [
        "Image generation is synchronous over HTTP; large images can take up to 2 minutes.",
        "Requests are screened by OpenAI's moderation system before generation.",
        "Sign in with ChatGPT is NOT supported by this adapter: it is gated to selected commercial partners and cannot generate images.",
      ],
    };
  }

  async listModels(credentials?: ProviderCredentials): Promise<readonly ModelDescriptor[]> {
    // The image models are fixed and not listed by any endpoint, so this is a static
    // list. The provider id is taken from the credential context when supplied so the
    // descriptors stay consistent with the connection that produced them.
    void credentials;
    return [
      descriptorFor(OPENAI_IMAGE_MODELS.fast, this.id),
      descriptorFor(OPENAI_IMAGE_MODELS.precise, this.id),
    ];
  }

  /** Resolve the effective base URL for a call: credentials override the constructor. */
  #resolveBaseUrl(credentials: ProviderCredentials): string {
    const base = (credentials.baseUrl ?? this.#baseUrl).replace(/\/+$/, "");

    const assessment = assessBaseUrl(base, { allowLocal: this.#allowLocalEndpoints });
    if (!assessment.allowed && assessment.rejection) {
      throw new OpenAIConfigurationError(assessment.rejection.message);
    }
    return base;
  }

  #headers(credentials: ProviderCredentials): Record<string, string> {
    if (!credentials.apiKey) {
      throw new OpenAIConfigurationError(
        "No API key is configured for this connection. Add one in Settings \u2192 Providers.",
      );
    }
    return {
      "content-type": "application/json",
      authorization: `Bearer ${credentials.apiKey}`,
      ...(this.#organisationId ?? credentials.organisationId
        ? { "openai-organization": this.#organisationId ?? credentials.organisationId ?? "" }
        : {}),
      ...(this.#clientRequestId ? { "x-client-request-id": this.#clientRequestId } : {}),
      ...credentials.extraHeaders,
    };
  }

  /**
   * Cheap credential check.
   *
   * `GET /v1/models` is used rather than a real generation because validating on save
   * must not cost the user an image. A 401 here is definitive; a success proves the key
   * is live without spending anything.
   */
  async validateCredentials(
    credentials: ProviderCredentials,
  ): Promise<{ ok: true } | { ok: false; error: NormalisedError }> {
    let baseUrl: string;
    let headers: Record<string, string>;
    try {
      baseUrl = this.#resolveBaseUrl(credentials);
      headers = this.#headers(credentials);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        ok: false,
        error: {
          code: "invalid_credentials",
          message,
          retryable: false,
          userActionRequired: true,
          detail: message,
        },
      };
    }

    try {
      const response = await guardedFetch(
        { baseUrl, path: "models" },
        { allowLocal: this.#allowLocalEndpoints },
        asPlatformFetch(this.#fetch),
        { method: "GET", headers },
      );

      if (response.ok) return { ok: true };

      const body = await safeJson(response);
      return { ok: false, error: normaliseOpenAIError(response.status, body, response.headers) };
    } catch (error) {
      return { ok: false, error: this.normaliseError(error) };
    }
  }

  async estimateCost(
    request: GenerationRequest,
    model: ModelDescriptor,
  ): Promise<CostEstimate> {
    // Reported honestly as unreliable. Price is a function of size AND quality AND the
    // account's tier, and a wrong number presented confidently is worse than none:
    // the user would approve a spend based on it.
    return {
      reliable: false,
      currency: "USD",
      note:
        `OpenAI prices ${model.id} per image, and the rate depends on both size ` +
        `(${request.size ?? "1024x1024"}) and quality (${request.quality ?? "auto"}). ` +
        "Kinema cannot read live pricing for this endpoint, so no estimate is shown. " +
        "Check the provider's pricing page before a large batch.",
    };
  }

  validateRequest(request: GenerationRequest, model: ModelDescriptor): ValidationResult {
    const problems: string[] = [];
    const unsupportedFields: string[] = [];
    const adjustments: { field: string; from: unknown; to: unknown; reason: string }[] = [];

    if (!request.prompt || request.prompt.trim().length === 0) {
      problems.push("A prompt is required.");
    }

    if (request.prompt && model.limits.maxPromptChars !== undefined) {
      if (request.prompt.length > model.limits.maxPromptChars) {
        problems.push(
          `Prompt is ${request.prompt.length} characters; this model accepts at most ${model.limits.maxPromptChars}.`,
        );
      }
    }

    if (request.size !== undefined) {
      if (!SUPPORTED_SIZES.includes(request.size as SupportedSize)) {
        problems.push(
          `Size ${request.size} is not supported. Choose one of: ${SUPPORTED_SIZES.join(", ")}.`,
        );
      }
    }

    if (request.quality !== undefined) {
      if (!SUPPORTED_QUALITIES.includes(request.quality as SupportedQuality)) {
        problems.push(
          `Quality "${request.quality}" is not supported. Choose one of: ${SUPPORTED_QUALITIES.join(", ")}.`,
        );
      }
    }

    if (request.count !== undefined) {
      const max = model.limits.maxBatchSize ?? 10;
      if (request.count < 1 || request.count > max) {
        problems.push(`Requested ${request.count} images; this endpoint returns between 1 and ${max}.`);
      }
    }

    // No seed on this endpoint. Reject rather than silently dropping it, because a
    // dropped seed means the user's attempt at reproducibility quietly fails.
    if (request.seed !== undefined) {
      unsupportedFields.push("seed");
      problems.push(
        "This endpoint has no seed parameter, so runs cannot be made reproducible. " +
          "Remove the seed, or use a provider that supports it.",
      );
    }

    if (request.negativePrompt) {
      unsupportedFields.push("negativePrompt");
      problems.push(
        "This endpoint has no negative-prompt parameter. Describe what you want in the prompt instead.",
      );
    }

    if (request.maskAssetId && !model.capabilities.supportsInpainting) {
      unsupportedFields.push("maskAssetId");
      problems.push(
        `${model.displayName} does not support masked inpainting. Use ${OPENAI_IMAGE_MODELS.precise}.`,
      );
    }

    if (request.referenceAssetIds && request.referenceAssetIds.length > 0) {
      if (!model.capabilities.supportsReferenceImage) {
        unsupportedFields.push("referenceAssetIds");
        problems.push("This model cannot use reference images.");
      } else if (model.id === OPENAI_IMAGE_MODELS.fast && request.referenceAssetIds.length > 1) {
        // Honest limitation rather than a silent truncation.
        problems.push(
          `${OPENAI_IMAGE_MODELS.fast} accepts a single reference image. ` +
            `Use ${OPENAI_IMAGE_MODELS.precise} for multiple references.`,
        );
      }
    }

    // Transparent background is only legal for png/webp. Adjusting with a visible
    // explanation beats failing, because the user's intent is unambiguous.
    const outputFormat = readOutputFormat(request.providerOptions);
    if (request.providerOptions?.["background"] === "transparent") {
      if (outputFormat !== undefined && !TRANSPARENT_BACKGROUND_FORMATS.includes(outputFormat)) {
        adjustments.push({
          field: "providerOptions.format",
          from: outputFormat,
          to: "png",
          reason: 'A transparent background requires png or webp; switched the output format to png.',
        });
      }
    }

    return {
      valid: problems.length === 0,
      unsupportedFields,
      problems,
      ...(adjustments.length > 0 ? { adjustments } : {}),
    };
  }

  /**
   * Submit a generation.
   *
   * The endpoint is synchronous, so this performs the whole request and returns a
   * terminal handle; `pollOrSubscribe` then rebuilds the cached result. That keeps the
   * `ProviderAdapter` contract intact without pretending there is a polling loop.
   */
  async submitJob(
    request: GenerationRequest,
    credentials: ProviderCredentials,
    signal?: CancellationSignal,
  ): Promise<JobHandle> {
    if (signal?.aborted) return { providerJobId: "", status: "cancelled" };

    const models = await this.listModels();
    const model =
      models.find((m) => m.id === request.modelId) ??
      models.find((m) => m.id === OPENAI_IMAGE_MODELS.fast);
    if (!model) throw new Error("No OpenAI image model is available.");

    const validation = this.validateRequest(request, model);
    if (!validation.valid) {
      throw new OpenAIRequestError(validation.problems.join(" "), validation);
    }

    const usesEdits = (request.referenceAssetIds?.length ?? 0) > 0 || request.maskAssetId !== undefined;

    const result = usesEdits
      ? await this.#generateWithEdits(request, credentials, model, signal)
      : await this.#generate(request, credentials, model, signal);

    // Cache by handle so pollOrSubscribe can return it. A Map rather than a single
    // slot: a caller may hold several handles at once.
    this.#completed.set(result.provenance.providerJobId ?? "", result);

    return {
      providerJobId: result.provenance.providerJobId ?? "",
      status: result.status,
    };
  }

  readonly #completed = new Map<string, GenerationResult>();

  async pollOrSubscribe(
    handle: JobHandle,
    _credentials: ProviderCredentials,
    signal?: CancellationSignal,
  ): Promise<GenerationResult> {
    void signal;
    const cached = this.#completed.get(handle.providerJobId);
    if (!cached) {
      throw new Error(
        `No completed result for job "${handle.providerJobId}". This adapter is ` +
          "synchronous: submitJob performs the request, so pollOrSubscribe only " +
          "returns an already-completed result.",
      );
    }
    this.#completed.delete(handle.providerJobId);
    return cached;
  }

  async cancelJob(): Promise<boolean> {
    // The request is a single blocking HTTP call. Aborting it is done through the
    // AbortSignal passed to submitJob; there is no server-side job to cancel, and
    // claiming otherwise would be a false capability.
    return false;
  }

  /** Parse a raw OpenAI image response into the shared result shape. */
  normaliseResult(raw: unknown, request: GenerationRequest): GenerationResult {
    const body = raw as OpenAIImageResponse;
    const format = readOutputFormat(request.providerOptions) ?? "png";
    const mimeType = formatToMimeType(format);
    const requestedSize = request.size as SupportedSize | undefined;
    const dimensions =
      requestedSize && requestedSize in DIMENSIONS_BY_SIZE
        ? DIMENSIONS_BY_SIZE[requestedSize]
        : { width: 1024, height: 1024 };

    const outputs: GenerationOutput[] = [];
    for (const item of body.data ?? []) {
      if (item.b64_json) {
        const bytes = Buffer.from(item.b64_json, "base64");
        outputs.push({
          kind: "image",
          data: bytes,
          mimeType,
          width: dimensions.width,
          height: dimensions.height,
        });
      } else if (item.url) {
        // Not expected from gpt-image-*, but handled so a compatible gateway that
        // returns URLs still works rather than producing an empty result.
        outputs.push({
          kind: "image",
          url: item.url,
          mimeType,
          width: dimensions.width,
          height: dimensions.height,
        });
      }
    }

    return {
      status: outputs.length > 0 ? "succeeded" : "failed",
      outputs,
      provenance: {
        providerId: this.id,
        modelId: request.modelId,
        prompt: request.prompt,
        createdAt: new Date().toISOString(),
        parameters: {
          size: request.size ?? "1024x1024",
          quality: request.quality ?? "auto",
          format,
          ...(body.data?.[0]?.revised_prompt
            ? { revisedPrompt: body.data[0].revised_prompt }
            : {}),
        },
      },
      ...(body.usage
        ? {
            usage: {
              // `exactOptionalPropertyTypes` rejects assigning a possibly-undefined
              // value to an optional field, and it is right to: the provider may omit
              // either count, and emitting `inputTokens: undefined` would serialise as
              // an explicit null in JSON rather than being absent.
              ...(body.usage.input_tokens !== undefined
                ? { inputTokens: body.usage.input_tokens }
                : {}),
              ...(body.usage.output_tokens !== undefined
                ? { outputTokens: body.usage.output_tokens }
                : {}),
              images: outputs.length,
            },
          }
        : { usage: { images: outputs.length } }),
    };
  }

  normaliseError(error: unknown): NormalisedError {
    if (error instanceof OpenAIConfigurationError) {
      return {
        code: "invalid_credentials",
        message: error.message,
        retryable: false,
        userActionRequired: true,
        detail: error.message,
      };
    }
    if (error instanceof OpenAIMalformedResponseError) {
      return {
        code: "provider_unavailable",
        message:
          "The provider returned a response in an unexpected format. This is usually a " +
          "transient problem with the provider.",
        retryable: true,
        userActionRequired: false,
        detail: error.message,
      };
    }
    if (error instanceof OpenAIRequestError) {
      return {
        code: "invalid_request",
        message: error.message,
        retryable: false,
        userActionRequired: true,
        detail: error.message,
      };
    }
    if (error instanceof Error && error.name === "AbortError") {
      return {
        code: "timeout",
        message: `The provider did not respond within ${Math.round(this.#timeoutMs / 1000)} seconds.`,
        retryable: true,
        userActionRequired: false,
        detail: "Request aborted by timeout.",
      };
    }
    if (error instanceof Error && error.name === "SsrfBlockedError") {
      return {
        code: "invalid_request",
        message: error.message,
        retryable: false,
        userActionRequired: true,
        detail: error.message,
      };
    }
    const message = error instanceof Error ? error.message : String(error);
    return {
      code: "network_error",
      message: "Could not reach the provider. Check the network connection and the base URL.",
      retryable: true,
      userActionRequired: false,
      detail: message,
    };
  }

  // -- private -------------------------------------------------------------

  async #generate(
    request: GenerationRequest,
    credentials: ProviderCredentials,
    model: ModelDescriptor,
    signal?: CancellationSignal,
  ): Promise<GenerationResult> {
    const payload = this.#buildPayload(request, model);
    return this.#post("images/generations", payload, request, credentials, signal);
  }

  async #generateWithEdits(
    request: GenerationRequest,
    credentials: ProviderCredentials,
    model: ModelDescriptor,
    signal?: CancellationSignal,
  ): Promise<GenerationResult> {
    // EDITING PATH.
    //
    // /images/edits is multipart/form-data, not JSON, because it carries image bytes.
    // It is only reachable when the caller has already resolved reference/mask asset
    // ids to bytes and placed them in providerOptions — asset resolution belongs to the
    // asset store, not the adapter, and inventing a resolution strategy here would
    // reach into another subsystem.
    //
    // If the bytes are absent this throws a precise error rather than silently falling
    // back to text-only generation, which would drop the user's reference image and
    // produce an image that does not match their character.
    const images = request.providerOptions?.["referenceImagesBase64"];
    const mask = request.providerOptions?.["maskBase64"];

    if (!Array.isArray(images) || images.length === 0) {
      throw new OpenAIRequestError(
        "Reference images were requested but their bytes are not available to the " +
          "adapter. Resolve the asset ids to base64 in providerOptions.referenceImagesBase64 " +
          "before submitting. Kinema will not silently generate without the reference.",
      );
    }

    const form = new FormData();
    form.set("model", model.id);
    form.set("prompt", request.prompt);
    if (request.size) form.set("size", request.size);
    if (request.quality) form.set("quality", request.quality);
    if (request.count) form.set("n", String(request.count));
    const background = request.providerOptions?.["background"];
    if (typeof background === "string") form.set("background", background);
    const format = readOutputFormat(request.providerOptions);
    if (format) form.set("output_format", format);

    images.forEach((entry: unknown, index: number) => {
      if (typeof entry === "string") {
        const bytes = Buffer.from(entry, "base64");
        form.append(
          "image[]",
          new Blob([bytes], { type: "image/png" }),
          `reference-${index}.png`,
        );
      }
    });

    if (typeof mask === "string") {
      const maskBytes = Buffer.from(mask, "base64");
      form.append("mask", new Blob([maskBytes], { type: "image/png" }), "mask.png");
    }

    return this.#post("images/edits", form, request, credentials, signal, true);
  }

  #buildPayload(
    request: GenerationRequest,
    model: ModelDescriptor,
  ): Record<string, unknown> {
    const payload: Record<string, unknown> = {
      model: model.id,
      prompt: request.prompt,
      // Explicit rather than defaulted: `b64_json` is what this adapter parses, and
      // relying on the provider's default would break silently if it ever changed.
      size: request.size ?? "1024x1024",
      quality: request.quality ?? "auto",
      n: Math.max(1, Math.min(request.count ?? 1, model.limits.maxBatchSize ?? 10)),
    };

    const format = readOutputFormat(request.providerOptions);
    if (format) payload["output_format"] = format;

    const background = request.providerOptions?.["background"];
    if (background === "transparent") {
      payload["background"] = "transparent";
      // Enforce the documented format restriction rather than letting the provider
      // reject the combination with a less clear message.
      const effective = typeof format === "string" ? format : "png";
      if (!TRANSPARENT_BACKGROUND_FORMATS.includes(effective)) {
        payload["output_format"] = "png";
      }
    } else if (typeof background === "string") {
      payload["background"] = background;
    }

    return payload;
  }

  /** Shared POST path for both endpoints, with response parsing and error mapping. */
  async #post(
    path: string,
    body: Record<string, unknown> | FormData,
    request: GenerationRequest,
    credentials: ProviderCredentials,
    signal?: CancellationSignal,
    isMultipart = false,
  ): Promise<GenerationResult> {
    const baseUrl = this.#resolveBaseUrl(credentials);
    const headers = this.#headers(credentials);
    if (isMultipart) {
      // The browser/undici runtime sets the multipart boundary; setting the header by
      // hand would produce a boundary mismatch and a confusing 400.
      delete headers["content-type"];
    }

    // Compose our own abort signal with the caller's, so a cancel stops the request
    // and therefore stops the spend.
    //
    // THE ORDER HERE MATTERS, and getting it wrong loses cancellations. `submitJob`
    // performs an `await` (model resolution) before reaching this point, so there is a
    // real window in which the caller can abort before the listener below exists. If we
    // only registered a listener, that abort would fire into the void and the request
    // would then be made — and paid for — despite the user having cancelled it.
    //
    // Registering first and then re-checking `aborted` closes the window: an abort that
    // lands after registration fires the listener, and one that landed before it is
    // caught by the re-check. Both paths converge on an aborted controller.
    const controller = new AbortController();
    if (signal) {
      signal.addEventListener("abort", () => controller.abort(), { once: true });
      if (signal.aborted) controller.abort();
      if (controller.signal.aborted) throw new DOMException("Aborted", "AbortError");
    }
    const timer = setTimeout(() => controller.abort(), this.#timeoutMs);

    try {
      const response = await guardedFetch(
        { baseUrl, path },
        { allowLocal: this.#allowLocalEndpoints },
        asPlatformFetch(this.#fetch),
        {
          method: "POST",
          headers,
          body: isMultipart ? (body as FormData) : JSON.stringify(body),
          signal: controller.signal,
        },
      );

      if (!response.ok) {
        const errorBody = await safeJson(response);
        const normalised = normaliseOpenAIError(response.status, errorBody, response.headers);
        throw new OpenAIHttpError(normalised);
      }

      const parsed = await safeJson(response);
      if (!isOpenAIImageResponse(parsed)) {
        throw new OpenAIMalformedResponseError(
          "Response did not contain a `data` array with `b64_json` or `url` entries.",
        );
      }

      const result = this.normaliseResult(parsed, request);
      if (result.outputs.length === 0) {
        throw new OpenAIMalformedResponseError(
          "The provider reported success but returned no image data.",
        );
      }
      return result;
    } catch (error) {
      // `OpenAIHttpError` is an internal carrier for an already-normalised error.
      // Unwrap it so callers receive the plain `NormalisedError` the taxonomy
      // promises, rather than a transport-specific wrapper they would have to know
      // about. Everything else (malformed response, abort, network failure) propagates
      // unchanged and is mapped by `normaliseError` at the boundary.
      if (error instanceof OpenAIHttpError) throw error.error;
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class OpenAIConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OpenAIConfigurationError";
  }
}

export class OpenAIRequestError extends Error {
  readonly validation: ValidationResult | undefined;
  constructor(message: string, validation?: ValidationResult) {
    super(message);
    this.name = "OpenAIRequestError";
    this.validation = validation;
  }
}

export class OpenAIMalformedResponseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OpenAIMalformedResponseError";
  }
}

/** Carries an already-normalised error out of the request path. */
export class OpenAIHttpError extends Error {
  readonly error: NormalisedError;
  constructor(error: NormalisedError) {
    super(error.message);
    this.name = "OpenAIHttpError";
    this.error = error;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function readOutputFormat(
  providerOptions: Readonly<Record<string, unknown>> | undefined,
): string | undefined {
  const value = providerOptions?.["format"] ?? providerOptions?.["outputFormat"];
  return typeof value === "string" ? value : undefined;
}

/**
 * Map a requested output format onto its MIME type, defaulting to PNG.
 *
 * An unrecognised format falls back rather than throwing: this runs while normalising
 * a successful response, and failing there would discard an image the user has already
 * paid for.
 */
function formatToMimeType(format: string): string {
  if (format === "png" || format === "jpeg" || format === "webp") {
    return MIME_BY_FORMAT[format];
  }
  return MIME_BY_FORMAT.png;
}

function isOpenAIImageResponse(value: unknown): value is OpenAIImageResponse {
  if (typeof value !== "object" || value === null) return false;
  const data = (value as { data?: unknown }).data;
  if (!Array.isArray(data)) return false;
  return data.every(
    (entry) =>
      typeof entry === "object" &&
      entry !== null &&
      (typeof (entry as OpenAIImageData).b64_json === "string" ||
        typeof (entry as OpenAIImageData).url === "string"),
  );
}

/**
 * Parse JSON without throwing.
 *
 * A non-JSON body is itself a signal (an HTML error page from a proxy, an empty 502),
 * and losing the status code because `response.json()` threw would make a diagnosable
 * failure undiagnosable.
 */
async function safeJson(response: Response): Promise<unknown> {
  try {
    const text = await response.text();
    if (text.trim().length === 0) return undefined;
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}