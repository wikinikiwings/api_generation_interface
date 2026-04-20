# Image Dropzone Optimization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add client-side image optimization (resize + re-encode) to the dropzone so oversized user uploads (48MP phone photos, 8K screenshots, fat PNGs) no longer kill `/api/generate/submit` with "failed to fetch".

**Architecture:** A new client-only helper `lib/image-optimize.ts` runs on ingestion. Pass 1 resizes each file exceeding 4096 px or 12 MB to a safe target (4096 long-side, JPEG q=0.92 or PNG-preserved if alpha). Pass 2 runs if aggregate > 85 MB. `components/image-dropzone.tsx` shows placeholder tiles with spinner overlays while a bounded-concurrency worker pool (size 4) processes files in parallel. `components/generate-form.tsx` adds a one-line guard preventing submit while any image is still `status: "processing"`.

**Tech Stack:** TypeScript, React, `lucide-react` (Loader2), `sonner` toasts, `OffscreenCanvas` + `createImageBitmap` (with `<canvas>` fallback), vitest + jsdom.

**Reference spec:** `docs/superpowers/specs/2026-04-20-image-dropzone-optimization-design.md`

---

## Testing strategy

jsdom doesn't ship `OffscreenCanvas` or `createImageBitmap`. The plan therefore splits into:

- **Automated (vitest):** pure helpers — `runPool`, `needsOptimizeByTriggers`, `needsAggregatePass2`, `collectPass2Candidates`, `buildSuccessMessage`, `plural`, `renameForOptimized`.
- **Manual (dev browser):** `optimizeOneFile` and end-to-end drop/paste flow. Explicit scenarios listed in Task 13.

Vitest discovers `*.test.ts` by default regardless of directory. We place `lib/image-optimize.test.ts` next to the source file (single-file module; the `__tests__/` subfolder convention used by `lib/styles/` and `lib/history/` is a multi-file pattern and not a fit here).

---

### Task 1: Module skeleton — types, constants, named exports

**Files:**
- Create: `lib/image-optimize.ts`

- [ ] **Step 1: Create the skeleton file**

```ts
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
```

- [ ] **Step 2: Verify TypeScript compiles**

Run: `npx tsc --noEmit`
Expected: no errors. If a `hardwareConcurrency` or similar DOM-lib issue shows up, resolve it now.

- [ ] **Step 3: Commit**

```bash
git add lib/image-optimize.ts
git commit -m "feat(image-optimize): add module skeleton with types and thresholds

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: `runPool` concurrency helper + tests

**Files:**
- Modify: `lib/image-optimize.ts` (add `runPool`)
- Create: `lib/image-optimize.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `lib/image-optimize.test.ts`:

```ts
import { describe, it, expect, vi } from "vitest";
import { runPool } from "@/lib/image-optimize";

describe("runPool", () => {
  it("processes all items and preserves index order in the result", async () => {
    const items = ["a", "b", "c", "d", "e"];
    const worker = vi.fn(async (item: string, i: number) => `${i}:${item}`);
    const out = await runPool(items, 2, worker);
    expect(out).toEqual(["0:a", "1:b", "2:c", "3:d", "4:e"]);
    expect(worker).toHaveBeenCalledTimes(5);
  });

  it("caps concurrency to the given value", async () => {
    let running = 0;
    let peak = 0;
    const worker = async () => {
      running++;
      peak = Math.max(peak, running);
      await new Promise((r) => setTimeout(r, 10));
      running--;
      return null;
    };
    await runPool([1, 2, 3, 4, 5, 6, 7, 8], 3, worker);
    expect(peak).toBeLessThanOrEqual(3);
    expect(peak).toBeGreaterThan(0);
  });

  it("returns empty array for empty input without invoking worker", async () => {
    const worker = vi.fn();
    const out = await runPool([], 4, worker);
    expect(out).toEqual([]);
    expect(worker).not.toHaveBeenCalled();
  });

  it("propagates a worker rejection", async () => {
    const worker = async (item: number) => {
      if (item === 2) throw new Error("boom");
      return item * 10;
    };
    await expect(runPool([1, 2, 3], 2, worker)).rejects.toThrow("boom");
  });
});
```

- [ ] **Step 2: Run the tests — expect all fail**

Run: `npx vitest run lib/image-optimize.test.ts`
Expected: `runPool is not a function` or similar — compilation error is fine.

