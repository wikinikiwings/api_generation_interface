# Output/History delete symmetry — Design

**Date:** 2026-04-12
**Status:** Approved for implementation planning
**Related:** `docs/superpowers/specs/2026-04-12-output-sync-design.md` (closes the "originating-device delete" follow-up)

## Problem

After the `output-sync` work landed, the red trash button on cards in
the Output panel stopped deleting images. Clicking it is either a full
no-op (for cards sourced from `serverToday`) or a flash-then-reappear
(for cards that have a local Zustand row): the entry is removed from
Zustand but the next `useHistory`/merge cycle re-adds it as a remote
entry because the server row still exists.

Deletion from the History sidebar works — it calls `DELETE /api/history`
and cleans up Zustand inline. The user reports they want both entry
points to behave symmetrically: deleting from Output must remove the
image from both Output and History; deleting from History (already
working) must remove from both.

## Goals

- Clicking the trash icon on an Output card deletes the generation from
  the server, from the Output panel, and from the History sidebar.
- Deletion is symmetric: Output-trash and History-trash produce the
  same end state across all open tabs and devices of the same user.
- Closes the `output-sync` follow-up: on an originating-device, a
  delete initiated from another device also clears the local Zustand
  entry (currently it persists until reload).
- No regression for the History sidebar delete path.

## Non-goals

- Undo / soft-delete. The server performs hard delete and the file is
  removed. Not adding a soft-delete tier for this work.
- Batch / multi-select delete.
- Delete confirmations with richer UI (custom dialog). Reuse the existing
  `window.confirm()` used by the History sidebar.
- New UI affordances. The trash button already exists on Output cards;
  we fix its behavior only.

## Key Design Decisions

1. **Single source of truth for Zustand-cleanup: the SSE subscriber.**
   Both UI entry points (Output trash, History trash) do the same thing:
   `confirm()` → `DELETE /api/history?id=…&username=…` → toast. The
   server broadcasts `generation.deleted` on success. Every connected
   tab's `useGenerationEvents` hook receives the event and performs the
   Zustand cleanup. This replaces the inline Zustand-cleanup that
   History sidebar does today.

2. **`confirm()` is used for server-backed entries only.** A local
   Zustand entry without `serverGenId` (failed POST, legacy pre-v3
   store) is dismissed silently with no dialog and no API call — it is
   not in the database, so there is nothing to delete server-side.
   Symmetry with History holds automatically: such entries do not
   appear in the History sidebar either.

3. **No optimistic local Zustand remove in the trash handler.** The SSE
   round-trip is fast (<200 ms typical) and the handler's own `toast`
   already confirms the action. Skipping the optimistic path keeps the
   handler narrow and avoids a "remove then the server says it failed,
   do we re-add?" class of bug. If the SSE event is late (network
   hiccup), the tile stays visible for an extra beat — acceptable, and
   it disappears as soon as the event lands.

4. **History sidebar's inline Zustand cleanup is removed.** The
   subscriber now handles it for every tab including the initiating
   one. This eliminates duplicate logic and the originating-device edge
   case in one move.

5. **DELETE errors do not mutate local state.** A failed DELETE shows a
   toast and leaves the tile in place. No refetch on failure. The user
   can retry.

6. **Pending-entry path unchanged.** History sidebar already handles
   `isPending(gen)` by calling `removePending(gen.uuid)` with no server
   call. That branch stays. Output-area does not render pending entries
   from the `serverToday` stream (pending entries are already rendered
   from Zustand with a Cancel button, not a Trash button), so no
   equivalent branch is needed on the Output side.

## Architecture

### `hooks/use-generation-events.ts` (modified)

Currently both event types call `broadcastHistoryRefresh()` via a
shared `refresh` callback. Split the handler for `generation.deleted`:

```ts
es.addEventListener("generation.deleted", (ev) => {
  let id: number | null = null;
  try {
    const parsed = JSON.parse((ev as MessageEvent).data) as { id: number };
    id = typeof parsed.id === "number" ? parsed.id : null;
  } catch {
    // Malformed payload — fall through to refresh-only.
  }
  if (id !== null) {
    const store = useHistoryStore.getState();
    const toRemove = store.entries
      .filter((e) => e.serverGenId === id)
      .map((e) => e.id);
    for (const localId of toRemove) store.remove(localId);
  }
  broadcastHistoryRefresh();
});
```

