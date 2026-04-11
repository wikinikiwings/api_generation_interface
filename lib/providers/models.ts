// Single source of truth for model metadata used by the UI selector.
// Providers stay decoupled from this file: they own their own slug maps
// and per-model caps. This file is purely descriptive (UI labels, capability
// matrix). See MODEL_ADDITION.md Phase 3 for rationale.

import type { ModelId, Resolution, OutputFormat } from "./types";

export interface ModelCapabilities {
  edit: boolean;
  textToImage: boolean;
  /** Hard cap on input images. v1 = 10, v2/pro = 14, seedream-4-5 = 10. */
  maxImages: number;
  /** Empty array = model has no concept of resolution; UI hides selector. */
  resolutions: Resolution[];
  /** Empty array = model picks format internally; UI hides format selector. */
  outputFormats: OutputFormat[];
}

export interface ModelMeta {
  id: ModelId;
  displayName: string;
  shortLabel: string;
  description: string;
  capabilities: ModelCapabilities;
}

export const MODELS_META: Record<ModelId, ModelMeta> = {
  "nano-banana-pro": {
    id: "nano-banana-pro",
    displayName: "Nano Banana Pro",
    shortLabel: "Pro",
    description: "Gemini 3 Pro Image — highest quality",
    capabilities: {
      edit: true,
      textToImage: true,
      maxImages: 14,
      resolutions: ["1k", "2k", "4k"],
      outputFormats: ["png", "jpeg"],
    },
  },
  "nano-banana-2": {
    id: "nano-banana-2",
    displayName: "Nano Banana 2",
    shortLabel: "v2",
    description: "Gemini 3.1 Flash Image — faster, cheaper",
    capabilities: {
      edit: true,
      textToImage: true,
      maxImages: 14,
      resolutions: ["1k", "2k", "4k"],
      outputFormats: ["png", "jpeg"],
    },
  },
  "nano-banana": {
    id: "nano-banana",
    displayName: "Nano Banana",
    shortLabel: "v1",
    description: "Gemini 2.5 Flash Image — original",
    capabilities: {
      edit: true,
      textToImage: true,
      maxImages: 10,
      // Empty = v1 has no resolution parameter on any provider.
      // UI reads this to conditionally hide the selector.
      resolutions: [],
      outputFormats: ["png", "jpeg"],
    },
  },
  "seedream-4-5": {
    id: "seedream-4-5",
    displayName: "Seedream 4.5",
    shortLabel: "SD4.5",
    description: "ByteDance Seedream 4.5 — 4K typography & poster generation",
    capabilities: {
      edit: true,
      textToImage: true,
      maxImages: 10,
      // Seedream physically cannot do 1K — Fal min width 1920, Comfy min 1024 but
      // image must total >=3.7M pixels (~1920x1920). UI shows only 2K/4K.
      resolutions: ["2k", "4k"],
      // Fal schema has no output_format field; Comfy uses None for 4.5;
      // WaveSpeed undocumented. Empty array tells UI to hide the selector
      // and providers hardcode PNG (or omit the field entirely).
      outputFormats: [],
    },
  },
  "seedream-5-0-lite": {
    id: "seedream-5-0-lite",
    displayName: "Seedream 5.0 Lite",
    shortLabel: "SD5L",
    description: "ByteDance Seedream 5.0 Lite — fast & cheap, max ~3K",
    capabilities: {
      edit: true,
      textToImage: true,
      // Comfy nodes_bytedance.py: max_num_of_images = 14 if model == "seedream-5-0-260128".
      maxImages: 14,
      // 5.0 Lite physically caps at ~3K (Fal max 3072x3072). UI keeps the
      // 2k/4k labels for consistency — providers auto-clamp on submit.
      resolutions: ["2k", "4k"],
      // 5.0 Lite has output_format documented on both WaveSpeed and Comfy.
      // Fal schema still doesn't expose it but ignores extras gracefully.
      outputFormats: ["png", "jpeg"],
    },
  },
};

export function getModelMeta(id: ModelId): ModelMeta {
  return MODELS_META[id];
}

export function listAllModels(): ModelMeta[] {
  return Object.values(MODELS_META);
}
