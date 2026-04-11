// This file is a backward-compatibility shim.
// The new source of truth for shared types is `lib/providers/types.ts`.
//
// Existing client components (history-store, generate-form, output-area, etc.)
// still import from `@/types/wavespeed`, so this file re-exports the types
// they need. New code should import directly from `@/lib/providers/types`.

export type {
  Resolution,
  AspectRatio,
  OutputFormat,
  TaskStatus,
  ProviderId,
} from "@/lib/providers/types";

import type {
  Resolution,
  AspectRatio,
  OutputFormat,
  TaskStatus,
  ProviderId,
} from "@/lib/providers/types";

/**
 * A single history entry stored in localStorage via zustand/persist.
 * One entry = one generation attempt.
 */
export interface HistoryEntry {
  id: string; // our internal uuid
  taskId: string; // provider's task id (empty for sync providers until submitted)
  provider: ProviderId; // NEW: which provider produced this
  model: string; // e.g. "google/nano-banana-pro/edit"
  prompt: string;
  resolution: Resolution;
  aspectRatio?: AspectRatio;
  outputFormat: OutputFormat;
  inputThumbnails: string[]; // downscaled data URLs
  outputUrl?: string;
  /**
   * Mid-resolution preview URL (~1200px) on our own server, set after
   * the generation is saved to /api/history. Used by Output area for
   * fast cached display — avoids hitting provider CDNs that may expire.
   * Falls back to outputUrl on legacy entries that predate this field.
   */
  previewUrl?: string;
  /**
   * Full-resolution original URL on our own server, set after save.
   * Used by ImageDialog download button and as the source the dropzone
   * fetches when an Output thumbnail is dragged back in. Falls back to
   * outputUrl on legacy entries.
   */
  originalUrl?: string;
  outputSizeBytes?: number;
  executionTimeMs?: number;
  status: TaskStatus;
  error?: string | null;
  createdAt: number; // ms timestamp
  /**
   * Server-side history DB row id, assigned after POST /api/history succeeds.
   * Used by history-sidebar to link a deletion back to this client entry and
   * drop it from the Output panel in sync. Optional because it's filled in
   * asynchronously after the generation itself is already in the store.
   */
  serverGenId?: number;
}
