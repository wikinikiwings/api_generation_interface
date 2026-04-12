# History Delete & Sync — Cleanup Spec

**Date:** 2026-04-12
**Status:** Design for future agent — pick up after a fresh session with the current delete behavior stable for ≥ 1 week

## Problem

The delete/refresh story across Output strip, History sidebar, Zustand, server DB, and SSE has accumulated enough call-sites that the flow is hard to reason about end-to-end. Symptoms that surfaced during the blur-up work:

1. Delete from Output left the card stranded ("очень долго, удаляется через полминуты").
2. Deleting X while Y was generating would re-surface X in the sidebar right after Y's completion — race between `triggerHistoryRefresh` and the not-yet-committed server DELETE.
3. Two DELETE requests fired per click on some clicks (observed in dev server logs; React strict-mode and/or DOM event bubbling suspected but unconfirmed).
4. SSE `generation.deleted` events were unreliable in dev because Next.js HMR reset the `subscribers` Map in `lib/sse-broadcast.ts` while client EventSource connections stayed "alive" from the browser's POV.
5. Three independent optimistic paths (Zustand.remove, `setDeletingIds`, `markGenerationDeleted`) had to be kept in sync by hand across three call-sites.

Each was patched as it surfaced; the patches accumulated. The underlying architecture is sound but now deserves consolidation.

## Current state (as of `dee4569`)

### Surfaces

- **Output strip** (`components/output-area.tsx`) — renders `todayEntries`, a merge of Zustand `entries` filtered to today + `serverToday` rows from `useHistory` for today's date range. Dedups by `serverGenId`.
- **History sidebar** (`components/history-sidebar.tsx`) — renders `visibleItems`, derived from `useHistory.items` filtered by an optimistic `deletingIds` state set.
- **ImageDialog siblings nav** — uses `useHistorySiblings`, a view over the same `useHistory.items`.

### Stores

- **`useHistoryStore`** (Zustand) — local entries, persisted to localStorage. Carries the original blob URLs for just-generated rows and the `serverGenId` link to server DB.
- **`pendingHistory`** (`lib/pending-history.ts`) — in-memory singleton of not-yet-confirmed uploads. Flows into `useHistory.mergedItems` for the sidebar.
- **`useDeletionsStore`** (`lib/history-deletions.ts`) — cross-surface registry of just-deleted server generation IDs. Filtered at source inside `useHistory.mergedItems`.

### Paths that can remove a row

1. **Output card trash click** → `handleRemove(entry)`:
   - If no `serverGenId`: `remove(entry.id)` on Zustand. Return.
   - Else: optimistic (`remove` + `markGenerationDeleted` + `broadcastHistoryRefresh`), then `fetch DELETE /api/history?id=...`.
2. **Sidebar trash click** → `handleDelete(gen)`:
   - If pending: `removePending(gen.uuid)`. Return.
   - Else: optimistic (`setDeletingIds.add` + `markGenerationDeleted` + Zustand.remove by `serverGenId` match), then `fetch DELETE`.
3. **SSE `generation.deleted`** (`useGenerationEvents`) — fires on any origin device's DELETE. Calls `markGenerationDeleted(id)` and removes matching Zustand entries.
4. **SSE `generation.created` reconnect** — broadcastHistoryRefresh triggers refetch; not a delete path but adjacent.

### Server DELETE handler

`app/api/history/route.ts DELETE` — `deleteGeneration(id, username)` (synchronous `better-sqlite3`), then `broadcastToUser(username, { type: "generation.deleted", data: { id } })`.

### Debug instrumentation

`lib/history-debug.ts` exposes `debugHistory(event, payload)` gated by `localStorage.DEBUG_HISTORY_DELETE === "1"`. Already wired into:

- `markGenerationDeleted` (success + skip)
- Output `handleRemove` (click / server.ok / server.error)
- Sidebar `handleDelete` (click / server.ok / server.error)
- `useGenerationEvents` SSE `generation.deleted` and `generation.created`

## Known issues

| # | Issue | Severity | Current workaround |
|---|---|---|---|
| 1 | Two DELETE requests on one click | Low (idempotent server side, both return 200) | Accepted — server DELETE is idempotent |
| 2 | SSE lost on HMR in dev | Medium (delete rows stranded) | Optimistic local cleanup makes SSE non-critical for same-tab flow |
| 3 | `triggerHistoryRefresh` 1.5 s debounce can re-fetch before server DELETE commits | Medium | `crossDeletedIds` set filters stale rows from refetch |
| 4 | Three call-sites each call optimistic hides manually | Low (source filter now covers sidebar + Output) | Source filter in `useHistory.mergedItems`; call sites only call `markGenerationDeleted` |
| 5 | `deletedIds` never evicts within a session | Low | Server IDs monotonic — no reuse risk. Reload clears |

## Proposed consolidation

### Goal

One entry point for "remove a history row" that every call-site calls. The entry point does all the optimistic local cleanup, fires the server DELETE, and handles toast + error state uniformly. SSE cleanup remains for cross-device, but same-tab UX never depends on it.

### New module: `lib/history-mutations.ts`

