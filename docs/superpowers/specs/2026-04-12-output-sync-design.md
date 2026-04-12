# Cross-device Output sync via SSE — Design

**Date:** 2026-04-12
**Status:** Approved for implementation planning

## Problem

Output panel ("Output · сегодня") shows only generations from the current device. If a user generates images on their phone, then opens the PC with the same username, completed generations from the phone appear in the history sidebar (server-backed SQLite) but NOT in the Output panel (Zustand → localStorage → device-local).

Goal: Output panel should reflect the user's generations from the current day across ALL devices, updated in near-real-time.

### Why this happens today

- `components/output-area.tsx` reads `entries` from `useHistoryStore` (Zustand + `localStorage`).
- LocalStorage is scoped per browser profile on one device. No cross-device propagation.
- The history sidebar (`useHistory` hook in `hooks/use-history.ts`) fetches `GET /api/history?username=...&startDate=...&endDate=...` from SQLite — which IS cross-device. Output simply doesn't call this endpoint.
- In-flight generations (`status: pending` / `processing`) never reach the server until completion — by design device-local.

## Goals

- Completed generations from any device of the same username appear in Output's "today" view on any other device within ≤2 seconds.
- Deletions propagate in the same window.
- In-flight generations stay device-local (a phone spinner should NOT appear on the PC).
- Zero behavior change for users on a single device.
- No degradation of existing history-sidebar responsiveness.

## Non-goals

- Real-time status updates for in-flight generations (spinners across devices).
- Syncing user settings, preferences, or UI state (only generations).
- Multi-instance deployment support (a scale-out to multiple Node processes is deferred — see "Future Work").
- Push notifications when the tab is closed.
- Offline editing / CRDT-style conflict resolution.

## Key Design Decisions

1. **Server-Sent Events (SSE), not WebSocket.** One-way server→client suits the use case. Native browser support via `EventSource` with automatic reconnect. Fits cleanly into a Next.js 15 streaming route handler. No custom server or extra infrastructure.
2. **In-memory subscriber registry, single-instance assumption.** The deployment model (Docker container + SQLite) is single-process. The subscriber `Map<username, Set<Writer>>` lives in the Next.js server process. A scale-out to multi-instance would require Redis pub/sub — documented in Future Work, not implemented now.
3. **Broadcasts fire on `POST /api/history` and `DELETE /api/history` success.** These are the only server-side events that change history state. No broadcast on GET (stateless).
4. **Event format.** Named SSE events with JSON data payloads:
   - `generation.created` — full `ServerGeneration` shape.
   - `generation.deleted` — `{ id: number }`.
5. **Reconnect catch-up via refetch.** On `EventSource` reconnect, the client triggers a normal `useHistory` refetch (through the existing `HISTORY_REFRESH_EVENT`). No server-side event ring buffer; simpler and robust.
6. **Output panel reads from zustand + server-today-merge.** `OutputArea` calls `useHistory({ username, startDate: startOfToday, endDate: endOfToday })` on mount AND subscribes to `generation.created`/`deleted`. Merges zustand entries (local optimistic + in-flight) with server entries from today, deduplicated by `serverGenId ↔ gen.id`. Slice to the existing 10-entry cap after merge.
7. **Coexist with existing BroadcastChannel.** `BroadcastChannel("wavespeed:history")` stays for same-device cross-tab optimistic sync. SSE adds cross-device. Both mechanisms ultimately trigger the same `HISTORY_REFRESH_EVENT` + `useHistoryStore` writes. Minor duplicate work but no correctness issue (refetch is idempotent).
8. **Heartbeat every 25 seconds.** SSE connections traverse proxies (nginx, Cloudflare) that close idle connections after 30–60s. A periodic `: heartbeat\n\n` comment keeps the pipe warm without visible events.
9. **Authentication by username query param.** Same pattern as existing GET `/api/history?username=`. Not tightened in this spec — treated as a separate security concern. Noted in Future Work.

## Architecture

### Server

#### `lib/sse-broadcast.ts` (new)

In-memory subscriber registry.

```
addSubscriber(username, controller, signal): void
removeSubscriber(username, controller): void
broadcastToUser(username, event: { type, data }): void
```

- `subscribers: Map<string, Set<ReadableStreamDefaultController<Uint8Array>>>`
- `broadcastToUser` encodes the event as SSE format and enqueues to every controller for that username.
- If a controller throws during enqueue (client disconnected mid-flight), the subscriber is removed.

#### `app/api/history/stream/route.ts` (new)

SSE endpoint. `GET /api/history/stream?username=X`.

Responds with a `ReadableStream<Uint8Array>` and the required SSE headers:

