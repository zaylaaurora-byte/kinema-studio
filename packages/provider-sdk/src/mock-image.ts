import { createHash } from "node:crypto";

import type {
  CancellationSignal,
  CostEstimate,
  GenerationOutput,
  GenerationRequest,
  GenerationResult,
  JobHandle,
  ModelDescriptor,
  NormalisedError,
  ProviderAdapter,
  ProviderCapabilities,
  ProviderCredentials,
  ValidationResult,
} from "@kinema/types";

/**
 * Offline mock image provider.
 *
 * Purpose: the entire application must be developable and testable without paid API
 * calls. The product spec requires this outright — "Build feature flags and mocked
 * provider adapters first so development does not require paid API calls" — and CI
 * depends on it, since CI has no secrets.
 *
 * This is deliberately NOT a fake that pretends to be a real model. It generates a
 * real, valid, deterministic PNG from the prompt. That means downstream code —
 * thumbnail generation, asset storage, timeline composition, video encoding — is
 * exercised for real rather than stubbed.
 *
 * Determinism matters: the same prompt and seed produce byte-identical output, so
 * visual-regression tests and cache behaviour can be tested properly.
 */

const MODEL_ID = "mock-image-v1";

/**
 * Minimal PNG encoder.
 *
 * Hand-rolled rather than pulling a dependency into the provider SDK: the mock must
 * stay dependency-free so that `pnpm install` works offline and CI stays fast. It
 * emits a genuine, spec-compliant PNG that any decoder can read.
 */
function encodePng(width: number, height: number, rgba: Buffer): Buffer {
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    const rowStart = y * (width * 4 + 1);
    raw[rowStart] = 0; // filter type: none
    rgba.copy(raw, rowStart + 1, y * width * 4, (y + 1) * width * 4);
  }

  const idat = zlibDeflate(raw);

  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type: RGBA
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // interlace

  return Buffer.concat([
    signature,
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", idat),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

function pngChunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const typeAndData = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typeAndData) >>> 0, 0);
  return Buffer.concat([length, typeAndData, crc]);
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (const byte of buf) {
    c = CRC_TABLE[(c ^ byte) & 0xff]! ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

/**
 * Store-only DEFLATE stream (BTYPE=00).
 *
 * A literal implementation of RFC 1951 uncompressed blocks. Avoids a zlib dependency
 * while still producing a valid stream, at the cost of size — irrelevant for a mock.
 */
function zlibDeflate(data: Buffer): Buffer {
  const blocks: Buffer[] = [];
  const MAX = 65535;

  for (let offset = 0; offset < data.length || offset === 0; offset += MAX) {
    const slice = data.subarray(offset, Math.min(offset + MAX, data.length));
    const isFinal = offset + MAX >= data.length;
    const header = Buffer.alloc(5);
    header[0] = isFinal ? 1 : 0;
    header.writeUInt16LE(slice.length, 1);
    header.writeUInt16LE(~slice.length & 0xffff, 3);
    blocks.push(header, slice);
    if (isFinal) break;
  }

  const body = Buffer.concat(blocks);

  // zlib wrapper: 2-byte header + deflate body + Adler-32 checksum.
  const zlibHeader = Buffer.from([0x78, 0x01]);
  const adler = Buffer.alloc(4);
  adler.writeUInt32BE(adler32(data) >>> 0, 0);

  return Buffer.concat([zlibHeader, body, adler]);
}

function adler32(data: Buffer): number {
  let a = 1;
  let b = 0;
  for (const byte of data) {
    a = (a + byte) % 65521;
    b = (b + a) % 65521;
  }
  return ((b << 16) | a) >>> 0;
}

/** Derive a stable hue from the prompt so different prompts look different. */
function hashToSeed(input: string): number {
  const digest = createHash("sha256").update(input).digest();
  return digest.readUInt32BE(0);
}

function parseSize(size: string | undefined, fallback = 1024): { w: number; h: number } {
  if (!size) return { w: fallback, h: fallback };
  const match = /^(\d+)x(\d+)$/.exec(size.trim());
  if (!match) return { w: fallback, h: fallback };
  return { w: Number(match[1]), h: Number(match[2]) };
}

/**
 * Render a deterministic gradient with a subtle grid, so a human can tell at a glance
 * which scene produced it while still being verifiable by hash.
 */
function renderMockImage(
  prompt: string,
  width: number,
  height: number,
  seed: number,
): Buffer {
  const rgba = Buffer.alloc(width * height * 4);

  const hue = (hashToSeed(prompt) % 360) / 360;
  const base = hslToRgb(hue, 0.45, 0.18);
  const accent = hslToRgb((hue + 0.08) % 1, 0.75, 0.62);

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;

      const fx = x / width;
      const fy = y / height;
      const diagonal = (fx + fy) / 2;

      // Deterministic pseudo-noise from the seed: no Math.random, so output is stable.
      const noise = ((seed ^ (x * 73856093) ^ (y * 19349663)) >>> 0) % 1000 / 1000;

      const t = Math.min(1, Math.max(0, diagonal + (noise - 0.5) * 0.05));

      rgba[i] = Math.round(base[0] + (accent[0] - base[0]) * t);
      rgba[i + 1] = Math.round(base[1] + (accent[1] - base[1]) * t);
      rgba[i + 2] = Math.round(base[2] + (accent[2] - base[2]) * t);
      rgba[i + 3] = 255;

      // Grid lines every 128px, for visual reference when inspecting output.
      if (x % 128 === 0 || y % 128 === 0) {
        rgba[i] = Math.min(255, rgba[i]! + 28);
        rgba[i + 1] = Math.min(255, rgba[i + 1]! + 28);
        rgba[i + 2] = Math.min(255, rgba[i + 2]! + 28);
      }
    }
  }

  return encodePng(width, height, rgba);
}