`generation.created` remains wired to the shared `refresh`. The `open`
and `error` handlers stay as-is.

Import `useHistoryStore` from `@/stores/history-store`.

### `components/output-area.tsx` (modified)

Replace `onRemove={() => remove(entry.id)}` (line 164) with a handler
that distinguishes categories:

```ts
async function handleRemove(entry: HistoryEntry) {
  if (typeof entry.serverGenId !== "number") {
    // Local entry never reached the server. Dismiss quietly.
    remove(entry.id);
    return;
  }
  if (!username) return;
  if (!confirm("Удалить эту запись из истории?")) return;
  try {
    const res = await fetch(
      `/api/history?id=${entry.serverGenId}&username=${encodeURIComponent(username)}`,
      { method: "DELETE" }
    );
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    toast.success("Удалено");
    // Zustand + History refetch handled by useGenerationEvents on the
    // `generation.deleted` SSE event.
  } catch (e) {
    toast.error(e instanceof Error ? e.message : "Delete failed");
  }
}
```

Pass `onRemove={() => handleRemove(entry)}` to `OutputCard`. The
`OutputCard` signature is unchanged — parent owns the logic.

The remote-entry path in the merge (line 102) already goes through
`serverGenToHistoryEntry`, which sets `serverGenId: gen.id`. No adapter
changes required.

### `components/history-sidebar.tsx` (modified)

In `handleDelete` (lines 134–171), remove the inline Zustand-cleanup
block:

```ts
// DELETE the lines currently at ~160–164:
const store = useHistoryStore.getState();
const toRemove = store.entries
  .filter((e) => e.serverGenId === gen.id)
  .map((e) => e.id);
for (const id of toRemove) store.remove(id);
```

Leave everything else intact: `confirm`, `isPending` branch, DELETE
fetch, `setDeletingIds`, `toast.success`, `refetch`. The SSE event will
handle Zustand cleanup for this tab (and every other tab of the user).

The `useHistoryStore` import in `history-sidebar.tsx` may become unused;
drop it if so.

### Server (`app/api/history/route.ts`, `lib/sse-broadcast.ts`)

No changes. `DELETE /api/history` already calls
`broadcastToUser(username, { type: "generation.deleted", data: { id } })`.

## Data Flow

**Scenario: User clicks Output trash on device A (also has device B, also has History sidebar open).**

1. A: `confirm()` → OK.
2. A: `fetch("/api/history?id=42&username=alice", { method: "DELETE" })`.
3. Server: deletes DB row 42 + associated files. Calls `broadcastToUser("alice", { type: "generation.deleted", data: { id: 42 } })`.
4. A: response 200 → `toast.success("Удалено")`.
5. SSE fanout: both A and B receive `generation.deleted` `{ id: 42 }`.
6. A's `useGenerationEvents`: removes Zustand entries with `serverGenId === 42`; calls `broadcastHistoryRefresh()` → every `useHistory` in the tab refetches → `serverToday` no longer contains id 42 → Output merge produces no tile for it.
7. B's `useGenerationEvents`: same. B's Output had no Zustand row for id 42 in the first place (it was a `serverToday` tile), so the Zustand-cleanup loop is a no-op; the refetch alone removes the tile.
8. A's and B's History sidebars: `useHistory` refetch removes the row from the list.

**Scenario: Device A deletes a row generated locally; device B has never seen it but is subscribed.**

Same flow; A's Zustand cleanup is the load-bearing step (closes `output-sync` originating-device-delete follow-up).

**Scenario: User clicks Output trash on a remote tile (no local Zustand row).**

1–5 identical.
6. A's Zustand-cleanup loop finds no matching entry — no-op. `broadcastHistoryRefresh` removes the row from `serverToday`. Correct.

## Error Handling

