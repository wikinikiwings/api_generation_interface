# Variants Separation — Post-Ship Handoff

**Date:** 2026-05-14
**Branch:** `feat/variants-separation` (23 commits, +2120/-63 across 39 files, ready to merge)
**Status:** Shipped locally; smoked on Fal and Comfy providers (Wavespeed untested but goes through the same upload path). 294/294 vitest pass, `tsc --noEmit` clean.
**Intended readers:** any future agent or engineer touching image storage, history serving, sync providers, hard-delete, or admin tooling.

## Quick-nav

- [Scope and motivation](#scope-and-motivation)
- [User-visible behaviour](#user-visible-behaviour)
- [Module map](#module-map)
- [Data flow — happy path POST + read](#data-flow--happy-path-post--read)
- [Two roots, one URL space — the dispatch invariant](#two-roots-one-url-space--the-dispatch-invariant)
- [Duplicate-originals fix](#duplicate-originals-fix)
- [Hard-delete contract — paired rename](#hard-delete-contract--paired-rename)
- [Admin "Превью / History state" tab](#admin-превью--history-state-tab)
- [Architectural conventions established](#architectural-conventions-established)
- [Pitfalls — easy ways to re-break things](#pitfalls--easy-ways-to-re-break-things)
- [Test coverage](#test-coverage)
- [Open follow-ups](#open-follow-ups)

---

## Scope and motivation

Before this branch, generating one image produced three files in the same `HISTORY_IMAGES_DIR/<email>/<YYYY>/<MM>/` directory: the original `<uuid>.<ext>`, plus client-generated `thumb_<uuid>.jpg` and `mid_<uuid>.jpg`. Three frictions:

1. "Give the user their content" implied also handing over machine-derived thumbnails the user didn't generate and wouldn't keep.
2. Cache trouble had no recovery path — a corrupted thumb could only be fixed by re-running the generation.
3. Sync providers (Fal/Comfy) ALSO saved a server-side copy of the original under a *different* UUID, which the client then duplicated by re-uploading. The DB only knew the client UUID; the server UUID was orphaned on disk. Before this branch, that orphan was invisible amid the thumb/mid noise; the cleanup-induced separation exposed it.

Spec lives at [`2026-05-14-variants-separation-design.md`](./2026-05-14-variants-separation-design.md). Plan lives at [`../plans/2026-05-14-variants-separation.md`](../plans/2026-05-14-variants-separation.md).

What shipped:

- A second top-level directory `HISTORY_VARIANTS_DIR/` for `thumb_*` and `mid_*` JPEGs.
- A new admin tab **"Превью / History state"** with three operations: legacy-purge (clean old thumb_/mid_ from images-dir), orphan-purge (delete originals not referenced by any DB row), and variant rebuild (per-user / global, sharp-driven).
- Hard-delete extended to rename both `<email>/` roots into the same `deleted_*` slot atomically.
- A duplicate-originals fix: the client now reuses the provider's server-side UUID as its upload UUID, and POST `/api/history` skips the redundant original write when the file is already on disk. One original per generation, referenced canonically by both DB and on-disk filename.
- An SSE-race fix that lets the UI dedupe a server row arriving before the upload-confirm handler runs, by matching on `entry.uploadUuid` in addition to `id` and `serverGenId`.

DB schema is unchanged — `generation_outputs.filepath` continues to point at the original under HISTORY_IMAGES_DIR; variant paths are formula-derived. Shared-DB sister project `viewcomfy-claude` is unaffected.

---

## User-visible behaviour

**On new generation:**

1. Client form sends the prompt + uploads → provider returns a result URL.
2. Client downloads the original (via the local `/api/history/image/...` URL the provider produced) and runs `createImageVariants` in the browser to produce 240px thumb + 1200px mid.
3. Client POSTs `/api/history` with the three blobs. Server writes to two roots:
   - `<HISTORY_IMAGES_DIR>/<email>/<YYYY>/<MM>/<uuid>.<ext>` (only if it doesn't already exist; sync providers pre-write it)
   - `<HISTORY_VARIANTS_DIR>/<email>/<YYYY>/<MM>/thumb_<uuid>.jpg`
   - `<HISTORY_VARIANTS_DIR>/<email>/<YYYY>/<MM>/mid_<uuid>.jpg`
4. History list and "Сгенерировано сегодня" both render the new entry exactly once.

**On admin Превью / History state tab:**

- **Состояние превью** block shows `Оригиналов в БД`, `Thumb на диске`, `Mid на диске`, and the resolved `HISTORY_VARIANTS_DIR`.
- **Очистка старых вариантов** block — scan + typed-`УДАЛИТЬ` purge of legacy `thumb_*.jpg` / `mid_*.jpg` files that still live in the images-dir from before this branch.
- **Удаление орфан-оригиналов** block — scan + typed-`УДАЛИТЬ` purge of `<uuid>.<ext>` originals that no `generation_outputs.filepath` row references. These are leftovers from the pre-fix Fal/Comfy duplicate-save flow.
- **Пересборка вариантов** block — per-user buttons + a "Пересобрать всё" button. Server-side `sharp` regenerates thumb/mid into the variants-dir. Progress and completion broadcast via SSE; UI shows a live progress bar.

**On hard-delete:**

User goes through soft-delete then hard-delete as before (see [`2026-05-07-admin-user-hard-delete-post-ship.md`](./2026-05-07-admin-user-hard-delete-post-ship.md)). The rename now applies to both `<HISTORY_IMAGES_DIR>/<email>/` and `<HISTORY_VARIANTS_DIR>/<email>/`, into the same `deleted_<email>` (or `deleted_2_<email>`, etc) slot. The response carries a `rename_outcome: { images, variants }` object and a `warning: "rename_failed"` flag if either side did not complete.

---

## Module map

```
lib/
├── image-variants-spec.ts            NEW. THUMB_WIDTH=240/THUMB_QUALITY=70/MID_WIDTH=1200/MID_QUALITY=85
│                                     (1..100 int scale — sharp's native unit).
├── image-variants.ts                 MODIFIED. Imports constants from spec, divides quality
│                                     by 100 for the Canvas API at the call site.
├── history-db.ts                     MODIFIED. Adds HISTORY_VARIANTS_DIR const +
│                                     getHistoryVariantsDir(). Mirrors HISTORY_IMAGES_DIR's
│                                     module-level resolve + sync mkdir.
├── history-urls.ts                   MODIFIED. New extractServerUuid() helper.
├── history-upload.ts                 (unchanged — the multipart contract didn't move)
├── variants-builder.ts               NEW. Pure server-side sharp pipeline.
│                                     buildVariantsForGeneration(db, id, opts).
├── sse-broadcast.ts                  MODIFIED. Adds admin.variants_rebuild_progress
│                                     and admin.variants_rebuild_done event variants.
└── admin/
    ├── folder-rename.ts              MODIFIED. Adds findFreeDeletedTargetAcross +
    │                                  renameUserFolderToTarget (paired-root variants).
    ├── variants-jobs.ts              NEW. In-memory job registry with single-active
    │                                  invariant. globalThis-stashed for HMR survival.
    ├── variants-runner.ts            NEW. Orchestrates a rebuild job. No HTTP concerns;
    │                                  takes broadcast as a closure.
    ├── legacy-purge.ts               NEW. Walker that deletes thumb_*/mid_* files from
    │                                  HISTORY_IMAGES_DIR (skips deleted_*/, non-UUID names).
    └── orphan-purge.ts               NEW. Walker that deletes <uuid>.<ext> originals
                                       unreferenced by any generation_outputs.filepath.

app/api/
├── history/
│   ├── route.ts                      MODIFIED (POST). Writes original to images-dir,
│   │                                  thumb/mid to variants-dir. Idempotent on original.
│   └── image/[...path]/route.ts      MODIFIED (GET). Dispatches root by thumb_/mid_
│                                      basename prefix; same path-traversal guards.
└── admin/
    └── variants/
        ├── stats/route.ts            NEW. GET. Originals-in-DB + on-disk thumb/mid counts.
        ├── users/route.ts            NEW. GET. Users with image generations, desc count.
        ├── legacy-scan/route.ts      NEW. GET.
        ├── legacy-purge/route.ts     NEW. POST.
        ├── orphan-scan/route.ts      NEW. GET.
        ├── orphan-purge/route.ts     NEW. POST.
        ├── rebuild/route.ts          NEW. POST per-user. setImmediate(runRebuild).
        ├── rebuild-all/route.ts      NEW. POST global. setImmediate(runRebuild).
        └── job/[jobId]/route.ts      NEW. GET. Snapshot from variants-jobs registry.

app/api/admin/users/[id]/route.ts     MODIFIED (DELETE). Two-step paired rename across
                                       both roots, audit logs predictedTarget +
                                       rename_outcome:{images,variants}.

components/
├── admin/
│   └── preview-state-tab.tsx          NEW. Stats + legacy-purge + orphan-purge +
│                                       rebuild controls. Subscribes to SSE.
├── admin-panel.tsx                    MODIFIED. Tab strip gains "preview-state" entry.
└── generate-form.tsx                  MODIFIED. saveToServerHistory calls
                                        extractServerUuid(outputUrl); when found,
                                        the upload uses that as the on-disk uuid
                                        and the pending entry records it in
                                        HistoryEntry.uploadUuid for SSE-race deduping.

lib/history/
├── types.ts                          MODIFIED. HistoryEntry gains uploadUuid?.
├── store.ts                          MODIFIED. applyServerRow matches by
│                                      (id | serverGenId | uploadUuid).
└── mutations.ts                      MODIFIED. updatePendingEntry patch type
                                       allows uploadUuid.

.env.example                          MODIFIED. Documents HISTORY_VARIANTS_DIR.
```

23 commits. Diff: 39 files, +2120 / -63.

---

## Data flow — happy path POST + read

### Generate → store

```
[Client form]
        ↓ submit
[Provider (Fal/Comfy)]
   - downloadAndSave fetches result bytes from Fal/Comfy CDN
   - writes HISTORY_IMAGES_DIR/<email>/<YYYY>/<MM>/<UUID-A>.<ext>
   - returns publicUrl = /api/history/image/<email>/<YYYY>/<MM>/<UUID-A>.<ext>
        ↓
[Client receives publicUrl]
   - fetches it (same-origin, no CORS)
   - createImageVariants → { thumb, mid, full } blobs in memory
   - extractServerUuid(publicUrl) = UUID-A
   - records uploadUuid=UUID-A on the pending entry (historyId is unchanged)
   - POST /api/history with uuid=UUID-A + original/thumb/mid multipart
        ↓
[POST /api/history]
   1. mkdir -p both roots' YYYY/MM dirs
   2. exists(<imagesDir>/<UUID-A>.<ext>)? yes (provider wrote it)
       → skip the multipart `original` write
   3. write <variantsDir>/thumb_<UUID-A>.jpg, mid_<UUID-A>.jpg
   4. saveGeneration({outputs:[{filepath:'<email>/<YYYY>/<MM>/<UUID-A>.<ext>'}]})
   5. broadcastToUserId(user.id, generation.created)
   6. fanOutAdmins(admin.user_generated)
   7. respond {id, fullUrl, thumbUrl, midUrl}
        ↓
[Client]
   - confirmPendingEntry(historyId, {serverGenId, serverUrls})
   - cacheBlob(...) for each url
        ↓
[Sibling tab / refetch]
   - applyServerRow(row)
   - uuid = extractUuid(row.outputs[0].filepath) = UUID-A
   - matches existing entry by:
       e.id === UUID-A  (client and server uuids coincide → t2i no-provider flow)
       OR e.serverGenId === row.id   (post-confirm race)
       OR e.uploadUuid === UUID-A    (extractServerUuid case, SSE-before-confirm race)
   - if pending → confirm; if live → merge metadata, keep blob URLs
```

### Read a variant

```
GET /api/history/image/alice@x.com/2026/05/thumb_<uuid>.jpg
   1. session cookie → user
   2. segments validated: no .., no /, no \
   3. ownerEmail = "alice@x.com"; if user.role !== admin and email differs → 403
   4. filename = "thumb_<uuid>.jpg"
   5. isVariant = true → dir = getHistoryVariantsDir()
   6. path.resolve(filePath).startsWith(path.resolve(dir)) → ok
   7. fs.readFile → 200 with Cache-Control: immutable
```

Same path-traversal defence runs in front of either root; the dispatch is just the choice of root.

---

## Two roots, one URL space — the dispatch invariant

The single most important invariant of this branch:

- The CLIENT only knows one URL template: `/api/history/image/<email>/<YYYY>/<MM>/<filename>`.
- The SERVER's GET handler routes to one of two physical roots based on the basename prefix: `thumb_*` / `mid_*` → variants root, anything else → images root.

This was a deliberate decision over the alternative of adding `/api/history/variant/...` as a sibling endpoint. The chosen design changes exactly one file (the GET handler) and zero client URL templates. The two roots have structurally identical sub-trees (`<email>/<YYYY>/<MM>/`), so the same segment validation, the same owner-email auth check, and the same `resolve().startsWith(root)` traversal guard work uniformly.

If you ever need a third root (e.g. animated previews) the cleanest extension is another prefix branch in the same dispatch — not another route.

---

## Duplicate-originals fix

This was a follow-up rather than part of the original plan, discovered during smoke. Three iterations to land on the right approach:

### Iteration 1 (reverted): drop server-side `downloadAndSave`

Initial idea — have providers return the external Fal/Comfy URL directly to the client. Client fetches the external URL, generates variants, uploads. One server save, no duplicate.

Failed in smoke: the client's `createImageVariants(externalUrl)` did `fetch(externalUrl)` which CORS-blocked Comfy's `api.comfy.org` endpoint. Generation died with `TypeError: Failed to fetch`. Even data-URI inline base64 didn't help for the URL branch.

Commits 58eaa36, a57679c (reverted by fa9bb0d, 51f9312).

### Iteration 2 (shipped): uuid reuse + idempotent POST

The shipped fix preserves the sync-provider server-side save (so the client always fetches a same-origin URL) but eliminates the duplicate:

1. **Client** — `lib/history-urls.ts::extractServerUuid(url)` parses the local history-image URL shape and returns the embedded uuid. `generate-form.tsx::saveToServerHistory` calls this on the provider's `outputUrl`; if non-null, the upload uuid becomes the server's uuid, falling back to `historyId` for non-local URLs.

2. **Server** — `POST /api/history` checks if the original file already exists at `<uuid>.<ext>`. If yes (the typical sync-provider case), it accepts the multipart `original` part but skips the disk write. thumb_/mid_ are written unconditionally into the variants root. The previous "uuid collision → 409" branch is gone — v4 uuid collisions are vanishingly rare, and the thumb/mid overwrite case is harmless.

3. **Result** — one canonical original per generation under HISTORY_IMAGES_DIR, with the same uuid the DB row references. thumb/mid are deterministically named with that same uuid in HISTORY_VARIANTS_DIR.

### Iteration 3 (shipped): SSE-arrives-before-confirm dedup

After Iteration 2, smoke surfaced a second issue: the UI showed two thumbnails for one generation. Diagnosis: under the upload-flow with extracted uuid, the pending entry's local `id` is the client `historyId`, but the server's row references the server uuid. `applyServerRow`, called from SSE, used to dedupe by `(id | serverGenId)`. Pre-confirm the `serverGenId` is unset; the `id` doesn't match. So it inserted a second row.

Fix — add a third matcher: `HistoryEntry.uploadUuid` is stamped on the pending entry the moment the upload uuid is decided. `applyServerRow` matches by `(id | serverGenId | uploadUuid)`. Now the SSE event binds back to the pending entry regardless of arrival order.

### What stays as a remediation tool

The **Удаление орфан-оригиналов** admin block stays — for historical generations created before the uuid-reuse fix, the duplicate originals still sit on disk and aren't going anywhere on their own. Run the orphan-purge once per environment after deployment.

---

## Hard-delete contract — paired rename

Reference: prior post-ship at [`2026-05-07-admin-user-hard-delete-post-ship.md`](./2026-05-07-admin-user-hard-delete-post-ship.md) for the original single-root flow.

The DELETE handler now uses two new helpers from `lib/admin/folder-rename.ts`:

```ts
findFreeDeletedTargetAcross([imagesDir, variantsDir], email)
  → picks the lowest deleted_N slot free in BOTH dirs.

renameUserFolderToTarget(dir, email, target)
  → renames {dir}/{email} → {dir}/{target} using the same
    Windows EPERM/EBUSY retry wrapper as before.
```

The handler picks the target ONCE via `findFreeDeletedTargetAcross`, records it in the audit event's `folder_rename_target`, then runs the two renames independently in their own try/catch blocks. Failure of one does not block the other. The response carries:

```json
{
  "ok": true,
  "purged": {
    "email": "alice@x.com",
    "generations_deleted": 47,
    "summary_csv_written": true,
    "folder_renamed_to": "deleted_2_alice@x.com",
    "rename_outcome": { "images": "renamed", "variants": "renamed" }
  }
}
```

`folder_renamed_to` is set if AT LEAST one side renamed. `warning: "rename_failed"` is emitted if either side failed; `intended_target` carries the predicted slot for manual recovery.

`_SUMMARY.csv` stays on the images side only. It is logically about user content (originals + billing semantics), not about the cache.

---

## Admin "Превью / History state" tab

`components/admin/preview-state-tab.tsx`, registered in `components/admin-panel.tsx` as a fifth tab next to Settings / Styles / Users / Models.

**Four sections, top to bottom:**

1. **Состояние превью** — read-only stats. The disk counts walk HISTORY_VARIANTS_DIR; for now this is an on-demand FS walk, acceptable up to a few thousand generations. Refetches on mount, on `admin.variants_rebuild_done`, and after a successful purge.

2. **Очистка старых вариантов** — one-time tool that runs `purgeLegacyVariants(imagesDir)` to remove `thumb_*.jpg` / `mid_*.jpg` from `<imagesDir>/<email>/<YYYY>/<MM>/`. Skips `deleted_*/` top-level dirs and non-UUID-shaped basenames. Typed-`УДАЛИТЬ` gate.

3. **Удаление орфан-оригиналов** — companion tool that runs `purgeOrphans(db, imagesDir)`. Walks the same shape, but only removes `<uuid>.<ext>` originals where the relative path is NOT present in any `generation_outputs.filepath` row. Same typed-`УДАЛИТЬ` gate.

4. **Пересборка вариантов** — server-side sharp regeneration. Two entry points:
   - Per-user "Пересобрать" button in the user list.
   - Global "Пересобрать всё" button.

   Both POST to the corresponding admin endpoint which calls `tryStartJob` on the in-memory registry. If a job is already active, the second invocation folds into it (returns the existing `jobId` with `folded: true`) — never starts a parallel job. Progress events are emitted at ~1 Hz via SSE; the UI shows a live progress strip and live error count. On `admin.variants_rebuild_done` the UI refetches stats and the user list.

A collapsed "Ошибки последней пересборки (N)" details section sits at the bottom of the tab when `activeJob.errorCount > 0`. The detailed error list itself is only available right after the controller opens the tab during/after the job (because the server-side error array is stored in the per-process job registry, which the UI hasn't fetched yet beyond the SSE-carried count). The UI explicitly tells the operator to refresh the page to see details — acceptable for an admin debugging path.

---

## Architectural conventions established

### 1. Two-root, one-URL dispatch

A new file class (cache vs content, audit vs data, etc.) can be added without inventing a new URL prefix. Encode the class in the basename prefix, dispatch by that prefix in the route. Keep auth and traversal checks in front of the dispatch so they apply uniformly.

### 2. Shared spec modules for cross-runtime constants

Where client and server both consume the same numeric parameters (resize widths, timeouts, quotas), put them in a server-safe module and import from both sides. A trivial unit test asserting the constants exist + match expected values keeps the two consumers from silently diverging. Example: `lib/image-variants-spec.ts`.

### 3. lib/admin/ for admin server logic

Extension of the convention established by the hard-delete work. Pure DB helpers take a `Database`; pure FS helpers take an `imagesDir`/`variantsDir`. Orchestration combines them. Routes are thin wrappers. Tests live in `__tests__/` next door and run against `:memory:` SQLite + `os.tmpdir()` directories.

### 4. In-memory job registry on globalThis

Single-active-job invariant; second invocation folds. Survives Next.js HMR by stashing on `globalThis`. Same pattern as `lib/sse-broadcast.ts`'s subscriber registry. Acceptable trade-off for operations that are: (a) rare, (b) idempotent on restart, (c) where a separate DB table would be migration surface for vanishingly low value.

### 5. Idempotent POST writes — accept "already there" as success

When a write target is content-addressed (uuid file naming, deterministic hashes), check existence first and skip rather than 409. The collision case for v4 uuids is effectively impossible; the more common case is "someone else already produced this file." Don't make the caller jump through a retry loop for a state that is correct.

### 6. Third-matcher dedup for cross-system races

When a local entity has a generated id but its persisted form lives under a different id, store BOTH ids on the local record and match by either. The duplicate-thumbnail bug was specifically: client `historyId` ≠ server `uuid_server`. The fix was to stamp `uploadUuid` on the local entry and add it as a `find()` predicate. Generalize: any time you replace an entity's primary key on persistence, keep the old key as a secondary matcher in any read-side reducer.

### 7. Re-enable sharp surgically

Sharp was historically removed when client-side variant generation shipped. We re-enabled it ONLY for the rebuild path — the hot POST path stays client-only, no sharp on the request thread. The pre-flight smoke (Task 1 of the plan) was a 1-second `sharp({create:...}).jpeg().toBuffer()` invocation; install issues surface in 60 seconds rather than mid-feature.

---

## Pitfalls — easy ways to re-break things

### Don't move thumb/mid back into HISTORY_IMAGES_DIR

The whole point of the cache split is that `HISTORY_IMAGES_DIR/<email>/` is now an exportable, backupable, user-facing folder. Any code path that writes thumb_*.jpg or mid_*.jpg back into the images-dir re-poisons the well. New code that creates derivative artifacts must put them under HISTORY_VARIANTS_DIR (or a third root with its own basename prefix and dispatch branch).

### Don't add audit calls for orphan/legacy purge without a new AuthEventType

`AuthEventType` is a closed union in `lib/auth/audit.ts`. The plan explicitly punted adding a new variant for the admin variant-tooling operations. If you decide an audit trail is needed, add the variant (e.g., `'admin_variants_legacy_purged'`) in its own commit before adding the call sites.

### Don't change the upload uuid logic without considering `applyServerRow`'s match clauses

The three-way match `(id | serverGenId | uploadUuid)` is load-bearing. Any change to how the client picks `uploadUuid` must consider whether the server's `extractUuid(filepath)` will produce a value that matches one of those three slots on the pending entry. The current invariant is: `uploadUuid` is exactly what the on-disk filename uses, which is exactly what `extractUuid(filepath)` returns.

### Don't drop the orphan-purge tool

Even after Iteration 2 of the duplicate fix, historical orphans (originals from before the fix) remain on disk. The orphan-purge tool is the only way to clean them. It's also a useful safety net for any future bug that accidentally double-writes — having the tool ready saves a manual hunt-and-delete.

### Don't single-call `findFreeDeletedTarget` for paired-root renames

Calling it twice — once per root — risks the two roots picking different slots (one has `deleted_alice/` from a prior purge, the other doesn't). Always use `findFreeDeletedTargetAcross` for paired contexts. The two-root invariant in this codebase is "same path shape in both roots"; respect it.

### Don't add an `EventSource` per tab section

The tab subscribes ONCE to `/api/history/stream` in a single `useEffect`. Adding another listener in a sub-section would open a second connection. The existing stream is multiplexed for admin events; just register more `addEventListener` calls on the same `es`.

### Don't assume the rebuild job survives a process restart

The registry is `globalThis`-stashed but process-local and in-memory. A `npm run dev` restart, a deploy, or any process crash forgets the active job. The runner is idempotent so re-clicking the button just retries from scratch. If you ever need long-running jobs (hours+), persist `variant_rebuild_jobs` to SQLite — but that's a bigger redesign and YAGNI today.

---

## Test coverage

**294/294 vitest pass after the branch. 42 new tests across 8 new test files** plus extensions to one existing test file:

| File | Tests | Notes |
|------|-------|-------|
| `lib/__tests__/image-variants-spec.test.ts` | 2 | Constants present + match expected scale |
| `lib/__tests__/history-variants-dir.test.ts` | 2 | Default path + env override + dir created |
| `lib/__tests__/variants-builder.test.ts` | 6 | Resize widths, no-enlarge, idempotent, original_missing, no_original, non-image-output |
| `lib/__tests__/history-urls.test.ts` | 6 | extractServerUuid: canonical, uppercase, external, blob, data URI, legacy flat, no ext |
| `lib/admin/__tests__/folder-rename.test.ts` | +4 | Across-dirs target picker (2) + named-target rename (2) |
| `lib/admin/__tests__/variants-jobs.test.ts` | 6 | Start/fold/restart/bumpDone/error-cap/getActive |
| `lib/admin/__tests__/variants-runner.test.ts` | 3 | Happy path scope=user, per-row error continues, scope=all multi-user |
| `lib/admin/__tests__/legacy-purge.test.ts` | 5 | Empty / counts / deletes / idempotent / skips deleted_*/ |
| `lib/admin/__tests__/orphan-purge.test.ts` | 8 | Empty / referenced not-orphan / unreferenced orphan / thumb_-mid_ ignored / non-uuid ignored / deleted_-ignored / purge / idempotent |

Untested by unit (covered by smoke):

- The 9 new admin route handlers — thin wrappers, the logic-carrying module under each has unit coverage.
- The `PreviewStateTab` React component — UI components aren't unit-tested in this project.
- The DELETE handler's paired-rename wiring — the pure `findFreeDeletedTargetAcross` / `renameUserFolderToTarget` have unit coverage; the handler is delegation.
- The POST /api/history idempotent-original branch — manual smoke confirmed the disk-count drops from 2 to 1.

---

## Open follow-ups

- **Wavespeed provider smoke** — the third sync provider goes through the same upload path so it should be fine, but a real generation is needed to confirm.
- **Run orphan-purge on the production deployment** when this branch ships there. Historical orphans accumulate disk space without surfacing as anything visible until someone inspects the folder.
- **Variants disk-count walk on large deployments** — at 100k+ generations the `countByPrefix` FS walk for the stats endpoint will get slow. If the count starts mattering, denormalize into a small table or cache it in-memory and invalidate on POST/rebuild.
- **Error log persistence** — the per-job error array lives in process memory and disappears on restart or next job start. If admins start needing post-mortem visibility, persist into a `variant_rebuild_job_errors` table.
- **Rebuild throttle test** — the 1-second SSE throttle in `variants-runner.ts` is implemented but not unit-tested. Easy to add with a clock-stub if regressions appear.
- **A "show details" button on the rebuild error list** — currently the UI shows the error count from SSE but doesn't auto-fetch the detail list. A `fetch('/api/admin/variants/job/<jobId>')` on click would populate the list. Trivial follow-up.
- **CORS-proxy for true single-save providers** — if a future provider has CORS-open output URLs, Iteration 1 of the duplicate fix becomes viable: provider returns the external URL, client fetches and uploads, no server-side save. The shipped Iteration 2 design doesn't preclude this — it just doesn't depend on CORS being open. A provider opt-in flag could route between the two flows.
