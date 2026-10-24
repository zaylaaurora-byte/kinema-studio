/**
 * Provider adapter contract.
 *
 * This is the central abstraction of Kinema: it is what lets a creator bring any
 * model — a cloud API, a local inference server, or a mock — without the rest of the
 * application knowing the difference.
 *
 * Two rules shape everything below:
 *
 * 1. NO FALSE CAPABILITY. Providers differ enormously. An adapter must declare what it
 *    can actually do, and `validateRequest` must reject what it cannot, rather than
 *    silently dropping a parameter the user asked for. The spec is explicit: "never
 *    fabricate unsupported parameters."
 *
 * 2. COST BEFORE ACTION. `estimateCost` runs before `submitJob`. If a reliable
 *    estimate is impossible, the adapter says so rather than guessing, so the UI can
 *    warn the user instead of surprising them.
 */

// ---------------------------------------------------------------------------
// Runtime-agnostic primitives
// ---------------------------------------------------------------------------

/**
 * Cancellation signal, declared structurally rather than by referencing the DOM or
 * Node type.
 *
 * Why: this package must compile for the browser, Node and a worker without pulling in
 * a DOM lib (which would wrongly allow `document` in server code). A real
 * `AbortSignal` satisfies this shape, so callers pass one directly — but tests can
 * pass a trivial stub without constructing a real signal.
 */
export interface CancellationSignal {
  readonly aborted: boolean;
  addEventListener(type: "abort", listener: () => void, options?: { once?: boolean }): void;
  removeEventListener(type: "abort", listener: () => void): void;
}

/**
 * Byte buffer for generated media, declared structurally so this package does not
 * need Node's or the browser's concrete `Buffer`/`Uint8Array` typings.
 */
export interface ByteBuffer {
  readonly byteLength: number;
  readonly buffer: ArrayBufferLike;
  readonly byteOffset: number;
}

// ---------------------------------------------------------------------------
// Capabilities
// ---------------------------------------------------------------------------

/** What a model can consume or produce. */
export type Modality = "text" | "image" | "audio" | "video" | "embedding";

export type ProviderKind = "mock" | "cloud" | "local" | "custom";

/**
 * A single model exposed by a provider.
 *
 * Deliberately descriptive rather than aspirational: if a provider cannot accept a
 * seed, `supportsSeed` is false and the UI hides that control.
 */
export interface ModelDescriptor {
  /** Provider-local model id, e.g. "gpt-image-2.5-flare". */
  readonly id: string;
  readonly displayName: string;
  readonly providerId: string;

  readonly inputs: readonly Modality[];
  readonly outputs: readonly Modality[];

  /**
   * Pixel dimensions or token limits this model accepts.
   * Kept permissive because providers express these wildly differently.
   */
  readonly limits: ModelLimits;

  /**
   * Capability flags. Every one of these is a real question a creator asks, and a
   * false value is a promise we must not break by pretending otherwise.
   */
  readonly capabilities: ModelCapabilities;

  readonly pricing: PricingDescriptor;

  /** Output MIME types, e.g. "image/png". */
  readonly outputMimeTypes: readonly string[];

  /** Provider-documented caveats worth surfacing before the user spends money. */
  readonly warnings?: readonly string[];
}

export interface ModelLimits {
  readonly maxPromptChars?: number;
  readonly maxOutputTokens?: number;
  readonly supportedSizes?: readonly string[];
  /** Upper bound on images/takes returned by one request. */
  readonly maxBatchSize?: number;
  /** Documented worst-case latency, ms. OpenAI image models reach ~120000. */
  readonly maxLatencyMs?: number;
}

/**
 * Capability flags.
 *
 * `supportsReferenceImage` and `supportsSeed` matter most: they are the only
 * mechanisms a provider offers for the product's core promise of character
 * continuity. Where they are false, the application must fall back to
 * prompt-and-composite strategies rather than implying consistency it cannot deliver.
 */
export interface ModelCapabilities {
  readonly supportsStreaming: boolean;
  readonly supportsToolCalls: boolean;
  readonly supportsReferenceImage: boolean;
  readonly supportsSeed: boolean;
  readonly supportsNegativePrompt: boolean;
  readonly supportsInpainting: boolean;
  readonly supportsTransparentBackground: boolean;
  /**
   * Multi-turn, conversation-anchored editing. This is the strongest continuity tool
   * available; the OpenAI Responses API image tool provides it.
   */
  readonly supportsConversationalEdit: boolean;
  readonly supportsCancellation: boolean;
  readonly supportsQualityControl: boolean;
}

