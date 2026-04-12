# History Thumbnail-First — Design

**Date:** 2026-04-12
**Status:** Approved for implementation planning

## Problem

The history sidebar shows a lightweight JPEG thumbnail for each generated image. The intent is that this thumbnail appears **first** in the UI. In practice, it appears **last** — after the full image is already rendered in the Output pane.

### Why this happens today

Trace of current flow (`app/api/history/route.ts:93-110`, `components/generate-form.tsx:255-298`):

1. Generation completes → full image visible in Output.
2. Client reads the full image file and `POST /api/history` with it.
3. Server synchronously runs two sequential `sharp` resizes:
   - `thumb_<uuid>.jpg` (280px, JPEG q70)
   - `mid_<uuid>.png` (1200px, PNG q85)
4. Response returns only after both files are written to disk.
5. `triggerHistoryRefresh()` → store fetches new server history → sidebar re-renders.

The history card is rendered only after step 5. Thumbnails are chronologically last.

## Goals

- History card appears within ≤200ms of generation completion (was >1000ms).
- All images rendered in the UI remain lightweight (downscaled variants, never full-res originals).
- Full-res originals remain accessible through explicit user actions: right-click → open/save, drag-drop into input widgets.
- Server becomes dumb storage — no `sharp` work on the request path.

## Non-goals

- Progressive blur-up loading in the main Output pane (planned follow-up, separate spec).
- Changing how images are stored long-term or migrating existing on-disk files.
- Changing the ImageDialog, Output pane, preload cache, or history store API shape.

## Key Design Decisions

1. **Client is the sole generator of image variants.** After generation completes, the client canvas-downscales the full image into two variants:
   - `thumb` — 240px JPEG, quality 0.70 (~15 KB)
   - `mid` — 1200px JPEG, quality 0.85 (~150 KB)
2. **Optimistic history entry inserted immediately.** The entry is placed into the store in the same tick the variants are ready, before any network call. URLs point to `blob:` URLs backed by the client-generated variants.
3. **Server is dumb storage.** `POST /api/history` becomes `multipart/form-data` with fields `uuid`, `original`, `thumb`, `mid`. The server writes bytes as-is. No `sharp` calls.
4. **Stable client-generated UUID.** `crypto.randomUUID()` on the client is included in the POST. Server-side file names and URLs derive from the same UUID, so the optimistic entry and the server-confirmed entry are the same logical record — swapping URLs in place is seamless.
5. **`mid` format changes from PNG to JPEG.** Quality 0.85 is sufficient for UI preview and 3–5× smaller. The serve endpoint (`/api/history/image/[file]`) is extension-agnostic, so existing `.png` files keep working.
6. **Server `sharp` usage in `/api/history/route.ts` is removed.** The `sharp` npm dependency stays if used elsewhere; otherwise it can be removed.

## Architecture

### Component boundaries

- **`lib/image-variants.ts`** (new) — "How to downscale an image." Does not know about history or upload.
  - Public API: `createImageVariants(source: Blob | string): Promise<{ thumb: Blob, mid: Blob, full: Blob }>`
  - If `source` is a URL string, the function fetches it and uses the response blob as `full`. If it is a Blob, that blob is passed through as `full`.
  - Internal: `createImageBitmap` → `OffscreenCanvas` → `convertToBlob` (with fallback to `HTMLCanvasElement` + `toBlob` for browsers without OffscreenCanvas).
  - Respects `withoutEnlargement`: if the source is smaller than the target width, return the original (normalized to JPEG) for that tier.
- **`lib/history-upload.ts`** (new) — "How to send a history entry to the server." Does not know where the bytes came from.
  - Public API: `uploadHistoryEntry(uuid, variants, meta, signal): Promise<ServerUrls>`
  - Builds `FormData`, `fetch` with `AbortSignal`, parses response.
- **`stores/history-store.ts`** (modified) — "What is in the history and in what state." Does not know about the server directly.
  - New entry fields: `confirmed: boolean`, `uploadError?: string`, `localBlobUrls?: string[]`.
  - New methods: `insertOptimistic(entry)`, `confirmEntry(uuid, serverUrls)`, `markUploadError(uuid, err)`, `retryUpload(uuid)`.
  - Persist partialize: `entries.filter(e => e.confirmed)`.
- **`components/generate-form.tsx`** (modified) — Orchestrator only. Calls the three modules in order. Handles fire-and-forget upload and retry wiring.
- **`components/history-sidebar.tsx`** (modified, minimal) — Renders `entry.thumbUrl` unchanged. Adds an error/retry indicator for entries with `uploadError`. Restricts `preloadImages` to `confirmed === true` entries.
- **`app/api/history/route.ts`** (modified) — Accepts multipart with `uuid`, `original`, `thumb`, `mid`. Writes three files in parallel. Responds with URLs. No `sharp`.

### Data flow (post-change)

