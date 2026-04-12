# History Thumbnail-First Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the history sidebar thumbnail the FIRST image to appear after generation completes (≤200ms), by generating all image variants client-side, inserting an optimistic pending entry into the sidebar synchronously, and reducing the server to dumb storage.

**Architecture:** Client canvas-downscales the completed image into `thumb` (240px JPEG q70) and `mid` (1200px JPEG q85) variants. A new `lib/pending-history.ts` singleton holds optimistic entries keyed by a client-generated UUID; `useHistory` merges them with server rows. `generate-form.tsx` fires a multipart upload in the background; the server writes the three files in parallel (no `sharp`) and returns. On confirmation, the pending entry is cleared and the server row is shown instead.

**Tech Stack:** Next.js 15, React 19, Zustand, SQLite (better-sqlite3), TypeScript. **No test runner in repo** — plan uses type-check (`npm run build`), runtime dev-server verification, and focused ad-hoc scripts for pure-function checks. A full vitest setup would be a separate infra change and is out of scope.

---

## Spec reference

`docs/superpowers/specs/2026-04-12-history-thumbnail-first-design.md`

## Important architectural clarification vs. spec

The spec's "insert optimistic entry into the store" (Key Design Decision #2) is ambiguous about which store. The history **sidebar** reads `ServerGeneration` rows from SQLite via `useHistory`, **not** the Zustand `useHistoryStore` (which feeds the Output panel). To make the thumbnail appear first in the sidebar, we introduce `lib/pending-history.ts` — a singleton that holds optimistic entries for the sidebar, independent of the Zustand store. The Zustand store retains its current role (Output panel, unchanged in this plan except for linking blob URLs to the `historyId` entry so the Output panel also benefits).

## File Structure

### New files

- **`lib/image-variants.ts`** — pure client-side image downscaler. `createImageVariants(source: Blob | string)` returns `{ thumb, mid, full }`. Uses `createImageBitmap` + `OffscreenCanvas` with DOM-canvas fallback. No project-domain knowledge.
- **`lib/history-upload.ts`** — multipart POST helper. `uploadHistoryEntry(params)` returns server URLs or throws. Thin wrapper around `fetch` + `FormData` with `AbortSignal`.
- **`lib/pending-history.ts`** — singleton store for optimistic sidebar entries. Mutates a `Map<uuid, PendingGeneration>`; exposes `addPending / confirmPending / markError / retry / subscribe / getAll`. Handles blob URL revocation on removal.

### Modified files

- **`stores/history-store.ts`** — add `localBlobUrls?`, `uploadError?`, `confirmed?` fields to entries; revoke blob URLs on remove/clear.
- **`hooks/use-history.ts`** — expose merged `items` combining `getAll()` from pending-history + server fetched items, dedupe by uuid. Subscribe to pending-history changes.
- **`components/history-sidebar.tsx`** — the card component accepts either a `ServerGeneration` or a `PendingGeneration`; shows an inline error/retry control for `uploadError`; preload excludes pending blob URLs.
- **`components/generate-form.tsx`** — replace current `saveToServerHistory` body: generate variants, `addPending`, fire-and-forget `uploadHistoryEntry`, on success `confirmPending`, on error `markError`.
- **`app/api/history/route.ts`** — accept multipart with required `uuid`, `original`, `thumb`, `mid`; write files in parallel; rollback on partial failure; remove `sharp` usage and `THUMB_*`/`MID_*` constants.

### No changes

- `lib/image-cache.ts` (preload API unchanged)

### Minor modification

- **`app/api/history/image/[filename]/route.ts`** — add `.jpg ↔ .png` fallback for `mid_*` lookups so legacy on-disk `mid_<uuid>.png` still serves when requested as `mid_<uuid>.jpg`. See Task 3b.

---

## Task 1: `lib/image-variants.ts` — client-side downscaler

**Files:**
- Create: `lib/image-variants.ts`

This module is pure and has no project dependencies. Other tasks build on its API.

- [ ] **Step 1: Create `lib/image-variants.ts` with the full implementation**

```ts
/**
 * Client-side image variant generator.
 *
 * Produces downscaled JPEGs suitable for history UI:
 *   - thumb: 240px JPEG q70  (~15 KB typical)
 *   - mid:   1200px JPEG q85 (~150 KB typical)
 *
 * If the source is smaller than the target width, the variant equals
 * the source (re-encoded as JPEG for format normalization).
 *
 * Uses OffscreenCanvas off the main thread when available; falls back
 * to HTMLCanvasElement on older browsers (notably iOS < 16.4).
 */

const THUMB_WIDTH = 240;
const THUMB_QUALITY = 0.7;
const MID_WIDTH = 1200;
const MID_QUALITY = 0.85;

export interface ImageVariants {
  /** 240px JPEG q70. */
  thumb: Blob;
  /** 1200px JPEG q85. */
  mid: Blob;
  /** Source blob, unchanged (pass-through). */
  full: Blob;
}

export async function createImageVariants(
  source: Blob | string
): Promise<ImageVariants> {
  const full =
    typeof source === "string" ? await fetchAsBlob(source) : source;

  const bitmap = await decode(full);
  try {
    const [thumb, mid] = await Promise.all([
      encodeVariant(bitmap, THUMB_WIDTH, THUMB_QUALITY),
      encodeVariant(bitmap, MID_WIDTH, MID_QUALITY),
    ]);
    return { thumb, mid, full };
  } finally {
    // ImageBitmap is GC-able but close() releases GPU memory eagerly.
    if ("close" in bitmap) bitmap.close();
  }
}

async function fetchAsBlob(url: string): Promise<Blob> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`fetch ${url}: HTTP ${res.status}`);
  return res.blob();
}

async function decode(blob: Blob): Promise<ImageBitmap> {
  if (typeof createImageBitmap === "function") {
    return createImageBitmap(blob);
  }
  return decodeViaImageElement(blob);
}

async function decodeViaImageElement(blob: Blob): Promise<ImageBitmap> {
  const url = URL.createObjectURL(blob);
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const el = new Image();
      el.onload = () => resolve(el);
      el.onerror = () => reject(new Error("decode failed"));
      el.src = url;
    });
    // Wrap HTMLImageElement in an ImageBitmap-like facade. We only need
    // width/height and the ability to draw it, which `drawImage` accepts
    // on both HTMLImageElement and ImageBitmap.
    return {
      width: img.naturalWidth,
      height: img.naturalHeight,
      close: () => {},
      // @ts-expect-error — HTMLImageElement stands in for ImageBitmap here
      __img: img,
    } as unknown as ImageBitmap;
  } finally {
    URL.revokeObjectURL(url);
  }
}

async function encodeVariant(
  bitmap: ImageBitmap,
  targetWidth: number,
  quality: number
): Promise<Blob> {
  const { width: sw, height: sh } = bitmap;
  const scale = sw <= targetWidth ? 1 : targetWidth / sw;
  const dw = Math.round(sw * scale);
  const dh = Math.round(sh * scale);

  if (typeof OffscreenCanvas !== "undefined") {
    const canvas = new OffscreenCanvas(dw, dh);
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("OffscreenCanvas 2d ctx unavailable");
    drawInto(ctx, bitmap, dw, dh);
    return canvas.convertToBlob({ type: "image/jpeg", quality });
  }

  const canvas = document.createElement("canvas");
  canvas.width = dw;
  canvas.height = dh;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Canvas 2d ctx unavailable");
  drawInto(ctx, bitmap, dw, dh);
  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(
      (b) => (b ? resolve(b) : reject(new Error("canvas.toBlob returned null"))),
      "image/jpeg",
      quality
    );
  });
}

function drawInto(
  ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
  bitmap: ImageBitmap,
  dw: number,
  dh: number
) {
  const source =
    (bitmap as unknown as { __img?: CanvasImageSource }).__img ?? bitmap;
  ctx.drawImage(source, 0, 0, dw, dh);
}
```