| Condition | Behavior |
|---|---|
| DELETE returns non-2xx | `toast.error(message)`. No Zustand change, no server state change (either the server rejected or the network dropped). |
| DELETE times out / network drops | Same as above. On next SSE reconnect, `open` handler triggers a refetch so stale state is reconciled from the server. |
| Malformed `generation.deleted` payload (missing / non-numeric `id`) | Handler falls through to `broadcastHistoryRefresh()` only. Zustand may keep a stale entry for one refetch cycle; refetch won't remove it (Zustand isn't derived from `serverToday`), so visible staleness on originating device possible until the next local mutation. Accepted: the server never produces malformed payloads today. |
| User not signed in (`username === null`) | Handler early-returns before `confirm`. The trash button is effectively inert. Symmetric with the state before this fix for server-backed entries; local-only entries still dismiss quietly via the `serverGenId` guard. |
| Clicking trash twice rapidly | First `confirm` → DELETE in-flight; second click's `confirm` shows again. If the user accepts, a second DELETE hits a 404 from the server (row already gone) → `toast.error` with HTTP 404 message. Acceptable; double-click-destroy not a common path. |
| SSE subscriber loses connection during the DELETE | `EventSource` auto-reconnect; the `open` handler triggers a full refetch. Zustand-cleanup on the initiating device happens when the `deleted` event arrives (queued by browser up to a small buffer) or not at all if the event was dropped. In the dropped case the local tile persists until the user refreshes or another mutation occurs. Low-probability, mirrors the pre-fix state. |

## Edge Cases

- **Race: DELETE completes before SSE open (rare).** The server fires `broadcastToUser` immediately; if A's subscriber momentarily disconnected, the event may be lost. A's response-side `toast.success` still fires. Result: local tile persists until next manual refresh. Accepted for this iteration.
- **Entry deleted from History while Output's `confirm()` dialog is showing.** User confirms, DELETE returns 404, `toast.error` fires. Tile disappears via the SSE event triggered by the *other* delete. Slightly noisy but not incorrect.
- **Legacy entries without `serverGenId`.** Output handler dismisses silently via the `typeof serverGenId !== "number"` guard. History sidebar never rendered these (it iterates `serverToday`), so symmetry is trivially preserved.
- **Pending entries in Output.** Rendered with a Cancel (×) button, not a Trash button (`output-area.tsx:284-299` vs `323-338`). This fix does not touch them.
- **10-cap eviction.** Deleting a row already past the 10-entry visible cap produces no visible change in Output; History sidebar shows the removal. Correct.

## Testing

### Manual

1. Sign in on two browser profiles / devices as the same username. Generate an image on A → tile in Output on both.
2. On A, click the Output trash → `confirm` → OK. Expect: tile disappears on A and B within ~1 s, and from both History sidebars.
3. Repeat but initiate the delete from History on A. Same expected outcome.
4. Fresh generation on A. On B, delete via History. Expect: on A, both the History row AND the Output tile disappear (this is the `output-sync` follow-up being closed — verify explicitly).
5. With network throttled to "Offline" for device A, click Output trash → `toast.error`, tile stays. Restore network → next generation triggers refetch, state reconciles.
6. Click Output trash on a row without `serverGenId` (simulate by making generate-form skip the POST, or open a stale pre-v3 store in DevTools → localStorage). Expect: no `confirm`, tile vanishes immediately, no network request in Network tab.
7. Two tabs on the same device. Delete via Output in tab 1. Expect: tile disappears in tab 2's Output + History as well (SSE path still works intra-device).

### Automated

None added. Matches the precedent set by `output-sync` — streaming/cross-tab behavior is manually verified.

## Out of scope (explicit)

- Redesigning the confirmation dialog.
- Soft-delete / trash bin / recover-deleted feature.
- Multi-select delete.
- Tightening the `?username=` auth model (tracked as a separate concern in the `output-sync` spec).
- Surface error messages from the server beyond the HTTP status.

## Future Work

- If a structured undo becomes desirable, the server would need a soft-delete column (`deleted_at`) and a POST endpoint to clear it. The client could then show a toast with an Undo button that invokes the restore. Not planned.
- If the SSE-event Zustand cleanup turns out to be the wrong place architecturally (e.g., we decide the store should never be mutated from a hook), promote it to a thin store-level action like `useHistoryStore.getState().removeByServerGenId(id)`.
