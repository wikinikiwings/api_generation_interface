# History Sync Mechanism — Redesign + Operator's Manual

**Date:** 2026-04-12 (evening)
**Status:** Task for a fresh agent — pick up as first thing next session
**Supersedes:** `2026-04-12-history-delete-sync-cleanup.md` (the earlier "patch-in-place" proposal)

## Your job (agent reading this tomorrow)

The history mechanism — how an image entry flows from generation → local state → server → cross-tab / cross-device sync → deletion → refresh — has grown organically across several features (output-sync, output-delete-symmetry, history-thumbnail-first, pretty-image-loading). Every feature layered new concerns onto the same primitives: Zustand, `pendingHistory` singleton, `useHistory` hook, `useGenerationEvents` SSE, `useDeletionsStore`.

**Each layer works individually. Together they produce surprising race behavior the user consistently hits in dev.**

You are NOT fixing a bug. You are rebuilding the mechanism **from scratch** with three non-negotiable properties:

1. **Single source of truth per concern.** No "both SSE and UI handler must remember to do X" patterns.
2. **Documented mental model.** A new engineer (or an LLM reading the repo cold) should be able to answer "where does an entry live?", "what removes it?", "what triggers a refresh?" from one document.
3. **Restorable from the doc alone.** If someone rips out the mechanism and has only the doc, they can rebuild it. That means: the doc contains exact types, a state diagram, a per-phase lifecycle description, and a test matrix.

Plus one eventual-requirement: **room for a deletion animation** (e.g. fade-out instead of instant vanish). The redesign must not make this harder.

## What's broken today (read before designing)

### Concrete symptoms the user hit

- Delete X from Output. X disappears locally.
- User starts generating Y while DELETE X is in-flight.
- Y finishes. `triggerHistoryRefresh()` fires. `useHistory` refetches. Response includes X because DELETE hasn't committed server-side yet.
- X re-surfaces in sidebar for a window. Our `useDeletedIds` filter was supposed to suppress this but under certain HMR cycles the store got reset and lost the entry.
- Worse cascade observed: deleting Y after X re-surfaced caused the UI to appear to delete X (the resurrected row) instead of Y. Y then vanished ~30 s later via auto-refresh.

### Architectural contributors

- **Three concurrent stores** with overlapping responsibilities:
  - `useHistoryStore` (Zustand, persisted) — local entries.
  - `pendingHistory` (singleton) — optimistic in-flight uploads.
  - `useDeletionsStore` (Zustand, our late addition) — cross-surface deletion registry.
- **Four refresh triggers**:
  - `HISTORY_REFRESH_EVENT` (window custom event, fired synchronously).
  - `triggerHistoryRefresh()` (leading-edge + 1.5 s trailing debounce).
  - `broadcastHistoryRefresh()` (no debounce, also cross-tab via BroadcastChannel).
  - SSE `generation.created` / `generation.deleted` reconnect → triggers refresh.
- **Four removal paths**:
  - Output card `handleRemove` (optimistic local + DELETE + refresh).
  - Sidebar `handleDelete` (optimistic local + DELETE + refetch).
  - SSE `generation.deleted` handler (Zustand.remove by serverGenId match).
  - `removePending()` for not-yet-confirmed uploads.
- **Dev-mode quirks**:
  - HMR resets the server-side `subscribers` Map in `lib/sse-broadcast.ts`. Client EventSource stays "connected" but events don't fan out.
  - HMR re-evaluates client modules. Module-level stores are recreated unless cached on globalThis. Our globalThis attempt made other things worse and was reverted (`f00bb41`).

### Known non-issues (don't "fix" these)

- Two DELETE requests per click were observed. Server DELETE is idempotent; this is noise from React strict-mode or a DOM double-fire. Not worth investigating — your redesign should be robust to N DELETE calls for the same id.
- Cache bloat from `useDeletionsStore` never evicting. Server IDs are monotonic; a session that deletes 10 000 rows accumulates 10 000 numbers — negligible. Don't bother evicting.

## Design constraints

### Requirements