- [ ] **Step 3: Implement `runPool` in `lib/image-optimize.ts`**

Add to the module (top-level export, between constants and `optimizeForUpload`):

```ts
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
```

- [ ] **Step 4: Run tests — expect all pass**

Run: `npx vitest run lib/image-optimize.test.ts`
Expected: 4 passed.

- [ ] **Step 5: Commit**

```bash
git add lib/image-optimize.ts lib/image-optimize.test.ts
git commit -m "feat(image-optimize): add runPool with bounded concurrency

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: Pure threshold decision helpers + tests

**Files:**
- Modify: `lib/image-optimize.ts` (add `needsOptimizeByTriggers`, `computeTargetDims`, `renameForOptimized`)
- Modify: `lib/image-optimize.test.ts` (add tests)

- [ ] **Step 1: Write the failing tests**

Append to `lib/image-optimize.test.ts`:

```ts
import {
  needsOptimizeByTriggers,
  computeTargetDims,
  renameForOptimized,
  MAX_LONG_SIDE,
} from "@/lib/image-optimize";

describe("needsOptimizeByTriggers", () => {
  it("returns false when both size and longSide are under the caps", () => {
    expect(needsOptimizeByTriggers(5 * 1024 * 1024, 1920, 1080)).toBe(false);
  });
  it("returns true when longSide exceeds MAX_LONG_SIDE", () => {
    expect(needsOptimizeByTriggers(1 * 1024 * 1024, 8000, 6000)).toBe(true);
    expect(needsOptimizeByTriggers(1 * 1024 * 1024, 4097, 100)).toBe(true);
  });
  it("returns true when bytes exceed MAX_FILE_BYTES even if pixels are small", () => {
    expect(needsOptimizeByTriggers(13 * 1024 * 1024, 2000, 2000)).toBe(true);
  });
  it("returns false exactly at the boundaries", () => {
    expect(needsOptimizeByTriggers(12 * 1024 * 1024, 4096, 4096)).toBe(false);
  });
});

describe("computeTargetDims", () => {
  it("keeps original dims when longSide is under cap", () => {
    expect(computeTargetDims(1920, 1080, 4096)).toEqual({ width: 1920, height: 1080 });
  });
  it("scales landscape down so long side = cap", () => {
    expect(computeTargetDims(8000, 6000, 4096)).toEqual({ width: 4096, height: 3072 });
  });
  it("scales portrait down so long side = cap", () => {
    expect(computeTargetDims(6000, 8000, 4096)).toEqual({ width: 3072, height: 4096 });
  });
  it("rounds to integer pixels", () => {
    const r = computeTargetDims(4500, 3000, 4096);
    expect(Number.isInteger(r.width)).toBe(true);
    expect(Number.isInteger(r.height)).toBe(true);
  });
  it("uses the pass-2 cap when passed", () => {
    expect(computeTargetDims(8000, 6000, 3072)).toEqual({ width: 3072, height: 2304 });
  });
});

describe("renameForOptimized", () => {
  it("appends -opt before the extension when format is preserved", () => {
    expect(renameForOptimized("photo.png", "image/png")).toBe("photo-opt.png");
    expect(renameForOptimized("pic.webp", "image/webp")).toBe("pic-opt.webp");
  });
  it("changes the extension when the output type differs", () => {
    expect(renameForOptimized("photo.png", "image/jpeg")).toBe("photo-opt.jpg");
    expect(renameForOptimized("shot.PNG", "image/jpeg")).toBe("shot-opt.jpg");
  });
  it("handles names without an extension", () => {
    expect(renameForOptimized("image", "image/jpeg")).toBe("image-opt.jpg");
  });
  it("keeps dotted base names intact", () => {
    expect(renameForOptimized("some.name.v2.png", "image/jpeg")).toBe("some.name.v2-opt.jpg");
  });
});
```

- [ ] **Step 2: Run tests — expect import errors**

Run: `npx vitest run lib/image-optimize.test.ts`
Expected: fails (helpers not defined).

- [ ] **Step 3: Implement the helpers in `lib/image-optimize.ts`**

Add below `runPool`:

```ts
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
```

- [ ] **Step 4: Run tests — expect pass**

Run: `npx vitest run lib/image-optimize.test.ts`
Expected: all tests (including earlier ones) pass.

- [ ] **Step 5: Commit**

```bash
git add lib/image-optimize.ts lib/image-optimize.test.ts
git commit -m "feat(image-optimize): add pure threshold + rename helpers

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: Aggregate-pass decision + candidate selector + tests