- [ ] **Step 2: Type-check compiles**

Run: `npx tsc --noEmit`
Expected: succeeds with zero errors.

- [ ] **Step 3: Ad-hoc runtime check via dev server**

Add a temporary dev-only log in a component that has access to an image `File` (e.g. paste in `components/generate-form.tsx` inside `handleSubmit` briefly):
```ts
if (images[0]) {
  const v = await (await import("@/lib/image-variants")).createImageVariants(
    images[0].file
  );
  console.log("[variants]", {
    thumb: v.thumb.size,
    mid: v.mid.size,
    full: v.full.size,
  });
}
```
Run: `npm run dev`, paste an image in the UI, trigger submit.
Expected: console logs three byte sizes; thumb < 50 KB, mid < 500 KB, full = original bytes.

Remove the log before commit.

- [ ] **Step 4: Commit**

```bash
git add lib/image-variants.ts
git commit -m "feat(variants): add createImageVariants canvas downscaler"
```

---

## Task 2: `lib/history-upload.ts` — multipart upload helper

**Files:**
- Create: `lib/history-upload.ts`

Depends on types in `types/wavespeed.ts` only for shared shapes; no runtime import from Task 1 required.

- [ ] **Step 1: Create `lib/history-upload.ts` with full implementation**

```ts
/**
 * Upload a completed generation to /api/history as multipart form data.
 *
 * The server writes the provided original/thumb/mid bytes as-is under
 * names derived from `uuid`, then returns the public URLs. The uuid
 * MUST be a fresh crypto.randomUUID() generated on the client — it
 * doubles as the server-side base filename.
 */

export interface UploadHistoryParams {
  uuid: string;
  username: string;
  workflowName: string;
  promptData: Record<string, unknown>;
  executionTimeSeconds: number;
  original: Blob;
  originalFilename: string;
  originalContentType: string;
  thumb: Blob;
  mid: Blob;
  signal?: AbortSignal;
}

export interface UploadHistoryResult {
  serverGenId: number;
  fullUrl: string;
  thumbUrl: string;
  midUrl: string;
}

export async function uploadHistoryEntry(
  p: UploadHistoryParams
): Promise<UploadHistoryResult> {
  const fd = new FormData();
  fd.append("uuid", p.uuid);
  fd.append("username", p.username);
  fd.append("workflowName", p.workflowName);
  fd.append("promptData", JSON.stringify(p.promptData));
  fd.append("executionTimeSeconds", String(p.executionTimeSeconds));
  fd.append(
    "original",
    new File([p.original], p.originalFilename, {
      type: p.originalContentType || p.original.type || "application/octet-stream",
    })
  );
  fd.append("thumb", new File([p.thumb], `thumb_${p.uuid}.jpg`, { type: "image/jpeg" }));
  fd.append("mid", new File([p.mid], `mid_${p.uuid}.jpg`, { type: "image/jpeg" }));

  const res = await fetch("/api/history", {
    method: "POST",
    body: fd,
    signal: p.signal,
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new UploadError(res.status, body);
  }

  const json = (await res.json()) as {
    id?: number;
    success?: boolean;
    fullUrl?: string;
    thumbUrl?: string;
    midUrl?: string;
  };

  if (
    typeof json.id !== "number" ||
    !json.fullUrl ||
    !json.thumbUrl ||
    !json.midUrl
  ) {
    throw new UploadError(0, `Malformed upload response: ${JSON.stringify(json)}`);
  }

  return {
    serverGenId: json.id,
    fullUrl: json.fullUrl,
    thumbUrl: json.thumbUrl,
    midUrl: json.midUrl,
  };
}

export class UploadError extends Error {
  constructor(public status: number, public body: string) {
    super(`Upload failed: HTTP ${status}${body ? ` — ${body.slice(0, 200)}` : ""}`);
    this.name = "UploadError";
  }
}
```

- [ ] **Step 2: Type-check compiles**

Run: `npx tsc --noEmit`
Expected: succeeds.

- [ ] **Step 3: Commit**

```bash
git add lib/history-upload.ts
git commit -m "feat(history): add uploadHistoryEntry multipart helper"
```

---

## Task 3: Change server POST handler — dumb storage, no sharp

**Files:**
- Modify: `app/api/history/route.ts`

This intentionally precedes wiring on the client. The new server accepts the new multipart shape AND no longer matches the old shape, so no client changes yet depend on it being backward-compatible. Client wiring lands in Tasks 7–8.

- [ ] **Step 1: Rewrite POST handler**

