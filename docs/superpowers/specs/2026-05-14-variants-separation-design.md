# Variants Separation — Design

**Date:** 2026-05-14
**Status:** Design — pending user approval before plan write-up
**Branch target:** new branch from `main` (no in-flight feature work blocks this)
**Intended readers:** any future agent or engineer touching image storage, history serving, admin tooling, or hard-delete.

## Quick-nav

- [Motivation](#motivation)
- [What we change vs. what we don't](#what-we-change-vs-what-we-dont)
- [Section 1 — File layout and env vars](#section-1--file-layout-and-env-vars)
- [Section 2 — URL routing and image serving](#section-2--url-routing-and-image-serving)
- [Section 3 — POST /api/history write paths](#section-3--post-apihistory-write-paths)
- [Section 4 — Server-side variant rebuild (sharp + admin API)](#section-4--server-side-variant-rebuild-sharp--admin-api)
- [Section 5 — Admin "Превью / History state" tab](#section-5--admin-превью--history-state-tab)
- [Section 6 — Hard-delete, tests, risks, out-of-scope](#section-6--hard-delete-tests-risks-out-of-scope)

---

## Motivation

Today, when a generation is saved, **three files** land in the same directory under `HISTORY_IMAGES_DIR/<email>/<YYYY>/<MM>/`:

- `<uuid>.<ext>` — the original (real user content)
- `thumb_<uuid>.jpg` — 240px JPEG for history list
- `mid_<uuid>.jpg` — 1200px JPEG for "Generated today"

The two derivatives are conceptually a cache: they are deterministically rebuildable from the original at any time. Mixing them with originals causes three frictions:

1. **"Give the user their content"** is harder — exporting `<email>/` includes auxiliary thumbnails that the user did not generate and does not want.
2. **Cache trouble**: if a variant gets corrupted/deleted/wrong-size, the only path today is "regenerate it on the next client write," which requires the user to re-do the work.
3. **No admin recovery path** for variants — if a future bug ever writes the wrong file, there is no button to rebuild.

The goal of this design is to:

- Keep user folders **clean** — only originals in `HISTORY_IMAGES_DIR/<email>/`.
- Put variants in a **separate top-level cache directory**, configurable via env, so the operator can route it to a different volume (faster SSD, smaller backup scope, etc.).
- Add an **admin "rebuild variants" tool** that re-derives variants from originals using server-side `sharp`, with both per-user and global flavours, surfaced in a new admin tab.
- **Do not change the DB schema.** Variant file paths are derivable from the original's path; persisting them would only add migration risk for no current benefit.

---

## What we change vs. what we don't

### Unchanged (intentional)

- **Database schema** — `generation_outputs.filepath` keeps storing the original's path; no new columns. `viewcomfy-claude` (shared SQLite) is unaffected.
- **Client URL shape** — clients keep hitting `/api/history/image/<email>/<YYYY>/<MM>/<filename>` for all three URL types. The serving route internally dispatches by filename prefix; the client does not know variants moved.
- **`lib/history/store.ts:160-188`** — the formula that derives `thumbUrl`/`outputUrl` from `outputs[0].filepath` stays exactly the same. Same URL prefix, same `thumb_`/`mid_` infix.
- **`lib/image-storage.ts`** — used by sync providers (Fal/Comfy) for downloading external URLs. It writes originals only; it has never produced variants. Untouched in this round.
- **Client-side variant generation** — `lib/image-variants.ts` (OffscreenCanvas / fallback) continues to run during a normal generation: fast first-paint, no server CPU spent on the hot path.
- **`lib/history-urls.ts` legacy fallback** — kept as-is (handles pre-Task-7.3 flat-layout rows). The fallback is for an unrelated legacy case and is invisible to the new flow.

### Changed

- **`POST /api/history`** writes the original to `HISTORY_IMAGES_DIR/<email>/<YYYY>/<MM>/` and variants to `HISTORY_VARIANTS_DIR/<email>/<YYYY>/<MM>/`. Three files, two roots.
- **`GET /api/history/image/[...path]`** dispatches: filenames starting with `thumb_` or `mid_` resolve under `HISTORY_VARIANTS_DIR`; everything else under `HISTORY_IMAGES_DIR`. One route, two roots.
- **`lib/history-db.ts`** exports a new `getHistoryVariantsDir()` alongside the existing `getHistoryImagesDir()`. Same sync-mkdir-at-first-call pattern.
- **`lib/admin/folder-rename.ts`** gets a small extension so that hard-delete can rename **both** `<email>/` folders to the same `deleted_*` slot consistently.
- **`lib/admin/purge-user.ts`** (or the route handler that orchestrates it) extends rename to cover the variants root.
- **`package.json`** — re-adds `sharp` as a dependency. Used **only** for admin rebuild (not the hot path).
- **`lib/image-variants.ts`** (client) — mechanical change: inline `THUMB_WIDTH`/`THUMB_QUALITY`/`MID_WIDTH`/`MID_QUALITY` constants replaced by imports from the new shared spec module. The `toBlob` quality argument divides by 100 at the call site (client API expects 0..1). No behavioural change.
- **New: `lib/variants-builder.ts`** — server-side `sharp` resize pipeline.
- **New: `lib/image-variants-spec.ts`** — shared resize parameters (widths as px ints, JPEG qualities as 1..100 ints) imported by both `lib/image-variants.ts` (client) and `lib/variants-builder.ts` (server).
- **New: admin endpoints** under `/api/admin/variants/...`.
- **New: admin tab** `components/admin/preview-state-tab.tsx`.

---

## Section 1 — File layout and env vars

### Layout

```
$HISTORY_DATA_DIR/
├── history_images/         ← ORIGINALS only (clean user folders)
│   └── <email>/<YYYY>/<MM>/<uuid>.<ext>
│
└── history_variants/       ← CACHE of derived JPEGs
    └── <email>/<YYYY>/<MM>/
        ├── thumb_<uuid>.jpg
        └── mid_<uuid>.jpg
```

Layout under `history_variants/` is **structurally identical** to `history_images/`: same `<email>/<YYYY>/<MM>/<filename>` path shape. Critical because:

- Hard-delete renames a top-level `<email>` directory; the same operation must apply uniformly to both roots.
- The `/api/history/image/[...path]` route receives a path-tail and uses the same segments to compute the on-disk path; only the **root** dir changes by filename-prefix dispatch.
- The user's `<email>/<YYYY>/<MM>/` exists symmetrically in both roots, which makes external bulk-archive tools straightforward.

### Env vars

- **`HISTORY_VARIANTS_DIR`** — new. Defaults to `${HISTORY_DATA_DIR}/history_variants/` (sibling to `history_images/`). The operator can override to point at a different mount.
- `HISTORY_DATA_DIR` — unchanged (existing).
- `HISTORY_IMAGES_DIR` — unchanged (existing; defaults to `${HISTORY_DATA_DIR}/history_images/`).

### `lib/history-db.ts` additions

The existing pattern resolves `DATA_DIR` and `HISTORY_IMAGES_DIR` at module import time as `const`s, then does a sync `mkdirSync(..., { recursive: true })` immediately. We mirror this shape:

```ts
// Added alongside the existing module-level constants. The env override
// resolves to an absolute path; the default sits next to history_images/.
const HISTORY_VARIANTS_DIR = process.env.HISTORY_VARIANTS_DIR
  ? path.resolve(process.env.HISTORY_VARIANTS_DIR)
  : path.join(DATA_DIR, "history_variants");

if (!fs.existsSync(HISTORY_VARIANTS_DIR))
  fs.mkdirSync(HISTORY_VARIANTS_DIR, { recursive: true });

export function getHistoryVariantsDir(): string {
  return HISTORY_VARIANTS_DIR;
}
```

The synchronous mkdir at import time matches the existing pattern (`HISTORY_IMAGES_DIR` is created the same way). No special init step at server start; the first import of `lib/history-db.ts` ensures the directory exists.

### `.env.example`

Documented next to `HISTORY_DATA_DIR` / `HISTORY_IMAGES_DIR`:

```
# Where derived thumb/mid JPEG variants are stored.
# Defaults to ${HISTORY_DATA_DIR}/history_variants/ (sibling of history_images/).
# Set to a different absolute path to keep variants on a separate volume.
# HISTORY_VARIANTS_DIR=
```

### Docker

`docker-compose.yml` mounts `${HISTORY_DATA_DIR:-./data}` as `/data` — by default this volume already covers both subdirectories. No volume config change needed unless the operator wants variants on a separate mount, which is fully optional.

---

## Section 2 — URL routing and image serving

### URL contract — unchanged for clients

All three URL types continue to use the same template:

```
GET /api/history/image/<email>/<YYYY>/<MM>/<filename>
```

The client computes `thumbUrl` / `outputUrl` (mid) / `originalUrl` from `filepath` exactly as today. No client code changes for URL construction.

### Server dispatch — new

The handler in `app/api/history/image/[...path]/route.ts` decides which root to read from **by inspecting the basename**:

```ts
const filename = segs[segs.length - 1];
const root = (filename.startsWith("thumb_") || filename.startsWith("mid_"))
  ? getHistoryVariantsDir()
  : getHistoryImagesDir();
const filePath = path.join(root, ...segs);
```

### Auth and path-traversal — unchanged and uniform

The existing checks run once, **before** root selection, against the path tail:

- All segments rejected if they contain `..`, `/`, or `\`.
- `segs[0]` (email) must equal the requesting user's email, unless the user is admin.
- `path.resolve(filePath).startsWith(path.resolve(root))` is checked against the selected root.

These guards are identical for both roots, so they cannot be bypassed by varying the filename prefix.

### 404 semantics

A 404 on a missing variant is **not an error condition** — it is the expected state immediately after a legacy-purge and before the corresponding rebuild completes. The UI already handles this: `BlurUpImage` falls back to a blur-on-sharp placeholder. The original (full-size) image still loads normally.

### Why a single route, not two

I considered `GET /api/history/variant/[...]` as a separate endpoint. It would be cleaner separation-of-concerns, but requires changing `lib/history/store.ts`, `lib/history-urls.ts`, `app/api/history/route.ts` (POST response), and any client code that touches these URLs. A prefix-dispatch inside the existing route changes **exactly one file** and zero URL templates. Symmetric paths + symmetric guards keep the operation safe.

---

## Section 3 — POST /api/history write paths

The multipart contract is unchanged: client posts `original`, `thumb`, `mid`. The server writes the three files to two different roots.

```ts
const yyyy = String(now.getUTCFullYear());
const mm = String(now.getUTCMonth() + 1).padStart(2, "0");
const relDir = `${user.email}/${yyyy}/${mm}`;

const imagesAbsDir   = path.join(getHistoryImagesDir(), relDir);
const variantsAbsDir = path.join(getHistoryVariantsDir(), relDir);
await Promise.all([
  fs.mkdir(imagesAbsDir, { recursive: true }),
  fs.mkdir(variantsAbsDir, { recursive: true }),
]);

const originalPath = path.join(imagesAbsDir, `${uuid}${ext}`);
const thumbPath    = path.join(variantsAbsDir, `thumb_${uuid}.jpg`);
const midPath      = path.join(variantsAbsDir, `mid_${uuid}.jpg`);
```

### Collision check

The existing UUID-collision check (lines 138–148) iterates the three full paths. Now they live in two roots — the check itself does not care. Logic unchanged: any of the three present → `409 uuid collision`.

### Rollback

Existing `writeAndTrack(...)` + `Promise.all` + `fs.unlink` on error already handles tracker entries across mixed directories — paths are absolute. No change needed.

### Response shape

Unchanged: `{ id, success, fullUrl, thumbUrl, midUrl }`. URL strings continue to use the `/api/history/image/...` prefix.

### Why not refactor `lib/image-storage.ts`

That module is used by sync providers (Fal, Comfy) to download an external URL or decode a base64 blob into an original on disk. It has never written variants. If sync providers later begin producing variants, a focused extension to that module can call `getHistoryVariantsDir()` — but it is YAGNI now and not in scope.

---

## Section 4 — Server-side variant rebuild (sharp + admin API)

### Library: `sharp`

Re-added as a dependency. The codebase used `sharp` previously; the comment in `app/api/history/route.ts:20` ("sharp is no longer imported — client pre-generates") shows it was deliberately removed when client-side generation shipped. We bring it back **only** for the rebuild path — the hot path stays client-only.

**Windows install pre-flight (called out for the implementation plan):** the very first task should be a no-op `sharp().resize(1,1).jpeg().toBuffer()` smoke test on the dev machine to confirm prebuilt binaries install cleanly. Surfacing install issues early is cheap; discovering them mid-feature is expensive.

### Shared resize spec — `lib/image-variants-spec.ts`

A new tiny module containing only constants:

```ts
export const THUMB_WIDTH = 240;
export const THUMB_QUALITY = 70;  // sharp uses 1..100 ints; client toBlob uses 0..1 → divide by 100
export const MID_WIDTH = 1200;
export const MID_QUALITY = 85;
```

Both `lib/image-variants.ts` (client) and `lib/variants-builder.ts` (server) import from here. A trivial unit test asserts equality of the four constants so the two pipelines cannot silently diverge.

### Builder: `lib/variants-builder.ts`

```ts
buildVariantsForGeneration(
  db: Database.Database,
  generationId: number,
  opts: { imagesDir: string; variantsDir: string }
): Promise<{ ok: true } | { ok: false; reason: BuildReason; error?: string }>
```

Behaviour:

1. Look up the row's first image output (`row.outputs.find(o => o.content_type.startsWith('image/'))`).
2. If no output / output missing → `{ ok: false, reason: 'no_original' }`. Variants cannot be built from nothing.
3. Read original bytes from `path.join(imagesDir, output.filepath)`. ENOENT → `{ ok: false, reason: 'original_missing' }`.
4. Compute dest `<dir>/<YYYY>/<MM>/` from the same `filepath` (split off basename).
5. `fs.mkdir(variantsAbsDir, { recursive: true })`.
6. For each variant (thumb, mid):
   - Pipe the original through `sharp(buffer).resize({ width, withoutEnlargement: true }).jpeg({ quality }).toBuffer()`.
   - Write to a `*.jpg.tmp` sibling, then `fs.rename` to the final name using the existing `renameWithRetry` helper (handles Windows EPERM/EBUSY).
7. Return `{ ok: true }`.

Idempotent: re-running over an already-rebuilt generation overwrites with byte-identical (modulo encoder non-determinism) results. Existing client-written variants for the same UUID are simply overwritten with the same-spec server-built ones — safe.

**Why `withoutEnlargement`:** matches client behaviour (`scale = sw <= targetWidth ? 1 : targetWidth / sw` in `image-variants.ts:108`). A 200px original stays 200px, not upscaled to 240px.

**Why temp-file + rename:** if the process crashes mid-write, a partial JPEG must not be visible. `*.tmp` + atomic rename is the standard pattern; `renameWithRetry` is already battle-tested on Windows.

### Jobs: in-memory, not persisted

A rebuild job's state lives in a `Map<jobId, JobState>` inside the Node process:

```ts
interface JobState {
  jobId: string;            // crypto.randomUUID()
  scope: 'user' | 'all';
  userId?: number;          // when scope='user'
  startedAt: string;        // ISO
  total: number;            // total generations to process
  done: number;
  errors: Array<{ generationId: number; reason: string; error?: string }>;  // capped at 100
  finished: boolean;
  finishedAt?: string;
}
```

State is **not** persisted to the DB. If the process restarts mid-rebuild, the admin re-clicks the button. This is acceptable because:

- Rebuild is idempotent — restarting it loses no information.
- Rebuilds are rare (likely a handful of times per year).
- A new SQLite table for job tracking adds migration surface for vanishingly low value.

### Concurrency

- **One active job per process.** A second invocation while a job is running returns the existing `jobId` (no second job spawned).
- **Within a job, bounded concurrency of 2** sharp invocations in parallel (`p-limit` style — small inline implementation; no new dep). `sharp` is multi-threaded via libvips internally; running 2 at once on a modern box keeps CPU busy without thrashing.

### Errors do not halt the job

Per-generation failure (file missing, decode error, write error) is captured in `errors[]` and the job continues. The admin sees the count and can inspect via expandable log. Logging server-side keeps a stack trace.

### Endpoints

```
POST   /api/admin/variants/rebuild           body: { userId: number }
POST   /api/admin/variants/rebuild-all       body: {}
GET    /api/admin/variants/job/:jobId        → JobState snapshot (poll-able)
GET    /api/admin/variants/stats             → { originals_in_db, variants_on_disk_thumb, variants_on_disk_mid, variants_dir }
GET    /api/admin/variants/users             → [{ user_id, email, image_generation_count }, ...]  sorted desc
GET    /api/admin/variants/legacy-scan       → { count, dirs }                 (read-only)
POST   /api/admin/variants/legacy-purge      → { deleted }                     (deletes thumb_*/mid_* from images-dir)
```

All admin-gated (`getCurrentUser().role === 'admin'` or 403).

Rebuild endpoints return `{ jobId }` immediately and continue work in `setImmediate(...)` after returning.

### Job-folding semantics under concurrent invocations

If a rebuild job is already running and a second invocation arrives (any scope, any admin), the existing job is returned as-is — the second invocation's scope is **ignored**, not merged. Examples:

- Job A is running for `userId=5`; admin clicks "Пересобрать всё" → response carries the same `jobId` as Job A, the global rebuild does NOT start. UI shows a non-blocking inline note "Job уже выполняется — дождитесь окончания и запустите снова".
- Two admins click "Пересобрать" for two different users at the same moment → only the first one wins; the second admin sees the same `jobId` and the same scope.

This keeps the "one active job per process" invariant simple and predictable. Operators serialize by waiting; no queue, no merge logic.

### SSE progress

Two new event types broadcast to active admins via the existing `lib/sse-broadcast.ts`:

```
admin.variants_rebuild_progress { jobId, done, total, currentEmail?, errors }
admin.variants_rebuild_done     { jobId, total, errors }
```

The admin UI subscribes via `EventSource` (same pattern that `admin.user_generated` / `admin.user_purged` already use). Progress events are throttled (≈1 per second or 1 per 5 generations, whichever is sparser) to avoid SSE flood.

### Scope of "all" generations

For both rebuild endpoints, generations included = those with `status IN ('completed','deleted')` and `content_type LIKE 'image/%'` on at least one output. Status `'failed'` is excluded (no original). Soft-deleted (`status='deleted'`) is included because the user may restore the row later — variants for restored rows must work without an extra admin action.

---

## Section 5 — Admin "Превью / History state" tab

### Placement

New tab in the admin panel — sibling to existing `users-tab`, `models-tab`, etc. File: `components/admin/preview-state-tab.tsx`. Registered in whatever admin layout chooses the active tab.

### Layout (top to bottom)

#### 1. Status summary (read-only)

```
┌─ Состояние превью ─────────────────────────────────────────┐
│  Оригиналов в БД:  3,142                                   │
│  Thumb на диске:   3,140                                   │
│  Mid на диске:     3,140                                   │
│  Каталог:  /data/history_variants/                         │
└────────────────────────────────────────────────────────────┘
```

Source: `GET /api/admin/variants/stats`. Refetches on mount, on `admin.variants_rebuild_done`, and on `visibilitychange`. Disk counts are computed by a recursive `fs.readdir` walk of `HISTORY_VARIANTS_DIR/` filtered by prefix — only over the active root; soft-cap at 60s wall time per request with cancellation if it overruns (returns last-known values). Counts are advisory, not transactional.

#### 2. Legacy-purge block (one-time use)

```
┌─ Очистка старых вариантов в папках пользователей ──────────┐
│  В пользовательских папках исторически лежат thumb_*/mid_* │
│  рядом с оригиналами. С этой версии они должны жить в      │
│  отдельном каталоге.                                       │
│                                                            │
│  [Сканировать]                                             │
│   → найдено 6,284 файлов в 412 папках                      │
│                                                            │
│  [Удалить старые]   (доступно после сканирования)          │
│                                                            │
│  ⚠ Превьюшки исчезнут до пересборки.                       │
└────────────────────────────────────────────────────────────┘
```

The delete button opens a typed-confirmation dialog (same UX pattern as `purge-user-dialog.tsx`): type `УДАЛИТЬ` (or similar; final wording in plan) to enable. The operation deletes only files whose basename matches `^(thumb|mid)_[0-9a-f-]{36}\.jpg$` under `HISTORY_IMAGES_DIR/<email>/<YYYY>/<MM>/` — does not touch originals, does not touch directories. Idempotent (re-running finds nothing).

#### 3. Rebuild block

```
┌─ Пересборка вариантов ─────────────────────────────────────┐
│  [Пересобрать всё]                                         │
│   Job 9f8e... в работе: 1,247 / 3,142 (12 ошибок)         │
│   [████████████░░░░░░░░░░░░] 40%                           │
│                                                            │
│  Поиск: [____________]                                     │
│  ┌─────────────────────────────────────────────────────┐  │
│  │ alice@x.com           312 ген.   [Пересобрать]     │  │
│  │ bob@y.com              18 ген.   [Пересобрать]     │  │
│  │ ...                                                 │  │
│  └─────────────────────────────────────────────────────┘  │
└────────────────────────────────────────────────────────────┘
```

User list = active users with at least one image-typed generation, sorted by descending count. Loaded from a new lightweight `GET /api/admin/variants/users` (could be folded into stats; design keeps it separate for clarity).

Each row's "Пересобрать" button is `POST /api/admin/variants/rebuild { userId }`. Disabled while any job is running.

Global "Пересобрать всё" is `POST /api/admin/variants/rebuild-all`. Also disabled while a job is running.

Progress strip subscribes to `admin.variants_rebuild_progress`. After `admin.variants_rebuild_done` it fades out the progress strip and refetches stats + user list.

#### 4. Error log (collapsed by default)

```
▸ Ошибки последней пересборки (12)
  ▾ ↳ generation 1238: original_missing
       /data/history_images/alice@x.com/2026/03/abc.png
    ↳ generation 1240: decode_error  Invalid SOI marker
    ↳ ...
```

Stored in `JobState.errors[]` (capped at 100); not persisted. Visible until the next job starts.

### Access control

Whole tab is gated `role === 'admin'`. The route handlers re-validate server-side; the UI guard is purely cosmetic.

### Style

Match existing admin tabs (`max-w-6xl`, segmented action buttons, inline auto-save indicators where applicable). No new visual primitives.

---

## Section 6 — Hard-delete, tests, risks, out-of-scope

### Hard-delete contract — extension

Reference: `docs/superpowers/specs/2026-05-07-admin-user-hard-delete-post-ship.md` and `lib/admin/folder-rename.ts`.

Today's flow renames `HISTORY_IMAGES_DIR/<email>/` → `HISTORY_IMAGES_DIR/<chosen_target>/`. After this change, the user's `<email>/` may also exist under `HISTORY_VARIANTS_DIR/`. Both must be renamed, and to the **same target name** so they stay paired.

#### Why "same target" matters

`findFreeDeletedTarget(dir, email)` picks the lowest unused `deleted_*` slot **for that directory**. If we call it twice (once per root) the two roots can pick different slots — e.g. images root has `deleted_alice/` from a previous purge and picks `deleted_2_alice/`, variants root has neither and picks `deleted_alice/`. Now the paired data is split across two named slots. That is a paper-trail nightmare and quietly destroys the "same path shape, different roots" invariant.

#### Extension to `lib/admin/folder-rename.ts`

Add one helper:

```ts
/**
 * Find the lowest-index `deleted_*_<email>` slot that is free in BOTH dirs.
 * Used by hard-delete so that the images and variants archives end up at
 * the same on-disk name regardless of prior purges.
 */
export async function findFreeDeletedTargetAcross(
  dirs: string[],
  email: string
): Promise<string>;
```

And a small adjustment to the rename helper to accept a pre-chosen target (existing single-dir helper stays as-is for other callers):

```ts
export async function renameUserFolderToTarget(
  dir: string,
  email: string,
  target: string
): Promise<RenameResult>;
```

`renameUserFolderToDeleted` (existing) can remain as a thin wrapper for any non-hard-delete callers, but the hard-delete route handler shifts to the explicit two-step flow:

```ts
const target = await findFreeDeletedTargetAcross([imagesDir, variantsDir], email);
const imgRes = await renameUserFolderToTarget(imagesDir, email, target);
const varRes = await renameUserFolderToTarget(variantsDir, email, target);
```

#### Audit and warning surface

The audit event `admin_user_purged` (existing) gains a richer `folder_rename_target` payload:

```ts
{
  ...existing...,
  folder_rename_target: 'deleted_2_alice@x.com',
  folder_rename_outcome: {
    images: 'renamed' | 'no_source' | 'failed',
    variants: 'renamed' | 'no_source' | 'failed',
  }
}
```

The HTTP response carries the same outcome dict. The UI toast remains a single "OK" or "rename_failed warning", but the warning text now distinguishes which side failed (a follow-up; the immediate plan can ship with the same toast text).

#### Failure modes — additions to existing table

| Failure | HTTP | DB state | Disk state | UI |
|---------|------|----------|------------|----|
| Variants source doesn't exist (user never generated since rollout) | 200 OK | committed | images renamed; variants noop | success toast |
| Variants rename fails after retries (images succeeded) | 200 `warning: rename_failed` | committed | images renamed, variants NOT renamed | warning toast (mentions variants path) |
| Images rename fails after retries (variants succeeded) | 200 `warning: rename_failed` | committed | images NOT renamed, variants renamed | warning toast |
| Both fail | 200 `warning: rename_failed` | committed | neither renamed | warning toast |

The "rename_failed is a degraded success" doctrine extends naturally.

#### `_SUMMARY.csv` stays on the images side only

It is logically about user content (originals) and is written before the DB transaction inside `purgeUser`. Variants are a cache and have no per-month/per-model billing semantics. We do not duplicate the CSV into the variants archive.

### Tests

| What | Level | Notes |
|------|-------|-------|
| POST /api/history splits writes between two roots | route-level (mock fs or tmpdir) | Asserts `<email>/<yyyy>/<mm>/<uuid>.png` is in images-dir; thumb/mid in variants-dir |
| GET /api/history/image dispatches by basename prefix | route-level | thumb_* served from variants-dir, normal name served from images-dir |
| Path-traversal defence applies equally to both roots | route-level | A `..`-laced segment with `thumb_` prefix is still rejected |
| `buildVariantsForGeneration` produces correct widths/qualities | unit | Use a 4×4 PNG fixture; assert dimensions ≤ THUMB_WIDTH and JPEG output |
| Rebuild is idempotent | unit | Run twice in a row; both succeed, second run overwrites |
| Rebuild handles missing original gracefully | unit | Returns `original_missing`, does not throw |
| Legacy-purge removes thumb_/mid_ but not originals | unit (tmpdir fixture) | After purge, originals untouched; thumb/mid gone |
| `findFreeDeletedTargetAcross` picks a slot free in all dirs | unit | Both dirs probed; lowest common index wins |
| Hard-delete renames both roots to the same target | unit, extends `purge-user.test.ts` | Sets up both dirs with prior `deleted_*` collisions in different states |
| Hard-delete tolerates missing variants source | unit | When user has no variants dir, hard-delete still completes |
| Shared spec constants match between client and server | trivial unit | Imports both modules' exports, asserts equality |

Routes and the admin UI tab are covered by smoke. Backend modules carry the unit weight (consistent with `lib/admin/` convention).

### Risks

1. **Transition window** — between legacy-purge and rebuild, history items show the blur-fallback placeholder instead of a real thumbnail. The original opens normally on click. Mitigation: the admin can test on a single user before running global purge, then run rebuild before purging the rest. This is procedural; the design supports per-user purge implicitly (the operation is content-addressed by `^thumb_|^mid_` and runs over a chosen scope — but for v1 we ship a single global purge button. A per-user variant of legacy-purge is a low-cost follow-up if the operator wants to phase the cleanup).

2. **`sharp` install on Windows** — usually clean (prebuilt win-x64 binary), but historically `npm rebuild sharp` or `--platform=win32` has been required in some environments. The plan's first task is an install smoke (resize a 1×1 buffer). Surfacing install issues at task 1 is cheap; discovering them mid-feature is expensive.

3. **Long global rebuild** — at thousands of generations the job may run for minutes. State is in-memory; a process restart loses progress. Acceptable: rebuild is idempotent and rare. If this turns out to bite us, future work could persist `variant_rebuild_jobs` to SQLite — but that is YAGNI now.

4. **Race: POST /api/history while rebuild runs for the same user** — client writes a valid variant pair, server's sharp pass later overwrites them with identical-spec variants. No correctness issue, just wasted CPU on those two writes. Not worth a lock.

5. **Race: hard-delete during rebuild** — admin purges a user mid-rebuild. The rename moves both `<email>` dirs to `deleted_*`. The in-flight rebuild's next write hits ENOENT → captured in `errors[]`. Job continues. Effect: extra entries in the error log; no data loss. Not worth coordination logic.

6. **Variant `withoutEnlargement` vs client** — must hold strictly to keep parity. Asserted by a fixture test (200×200 PNG → thumb is 200×200, not 240×240). If a future maintainer flips this on one side, the test fails.

7. **Two admin-tab admins clicking rebuild at the same time** — second invocation is folded into the running job (returns the same `jobId`). No double work. SSE progress fans out to both.

### Out of scope (explicit YAGNI)

- DB schema changes (no `thumb_filepath`/`mid_filepath` columns). Variant paths are formula-derivable.
- Touching `lib/image-storage.ts` (sync-provider download helper) — never wrote variants, scope unchanged.
- Server-side variant generation on the **hot** POST path — client stays the producer for fresh generations.
- An "import legacy CSV / re-derive missing originals" path — originals are user content and out of this feature's scope.
- A cron / scheduler for automatic rebuilds — generation correctness is solid; no recurring fix is required.
- A UI for choosing variant dimensions or qualities — constants live in code; changing them is a code change.
- Per-month or per-year scope for rebuild — global + per-user is enough. Bigger granularity is a follow-up if scale demands.
- Wiping the variants directory wholesale via UI — the rebuild button overwrites everything anyway; a separate "wipe variants" button just adds a footgun.