**Files:**
- Modify: `lib/image-optimize.ts`
- Modify: `lib/image-optimize.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `lib/image-optimize.test.ts`:

```ts
import {
  needsAggregatePass2,
  collectPass2Candidates,
  MAX_AGGREGATE_BYTES,
} from "@/lib/image-optimize";
import type { OptimizeFileResult } from "@/lib/image-optimize";

function mkResult(over: Partial<OptimizeFileResult>): OptimizeFileResult {
  return {
    file: new File([], "x"),
    wasOptimized: false,
    originalBytes: 0,
    newBytes: 0,
    originalDims: { width: 0, height: 0 },
    newDims: { width: 0, height: 0 },
    hasAlpha: false,
    pass: 0,
    ...over,
  };
}

describe("needsAggregatePass2", () => {
  it("returns false when sum is under cap", () => {
    const rs = [
      mkResult({ file: new File([new Uint8Array(10_000_000)], "a") }),
      mkResult({ file: new File([new Uint8Array(10_000_000)], "b") }),
    ];
    expect(needsAggregatePass2(rs)).toBe(false);
  });
  it("returns true when sum exceeds MAX_AGGREGATE_BYTES", () => {
    const big = new Uint8Array(MAX_AGGREGATE_BYTES + 1);
    const rs = [mkResult({ file: new File([big], "big") })];
    expect(needsAggregatePass2(rs)).toBe(true);
  });
});

describe("collectPass2Candidates", () => {
  it("excludes untouched files (wasOptimized=false)", () => {
    const a = mkResult({ wasOptimized: false });
    const b = mkResult({
      wasOptimized: true,
      hasAlpha: false,
      file: new File([new Uint8Array(5_000_000)], "b"),
    });
    const { indices } = collectPass2Candidates([a, b]);
    expect(indices).toEqual([1]);
  });
  it("excludes alpha-PNGs below 4 MB", () => {
    const small = mkResult({
      wasOptimized: true,
      hasAlpha: true,
      file: new File([new Uint8Array(3_000_000)], "small"),
    });
    const big = mkResult({
      wasOptimized: true,
      hasAlpha: true,
      file: new File([new Uint8Array(6_000_000)], "big"),
    });
    const { indices } = collectPass2Candidates([small, big]);
    expect(indices).toEqual([1]);
  });
  it("includes all sized JPEG-output entries", () => {
    const a = mkResult({
      wasOptimized: true,
      hasAlpha: false,
      file: new File([new Uint8Array(100_000)], "a"),
    });
    const b = mkResult({
      wasOptimized: true,
      hasAlpha: false,
      file: new File([new Uint8Array(8_000_000)], "b"),
    });
    const { indices } = collectPass2Candidates([a, b]);
    expect(indices).toEqual([0, 1]);
  });
});
```

- [ ] **Step 2: Run tests — expect fail (imports)**

Run: `npx vitest run lib/image-optimize.test.ts`
Expected: fails.

- [ ] **Step 3: Implement the helpers**

Add to `lib/image-optimize.ts`:

```ts
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
```

- [ ] **Step 4: Run tests — expect pass**

Run: `npx vitest run lib/image-optimize.test.ts`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add lib/image-optimize.ts lib/image-optimize.test.ts
git commit -m "feat(image-optimize): add aggregate pass-2 decision helpers

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: Toast summary / plural helpers + tests

**Files:**
- Modify: `lib/image-optimize.ts`
- Modify: `lib/image-optimize.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `lib/image-optimize.test.ts`:

```ts
import { buildSuccessMessage, plural } from "@/lib/image-optimize";

describe("plural", () => {
  it("returns the correct Russian form", () => {
    expect(plural(1)).toBe("изображение");
    expect(plural(2)).toBe("изображения");
    expect(plural(3)).toBe("изображения");
    expect(plural(4)).toBe("изображения");
    expect(plural(5)).toBe("изображений");
    expect(plural(11)).toBe("изображений");
    expect(plural(21)).toBe("изображение");
    expect(plural(22)).toBe("изображения");
    expect(plural(25)).toBe("изображений");
  });
});

describe("buildSuccessMessage", () => {
  it("formats the no-optimization case", () => {
    const r: OptimizeResult = {
      files: [new File([], "a")],
      results: [mkResult({})],
      errors: [],
      aggregatePass2Triggered: false,
    };
    expect(buildSuccessMessage(r, 3)).toBe("Добавлено: 3");
  });

  it("formats the single-optimization-in-small-batch case with dims", () => {
    const r: OptimizeResult = {
      files: [new File([], "a"), new File([], "b")],
      results: [
        mkResult({ wasOptimized: false }),
        mkResult({
          wasOptimized: true,
          originalDims: { width: 8000, height: 6000 },
          newDims: { width: 4096, height: 3072 },
        }),
      ],
      errors: [],
      aggregatePass2Triggered: false,
    };
    expect(buildSuccessMessage(r, 2)).toBe(
      "1 из 2 оптимизирована: 8000×6000 → 4096×3072"
    );
  });

  it("formats the many-optimized case", () => {
    const results = Array.from({ length: 10 }, () =>
      mkResult({ wasOptimized: true })
    );
    const r: OptimizeResult = {
      files: results.map((x) => x.file),
      results,
      errors: [],
      aggregatePass2Triggered: false,
    };
    expect(buildSuccessMessage(r, 10)).toBe("Оптимизировано: 10 из 10");
  });
});
```

(Note: `OptimizeResult` and `mkResult` are already imported / defined earlier in the test file from Task 4.)

- [ ] **Step 2: Run tests — expect fail**

Run: `npx vitest run lib/image-optimize.test.ts`
Expected: fails.

- [ ] **Step 3: Implement helpers**

Add to `lib/image-optimize.ts`:

```ts
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
```

- [ ] **Step 4: Run tests — expect pass**

Run: `npx vitest run lib/image-optimize.test.ts`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add lib/image-optimize.ts lib/image-optimize.test.ts
git commit -m "feat(image-optimize): add toast summary + plural helpers

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: Core per-file optimizer `optimizeOneFile`

No automated tests — requires `OffscreenCanvas` / `createImageBitmap`, absent from jsdom. Verified manually in Task 13.

**Files:**
- Modify: `lib/image-optimize.ts`

- [ ] **Step 1: Add `optimizeOneFile` and its internals**

Append to `lib/image-optimize.ts` (keep it below the pure helpers, above `optimizeForUpload`):

```ts
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
    const byteTrigger = file.size > MAX_FILE_BYTES;
    const willWork = triggers || pixelTrigger;

    if (!willWork && !byteTrigger) {
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
```

- [ ] **Step 2: Verify TypeScript compiles**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 3: Run existing tests — expect still pass**

Run: `npx vitest run lib/image-optimize.test.ts`
Expected: existing pure-logic tests still pass.

- [ ] **Step 4: Commit**