Replace the POST function and helpers in `app/api/history/route.ts`. The GET and DELETE handlers stay intact.

Replace lines 11 and 13–19 with:
```ts
// sharp is no longer imported — client pre-generates thumb/mid.

// Read more generously than /api/generate/submit since we write image files.
export const maxDuration = 30;
```

(Drop the `import sharp from "sharp";` line; drop `THUMB_WIDTH`, `THUMB_QUALITY`, `MID_WIDTH`, `MID_QUALITY` constants.)

Replace the entire `export async function POST(request: NextRequest)` (currently lines 54–142) with:

```ts
/**
 * POST /api/history — multipart form:
 *   uuid          required, matches /^[0-9a-f-]{36}$/i (crypto.randomUUID format)
 *   username      required
 *   workflowName  string
 *   promptData    JSON string
 *   executionTimeSeconds  number string
 *   original      File, image/*
 *   thumb         File, image/jpeg
 *   mid           File, image/jpeg
 *
 * Writes three files in parallel:
 *   <uuid>.<ext>       — original bytes
 *   thumb_<uuid>.jpg   — client-generated 240px
 *   mid_<uuid>.jpg     — client-generated 1200px
 *
 * No sharp usage — the client is the sole generator of variants.
 * Returns { id, success, fullUrl, thumbUrl, midUrl }.
 */
export async function POST(request: NextRequest) {
  try {
    const formData = await request.formData();
    const uuid = (formData.get("uuid") as string | null)?.trim() ?? "";
    const username = formData.get("username") as string;
    const workflowName = (formData.get("workflowName") as string) || "";
    const promptData = JSON.parse(
      (formData.get("promptData") as string) || "{}"
    );
    const executionTimeSeconds = parseFloat(
      (formData.get("executionTimeSeconds") as string) || "0"
    );
    const original = formData.get("original");
    const thumb = formData.get("thumb");
    const mid = formData.get("mid");

    if (!username) {
      return NextResponse.json(
        { error: "username is required" },
        { status: 400 }
      );
    }
    if (!/^[0-9a-f-]{36}$/i.test(uuid)) {
      return NextResponse.json(
        { error: "valid uuid is required" },
        { status: 400 }
      );
    }
    if (
      !(original instanceof File) ||
      !(thumb instanceof File) ||
      !(mid instanceof File)
    ) {
      return NextResponse.json(
        { error: "original, thumb, mid files are required" },
        { status: 400 }
      );
    }
    if (!original.type.startsWith("image/")) {
      return NextResponse.json(
        { error: "original must be image/*" },
        { status: 400 }
      );
    }
    if (thumb.type !== "image/jpeg" || mid.type !== "image/jpeg") {
      return NextResponse.json(
        { error: "thumb and mid must be image/jpeg" },
        { status: 400 }
      );
    }

    const dir = getHistoryImagesDir();
    const ext = path.extname(original.name) || getExtFromMime(original.type);
    const originalFilename = `${uuid}${ext}`;
    const thumbFilename = `thumb_${uuid}.jpg`;
    const midFilename = `mid_${uuid}.jpg`;

    const originalPath = path.join(dir, originalFilename);
    const thumbPath = path.join(dir, thumbFilename);
    const midPath = path.join(dir, midFilename);

    // Uuid collision check — if any of the three files already exists,
    // refuse to overwrite. Client treats 409 as a bug and retries with
    // a fresh uuid.
    const [oExists, tExists, mExists] = await Promise.all([
      exists(originalPath),
      exists(thumbPath),
      exists(midPath),
    ]);
    if (oExists || tExists || mExists) {
      return NextResponse.json(
        { error: "uuid collision" },
        { status: 409 }
      );
    }

    // Write all three in parallel. If any write fails, roll back the
    // others so no partial state survives on disk.
    const written: string[] = [];
    try {
      await Promise.all([
        writeAndTrack(originalPath, original, written),
        writeAndTrack(thumbPath, thumb, written),
        writeAndTrack(midPath, mid, written),
      ]);
    } catch (err) {
      await Promise.all(
        written.map((p) => fs.unlink(p).catch(() => undefined))
      );
      throw err;
    }

    const id = saveGeneration({
      username,
      workflowName,
      promptData,
      executionTimeSeconds,
      outputs: [
        {
          filename: original.name,
          filepath: originalFilename,
          contentType: original.type,
          size: original.size,
        },
      ],
    });

    return NextResponse.json({
      id,
      success: true,
      fullUrl: `/api/history/image/${encodeURIComponent(originalFilename)}`,
      thumbUrl: `/api/history/image/${encodeURIComponent(thumbFilename)}`,
      midUrl: `/api/history/image/${encodeURIComponent(midFilename)}`,
    });
  } catch (err) {
    console.error("[history POST] failed:", err);
    return NextResponse.json({ error: "Failed to save history" }, { status: 500 });
  }
}

async function exists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

async function writeAndTrack(
  filepath: string,
  file: File,
  tracker: string[]
): Promise<void> {
  const buffer = Buffer.from(await file.arrayBuffer());
  await fs.writeFile(filepath, buffer);
  tracker.push(filepath);
}
```

- [ ] **Step 2: Remove `sharp` import and ensure nothing else in the project imports it**

Run: `grep -rn "from \"sharp\"\\|require('sharp')" app lib components hooks stores`
Expected: zero matches (sharp is no longer referenced in source).

If there are other usages, leave them — this plan only removes sharp from the history POST path. The `sharp` npm dependency stays in `package.json` for this PR.

- [ ] **Step 3: Type-check compiles**

Run: `npx tsc --noEmit`
Expected: succeeds.

- [ ] **Step 4: Smoke test the server accepts the new shape**

With `npm run dev` running, in browser devtools console:
```js
const fd = new FormData();
fd.append("uuid", crypto.randomUUID());
fd.append("username", "test");
fd.append("workflowName", "smoke");
fd.append("promptData", "{}");
fd.append("executionTimeSeconds", "0");
const blob = new Blob(["x"], { type: "image/png" });
fd.append("original", new File([blob], "a.png", { type: "image/png" }));
const jpeg = new Blob([new Uint8Array([0xff, 0xd8, 0xff])], { type: "image/jpeg" });
fd.append("thumb", new File([jpeg], "t.jpg", { type: "image/jpeg" }));
fd.append("mid",   new File([jpeg], "m.jpg", { type: "image/jpeg" }));
const r = await fetch("/api/history", { method: "POST", body: fd });
console.log(r.status, await r.json());
```
Expected: status 200, JSON has `id`, `success: true`, `fullUrl`, `thumbUrl`, `midUrl`.

