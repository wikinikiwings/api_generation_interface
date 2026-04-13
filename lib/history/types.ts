import type {
  Resolution,
  AspectRatio,
  OutputFormat,
  TaskStatus,
  ProviderId,
} from "@/lib/providers/types";

export type EntryState = "pending" | "live" | "deleting" | "removed";

/**
 * Unified history record. Replaces both the old persisted HistoryEntry
 * (zustand) and PendingGeneration (singleton). The `state` field is the
 * single source of truth for visibility / removal eligibility. Field
 * shape is a superset of the previous HistoryEntry so components can
 * migrate by changing imports without rewriting render code.
 */
export interface HistoryEntry {
  /** Stable canonical id. Local origin: uuid from generate-form.
   *  Server-only origin: extractUuid(filepath) ?? `server-${serverGenId}`. */
  id: string;

  /** Provider's task id (empty for sync providers until submitted). Optional
   *  for cross-device-only entries that never had a client task. */
  taskId?: string;

  /** Source of truth for visibility / removal eligibility. */
  state: EntryState;

  /** True after POST /api/history. False on freshly-created PENDING.
   *  Forbidden combinations: state="live"|"deleting"|"removed" + confirmed=false. */
  confirmed: boolean;

  /** Server-side history DB row id. Set on confirmPendingEntry. */
  serverGenId?: number;

  // === Generation metadata ===
  prompt: string;
  provider: ProviderId;
  model?: string;                                     // optional for cross-device entries
  workflowName?: string;
  resolution?: Resolution;
  aspectRatio?: AspectRatio;
  outputFormat?: OutputFormat;
  inputThumbnails?: string[];                         // small data URLs of inputs
  createdAt: number;                                  // ms epoch
  status: TaskStatus;
  error?: string | null;
  outputSizeBytes?: number;
  executionTimeMs?: number;

  // === Image URLs ===
  originalUrl?: string;
  outputUrl?: string;
  previewUrl?: string;
  thumbUrl?: string;

  /** Blob URLs owned by this entry; revoked on REMOVED. */
  localBlobUrls?: string[];

  /** Optional human-readable upload error (separate from generation error).
   *  Presence signals "show retry UI" in the sidebar. */
  uploadError?: string | null;
}

export interface DateRange {
  from?: Date;
  to?: Date;
}

/** Input shape for addPendingEntry. Mirrors freshly-generated state. */
export interface NewPendingInput {
  uuid: string;                                       // becomes HistoryEntry.id
  taskId?: string;
  prompt: string;
  provider: ProviderId;
  model?: string;
  workflowName?: string;
  resolution?: Resolution;
  aspectRatio?: AspectRatio;
  outputFormat?: OutputFormat;
  inputThumbnails?: string[];
  createdAt: number;
  status?: TaskStatus;                                // default "pending"
  thumbUrl?: string;
  previewUrl?: string;
  originalUrl?: string;
  outputUrl?: string;
  localBlobUrls?: string[];
}

// === Server-side row shape (re-export for callers) ===

export interface ServerOutput {
  id: number;
  generation_id: number;
  filename: string;
  filepath: string;
  content_type: string;
  size: number;
}

export interface ServerGeneration {
  id: number;
  username: string;
  workflow_name: string;
  prompt_data: string;
  execution_time_seconds: number;
  created_at: string;
  status: string;
  outputs: ServerOutput[];
}
