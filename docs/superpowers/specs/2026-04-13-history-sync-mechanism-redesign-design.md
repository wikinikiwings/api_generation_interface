# History Sync Mechanism — Redesign

**Date:** 2026-04-13
**Status:** Approved for implementation planning
**Supersedes (in spirit):** `2026-04-12-history-sync-mechanism-redesign.md` — that document is the brief for this work; this document is the validated design.
**Also supersedes:** `2026-04-12-history-delete-sync-cleanup.md` (the earlier patch-in-place proposal).

## Problem

History — how an image entry flows from generation → local state → server → cross-tab/cross-device sync → deletion → refresh — has accreted three concurrent stores (`useHistoryStore`, `pendingHistory`, `useDeletionsStore`), four refresh triggers (`HISTORY_REFRESH_EVENT`, `broadcastHistoryRefresh`, BroadcastChannel, SSE reconnect), and four removal paths (Output `handleRemove`, Sidebar `handleDelete`, SSE `generation.deleted`, `removePending`).

Each layer works individually. Together they produce four classes of bug the user repeatedly hits:

1. **Resurrection.** Delete X, generate Y, refetch arrives during DELETE in-flight, X re-surfaces.
2. **Inability to delete.** SSE-dependent UI cleanup fails when SSE subscribers map dies (HMR), card hangs.
3. **Asymmetric behavior.** Output and Sidebar have separate handlers — surfaces drift.
4. **Slow delete.** Multi-step optimistic chain (`mark → remove → broadcast → refetch`) feels heavy.

The visible severity of (1) increased after the BlurUpImage curtain-reveal shipped on 2026-04-12: the resurrected entry now plays a 700ms animation instead of disappearing in a 150ms baseline-JPEG flash.

This is **not a bug fix.** It is a green-field rewrite of the mechanism with three non-negotiable properties (per the brief):

1. **Single source of truth per concern.**
2. **Documented mental model** — a new engineer or LLM reading cold can answer "where does an entry live, what removes it, what refreshes it" from one document.
3. **Restorable from the doc alone.** State diagram, exact types, lifecycle, test matrix all live here.

Plus: **animation-ready** (room for a fade-out on delete without state-machine rework).

## Goals

- Replace three stores with one Zustand store keyed by a unified `HistoryEntry` carrying a `state: "pending" | "live" | "deleting" | "removed"` field.
- Consolidate four removal paths into one `deleteEntry(id)` function.
- Remove all public refresh triggers (`broadcastHistoryRefresh`, `HISTORY_REFRESH_EVENT`); refresh becomes implicit through state transitions and SSE.
- Make resurrection architecturally impossible (invariant-enforced, not handler-vigilance-enforced).
- Make UI hide synchronous (≤ 16ms from click to first frame without the entry).
- Make cross-device delete symmetric and automatic across Output strip, History sidebar, all tabs, all devices logged in as the same `username`.
- Preserve the `BlurUpImage` curtain-reveal behavior unchanged.

## Non-goals

- No server-side changes. `/api/history` GET/POST/DELETE, `/api/history/stream` SSE, `lib/sse-broadcast.ts`, `app/api/history/image/[filename]/route.ts` — untouched.
- No changes to `lib/image-variants.ts`, `lib/history-upload.ts`, `lib/image-cache.ts`, `components/blur-up-image.tsx`.
- No multi-device conflict resolution beyond last-writer-wins (delete beats insert; recreated-after-delete gets a new server id).
- No localStorage persistence of the new store. Server is the only source of truth; HTTP cache (already 1-year immutable on `/api/history/image/*`) handles image bytes; `/api/history` JSON is small (~kilobytes for "today") and fast.
- No backwards compat with old call-sites — green-field rewrite, all call-sites migrate.
- No multi-process SSE backplane (Redis pub/sub, etc.) — single-process broadcast as today.

## Key Design Decisions