Then verify the three files exist under the history images directory. Delete them after: visit the sidebar, remove the test entry.

- [ ] **Step 5: Commit**

```bash
git add app/api/history/route.ts
git commit -m "feat(api/history): accept client-generated thumb/mid, drop sharp"
```

---

## Task 3b: Legacy `.png` mid fallback in image resolver

**Files:**
- Modify: `app/api/history/image/[filename]/route.ts`

After Task 3, new entries write `mid_<uuid>.jpg`. Legacy entries have `mid_<uuid>.png` on disk. The sidebar's `imgUrl` helper (after Task 7) will request `.jpg` for every entry. Without a resolver fallback, legacy entries would 404 on the mid URL and the card's `onError` handler would swap to the full original — violating the lightweight-UI principle.

This task adds a narrow fallback: if the requested filename starts with `mid_` and ends with `.jpg` and the file is missing, try the same basename with `.png`. Symmetric the other direction too (`mid_*.png` requested → fallback to `.jpg`) for forward-compatibility if any legacy client still builds `.png` URLs.

- [ ] **Step 1: Add the fallback in the catch-ENOENT branch**

Replace the file-read block (currently lines 45–63 in `app/api/history/image/[filename]/route.ts`):

```ts
  try {
    const buf = await readWithMidFallback(resolved, filename, dir);
    const contentType = mime.lookup(buf.filename) || "application/octet-stream";
    return new NextResponse(new Uint8Array(buf.bytes), {
      status: 200,
      headers: {
        "Content-Type": contentType,
        // Files are immutable (UUID names) → cache aggressively.
        "Cache-Control": "public, max-age=31536000, immutable",
      },
    });
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }
    console.error("[history image] read failed:", err);
    return NextResponse.json({ error: "Read failed" }, { status: 500 });
  }
}

/**
 * Read the requested file, or — for `mid_*` variants only — fall back
 * to the sibling extension. Legacy entries wrote `mid_<uuid>.png`; new
 * entries write `mid_<uuid>.jpg`. Clients always request `.jpg` after
 * the thumbnail-first change, so we transparently serve the legacy
 * `.png` when the `.jpg` is missing.
 *
 * Returns the bytes AND the effective filename (so Content-Type reflects
 * what was actually served, not what was requested).
 */
async function readWithMidFallback(
  primaryPath: string,
  requestedFilename: string,
  dir: string
): Promise<{ bytes: Buffer; filename: string }> {
  try {
    const bytes = await fs.readFile(primaryPath);
    return { bytes, filename: requestedFilename };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    if (!requestedFilename.startsWith("mid_")) throw err;
    const lower = requestedFilename.toLowerCase();
    const altName =
      lower.endsWith(".jpg")
        ? requestedFilename.slice(0, -4) + ".png"
        : lower.endsWith(".png")
          ? requestedFilename.slice(0, -4) + ".jpg"
          : null;
    if (!altName) throw err;
    const altPath = path.join(dir, altName);
    const bytes = await fs.readFile(altPath);
    return { bytes, filename: altName };
  }
}
```

- [ ] **Step 2: Type-check compiles**

Run: `npx tsc --noEmit`
Expected: succeeds.

- [ ] **Step 3: Smoke test: request a missing `.jpg` whose `.png` sibling exists**

Pick an existing mid `.png` on disk (from the history directory). In browser:
```
/api/history/image/mid_<uuid>.jpg     → 200, PNG bytes, Content-Type: image/png
/api/history/image/mid_<uuid>.png     → 200 (direct hit)
/api/history/image/mid_unknown.jpg    → 404
/api/history/image/thumb_<uuid>.jpg   → 200 (fallback NOT triggered for thumb_)
```

- [ ] **Step 4: Commit**

```bash
git add "app/api/history/image/[filename]/route.ts"
git commit -m "fix(api/history/image): fall back .jpg↔.png for legacy mid files"
```

---

## Task 4: Extend history-store with optimistic fields

**Files:**
- Modify: `stores/history-store.ts`
- Modify: `types/wavespeed.ts`

Zustand store needs to hold references to client blob URLs so the Output panel can display them AND so we can revoke them on entry removal. The store does NOT drive the sidebar — that's Task 5.

- [ ] **Step 1: Extend `HistoryEntry` in `types/wavespeed.ts`**

Append these fields to the existing `HistoryEntry` interface (after `serverGenId`, before closing brace):

```ts
  /**
   * True once the server has persisted this generation to disk + DB.
   * Optimistic entries live in-memory only (blob URLs aren't portable
   * across reloads) and are filtered out of the persisted store.
   * Undefined on legacy entries — treat as "confirmed" for back-compat.
   */
  confirmed?: boolean;
  /**
   * Human-readable error if the POST /api/history call failed.
   * Presence signals "show retry UI". Cleared on successful retry.
   */
  uploadError?: string | null;
  /**
   * Client-generated blob: URLs that must be revoked when the entry
   * is removed or when the entry transitions to "confirmed" (2s after,
   * via requestIdleCallback). Tracked here so the store's own `remove`
   * / `clear` can free them without the owner having to call revoke.
   */
  localBlobUrls?: string[];
```

- [ ] **Step 2: Update `stores/history-store.ts` to revoke blob URLs on remove/clear**

Add this helper near the top of the file (below imports):

```ts
function revokeLocalBlobUrls(entries: HistoryEntry[]): void {
  if (typeof window === "undefined") return;
  for (const e of entries) {
    if (!e.localBlobUrls) continue;
    for (const u of e.localBlobUrls) {
      try {
        URL.revokeObjectURL(u);
      } catch {
        // Already revoked or never registered — ignore.
      }
    }
  }
}
```

Replace the `remove` method (currently lines 48–51):

