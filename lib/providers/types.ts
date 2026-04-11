// Core types for the provider abstraction layer.
// This file is the single source of truth for shared types.
// `types/wavespeed.ts` re-exports from here for backward compatibility.

/** Stable identifier for each provider. Used in UI, API, and history store. */
export type ProviderId = "wavespeed" | "comfy" | "fal";

/** Stable identifier for each model. Used in UI, API, history store, and provider routing. */
export type ModelId =
  | "nano-banana-pro"   // Gemini 3 Pro Image
  | "nano-banana-2"     // Gemini 3.1 Flash Image (NOT 2.5 — see MODEL_ADDITION.md Phase 0)
  | "nano-banana"       // Gemini 2.5 Flash Image
  | "seedream-4-5"      // ByteDance Seedream 4.5 — 4K typography & poster generation
  | "seedream-5-0-lite";// ByteDance Seedream 5.0 Lite — cheap/fast variant, max ~3K

export type Resolution = "1k" | "2k" | "4k";

export type AspectRatio =
  | "1:1"
  | "3:2"
  | "2:3"
  | "3:4"
  | "4:3"
  | "4:5"
  | "5:4"
  | "9:16"
  | "16:9"
  | "21:9";

export type OutputFormat = "png" | "jpeg";

export type TaskStatus = "pending" | "processing" | "completed" | "failed" | "cancelled";

/** Normalized input that every provider's submit() accepts. */
export interface EditInput {
  /** Which model to use. Providers map this to their own slug. */
  modelId: ModelId;
  prompt: string;
  /** URLs or base64 data URIs. Up to 14. */
  images: string[];
  resolution: Resolution;
  aspectRatio?: AspectRatio;
  outputFormat: OutputFormat;
  /** Optional. Source image aspect ratio (W/H) carried from the client.
   *  Used by seedream providers when the user picks "Auto (match input)":
   *  nano-banana models infer this server-side from the input image, but
   *  seedream's API has no aspect_ratio field at all — it requires explicit
   *  W*H pixels — so the client must compute and ship the source ratio. */
  sourceAspectRatio?: number;
}

/**
 * Result of provider.submit(). Discriminated union:
 * - `sync`: provider ran synchronously and the result is ready now
 * - `async`: provider accepted the task; client must poll `getStatus(taskId)`
 */
export type SubmitResult =
  | { kind: "sync"; outputUrls: string[]; executionTimeMs: number }
  | { kind: "async"; taskId: string };

/** Result of provider.getStatus(taskId). Only relevant for async providers. */
export interface StatusResult {
  status: TaskStatus;
  outputUrls: string[];
  error?: string | null;
}

/**
 * Contract that every provider implementation must satisfy.
 * Instances live in `lib/providers/registry.ts`.
 */
export interface Provider {
  id: ProviderId;
  displayName: string;
  /** Short description of the underlying model, e.g. "Nano Banana Pro (Gemini 3 Pro Image)". */
  modelLabel: string;
  /** Models this provider can route to. UI selector filters by this. */
  supportedModels: ModelId[];
  /** True if submit() returns a taskId and client must poll getStatus(). */
  isAsync: boolean;
  /** True if required env vars are set (e.g. API key). */
  isConfigured(): boolean;
  /** Submit a new edit task. Must throw Error on failure. */
  submit(input: EditInput): Promise<SubmitResult>;
  /** Poll status by task id. Required when isAsync is true. */
  getStatus?(taskId: string): Promise<StatusResult>;
}

// ============================================================
// Client <-> Server API response shapes for /api/generate/*
// ============================================================

/** Response body from POST /api/generate/submit */
export type GenerateSubmitResponse =
  | {
      kind: "async";
      provider: ProviderId;
      taskId: string;
    }
  | {
      kind: "sync";
      provider: ProviderId;
      outputUrls: string[];
      executionTimeMs: number;
    };

/** Response body from GET /api/generate/status/:id?provider=... */
export interface GenerateStatusResponse {
  id: string;
  status: TaskStatus;
  outputUrls: string[];
  error: string | null;
}

/** Request body for POST /api/generate/submit */
export interface GenerateSubmitBody extends EditInput {
  provider: ProviderId;
}