1. **One module: `lib/history/`.** All history state, mutations, hydration, SSE, BroadcastChannel, debug live here. Only `lib/history/index.ts` is publicly importable.
2. **Unified `HistoryEntry` with `state` field.** Replaces three stores. State enum: `"pending" | "live" | "deleting" | "removed"`.
3. **Server hydrates INTO the store.** No separate `items` state in the consumer hook. `applyServerList(rows)` and `applyServerRow(row)` are the single ingestion path.
4. **REMOVED is a tombstone.** Entries marked removed stay in the store (≈200 bytes each) so future hydrations can't resurrect them. Memory: 10 000 deletions ≈ 2 MB, acceptable.
5. **`deleteEntry` is the single removal path.** Output, Sidebar, SSE, BroadcastChannel, future keyboard-shortcut all call it. Idempotent. Optimistic synchronous transition + async DELETE + rollback on failure.
6. **DELETING state with `animationHoldMs` hook.** Default 0 in MVP; bumping to 200ms enables a fade-out without touching the state machine.
7. **No persistence.** `lib/history/store.ts` is pure runtime. After reload, `/api/history` (warm: ~80–200ms) repopulates. Output strip shows skeleton tiles in the gap. Old `wavespeed-history` localStorage key is one-time cleared on first mount.
8. **Cross-tab via BroadcastChannel; cross-device via SSE.** Both feed the same `deleteEntry` / `applyServerRow` paths. Idempotency makes overlap safe.
9. **SSE patches in-place.** `generation.created.data` already contains the full row; `generation.deleted.data` carries `{id}`. Neither triggers a refetch in normal operation. Only SSE `open` (initial connect + each reconnect) calls `hydrateFromServer` to reconcile missed events.
10. **No public refresh API surfaced in UI.** No "Refresh" button. Programmatic `refetch()` exposed on the hook for tests and internal use only. Project-wide UX principle: sync is invisible.

## Architecture

### Module tree

```
lib/history/
  types.ts          — HistoryEntry, EntryState, ServerGeneration (re-export), DateRange
  store.ts          — Zustand store + applyServerRow + applyServerList + state helpers
  pending.ts        — singleton for in-flight upload controls (retry/abort callbacks)
  mutations.ts      — public deleteEntry, addPendingEntry, confirmPendingEntry, etc.
  hydrate.ts        — internal fetch /api/history → applyServerList; debounce; reqId race-guard
  sse.ts            — EventSource → applyServerRow / deleteEntry; useGenerationEvents hook
  broadcast.ts      — BroadcastChannel cross-tab
  debug.ts          — debugHistory("event", payload) gated by localStorage flag
  hooks.ts          — useHistoryEntries, useEntryById
  index.ts          — public re-export surface
  README.md         — one-page mental model + state diagram + three editing entry points
```

**Import boundary:** components import only from `@/lib/history`. ESLint `no-restricted-imports` blocks deep imports of `@/lib/history/store`, `/mutations`, `/hydrate`, `/sse`, `/broadcast`, `/pending`.

### Files removed in this rewrite

- `hooks/use-history.ts`
- `hooks/use-generation-events.ts`
- `lib/pending-history.ts`
- `lib/history-deletions.ts`
- `lib/history-debug.ts`
- `stores/history-store.ts`

The exports `broadcastHistoryRefresh`, `HISTORY_REFRESH_EVENT`, `markGenerationDeleted`, `useDeletedIds`, `getDeletedIds`, `useHistoryStore` no longer exist.

### Types

```ts
// lib/history/types.ts

export type EntryState = "pending" | "live" | "deleting" | "removed";

export interface HistoryEntry {
  /** Stable canonical id. Server rows: extractUuid(filepath) ?? `server-${serverGenId}`.
   *  Locally created: uuid from generate-form. */
  id: string;

  /** Link to server row. Undefined until confirmPendingEntry. */
  serverGenId?: number;

  /** Source of truth for filtering, rendering, and removal eligibility. */
  state: EntryState;

  /** Generation metadata. Identical fields to current HistoryEntry. */
  prompt: string;
  provider: string;
  workflowName?: string;
  createdAt: number;          // ms epoch
  status: TaskStatus;
  error: string | null;

  /** Image URLs. May be blob: (PENDING/LIVE-this-tab) or /api/history/image/...
   *  (server-backed). All three may be missing while generation in progress. */
  originalUrl?: string;
  outputUrl?: string;
  previewUrl?: string;
  thumbUrl?: string;

  /** Blob URLs owned by this entry; revoked on REMOVED. */
  localBlobUrls?: string[];

  /** True after POST /api/history. False on freshly-created PENDING.
   *  Forbidden combinations: state="live"|"deleting"|"removed" + confirmed=false. */
  confirmed: boolean;
}

export interface DateRange {
  from?: Date;
  to?: Date;
}
```

In-flight upload controls (`retry`, `abort` callbacks) live in `lib/history/pending.ts` as a separate `Map<uuid, { retry?, abort? }>` — they aren't serializable, aren't cross-tab data, and don't belong on the data record.

### State machine

