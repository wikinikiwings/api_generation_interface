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

/**
 * Runs `worker` over `items` with at most `concurrency` in flight
 * simultaneously. Returns results in input order. A rejection from
 * any worker aborts by rejecting the returned Promise.
 */
export async function runPool<T, R>(
  items: T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const runners = Array.from(
    { length: Math.min(concurrency, items.length) },
    async () => {
      while (true) {
        const i = next++;
        if (i >= items.length) return;
        results[i] = await worker(items[i], i);
      }
    }
  );
  await Promise.all(runners);
  return results;
}

/** True if either the pixel cap or the byte cap is exceeded (strict >). */
export function needsOptimizeByTriggers(
  bytes: number,
  width: number,
  height: number
): boolean {
  const longSide = Math.max(width, height);
  return longSide > MAX_LONG_SIDE || bytes > MAX_FILE_BYTES;
}

/** Compute new dimensions that cap the long side at `longSideCap`,
 *  preserving aspect ratio. Returns integer pixels. Original dims
 *  are returned unchanged when already under the cap. */
export function computeTargetDims(
  width: number,
  height: number,
  longSideCap: number
): { width: number; height: number } {
  const longSide = Math.max(width, height);
  if (longSide <= longSideCap) return { width, height };
  const scale = longSideCap / longSide;
  return {
    width: Math.round(width * scale),
    height: Math.round(height * scale),
  };
}

/** Rename a file by appending `-opt` before the extension, switching
 *  extension if the output MIME differs from the input extension. */
export function renameForOptimized(
  originalName: string,
  outputType: string
): string {
  const dot = originalName.lastIndexOf(".");
  const base = dot >= 0 ? originalName.slice(0, dot) : originalName;
  const newExt =
    outputType === "image/jpeg"
      ? "jpg"
      : outputType === "image/png"
      ? "png"
      : outputType === "image/webp"
      ? "webp"
      : "bin";
  return `${base}-opt.${newExt}`;
}

/** Aggregate decision: sum of current file sizes over the cap. */
export function needsAggregatePass2(results: OptimizeFileResult[]): boolean {
  const sum = results.reduce((acc, r) => acc + r.file.size, 0);
  return sum > MAX_AGGREGATE_BYTES;
}

/** Pick the indices of pass-1 outputs worth re-running through a tighter
 *  pass 2. Skips untouched files and alpha-PNGs under 4 MB (no meaningful
 *  gain). Returns both the index list and the filtered result refs for
 *  the caller's convenience. */
export function collectPass2Candidates(
  results: OptimizeFileResult[]
): { indices: number[]; entries: OptimizeFileResult[] } {
  const ALPHA_PNG_FLOOR = 4 * 1024 * 1024;
  const indices: number[] = [];
  const entries: OptimizeFileResult[] = [];
  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    if (!r.wasOptimized) continue;
    if (r.hasAlpha && r.file.size <= ALPHA_PNG_FLOOR) continue;
    indices.push(i);
    entries.push(r);
  }
  return { indices, entries };
}

export async function optimizeForUpload(
  _files: File[],
  _options?: OptimizeOptions
): Promise<OptimizeResult> {
  // Implementation built up across tasks 2-7.
  throw new Error("not implemented");
}
