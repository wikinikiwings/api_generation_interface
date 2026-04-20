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

/** Russian plural of "изображение" based on cardinal `n`. */
export function plural(n: number): "изображение" | "изображения" | "изображений" {
  const mod100 = n % 100;
  const mod10 = n % 10;
  if (mod100 >= 11 && mod100 <= 14) return "изображений";
  if (mod10 === 1) return "изображение";
  if (mod10 >= 2 && mod10 <= 4) return "изображения";
  return "изображений";
}

/** Build the success-toast text from an optimize result. See spec. */
export function buildSuccessMessage(
  result: OptimizeResult,
  totalCount: number
): string {
  const optimized = result.results.filter((r) => r.wasOptimized);
  if (optimized.length === 0) return `Добавлено: ${totalCount}`;
  if (optimized.length === 1 && totalCount <= 2) {
    const r = optimized[0];
    return `1 из ${totalCount} оптимизирована: ${r.originalDims.width}×${r.originalDims.height} → ${r.newDims.width}×${r.newDims.height}`;
  }
  return `Оптимизировано: ${optimized.length} из ${totalCount}`;
}

// ── Canvas-backed implementation ──────────────────────────────────────

interface OptimizeConfig {
  maxLongSide: number;
  jpegQuality: number;
}

const PASS1_CONFIG: OptimizeConfig = {
  maxLongSide: MAX_LONG_SIDE,
  jpegQuality: JPEG_QUALITY_PASS1,
};

const PASS2_CONFIG: OptimizeConfig = {
  maxLongSide: MAX_LONG_SIDE_PASS2,
  jpegQuality: JPEG_QUALITY_PASS2,
};

/** Returns true if the browser supports the fast path. */
function hasOffscreenStack(): boolean {
  return (
    typeof OffscreenCanvas !== "undefined" &&
    typeof createImageBitmap !== "undefined"
  );
}

/** Decode a File to an ImageBitmap via createImageBitmap (fast path)
 *  OR via HTMLImageElement + object URL (fallback). */
async function decodeFile(file: File): Promise<{
  width: number;
  height: number;
  drawInto: (ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D, w: number, h: number) => void;
  close: () => void;
}> {
  if (hasOffscreenStack()) {
    const bitmap = await createImageBitmap(file);
    return {
      width: bitmap.width,
      height: bitmap.height,
      drawInto: (ctx, w, h) => ctx.drawImage(bitmap, 0, 0, w, h),
      close: () => bitmap.close(),
    };
  }
  // Fallback: load via Image + object URL.
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const el = new Image();
      el.onload = () => resolve(el);
      el.onerror = () => reject(new Error("Image decode failed"));
      el.src = url;
    });
    return {
      width: img.naturalWidth,
      height: img.naturalHeight,
      drawInto: (ctx, w, h) => ctx.drawImage(img, 0, 0, w, h),
      close: () => URL.revokeObjectURL(url),
    };
  } catch (e) {
    URL.revokeObjectURL(url);
    throw e;
  }
}

/** Cheap alpha sampling: draw the image into a 64×64 canvas and scan
 *  for any pixel with alpha < 255. Called only for MIME types that can
 *  carry alpha (png/webp/gif). */
async function sampleAlpha(decoded: {
  drawInto: (ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D, w: number, h: number) => void;
}): Promise<boolean> {
  const W = 64;
  const H = 64;
  if (hasOffscreenStack()) {
    const c = new OffscreenCanvas(W, H);
    const ctx = c.getContext("2d");
    if (!ctx) return true; // conservative
    decoded.drawInto(ctx, W, H);
    const data = ctx.getImageData(0, 0, W, H).data;
    for (let i = 3; i < data.length; i += 4) {
      if (data[i] < 255) return true;
    }
    return false;
  }
  const c = document.createElement("canvas");
  c.width = W;
  c.height = H;
  const ctx = c.getContext("2d");
  if (!ctx) return true;
  decoded.drawInto(ctx, W, H);
  const data = ctx.getImageData(0, 0, W, H).data;
  for (let i = 3; i < data.length; i += 4) {
    if (data[i] < 255) return true;
  }
  return false;
}

/** Encode a decoded image to a Blob at `targetW × targetH` using
 *  `outputType` + `quality`. */
async function encodeToBlob(
  decoded: Pick<Awaited<ReturnType<typeof decodeFile>>, "drawInto">,
  targetW: number,
  targetH: number,
  outputType: string,
  quality: number
): Promise<Blob> {
  if (hasOffscreenStack()) {
    const c = new OffscreenCanvas(targetW, targetH);
    const ctx = c.getContext("2d");
    if (!ctx) throw new Error("2d context unavailable");
    decoded.drawInto(ctx, targetW, targetH);
    return c.convertToBlob({ type: outputType, quality });
  }
  const c = document.createElement("canvas");
  c.width = targetW;
  c.height = targetH;
  const ctx = c.getContext("2d");
  if (!ctx) throw new Error("2d context unavailable");
  decoded.drawInto(ctx, targetW, targetH);
  return new Promise<Blob>((resolve, reject) => {
    c.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error("toBlob returned null"))),
      outputType,
      quality
    );
  });
}

/** Optimize a single file with the given config. The caller decides
 *  whether optimization is warranted; this function still checks and
 *  will return `wasOptimized=false` (with the original `file`) if
 *  triggers don't apply under THIS config. */
export async function optimizeOneFile(
  file: File,
  config: OptimizeConfig = PASS1_CONFIG
): Promise<OptimizeFileResult> {
  const decoded = await decodeFile(file);
  try {
    const origDims = { width: decoded.width, height: decoded.height };

    const triggers = needsOptimizeByTriggers(file.size, decoded.width, decoded.height);
    // A pass-2 call may be over a file that's under the pass-1 triggers
    // (e.g. the JPEG output of pass 1). We still run a resize if the
    // pass-2 cap is smaller than current dims.
    const pixelTrigger =
      Math.max(decoded.width, decoded.height) > config.maxLongSide;
    const willWork = triggers || pixelTrigger;

    if (!willWork) {
      return {
        file,
        wasOptimized: false,
        originalBytes: file.size,
        newBytes: file.size,
        originalDims: origDims,
        newDims: origDims,
        hasAlpha: false,
        pass: 0,
      };
    }

    // Alpha detection only for MIME types that can carry it.
    let hasAlpha = false;
    if (file.type === "image/png" || file.type === "image/webp") {
      hasAlpha = await sampleAlpha(decoded);
    } else if (file.type === "image/gif") {
      hasAlpha = true;
    }

    const target = computeTargetDims(
      decoded.width,
      decoded.height,
      config.maxLongSide
    );
    const outputType = hasAlpha ? "image/png" : "image/jpeg";
    const blob = await encodeToBlob(
      decoded,
      target.width,
      target.height,
      outputType,
      config.jpegQuality
    );
    const newName = renameForOptimized(file.name, outputType);
    const newFile = new File([blob], newName, {
      type: outputType,
      lastModified: file.lastModified,
    });

    return {
      file: newFile,
      wasOptimized: true,
      originalBytes: file.size,
      newBytes: newFile.size,
      originalDims: origDims,
      newDims: target,
      hasAlpha,
      pass: 1,
    };
  } finally {
    decoded.close();
  }
}

export async function optimizeForUpload(
  _files: File[],
  _options?: OptimizeOptions
): Promise<OptimizeResult> {
  // Implementation built up across tasks 2-7.
  throw new Error("not implemented");
}