```
                  addPendingEntry(uuid, blobs)
                              │
                              ▼
                       ┌─────────────┐
                       │   PENDING   │  state=pending, confirmed=false
                       │  blob URLs  │  rendered: yes (skeleton/in-progress)
                       └──────┬──────┘
                              │
                              │ confirmPendingEntry(uuid, serverGenId, serverUrls)
                              ▼
                       ┌─────────────┐
                       │    LIVE     │  state=live, confirmed=true, serverGenId set
                       │  server URLs│  rendered: yes (normal)
                       └──────┬──────┘
                              │
                              │ deleteEntry(id)  ──┐
                              │                   │ rollbackDeletion(id)  (DELETE failed)
                              ▼                   │
                       ┌─────────────┐            │
                       │  DELETING   │ ───────────┘
                       │ animation OK│  rendered: optional (animation hook)
                       └──────┬──────┘  filtered from logical "items" lists
                              │
                              │ commitDeletion(id)
                              │ (DELETE succeeded + animationHoldMs elapsed)
                              ▼
                       ┌─────────────┐
                       │   REMOVED   │  rendered: never; revoke blob URLs;
                       │ tombstone   │  entry kept in store as tombstone
                       └─────────────┘
```

Additional path: PENDING → REMOVED directly via `deleteEntry`, when user removes an entry before its POST /api/history completes. No server DELETE; `pending.getControls(uuid).abort?.()` cancels the upload.

### Invariants

These are enforceable in code (one place each) and tested:

1. **State is monotone toward "deleted":** PENDING/LIVE → DELETING → REMOVED. Reverse only via `rollbackDeletion(id)` after a failed DELETE.
2. **Server input does not resurrect:** `applyServerRow(row)` and `applyServerList(rows)` MUST NOT change the state of an existing entry that is in DELETING or REMOVED. Single guard at the top of `applyServerRow`. *This is the architectural fix for the resurrection race.*
3. **REMOVED is a tombstone**, not a deletion from the store. `entries[]` keeps removed records forever within session.
4. **Default hook filter:** `useHistoryEntries` returns only `state ∈ {pending, live, deleting}`. REMOVED never reaches render.
5. **`deleteEntry` is idempotent.** Second call on PENDING-without-server / DELETING / REMOVED is no-op.
6. **One writer per state-transition:** all transitions go through functions in `lib/history/mutations.ts`. Direct `useStore.setState` is forbidden outside the store file. ESLint + review.
7. **`applyServerList` does not delete implicitly except in narrowly-scoped cross-device-delete logic.** Specifically: a LIVE entry with `serverGenId` absent from the server response is marked REMOVED only if (a) `offset === 0` (first page only) and (b) `entry.createdAt >= min(rows.map(r => r.created_at))` (entry is within the response window). Pending entries (no serverGenId) are never touched.
8. **Animation hold does not block server commit:** `commitDeletion` waits for `Promise.all([deleteFetch, sleep(animationHoldMs)])`. Failure path triggers `rollbackDeletion` regardless of animation state.

### Public API

`lib/history/index.ts`:

```ts
// === HOOKS ===

export function useHistoryEntries(opts?: {
  username: string | null;
  range?: DateRange;
  excludeDeleting?: boolean;     // default false — DELETING rendered for animation
}): {
  entries: HistoryEntry[];        // newest first
  isLoading: boolean;             // true only during first hydration
  isLoadingMore: boolean;
  hasMore: boolean;
  loadMore: () => void;
  error: string | null;
  refetch: () => void;            // programmatic escape-hatch (tests, SSE-internal)
};

export function useEntryById(id: string): HistoryEntry | undefined;

export function useGenerationEvents(username: string | null): void;

// === MUTATIONS ===

export async function deleteEntry(
  idOrServerGenId: string | number,
  opts?: { skipServerDelete?: boolean }
): Promise<void>;

/** Input for a freshly-generated, not-yet-server-confirmed entry.
 *  Mirrors the existing PendingGeneration creation in generate-form.tsx
 *  minus the `pending: true` discriminator. */
export interface NewPendingInput {
  uuid: string;                        // becomes HistoryEntry.id
  prompt: string;
  provider: string;
  workflowName?: string;
  createdAt: number;
  thumbUrl?: string;
  previewUrl?: string;
  originalUrl?: string;
  outputUrl?: string;
  localBlobUrls?: string[];
}
export function addPendingEntry(entry: NewPendingInput): void;

export function updatePendingEntry(
  uuid: string,
  patch: Partial<Pick<HistoryEntry,
    "thumbUrl" | "previewUrl" | "originalUrl" | "outputUrl" | "localBlobUrls"
  >>
): void;

export function confirmPendingEntry(
  uuid: string,
  payload: {
    serverGenId: number;
    serverUrls: { thumb?: string; mid?: string; full?: string };
  }
): void;

export function markPendingError(uuid: string, message: string): void;

export function setPendingControls(
  uuid: string,
  controls: { retry?: () => void; abort?: () => void }
): void;
export function getPendingControls(uuid: string):
  { retry?: () => void; abort?: () => void } | undefined;

// === TYPES (re-export) ===

export type { HistoryEntry, EntryState, ServerGeneration, DateRange } from "./types";
```

