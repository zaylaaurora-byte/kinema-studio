import { describe, expect, it } from "vitest";

import { MockImageAdapter } from "./mock-image.js";

/**
 * These tests verify the mock provider produces real, decodable output — not just that
 * functions return without throwing. A mock that emits a corrupt PNG would let broken
 * image handling pass CI, which defeats its entire purpose.
 */

const adapter = new MockImageAdapter();

describe("MockImageAdapter", () => {
  it("declares itself honestly as a mock that cannot use reference images", () => {
    expect(adapter.kind).toBe("mock");
  });

  it("lists exactly one model", async () => {
    const models = await adapter.listModels();
    expect(models).toHaveLength(1);
    const model = models[0]!;
    expect(model.outputs).toContain("image");
    // The honesty rule: if it cannot use references, it must say so, so the UI can
    // hide the control rather than pretending to support character consistency.
    expect(model.capabilities.supportsReferenceImage).toBe(false);
    expect(model.capabilities.supportsSeed).toBe(true);
  });

  it("validates with no credentials, so the app runs from an empty .env", async () => {
    await expect(adapter.validateCredentials({})).resolves.toEqual({ ok: true });
  });

  it("reports zero cost reliably", async () => {
    const estimate = await adapter.estimateCost();
    expect(estimate.amount).toBe(0);
    expect(estimate.reliable).toBe(true);
  });

  describe("validateRequest", () => {
    const model = {
      id: "mock-image-v1",
      displayName: "Mock",
      providerId: "mock",
      inputs: ["text"] as const,
      outputs: ["image"] as const,
      limits: { maxPromptChars: 100, supportedSizes: ["1024x1024"], maxBatchSize: 2 },
      capabilities: {
        supportsStreaming: false,
        supportsToolCalls: false,
        supportsReferenceImage: false,
        supportsSeed: true,
        supportsNegativePrompt: false,
        supportsInpainting: false,
        supportsTransparentBackground: false,
        supportsConversationalEdit: false,
        supportsCancellation: true,
        supportsQualityControl: false,
      },
      pricing: { basis: "free" as const },
      outputMimeTypes: ["image/png"],
    };

    it("accepts a well-formed request", () => {
      const result = adapter.validateRequest({ modelId: "mock-image-v1", prompt: "a cat" }, model);
      expect(result.valid).toBe(true);
      expect(result.problems).toHaveLength(0);
    });

    it("rejects an empty prompt", () => {
      const result = adapter.validateRequest({ modelId: "mock-image-v1", prompt: "  " }, model);
      expect(result.valid).toBe(false);
      expect(result.problems.join(" ")).toMatch(/prompt is required/i);
    });

    it("rejects an over-long prompt with a specific message", () => {
      const result = adapter.validateRequest(
        { modelId: "mock-image-v1", prompt: "x".repeat(101) },
        model,
      );
      expect(result.valid).toBe(false);
      expect(result.problems.join(" ")).toMatch(/at most 100/);
    });

    it("rejects an unsupported size and lists what is supported", () => {
      const result = adapter.validateRequest(
        { modelId: "mock-image-v1", prompt: "a cat", size: "4096x4096" },
        model,
      );
      expect(result.valid).toBe(false);
      expect(result.problems.join(" ")).toContain("1024x1024");
    });

    it("rejects a batch larger than the model allows", () => {
      const result = adapter.validateRequest(
        { modelId: "mock-image-v1", prompt: "a cat", count: 9 },
        model,
      );
      expect(result.valid).toBe(false);
      expect(result.problems.join(" ")).toMatch(/at most 2/);
    });

    it("rejects reference images rather than silently ignoring them", () => {
      // This is the behaviour that prevents a false promise of character consistency.
      const result = adapter.validateRequest(
        { modelId: "mock-image-v1", prompt: "a cat", referenceAssetIds: ["asset-1"] },
        model,
      );
      expect(result.valid).toBe(false);
      expect(result.unsupportedFields).toContain("referenceAssetIds");
    });

    it("rejects negative prompts and masks", () => {
      const neg = adapter.validateRequest(
        { modelId: "mock-image-v1", prompt: "a cat", negativePrompt: "blurry" },
        model,
      );
      expect(neg.unsupportedFields).toContain("negativePrompt");

      const masked = adapter.validateRequest(
        { modelId: "mock-image-v1", prompt: "a cat", maskAssetId: "mask-1" },
        model,
      );
      expect(masked.unsupportedFields).toContain("maskAssetId");
    });
  });

  describe("generation", () => {
    it("produces a real, decodable PNG with the requested dimensions", async () => {
      const result = await adapter.submitJobAndResolve({
        modelId: "mock-image-v1",
        prompt: "a lighthouse at dusk",
        size: "512x512",
      });

      expect(result.status).toBe("succeeded");
      expect(result.outputs).toHaveLength(1);

      const output = result.outputs[0]!;
      expect(output.mimeType).toBe("image/png");
      expect(output.width).toBe(512);
      expect(output.height).toBe(512);

      const bytes = Buffer.from(output.data as Buffer);

      // PNG signature — proves we emitted a real PNG container, not arbitrary bytes.
      expect(bytes.subarray(0, 8)).toEqual(
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      );

      // IHDR must declare the dimensions we asked for.
      expect(bytes.subarray(12, 16).toString("ascii")).toBe("IHDR");
      expect(bytes.readUInt32BE(16)).toBe(512);
      expect(bytes.readUInt32BE(20)).toBe(512);
      expect(bytes[24]).toBe(8); // bit depth
      expect(bytes[25]).toBe(6); // RGBA

      // Must terminate with IEND.
      expect(bytes.subarray(bytes.length - 8, bytes.length - 4).toString("ascii")).toBe("IEND");
    });

    it("is deterministic: identical prompt and seed give identical bytes", async () => {
      const request = { modelId: "mock-image-v1", prompt: "stable", seed: 42, size: "512x512" };
      const a = await adapter.submitJobAndResolve(request);
      const b = await adapter.submitJobAndResolve(request);

      expect(Buffer.from(a.outputs[0]!.data as Buffer).equals(
        Buffer.from(b.outputs[0]!.data as Buffer),
      )).toBe(true);
    });

    it("produces different bytes for different prompts", async () => {
      const a = await adapter.submitJobAndResolve({ modelId: "mock-image-v1", prompt: "dawn" });
      const b = await adapter.submitJobAndResolve({ modelId: "mock-image-v1", prompt: "dusk" });

      expect(Buffer.from(a.outputs[0]!.data as Buffer).equals(
        Buffer.from(b.outputs[0]!.data as Buffer),
      )).toBe(false);
    });

    it("returns distinct candidates within one batch", async () => {
      const result = await adapter.submitJobAndResolve({
        modelId: "mock-image-v1",
        prompt: "three candidates",
        count: 3,
        size: "512x512",
      });

      expect(result.outputs).toHaveLength(3);
      const hashes = result.outputs.map((o) =>
        Buffer.from(o.data as Buffer).toString("base64"),
      );
      expect(new Set(hashes).size).toBe(3);
      expect(result.usage?.images).toBe(3);
    });

    it("records provenance identifying the model that produced the output", async () => {
      const result = await adapter.submitJobAndResolve({
        modelId: "mock-image-v1",
        prompt: "provenance check",
        seed: 7,
      });

      expect(result.provenance.providerId).toBe("mock");
      expect(result.provenance.modelId).toBe("mock-image-v1");
      expect(result.provenance.prompt).toBe("provenance check");
      expect(result.provenance.seed).toBe(7);
      expect(result.provenance.createdAt).toBeTruthy();
    });

    it("refuses an invalid request instead of generating anyway", async () => {
      await expect(
        adapter.submitJobAndResolve({ modelId: "mock-image-v1", prompt: "" }),
      ).rejects.toThrow(/Invalid request/);
    });

    it("honours an already-aborted cancellation signal", async () => {
      const controller = new AbortController();
      controller.abort();

      const result = await adapter.submitJobAndResolve(
        { modelId: "mock-image-v1", prompt: "cancelled" },
        controller.signal,
      );

      expect(result.status).toBe("cancelled");
      expect(result.outputs).toHaveLength(0);
    });
  });

  describe("normaliseError", () => {
    it("maps errors to a non-retryable, user-actionable shape", () => {
      const error = adapter.normaliseError(new Error("bad prompt"));
      expect(error.code).toBe("invalid_request");
      expect(error.retryable).toBe(false);
      expect(error.userActionRequired).toBe(true);
      expect(error.message).toBe("bad prompt");
    });

    it("handles non-Error throwables without crashing", () => {
      const error = adapter.normaliseError("a string was thrown");
      expect(error.message).toBe("a string was thrown");
    });
  });
});