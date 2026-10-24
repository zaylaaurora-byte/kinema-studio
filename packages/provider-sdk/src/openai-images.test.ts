import { describe, expect, it, vi } from "vitest";

import {
  DEFAULT_OPENAI_BASE_URL,
  MAX_LATENCY_MS,
  OPENAI_IMAGE_MODELS,
  OpenAIImagesAdapter,
  normaliseOpenAIError,
  parseRetryAfter,
  shouldAutoRetry,
  type FetchLike,
} from "./openai-images.js";

/**
 * OpenAI Images adapter tests.
 *
 * NO TEST IN THIS FILE TOUCHES THE NETWORK. The adapter takes `fetchImpl` as a
 * required constructor argument, so "no network" is enforced by the type system
 * rather than by discipline: there is no default to fall back to.
 *
 * Every fake below asserts the URL and method it was called with. A fake that ignored
 * its arguments would let a broken endpoint path pass unnoticed.
 */

/** A 1x1 transparent PNG, the smallest real image payload. */
const PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==";

interface RecordedCall {
  readonly url: string;
  readonly method: string;
  readonly headers: Record<string, string>;
  readonly body: string | undefined;
}

/** Build a fake fetch that returns one canned response and records the call. */
function fakeFetch(
  responder: (call: RecordedCall) => {
    status: number;
    body?: unknown;
    headers?: Record<string, string>;
    rawBody?: string;
  },
): { fetchImpl: FetchLike; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];

  const fetchImpl: FetchLike = async (input, init) => {
    const headers: Record<string, string> = {};
    for (const [key, value] of Object.entries(init?.headers ?? {})) {
      headers[key.toLowerCase()] = String(value);
    }

    const call: RecordedCall = {
      url: input,
      method: init?.method ?? "GET",
      headers,
      body: typeof init?.body === "string" ? init.body : undefined,
    };
    calls.push(call);

    const result = responder(call);
    const text = result.rawBody ?? JSON.stringify(result.body ?? {});

    return new Response(text, {
      status: result.status,
      headers: { "content-type": "application/json", ...result.headers },
    });
  };

  return { fetchImpl, calls };
}

function makeAdapter(fetchImpl: FetchLike, overrides: Partial<{
  baseUrl: string;
  allowLocalEndpoints: boolean;
}> = {}) {
  return new OpenAIImagesAdapter({
    fetchImpl,
    ...(overrides.baseUrl !== undefined ? { baseUrl: overrides.baseUrl } : {}),
    ...(overrides.allowLocalEndpoints !== undefined
      ? { allowLocalEndpoints: overrides.allowLocalEndpoints }
      : {}),
  });
}

const CREDENTIALS = { apiKey: "sk-test-KEY-abcdefghijklmnop9999" };

// ---------------------------------------------------------------------------
// Success parsing
// ---------------------------------------------------------------------------