Nothing else is publicly exported. `useHistoryStore`, `applyServerRow`, `applyServerList`, `hydrateFromServer`, the BroadcastChannel instance, and the pending singleton are all module-private.

### Internals — hydration

`lib/history/hydrate.ts`:

```ts
let activeReqId = 0;
let pendingHydrate: Promise<void> | null = null;
let debounceTimer: ReturnType<typeof setTimeout> | null = null;
const HYDRATE_DEBOUNCE_MS = 50;

export function hydrateFromServer(opts: HydrateOpts): Promise<void> {
  if (debounceTimer) clearTimeout(debounceTimer);
  if (pendingHydrate) return pendingHydrate;

  pendingHydrate = new Promise((resolve) => {
    debounceTimer = setTimeout(async () => {
      const myReq = ++activeReqId;
      try {
        const url = buildUrl(opts);
        const res = await fetch(url, { cache: "no-store" });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const rows = (await res.json()) as ServerGeneration[];
        if (myReq !== activeReqId) return;     // newer request already in flight
        applyServerList(rows, opts);
        debugHistory("hydrate.ok", { count: rows.length, reqId: myReq });
      } catch (e) {
        if (myReq !== activeReqId) return;
        useHistoryStore.setState({ error: String(e) });
        debugHistory("hydrate.error", { message: String(e) });
      } finally {
        pendingHydrate = null;
        debounceTimer = null;
        resolve();
      }
    }, HYDRATE_DEBOUNCE_MS);
  });
  return pendingHydrate;
}
```

`lib/history/store.ts::applyServerRow(row)` — **the single decision point for "accept a server row"**:

```ts
function applyServerRow(row: ServerGeneration): void {
  const uuid = extractUuid(row.outputs[0]?.filepath ?? "") ?? `server-${row.id}`;
  const existing = useHistoryStore.getState().entries.find(
    (e) => e.id === uuid || e.serverGenId === row.id
  );

  // Invariant 2: server input cannot resurrect DELETING/REMOVED.
  if (existing && (existing.state === "deleting" || existing.state === "removed")) {
    debugHistory("applyServerRow.ignored", {
      uuid, serverGenId: row.id, localState: existing.state,
    });
    return;
  }

  const fromServer = serverGenToEntry(row, uuid);

  if (!existing) {
    useHistoryStore.setState((s) => ({ entries: [fromServer, ...s.entries] }));
    debugHistory("applyServerRow.insert", { id: uuid, serverGenId: row.id });
    return;
  }

  if (existing.state === "pending") {
    // PENDING → LIVE on server confirmation. Keep this tab's blob URLs
    // (they're already in memory and render instantly); server URLs swap
    // in via confirmPendingEntry's later patch when the explicit
    // generate-form path runs. Avoid forcing a re-decode here.
    useHistoryStore.setState((s) => ({
      entries: s.entries.map((e) =>
        e.id === uuid
          ? { ...e, serverGenId: row.id, state: "live", confirmed: true,
              createdAt: Date.parse(row.created_at),
              workflowName: fromServer.workflowName, prompt: fromServer.prompt }
          : e
      ),
    }));
    debugHistory("applyServerRow.confirm", { id: uuid, serverGenId: row.id });
    return;
  }

  // existing.state === "live" — merge metadata, keep local blob URLs.
  useHistoryStore.setState((s) => ({
    entries: s.entries.map((e) => (e.id === uuid ? mergeKeepingBlobs(e, fromServer) : e)),
  }));
}
```

`mergeKeepingBlobs(local, server)` returns `{...server, ...localBlobOverrides}` where `localBlobOverrides` includes only the URL fields where `local` has a `blob:` URL. This is the rule: blob URLs in the current tab always beat server URLs, because blob URLs render from memory with zero network and zero re-decode.

`applyServerList(rows, opts)` — runs `applyServerRow` for each row; then handles cross-device delete via invariant 7:

```ts
function applyServerList(rows: ServerGeneration[], opts: HydrateOpts): void {
  const incomingByGenId = new Map(rows.map((r) => [r.id, r]));
  for (const row of rows) applyServerRow(row);

  if (rows.length === 0) return;
  if (opts.offset && opts.offset > 0) return;        // pagination — skip

  const oldest = Math.min(...rows.map((r) => Date.parse(r.created_at)));
  const state = useHistoryStore.getState();
  const toRemove: string[] = [];
  for (const e of state.entries) {
    if (e.state !== "live") continue;
    if (typeof e.serverGenId !== "number") continue;
    if (incomingByGenId.has(e.serverGenId)) continue;
    if (e.createdAt < oldest) continue;              // outside window
    toRemove.push(e.id);
    debugHistory("hydrate.cross-device-delete", {
      id: e.id, serverGenId: e.serverGenId,
    });
  }
  for (const id of toRemove) markRemoved(id);
}
```