```
[generation complete]
    ↓  (client has full blob)
uuid = crypto.randomUUID()
    ↓
createImageVariants(full) → { thumb, mid, full }      ~30–200ms, parallel-safe
    ↓
blob URLs created (thumbUrl, midUrl, fullUrl)
    ↓
store.insertOptimistic({ id: uuid, urls, confirmed: false })
    ↓
── HISTORY CARD VISIBLE ──  (~≤200ms after generation complete)
    ↓  (in parallel, not blocking UI)
uploadHistoryEntry(uuid, variants, meta)
    ↓  (server writes 3 files in parallel, returns)
store.confirmEntry(uuid, serverUrls)
    ↓
blob URLs scheduled for revoke via requestIdleCallback (min 2s delay)
    ↓
entry is now persistable to localStorage
```

### File naming on disk

- Original: `<uuid>.<original-ext>` (unchanged)
- Thumb: `thumb_<uuid>.jpg` (was already `.jpg`)
- Mid: `mid_<uuid>.jpg` (was `.png`)

Old entries with `mid_*.png` continue to serve because the resolver is extension-agnostic.

## Error Handling

| Condition | Behavior |
|---|---|
| `createImageVariants` fails (decode/OOM) | Optimistic entry not inserted. Toast: "Could not prepare thumbnail." Full image still shown in Output. |
| `createImageBitmap` unavailable | Fallback to `new Image()` + `HTMLCanvasElement.drawImage`. Feature-detected once. |
| POST `/api/history` fails (network/5xx) | Entry stays optimistic; `uploadError` set. Small error badge with retry on the card. Not persisted to localStorage. |
| Retry succeeds | `confirmEntry` + clear error. Persists as normal. |
| Reload while upload in progress | Optimistic entries (`confirmed: false`) are filtered out of persist. They disappear. By design — user can regenerate if needed. |
| Server partial write (original OK, thumb/mid fails) | Server rolls back (deletes any files it already wrote), returns 500. No partial state on disk. |
| UUID collision (file exists) | Server 409. Client treats as bug (randomUUID collisions are effectively impossible), logs, retries with a fresh UUID. |
| Source image smaller than target width | Return normalized JPEG of the original for that tier (`withoutEnlargement` semantics). |
| Blob URL revoked before `<img>` swapped | Prevented by: revoke scheduled via `requestIdleCallback` with minimum 2s delay after `confirmEntry`. Belt-and-braces: revoke gated on `<img onLoad>` of server URL (optional optimization). |
| User deletes optimistic entry mid-upload | `AbortController` cancels the in-flight fetch. Blob URLs revoked immediately on delete. |

## Edge Cases

- **Multiple generations in flight.** Each has its own UUID and blob-URL set. Store allows multiple `confirmed: false` entries. Uploads are independent.
- **4K+ source images.** `createImageBitmap` + `OffscreenCanvas` runs off main thread. If OffscreenCanvas is not available, main thread stalls ~100–300ms — acceptable.
- **Very small source (<240px).** Thumb and mid both equal normalized original. Three files still written to disk; minimal overhead.
- **Reload after confirm.** Entry in localStorage has server URLs. Works as today.
- **Old entries with `mid_*.png`.** Resolver serves them. No migration needed.

## Testing

### Unit

- `lib/image-variants.ts` — feed known PNG/JPEG blobs; assert output dimensions, MIME, and `withoutEnlargement` behavior on small sources.
- `stores/history-store.ts` — `insertOptimistic → confirmEntry → persist` cycle; `confirmed` filter on persist; `URL.revokeObjectURL` called (mocked) after `confirmEntry`.
- `lib/history-upload.ts` — happy path; 5xx and network error; 409 on uuid collision; abort via `AbortController`.

### Integration (manual or Playwright)

- Generate an image → verify history card appears **before** or coincident with Output's full-image paint. Measure with `performance.mark` (`history-card-visible` < 200ms after `generation-complete`).
- Throttle network to "Slow 3G" → confirm history card is NOT blocked by upload.
- Force POST failure (DevTools) → error badge appears; click retry → recovers.
- Reload mid-upload → optimistic entry gone (expected).
- Right-click → Open image in new tab → loads full original.
- Drag card into input widget → transfers full original.
- Open old entry with `mid_*.png` → ImageDialog renders correctly.

### Success criteria

- History card visible ≤200ms after generation completion in dev mode.
- No full-resolution image rendered in any sidebar/dialog container.
- `/api/history` POST handler contains no `sharp` call.
- Right-click/save/drag all deliver the full original.
- Existing `.png` mid entries continue to display.

## Out of scope (explicit)

- Progressive blur-up for the Output pane (follow-up).
- Any change to the image generation provider pipeline.
- Server-side thumbnail generation as a fallback (removed entirely; not kept as dead code).
- Migration of existing `.png` mid files to `.jpg`.
- Removal of the `sharp` dependency from `package.json` (verify no other usages; remove in a follow-up PR if unused).