```ts
/**
 * Single source of truth for destructive history operations.
 * Every call-site (Output, Sidebar, future keyboard shortcut) goes
 * through these — never fetches DELETE directly.
 */

export interface DeleteOptions {
  localId?: string;       // Zustand entry id, optional
  serverGenId?: number;   // Server row id, optional
  pendingUuid?: string;   // lib/pending-history uuid, optional
  username: string;
  /** Callback for UI feedback. Defaults to sonner toast. */
  onFeedback?: (kind: "success" | "error", message: string) => void;
}

export async function deleteHistoryEntry(opts: DeleteOptions): Promise<void>;
```

Inside, the function:

1. Runs ALL optimistic local cleanups that apply, in this order:
   - `removePending(pendingUuid)` if given
   - `useHistoryStore.getState().remove(localId)` if given
   - `markGenerationDeleted(serverGenId)` if given
   - `broadcastHistoryRefresh()`
2. If `serverGenId` is present, fires `fetch DELETE`.
3. On success: `onFeedback("success", "Удалено")`.
4. On failure: `onFeedback("error", message)` but does NOT resurrect.
5. Returns.

Call-sites become:

```ts
// Output
await deleteHistoryEntry({
  localId: entry.id,
  serverGenId: entry.serverGenId,
  username,
});

// Sidebar
await deleteHistoryEntry({
  pendingUuid: isPending(gen) ? gen.uuid : undefined,
  serverGenId: isPending(gen) ? undefined : gen.id,
  localId: matchingLocalIds[0], // derive from Zustand lookup if needed
  username,
});
```

### Other consolidation

- **Remove `setDeletingIds`** from sidebar. With source-level filter in `useHistory` already applied via `useDeletedIds`, the only thing `setDeletingIds` adds is "hide before markGenerationDeleted propagates" which is the same tick anyway.
- **Consider moving `useHistoryStore.remove`'s orphan-by-serverGenId logic into `history-mutations.ts`**. Zustand.remove takes a local id only; the "remove all Zustand entries whose serverGenId === X" sweep belongs next to `markGenerationDeleted`, not scattered in SSE handler + sidebar delete.

### Testing

Sketch a playwright or manual matrix:

1. Delete an Output-today local card with serverGenId set. Expect: instant removal in Output + sidebar + no regression on server refetch.
2. Delete an Output-today remote card (cross-device). Expect: instant removal, server refetch doesn't resurrect.
3. Delete a sidebar confirmed row. Expect: instant removal in sidebar + Output, server refetch clean.
4. Delete a sidebar pending row. Expect: instant removal, no server call, no SSE wait.
5. Delete X, immediately start generation Y, wait for Y to finish. Expect: X stays hidden, Y appears.
6. Two tabs, user A generates in tab 1, user A deletes in tab 2 (simulating SSE cross-tab). Expect: both tabs agree.
7. Devtools "Disable cache" + SSE still delivers cleanups. (SSE bypasses HTTP cache anyway.)
8. Dev-server HMR reload during test — manual verify that optimistic paths still work, SSE loss is non-fatal.

### Metrics to capture before cleanup

- Count of Output `handleRemove` + sidebar `handleDelete` invocations vs. actual server DELETEs over a representative session. If they don't match, dig in.
- Time between click and `sse.generation.deleted` arriving (when SSE survives HMR) — confirm target latency.
- React profiler: time-to-repaint after click OK on a delete when sidebar has 30+ cards. Target: < 50 ms total.

## Non-goals for this cleanup

- Service Worker for SSE durability — covered by separate deferred spec `2026-04-12-sw-image-cache-future.md`.
- Changing server DELETE behavior (already idempotent, fast).
- New UI — delete UX stays identical after cleanup.
- Multi-device conflict resolution — current "last writer wins" (deletion is absorbent) is fine.

## Risks of deferring

None severe. The current behavior works. This is a maintainability investment, not a correctness fix. Can be safely deferred until another bug surfaces in the area OR an agent is picking up a related story and wants clean ground to stand on.

## Execution hints for the future agent

- Land the new `history-mutations.ts` first with test cases as a harness script (pattern: one-off `scripts/verify-*.ts` like `thumbUrlForEntry` used).
- Migrate Output handleRemove to the new API — verify no regression, commit.
- Migrate Sidebar handleDelete — verify, commit.
- Migrate SSE `generation.deleted` handler — verify, commit.
- Delete old scattered optimistic-cleanup lines — verify, commit.
- Update `lib/history-debug.ts` call-sites if renaming.
- Read `lib/history-debug.ts` and turn on the flag during manual verification to trace every fire.

When doubting an approach, enable `localStorage.setItem("DEBUG_HISTORY_DELETE", "1")` and reproduce the flow. Every delete path already logs through `debugHistory` — if a change silently breaks one, the missing log line is the signal.

## References

- `dee4569` — source-level filter in `useHistory.mergedItems`
- `5f7db4b` — `lib/history-deletions.ts` backed by Zustand + SSE wire
- `ecc1a84` — first optimistic local Zustand cleanup
- `e994900` — hide before awaiting DELETE (optimistic UI)
- `c2cb848` — Output remote filter (superseded by source-level filter)
- `ba9638e` — stable key for pending entries