**Hydration triggers** (the only ones; hardcoded inside `lib/history/`):

1. `useHistoryEntries` mount, and on `username`/`range` change.
2. SSE `open` event (`lib/history/sse.ts`).
3. BroadcastChannel `{type: "rehydrate"}` (escape-hatch; not used in MVP).
4. Programmatic `refetch()` from a consumer (tests).

**Hydration is NOT triggered by:**

- SSE `generation.created` / `generation.deleted` — patched in place.
- `deleteEntry` success or failure — state-machine is authoritative.
- `confirmPendingEntry` — patched in place by generate-form.

### Internals — `deleteEntry`

`lib/history/mutations.ts`:

```ts
const ANIMATION_HOLD_MS = 0;  // MVP. Bump to 200 to enable fade-out.

export async function deleteEntry(
  idOrServerGenId: string | number,
  opts?: { skipServerDelete?: boolean }
): Promise<void> {
  const entry = findEntry(idOrServerGenId);
  if (!entry) return;

  // Idempotent.
  if (entry.state === "deleting" || entry.state === "removed") {
    debugHistory("deleteEntry.noop", { id: entry.id, state: entry.state });
    return;
  }

  // PENDING — never reached the server.
  if (entry.state === "pending") {
    debugHistory("deleteEntry.pending", { id: entry.id });
    pending.getControls(entry.id)?.abort?.();
    markRemoved(entry.id);
    revokeBlobs(entry.localBlobUrls);
    broadcast.post({ type: "delete", id: entry.id });
    return;
  }

  // LIVE — synchronous optimistic transition + async DELETE.
  setState(entry.id, "deleting");
  debugHistory("deleteEntry.start", { id: entry.id, serverGenId: entry.serverGenId });
  broadcast.post({ type: "delete", id: entry.id, serverGenId: entry.serverGenId });

  if (typeof entry.serverGenId !== "number") {
    markRemoved(entry.id);
    debugHistory("deleteEntry.no-server-id", { id: entry.id });
    return;
  }

  if (opts?.skipServerDelete) {
    // Came from SSE generation.deleted or BroadcastChannel — server already knows.
    if (ANIMATION_HOLD_MS > 0) await sleep(ANIMATION_HOLD_MS);
    markRemoved(entry.id);
    revokeBlobs(entry.localBlobUrls);
    debugHistory("deleteEntry.commit.no-server", { id: entry.id });
    return;
  }

  const username = getCurrentUsername();
  if (!username) {
    rollbackDeletion(entry.id);
    debugHistory("deleteEntry.no-username", { id: entry.id });
    return;
  }

  const url = `/api/history?id=${entry.serverGenId}&username=${encodeURIComponent(username)}`;
  try {
    const [deleteRes] = await Promise.all([
      fetch(url, { method: "DELETE" }),
      ANIMATION_HOLD_MS > 0 ? sleep(ANIMATION_HOLD_MS) : Promise.resolve(),
    ]);
    if (!deleteRes.ok) throw new Error(`HTTP ${deleteRes.status}`);
    markRemoved(entry.id);
    revokeBlobs(entry.localBlobUrls);
    debugHistory("deleteEntry.commit", { id: entry.id, serverGenId: entry.serverGenId });
  } catch (e) {
    rollbackDeletion(entry.id);
    debugHistory("deleteEntry.error", {
      id: entry.id, serverGenId: entry.serverGenId, message: String(e),
    });
    toast.error(e instanceof Error ? e.message : "Не удалось удалить");
  }
}
```

State-helpers in `lib/history/store.ts` (private):

```ts
function setState(id: string, next: EntryState): void {
  useHistoryStore.setState((s) => ({
    entries: s.entries.map((e) => (e.id === id ? { ...e, state: next } : e)),
  }));
}
function markRemoved(id: string): void { setState(id, "removed"); }
function rollbackDeletion(id: string): void { setState(id, "live"); }
```

### Internals — SSE

`lib/history/sse.ts`:

```ts
let es: EventSource | null = null;
let currentUsername: string | null = null;

export function useGenerationEvents(username: string | null): void {
  React.useEffect(() => {
    if (!username) return;
    if (typeof window === "undefined" || typeof EventSource === "undefined") return;
    open(username);
    return () => close();
  }, [username]);
}

function open(username: string): void {
  if (es && currentUsername === username) return;
  close();
  currentUsername = username;
  es = new EventSource(`/api/history/stream?username=${encodeURIComponent(username)}`);

  es.addEventListener("generation.created", (ev) => {
    try {
      const row = JSON.parse((ev as MessageEvent).data) as ServerGeneration;
      debugHistory("sse.created", { id: row.id });
      applyServerRow(row);
    } catch (err) {
      debugHistory("sse.created.parse-error", { error: String(err) });
    }
  });

  es.addEventListener("generation.deleted", (ev) => {
    try {
      const { id } = JSON.parse((ev as MessageEvent).data) as { id: number };
      debugHistory("sse.deleted", { id });
      void deleteEntry(id, { skipServerDelete: true });
    } catch (err) {
      debugHistory("sse.deleted.parse-error", { error: String(err) });
    }
  });

  es.addEventListener("open", () => {
    debugHistory("sse.open");
    void hydrateFromServer({ username, range: undefined });
  });

  es.addEventListener("error", () => {
    debugHistory("sse.error", { readyState: es?.readyState });
  });
}

function close(): void {
  es?.close();
  es = null;
  currentUsername = null;
}
```

`useGenerationEvents(username)` is mounted **once** in the root layout — not per-consumer. Multiple mounts would open N EventSources for one user.

The `currentUsername` module variable doubles as the source for `getCurrentUsername()` used by `deleteEntry` (called from non-React contexts: SSE handlers, BroadcastChannel listeners, programmatic mutation calls). The mount-once contract guarantees it's set before any user-action delete can happen. If `currentUsername === null` when `deleteEntry` runs in LIVE+server-id branch, the function rolls back the transition and logs `deleteEntry.no-username` — defensive, but should never fire in practice.

### Internals — BroadcastChannel

`lib/history/broadcast.ts`:

```ts
type BroadcastMessage =
  | { type: "delete"; id: string; serverGenId?: number }
  | { type: "rehydrate" };

const channel: BroadcastChannel | null =
  typeof window !== "undefined" && "BroadcastChannel" in window
    ? new BroadcastChannel("wavespeed:history")
    : null;

if (channel) {
  channel.addEventListener("message", (ev: MessageEvent<BroadcastMessage>) => {
    const msg = ev.data;
    debugHistory("broadcast.recv", msg);
    switch (msg.type) {
      case "delete":
        void deleteEntry(msg.serverGenId ?? msg.id, { skipServerDelete: true });
        break;
      case "rehydrate":
        void hydrateFromServer({ username: getCurrentUsername(), range: undefined });
        break;
    }
  });
}

export const broadcast = {
  post(msg: BroadcastMessage): void {
    if (!channel) return;
    channel.postMessage(msg);
    debugHistory("broadcast.send", msg);
  },
};
```

