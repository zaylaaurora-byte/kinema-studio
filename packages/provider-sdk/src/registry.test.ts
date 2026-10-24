import { describe, expect, it, vi } from "vitest";

import { MockImageAdapter } from "./mock-image.js";
import {
  ProviderRegistry,
  UnknownProviderError,
  fingerprintKey,
  toConnectionSummary,
} from "./registry.js";
import type { ModelDescriptor, ProviderAdapter } from "@kinema/types";

function makeAdapter(id: string, models: ModelDescriptor[] = []): ProviderAdapter {
  return {
    id,
    displayName: id,
    kind: "cloud",
    discoverCapabilities: async () => ({
      providerId: id,
      kind: "cloud",
      supportsStreaming: false,
      supportsAsyncJobs: false,
      supportsCancellation: false,
      requiresNetwork: true,
      isMock: false,
    }),
    listModels: async () => models,
    validateCredentials: async () => ({ ok: true }),
    estimateCost: async () => ({ reliable: false }),
    validateRequest: () => ({ valid: true, unsupportedFields: [], problems: [] }),
    submitJob: async () => ({ providerJobId: "x", status: "queued" }),
    pollOrSubscribe: async () => {
      throw new Error("not implemented");
    },
    cancelJob: async () => true,
    normaliseResult: (raw) => raw as never,
    normaliseError: (e) => ({
      code: "unknown",
      message: String(e),
      retryable: false,
      userActionRequired: false,
    }),
  };
}

function makeModel(id: string, providerId: string): ModelDescriptor {
  return {
    id,
    displayName: id,
    providerId,
    inputs: ["text"],
    outputs: ["image"],
    limits: {},
    capabilities: {
      supportsStreaming: false,
      supportsToolCalls: false,
      supportsReferenceImage: false,
      supportsSeed: false,
      supportsNegativePrompt: false,
      supportsInpainting: false,
      supportsTransparentBackground: false,
      supportsConversationalEdit: false,
      supportsCancellation: false,
      supportsQualityControl: false,
    },
    pricing: { basis: "unknown" },
    outputMimeTypes: ["image/png"],
  };
}

describe("ProviderRegistry", () => {
  it("registers and retrieves an adapter", () => {
    const registry = new ProviderRegistry();
    const adapter = new MockImageAdapter();
    registry.register(adapter);

    expect(registry.get("mock")).toBe(adapter);
    expect(registry.list()).toHaveLength(1);
  });

  it("rejects a duplicate provider id", () => {
    const registry = new ProviderRegistry();
    registry.register(makeAdapter("dup"));
    expect(() => registry.register(makeAdapter("dup"))).toThrow(/already registered/);
  });

  it("require() throws a descriptive error for an unknown provider", () => {
    const registry = new ProviderRegistry();
    registry.register(makeAdapter("mock"));

    expect(() => registry.require("nope")).toThrow(UnknownProviderError);

    try {
      registry.require("nope");
    } catch (error) {
      const e = error as UnknownProviderError;
      expect(e.providerId).toBe("nope");
      // The message must list what IS available, so the developer can fix it fast.
      expect(e.knownProviders).toContain("mock");
      expect(e.message).toContain("mock");
    }
  });

  it("filters adapters by kind", () => {
    const registry = new ProviderRegistry();
    registry.register(new MockImageAdapter());
    registry.register(makeAdapter("cloud-one"));

    expect(registry.listByKind("mock")).toHaveLength(1);
    expect(registry.listByKind("cloud")).toHaveLength(1);
    expect(registry.listByKind("local")).toHaveLength(0);
  });

  it("collects models across providers", async () => {
    const registry = new ProviderRegistry();
    registry.register(makeAdapter("a", [makeModel("m-a", "a")]));
    registry.register(makeAdapter("b", [makeModel("m-b", "b")]));

    const results = await registry.listAllModels();
    expect(results).toHaveLength(2);
  });

  it("does not let one broken provider break the whole catalogue", async () => {
    // A single misconfigured provider must not make the model picker unusable.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const registry = new ProviderRegistry();

    const broken = makeAdapter("broken");
    broken.listModels = async () => {
      throw new Error("provider unreachable");
    };

    registry.register(broken);
    registry.register(makeAdapter("healthy", [makeModel("m", "healthy")]));

    const results = await registry.listAllModels();
    expect(results).toHaveLength(1);
    expect(warn).toHaveBeenCalled();

    warn.mockRestore();
  });

  it("resolves the provider that owns a model id", async () => {
    const registry = new ProviderRegistry();
    registry.register(makeAdapter("a", [makeModel("shared-name", "a")]));
    registry.register(makeAdapter("b", [makeModel("other", "b")]));

    const found = await registry.findProviderForModel("other");
    expect(found?.id).toBe("b");

    const missing = await registry.findProviderForModel("does-not-exist");
    expect(missing).toBeUndefined();
  });
});

describe("fingerprintKey", () => {
  it("never reveals more than the last four characters", () => {
    const key = "sk-proj-abcdefghijklmnop1234";
    const fp = fingerprintKey(key)!;

    expect(fp).toBe("****1234");
    // The body of the key must not appear anywhere in the fingerprint.
    expect(fp).not.toContain("abcdefghijklmnop");
    expect(fp).not.toContain("sk-proj");
  });

  it("returns undefined when there is no key", () => {
    expect(fingerprintKey(undefined)).toBeUndefined();
    expect(fingerprintKey("")).toBeUndefined();
  });

  it("fully masks a key too short to fingerprint safely", () => {
    // Revealing 4 of a 6-character secret would expose most of it.
    expect(fingerprintKey("abc123")).toBe("****");
  });

  it("trims whitespace before fingerprinting so pasted keys behave", () => {
    expect(fingerprintKey("  sk-abcdefgh9999  ")).toBe("****9999");
  });
});

describe("toConnectionSummary", () => {
  it("produces a client-safe object with no raw key", () => {
    const summary = toConnectionSummary({
      id: "conn-1",
      providerId: "openai-images",
      label: "My OpenAI key",
      kind: "cloud",
      credentials: { apiKey: "sk-secret-value-5678", baseUrl: "https://api.openai.com/v1" },
      status: "valid",
      validatedAt: "2026-10-24T00:00:00.000Z",
    });

    expect(summary.keyFingerprint).toBe("****5678");
    expect(summary.baseUrl).toBe("https://api.openai.com/v1");
    expect(summary.status).toBe("valid");

    // The strongest check: the full key must not be reachable anywhere in the object.
    const serialised = JSON.stringify(summary);
    expect(serialised).not.toContain("sk-secret-value-5678");
    expect(serialised).not.toContain("secret-value");
  });

  it("omits optional fields when absent rather than emitting undefined", () => {
    const summary = toConnectionSummary({
      id: "conn-2",
      providerId: "mock",
      label: "Mock",
      kind: "mock",
      credentials: {},
    });

    expect(summary.keyFingerprint).toBeUndefined();
    expect(summary.baseUrl).toBeUndefined();
    expect("keyFingerprint" in summary).toBe(false);
    expect(summary.status).toBe("unvalidated");
  });
});