```ts
      remove: (id) =>
        set((state) => {
          const victim = state.entries.find((e) => e.id === id);
          if (victim) revokeLocalBlobUrls([victim]);
          return {
            entries: state.entries.filter((e) => e.id !== id),
          };
        }),
```

Replace the `clear` method (currently line 53):

```ts
      clear: () =>
        set((state) => {
          revokeLocalBlobUrls(state.entries);
          return { entries: [] };
        }),
```

Add a `partialize` option to the `persist` config alongside `name`, `storage`, `version`, `migrate`. Insert after `version: 3,`:

```ts
      partialize: (state) => ({
        // Drop optimistic-only entries: their blob URLs won't survive
        // reload. Entries without `confirmed` (legacy v1–v3 rows) are
        // treated as confirmed for back-compat.
        entries: state.entries.filter((e) => e.confirmed !== false),
      }),
```

- [ ] **Step 3: Type-check compiles**

Run: `npx tsc --noEmit`
Expected: succeeds.

- [ ] **Step 4: Commit**

```bash
git add stores/history-store.ts types/wavespeed.ts
git commit -m "feat(history-store): add optimistic fields + blob URL revocation"
```

---

## Task 5: `lib/pending-history.ts` — sidebar-facing pending singleton

**Files:**
- Create: `lib/pending-history.ts`

This is the bridge between `generate-form.tsx` (which pushes pending entries) and `useHistory` (which merges them with server rows for the sidebar).

- [ ] **Step 1: Create `lib/pending-history.ts` with full implementation**

```ts
/**
 * In-memory singleton of pending (not-yet-server-confirmed) history
 * generations. Read by useHistory and rendered in the history sidebar
 * alongside server rows, so a freshly-completed generation shows up
 * as a card within milliseconds — before the /api/history POST has
 * even finished.
 *
 * A pending entry is shaped to closely mirror ServerGeneration so the
 * sidebar card component can render either with minimal branching.
 * The key difference: pending entries carry blob: URLs (not server
 * /api/history/image/ URLs) and a `pending: true` marker.
 *
 * Lifecycle:
 *   addPending(uuid, gen)       → visible in sidebar
 *   markError(uuid, msg)        → error badge + retry UI
 *   confirmPending(uuid)        → removed (server refresh will show
 *                                 the real row), blob URLs revoked
 *                                 after a short grace window
 */

import type { ServerGeneration } from "@/hooks/use-history";

export interface PendingGeneration extends ServerGeneration {
  pending: true;
  uuid: string;
  thumbBlobUrl: string;
  midBlobUrl: string;
  fullBlobUrl: string;
  uploadError?: string;
  /**
   * Captures the inputs needed to retry the upload without the caller
   * having to re-run variant generation. The retry handler in
   * generate-form.tsx calls this function.
   */
  retry?: () => void;
}

type Listener = () => void;

const map = new Map<string, PendingGeneration>();
const listeners = new Set<Listener>();

const REVOKE_DELAY_MS = 2000;

function emit() {
  for (const l of listeners) l();
}

export function subscribe(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getAll(): PendingGeneration[] {
  // Newest first, matching server-history ordering.
  return Array.from(map.values()).sort(
    (a, b) => Date.parse(b.created_at) - Date.parse(a.created_at)
  );
}

export function addPending(entry: PendingGeneration): void {
  map.set(entry.uuid, entry);
  emit();
}

export function markError(uuid: string, message: string): void {
  const cur = map.get(uuid);
  if (!cur) return;
  map.set(uuid, { ...cur, uploadError: message });
  emit();
}

export function clearError(uuid: string): void {
  const cur = map.get(uuid);
  if (!cur || !cur.uploadError) return;
  const { uploadError: _removed, ...rest } = cur;
  void _removed;
  map.set(uuid, rest as PendingGeneration);
  emit();
}

/**
 * Mark an entry as server-confirmed. The entry is removed from the
 * pending map immediately (the sidebar will switch to showing the
 * server row on next refresh), and its blob URLs are revoked after
 * a short grace window so in-flight <img> elements aren't torn down
 * before the swap completes.
 */
export function confirmPending(uuid: string): void {
  const cur = map.get(uuid);
  if (!cur) return;
  map.delete(uuid);
  emit();
  scheduleRevoke([cur.thumbBlobUrl, cur.midBlobUrl, cur.fullBlobUrl]);
}

/** Remove a pending entry without grace-period revocation (user-deleted). */
export function removePending(uuid: string): void {
  const cur = map.get(uuid);
  if (!cur) return;
  map.delete(uuid);
  emit();
  revoke([cur.thumbBlobUrl, cur.midBlobUrl, cur.fullBlobUrl]);
}

function scheduleRevoke(urls: string[]): void {
  if (typeof window === "undefined") return;
  const run = () => revoke(urls);
  const ric = (window as unknown as { requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number })
    .requestIdleCallback;
  if (ric) {
    ric(run, { timeout: REVOKE_DELAY_MS + 1000 });
  } else {
    setTimeout(run, REVOKE_DELAY_MS);
  }
}

function revoke(urls: string[]): void {
  for (const u of urls) {
    if (!u || !u.startsWith("blob:")) continue;
    try {
      URL.revokeObjectURL(u);
    } catch {
      // Already revoked — ignore.
    }
  }
}

/** Test/debug: drop all pending without revocation (e.g. HMR reset). */
export function _resetForTest(): void {
  map.clear();
  listeners.clear();
}
```

- [ ] **Step 2: Type-check compiles**

Run: `npx tsc --noEmit`
Expected: succeeds.

- [ ] **Step 3: Commit**

```bash
git add lib/pending-history.ts
git commit -m "feat(history): add pending-history singleton for optimistic sidebar entries"
```

---

## Task 6: Wire pending-history into `useHistory` hook

**Files:**
- Modify: `hooks/use-history.ts`

Subscribe to pending-history changes; merge into `items`; dedupe by uuid (a server row whose filepath `<uuid>.<ext>` matches a pending uuid replaces the pending entry).

- [ ] **Step 1: Extend `hooks/use-history.ts` — imports**

At the top of the file, after the existing imports, add:

```ts
import * as pendingHistory from "@/lib/pending-history";
```

- [ ] **Step 2: Add a uuid extractor helper**

