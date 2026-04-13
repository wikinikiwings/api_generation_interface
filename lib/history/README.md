# History Module

Single source of truth for image-generation history: pending uploads,
server-confirmed entries, deletions. All state, mutations, hydration,
SSE, and BroadcastChannel logic lives here.

## Mental model

Each entry has a `state`:

```
PENDING ──────► LIVE ──────► DELETING ──────► REMOVED
                  ▲              │
                  └──────────────┘  (rollback on DELETE failure)
```

- **PENDING** — locally generated this tab, not yet on server. Blob URLs.
- **LIVE** — server has the row. Server URLs (or blob URLs of the originating tab; blob always wins).
- **DELETING** — user clicked delete; server DELETE in flight. UI may animate.
- **REMOVED** — gone. Tombstone in the store; never resurrected by server input.

The default hook filter excludes REMOVED. DELETING is rendered by default
(opt out via `excludeDeleting: true`) so a future fade-out animation can
play before eviction.

## Three places to look when editing

1. **`store.ts`** — types, state transitions, `applyServerRow` (the only
   place that decides "accept a server row" — invariant 2 lives here:
   server input never resurrects DELETING/REMOVED).
2. **`mutations.ts`** — `deleteEntry` (the only removal path),
   `addPendingEntry` / `confirmPendingEntry` lifecycle, `updateEntry`
   for non-state metadata patches.
3. **`index.ts`** — public surface. If a consumer needs something not
   listed here, it doesn't exist. ESLint blocks deep imports of internals.

## Public API

```ts
// Hooks
useHistoryEntries({ username, range?, excludeDeleting? }) →
  { entries, isLoading, isLoadingMore, hasMore, loadMore, error, refetch }
useEntryById(id) → HistoryEntry | undefined
useGenerationEvents(username) → void  // mount once at app shell

// Mutations
deleteEntry(idOrServerGenId, { skipServerDelete? }?) → Promise<void>
addPendingEntry(input: NewPendingInput) → void
updatePendingEntry(uuid, urlPatch) → void
updateEntry(id, metaPatch) → void  // non-URL, non-state fields
confirmPendingEntry(uuid, { serverGenId, serverUrls }) → void
markPendingError(uuid, message) → void
setPendingControls(uuid, { retry?, abort? }) → void
getPendingControls(uuid) → { retry?, abort? } | undefined
```

## Operator's manual

When something looks wrong, enable the debug flag in DevTools console:

```js
localStorage.setItem("DEBUG_HISTORY_DELETE", "1");
```

Then perform the action and read the console.

| Symptom | Where to look |
|---|---|
| Card won't disappear on delete | `deleteEntry.start` → `deleteEntry.commit` sequence. Missing commit → DELETE hung; check Network tab. Missing start → click handler isn't wired to `deleteEntry`. |
| Card reappears after another generation | Look for `applyServerRow.ignored` for the entry's id. If absent, invariant 2 is broken (or the entry wasn't actually in DELETING/REMOVED at the time). Inspect `useHistoryStore.getState()` to confirm. |
| Cross-tab delete doesn't propagate | Look for `broadcast.send` in tab A and `broadcast.recv` in tab B. Sender shows send but receiver shows no recv → BroadcastChannel support / extension blocking. |
| Cross-device delete doesn't propagate | DevTools → Network → EventStream tab. If no `generation.deleted` event arrived, the server's `broadcastToUser` didn't fan out (HMR-broken subscribers map in dev; check server logs in prod). |
| Output strip empty after reload | Network tab for `/api/history`. 200 → check `applyServerList` log entry. 4xx/5xx → server side. Skeleton stuck >2 s → check throttling. |
| Pending card stuck after upload error | Check for `deleteEntry.error` (rollback) or `markPendingError` log. The card should show `uploadError`; deleting it triggers the pending path (`deleteEntry.pending`) — abort + revoke. |

## Architecture invariants

These are enforced in code (one place each) and tested:

1. **State is monotone toward "deleted":** PENDING/LIVE → DELETING → REMOVED.
   Reverse only via `rollbackDeletion` after a failed DELETE.
2. **Server input does not resurrect** DELETING/REMOVED entries — `applyServerRow` guard.
3. **REMOVED is a tombstone** kept in the store forever within the session.
4. **Default hook filter** excludes REMOVED.
5. **`deleteEntry` is idempotent** on PENDING-without-server, DELETING, REMOVED.
6. **One writer per state-transition** — all transitions in `mutations.ts`.
7. **`applyServerList` cross-device delete** only fires for first page (`offset=0`)
   and only inside the response time window — pagination + old entries safe.
8. **Animation hold doesn't block server commit** — failure path runs regardless.

## Spec

`docs/superpowers/specs/2026-04-13-history-sync-mechanism-redesign-design.md`

## Plan

`docs/superpowers/plans/2026-04-13-history-sync-mechanism-redesign.md`
