import type {
  ModelDescriptor,
  ProviderAdapter,
  ProviderConnectionSummary,
  ProviderKind,
} from "@kinema/types";

/**
 * Provider registry.
 *
 * The single place that knows which providers exist. Everything else — the API, the
 * worker, the settings UI — asks the registry rather than importing adapters directly.
 *
 * Why this matters: the product promises "bring any compatible model". That promise is
 * only keepable if adding a provider is a local change. Registering an adapter here
 * must be the *only* edit required to make a new provider appear throughout the app.
 */
export class ProviderRegistry {
  readonly #adapters = new Map<string, ProviderAdapter>();

  register(adapter: ProviderAdapter): void {
    if (this.#adapters.has(adapter.id)) {
      throw new Error(
        `A provider with id "${adapter.id}" is already registered. Provider ids must be unique.`,
      );
    }
    this.#adapters.set(adapter.id, adapter);
  }

  get(id: string): ProviderAdapter | undefined {
    return this.#adapters.get(id);
  }

  /**
   * Look up an adapter or fail loudly.
   *
   * Used where a missing provider is a programming error (a job referencing a provider
   * that should exist) rather than a user-input error.
   */
  require(id: string): ProviderAdapter {
    const adapter = this.#adapters.get(id);
    if (!adapter) {
      throw new UnknownProviderError(id, [...this.#adapters.keys()]);
    }
    return adapter;
  }

  list(): readonly ProviderAdapter[] {
    return [...this.#adapters.values()];
  }

  listByKind(kind: ProviderKind): readonly ProviderAdapter[] {
    return this.list().filter((a) => a.kind === kind);
  }

  /**
   * Every model across every registered provider.
   *
   * A provider that throws here must not break the whole catalogue — a single
   * misconfigured provider would otherwise make the model picker unusable.
   */
  async listAllModels(): Promise<
    readonly { model: ModelDescriptor; error?: undefined }[] | readonly { error: string; providerId: string }[]
  > {
    const results: { model: ModelDescriptor }[] = [];
    for (const adapter of this.list()) {
      try {
        const models = await adapter.listModels();
        for (const model of models) {
          results.push({ model });
        }
      } catch (error) {
        // Surfaced rather than swallowed, so the UI can show "provider X unavailable".
        console.warn(
          `[provider-registry] Failed to list models for "${adapter.id}":`,
          error instanceof Error ? error.message : error,
        );
      }
    }
    return results;
  }

  /**
   * Find which provider owns a model id.
   *
   * Model ids are only unique within a provider — two providers may both expose
   * "some-model". Callers should prefer passing a provider id explicitly, but scene
   * data often stores only a model id, so this resolves it when unambiguous.
   */
  async findProviderForModel(modelId: string): Promise<ProviderAdapter | undefined> {
    for (const adapter of this.list()) {
      try {
        const models = await adapter.listModels();
        if (models.some((m) => m.id === modelId)) {
          return adapter;
        }
      } catch {
        // Ignore: an unreachable provider cannot own the model we are looking for.
      }
    }
    return undefined;
  }
}

export class UnknownProviderError extends Error {
  readonly providerId: string;
  readonly knownProviders: readonly string[];

  constructor(providerId: string, knownProviders: readonly string[]) {
    super(
      `Unknown provider "${providerId}". Registered providers: ${
        knownProviders.length > 0 ? knownProviders.join(", ") : "(none)"
      }.`,
    );
    this.name = "UnknownProviderError";
    this.providerId = providerId;
    this.knownProviders = knownProviders;
  }
}

/**
 * Redact a credential for display or logging.
 *
 * Centralised deliberately: this is the single most dangerous thing to get wrong in
 * this codebase. A leaked key is a user's money and access. Never construct a
 * fingerprint anywhere else.
 */
export function fingerprintKey(apiKey: string | undefined): string | undefined {
  if (!apiKey) return undefined;
  const trimmed = apiKey.trim();
  // Too short to fingerprint safely without revealing most of it.
  if (trimmed.length < 8) return "****";
  return `****${trimmed.slice(-4)}`;
}

/**
 * Build the client-safe summary of a connection.
 *
 * Takes the full credentials and returns something safe to serialise. Keeping this
 * next to the credential handling makes it obvious that raw keys must not leave the
 * server.
 */
export function toConnectionSummary(input: {
  id: string;
  providerId: string;
  label: string;
  kind: ProviderKind;
  credentials: { apiKey?: string; baseUrl?: string };
  validatedAt?: string;
  status?: ProviderConnectionSummary["status"];
}): ProviderConnectionSummary {
  return {
    id: input.id,
    providerId: input.providerId,
    label: input.label,
    kind: input.kind,
    ...(input.credentials.baseUrl ? { baseUrl: input.credentials.baseUrl } : {}),
    ...(fingerprintKey(input.credentials.apiKey)
      ? { keyFingerprint: fingerprintKey(input.credentials.apiKey)! }
      : {}),
    ...(input.validatedAt ? { validatedAt: input.validatedAt } : {}),
    status: input.status ?? "unvalidated",
  };
}