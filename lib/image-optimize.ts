// lib/image-optimize.ts
// Client-only. Uses OffscreenCanvas / createImageBitmap with a
// <canvas> + HTMLImageElement fallback for browsers that lack them.
//
// Purpose: shrink oversized user uploads (48MP phone photos, 8K
// screenshots, fat PNGs) before they enter the DroppedImage pipeline.
// Small/normal images pass through untouched at zero cost.

export const MAX_LONG_SIDE = 4096;
export const MAX_FILE_BYTES = 12 * 1024 * 1024; // 12 MB
export const MAX_AGGREGATE_BYTES = 85 * 1024 * 1024; // 85 MB
export const JPEG_QUALITY_PASS1 = 0.92;
export const JPEG_QUALITY_PASS2 = 0.8;
export const MAX_LONG_SIDE_PASS2 = 3072;

/** Bounded-concurrency pool size. Matches the sweet spot between
 *  throughput and decoded-bitmap peak memory. */
export const CONCURRENCY =
  typeof navigator !== "undefined"
    ? Math.min(4, navigator.hardwareConcurrency || 4)
    : 4;

export interface OptimizeFileResult {
  /** The final File to use. May be the same reference as the input
   *  when no optimization was needed. */
  file: File;
  wasOptimized: boolean;
  originalBytes: number;
  newBytes: number;
  originalDims: { width: number; height: number };
  newDims: { width: number; height: number };
  hasAlpha: boolean;
  /** 0 = untouched, 1 = pass 1 only, 2 = also adjusted by pass 2 */
  pass: 0 | 1 | 2;
}

export interface OptimizeError {
  fileName: string;
  reason: string;
}

export interface OptimizeResult {
  /** Files in input order. Failed files are absent — check `errors`. */
  files: File[];
  /** Parallel metadata. Length may be < input if some files errored. */
  results: OptimizeFileResult[];
  errors: OptimizeError[];
  aggregatePass2Triggered: boolean;
}

export interface OptimizeOptions {
  /** Fires once per file as soon as that file's result is known.
   *  May fire TWICE for the same index if pass 2 re-optimizes it. */
  onFileComplete?: (index: number, result: OptimizeFileResult) => void;
}

export async function optimizeForUpload(
  _files: File[],
  _options?: OptimizeOptions
): Promise<OptimizeResult> {
  // Implementation built up across tasks 2-7.
  throw new Error("not implemented");
}