/**
 * How a provider charges.
 *
 * `unknown` is a first-class value on purpose. Many self-hosted and community
 * endpoints have no published price, and inventing one would corrupt any cost display
 * built on top of it.
 */
export interface PricingDescriptor {
  readonly basis: "per_image" | "per_token" | "per_second" | "per_request" | "free" | "unknown";
  readonly currency?: "USD" | "GBP" | "EUR";
  /** Price in the smallest sensible unit for the basis, e.g. USD per image. */
  readonly unitPrice?: number;
  /** Human-readable explanation shown in the UI. */
  readonly note?: string;
  /**
   * Provenance of the figure: when and where it was obtained. Prices change, and a
   * stale number presented as fact is worse than no number.
   */
  readonly source?: string;
  readonly verifiedAt?: string;
}

// ---------------------------------------------------------------------------
// Credentials
// ---------------------------------------------------------------------------

/**
 * Credentials for a provider connection.
 *
 * This type is used on the server. Keys must never be serialised into an API response
 * or written to a log — see SECURITY.md.
 */
export interface ProviderCredentials {
  readonly apiKey?: string;
  readonly baseUrl?: string;
  readonly organisationId?: string;
  readonly extraHeaders?: Readonly<Record<string, string>>;
}

/** Safe, non-secret summary of a stored connection. Returned to clients. */
export interface ProviderConnectionSummary {
  readonly id: string;
  readonly providerId: string;
  readonly label: string;
  readonly kind: ProviderKind;
  readonly baseUrl?: string;
  /** Last 4 characters only, for recognition. Never the full key. */
  readonly keyFingerprint?: string;
  readonly validatedAt?: string;
  readonly status: "unvalidated" | "valid" | "invalid" | "expired";
}

// ---------------------------------------------------------------------------
// Requests and results
// ---------------------------------------------------------------------------

/**
 * A generation request.
 *
 * Fields are optional because providers accept different subsets. `validateRequest`
 * is what enforces the difference — never the caller guessing.
 */
export interface GenerationRequest {
  readonly modelId: string;
  readonly prompt: string;
  readonly negativePrompt?: string;
  readonly seed?: number;
  readonly size?: string;
  readonly quality?: string;
  readonly count?: number;
  /** Reference images for identity/style continuity, as stored asset ids. */
  readonly referenceAssetIds?: readonly string[];
  readonly maskAssetId?: string;

  /** Text-generation controls. */
  readonly maxOutputTokens?: number;
  readonly temperature?: number;
  readonly stream?: boolean;
  /** Requested structured output, as a JSON Schema. */
  readonly responseSchema?: unknown;

  /** Audio-generation controls. */
  readonly voiceId?: string;

  /**
   * Anchor a request to an earlier one for multi-turn consistency.
   * Maps to the Responses API `previous_response_id`.
   */
  readonly previousJobId?: string;

  /** Provider-specific passthrough, validated by `validateRequest` first. */
  readonly providerOptions?: Readonly<Record<string, unknown>>;
}

/** Result of validating a request against a model's real capabilities. */
export interface ValidationResult {
  readonly valid: boolean;
  /** Fields the model cannot honour. Non-empty means `valid` is false. */
  readonly unsupportedFields: readonly string[];
  /** Human-readable, actionable reasons suitable for display. */
  readonly problems: readonly string[];
  /** Fields silently adjusted, with an explanation. */
  readonly adjustments?: readonly { field: string; from: unknown; to: unknown; reason: string }[];
}

export interface CostEstimate {
  readonly amount?: number;
  readonly currency?: "USD" | "GBP" | "EUR";
  /** False when the provider publishes no reliable price. */
  readonly reliable: boolean;
  readonly note?: string;
}

/**
 * Handle for an in-flight job. Providers may be synchronous (mock, some image APIs)
 * or asynchronous (queued render services).
 */
export interface JobHandle {
  readonly providerJobId: string;
  readonly status: JobStatus;
  /** Polling is the fallback when a provider cannot call back. */
  readonly pollAfterMs?: number;
}

export type JobStatus =
  | "queued"
  | "running"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "unknown";

/** A generated output, normalised across providers. */
export interface GenerationOutput {
  readonly kind: "image" | "text" | "audio" | "video";
  /** Raw bytes when the provider returned inline data (base64). */
  readonly data?: ByteBuffer;
  /** Remote URL when the provider returned a link. */
  readonly url?: string;
  readonly mimeType: string;
  readonly width?: number;
  readonly height?: number;
  readonly durationSeconds?: number;
  readonly text?: string;
  /** Provider-side identifier, for provenance and multi-turn anchoring. */
  readonly providerAssetId?: string;
}