function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const hp = h * 6;
  const x = c * (1 - Math.abs((hp % 2) - 1));
  let rgb: [number, number, number];
  if (hp < 1) rgb = [c, x, 0];
  else if (hp < 2) rgb = [x, c, 0];
  else if (hp < 3) rgb = [0, c, x];
  else if (hp < 4) rgb = [0, x, c];
  else if (hp < 5) rgb = [x, 0, c];
  else rgb = [c, 0, x];
  const m = l - c / 2;
  return [
    Math.round((rgb[0] + m) * 255),
    Math.round((rgb[1] + m) * 255),
    Math.round((rgb[2] + m) * 255),
  ];
}

const MOCK_CAPABILITIES: ProviderCapabilities = {
  providerId: "mock",
  kind: "mock",
  supportsStreaming: false,
  supportsAsyncJobs: false,
  supportsCancellation: true,
  requiresNetwork: false,
  isMock: true,
  notes: [
    "Offline mock provider. Produces real, deterministic PNG images without any network access or cost.",
    "Use it to develop and test the full workflow before connecting a paid provider.",
  ],
};

const MOCK_MODEL: ModelDescriptor = {
  id: MODEL_ID,
  displayName: "Mock Image (offline)",
  providerId: "mock",
  inputs: ["text"],
  outputs: ["image"],
  limits: {
    maxPromptChars: 4000,
    supportedSizes: ["512x512", "1024x1024", "1536x1024", "1024x1536"],
    maxBatchSize: 4,
    maxLatencyMs: 50,
  },
  capabilities: {
    supportsStreaming: false,
    supportsToolCalls: false,
    // Honest: the mock cannot honour a reference image, so the UI must not offer it.
    supportsReferenceImage: false,
    supportsSeed: true,
    supportsNegativePrompt: false,
    supportsInpainting: false,
    supportsTransparentBackground: false,
    supportsConversationalEdit: false,
    supportsCancellation: true,
    supportsQualityControl: false,
  },
  pricing: {
    basis: "free",
    note: "Local mock generation. No network call, no cost.",
    source: "built-in",
    verifiedAt: new Date().toISOString(),
  },
  outputMimeTypes: ["image/png"],
  warnings: [
    "Output is a synthetic gradient, not a real generation. Not for production use.",
  ],
};

export class MockImageAdapter implements ProviderAdapter {
  readonly id = "mock";
  readonly displayName = "Mock (offline)";
  readonly kind = "mock" as const;

  async discoverCapabilities(): Promise<ProviderCapabilities> {
    return MOCK_CAPABILITIES;
  }

  async listModels(): Promise<readonly ModelDescriptor[]> {
    return [MOCK_MODEL];
  }

  async validateCredentials(
    _credentials: ProviderCredentials,
  ): Promise<{ ok: true }> {
    // The mock needs no credentials, so it always validates. This is what allows the
    // application to start with an empty .env.
    return { ok: true };
  }

  async estimateCost(): Promise<CostEstimate> {
    return {
      amount: 0,
      currency: "USD",
      reliable: true,
      note: "Mock provider is free.",
    };
  }

