/**
 * @kinema/provider-sdk — provider adapter registry and implementations.
 *
 * Adding a provider means adding one adapter and registering it. Nothing else in the
 * application should need to change.
 */

export { MockImageAdapter } from "./mock-image.js";

export {
  ProviderRegistry,
  UnknownProviderError,
  fingerprintKey,
  toConnectionSummary,
} from "./registry.js";