```bash
git add lib/image-optimize.ts
git commit -m "feat(image-optimize): add optimizeOneFile (canvas + fallback)

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 7: Orchestrator `optimizeForUpload` with pass 1 + pass 2

**Files:**
- Modify: `lib/image-optimize.ts` (replace the `throw new Error("not implemented")` stub)

- [ ] **Step 1: Replace the stub with the real implementation**

Replace the body of `optimizeForUpload` with:

```ts
export async function optimizeForUpload(
  files: File[],
  options?: OptimizeOptions
): Promise<OptimizeResult> {
  const errors: OptimizeError[] = [];
  // Sparse results aligned with input indices. `undefined` slots mean
  // the file errored and must be filtered out at the end.
  const results: (OptimizeFileResult | undefined)[] = new Array(files.length);

  // ── Pass 1 ────────────────────────────────────────────────────────
  await runPool(files, CONCURRENCY, async (file, i) => {
    try {
      const r = await optimizeOneFile(file, PASS1_CONFIG);
      results[i] = r;
      options?.onFileComplete?.(i, r);
    } catch (e) {
      errors.push({
        fileName: file.name,
        reason: e instanceof Error ? e.message : String(e),
      });
    }
  });

  // Compact results (skip errored slots for subsequent steps).
  const presentResults: OptimizeFileResult[] = [];
  const presentIndices: number[] = [];
  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    if (r) {
      presentResults.push(r);
      presentIndices.push(i);
    }
  }

  // ── Pass 2 ────────────────────────────────────────────────────────
  let aggregatePass2Triggered = false;
  if (needsAggregatePass2(presentResults)) {
    aggregatePass2Triggered = true;
    const { indices: subIdx, entries } = collectPass2Candidates(presentResults);
    await runPool(entries, CONCURRENCY, async (entry, k) => {
      try {
        const r = await optimizeOneFile(entry.file, PASS2_CONFIG);
        // Mark the pass field as 2 so consumers can distinguish. If pass 2
        // didn't actually change anything (already under pass-2 triggers),
        // still mark pass=2 when wasOptimized was true originally.
        const merged: OptimizeFileResult = {
          ...r,
          // Preserve the original-source metadata from pass 1, not the
          // re-decoded pass-1-output as "original".
          originalBytes: entry.originalBytes,
          originalDims: entry.originalDims,
          wasOptimized: true,
          pass: 2,
        };
        // Index within presentResults → original index within files.
        const presentPos = subIdx[k];
        presentResults[presentPos] = merged;
        const originalIndex = presentIndices[presentPos];
        results[originalIndex] = merged;
        options?.onFileComplete?.(originalIndex, merged);
      } catch (e) {
        // A pass-2 failure leaves the pass-1 result in place. Record
        // the error so the caller can surface it if desired.
        errors.push({
          fileName: entry.file.name,
          reason: e instanceof Error ? e.message : String(e),
        });
      }
    });
  }

  const finalFiles: File[] = [];
  const finalResults: OptimizeFileResult[] = [];
  for (const r of results) {
    if (r) {
      finalFiles.push(r.file);
      finalResults.push(r);
    }
  }

  return {
    files: finalFiles,
    results: finalResults,
    errors,
    aggregatePass2Triggered,
  };
}
```

- [ ] **Step 2: Verify TypeScript compiles**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 3: Run existing tests**

Run: `npx vitest run lib/image-optimize.test.ts`
Expected: still pass (no change to the pure helpers).

- [ ] **Step 4: Commit**

```bash
git add lib/image-optimize.ts
git commit -m "feat(image-optimize): orchestrate pass 1 + pass 2 with concurrency

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 8: Extend `DroppedImage` with `status` + render placeholder tiles

**Files:**
- Modify: `components/image-dropzone.tsx`

- [ ] **Step 1: Add `status` to the exported interface**

In `components/image-dropzone.tsx`, replace the existing `DroppedImage` interface (around lines 9-18) with:

```ts
export interface DroppedImage {
  id: string;
  file: File;
  dataUrl: string;
  /** Natural pixel dimensions of the source image. Used by seedream
   *  providers to honor "Auto (match input)" aspect ratio — nano-banana
   *  models infer this server-side, but seedream needs an explicit size. */
  width: number;
  height: number;
  /** Absent = "ready". While "processing", `dataUrl` is a blob URL of
   *  the pre-optimization original and the tile shows a spinner
   *  overlay. The `×` and drag handlers are skipped for processing
   *  entries to avoid racing with the worker pool. */
  status?: "processing" | "ready";
}
```

- [ ] **Step 2: Add `Loader2` import**

In the `lucide-react` import at the top of the file, extend it:

```ts
import { Loader2, Plus, X } from "lucide-react";
```

- [ ] **Step 3: Update the per-tile render to branch on `status`**

Locate the tile render (around lines 272-341: the `value.map((img, idx) => ...)` block). Replace the entire `<div key={img.id} ...>` block with:

```tsx
{value.map((img, idx) => {
  const isProcessing = img.status === "processing";
  return (
    <div
      key={img.id}
      draggable={!isProcessing}
      onDragStart={(e) => {
        if (isProcessing) return;
        setDraggedId(img.id);
        e.dataTransfer.effectAllowed = "move";
        e.dataTransfer.setData("text/plain", img.id);
      }}
      onDragEnd={() => {
        setDraggedId(null);
        setDragOverId(null);
      }}
      onDragOver={(e) => {
        if (!draggedId || isProcessing) return;
        e.preventDefault();
        e.stopPropagation();
        e.dataTransfer.dropEffect = "move";
        if (dragOverId !== img.id) setDragOverId(img.id);
      }}
      onDragLeave={(e) => {
        if (!draggedId) return;
        e.stopPropagation();
        if (dragOverId === img.id) setDragOverId(null);
      }}
      onDrop={(e) => {
        if (!draggedId || isProcessing) return;
        e.preventDefault();
        e.stopPropagation();
        reorder(draggedId, img.id);
        setDraggedId(null);
        setDragOverId(null);
      }}
      className={cn(
        "group relative aspect-square overflow-hidden rounded-md border border-border bg-background p-1 transition-all",
        !isProcessing && "cursor-grab active:cursor-grabbing",
        draggedId === img.id && "opacity-40",
        dragOverId === img.id &&
          draggedId !== img.id &&
          "ring-2 ring-primary ring-offset-1 ring-offset-background"
      )}
    >
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={img.dataUrl}
        alt={img.file.name}
        draggable={false}
        className="h-full w-full select-none object-contain"
      />
      {isProcessing && (
        <div className="absolute inset-0 flex items-center justify-center bg-background/60 backdrop-blur-sm">
          <Loader2 className="h-6 w-6 animate-spin text-primary" />
        </div>
      )}
      <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/70 to-transparent p-1.5">
        <span className="text-[10px] text-white">#{idx + 1}</span>
      </div>
      {!isProcessing && (
        <Button
          type="button"
          variant="destructive"
          size="icon"
          className="absolute right-1 top-1 h-6 w-6 opacity-0 transition-opacity group-hover:opacity-100"
          onClick={(e) => {
            e.stopPropagation();
            handleRemove(img.id);
          }}
          aria-label="Remove image"
        >
          <X className="h-3 w-3" />
        </Button>
      )}
    </div>
  );
})}
```

- [ ] **Step 4: Verify TypeScript compiles**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add components/image-dropzone.tsx
git commit -m "feat(image-dropzone): add status field and placeholder tile render

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 9: Refactor `handleFiles` to use `optimizeForUpload` with placeholders + toasts

**Files:**
- Modify: `components/image-dropzone.tsx`

- [ ] **Step 1: Add import for the new module**

Add near the existing imports:

```ts
import {
  optimizeForUpload,
  buildSuccessMessage,
  plural,
} from "@/lib/image-optimize";
```

- [ ] **Step 2: Extract the existing id-builder into a local helper**

Just above `handleFiles` (inside the component, after the `valueRef` block), add:

```ts
const buildId = React.useCallback(
  (file: File) =>
    `${file.name}-${file.size}-${file.lastModified}-${Math.random()
      .toString(36)
      .slice(2, 6)}`,
  []
);
```

- [ ] **Step 3: Replace `handleFiles` body**

Replace the entire `handleFiles` `useCallback` with:

```ts
const handleFiles = React.useCallback(
  async (filesArg: FileList | File[]) => {
    const arr = Array.from(filesArg).filter((f) => f.type.startsWith("image/"));
    if (arr.length === 0) return;

    const current = valueRef.current;
    const room = maxImages - current.length;
    const toProcess = arr.slice(0, room);
    if (toProcess.length === 0) {
      toast.error(`Лимит ${maxImages} изображений достигнут`);
      return;
    }

    // 1. Insert blob-URL placeholders into value immediately.
    const placeholders: DroppedImage[] = toProcess.map((f) => ({
      id: buildId(f),
      file: f,
      dataUrl: URL.createObjectURL(f),
      width: 0,
      height: 0,
      status: "processing" as const,
    }));
    const placeholderIds = placeholders.map((p) => p.id);
    onChange([...valueRef.current, ...placeholders]);

    // Yield one frame so React commits the placeholder insert and the
    // valueRef useEffect updates. Otherwise a super-fast worker
    // completion could read a stale ref and drop the placeholder.
    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => resolve())
    );

    // 2. Kick off optimization with per-file replacement callback.
    const promise = optimizeForUpload(toProcess, {
      onFileComplete: async (index, result) => {
        const id = placeholderIds[index];
        const previous = valueRef.current.find((e) => e.id === id);
        // Previous entry's dataUrl is a blob URL OR the pass-1 data URL
        // (if pass 2 fires for the same slot). Revoke only blob URLs.
        if (previous && previous.dataUrl.startsWith("blob:")) {
          URL.revokeObjectURL(previous.dataUrl);
        }

        let dataUrl = "";
        let dims = { width: 0, height: 0 };
        try {
          dataUrl = await fileToDataURL(result.file);
          dims = await readImageDimensions(dataUrl);
        } catch (err) {
          console.error("Failed to finalize optimized file", result.file.name, err);
          // Fall through with empty dataUrl — tile will break but other
          // files proceed. The top-level catch below still reports.
        }

        const ready: DroppedImage = {
          id,
          file: result.file,
          dataUrl,
          width: dims.width,
          height: dims.height,
          status: "ready",
        };
        // Replace by id; if the placeholder was removed, map is a no-op.
        onChange(valueRef.current.map((e) => (e.id === id ? ready : e)));
      },
    });

    // 3. Single summary toast for the whole batch.
    await toast.promise(promise, {
      loading: `Обрабатываю ${toProcess.length} ${plural(toProcess.length)}...`,
      success: (r) => buildSuccessMessage(r, toProcess.length),
      error: "Не удалось обработать изображения",
    });

    const result = await promise;

    // 4. Side-effect toasts + cleanup of errored placeholders.
    if (result.aggregatePass2Triggered) {
      toast.warning(
        "Суммарный размер превысил лимит — сжатие усилено"
      );
    }
    if (result.errors.length > 0) {
      toast.error(
        result.errors.length === 1
          ? "1 файл не удалось прочитать"
          : `${result.errors.length} файл(ов) не удалось прочитать`
      );
      const erroredIds = new Set<string>();
      result.errors.forEach((e) => {
        const idx = toProcess.findIndex((f) => f.name === e.fileName);
        if (idx >= 0) erroredIds.add(placeholderIds[idx]);
      });
      // Revoke blob URLs of errored placeholders before removing.
      valueRef.current
        .filter((e) => erroredIds.has(e.id) && e.dataUrl.startsWith("blob:"))
        .forEach((e) => URL.revokeObjectURL(e.dataUrl));
      onChange(valueRef.current.filter((e) => !erroredIds.has(e.id)));
    }
  },
  [onChange, maxImages, buildId]
);
```

- [ ] **Step 4: Verify TypeScript compiles**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add components/image-dropzone.tsx
git commit -m "feat(image-dropzone): route handleFiles through optimizeForUpload

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 10: Add blob-URL cleanup `useEffect`

**Files:**
- Modify: `components/image-dropzone.tsx`

- [ ] **Step 1: Add a cleanup effect after the existing `valueRef` useEffect**

Insert right after the existing `useEffect(() => { valueRef.current = value; }, [value]);` block:

```ts
// On unmount, revoke any leftover blob URLs created for placeholders.
// Individual `onFileComplete` callbacks revoke on replacement, and the
// error path revokes on removal — this catches the edge case where the
// user navigates away mid-optimization.
React.useEffect(() => {
  return () => {
    for (const img of valueRef.current) {
      if (img.dataUrl.startsWith("blob:")) {
        URL.revokeObjectURL(img.dataUrl);
      }
    }
  };
}, []);
```

- [ ] **Step 2: Verify TypeScript compiles**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add components/image-dropzone.tsx
git commit -m "feat(image-dropzone): revoke blob URLs on unmount

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 11: Submit guard in `generate-form.tsx`

**Files:**
- Modify: `components/generate-form.tsx`

- [ ] **Step 1: Locate the submit handler**

Find `async function handleSubmit(e: React.FormEvent)` (around line 232). The first meaningful statement after `e.preventDefault()` and the comment block is the "Inner helper: POST the finished generation..." function declaration and then `if (!prompt.trim())` (around line 409).

- [ ] **Step 2: Insert the guard ABOVE the `if (!prompt.trim())` check**

Add this block just before `if (!prompt.trim())`:

```ts
// Block submit while any dropped image is still being optimized. The
// placeholder spinner UI tells the user what's happening; this prevents
// the submit from racing with the worker pool and shipping a File that
// was about to be replaced.
if (images.some((img) => img.status === "processing")) {
  toast.info("Дождитесь оптимизации изображений");
  return;
}
```

- [ ] **Step 3: Verify TypeScript compiles**

Run: `npx tsc --noEmit`
Expected: no errors (`img.status` resolves because `DroppedImage.status` is now typed).

- [ ] **Step 4: Commit**