  validateRequest(
    request: GenerationRequest,
    model: ModelDescriptor,
  ): ValidationResult {
    const problems: string[] = [];
    const unsupportedFields: string[] = [];

    if (!request.prompt || request.prompt.trim().length === 0) {
      problems.push("A prompt is required.");
    }

    if (request.prompt && model.limits.maxPromptChars !== undefined) {
      if (request.prompt.length > model.limits.maxPromptChars) {
        problems.push(
          `Prompt is ${request.prompt.length} characters; the model accepts at most ${model.limits.maxPromptChars}.`,
        );
      }
    }

    if (request.size && model.limits.supportedSizes) {
      if (!model.limits.supportedSizes.includes(request.size)) {
        problems.push(
          `Size ${request.size} is not supported. Supported: ${model.limits.supportedSizes.join(", ")}.`,
        );
      }
    }

    if (request.count !== undefined && model.limits.maxBatchSize !== undefined) {
      if (request.count > model.limits.maxBatchSize) {
        problems.push(
          `Requested ${request.count} images; the model returns at most ${model.limits.maxBatchSize} per request.`,
        );
      }
    }

    // Reject rather than silently ignore, per the "no false capability" rule.
    if (request.referenceAssetIds && request.referenceAssetIds.length > 0) {
      unsupportedFields.push("referenceAssetIds");
      problems.push(
        "This model cannot use reference images, so character consistency cannot be guaranteed with it.",
      );
    }
    if (request.negativePrompt) {
      unsupportedFields.push("negativePrompt");
      problems.push("This model does not support negative prompts.");
    }
    if (request.maskAssetId) {
      unsupportedFields.push("maskAssetId");
      problems.push("This model does not support inpainting masks.");
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
    if (signal?.aborted) {
      return { providerJobId: "", status: "cancelled" };
    }

    const validation = this.validateRequest(request, MOCK_MODEL);
    if (!validation.valid) {
      throw new Error(`Invalid request: ${validation.problems.join(" ")}`);
    }

    // Synchronous provider: work is complete by the time submitJob returns.
    const jobId = `mock-${hashToSeed(request.prompt + (request.seed ?? ""))}`;
    return { providerJobId: jobId, status: "succeeded" };
  }

  async pollOrSubscribe(
    handle: JobHandle,
    credentials: ProviderCredentials,
    signal?: CancellationSignal,
  ): Promise<GenerationResult> {
    // The mock is synchronous, so there is nothing to poll; reconstruct the result.
    // A real asynchronous adapter would loop here against the provider.
    void credentials;
    void signal;
    void handle;

    throw new Error(
      "MockImageAdapter is synchronous; call submitJobAndResolve() instead.",
    );
  }

  /**
   * Convenience path for synchronous providers: submit and resolve in one call.
   * Kept separate from the async `pollOrSubscribe` contract so callers are explicit
   * about which shape they are dealing with.
   */
  async submitJobAndResolve(
    request: GenerationRequest,
    signal?: CancellationSignal,
  ): Promise<GenerationResult> {
    const handle = await this.submitJob(request, {}, signal);
    if (handle.status === "cancelled") {
      return {
        status: "cancelled",
        outputs: [],
        provenance: this.buildProvenance(request),
      };
    }

    const { w, h } = parseSize(request.size);
    const count = Math.max(1, Math.min(request.count ?? 1, 4));
    const outputs: GenerationOutput[] = [];

    for (let i = 0; i < count; i++) {
      // Vary each image in a batch deterministically, so candidates are distinguishable.
      const seed = (request.seed ?? hashToSeed(request.prompt)) + i;
      const png = renderMockImage(request.prompt, w, h, seed);
      outputs.push({
        kind: "image",
        data: png,
        mimeType: "image/png",
        width: w,
        height: h,
      });
    }

    return {
      status: "succeeded",
      outputs,
      provenance: this.buildProvenance(request),
      usage: { images: count },
    };
  }

  async cancelJob(): Promise<boolean> {
    // Nothing to cancel: the mock completes synchronously.
    return true;
  }

  normaliseResult(raw: unknown): GenerationResult {
    return raw as GenerationResult;
  }

  normaliseError(error: unknown): NormalisedError {
    const message = error instanceof Error ? error.message : String(error);
    return {
      code: "invalid_request",
      message,
      retryable: false,
      userActionRequired: true,
      detail: message,
    };
  }

  private buildProvenance(request: GenerationRequest) {
    return {
      providerId: this.id,
      modelId: MODEL_ID,
      prompt: request.prompt,
      ...(request.seed !== undefined ? { seed: request.seed } : {}),
      createdAt: new Date().toISOString(),
      parameters: {
        size: request.size ?? "1024x1024",
        count: request.count ?? 1,
      },
    };
  }
}