After the `buildUrl` function (around line 84), before `export function useHistory`, add:

```ts
/**
 * Extract the uuid portion of a server-history filepath. Files are stored
 * as `<uuid>.<ext>` for originals. Returns null if the shape is unexpected
 * (legacy rows with non-uuid filenames). Used to dedupe pending vs server.
 */
function extractUuid(filepath: string): string | null {
  const m = /^([0-9a-f-]{36})\./i.exec(filepath);
  return m ? m[1].toLowerCase() : null;
}

function serverHasUuid(gen: ServerGeneration, uuid: string): boolean {
  const target = uuid.toLowerCase();
  return gen.outputs.some((o) => extractUuid(o.filepath) === target);
}
```

- [ ] **Step 3: Add pending subscription to `useHistory`**

Inside `useHistory`, after the existing `const [items, setItems] = React.useState<ServerGeneration[]>([]);` line, add:

```ts
  const [pending, setPending] = React.useState<pendingHistory.PendingGeneration[]>(
    () => pendingHistory.getAll()
  );
  React.useEffect(() => {
    return pendingHistory.subscribe(() => setPending(pendingHistory.getAll()));
  }, []);
```

- [ ] **Step 4: Merge pending + server items on return**

Replace the `return { ... }` block at the bottom of `useHistory` with:

```ts
  const mergedItems = React.useMemo(() => {
    if (pending.length === 0) return items;
    const pendingUuids = new Set(pending.map((p) => p.uuid));
    const filteredServer = items.filter(
      (g) => !pending.some((p) => serverHasUuid(g, p.uuid))
    );
    // Also drop any pending that the server view already has (protects
    // against a brief overlap window between server refresh and
    // confirmPending firing).
    const filteredPending = pending.filter(
      (p) => !items.some((g) => serverHasUuid(g, p.uuid))
    );
    void pendingUuids;
    return [...filteredPending, ...filteredServer];
  }, [pending, items]);

  return {
    items: mergedItems,
    hasMore,
    isLoading,
    isLoadingMore,
    error,
    loadMore,
    refetch: fetchFirstPage,
  };
```

- [ ] **Step 5: Type-check compiles**

Run: `npx tsc --noEmit`
Expected: succeeds.

- [ ] **Step 6: Commit**

```bash
git add hooks/use-history.ts
git commit -m "feat(use-history): merge pending-history entries into sidebar items"
```

---

## Task 7: Update sidebar card to handle pending entries + error/retry UI

**Files:**
- Modify: `components/history-sidebar.tsx`

The `ServerEntryCard` already accepts a `ServerGeneration`. `PendingGeneration` extends that shape so it renders with minor adjustments:
- `thumb`/`mid`/`full` URLs come from the pending entry's blob URLs when `pending === true`.
- Error badge + retry when `uploadError` is present.
- Exclude pending entries' blob URLs from `preloadImages` (they're already in memory).

- [ ] **Step 1: Extend `imgUrl` helper to support `.jpg` mid**

Replace the `imgUrl` function (currently lines 84–93) with:

```ts
/** Build a URL for the local image-serving endpoint. */
function imgUrl(filepath: string, variant?: "thumb" | "mid"): string {
  const base = filepath.replace(/\.[^.]+$/, "");
  if (variant === "thumb") {
    return `/api/history/image/${encodeURIComponent(`thumb_${base}.jpg`)}`;
  }
  if (variant === "mid") {
    // New entries (client-generated variants) use .jpg. Legacy entries
    // (server sharp-generated) use .png. The card's <img onError>
    // already has a fallback path, but we prefer to guess correctly
    // on the first attempt: pending entries (blob URLs) never reach
    // this helper, so a filepath here means it came from the server.
    // Try .jpg first — old .png files will 404 briefly and trigger
    // the onError → full fallback.
    return `/api/history/image/${encodeURIComponent(`mid_${base}.jpg`)}`;
  }
  return `/api/history/image/${encodeURIComponent(filepath)}`;
}
```

- [ ] **Step 2: Update the card to detect pending entries and use their blob URLs**

In `ServerEntryCard` (around lines 348–482), replace the start of the function body (the `thumbSrc`/`midSrc`/`fullSrc` derivation block, currently lines 355–359) with:

```ts
  const data = React.useMemo(() => parsePromptData(gen.prompt_data), [gen.prompt_data]);
  const firstImage = gen.outputs.find((o) => o.content_type.startsWith("image/"));
  const isPending = (gen as PendingGeneration).pending === true;
  const pendingEntry = isPending ? (gen as PendingGeneration) : null;
  const uploadError = pendingEntry?.uploadError;

  const thumbSrc = pendingEntry
    ? pendingEntry.thumbBlobUrl
    : firstImage
      ? imgUrl(firstImage.filepath, "thumb")
      : null;
  const midSrc = pendingEntry
    ? pendingEntry.midBlobUrl
    : firstImage
      ? imgUrl(firstImage.filepath, "mid")
      : null;
  const fullSrc = pendingEntry
    ? pendingEntry.fullBlobUrl
    : firstImage
      ? imgUrl(firstImage.filepath)
      : null;
```

Add the `PendingGeneration` import to the component file. Near the top of `components/history-sidebar.tsx`, add (after the existing `useHistory` import):

```ts
import type { PendingGeneration } from "@/lib/pending-history";
```

- [ ] **Step 3: Add error badge + retry UI**

After the `<div className="mb-2">` block that contains the thumbnail `<img>` and the `<ImageDialog>` wrapper (currently around line 435, right after the closing `</ImageDialog>` / `)}`) — inside the outer `<div className="flex w-full flex-col items-center">`, add an error row that only renders when `uploadError` is present:

```tsx
      {uploadError && pendingEntry?.retry && (
        <div className="mb-2 flex items-center gap-2 rounded border border-destructive/40 bg-destructive/5 px-2 py-1 text-xs text-destructive">
          <span title={uploadError}>Not saved</span>
          <Button
            variant="outline"
            size="sm"
            className="h-5 px-2 py-0 text-xs"
            onClick={() => pendingEntry.retry?.()}
          >
            Retry
          </Button>
        </div>
      )}
```

- [ ] **Step 4: Skip preload for pending blob URLs**