export interface GenerationResult {
  readonly status: JobStatus;
  readonly outputs: readonly GenerationOutput[];
  /** What actually generated this, recorded for provenance. */
  readonly provenance: Provenance;
  readonly usage?: TokenUsage;
}

/**
 * Provenance for every generated asset.
 *
 * Required by the product spec: the system must be able to say which model produced a
 * given asset, and replace that asset without destroying approved work.
 */
export interface Provenance {
  readonly providerId: string;
  readonly modelId: string;
  /** The prompt actually sent, after any normalisation. */
  readonly prompt: string;
  readonly seed?: number;
  readonly createdAt: string;
  /** Provider request id, for support and debugging. */
  readonly providerRequestId?: string;
  readonly providerJobId?: string;
  readonly parameters?: Readonly<Record<string, unknown>>;
}

export interface TokenUsage {
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly images?: number;
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/**
 * Normalised error taxonomy.
 *
 * The distinction that matters most is `retryable`. Retrying a moderation block or a
 * quota error wastes the user's time and money; retrying a transient 5xx does not.
 * OpenAI returns `error.code = "moderation_blocked"` for the former.
 */
export type NormalisedErrorCode =
  | "invalid_credentials"
  | "insufficient_quota"
  | "rate_limited"
  | "moderation_blocked"
  | "invalid_request"
  | "model_not_found"
  | "unsupported_capability"
  | "timeout"
  | "provider_unavailable"
  | "cancelled"
  | "network_error"
  | "unknown";

export interface NormalisedError {
  readonly code: NormalisedErrorCode;
  readonly message: string;
  /** Whether a retry could plausibly succeed unchanged. */
  readonly retryable: boolean;
  /** Whether the *user* must change something (prompt, size, key) before retrying. */
  readonly userActionRequired: boolean;
  readonly providerRequestId?: string;
  /** Developer-facing detail. Never shown raw to end users. */
  readonly detail?: string;
  readonly retryAfterMs?: number;
}

// ---------------------------------------------------------------------------
// The adapter interface
// ---------------------------------------------------------------------------

/**
 * Every provider integration implements this. The method set mirrors the product
 * specification's `ProviderAdapter`, with typed results and an explicit streaming
 * path.
 */
export interface ProviderAdapter {
  /** Stable identifier, e.g. "openai-images". */
  readonly id: string;
  readonly displayName: string;
  readonly kind: ProviderKind;

  /** What this provider supports, overall. */
  discoverCapabilities(): Promise<ProviderCapabilities>;

  /** Models currently available. */
  listModels(): Promise<readonly ModelDescriptor[]>;

  /**
   * Confirm credentials work. Returns a normalised error rather than throwing, so the
   * settings UI can display a precise reason.
   */
  validateCredentials(
    credentials: ProviderCredentials,
  ): Promise<{ ok: true } | { ok: false; error: NormalisedError }>;

  /** Estimate spend before dispatch. */
  estimateCost(
    request: GenerationRequest,
    model: ModelDescriptor,
  ): Promise<CostEstimate>;

  /** Reject requests the model cannot honour. */
  validateRequest(
    request: GenerationRequest,
    model: ModelDescriptor,
  ): ValidationResult;

  /** Begin a job. */
  submitJob(
    request: GenerationRequest,
    credentials: ProviderCredentials,
    signal?: CancellationSignal,
  ): Promise<JobHandle>;

  /**
   * Wait for completion by polling or subscribing, whichever the provider offers.
   * Implementations should honour `signal` so a cancelled job stops costing money.
   */
  pollOrSubscribe(
    handle: JobHandle,
    credentials: ProviderCredentials,
    signal?: CancellationSignal,
  ): Promise<GenerationResult>;

  /** Best-effort cancellation. Providers vary; report honestly if unsupported. */
  cancelJob(handle: JobHandle, credentials: ProviderCredentials): Promise<boolean>;

  /** Map a provider payload onto the shared output shape. */
  normaliseResult(raw: unknown, request: GenerationRequest): GenerationResult;

  /** Map any thrown value onto the shared error taxonomy. */
  normaliseError(error: unknown): NormalisedError;
}

export interface ProviderCapabilities {
  readonly providerId: string;
  readonly kind: ProviderKind;
  readonly supportsStreaming: boolean;
  readonly supportsAsyncJobs: boolean;
  readonly supportsCancellation: boolean;
  readonly requiresNetwork: boolean;
  /** True when the provider is the built-in offline mock. */
  readonly isMock: boolean;
  readonly notes?: readonly string[];
}