1. **One module owns history state** (entries, pending uploads, deletions). Components consume via hooks, never mutate directly.
2. **One function deletes an entry** across every path (Output trash, Sidebar trash, SSE cross-device event, keyboard shortcut future). No call-site does its own Zustand.remove + markDeleted + refresh.
3. **One refresh primitive.** Pick `broadcastHistoryRefresh()` (immediate, cross-tab) or `triggerHistoryRefresh()` (debounced) — not both. Likely the immediate one; debounce can live inside the consumer if needed.
4. **Prod-first correctness.** Dev-HMR is a nice-to-have; the mechanism should degrade gracefully when SSE drops, but SSE reliability in dev is not a build-blocker.
5. **Instrumented by default.** Keep `lib/history-debug.ts` (or a successor); add logs at every state transition. The flag gate keeps prod silent.
6. **Animation-ready.** The mechanism's remove step should be a state transition to `"deleting"`, not immediate removal, so a future `<HistoryCard state="deleting">` can fade out before the component unmounts.

### Non-goals

- Server-side changes. `DELETE /api/history` and `broadcastToUser` are fine.
- `pendingHistory` restructure — it's a focused, working singleton.
- `BlurUpImage` changes — independent.
- Touching `useHistoryStore`'s persistence / migration / storage-event sync.
- Multi-device conflict resolution beyond "last-writer-wins" (a delete always wins over an insert; a re-create after delete gets a new id).

## Proposed architecture

### Module tree (new / consolidated)

```
lib/history/
  store.ts          — single facade over Zustand + pendingHistory
  mutations.ts      — deleteEntry, confirmEntry, addPendingEntry, etc.
  sse.ts            — EventSource connection + event dispatch (was useGenerationEvents)
  debug.ts          — existing history-debug.ts renamed
  types.ts          — ServerGeneration, PendingGeneration, HistoryEntry, state enum
  index.ts          — re-exports the PUBLIC hooks + functions; call-sites import from here only
```

Everything under `lib/history/` is the ONLY place allowed to touch Zustand or the pending singleton. Components import from `@/lib/history` and get typed hooks.

### State model — entry lifecycle

```
        (user submits a generation)
                  │
                  ▼
            ┌──────────┐
            │ PENDING  │  ← pendingHistory holds it; not yet on server
            └────┬─────┘
                 │ server responds with serverGenId
                 ▼
            ┌──────────┐
            │ LIVE     │  ← Zustand + server DB agree; normal render
            └────┬─────┘
                 │ user or SSE triggers delete
                 ▼
            ┌──────────┐
            │ DELETING │  ← removed from lists? NO. Marked state="deleting".
            └────┬─────┘     Components CAN render with opacity/animation.
                 │ fetch DELETE commits + commitDelete() fires
                 ▼
            ┌──────────┐
            │ REMOVED  │  ← actually evicted from stores. Filter drops from lists.
            └──────────┘
```

A single entry has one `state` field. Consumers filter on state (default: show LIVE + DELETING; an animation prop decides whether DELETING renders). No separate "deleted-ids" registry.

### Public API (drafted)

```ts
// lib/history/types.ts
export type EntryState = "pending" | "live" | "deleting" | "removed";

export interface HistoryEntry {
  id: string;                 // stable, uuid-derived
  serverGenId?: number;
  state: EntryState;
  /* ... existing HistoryEntry fields ... */
}

// lib/history/index.ts
export function useHistoryEntries(range?: DateRange): {
  entries: HistoryEntry[];     // pre-filtered: pending + live + deleting
  pending: HistoryEntry[];     // only pending subset (for skeleton rendering)
  isLoading: boolean;
  error: string | null;
  refetch: () => void;
};

export function useEntryById(id: string): HistoryEntry | undefined;

// lib/history/mutations.ts
export async function deleteEntry(entryIdOrServerGenId: string | number): Promise<void>;
export function addPendingEntry(...): void;
export function confirmPendingEntry(uuid: string, serverUrls: ServerUrls): void;
```

### `deleteEntry(id)` — the single removal path

1. Resolve to an entry in the store (by local id OR serverGenId).
2. If PENDING → call `removePending(uuid)` → state=REMOVED immediately. Return.
3. If LIVE:
   - Set state=DELETING (components render accordingly — fade-out opportunity).
   - Fire `fetch DELETE /api/history`.
   - On success: wait for `animationHoldMs` (default 0, can be 200 for fade-out) → set state=REMOVED → evict from stores.
   - On failure: toast error, set state=LIVE back, surface the error.
4. Whether the state transition came from a UI click or from SSE (cross-device), the same function runs the same way. No duplicated logic.

### Refresh primitive — simplified

Consumers don't call `broadcastHistoryRefresh()` or `triggerHistoryRefresh()`. They get reactive data from `useHistoryEntries`. The ONLY thing that triggers a server refetch is:

- Module-internal: entry state transitions to REMOVED or gets re-added.
- SSE `generation.created` handler.
- SSE `open` reconnect.

All refetches go through one debounced function inside `lib/history/store.ts`. Consumers never think about refetches.

### Cross-tab via BroadcastChannel

Same channel as today (`lib/history/store.ts` owns it). When state transitions happen locally, post a message so other tabs apply the same transition. No polling — events are the truth.

### SSE handler — thin

`lib/history/sse.ts` just translates events to `deleteEntry(serverGenId)` / `refetch()` calls. No store mutations in the handler itself. This means deleting from another tab via SSE runs the same `deleteEntry` that a local click does — same state machine, same animation, same guarantee.

## Operator's manual (what goes in the doc AFTER implementation)

When you ship the redesign, append a section to this file titled "Operator's Manual" with:

1. **State diagram** (above) with an example entry walking every edge.
2. **"When X breaks, check Y"** table:
   - Card won't disappear on delete → enable DEBUG_HISTORY flag, click; check for `deleteEntry.start` → `deleteEntry.server.ok` → `deleteEntry.commit` sequence. Missing final one → state-machine bug.
   - Card reappears after generation → check the refetch path; entry should be state=REMOVED, not present in items.
   - Cross-tab delete doesn't propagate → check BroadcastChannel / SSE connection in DevTools.
3. **File-level README** at `lib/history/README.md` pointing to this spec.
4. **One-page "mental model"** — the state diagram, the public hooks, the three places to look when editing anything history-related.

## Implementation plan (for the agent)

1. **Read** this document, the Post-ship notes in `2026-04-12-pretty-image-loading-design.md`, and skim the commit history from `0693ac6` through today's `f00bb41`. Understand how we got here.
2. **Brainstorm with the user** — don't start from this doc's API verbatim; validate the shape with them, they may want different boundaries.
3. **Write a plan** following `superpowers:writing-plans`. Expect ~12–18 tasks, several large.
4. **Execute** via `superpowers:subagent-driven-development` or `superpowers:executing-plans`.
5. **Do not preserve backwards-compat** with the current scattered API. This is a green-field rewrite; prior call-sites are migrated. Commits of the form "migrate <component> to new history API" are expected.
6. **Retain `lib/history-debug.ts`** (move under `lib/history/debug.ts`). Add new logs at every state transition in the new state machine.
7. **Delete** the earlier `2026-04-12-history-delete-sync-cleanup.md` at end of cleanup — it is superseded.

### Estimated effort

One day of focused work if you start from the design in this doc. A few hours more for tests / manual verification. The user is willing to block the feature branch for this.

## Test matrix (for the implementation plan)

| # | Scenario | Pass criteria |
|---|---|---|
| 1 | Delete a local-only freshly-generated card in Output | Instant hide, server DELETE fires, Zustand clean |
| 2 | Delete a cross-device card in Output (no Zustand row) | Instant hide, server DELETE fires, sidebar also drops |
| 3 | Delete a confirmed row in Sidebar | Instant hide in sidebar AND Output, DB clean |
| 4 | Delete a pending row in Sidebar (uuid-only) | Instant hide, no server call |
| 5 | Delete X, start Y while DELETE X is in flight, Y completes | X never reappears; Y appears |
| 6 | Delete X in tab A, check tab B | B's sidebar + Output drop X within 2 s |
| 7 | Delete a card with Network throttled offline | Error toast, state=LIVE restored, user can retry |
| 8 | Enable DEBUG flag, delete, generate, delete again | Every transition has a log line; no duplicate logs |
| 9 | HMR rebuild during testing (just edit a comment) | No state loss; markDeleted entries persist |
| 10 | Delete a card during a curtain reveal animation | Reveal completes OR is interrupted cleanly; no stuck animations |
| 11 | Add fade-out animation (stub) to DELETING state | 200ms hold; card visibly fades before eviction |

## Closing note from today

We spent an evening playing whack-a-mole with the current mechanism. The user's feedback was clear: "it doesn't look very complicated by logic — it should be clean and transparent and restorable from a document." They're right. The incremental patches brought it closer but didn't close it. Tomorrow: start fresh.

The pretty-image-loading work this spec originally supported (BlurUpImage, curtain reveal, cache-skip heuristic) is **solid and shipped**. That part of the day was a win. The history mechanism's state isn't its fault — it was inherited pre-existing complexity we touched tangentially. The right move is to rebuild it.