In `HistorySidebar`, replace the preload effect (currently lines 158–168) with:

```tsx
  React.useEffect(() => {
    if (visibleItems.length === 0) return;
    const urls: string[] = [];
    for (const g of visibleItems) {
      // Blob URLs are already in memory — preloading does nothing useful.
      if ((g as PendingGeneration).pending === true) continue;
      const img = g.outputs.find((o) => o.content_type.startsWith("image/"));
      if (!img) continue;
      urls.push(imgUrl(img.filepath, "thumb"));
      urls.push(imgUrl(img.filepath, "mid"));
    }
    preloadImages(urls);
  }, [visibleItems]);
```

- [ ] **Step 5: Guard `handleDelete` against pending entries**

Still in `HistorySidebar`, replace `handleDelete` (currently around lines 170–198) to short-circuit on pending entries (they have no server DB row):

Find:
```ts
  async function handleDelete(gen: ServerGeneration) {
    if (!username) return;
    if (!confirm("Удалить эту запись из истории?")) return;
```

Replace with:
```ts
  async function handleDelete(gen: ServerGeneration) {
    if (!username) return;
    if (!confirm("Удалить эту запись из истории?")) return;

    // Pending (not-yet-confirmed) entry: drop it from the client-side
    // singleton. Blob URLs revoked. No server call.
    const pending = (gen as PendingGeneration).pending === true
      ? (gen as PendingGeneration)
      : null;
    if (pending) {
      const { removePending } = await import("@/lib/pending-history");
      removePending(pending.uuid);
      toast.success("Удалено");
      return;
    }
```

(The rest of the function — the fetch + zustand cleanup — stays unchanged below this new block.)

- [ ] **Step 6: Type-check compiles**

Run: `npx tsc --noEmit`
Expected: succeeds.

- [ ] **Step 7: Commit**

```bash
git add components/history-sidebar.tsx
git commit -m "feat(sidebar): render pending entries with error/retry UI, .jpg mid"
```

---

## Task 8: Rewire `generate-form.tsx` save flow

**Files:**
- Modify: `components/generate-form.tsx`

Replace the body of `saveToServerHistory`: generate variants, push a pending entry, fire-and-forget upload, on success confirm + update zustand entry with server URLs. On error, `markError` with a retry closure.

- [ ] **Step 1: Add imports**

Near the top of `components/generate-form.tsx`, add:

```ts
import { createImageVariants } from "@/lib/image-variants";
import { uploadHistoryEntry } from "@/lib/history-upload";
import * as pendingHistory from "@/lib/pending-history";
```

- [ ] **Step 2: Replace the body of `saveToServerHistory`**

Replace the entire inner helper `async function saveToServerHistory(...)` (currently lines 212–303) with:

```ts
    /**
     * Upload a completed generation to /api/history AND insert an
     * optimistic pending entry into the sidebar. The pending entry is
     * visible within ~30–200ms (well before the upload round-trip),
     * and transitions to the server row on confirmation. Fire-and-
     * forget — the outer flow does not await this.
     */
    async function saveToServerHistory(
      outputUrl: string,
      executionTimeMs: number,
      thumbnails: string[]
    ) {
      if (!username) {
        console.warn("[history] skip POST: no username");
        return;
      }
      const uploadUuid =
        typeof crypto !== "undefined" && "randomUUID" in crypto
          ? crypto.randomUUID()
          : uuid();
      let variants: Awaited<ReturnType<typeof createImageVariants>>;
      try {
        variants = await createImageVariants(outputUrl);
      } catch (e) {
        console.error("[history] variant generation failed:", e);
        toast.error("Could not prepare thumbnail");
        return;
      }

      const thumbBlobUrl = URL.createObjectURL(variants.thumb);
      const midBlobUrl = URL.createObjectURL(variants.mid);
      const fullBlobUrl = URL.createObjectURL(variants.full);

      const hasImages = images.length > 0;
      const workflowName = `wavespeed:${activeProvider}/${selectedModel}/${
        hasImages ? "edit" : "t2i"
      }`;
      const promptPayload = {
        prompt: prompt.trim(),
        resolution: hasResolutions ? resolution : undefined,
        aspectRatio: aspectRatio || undefined,
        outputFormat,
        provider: activeProvider,
        modelId: selectedModel,
        model: getModelString(activeProvider, selectedModel, hasImages),
        inputThumbnails: thumbnails,
      };

      const originalFilename =
        outputUrl.split("/").pop() || `output.${outputFormat}`;
      const originalContentType =
        variants.full.type || `image/${outputFormat}`;

      // Push optimistic entry into the sidebar singleton BEFORE upload.
      // Shape mirrors ServerGeneration just enough for the card renderer;
      // `id: -1` is a sentinel that the card treats via `pending: true`.
      const doUpload = () =>
        uploadHistoryEntry({
          uuid: uploadUuid,
          username,
          workflowName,
          promptData: promptPayload,
          executionTimeSeconds: executionTimeMs / 1000,
          original: variants.full,
          originalFilename,
          originalContentType,
          thumb: variants.thumb,
          mid: variants.mid,
        });

      const retry = () => {
        pendingHistory.clearError(uploadUuid);
        doUpload().then(
          (res) => {
            pendingHistory.confirmPending(uploadUuid);
            updateHistory(historyId, {
              serverGenId: res.serverGenId,
              previewUrl: res.midUrl,
              originalUrl: res.fullUrl,
              outputUrl: res.midUrl,
              confirmed: true,
            });
            triggerHistoryRefresh();
          },
          (e: Error) => {
            pendingHistory.markError(uploadUuid, e.message);
          }
        );
      };

      pendingHistory.addPending({
        pending: true,
        uuid: uploadUuid,
        thumbBlobUrl,
        midBlobUrl,
        fullBlobUrl,
        // ServerGeneration shape — filled with values that match what
        // the card renderer reads. `id: -1` is fine because pending
        // entries are only matched by `pending: true`, never by id.
        id: -1,
        username,
        workflow_name: workflowName,
        prompt_data: JSON.stringify(promptPayload),
        execution_time_seconds: executionTimeMs / 1000,
        created_at: new Date().toISOString(),
        status: "completed",
        outputs: [
          {
            id: -1,
            generation_id: -1,
            filename: originalFilename,
            filepath: `${uploadUuid}.${originalFilename.split(".").pop() || "png"}`,
            content_type: originalContentType,
            size: variants.full.size,
          },
        ],
        retry,
      });

      // Also link blob URLs into the zustand entry so the Output panel
      // picks them up (so right-click / drag / ImageDialog in Output
      // work against the lightweight variants) and so blob URLs get
      // revoked when the Output card is dismissed.
      updateHistory(historyId, {
        previewUrl: midBlobUrl,
        originalUrl: fullBlobUrl,
        outputUrl: midBlobUrl,
        confirmed: false,
        localBlobUrls: [thumbBlobUrl, midBlobUrl, fullBlobUrl],
      });

      try {
        const res = await doUpload();
        pendingHistory.confirmPending(uploadUuid);
        updateHistory(historyId, {
          serverGenId: res.serverGenId,
          previewUrl: res.midUrl,
          originalUrl: res.fullUrl,
          outputUrl: res.midUrl,
          confirmed: true,
        });
        triggerHistoryRefresh();
      } catch (e) {
        const msg = e instanceof Error ? e.message : "Upload failed";
        pendingHistory.markError(uploadUuid, msg);
        // Zustand entry keeps the blob URLs so the Output panel stays
        // usable; confirmed remains false so localStorage doesn't
        // persist a dead entry.
      }
    }
```