```bash
git add components/generate-form.tsx
git commit -m "feat(generate-form): block submit while images are optimizing

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 12: Run full test suite + typecheck + lint

**Files:** none

- [ ] **Step 1: Run full vitest suite**

Run: `npx vitest run`
Expected: all previously passing tests still pass; new image-optimize tests all pass.

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 3: Build check**

Run: `npm run build`
Expected: successful production build. Flag any new warnings.

- [ ] **Step 4: Commit anything the build surfaced**

If the build requested any fixes (e.g. missing `"use client"` somewhere), apply and commit.

---

### Task 13: Manual smoke test in dev browser

No code changes. Verify end-to-end behavior.

- [ ] **Step 1: Start dev server**

Run: `npm run dev`
Navigate to `http://localhost:3000` (or `http://192.168.88.76:3000` per the project's deployments note).

- [ ] **Step 2: Scenario A — small JPEG, no optimization**

- Drop a 1–2 MB, 1920×1080 JPEG.
- Expected: tile appears instantly with NO spinner (file was under both triggers, so pass-1 took ~0 ms but the rAF yield + path still shows a micro-spinner; it should resolve in < 100 ms).
- Toast: `Добавлено: 1` (1.5 s).
- Generate to confirm submit still works.

- [ ] **Step 3: Scenario B — one huge PNG**

- Drop a 20+ MB PNG, 8000×6000 (take a 48MP phone photo or synthesize with ImageMagick: `convert -size 8000x6000 xc:white big.png`).
- Expected: placeholder spinner appears immediately with a blurred preview of the original.
- After ~500–1000 ms, tile resolves showing the downsized image.
- Toast: `1 из 1 оптимизирована: 8000×6000 → 4096×…` (dimensions match).
- Inspect element on the tile's `<img>` — `src` should start with `data:image/jpeg;base64,` (no alpha) OR `data:image/png;base64,` (if your PNG has alpha).

- [ ] **Step 4: Scenario C — mixed batch**

- Drop 5 files at once: 3 normal (< 2 MB), 2 huge (12+ MB, 4096+ long side).
- Expected: 5 placeholder spinners appear instantly; small files resolve almost immediately; huge ones take longer.
- Toast: `Оптимизировано: 2 из 5` (2 s).

- [ ] **Step 5: Scenario D — aggregate pass 2**

- Drop 4–6 huge PNGs totalling > 85 MB original.
- Expected: main toast as in scenario C. A second warning toast: `Суммарный размер превысил лимит — сжатие усилено` (3 s).

- [ ] **Step 6: Scenario E — submit while processing**

- Drop a huge file.
- While spinner is visible, click Generate.
- Expected: `toast.info("Дождитесь оптимизации изображений")`. Submit does NOT fire. Once optimization finishes, clicking Generate submits normally.

- [ ] **Step 7: Scenario F — paste from clipboard**

- Take a full-screen screenshot (typically 5–10 MB PNG).
- Focus anywhere on the page, press Ctrl+V.
- Expected: same flow as drop — placeholder, spinner, resolved tile. Combined with the existing paste toast.

- [ ] **Step 8: Scenario G — drag from history sidebar**

- Find a large-output entry in the history sidebar.
- Drag its thumbnail into the dropzone.
- Expected: `Загружаю оригинал...` toast → `Добавлено в исходном качестве` → `Обрабатываю 1 изображение...` → summary. Both toasts are acceptable per the spec.

- [ ] **Step 9: Scenario H — corrupted file**

- Create a file with a `.png` extension but random bytes: `dd if=/dev/urandom of=corrupt.png bs=1M count=20`
- Drop it.
- Expected: placeholder appears and then disappears; `toast.error("1 файл не удалось прочитать")`.
- The batch doesn't poison other files if dropped together with valid ones.

- [ ] **Step 10: End-to-end generation**

- Drop 2–3 real images, let them optimize.
- Click Generate.
- Expected: generation completes successfully, output appears in the OutputArea. Confirms optimized base64 payloads are accepted by `/api/generate/submit` and Fal.

- [ ] **Step 11: Final commit (if needed)**

If any of the above surfaced a bug, fix it and commit. If all green, no further commits needed.

---

## Done Criteria

- `lib/image-optimize.ts` module + adjacent test file present and all vitest tests green.
- `npx tsc --noEmit` clean.
- `npm run build` succeeds.
- Dropzone shows placeholder tiles with spinners while optimizing; normal files appear instantly.
- Submit guards against in-flight optimization.
- All manual smoke scenarios (A–H) behave as described in Task 13.
