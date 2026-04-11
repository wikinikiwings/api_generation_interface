// Server-only. Provider registry.
// Adds each provider here once it's implemented.
// In step 2 we'll add `falProvider`, in step 3 `comfyProvider`.

import type { Provider, ProviderId, ModelId } from "./types";
import { wavespeedProvider } from "./wavespeed";
import { falProvider } from "./fal";
import { comfyProvider } from "./comfy";

/**
 * Registry of all available provider implementations.
 * Partial: some providers may not be implemented yet.
 */
const providers: Partial<Record<ProviderId, Provider>> = {
  wavespeed: wavespeedProvider,
  fal: falProvider,
  comfy: comfyProvider,
};

/** Get a provider by id. Throws if the provider is not implemented. */
export function getProvider(id: ProviderId): Provider {
  const p = providers[id];
  if (!p) {
    throw new Error(
      `Provider "${id}" is not available yet. Configured providers: ${listProviders()
        .map((x) => x.id)
        .join(", ")}`
    );
  }
  return p;
}

/** List all implemented providers (regardless of whether they are configured). */
export function listProviders(): Provider[] {
  return Object.values(providers).filter((p): p is Provider => !!p);
}

/**
 * Check if a provider is configured (env vars set).
 * Returns false also if the provider is not implemented at all.
 */
export function isProviderConfigured(id: ProviderId): boolean {
  const p = providers[id];
  if (!p) return false;
  try {
    return p.isConfigured();
  } catch {
    return false;
  }
}

/** List models that the given provider can route to. Empty if provider not implemented. */
export function listModelsForProvider(id: ProviderId): ModelId[] {
  const p = providers[id];
  return p?.supportedModels ?? [];
}

/** Validate that a (provider, model) pair is routable. */
export function isModelSupportedByProvider(id: ProviderId, modelId: ModelId): boolean {
  return listModelsForProvider(id).includes(modelId);
}

/**
 * Client-safe metadata about all providers.
 * Does NOT expose any secrets — just id, displayName, modelLabel, configured flag.
 * Used by the burger menu UI in step 4.
 */
export interface ProviderMeta {
  id: ProviderId;
  displayName: string;
  modelLabel: string;
  supportedModels: ModelId[];
  isAsync: boolean;
  isConfigured: boolean;
  isImplemented: boolean;
}

/** All known provider IDs, even if not implemented yet. */
const ALL_PROVIDER_IDS: ProviderId[] = ["wavespeed", "fal", "comfy"];

export function listProviderMeta(): ProviderMeta[] {
  return ALL_PROVIDER_IDS.map((id) => {
    const p = providers[id];
    if (!p) {
      // Placeholder for not-yet-implemented providers
      return {
        id,
        displayName: id.charAt(0).toUpperCase() + id.slice(1),
        modelLabel: "не реализовано",
        supportedModels: [],
        isAsync: false,
        isConfigured: false,
        isImplemented: false,
      };
    }
    return {
      id: p.id,
      displayName: p.displayName,
      modelLabel: p.modelLabel,
      supportedModels: p.supportedModels,
      isAsync: p.isAsync,
      isConfigured: (() => {
        try {
          return p.isConfigured();
        } catch {
          return false;
        }
      })(),
      isImplemented: true,
    };
  });
}