- [ ] **Step 3: Remove now-unused import**

The file no longer uses `fileToThumbnail`? Check: it still uses it for `inputThumbnails` (around line 320). Keep the import.

Run: `npx tsc --noEmit`
Expected: succeeds. Any unused-import warnings from the rewrite → remove those imports.

- [ ] **Step 4: Commit**

```bash
git add components/generate-form.tsx
git commit -m "feat(generate-form): optimistic sidebar entry + client variants"
```

---

## Task 9: End-to-end manual verification

**Files:**
- No code changes — this task is verification only.

- [ ] **Step 1: Start dev server**

Run: `npm run dev`

- [ ] **Step 2: Time-to-thumbnail test**

In the app: sign in, paste a small prompt, submit a text-to-image generation. Watch the history sidebar.

Expected:
- Immediately after the Output panel shows the finished image, a new history card appears in the sidebar with the SAME thumbnail — within ~200ms.
- No spinner / empty placeholder card.
- After ~1–3 seconds (when the debounced refresh fires), the card may refresh silently but the thumbnail image does not flash or change.

Optional precise measurement — add temporary `performance.mark` calls:
- Mark `"gen-complete"` where `saveToServerHistory` is called (around the existing `void saveToServerHistory(...)` calls).
- Mark `"history-card-visible"` inside `addPending` in `lib/pending-history.ts` right after `emit()`.
- In devtools console after generation: `performance.measure("t2h", "gen-complete", "history-card-visible").duration` — expect < 200ms.

Remove the temporary marks before the final commit.

- [ ] **Step 3: UI-lightness test**

With a 4K source image in a generation:
- Open devtools → Memory → take a heap snapshot.
- Confirm that the only full-resolution ImageBitmap or HTMLImageElement live in memory is the one held by the Output panel (and the Output's own blob URL). The sidebar card's decoded image is ≤ 1200×1200 from the mid blob.
- Right-click a history card → "Open image in new tab" → confirm the full-res original opens (served via `/api/history/image/<uuid>.<ext>` once confirmed, or `blob:` while pending).
- Drag a history card into the input widget → confirm the file that lands is the full original (check file size in DevTools Network tab).

- [ ] **Step 4: Network-throttle test**

DevTools → Network → set throttling to "Slow 3G". Trigger a generation.
Expected: history card appears immediately after Output completes, regardless of upload still being in flight. Once upload completes (several seconds later under throttle), no visible change in the sidebar (the debounced server refresh might update `created_at` formatting marginally; no thumbnail reload).

- [ ] **Step 5: Force-failure test**

DevTools → Network → add a request-blocking rule for `/api/history` on POST (not GET). Trigger a generation.
Expected: card appears; "Not saved" badge + Retry button show up after the upload fetch rejects. Remove the block, click Retry, confirm the card transitions to the confirmed server-backed state within a few seconds. Reload mid-failure → the pending entry is gone (localStorage didn't persist it).

- [ ] **Step 6: Legacy entries test**

Check that an OLD history entry — one where the mid variant on disk is `mid_<uuid>.png` (from a generation before this change) — still displays correctly in the sidebar and ImageDialog. With Task 3b's `.jpg ↔ .png` fallback in the resolver, the card's request for `mid_<uuid>.jpg` transparently serves the `.png` bytes. Expected: thumbnail renders directly from the mid variant (no flash to full), ImageDialog works against the mid preview.

- [ ] **Step 7: Concurrent generations test**

Trigger two generations back-to-back (before the first finishes). Expected: both produce their own pending cards when they complete; uploads are independent; the sidebar shows both.

- [ ] **Step 8: Full build check**

Run: `npm run build`
Expected: succeeds with zero errors.

- [ ] **Step 9: Commit verification notes if any temporary marks were added**

If temporary `performance.mark` calls were kept, remove them now. If none were kept, skip this step.

```bash
# if temporary debug code was removed
git add -A
git commit -m "chore: remove temporary perf marks from thumbnail-first verification"
```

---

## Self-review checklist (for the engineer)

Before declaring the feature done, confirm:

- [ ] Spec success criteria satisfied:
  - [ ] History card visible ≤200ms after generation completion.
  - [ ] No full-resolution image rendered in any sidebar/dialog container.
  - [ ] `/api/history` POST handler contains no `sharp` call (`grep -n sharp app/api/history/route.ts` returns nothing).
  - [ ] Right-click / save / drag all deliver the full original.
  - [ ] Existing `.png` mid entries continue to display transparently (resolver fallback from Task 3b serves them without a flash to full).
- [ ] No orphaned blob URLs: after deleting a pending card, heap inspection shows the three blob URLs are revoked; after confirm + 2s, same.
- [ ] `package.json` still lists `sharp` (removal is a follow-up per spec).
- [ ] No temporary debug code in committed files.
