# History Sync Mechanism — Post-Ship Handoff

**Date:** 2026-04-13
**Status:** Shipped. All 22 unit tests green, all 16 manual scenarios verified, production build green.
**Intended readers:** any future agent or engineer editing `lib/history/`, debugging sync issues, or recovering from a regression.

## Quick-nav

- [Status & scope](#status--scope)
- [The problem, the symptoms, the fix](#the-problem-the-symptoms-the-fix)
- [Architecture in one page](#architecture-in-one-page)
- [Walk through the code](#walk-through-the-code)
- [Critical invariants](#critical-invariants-and-why-they-hold)
- [Data flows](#data-flows)
- [Test coverage — what is guaranteed](#test-coverage--what-is-guaranteed)
- [Extension points](#extension-points--safe-ways-to-change-things)
- [Pitfalls — things that look wrong but aren't](#pitfalls--things-that-look-wrong-but-arent)
- [Recovery — when X breaks, look at Y](#recovery--when-x-breaks-look-at-y)
- [Rollback — nuclear option](#rollback--nuclear-option)
- [Open follow-ups](#open-follow-ups)
- [Commit inventory](#commit-inventory)

---

## Status & scope

**What is in place:**

- Unified history module at `lib/history/`. Single public surface
  (`@/lib/history` → `lib/history/index.ts`).
- One Zustand store. One removal function. One server-ingestion function.
- Cross-device sync via SSE that patches in-place (no refetch storms).
- Cross-tab sync via BroadcastChannel.
- 200ms fade-out animation on delete (opacity + scale).
- Debug logger gated by `localStorage.setItem("DEBUG_HISTORY_DELETE","1")`.
- ESLint rule blocking deep imports of internals.
- One-time `localStorage.removeItem("wavespeed-history")` cleanup of
  the previous persistent store.

**What was deliberately NOT touched:**

- Server-side: `/api/history` GET/POST/DELETE, `/api/history/stream`
  SSE, `lib/sse-broadcast.ts`, `app/api/history/image/[filename]`.
  **No DB migration.**
- Image pipeline: `lib/image-variants.ts`, `lib/history-upload.ts`,
  `lib/image-cache.ts`, `components/blur-up-image.tsx`.
- `sonner`, `zustand`, Next.js, React versions — all unchanged.

**Scope limit of the redesign:** correctness + maintainability of the
client-side sync mechanism. NOT performance, NOT server scalability,
NOT feature additions.

## The problem, the symptoms, the fix

### Symptoms the user repeatedly hit

1. **Resurrection.** Delete X → generate Y while DELETE X is in flight
   → refetch arrives with X still on server → X re-surfaces in Sidebar
   for a window before server commits.
2. **Inability to delete.** Card won't disappear because some handler
   relied on a cross-surface event that never fired (HMR-broken SSE
   subscribers map).
3. **Asymmetric behavior.** Output `handleRemove` and Sidebar
   `handleDelete` had drifted — different cleanup logic, different
   filters, different race windows.
4. **Slow delete.** Multi-step optimistic chain felt like 500ms of UI
   lag even when it was actually ~30ms of React re-renders.

### Root cause in the old code

Three concurrent stores (`useHistoryStore`, `pendingHistory`,
`useDeletionsStore`) with overlapping responsibilities; four refresh
triggers; four removal paths; each call-site had to remember to apply
its own filter. Resurrection was architecturally *possible* — no
invariant forbade it — only discipline and handler vigilance.

### The architectural fix

**One store. One entry type with a `state` field. One decision point
for "accept a server row" (`applyServerRow`) that is forbidden from
resurrecting DELETING/REMOVED.**

Resurrection is no longer a bug you can introduce by forgetting to
filter somewhere — it is *architecturally impossible* while invariant 2
holds in `applyServerRow`. To bring resurrection back, you would have
to edit `store.ts::applyServerRow` and delete the guard. Everything
else flows from that single check.

## Architecture in one page

```
           user click Generate                  user click Trash
                   │                                   │
                   ▼                                   ▼
       ┌─────────────────────┐              ┌───────────────────────┐
       │   addPendingEntry   │              │      deleteEntry      │
       │   state=pending     │              │  live → deleting      │
       └──────────┬──────────┘              │  anim hold 200ms      │
                  │                         │  fetch DELETE         │
                  │ generation pipeline     │  success → removed    │
                  │ (status updates)        │  failure → live       │
                  │                         └───────────┬───────────┘
                  ▼                                     │
       ┌─────────────────────┐                          │
       │ createImageVariants │                          │
       │ + uploadHistoryEntry│                          │
       │   (generate-form)   │                          │
       └──────────┬──────────┘                          │
                  │                                     │
                  │ server row returned                 │
                  │                                     │
                  ▼                                     │
       ┌─────────────────────┐                          │
       │ confirmPendingEntry │                          │
       │ pending → live      │                          │
       │  (blob URLs kept)   │                          │
       └──────────┬──────────┘                          │
                  │                                     │
      ╔═══════════╧═════════════════════════════════════╧═══════════╗
      ║                   useHistoryStore (Zustand)                 ║
      ║            entries[] with state=pending|live|deleting|removed║
      ║            REMOVED = tombstone, never resurrected            ║
      ╚═══════════╤═════════════════════════════════════════════════╝
                  │
      ┌───────────┼────────────┬─────────────────┬─────────────────┐
      │           │            │                 │                 │
      ▼           ▼            ▼                 ▼                 ▼
  useHistory  useEntry   hydrate.ts        sse.ts         broadcast.ts
  Entries     ById       ← fetch+apply    ← SSE events   ← BroadcastChannel
  (component  (single    (mount, SSE      (created,       (cross-tab
   feed)      entry)      open reconnect)  deleted, open)  delete/rehydrate)
```

**Components consume only through `useHistoryEntries`, `useEntryById`,
`useGenerationEvents`.** They never import the Zustand store, never
call `applyServerRow`, never call `hydrateFromServer`. The public API
surface is in `lib/history/index.ts` and ESLint blocks deep imports of
internals.

## Walk through the code

`lib/history/`:

| File | Responsibility | Public? |
|---|---|---|
| `types.ts` | `HistoryEntry`, `EntryState`, `DateRange`, `NewPendingInput`, `ServerGeneration` | yes (re-exported) |
| `util.ts` | `extractUuid(filepath)` | no |
| `debug.ts` | `debugHistory(event, payload)` — localStorage-flag-gated | no |
| `pending.ts` | `setPendingControls/getPendingControls/clearPendingControls` — retry/abort callback map | yes (via mutations) |
| `store.ts` | Zustand store + state helpers (`setStateOf`, `markRemoved`, `rollbackDeletion`) + `applyServerRow` (single server-row decision) + `applyServerList` (cross-device delete invariant) | no (internal-only) |
| `hydrate.ts` | `hydrateFromServer` — debounced, race-guarded `/api/history` fetch → `applyServerList` | no |
| `mutations.ts` | `deleteEntry`, `addPendingEntry`, `updatePendingEntry`, `updateEntry`, `confirmPendingEntry`, `markPendingError`, `setCurrentUsername`, `setUsernameForTest` | yes (deleteEntry + pending lifecycle) |
| `broadcast.ts` | BroadcastChannel wire-up. On `message` → `deleteEntry(...,{skipServerDelete:true})` or `hydrateFromServer`. Exports `broadcast.post`. | no (but posts from mutations) |
| `sse.ts` | `useGenerationEvents(username)` + internal `open`/`close`. Translates SSE events to in-place mutations. | yes (hook) |
| `hooks.ts` | `useHistoryEntries(opts)`, `useEntryById(id)` | yes |
| `index.ts` | Public re-export surface | — |
| `README.md` | One-page mental model + operator's manual | — |
| `__tests__/` | Vitest unit tests for store, hydrate, mutations, sse | — |

**Everything outside `lib/history/`** that interacts with history:

- `components/generate-form.tsx` — creates entries via
  `addPendingEntry`, updates via `updateEntry`/`updatePendingEntry`,
  confirms via `confirmPendingEntry`, removes via `deleteEntry`.
- `components/output-area.tsx` — reads via `useHistoryEntries`, mounts
  SSE via `useGenerationEvents`, deletes via `deleteEntry`.
- `components/history-sidebar.tsx` — reads via `useHistoryEntries`,
  deletes via `deleteEntry`.
- `components/image-dialog.tsx` — consumes `HistoryEntry` type only.

## Critical invariants (and why they hold)

Each invariant is enforced in *one place* — the blast radius of "if you
break this, it's this file, these lines." Test coverage column shows
which `__tests__` exercise the invariant.

### Invariant 1: State is monotone toward "deleted"

`PENDING/LIVE → DELETING → REMOVED`. Reverse only via
`rollbackDeletion` after failed DELETE.

**Enforced by:** `lib/history/mutations.ts::deleteEntry` — it never
calls `setStateOf(id, "live")` except via `rollbackDeletion`. There is
no public function that can move DELETING or REMOVED back to LIVE.

**Tests:** U10 (LIVE→DELETING→REMOVED happy path), U11 (LIVE→DELETING
→LIVE on failure).

### Invariant 2: Server input does not resurrect

`applyServerRow(row)` and `applyServerList(rows)` MUST NOT change the
state of an existing entry that is in DELETING or REMOVED.

**Enforced by:** `lib/history/store.ts::applyServerRow` — first
conditional:

```ts
if (existing && (existing.state === "deleting" || existing.state === "removed")) {
  debugHistory("applyServerRow.ignored", {...});
  return;
}
```

**This is the single architectural guarantee against resurrection.** If
you edit this function, re-read the race scenarios in the spec before
changing the guard condition. Any future server-row ingestion path
(new SSE event, new fetch) must route through `applyServerRow` to
inherit this guard.

**Tests:** U3 (DELETING ignored), U4 (REMOVED ignored).

### Invariant 3: REMOVED is a tombstone

Removed entries stay in the store (≈200 bytes each) forever within the
session. The default `useHistoryEntries` filter hides them from render,
but they remain in `useHistoryStore.getState().entries`.

**Why:** without tombstones, a server response containing a
just-deleted row would create a fresh entry (no `existing`), insert it
as LIVE, and bypass invariant 2. The tombstone is what makes invariant
2 load-bearing for server responses too.

**Enforced by:** `lib/history/store.ts::markRemoved` — it sets state,
does NOT filter from `entries[]`. Only `hooks.ts::useHistoryEntries`
filters `removed` for render.

### Invariant 4: Default hook filter excludes REMOVED

`useHistoryEntries` returns `entries.filter(e => e.state !== "removed")`
(plus date range filter).

**Enforced by:** `lib/history/hooks.ts`. Override via
`excludeDeleting: true` flag if a surface doesn't want to render the
animation.

### Invariant 5: `deleteEntry` is idempotent

Second call on PENDING-without-server, DELETING, or REMOVED is a no-op
(logged as `deleteEntry.noop`). Safe against double-clicks, React
strict mode, dedup-after-broadcast, overlapping SSE + click.

**Enforced by:** `lib/history/mutations.ts::deleteEntry` — first
conditional after resolving `entry`.

**Tests:** U12, U13.

### Invariant 6: One writer per state-transition

All transitions go through functions in `lib/history/mutations.ts` or
the store helpers `setStateOf/markRemoved/rollbackDeletion` called
*from* `mutations.ts` or `store.ts::applyServerList`.

**Enforced by:** ESLint `no-restricted-imports` in `.eslintrc.json` —
outside `lib/history/` you can only reach the store through the public
API in `index.ts`, which doesn't export `setStateOf`. Inside
`lib/history/` there's override that allows cross-imports, but the
convention (code review + file comments) keeps direct setState usage
limited to the few helpers.

### Invariant 7: Cross-device delete is scoped

`applyServerList` marks LIVE entries as REMOVED only when absent from
the server response AND `offset === 0` AND `createdAt >= oldest(rows)`.

**Why scoped:** on page 2+ (pagination) or for entries older than the
response window, absence doesn't mean "deleted on another device" — it
means "outside this page's time slice." Blanket-removing would drop
valid older rows.

**Enforced by:** `lib/history/store.ts::applyServerList`.

**Tests:** U6 (cross-device delete fires), U7 (pagination skips), U8
(out-of-window preserved).

### Invariant 8: Animation hold doesn't block server commit

`deleteEntry` does `Promise.all([fetch, sleep(ANIMATION_HOLD_MS)])`.
Rollback on failure runs regardless of whether the sleep has elapsed.

**Enforced by:** `lib/history/mutations.ts::deleteEntry`. The
`Promise.all` is important — sequential `await fetch; await sleep`
would make rollback dependent on anim timing.

## Data flows

### Flow A: User generates an image (local)

```
1. user clicks Generate
2. generate-form: addPendingEntry({uuid: historyId, ...})
   → state=pending, confirmed=false
   → rendered in Output strip with spinner
3. generation pipeline runs
   → updateEntry(historyId, {status: "processing"/"completed", outputUrl})
4. saveToServerHistory runs:
   a. createImageVariants → updatePendingEntry(historyId, {thumbUrl, etc.})
   b. uploadHistoryEntry → server returns {serverGenId, serverUrls}
   c. confirmPendingEntry(historyId, {serverGenId, serverUrls})
      → state=live, confirmed=true
5. entry visible on every device via SSE generation.created broadcast
```

### Flow B: Cross-device generation (received)

```
1. SSE generation.created fires with full ServerGeneration row
2. lib/history/sse.ts::listener:
   → applyServerRow(row)
   → existing = entries.find(e => e.id === uuid OR serverGenId === row.id)
   → if existing undefined: insert new HistoryEntry, state=live
3. useHistoryEntries picks up new entry via Zustand subscribe
4. rendered on Output strip (if today) and/or Sidebar (if in range)
5. NO fetch. Zero network for the receiving device.
```

### Flow C: Local delete

```
1. user clicks trash → handleRemove calls deleteEntry(entry.id)
2. mutations.ts::deleteEntry:
   a. find entry, idempotency check, state check
   b. setStateOf(id, "deleting")  ← UI re-renders, fade starts
   c. broadcast.post({type:"delete", id, serverGenId})  ← other tabs
   d. Promise.all([
        fetch DELETE /api/history?id=N,
        sleep(ANIMATION_HOLD_MS),
      ])
   e. on success: markRemoved(id), revokeBlobs
      on failure: rollbackDeletion(id) → state=live, toast.error
3. Other tabs (same browser):
   - broadcast.ts listener → deleteEntry(N, {skipServerDelete:true})
     (same state machine, same anim, no server fetch)
4. Other devices (same username):
   - server broadcasts SSE generation.deleted {id:N}
   - sse.ts listener → deleteEntry(N, {skipServerDelete:true})
5. Originating tab also receives SSE event but deleteEntry is idempotent
   → logged as deleteEntry.noop, no-op
```

### Flow D: Cross-device delete (received)

```
1. SSE generation.deleted fires with {id:N}
2. sse.ts listener:
   → deleteEntry(N, {skipServerDelete:true})
3. mutations.ts::deleteEntry:
   a. find entry by serverGenId
   b. if state ∈ {deleting, removed}: noop (we already did this locally)
   c. if state === "live":
      - setStateOf(id, "deleting")  ← fade starts
      - skip fetch (skipServerDelete)
      - sleep(ANIMATION_HOLD_MS)
      - markRemoved, revokeBlobs
```

### Flow E: Reload

```
1. Page reloads. Zustand store is fresh and empty.
2. lib/history/store.ts top-level: localStorage.removeItem("wavespeed-history")
3. Components mount. useHistoryEntries({username, range}) called.
4. Effect fires → hydrateFromServer({username, range})
   → GET /api/history → applyServerList(rows, {offset:0})
   → each row becomes a live entry via applyServerRow
5. Output strip / Sidebar render. ~150-200ms skeleton window between
   mount and first paint (no persistence).
6. useGenerationEvents mounts → opens SSE → sse.open event fires
   → another hydrateFromServer (dedup'd with the mount-one by
      pendingHydrate)
```

## Test coverage — what is guaranteed

**Unit tests** (Vitest, `lib/history/__tests__/`, 22 tests):

| Block | Covers | Files |
|---|---|---|
| store.test.ts | applyServerRow branches (insert, merge-keeping-blobs, ignore DELETING, ignore REMOVED, PENDING→LIVE confirm) + applyServerList cross-device delete (in-window, pagination-skip, out-of-window preserved) | U1-U8 |
| hydrate.test.ts | Concurrent-call dedup (shared Promise), stale-response discard via activeReqId, 50ms debounce coalescing | U16-U18 |
| mutations.test.ts | deleteEntry on PENDING (no fetch + abort), LIVE happy path, HTTP-500 rollback, idempotency on DELETING, idempotency on REMOVED, deleteEntry(serverGenId:number), skipServerDelete flag | U9-U15 |
| sse.test.ts | generation.created → applyServerRow, generation.deleted → deleteEntry skipServer, open → hydrate, malformed payload doesn't crash | U19-U22 |

Run: `npm test`. All 22 must pass.

**Manual matrix** (16 scenarios, verified 2026-04-13):

M1 local delete, M2 cross-device delete local, M3 sidebar delete sym,
M4 pending delete, **M5 resurrection race (the main one)**, M6
cross-tab via BC, M7 cross-device via SSE, M8 offline rollback, M9
clean debug trace, M10 HMR edge (dev-only), M11 delete during BlurUp,
M12 localStorage cleanup, M13 cross-device create, M14 Output→Sidebar,
M15 Sidebar→Output, M16 animation hold.

Run these manually after any change to `lib/history/` or the consumer
components. Checklist in the plan doc
(`docs/superpowers/plans/2026-04-13-history-sync-mechanism-redesign.md`).

## Extension points — safe ways to change things

### Add a new entry state

If a new lifecycle step appears (e.g. "archived"):

1. Add `"archived"` to `EntryState` in `types.ts`.
2. Decide transitions: what triggers it, what exits it.
3. Decide if invariant 2 should protect it — if archived entries can
   come back to live, add `archived` to the ignore list in
   `applyServerRow`; if not, add to the same guard.
4. Decide if the default hook filter should hide or show it. Update
   `hooks.ts::useHistoryEntries`.
5. Add a `markArchived` helper in `store.ts` (not a public export).
6. Add a public mutation (e.g. `archiveEntry(id)`) in `mutations.ts`
   and to `index.ts`.
7. Add unit tests covering the transitions and invariant interactions.

### Add a new removal trigger (e.g. keyboard shortcut)

Call `deleteEntry(id)` from the shortcut handler. Nothing else. All
state transitions, broadcasting, server sync, idempotency are already
handled.

### Add a new server event type

1. Server-side: `broadcastToUser(username, {type: "generation.updated", data: row})`.
2. `lib/history/sse.ts`: add `es.addEventListener("generation.updated", ...)`.
3. Inside the listener, route to existing functions — likely `applyServerRow(row)`.
4. DO NOT add a new "update" mutation exported to components — keep
   the ingestion path through `applyServerRow` so invariant 2 applies.

### Change the animation hold

`lib/history/mutations.ts::ANIMATION_HOLD_MS`. Currently 200ms. Values
above 500ms feel sluggish; values below 100ms make the fade
indiscernible. Wire more complex animations via
`data-state="deleting"` CSS in `app/globals.css` — selector
`[data-history-card][data-state="deleting"]`.

### Add a new call-site (new component showing history entries)

1. Import from `@/lib/history` only: `useHistoryEntries`, `deleteEntry`,
   `type HistoryEntry`.
2. Pass `username` from `useUser()` and a `range` if you want date filtering.
3. Render entries; filter by additional criteria (status, workflowName,
   etc.) in the component — the hook already filters state and date range.
4. For delete buttons, call `deleteEntry(entry.id)` directly.
5. If you want the fade-out animation, attach
   `data-history-card data-state={entry.state}` to the card root.

### Add a persistence layer (future)

If single-device "remember entries across reload" becomes a priority:

- DO NOT re-add Zustand `persist` middleware — that's what caused
  stale-state-flash on cross-device delete before.
- PREFER a service worker caching `/api/history` responses (see
  `docs/superpowers/specs/2026-04-12-sw-image-cache-future.md`). Image
  bytes already have 1-year HTTP immutable cache.
- If you must persist entries: persist only `state === "live"`,
  explicitly, with a freshness TTL (e.g. drop after 1 hour), and apply
  a post-hydrate reconciliation: on mount, compare persisted entries
  vs `/api/history` response, mark any missing ones as REMOVED (same
  logic as invariant 7, but broader window).

## Pitfalls — things that look wrong but aren't

### 1. Two events for one delete (broadcast + SSE)

When you click delete, console shows:
```
deleteEntry.start
broadcast.send {type:"delete",id,serverGenId}
deleteEntry.commit
... then later ...
broadcast.recv {type:"delete",...}      ← from another tab if open
deleteEntry.start                         ← other tab's processing
deleteEntry.commit.no-server             ← other tab
sse.deleted {id}                         ← this tab receives its own server echo
deleteEntry.noop {state:"removed"}       ← idempotent no-op
```

This is expected. BroadcastChannel delivers to other tabs of this
browser; SSE broadcasts to all devices (including this tab's
connection). Idempotency makes the dupe harmless.

### 2. `deleteEntry.noop` logs during cross-tab delete

Same mechanism as above. It means "I already processed this via an
earlier path; this duplicate event changes nothing."

### 3. Long "click handler took X ms" violations

The `confirm()` dialog is synchronous; `[Violation] 'click' handler
took 800ms` means the user took 800ms to click OK. Not our code.
Fixable only by replacing `confirm()` with a non-blocking modal (out
of scope for this redesign).

### 4. `Unchecked runtime.lastError: The message port closed`

Chrome extensions (react-devtools, metamask, others) chatter. Not our
code.

### 5. `useGenerationEvents` and `useHistoryEntries` both cause hydration

`useGenerationEvents` calls hydrate on SSE `open`. `useHistoryEntries`
calls hydrate on mount + on `username`/`range` change. These can fire
within milliseconds of each other. The `pendingHydrate` Promise
coalesces them to a single fetch.

### 6. Entry shows up in store but not in hook result

Check the default filter — `state === "removed"` is filtered. Check
the date range — new entries created after the hook's `range.to` get
filtered (this was a real bug, fixed in `eb74130` by normalizing
`range.to` to end-of-day in the sidebar). If building a new consumer,
use either (a) no range, or (b) range that normalizes bounds.

### 7. Blob URL still rendering after refresh

Blob URLs (`blob:...`) are revoked on page unload by the browser. After
reload the entry re-hydrates from `/api/history` with server URLs. The
"keeps blob URL during merge" logic in `applyServerRow::mergeKeepingBlobs`
only applies within a session — post-reload, there are no blob URLs
to keep because the entries are inserted fresh.

## Recovery — when X breaks, look at Y

First: enable debug flag in DevTools console:

```js
localStorage.setItem("DEBUG_HISTORY_DELETE", "1");
```

Reproduce. Read console. Trace matches these sequences:

| Healthy trace | Problem trace |
|---|---|
| `deleteEntry.start` → `broadcast.send` → `deleteEntry.commit` | Missing `deleteEntry.commit` → DELETE stuck (Network tab) or rolled back (`deleteEntry.error`) |
| `sse.created` → `applyServerRow.insert` | `applyServerRow.ignored` + the local state is not as expected → inspect `useHistoryStore.getState().entries` |
| `hydrate.ok {count:N}` | `hydrate.error` → Network tab, server down or CORS |
| `broadcast.send` in tab A, `broadcast.recv` in tab B | BroadcastChannel blocked by extension, use incognito to isolate |

### Specific symptoms

**"Card doesn't disappear on delete."**

- Check console for `deleteEntry.start`. If absent, the click handler
  isn't wired (check `handleRemove`/`handleDelete` in the calling
  component).
- If present, check for `deleteEntry.commit` vs `deleteEntry.error`.
  Error → Network tab for DELETE failure.
- If `deleteEntry.start` then silence for > 1s: the fetch is stalled.
  Server side or network.

**"Card reappears after another generation."**

- Look for `applyServerRow.ignored` for the entry's uuid. Expected.
- If the entry was `state=live` at the time (not deleting/removed),
  invariant 2 didn't fire because the state was wrong. Inspect
  `useHistoryStore.getState().entries`.
- Check: did `deleteEntry` actually complete for the first delete?
  Missing `deleteEntry.commit` → the entry was never in `removed`
  state → subsequent hydration legitimately re-inserted it.

**"Cross-tab delete doesn't propagate."**

- `broadcast.send` in sender tab, `broadcast.recv` in receiver tab? If
  sender shows send but receiver shows no recv — BroadcastChannel
  support (extension blocking, private browsing restrictions). Test in
  a clean browser profile.

**"Cross-device delete doesn't propagate."**

- Receiver console: `sse.deleted` event present? If not, SSE connection
  is dead. Check DevTools → Network → EventStream tab for `/api/history/stream`.
  If that tab shows closed connection or heartbeat timeout, the server
  side's `subscribers` Map may have lost the client (HMR in dev).
  Fix in dev: reload. Fix in prod: (shouldn't happen) check server logs.

**"Output strip empty after reload."**

- Network tab for `/api/history?username=...`. 200 with data? Check
  console for `hydrate.ok`.
- 4xx/5xx: server-side issue.
- 200 with empty array: user has no entries (might be username mismatch).
- `hydrate.ok {count:N}` but still empty: check the `range` passed to
  the hook. New entries with `createdAt > range.to` get filtered (see
  pitfall 6).

**"Pending card stuck after upload error."**

- Check for `markPendingError` log. The card should show the error.
  Deleting the card triggers `deleteEntry.pending` which aborts and
  revokes — expected.
- If the card won't delete, check `deleteEntry.noop` — maybe already
  removed.

### Running full regression

```bash
npm test                 # 22 unit tests, must all pass
npm run build            # Next production build, must succeed
npm run lint             # no new errors
npm run dev              # start dev server
```

Then: manual matrix M1-M16 from
`docs/superpowers/plans/2026-04-13-history-sync-mechanism-redesign.md`.
M5 (resurrection) is the primary regression canary — if it passes,
invariant 2 is intact.

## Rollback — nuclear option

If something catastrophic happens and the redesign needs to be
reverted:

```bash
# Find the last commit before the redesign:
git log --oneline | grep "history-sync"

# The commit immediately BEFORE 5a7fc51 (chore(test): add Vitest + RTL infrastructure)
# is 2adfb61 (the spec-only commit from the night before the rewrite).

# Reset to pre-redesign state:
git reset --hard 2adfb61

# Re-run the old mechanism's build:
rm -rf node_modules/.cache .next
npm install
npm run build
```

This reverts 20+ commits. You'll have the old three-stores mechanism
back, with all its known issues (resurrection race, etc.). Do this
only if a regression fundamentally breaks user-facing functionality
and there's no faster fix.

**Preferred:** revert a specific commit if a single step introduced a
regression. `git log --oneline 2adfb61..HEAD` shows the full sequence.
Most commits are independently revertable because the module was built
incrementally.

## Open follow-ups

Things intentionally left for later. None block normal operation.

1. **Replace `confirm()` modal with a non-blocking dialog.** The
   blocking `confirm()` causes "click handler took N ms" violation
   logs and blocks the UI. A Radix-style AlertDialog would fix both.
   Not in scope for the sync redesign. File: `components/output-area.tsx`,
   `components/history-sidebar.tsx`.

2. **Service Worker cache for `/api/history` JSON.** Eliminates the
   150-200ms skeleton flash on reload. Spec already exists:
   `docs/superpowers/specs/2026-04-12-sw-image-cache-future.md`.
   Would also enable offline browsing of recent history.

3. **Unit tests for the new fade-out animation.** CSS-level behavior
   isn't currently covered. Could add a Playwright test that verifies
   `data-state="deleting"` yields `opacity: 0` after animation hold.

4. **Dev-only HMR fragility in SSE.** The server-side `subscribers`
   Map dies on HMR. Client reconnects but server forgot it. Adding
   a heartbeat-pong health check would let the server prune dead
   controllers and the client force-reconnect. Out of scope; prod
   has no HMR.

5. **Pagination integration with cross-device delete.** Currently
   cross-device delete (invariant 7) only fires for offset=0. If a
   user scrolls to page 3 and an entry on page 1 is deleted on another
   device, the removal propagates on the next offset=0 hydration
   (e.g. SSE reconnect). Acceptable MVP behavior; if latency matters,
   hydrate all loaded pages, not just the first.

6. **Formal mid-transition verification.** No test currently asserts
   "if DELETE is in flight and a hydration arrives with the row still
   present, the entry stays in `deleting`." Unit test U3/U4 cover the
   single-apply case; an integration-style test for the race would be
   nice.

## Commit inventory

Full sequence from the redesign, in order:

| Commit | Subject |
|---|---|
| `5a7fc51` | chore(test): add Vitest + RTL infrastructure |
| `e67146e` | feat(history): scaffold lib/history — types, debug, pending controls |
| `340d5d0` | feat(history): store + applyServerRow/applyServerList with invariants 2 & 7 |
| `8e47025` | feat(history): hydrate.ts with race-guard, dedup, and 50ms debounce |
| `536890a` | feat(history): mutations.ts — deleteEntry single-path + pending lifecycle |
| `8143602` | feat(history): broadcast.ts — cross-tab via BroadcastChannel |
| (T8 commit) | feat(history): sse.ts — thin event translator + useGenerationEvents |
| `2c74909` | feat(history): hooks.ts — useHistoryEntries + useEntryById |
| `4cc2d50` | feat(history): public index.ts — single import surface |
| `d0cc8d2` | refactor(history): migrate generate-form to @/lib/history |
| `f299aa4` | refactor(output-area): migrate to useHistoryEntries + deleteEntry |
| `2b55da7` | refactor(history-sidebar): migrate to useHistoryEntries + deleteEntry |
| (T15 commit) | refactor(history): delete eight superseded modules; migration complete |
| `8267c79` | chore(history): localStorage cleanup + ESLint deep-import guard |
| `885ec54` | docs(history): module README + operator's manual |
| `eb74130` | fix(history-sidebar): normalize date range to whole-day boundaries |
| `0057eb5` | chore(history): ANIMATION_HOLD_MS=200 + fix U20 test for the hold |
| `2f0e02f` | feat(history): deletion fade-out animation |

Each commit is self-contained and tested. Reverting any single commit
should leave the tree in a build-green state, with one exception:
`5a7fc51` through the first module-building commits must stay in
order (they depend on each other).

## References

- Design spec: `docs/superpowers/specs/2026-04-13-history-sync-mechanism-redesign-design.md`
- Implementation plan: `docs/superpowers/plans/2026-04-13-history-sync-mechanism-redesign.md`
- Module README + operator's manual: `lib/history/README.md`
- Prior brief (problem statement): `docs/superpowers/specs/2026-04-12-history-sync-mechanism-redesign.md`
- Pretty-image-loading (sibling feature, unchanged): `docs/superpowers/specs/2026-04-12-pretty-image-loading-design.md`
- Future: Service Worker cache: `docs/superpowers/specs/2026-04-12-sw-image-cache-future.md`

## Contact surface

If editing this module:

1. Read this doc end-to-end.
2. Read `lib/history/README.md` for the one-page model.
3. Look at the invariant you might touch — it names the exact file and
   lines.
4. Run `npm test` before AND after. All 22 must pass.
5. Run `npm run build`.
6. Run M5 manually (resurrection canary).
7. If changing `applyServerRow` guard, pause. Read invariants 2 and 3
   again. Ask: "Can this change allow a DELETING/REMOVED entry to
   become LIVE?" If yes, don't ship.
