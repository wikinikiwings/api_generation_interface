# Image Dropzone — Client-Side Optimization

**Date:** 2026-04-20
**Scope:** new module `lib/image-optimize.ts` and focused changes in `components/image-dropzone.tsx`. No server or provider changes.

## Problem

Users drop very large images (phone photos at 48MP, 8K screenshots, uncompressed PNGs) into the dropzone. These are serialized into base64 data URIs and shipped as a single JSON body to `/api/generate/submit`. Base64 inflates bytes by ~33 %, and at 14 slots the aggregate easily crosses the 100 MB nginx cap, producing `failed to fetch`.

The generative models themselves (nano-banana family, seedream) cap their real input at ~4K; anything above that is downscaled server-side by the provider anyway. The bytes between browser → our Next route → Fal/Wavespeed are wasted.

## Goal

Client-side, on ingestion, detect "too large" images and downscale / re-encode them before they enter `DroppedImage`. Images already within sane bounds pass through untouched. User sees placeholders with spinners while this happens, and a single summary toast per drop.

## Non-Goals

- No server-side resizing or new upload endpoint.
- No change to the submit flow, provider payloads, or history storage format.
- No change to `generate-form.tsx`, no change to provider code in `lib/providers/*`.
- No preservation of the untouched original on the client — once optimized, the reduced file replaces the original in `DroppedImage.file` and `dataUrl`. The user explicitly accepted this: oversized images are considered "accidental", not intentional.
- No support for animated GIFs preservation (first frame only — models don't process animation).

## Thresholds

Constants live in `lib/image-optimize.ts`:

| Constant | Value | Purpose |
|---|---|---|
| `MAX_LONG_SIDE` | 4096 px | Pixel trigger. Matches the practical ceiling of supported models. |
| `MAX_FILE_BYTES` | 12 MB | Byte trigger. Catches 2K/3K PNGs with complex content that happen to exceed the pixel-trigger's net. |
| `MAX_AGGREGATE_BYTES` | 85 MB | Aggregate trigger (pass 2). Keeps total body under nginx's 100 MB cap with headroom for JSON overhead. |
| `JPEG_QUALITY_PASS1` | 0.92 | High-quality encode during pass 1. |
| `JPEG_QUALITY_PASS2` | 0.80 | Harder compression when the aggregate still won't fit. |
| `MAX_LONG_SIDE_PASS2` | 3072 px | Tighter pixel cap for pass 2. |
| `CONCURRENCY` | `Math.min(4, navigator.hardwareConcurrency || 4)` | Worker-pool size. |

## Architecture

### New module `lib/image-optimize.ts`

Client-only (uses `OffscreenCanvas` / `createImageBitmap`). Header comment documents this.

Public API:

```ts
export interface OptimizeFileResult {
  file: File;                                    // may be the original (pass-through) or a new File
  wasOptimized: boolean;
  originalBytes: number;
  newBytes: number;
  originalDims: { width: number; height: number };
  newDims: { width: number; height: number };
  hasAlpha: boolean;
  pass: 0 | 1 | 2;                               // 0 = untouched, 1 = pass 1 only, 2 = also pass 2
}

export interface OptimizeError {
  fileName: string;
  reason: string;
}

export interface OptimizeResult {
  files: File[];                                 // same length as input, same order as input
  results: OptimizeFileResult[];                 // parallel array with metadata
  errors: OptimizeError[];                       // any files that failed entirely (excluded from `files`)
  aggregatePass2Triggered: boolean;
}

export interface OptimizeOptions {
  onFileComplete?: (index: number, result: OptimizeFileResult) => void;
}

export function optimizeForUpload(
  files: File[],
  options?: OptimizeOptions
): Promise<OptimizeResult>;
```

### Algorithm

**Pass 1 (per-file):**

1. Decode via `createImageBitmap(file)`. Width/height read from the bitmap.
2. Trigger check: `needsWork = longSide > MAX_LONG_SIDE || file.size > MAX_FILE_BYTES`. If `false` → return the original `File`, `wasOptimized=false`, `pass=0`. Close the bitmap.
3. Alpha detection:
   - `file.type === "image/jpeg"` → `hasAlpha=false` (JPEG has no alpha channel).
   - `file.type === "image/gif"` → `hasAlpha=true` (conservative; many GIFs are transparent).
   - `image/png` or `image/webp` → draw bitmap into a 64×64 `OffscreenCanvas`, `getImageData`, scan alpha channel early-exit. Sampled — full-resolution scan is wasteful and slow.
4. Compute target dims: if `longSide > MAX_LONG_SIDE`, scale down so `max(w,h) = MAX_LONG_SIDE`, preserving aspect ratio (rounded to integer pixels). Otherwise keep original pixels (pure byte-trigger case).
5. Resize on an `OffscreenCanvas(targetW, targetH)` via `ctx.drawImage(bitmap, 0, 0, targetW, targetH)`.
6. Encode: `hasAlpha` → `canvas.convertToBlob({type:"image/png"})`; otherwise `canvas.convertToBlob({type:"image/jpeg", quality: JPEG_QUALITY_PASS1})`.
7. Wrap: `new File([blob], renameForOptimized(originalName, outputType), { type: outputType, lastModified: file.lastModified })`.
8. `bitmap.close()` in `finally` to free memory.

**Pass 2 (aggregate):**

After pass 1 for all files, compute `sum(result.file.size)`. If `> MAX_AGGREGATE_BYTES`:

1. Collect pass-2 candidates: entries where `wasOptimized === true && (hasAlpha ? file.size > 4 MB : true)`. Skip already-tiny entries.
2. Re-run pass 1 logic on those, with `MAX_LONG_SIDE = MAX_LONG_SIDE_PASS2` and `JPEG_QUALITY = JPEG_QUALITY_PASS2`. PNG-with-alpha stays PNG, just smaller in pixels.
3. Each pass-2 completion fires `onFileComplete` again with updated metadata (`pass=2`).
4. Set `aggregatePass2Triggered=true`.
5. If the aggregate **still** exceeds `MAX_AGGREGATE_BYTES`: do not fail. Return results as-is. The caller shows a warning toast, and if the submit ultimately 413s, the existing error path surfaces it.

**Error handling:** any exception on a given file → captured in `errors[]`, that file is excluded from `files`, processing continues for the rest.

**Concurrency:** pass 1 runs through a `CONCURRENCY=4` worker pool (see `runPool` helper). Pass 2, same. Rationale: ~4× speedup without blowing memory. 4 × 48MP decoded bitmaps ≈ 800 MB peak, safe on modern hardware. `ImageBitmap.close()` immediately after each file keeps the peak bounded.

**Worker-pool helper (inline in the module):**

```ts
async function runPool<T, R>(
  items: T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const runners = Array.from({ length: concurrency }, async () => {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await worker(items[i], i);
    }
  });
  await Promise.all(runners);
  return results;
}
```

**Browser fallback:** if `typeof OffscreenCanvas === "undefined"` or `typeof createImageBitmap === "undefined"`, the module falls back to `<img>` + `HTMLCanvasElement` + `canvas.toBlob`. The fallback path is functionally identical and lives behind an `optimizeOneFile()` internal function that picks its strategy on import.

**File renaming:** `photo.png` → `photo-opt.jpg` (type changed) or `photo-opt.png` (alpha preserved). Suffix `-opt` makes it visible if the user right-clicks → Save As.

## Data-Model Changes

`components/image-dropzone.tsx` exports an extended `DroppedImage`:

```ts
export interface DroppedImage {
  id: string;
  file: File;
  dataUrl: string;
  width: number;
  height: number;
  status?: "processing" | "ready";  // optional — absent = "ready"
}
```

`status` is optional so every consumer outside `image-dropzone` keeps working unmodified (`status === undefined` behaves as "ready"). The only consumer today is `generate-form.tsx`, which reads `file`, `dataUrl`, `width`, `height` — none of those change semantics.

`generate-form.tsx` MUST NOT submit while any entry in `images` has `status === "processing"`. Enforcement:

- Submit handler checks `images.some(i => i.status === "processing")` at the start. If true: `toast.info("Дождитесь оптимизации изображений")`, return early.
- No disabling of the button is required (keeps the existing UI stable), but the guard prevents accidental submits.

This is the single intentional change in `generate-form.tsx`.

## UI Behavior

### Placeholder tile (new rendering branch in the map over `value`)

When `img.status === "processing"`:

- The tile still renders `<img src={img.dataUrl} />`, where `dataUrl` is a **blob URL** (`URL.createObjectURL(file)`). Instant, shows a preview of the original.
- Overlay: `<div className="absolute inset-0 flex items-center justify-center bg-background/60 backdrop-blur-sm">` with a `<Loader2 className="h-6 w-6 animate-spin text-primary" />` (icon from `lucide-react`, already used in the project).
- The `×` remove button is hidden (not rendered) while processing — removing mid-optimization races with the worker.
- `draggable` attribute is omitted and drag handlers are skipped — no reorder while processing.
- `#N` position badge renders as today (no change).

When `img.status === "ready"` (or undefined): rendered exactly as today.

### Ingestion flow (`handleFiles` refactor)

```ts
const handleFiles = async (filesArg: FileList | File[]) => {
  const arr = Array.from(filesArg).filter(f => f.type.startsWith("image/"));
  if (arr.length === 0) return;

  const current = valueRef.current;
  const room = maxImages - current.length;
  const toProcess = arr.slice(0, room);
  if (toProcess.length === 0) {
    toast.error(`Лимит ${maxImages} изображений достигнут`);
    return;
  }

  // 1. Build pending placeholders with blob-URL previews.
  const placeholders: DroppedImage[] = toProcess.map((f) => ({
    id: buildId(f),
    file: f,
    dataUrl: URL.createObjectURL(f),
    width: 0,
    height: 0,
    status: "processing",
  }));
  // Snapshot id ↔ index mapping for replacement later.
  const placeholderIds = placeholders.map(p => p.id);
  onChange([...valueRef.current, ...placeholders]);

  // IMPORTANT: yield one frame so React commits the placeholder insert and the
  // `useEffect(() => { valueRef.current = value })` hook updates the ref. If
  // `optimizeForUpload` finishes a file before this, `onFileComplete` would
  // read a stale valueRef (without our placeholders) and its .map() would
  // no-op, dropping both the placeholder and the optimized result.
  await new Promise<void>((resolve) =>
    requestAnimationFrame(() => resolve())
  );

  // 2. Kick off optimization with per-file completion callback.
  const promise = optimizeForUpload(toProcess, {
    onFileComplete: async (index, result) => {
      // Rebuild a ready DroppedImage for this slot.
      const id = placeholderIds[index];
      const oldEntry = valueRef.current.find(e => e.id === id);
      if (oldEntry) URL.revokeObjectURL(oldEntry.dataUrl);

      const dataUrl = await fileToDataURL(result.file);
      const dims = await readImageDimensions(dataUrl);
      const ready: DroppedImage = {
        id,
        file: result.file,
        dataUrl,
        width: dims.width,
        height: dims.height,
        status: "ready",
      };
      // Replace by id; if the placeholder was removed by the user, this is a no-op.
      onChange(valueRef.current.map(e => e.id === id ? ready : e));
    },
  });

  // 3. Single summary toast for the whole batch.
  await toast.promise(promise, {
    loading: `Обрабатываю ${toProcess.length} ${plural(toProcess.length)}...`,
    success: (r) => buildSuccessMessage(r, toProcess.length),
    error: "Не удалось обработать изображения",
  });

  const result = await promise;
  if (result.aggregatePass2Triggered) {
    toast.warning("Суммарный размер превысил лимит — сжатие усилено");
  }
  if (result.errors.length > 0) {
    toast.error(`${result.errors.length} файл(ов) не удалось прочитать`);
    // Remove any placeholders whose files ended up in errors[].
    const erroredIds = new Set<string>();
    result.errors.forEach((e) => {
      const idx = toProcess.findIndex(f => f.name === e.fileName);
      if (idx >= 0) erroredIds.add(placeholderIds[idx]);
    });
    onChange(valueRef.current.filter(e => !erroredIds.has(e.id)));
  }
};
```

(`buildId` is the existing id-builder expression extracted into a small helper.)

### Toast copy

Single toast per `handleFiles` invocation, via `toast.promise`:

- Loading: `Обрабатываю N изображени{е/я/й}...`.
- Success — decided from `OptimizeResult`:

| Condition | Message | Duration |
|---|---|---|
| `optimizedCount === 0` | `Добавлено: N` | 1.5 s |
| `optimizedCount === 1 && total <= 2` | `1 из N оптимизирована: 8000×6000 → 4096×3072` (dims from the single optimized entry) | 2 s |
| otherwise | `Оптимизировано: X из N` | 2 s |

Side toasts (in addition to the main one):
- Pass 2 triggered: `toast.warning("Суммарный размер превысил лимит — сжатие усилено")`, 3 s.
- One or more files failed: `toast.error("N файл(ов) не удалось прочитать")`, 3 s.

## Drag-From-History Compatibility

`ingestMediaPayload` (current `image-dropzone.tsx` line 215+) fetches the full-resolution original from the server with its own `toast.promise` (`"Загружаю оригинал..."` → `"Добавлено в исходном качестве"`) and then calls `handleFiles([file])`. After this change, `handleFiles` itself fires another `toast.promise` for optimization. The user sees a short sequence:

1. `"Загружаю оригинал..."` (spinner) → `"Добавлено в исходном качестве"` (success, 1.5 s).
2. `"Обрабатываю 1 изображение..."` → the appropriate summary message.

Acceptable — each toast is truthful about its stage, and both are short. If empirically this feels noisy, a future cleanup can replace `ingestMediaPayload`'s own `toast.promise` with the inner optimize toast only; not required for this change.

## Behaviors Explicitly Preserved

- All existing dropzone affordances: OS file drop, paste (Ctrl+V), click-to-pick, custom-MIME history drag-in, tile reorder, tile remove, `maxImages` limit, `+` add-tile.
- `DroppedImage.width` / `.height` — still natural pixels of **whatever image is currently in the slot**. After optimization these are the post-resize dims, which is what seedream's "Auto (match input)" aspect actually cares about (the ratio is preserved).
- `generate-form.tsx` submit body shape unchanged.
- `fileToDataURL`, `readImageDimensions`, `fileToThumbnail` — unchanged.
- Thumbnails stored in history (`inputThumbnails` built via `fileToThumbnail(img.file, 240, 0.8)`) — still downscaled to 240 px regardless of whether the source file was optimized. No change to history storage.

## Edge Cases

- **Concurrent `handleFiles` calls** (e.g. a paste happens while a drop is still optimizing): each call manages its own `placeholderIds`. The existing `valueRef.current` race-guard (already in `handleFiles`, comments at current lines 52–55 and 87–88) still protects against interleaving because all `onChange` calls read and spread the latest ref — no assumption about "what we appended earlier is still at the end".
- **User removes a placeholder while optimizing**: the `onFileComplete` callback's replacement uses `id` lookup. If the id isn't present, `map` leaves the array untouched. Blob URL is revoked in that path too (cleanup handled in the remove button for `status==="processing"` entries — but button is hidden, so this can only happen via the next point).
- **User refreshes / navigates away mid-optimization**: React unmount → blob URLs would leak, but for a single session this is negligible (browser cleans up on navigation). An explicit `useEffect` cleanup that walks `value` and revokes any `processing` blob URLs on unmount is trivial to add — included in the plan.
- **`room < toProcess.length`** (user dropped more than the remaining slots): handled by existing `arr.slice(0, room)`. Overflow gets a `toast.info` indicating truncation (existing behavior, kept).
- **HEIC / HEIF from iOS paste**: `createImageBitmap` rejects on unsupported formats → captured in `errors[]`. No regression (today's `fileToDataURL` + canvas wouldn't handle these either; they'd silently go in but break downstream).
- **Submit guard**: if user clicks Generate while any placeholder is still processing → toast + early return. This is the ONLY change in `generate-form.tsx`.

## Memory & Performance

- Peak memory: `CONCURRENCY × size(decoded bitmap)`. Worst case 4 × 48MP RGBA = ~768 MB decoded + the canvas(es) = ~1 GB peak. Realistic drops (1–4 files) stay well under.
- `ImageBitmap.close()` in `finally` is mandatory. Each bitmap held beyond the encode step blocks GC of 50+ MB of decoded pixels.
- UI responsiveness: `createImageBitmap` and `OffscreenCanvas.convertToBlob` are off-main-thread in modern browsers. Main thread handles `<img>` renders of blob URLs (cheap — browser decodes natively on paint) and toast updates.
- Typical latencies per-file:
  - Small (under both thresholds): 0 ms.
  - Single 8K JPEG: ~400 ms.
  - Single 4K PNG → JPEG: ~300 ms.
  - Single 4K PNG with alpha → PNG: ~700 ms.
  - Aggregate pass 2 adds one additional latency of similar magnitude for pass-2 candidates only.

## Testing

### Automated

New file `lib/image-optimize.test.ts`:

1. Small JPEG under thresholds → same File ref out, `wasOptimized=false`.
2. 8000×6000 synthetic JPEG → new File, type `image/jpeg`, longSide=4096, aspect preserved, `wasOptimized=true`.
3. 4096×4096 PNG with alpha (heavy content, > 12 MB) → new File, type `image/png`, dims unchanged, `hasAlpha=true`.
4. 4096×4096 PNG without alpha, > 12 MB → converts to JPEG, `hasAlpha=false`.
5. Three large synthetic PNGs aggregating > 85 MB → `aggregatePass2Triggered=true`, post-pass-2 aggregate smaller.
6. Corrupted PNG bytes with `image/png` MIME → added to `errors[]`, other files in the batch unaffected.
7. Mixed batch (small + large) → index order preserved, only the large entry is optimized.
8. `onFileComplete` fires exactly once per file in pass 1, plus additional fires for pass-2 candidates.

Runner: vitest (already configured at `vitest.config.ts` / `vitest.setup.ts`). `happy-dom` or `jsdom` likely lacks `OffscreenCanvas` / `createImageBitmap` — confirm during implementation and either (a) configure the fallback path under the test env, or (b) polyfill the globals with a minimal stub (just enough for the algorithm to run on synthetic PixelBuffers). A third option: expose the core function as a pure `(rgba, w, h) => rgba` and test it with in-memory buffers, bypassing canvas for unit tests. Decide during implementation; the spec's correctness doesn't depend on which path.

### Manual smoke

After merge, verify in the dev environment:

- Drop a 20+ MB PNG from disk → placeholder spinner appears instantly, resolves in < 1 s, single success toast, tile shows the smaller version.
- Drop 10 mixed files → 10 spinners appear, resolve progressively, summary toast `"Оптимизировано: X из 10"`.
- Drag an image from the history sidebar → nested toasts are coherent and ordered.
- Paste a screenshot (Ctrl+V) → same flow.
- Click Generate mid-optimization → info toast, no submit fires.
- Generate completes correctly with optimized images (end-to-end sanity check on the fal provider).

## Files Touched

- `lib/image-optimize.ts` — new.
- `lib/image-optimize.test.ts` — new.
- `components/image-dropzone.tsx` — `handleFiles` refactor, `DroppedImage` adds `status`, placeholder tile rendering branch, blob-URL cleanup `useEffect`.
- `components/generate-form.tsx` — submit-handler guard against `status === "processing"`.

Everything else stays as-is.