BroadcastChannel does not echo to the sender, so no self-loop. SSE and BroadcastChannel partially overlap (two tabs on the same PC receive both for the originating tab's action) — idempotency makes this safe.

| Channel | Between | Latency |
|---|---|---|
| `BroadcastChannel` | Tabs of the same browser | ~1 ms |
| `SSE` | All devices/browsers for the same `username` | ~50–200 ms |

### Backwards compatibility with existing data

1. **Server data (`generations` table) — zero migration.** Server returns the same `ServerGeneration` shape; new `applyServerList` consumes it directly. Legacy rows (no uuid filenames, no thumb variants) handled the same as today via `extractUuid`-fallback to `server-${id}` and `thumbUrlForEntry` fallback.
2. **localStorage (`wavespeed-history` v3)** — not read. One-time `localStorage.removeItem("wavespeed-history")` in store init. No data loss: persisted entries duplicate server rows that arrive in the first GET.
3. **Conversion `ServerGeneration → HistoryEntry`** — single function `serverGenToEntry(row, uuid)` in `store.ts`. Robust to malformed `prompt_data` (try/catch → `prompt: ""`).
4. **In-flight uploads at deploy moment** — same loss profile as today (blob URLs don't survive reload). Server uploads are idempotent.
5. **Active SSE connections at deploy** — close with the old process; new SSE auto-reconnects on mount, `open` event triggers `hydrateFromServer` to reconcile any deploy-window events.
6. **Mixed-version tab/device during rolling deploy** — server API and SSE payloads unchanged, both versions see the same data. New BroadcastChannel message format is ignored by old code (no listener for `{type:"delete"}` — old code used a tickle-only message). Old format is ignored by new code (no `{type:"refresh"}` listener). One reload-cycle of incompatibility, then converged.

## Implementation plan

Twelve commits in one PR, in order. No backwards-compat shims; old and new code do not coexist in the tree.

1. `feat(history): scaffold lib/history module` — create all new files with the full implementation. Old files untouched. Build green (new code is unreferenced).
2. `refactor(history): migrate generate-form to lib/history` — `pendingHistory.*` → `addPendingEntry/updatePendingEntry/confirmPendingEntry/markPendingError`. 1-to-1 logic.
3. `refactor(history): migrate output-area to useHistoryEntries + deleteEntry` — `useHistory(...)` → `useHistoryEntries({username, range: today})`. `handleRemove` collapses into `deleteEntry(entry.id)`. Drop imports of `markGenerationDeleted`, `broadcastHistoryRefresh`, `useHistoryStore`, `useDeletedIds`.
4. `refactor(history): migrate history-sidebar to useHistoryEntries + deleteEntry` — same pattern.
5. `refactor(history): mount useGenerationEvents from lib/history` — repoint SSE-hook import.
6. `refactor(history): migrate remaining consumers` — `grep -rn "from \"@/hooks/use-history\"\\|@/lib/pending-history\\|@/lib/history-deletions\\|@/lib/history-debug\\|@/stores/history-store\\|@/hooks/use-generation-events"`. Repoint each.
7. `refactor(history): delete old modules` — remove the six superseded files. Build still green.
8. `feat(history): one-time localStorage cleanup` — `localStorage.removeItem("wavespeed-history")` on first store mount.
9. `feat(history): ESLint rule against deep imports into lib/history` — `no-restricted-imports` blocks `@/lib/history/{store,mutations,hydrate,sse,broadcast,pending}`.
10. `docs(history): README + state diagram + operator's manual` — `lib/history/README.md`. Operator's manual ("when X breaks, check Y") inline. Link to this spec.
11. `chore(history): delete superseded spec` — remove `2026-04-12-history-delete-sync-cleanup.md`.
12. `test(history): unit tests` — Vitest tests for `applyServerRow`, `deleteEntry` idempotency, hydration race-guard, cross-device delete logic.

Estimated diff: −350 / +500 lines.

## Test matrix

### Unit tests (Vitest)

`lib/history/__tests__/store.test.ts`:

| # | Scenario | Pass criteria |
|---|---|---|
| U1 | `applyServerRow` for new row | Inserted with `state="live"` |
| U2 | `applyServerRow` for existing LIVE | Metadata merged, blob URLs preserved |
| U3 | `applyServerRow` for existing DELETING | No-op, `applyServerRow.ignored` log |
| U4 | `applyServerRow` for existing REMOVED | No-op |
| U5 | `applyServerRow` for existing PENDING | PENDING → LIVE, `confirmed=true`, `serverGenId` set |
| U6 | `applyServerList` cross-device delete | LIVE entry with `serverGenId` absent from response → REMOVED |
| U7 | `applyServerList` with pagination (`offset > 0`) | Cross-device-delete logic skipped |
| U8 | `applyServerList` outside response window | Entry with `createdAt < oldest(rows)` not touched |

`lib/history/__tests__/mutations.test.ts`:

| # | Scenario | Pass criteria |
|---|---|---|
| U9 | `deleteEntry` on PENDING | Direct REMOVED, no fetch, `abort` called |
| U10 | `deleteEntry` on LIVE happy path | LIVE → DELETING → REMOVED, fetch DELETE with correct URL |
| U11 | `deleteEntry` on LIVE with HTTP 500 | LIVE → DELETING → LIVE (rollback), `toast.error` called |
| U12 | `deleteEntry` idempotency on DELETING | No-op on second call |
| U13 | `deleteEntry` idempotency on REMOVED | No-op |
| U14 | `deleteEntry(serverGenId: number)` | Resolves entry by serverGenId, not local id |
| U15 | `deleteEntry({skipServerDelete:true})` | State transitions occur, no fetch |

`lib/history/__tests__/hydrate.test.ts`:

| # | Scenario | Pass criteria |
|---|---|---|
| U16 | `hydrateFromServer` concurrent dedup | Two parallel calls share one Promise; one fetch |
| U17 | `hydrateFromServer` race-guard | Stale response not applied if newer request fired |
| U18 | `hydrateFromServer` debounce | 5 rapid calls → one fetch after 50 ms |

`lib/history/__tests__/sse.test.ts` (with mocked `EventSource`):

| # | Scenario | Pass criteria |
|---|---|---|
| U19 | `generation.created` event | `applyServerRow` called with payload, no fetch |
| U20 | `generation.deleted` event | `deleteEntry(payload.id, {skipServerDelete:true})` called |
| U21 | `open` event | `hydrateFromServer` called |
| U22 | Malformed payload | Try/catch swallows, parse-error logged, no crash |

### Manual integration matrix (PR description checklist)

| # | Scenario | Pass |
|---|---|---|
| M1 | Delete a freshly-generated local card in Output | Instant hide, server DELETE fires, store clean |
| M2 | Delete a cross-device card in Output (no local row) | Instant hide, sidebar drops too |
| M3 | Delete a confirmed row in Sidebar | Instant hide in sidebar AND Output |
| M4 | Delete a pending row in Sidebar (uuid-only) | Instant hide, no server call, abort upload |
| M5 | Delete X, start Y while DELETE X in-flight, Y completes | **X never reappears**; Y appears |
| M6 | Delete X in tab A, check tab B (BroadcastChannel) | B hides X instantly, no network |
| M7 | Delete X on PC, check phone (SSE) | Phone hides X within 1–2 s |
| M8 | Delete with network throttled to "Offline" | Toast error, state=LIVE restored, retry possible |
| M9 | Enable `DEBUG_HISTORY_DELETE` flag, delete, generate, delete again | Every transition logged, no duplicate logs |
| M10 | HMR rebuild during testing (edit a comment) | Prod: N/A. Dev: one-time loss, user re-clicks, no cascade |
| M11 | Delete a card during BlurUpImage curtain reveal | Reveal completes OR cleanly interrupts; no stuck animation |
| M12 | Reload after deploy with old-version tab open | Old `wavespeed-history` localStorage silently cleared |
| M13 | Cross-device generation: PC generates → phone sees it | Appears within 1–2 s via SSE `generation.created` |
| M14 | Delete in Output → check Sidebar in same tab | Instant (one store, one rerender) |
| M15 | Delete in Sidebar → check Output in same tab | Instant |
| M16 | Bump `ANIMATION_HOLD_MS` to 200 + add fade-out CSS | Card visibly fades over 200 ms before eviction; functionally deleted immediately |

### Success criteria for the PR

- No scenario causes a deleted entry to reappear.
- Click-to-visual-hide ≤ 16 ms (one React commit).
- Cross-device delete latency ≤ 2 s.
- Cross-tab delete latency ≤ 50 ms.
- ESLint blocks deep imports into `@/lib/history/*`.
- TypeScript build green.
- All Vitest unit tests green.
- `DEBUG_HISTORY_DELETE` flag produces a coherent transition trace with no duplicates.

## Operator's manual (lives in `lib/history/README.md` after ship)

When something looks wrong, enable the debug flag in DevTools console:

```
localStorage.setItem("DEBUG_HISTORY_DELETE", "1");
```

Then perform the action and read the console.

| Symptom | Where to look |
|---|---|
| Card won't disappear on delete | Look for `deleteEntry.start` → `deleteEntry.commit` sequence. Missing commit → DELETE hung; check Network tab for the DELETE request. Missing start → `deleteEntry` never invoked; check the click handler import. |
| Card reappears after another generation | Look for `applyServerRow.ignored` for the entry's id. If absent, invariant 2 broken (or entry's local state was wrong at the time). Inspect `useHistoryStore.getState()` for the entry. |
| Cross-tab delete doesn't propagate | Look for `broadcast.send` / `broadcast.recv` in respective tabs. If sender shows send but receiver shows no recv — check `BroadcastChannel` support / extension blocking. |
| Cross-device delete doesn't propagate | Check the EventSource in DevTools → Network → EventStream tab. If no `generation.deleted` event arrived, the server's `broadcastToUser` didn't fan out (HMR-broken subscribers map in dev; check server logs in prod). |
| Output strip empty after reload | Check `/api/history` Network tab. 200 response — check `applyServerList` log. 4xx/5xx — check server. Skeleton showing for >2 s — check network throttling. |

Three places to look when editing anything history-related:

1. `lib/history/store.ts` — types, state transitions, `applyServerRow` (the only place that decides "accept a server row").
2. `lib/history/mutations.ts` — `deleteEntry` (the only removal path), `addPendingEntry`/`confirmPendingEntry` lifecycle.
3. `lib/history/index.ts` — public API surface; if a consumer wants something not here, it doesn't exist.

## References

- Brief: `docs/superpowers/specs/2026-04-12-history-sync-mechanism-redesign.md`
- BlurUpImage (unaffected): `docs/superpowers/specs/2026-04-12-pretty-image-loading-design.md`
- Server SSE: `lib/sse-broadcast.ts`, `app/api/history/stream/route.ts`
- Server DELETE: `app/api/history/route.ts`
- Image cache (unaffected): `lib/image-cache.ts`