```
Content-Type: text/event-stream
Cache-Control: no-cache, no-transform
Connection: keep-alive
X-Accel-Buffering: no   # defeat nginx's default buffering
```

Stream lifecycle:
- `start(controller)` — add to subscriber registry, emit an initial `: connected\n\n` comment, set up a heartbeat interval.
- `cancel()` — client disconnected: clear the heartbeat interval and remove from the registry.
- Also honors `request.signal.aborted` as the disconnect signal in case `cancel()` doesn't fire reliably on some platforms.

Auth: requires `username` query param (matches existing `/api/history` GET).

#### `app/api/history/route.ts` (modified)

On `POST` success, AFTER the existing `saveGeneration` call returns with the new row's `id`, fetch the just-created row via `getGenerations({ username, ... limit: 1 })` (or construct it in-place from known fields) and call:
```ts
broadcastToUser(username, {
  type: "generation.created",
  data: { ...serverGenerationShape },
});
```

On `DELETE` success, call:
```ts
broadcastToUser(username, {
  type: "generation.deleted",
  data: { id: parseInt(id) },
});
```

If the broadcast helper throws (shouldn't), it's caught and logged — does not impact the HTTP response.

### Client

#### `hooks/use-generation-events.ts` (new)

```
useGenerationEvents(username: string | null): void
```

- On mount (and when `username` changes), open `new EventSource("/api/history/stream?username=" + encoded)`.
- Register listeners for `generation.created` and `generation.deleted`:
  - Both events call `broadcastHistoryRefresh()` (the existing function from `hooks/use-history.ts`) to trigger a `HISTORY_REFRESH_EVENT`. This in turn causes every `useHistory` instance in the tab to refetch.
- On connection errors, `EventSource` auto-reconnects (built-in exponential backoff). Log once per error cycle, don't toast.
- Cleanup: close the EventSource on unmount or username change.

#### `components/output-area.tsx` (modified)

Add:
- `const { items: serverItemsToday } = useHistory({ username, startDate: startOfToday, endDate: endOfToday });`
- `useGenerationEvents(username);`
- Replace the existing `todayEntries = entries.filter(createdAt >= todayStart).slice(0, 10)` with a merge:
  ```
  mergedToday = dedupMerge(
    entries.filter(createdAt >= todayStart),  // zustand: includes in-flight
    serverItemsToday                           // SQLite: includes cross-device
  )
  // dedup: server item wins over zustand entry with same serverGenId
  // sort by createdAt desc, slice(0, 10)
  ```

The output card renders from whichever source owns the entry. Server-sourced entries are converted to `HistoryEntry` shape via the existing `serverGenToHistoryEntry` adapter in `components/history-sidebar.tsx` (promoted to a shared location if necessary — see Implementation Plan).

## Error Handling

| Condition | Behavior |
|---|---|
| User not signed in (no username) | `useGenerationEvents` no-ops; `useHistory` returns empty. Output falls back to zustand-only (current behavior). |
| SSE connection fails (network) | `EventSource` auto-reconnects. Visible effect: brief sync gap. Catch-up on reconnect via `HISTORY_REFRESH_EVENT`. |
| Server restart | All connections drop, clients reconnect. Same catch-up path. |
| Proxy closes idle connection | Heartbeat prevents this. If it still happens (malformed proxy), reconnect handles. |
| `broadcastToUser` enqueue fails for one subscriber | That subscriber is removed from the registry. Others continue. Logged. |
| Broadcast during server shutdown | All pending enqueues best-effort. Next client reconnect catches up via fetch. |
| Multi-instance deployment (out-of-scope) | Broadcasts from instance A do not reach subscribers on instance B. Document the limitation. |
| Concurrent POSTs from same user on different devices | Both broadcasts fire; both connected clients receive both. Dedup by `id` on the client's server-history merge side handles it. |
| Event arrives before the initial `useHistory` fetch completes | The event triggers a refetch, but if one is already in-flight (request id tracking in `useHistory`), it safely ignores the stale response. |

## Edge Cases

- **Multiple tabs on the same device.** Each tab opens its own `EventSource`. The server broadcasts to each independently. Each tab updates its local `useHistoryStore` via refetch. `BroadcastChannel` additionally cross-tab-syncs the local Zustand writes. No conflict.
- **User signs out + signs in as a different username.** `useGenerationEvents`'s effect re-runs with the new username, closes the old `EventSource`, opens a new one. Subscribers for the old username are removed on `cancel()`.
- **Clock skew between devices.** `startOfToday` is computed locally on each device. A phone in UTC+5 and a PC in UTC+3 will disagree on "today's boundary" near midnight. Accepted: each device shows its own today. Cross-device sync works for entries generated in the overlap window.
- **Rapid-fire generations.** If a user generates N images in quick succession, N broadcasts fire, N refetches may be triggered on the client. The existing leading-edge throttle in `triggerHistoryRefresh` (trailing debounce at 1500ms) coalesces.
- **Deleted entry that was already evicted from Output** (e.g. more than 10 generations today, deleted one that was already scrolled out). The delete event fires; refetch returns the current top 10; no visible change. Correct.
- **First paint on fresh tab.** The initial `useHistory` fetch fires before SSE connection opens. Both are async. The fetch populates `serverItemsToday`, EventSource later takes over live updates. No gap.

## Testing

### Manual

- Sign in as same user on two devices (or two browser profiles / incognito windows pointing at the same server). Generate on device A. Device B's Output panel should update within 2 seconds without reload.
- Delete on device A. Device B's Output updates.
- Kill the dev server mid-connection. Browser console should show reconnect attempts; on restart, new connection established; next generation syncs.
- DevTools Network tab: find the `/api/history/stream?username=...` request. Should show status 200, `content-type: text/event-stream`, and stay "pending" (streaming). Heartbeat bytes visible every ~25s in the response body (if Network shows raw).
- Close the tab while streaming. Server-side log should show subscriber removal.

### Automated

None for this spec. Streaming is hard to unit-test without significant mock infrastructure. Defer to manual verification.

## Security notes (follow-ups, not blocking)

- The SSE endpoint accepts `?username=X` without verifying the caller is that user. This is consistent with `GET /api/history` today and is a pre-existing concern, not introduced by this spec. Future work: plumb session-cookie-based auth into both endpoints.

## Out of scope (explicit)

- Multi-instance deployment (Redis pub/sub).
- Syncing pre-today generations through SSE (today filter is a UI concern; sidebar pagination handles the rest).
- Server-side persistence of dropped events (no ring buffer).
- Real-time progress events for in-flight generations.
- Push notifications when the tab is backgrounded or closed.
- Replacement of the existing `BroadcastChannel` — kept for local optimistic flows.

## Future Work

- **Multi-instance scale-out.** If the app deploys to more than one Node process, replace the in-memory subscriber registry with a Redis pub/sub. Each instance subscribes to a single Redis channel for broadcasts; its local subscriber set delivers events to connected clients. ~150 LOC including connection lifecycle.
- **Session-cookie auth on the SSE endpoint.** Replace `?username=X` query param with server-side session lookup. Same change should apply to `/api/history` GET.
- **Ring buffer for dropped-event recovery.** If users report stale state after long disconnects, implement a per-user ring buffer of last ~200 events keyed by SSE `id:`. Client sends `Last-Event-ID` on reconnect; server replays. Not needed if refetch-on-reconnect remains reliable.
- **Typed event schema.** Extract event types into a shared module used by both server and client. Currently JSON-by-convention.
- **Mobile background behavior.** Chrome for Android / iOS Safari may suspend `EventSource` when the tab is backgrounded. Re-foreground should trigger reconnect automatically, but worth spot-checking if we add PWA or fullscreen modes.

## Implementation notes (2026-04-12)

Shipped in 7 sequential commits (`fb65155` → `498c27c`) on `main`. See
the corresponding plan (`docs/superpowers/plans/2026-04-12-output-sync.md`)
for the per-task log.

One edge case surfaced during browser testing that this spec did not
anticipate: **same-device duplicate flash during the POST/SSE race.**
Because the SSE `generation.created` event travels on a separate
connection from the POST response, the client can refetch `useHistory`
and re-merge *before* the originating device's Zustand entry has its
`serverGenId` populated. In that window, the existing `serverGenId`
dedup is empty, so the server row enters the merge as a second card —
visible briefly as a "broken" image tile (server `mid_<uuid>.jpg` URL
that the browser has not yet fetched) next to the local blob-URL card.

**Resolution** (`d446681`): the `OutputArea` merge now also keys on
`uuid`. Pending uploads from this device are read from
`lib/pending-history` via `useSyncExternalStore`, and server rows whose
output filepath uuid matches any pending uuid are skipped. The existing
`serverGenId` path still covers the post-race steady state and
cross-device events. `extractUuid` was promoted from a file-local
helper in `hooks/use-history.ts` to a named export for reuse.

This fix preserved all cross-device behavior: on a receiving device,
`pending` is always empty, so the uuid filter is a no-op and server
rows flow through as before.

### Follow-ups still open

- The "originating-device delete" edge case (delete arrives from device
  B while device A still holds the Zustand entry with `serverGenId`)
  was closed by the `2026-04-12-output-delete-symmetry` work:
  `useGenerationEvents` now cleans Zustand on `generation.deleted`.