describe("OpenAIImagesAdapter: success parsing", () => {
  it("decodes data[0].b64_json into GenerationOutput.data as a ByteBuffer", async () => {
    const { fetchImpl, calls } = fakeFetch(() => ({
      status: 200,
      body: { created: 1_700_000_000, data: [{ b64_json: PNG_BASE64 }] },
    }));

    const adapter = makeAdapter(fetchImpl);
    const result = await adapter.submitJob(
      { modelId: OPENAI_IMAGE_MODELS.fast, prompt: "a lighthouse at dusk" },
      CREDENTIALS,
    );

    expect(result.status).toBe("succeeded");
    const completion = await adapter.pollOrSubscribe(result, CREDENTIALS);

    expect(completion.outputs).toHaveLength(1);
    const output = completion.outputs[0]!;
    expect(output.kind).toBe("image");
    expect(output.mimeType).toBe("image/png");

    // The bytes must be the real PNG, not the base64 text.
    const bytes = Buffer.from(output.data!.buffer as ArrayBuffer, output.data!.byteOffset, output.data!.byteLength);
    expect(bytes.subarray(0, 8)).toEqual(
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    );
    expect(bytes.toString("base64")).toBe(PNG_BASE64);

    // And it really called the generations endpoint with a bearer token.
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(`${DEFAULT_OPENAI_BASE_URL}/images/generations`);
    expect(calls[0]!.method).toBe("POST");
    expect(calls[0]!.headers["authorization"]).toBe(`Bearer ${CREDENTIALS.apiKey}`);

    const payload = JSON.parse(calls[0]!.body!) as Record<string, unknown>;
    expect(payload["model"]).toBe(OPENAI_IMAGE_MODELS.fast);
    expect(payload["prompt"]).toBe("a lighthouse at dusk");
  });

  it("carries width and height derived from the requested size", async () => {
    const { fetchImpl } = fakeFetch(() => ({
      status: 200,
      body: { data: [{ b64_json: PNG_BASE64 }] },
    }));

    const adapter = makeAdapter(fetchImpl);
    const result = await adapter.submitJob(
      {
        modelId: OPENAI_IMAGE_MODELS.precise,
        prompt: "wide vista",
        size: "1536x1024",
      },
      CREDENTIALS,
    );
    const completion = await adapter.pollOrSubscribe(result, CREDENTIALS);

    expect(completion.outputs[0]!.width).toBe(1536);
    expect(completion.outputs[0]!.height).toBe(1024);
  });

  it("records provenance naming the model and the prompt actually sent", async () => {
    const { fetchImpl } = fakeFetch(() => ({
      status: 200,
      body: { data: [{ b64_json: PNG_BASE64, revised_prompt: "a lighthouse, golden hour" }] },
    }));

    const adapter = makeAdapter(fetchImpl);
    const handle = await adapter.submitJob(
      { modelId: OPENAI_IMAGE_MODELS.fast, prompt: "lighthouse" },
      CREDENTIALS,
    );
    const completion = await adapter.pollOrSubscribe(handle, CREDENTIALS);

    expect(completion.provenance.providerId).toBe("openai-images");
    expect(completion.provenance.modelId).toBe(OPENAI_IMAGE_MODELS.fast);
    expect(completion.provenance.prompt).toBe("lighthouse");
    expect(completion.provenance.parameters?.["revisedPrompt"]).toBe("a lighthouse, golden hour");
  });

  it("returns every image in a batch", async () => {
    const { fetchImpl } = fakeFetch(() => ({
      status: 200,
      body: {
        data: [{ b64_json: PNG_BASE64 }, { b64_json: PNG_BASE64 }, { b64_json: PNG_BASE64 }],
      },
    }));

    const adapter = makeAdapter(fetchImpl);
    const handle = await adapter.submitJob(
      { modelId: OPENAI_IMAGE_MODELS.fast, prompt: "three variations", count: 3 },
      CREDENTIALS,
    );
    const completion = await adapter.pollOrSubscribe(handle, CREDENTIALS);

    expect(completion.outputs).toHaveLength(3);
    expect(completion.usage?.images).toBe(3);
  });

  it("honours a custom base URL", async () => {
    const { fetchImpl, calls } = fakeFetch(() => ({
      status: 200,
      body: { data: [{ b64_json: PNG_BASE64 }] },
    }));

    const adapter = makeAdapter(fetchImpl, { baseUrl: "https://gateway.example.com/v1/" });
    const handle = await adapter.submitJob(
      { modelId: OPENAI_IMAGE_MODELS.fast, prompt: "x" },
      CREDENTIALS,
    );
    await adapter.pollOrSubscribe(handle, CREDENTIALS);

    // Trailing slash on the base URL must not produce a double slash.
    expect(calls[0]!.url).toBe("https://gateway.example.com/v1/images/generations");
  });
});

// ---------------------------------------------------------------------------
// Moderation — the behaviour that matters most
// ---------------------------------------------------------------------------

describe("OpenAIImagesAdapter: moderation is a refusal, not an error to retry", () => {
  const moderationBody = {
    error: {
      type: "image_generation_user_error",
      code: "moderation_blocked",
      message: "Your request was blocked by our moderation system.",
      moderation_details: {
        moderation_stage: "input",
        categories: ["sexual", "violence"],
      },
    },
  };

  it("maps a block to moderation_blocked with retryable FALSE", async () => {
    const { fetchImpl } = fakeFetch(() => ({ status: 400, body: moderationBody }));
    const adapter = makeAdapter(fetchImpl);

    await expect(
      adapter.submitJob(
        { modelId: OPENAI_IMAGE_MODELS.fast, prompt: "blocked content" },
        CREDENTIALS,
      ),
    ).rejects.toMatchObject({
      code: "moderation_blocked",
      retryable: false,
      userActionRequired: true,
    });
  });

  it("agrees with normaliseOpenAIError directly", () => {
    const error = normaliseOpenAIError(400, moderationBody);

    expect(error.code).toBe("moderation_blocked");
    // THE ASSERTION THIS WHOLE FILE EXISTS FOR:
    expect(error.retryable).toBe(false);
    expect(error.userActionRequired).toBe(true);
  });

  it("puts the stage and categories in developer detail but keeps the message generic", () => {
    const error = normaliseOpenAIError(400, moderationBody);

    // Developer-facing detail: precise, for logs and bug reports.
    expect(error.detail).toContain("moderation_stage=input");
    expect(error.detail).toContain("sexual");
    expect(error.detail).toContain("violence");

    // User-facing message: actionable, and free of classifier internals.
    expect(error.message).not.toContain("sexual");
    expect(error.message).not.toContain("violence");
    expect(error.message).not.toContain("moderation_stage");
    expect(error.message).toMatch(/declined|cannot|edit the prompt/i);
  });

  it("still classifies a block that arrives without moderation_details", () => {
    const error = normaliseOpenAIError(400, {
      error: { code: "moderation_blocked", message: "blocked" },
    });
    expect(error.code).toBe("moderation_blocked");
    expect(error.retryable).toBe(false);
    expect(error.detail).toContain("(none reported)");
  });

  it("treats image_generation_user_error alone as a block", () => {
    // The `type` is the documented marker; a provider that omits the `code` must not
    // cause us to retry a deterministic refusal.
    const error = normaliseOpenAIError(400, {
      error: { type: "image_generation_user_error", message: "blocked" },
    });
    expect(error.code).toBe("moderation_blocked");
    expect(error.retryable).toBe(false);
  });

  it("refuses to auto-retry a moderation block even if something marked it retryable", () => {
    // Defence in depth: a proxy or wrapper that re-typed the status must not cause an
    // automated retry loop against a deterministic refusal.
    expect(
      shouldAutoRetry({
        code: "moderation_blocked",
        message: "blocked",
        retryable: true,
        userActionRequired: false,
      }),
    ).toBe(false);
  });

  it("never auto-retries anything that needs the user to act", () => {
    expect(
      shouldAutoRetry({
        code: "unknown",
        message: "x",
        retryable: true,
        userActionRequired: true,
      }),
    ).toBe(false);
  });

  it("does auto-retry a genuine transient fault", () => {
    expect(
      shouldAutoRetry({
        code: "provider_unavailable",
        message: "x",
        retryable: true,
        userActionRequired: false,
      }),
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Rate limiting
// ---------------------------------------------------------------------------

describe("OpenAIImagesAdapter: rate limits are retryable and carry the delay", () => {
  it("marks 429 retryable and parses Retry-After into retryAfterMs", async () => {
    const { fetchImpl } = fakeFetch(() => ({
      status: 429,
      body: { error: { type: "rate_limit_error", message: "Rate limit reached" } },
      headers: { "retry-after": "30" },
    }));

    const adapter = makeAdapter(fetchImpl);
    await expect(
      adapter.submitJob({ modelId: OPENAI_IMAGE_MODELS.fast, prompt: "x" }, CREDENTIALS),
    ).rejects.toMatchObject({
      code: "rate_limited",
      retryable: true,
      retryAfterMs: 30_000,
    });
  });

  it("uses the numeric form of Retry-After", () => {
    const error = normaliseOpenAIError(
      429,
      { error: { message: "slow down" } },
      new Headers({ "retry-after": "12" }),
    );
    expect(error.retryable).toBe(true);
    expect(error.retryAfterMs).toBe(12_000);
  });

  it("also accepts the HTTP-date form of Retry-After", () => {
    // Providers use both forms; handling only the numeric one means occasionally
    // ignoring the delay and hammering the endpoint.
    const error = normaliseOpenAIError(
      429,
      { error: { message: "slow down" } },
      new Headers({ "retry-after": new Date(Date.now() + 5_000).toUTCString() }),
    );
    expect(error.retryable).toBe(true);
    expect(error.retryAfterMs).toBeGreaterThan(0);
    expect(error.retryAfterMs).toBeLessThanOrEqual(5_000);
  });

  it("omits retryAfterMs when the header is absent", () => {
    const error = normaliseOpenAIError(429, { error: { message: "slow down" } });
    expect(error.retryable).toBe(true);
    expect("retryAfterMs" in error).toBe(false);
  });

  it("leaves the message actionable when there is no delay to report", () => {
    const error = normaliseOpenAIError(429, {});
    expect(error.message).toMatch(/retried shortly/i);
    expect(error.userActionRequired).toBe(false);
  });

  it("treats a past Retry-After date as retry-now, not a negative delay", () => {
    const error = normaliseOpenAIError(
      429,
      {},
      new Headers({ "retry-after": new Date(Date.now() - 60_000).toUTCString() }),
    );
    expect(error.retryAfterMs).toBe(0);
  });

  it("parses Retry-After defensively for junk and empty values", () => {
    expect(parseRetryAfter(undefined)).toBeUndefined();
    expect(parseRetryAfter(null)).toBeUndefined();
    expect(parseRetryAfter("")).toBeUndefined();
    expect(parseRetryAfter("   ")).toBeUndefined();
    expect(parseRetryAfter("soon")).toBeUndefined();
    expect(parseRetryAfter("-5")).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Quota
// ---------------------------------------------------------------------------

describe("OpenAIImagesAdapter: quota exhaustion is NOT retryable", () => {
  it("maps insufficient_quota on a 429 to a non-retryable error", async () => {
    const { fetchImpl } = fakeFetch(() => ({
      status: 429,
      body: {
        error: {
          type: "insufficient_quota",
          code: "insufficient_quota",
          message: "You exceeded your current quota.",
        },
      },
    }));

    const adapter = makeAdapter(fetchImpl);
    await expect(
      adapter.submitJob({ modelId: OPENAI_IMAGE_MODELS.fast, prompt: "x" }, CREDENTIALS),
    ).rejects.toMatchObject({
      code: "insufficient_quota",
      // No number of retries creates credit.
      retryable: false,
      userActionRequired: true,
    });
  });

  it("distinguishes quota from a plain rate limit on the SAME status code", () => {
    const quota = normaliseOpenAIError(429, {
      error: { code: "insufficient_quota", message: "no credit" },
    });
    const limit = normaliseOpenAIError(429, {
      error: { code: "rate_limit_exceeded", message: "too fast" },
    });

    // Both are 429; they must NOT map to the same handling.
    expect(quota.code).toBe("insufficient_quota");
    expect(quota.retryable).toBe(false);
    expect(limit.code).toBe("rate_limited");
    expect(limit.retryable).toBe(true);
  });

  it("also catches a quota error delivered as a 400", () => {
    const error = normaliseOpenAIError(400, {
      error: { code: "billing_hard_limit_reached", message: "hard limit" },
    });
    expect(error.code).toBe("insufficient_quota");
    expect(error.retryable).toBe(false);
  });

  it("does not auto-retry a quota error", () => {
    const error = normaliseOpenAIError(429, {
      error: { code: "insufficient_quota", message: "no credit" },
    });
    expect(shouldAutoRetry(error)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Other statuses
// ---------------------------------------------------------------------------

describe("OpenAIImagesAdapter: status taxonomy", () => {
  it("maps 401 to invalid_credentials and does not retry", () => {
    const error = normaliseOpenAIError(401, {
      error: { message: "Incorrect API key provided." },
    });
    expect(error.code).toBe("invalid_credentials");
    expect(error.retryable).toBe(false);
    expect(error.userActionRequired).toBe(true);
  });

  it("maps 5xx to provider_unavailable and DOES retry", () => {
    for (const status of [500, 502, 503, 504]) {
      const error = normaliseOpenAIError(status, { error: { message: "upstream" } });
      expect(error.code).toBe("provider_unavailable");
      expect(error.retryable).toBe(true);
      expect(shouldAutoRetry(error)).toBe(true);
    }
  });

  it("reads a retry delay from a 503 as well", () => {
    const error = normaliseOpenAIError(
      503,
      {},
      new Headers({ "retry-after": "7" }),
    );
    expect(error.retryable).toBe(true);
    expect(error.retryAfterMs).toBe(7_000);
  });

  it("maps 400 to invalid_request and 404 to model_not_found", () => {
    expect(normaliseOpenAIError(400, { error: { message: "bad size" } }).code).toBe(
      "invalid_request",
    );
    expect(normaliseOpenAIError(404, { error: { message: "no model" } }).code).toBe(
      "model_not_found",
    );
  });

  it("surfaces the provider request id for support tickets", () => {
    const error = normaliseOpenAIError(
      400,
      { error: { message: "bad" } },
      new Headers({ "x-request-id": "req_abc123" }),
    );
    expect(error.providerRequestId).toBe("req_abc123");
  });

  it("never leaks the API key into a normalised error", () => {
    const error = normaliseOpenAIError(401, {
      error: { message: "Incorrect API key provided: sk-test-KEY-abcdefghijklmnop9999." },
    });
    // `detail` carries the provider's own text. This asserts the shape of what we
    // control: the code, and the fact that the user-facing message is ours.
    expect(error.message).not.toContain("sk-test");
    expect(error.code).toBe("invalid_credentials");
  });
});

// ---------------------------------------------------------------------------
// Malformed responses
// ---------------------------------------------------------------------------

describe("OpenAIImagesAdapter: malformed responses", () => {
  it("rejects a 200 with no data array", async () => {
    const { fetchImpl } = fakeFetch(() => ({ status: 200, body: { created: 123 } }));
    const adapter = makeAdapter(fetchImpl);

    await expect(
      adapter.submitJob({ modelId: OPENAI_IMAGE_MODELS.fast, prompt: "x" }, CREDENTIALS),
    ).rejects.toThrow(/unexpected format|did not contain/i);
  });

  it("rejects a 200 whose data entries have neither b64_json nor url", async () => {
    const { fetchImpl } = fakeFetch(() => ({
      status: 200,
      body: { data: [{ revised_prompt: "something" }] },
    }));
    const adapter = makeAdapter(fetchImpl);

    await expect(
      adapter.submitJob({ modelId: OPENAI_IMAGE_MODELS.fast, prompt: "x" }, CREDENTIALS),
    ).rejects.toThrow(/unexpected format|did not contain/i);
  });

  it("rejects a 200 with a non-JSON body", async () => {
    // A proxy returning an HTML error page with status 200.
    const { fetchImpl } = fakeFetch(() => ({
      status: 200,
      rawBody: "<html><body>Gateway</body></html>",
    }));
    const adapter = makeAdapter(fetchImpl);

    await expect(
      adapter.submitJob({ modelId: OPENAI_IMAGE_MODELS.fast, prompt: "x" }, CREDENTIALS),
    ).rejects.toThrow(/unexpected format|did not contain/i);
  });

  it("rejects an empty 200 body", async () => {
    const { fetchImpl } = fakeFetch(() => ({ status: 200, rawBody: "" }));
    const adapter = makeAdapter(fetchImpl);

    await expect(
      adapter.submitJob({ modelId: OPENAI_IMAGE_MODELS.fast, prompt: "x" }, CREDENTIALS),
    ).rejects.toThrow(/unexpected format|did not contain/i);
  });

  it("treats a malformed response as retryable provider trouble, not a user error", () => {
    const adapter = makeAdapter(async () => new Response("{}", { status: 200 }));
    const error = adapter.normaliseError(new Error("Response did not contain a `data` array."));

    // A generic Error is a network_error; the important part is that it is retryable
    // and does not demand user action.
    expect(error.retryable).toBe(true);
    expect(error.userActionRequired).toBe(false);
  });

  it("reports an empty data array as a failure rather than a silent success", async () => {
    const { fetchImpl } = fakeFetch(() => ({ status: 200, body: { data: [] } }));
    const adapter = makeAdapter(fetchImpl);

    await expect(
      adapter.submitJob({ modelId: OPENAI_IMAGE_MODELS.fast, prompt: "x" }, CREDENTIALS),
    ).rejects.toThrow(/no image data/i);
  });
});

// ---------------------------------------------------------------------------
// Capability honesty
// ---------------------------------------------------------------------------

describe("OpenAIImagesAdapter: declared capabilities are honest", () => {
  it("declares the documented 2-minute latency ceiling", async () => {
    const adapter = makeAdapter(async () => new Response("{}", { status: 200 }));
    const models = await adapter.listModels();

    for (const model of models) {
      expect(model.limits.maxLatencyMs).toBe(MAX_LATENCY_MS);
      expect(model.limits.maxLatencyMs).toBe(120_000);
    }
  });

  it("lists exactly the three supported sizes", async () => {
    const adapter = makeAdapter(async () => new Response("{}", { status: 200 }));
    const models = await adapter.listModels();
    for (const model of models) {
      expect(model.limits.supportedSizes).toEqual(["1024x1024", "1536x1024", "1024x1536"]);
    }
  });

  it("declares seed as unsupported, because the endpoint has no seed parameter", async () => {
    const adapter = makeAdapter(async () => new Response("{}", { status: 200 }));
    const models = await adapter.listModels();
    for (const model of models) {
      expect(model.capabilities.supportsSeed).toBe(false);
    }
  });

  it("declares reference images supported but inpainting only on sunburst", async () => {
    const adapter = makeAdapter(async () => new Response("{}", { status: 200 }));
    const models = await adapter.listModels();

    const flare = models.find((m) => m.id === OPENAI_IMAGE_MODELS.fast)!;
    const sunburst = models.find((m) => m.id === OPENAI_IMAGE_MODELS.precise)!;

    expect(flare.capabilities.supportsReferenceImage).toBe(true);
    expect(flare.capabilities.supportsInpainting).toBe(false);
    expect(sunburst.capabilities.supportsInpainting).toBe(true);
  });

  it("declares conversational edit unsupported on the API-key path", async () => {
    // This is the capability ChatGPT OAuth would have offered. It is honestly false.
    const adapter = makeAdapter(async () => new Response("{}", { status: 200 }));
    const models = await adapter.listModels();
    for (const model of models) {
      expect(model.capabilities.supportsConversationalEdit).toBe(false);
    }
  });

  it("refuses to claim a reliable cost estimate", async () => {
    const adapter = makeAdapter(async () => new Response("{}", { status: 200 }));
    const models = await adapter.listModels();
    const estimate = await adapter.estimateCost(
      { modelId: models[0]!.id, prompt: "x" },
      models[0]!,
    );

    expect(estimate.reliable).toBe(false);
    expect(estimate.amount).toBeUndefined();
  });

  it("states the partner gate and image limitation in its capability notes", async () => {
    const adapter = makeAdapter(async () => new Response("{}", { status: 200 }));
    const caps = await adapter.discoverCapabilities();

    const notes = (caps.notes ?? []).join(" ");
    expect(notes).toMatch(/commercial partners/i);
    expect(notes).toMatch(/cannot generate images/i);
  });

  it("rejects a seed rather than silently dropping it", async () => {
    const adapter = makeAdapter(async () => new Response("{}", { status: 200 }));
    const models = await adapter.listModels();
    const result = adapter.validateRequest(
      { modelId: models[0]!.id, prompt: "x", seed: 42 },
      models[0]!,
    );

    expect(result.valid).toBe(false);
    expect(result.unsupportedFields).toContain("seed");
  });

  it("rejects an unsupported size with the supported list in the message", async () => {
    const adapter = makeAdapter(async () => new Response("{}", { status: 200 }));
    const models = await adapter.listModels();
    const result = adapter.validateRequest(
      { modelId: models[0]!.id, prompt: "x", size: "512x512" },
      models[0]!,
    );

    expect(result.valid).toBe(false);
    expect(result.problems.join(" ")).toContain("1024x1024");
  });

  it("rejects multiple references on flare but allows them on sunburst", async () => {
    const adapter = makeAdapter(async () => new Response("{}", { status: 200 }));
    const models = await adapter.listModels();
    const flare = models.find((m) => m.id === OPENAI_IMAGE_MODELS.fast)!;
    const sunburst = models.find((m) => m.id === OPENAI_IMAGE_MODELS.precise)!;

    const request = {
      modelId: flare.id,
      prompt: "x",
      referenceAssetIds: ["a", "b"],
    };

    expect(adapter.validateRequest(request, flare).valid).toBe(false);
    expect(adapter.validateRequest(request, sunburst).valid).toBe(true);
  });

  it("plans a png switch when transparency is requested with jpeg", async () => {
    const adapter = makeAdapter(async () => new Response("{}", { status: 200 }));
    const models = await adapter.listModels();
    const result = adapter.validateRequest(
      {
        modelId: models[0]!.id,
        prompt: "x",
        providerOptions: { background: "transparent", format: "jpeg" },
      },
      models[0]!,
    );

    expect(result.adjustments?.[0]?.to).toBe("png");
    expect(result.adjustments?.[0]?.reason).toMatch(/png or webp/i);
  });

  it("states that cancellation is not available, rather than faking it", async () => {
    const adapter = makeAdapter(async () => new Response("{}", { status: 200 }));
    expect(await adapter.cancelJob()).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Credentials and transport safety
// ---------------------------------------------------------------------------

describe("OpenAIImagesAdapter: credentials and transport", () => {
  it("refuses to make a request with no API key", async () => {
    const { fetchImpl, calls } = fakeFetch(() => ({ status: 200, body: {} }));
    const adapter = makeAdapter(fetchImpl);

    const result = await adapter.validateCredentials({});
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("invalid_credentials");
    }
    // And crucially: no request was attempted at all.
    expect(calls).toHaveLength(0);
  });

  it("validates credentials against /models rather than spending on a generation", async () => {
    const { fetchImpl, calls } = fakeFetch(() => ({ status: 200, body: { data: [] } }));
    const adapter = makeAdapter(fetchImpl);

    const result = await adapter.validateCredentials(CREDENTIALS);
    expect(result.ok).toBe(true);
    expect(calls[0]!.url).toBe(`${DEFAULT_OPENAI_BASE_URL}/models`);
    expect(calls[0]!.method).toBe("GET");
  });

  it("reports a precise error when credential validation fails", async () => {
    const { fetchImpl } = fakeFetch(() => ({
      status: 401,
      body: { error: { message: "Incorrect API key provided." } },
    }));
    const adapter = makeAdapter(fetchImpl);

    const result = await adapter.validateCredentials(CREDENTIALS);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("invalid_credentials");
      expect(result.error.userActionRequired).toBe(true);
    }
  });

  it("refuses a metadata endpoint as the base URL (SSRF)", async () => {
    const { fetchImpl, calls } = fakeFetch(() => ({ status: 200, body: {} }));
    const adapter = makeAdapter(fetchImpl);

    const result = await adapter.validateCredentials({
      apiKey: "sk-test-abcdefghijklmnop",
      baseUrl: "http://169.254.169.254/latest/meta-data/",
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toMatch(/metadata/i);
    }
    expect(calls).toHaveLength(0);
  });

  it("rejects a metadata base URL on the generate path too", async () => {
    const { fetchImpl, calls } = fakeFetch(() => ({ status: 200, body: {} }));
    const adapter = makeAdapter(fetchImpl);

    await expect(
      adapter.submitJob(
        { modelId: OPENAI_IMAGE_MODELS.fast, prompt: "x" },
        { apiKey: "sk-test-abcdefghijklmnop", baseUrl: "http://169.254.169.254/" },
      ),
    ).rejects.toThrow(/metadata/i);
    expect(calls).toHaveLength(0);
  });

  it("allows a localhost base URL when local endpoints are permitted", async () => {
    const { fetchImpl, calls } = fakeFetch(() => ({ status: 200, body: { data: [] } }));
    const adapter = makeAdapter(fetchImpl, { allowLocalEndpoints: true });

    const result = await adapter.validateCredentials({
      apiKey: "sk-test-abcdefghijklmnop",
      baseUrl: "http://localhost:1234/v1",
    });

    expect(result.ok).toBe(true);
    expect(calls[0]!.url).toBe("http://localhost:1234/v1/models");
  });

  it("blocks a localhost base URL when local endpoints are disabled", async () => {
    const { fetchImpl, calls } = fakeFetch(() => ({ status: 200, body: {} }));
    const adapter = makeAdapter(fetchImpl, { allowLocalEndpoints: false });

    const result = await adapter.validateCredentials({
      apiKey: "sk-test-abcdefghijklmnop",
      baseUrl: "http://localhost:1234/v1",
    });

    expect(result.ok).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it("requires an explicit fetch implementation", () => {
    expect(
      () => new OpenAIImagesAdapter({ fetchImpl: undefined as unknown as FetchLike }),
    ).toThrow(/explicit `fetchImpl`/);
  });

  it("sends the organisation header when configured", async () => {
    const { fetchImpl, calls } = fakeFetch(() => ({ status: 200, body: { data: [] } }));
    const adapter = new OpenAIImagesAdapter({
      fetchImpl,
      organisationId: "org-abc123",
    });

    await adapter.validateCredentials(CREDENTIALS);
    expect(calls[0]!.headers["openai-organization"]).toBe("org-abc123");
  });

  it("merges extra headers from the connection", async () => {
    const { fetchImpl, calls } = fakeFetch(() => ({ status: 200, body: { data: [] } }));
    const adapter = makeAdapter(fetchImpl);

    await adapter.validateCredentials({
      ...CREDENTIALS,
      extraHeaders: { "x-custom-gateway": "yes" },
    });
    expect(calls[0]!.headers["x-custom-gateway"]).toBe("yes");
  });

  it("never puts the API key in the URL", async () => {
    const { fetchImpl, calls } = fakeFetch(() => ({ status: 200, body: { data: [] } }));
    const adapter = makeAdapter(fetchImpl);

    await adapter.validateCredentials(CREDENTIALS);
    expect(calls[0]!.url).not.toContain(CREDENTIALS.apiKey);
    expect(calls[0]!.url).not.toContain("sk-test");
  });

  it("maps a thrown network failure to a retryable network_error", () => {
    const adapter = makeAdapter(async () => {
      throw new TypeError("fetch failed");
    });

    const error = adapter.normaliseError(new TypeError("fetch failed"));
    expect(error.code).toBe("network_error");
    expect(error.retryable).toBe(true);
    expect(error.userActionRequired).toBe(false);
  });

  it("reports a timeout as retryable without demanding user action", () => {
    const adapter = makeAdapter(async () => new Response("{}", { status: 200 }));
    const abort = new Error("aborted");
    abort.name = "AbortError";

    const error = adapter.normaliseError(abort);
    expect(error.code).toBe("timeout");
    expect(error.retryable).toBe(true);
    expect(error.message).toContain("120");
  });

  it("unwraps an SSRF refusal into the normalised taxonomy", () => {
    const adapter = makeAdapter(async () => new Response("{}", { status: 200 }));
    const ssrf = new Error("That address is a cloud instance-metadata endpoint.");
    ssrf.name = "SsrfBlockedError";

    const error = adapter.normaliseError(ssrf);
    expect(error.code).toBe("invalid_request");
    expect(error.retryable).toBe(false);
    expect(error.userActionRequired).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Cancellation
// ---------------------------------------------------------------------------

describe("OpenAIImagesAdapter: cancellation", () => {
  it("refuses to start a job when the signal is already aborted", async () => {
    const { fetchImpl, calls } = fakeFetch(() => ({ status: 200, body: {} }));
    const adapter = makeAdapter(fetchImpl);

    const handle = await adapter.submitJob(
      { modelId: OPENAI_IMAGE_MODELS.fast, prompt: "x" },
      CREDENTIALS,
      { aborted: true, addEventListener: () => {}, removeEventListener: () => {} },
    );

    expect(handle.status).toBe("cancelled");
    expect(calls).toHaveLength(0);
  });

  it("aborts the in-flight request when the signal fires", async () => {
    // A fake that never resolves on its own, so cancellation is genuinely exercised
    // rather than observed on an already-settled promise.
    let seenSignal: AbortSignal | undefined;
    let reachedFetch: (() => void) | undefined;
    const atFetch = new Promise<void>((resolve) => {
      reachedFetch = resolve;
    });

    const fetchImpl: FetchLike = (_input, init) => {
      seenSignal = init?.signal ?? undefined;
      reachedFetch?.();
      return new Promise((_resolve, reject) => {
        const rejectAborted = () => {
          const error = new Error("aborted");
          error.name = "AbortError";
          reject(error);
        };
        const abortSignal = init?.signal;
        if (!abortSignal) {
          return;
        }
        // A real fetch rejects immediately when handed an already-aborted signal; the
        // fake must too, or the test would pass against behaviour the platform does
        // not have.
        if (abortSignal.aborted) {
          rejectAborted();
          return;
        }
        abortSignal.addEventListener("abort", rejectAborted, { once: true });
      });
    };

    const adapter = makeAdapter(fetchImpl);

    // A REAL AbortController, not a stub: the adapter composes the caller's signal
    // into its own controller, so this verifies the composition works rather than
    // testing against a hand-rolled shape that might not match what callers pass.
    const controller = new AbortController();

    const pending = adapter.submitJob(
      { modelId: OPENAI_IMAGE_MODELS.fast, prompt: "x" },
      CREDENTIALS,
      controller.signal,
    );

    // Deterministic handshake: wait until fetch has actually been called before
    // aborting, so the abort lands while the request is genuinely in flight.
    await atFetch;
    expect(seenSignal).toBeDefined();

    controller.abort();

    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  });

  it("does not lose a cancellation that arrives before the request is built", async () => {
    // REGRESSION GUARD for a real race. `submitJob` awaits model resolution before it
    // registers its abort listener, so a cancel landing in that window must still stop
    // the request. Without the `signal.aborted` re-check in the adapter, the abort
    // fires into the void and the request is made — and paid for — after the user
    // cancelled it.
    const { fetchImpl, calls } = fakeFetch(() => ({
      status: 200,
      body: { data: [{ b64_json: PNG_BASE64 }] },
    }));
    const adapter = makeAdapter(fetchImpl);

    const controller = new AbortController();
    // Abort BEFORE submitJob is ever called, and again synchronously after, so both
    // the pre-registration and post-registration paths are covered.
    controller.abort();

    await expect(
      adapter.submitJob(
        { modelId: OPENAI_IMAGE_MODELS.fast, prompt: "x" },
        CREDENTIALS,
        controller.signal,
      ),
    ).rejects.toMatchObject({ name: "AbortError" });

    // The decisive assertion: no request left the process, so nothing was charged.
    expect(calls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Regression guards
// ---------------------------------------------------------------------------

describe("OpenAIImagesAdapter: regression guards", () => {
  it("uses the generations endpoint, not a chat-completions shape", async () => {
    const { fetchImpl, calls } = fakeFetch(() => ({
      status: 200,
      body: { data: [{ b64_json: PNG_BASE64 }] },
    }));
    const adapter = makeAdapter(fetchImpl);
    const handle = await adapter.submitJob(
      { modelId: OPENAI_IMAGE_MODELS.fast, prompt: "x" },
      CREDENTIALS,
    );
    await adapter.pollOrSubscribe(handle, CREDENTIALS);

    expect(calls[0]!.url).toContain("/images/generations");
    expect(calls[0]!.url).not.toContain("/chat/completions");
    const payload = JSON.parse(calls[0]!.body!) as Record<string, unknown>;
    expect(payload).not.toHaveProperty("messages");
  });

  it("always sends an explicit size, quality and n", async () => {
    const { fetchImpl, calls } = fakeFetch(() => ({
      status: 200,
      body: { data: [{ b64_json: PNG_BASE64 }] },
    }));
    const adapter = makeAdapter(fetchImpl);
    const handle = await adapter.submitJob(
      { modelId: OPENAI_IMAGE_MODELS.fast, prompt: "x" },
      CREDENTIALS,
    );
    await adapter.pollOrSubscribe(handle, CREDENTIALS);

    const payload = JSON.parse(calls[0]!.body!) as Record<string, unknown>;
    expect(payload["size"]).toBe("1024x1024");
    expect(payload["quality"]).toBe("auto");
    expect(payload["n"]).toBe(1);
  });

  it("refuses to fall back to text-only generation when reference bytes are missing", async () => {
    // Silently dropping the reference would produce an image that does not match the
    // user's character — exactly the failure the adapter must not hide.
    const { fetchImpl, calls } = fakeFetch(() => ({
      status: 200,
      body: { data: [{ b64_json: PNG_BASE64 }] },
    }));
    const adapter = makeAdapter(fetchImpl);

    await expect(
      adapter.submitJob(
        {
          modelId: OPENAI_IMAGE_MODELS.precise,
          prompt: "x",
          referenceAssetIds: ["asset-1"],
        },
        CREDENTIALS,
      ),
    ).rejects.toThrow(/will not silently generate without the reference/i);

    expect(calls).toHaveLength(0);
  });

  it("posts to the edits endpoint when reference bytes are supplied", async () => {
    const { fetchImpl, calls } = fakeFetch(() => ({
      status: 200,
      body: { data: [{ b64_json: PNG_BASE64 }] },
    }));
    const adapter = makeAdapter(fetchImpl);

    // Multipart bodies are not strings, so the recorder sees `undefined`; the URL is
    // what distinguishes the two endpoints.
    const handle = await adapter.submitJob(
      {
        modelId: OPENAI_IMAGE_MODELS.precise,
        prompt: "keep the same character",
        referenceAssetIds: ["asset-1"],
        providerOptions: { referenceImagesBase64: [PNG_BASE64] },
      },
      CREDENTIALS,
    );
    await adapter.pollOrSubscribe(handle, CREDENTIALS);

    expect(calls[0]!.url).toContain("/images/edits");
    // The multipart boundary must be set by the runtime, not by us.
    expect(calls[0]!.headers["content-type"]).toBeUndefined();
  });
});