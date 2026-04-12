# Output/History delete symmetry Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the broken red-trash button in the Output panel so clicking it deletes the generation from server + Output + History, and ensure delete from either Output or History propagates symmetrically across all tabs and devices.

**Architecture:** Both UI entry points (Output trash, History trash) call `DELETE /api/history?id=…&username=…`. The server-side SSE broadcast already exists. The client-side `useGenerationEvents` SSE subscriber becomes the single source of truth for Zustand cleanup on `generation.deleted` — replacing the inline Zustand cleanup currently done by the History sidebar. This also closes the originating-device-delete follow-up flagged in the `output-sync` spec.

**Tech Stack:** Next.js 15, React 19, TypeScript strict, Zustand persist, `EventSource`. No new dependencies. Manual verification only (no test runner in this project).

---

## Spec reference

`docs/superpowers/specs/2026-04-12-output-delete-symmetry-design.md`

## Important architectural notes

- **Single source of truth for Zustand cleanup = SSE subscriber.** Do NOT duplicate cleanup logic in the Output handler. Do NOT keep the inline cleanup in the History handler after this plan runs.
- **No optimistic `remove()` in the trash handler.** The SSE round-trip is fast; skipping optimistic keeps the handler narrow and avoids rollback edge cases (see spec Key Decision #3).
- **`confirm()` only when there is something to delete server-side.** Local-only entries (no `serverGenId`) are dismissed silently with no dialog.
- **No changes to server routes, SSE broadcast, or the `/api/history/stream` endpoint.** The server side already fires `generation.deleted` on DELETE success.
- **No new test runner.** Manual browser verification, same convention as the `output-sync` plan.

## File Structure

### Modified files

- **`hooks/use-generation-events.ts`** — split the `generation.deleted` handler out from the shared `refresh` callback; parse the payload; remove Zustand entries whose `serverGenId` matches; then broadcast history refresh.
- **`components/output-area.tsx`** — replace `onRemove={() => remove(entry.id)}` with a proper handler that confirms, calls `DELETE /api/history`, and toasts. No optimistic Zustand change.
- **`components/history-sidebar.tsx`** — remove the inline Zustand-cleanup block in `handleDelete`. The SSE subscriber handles it now.

### No changes

- `stores/history-store.ts`
- `lib/server-gen-adapter.ts` (remote entries already carry `serverGenId`)
- `lib/sse-broadcast.ts`
- `app/api/history/route.ts`
- `app/api/history/stream/route.ts`

---

## Task 1: Split `generation.deleted` handler in `useGenerationEvents`

**Files:**
- Modify: `hooks/use-generation-events.ts`

The current hook wires both `generation.created` and `generation.deleted` to the same `refresh` callback (`broadcastHistoryRefresh`). We want `generation.deleted` to additionally clean the Zustand store, so any tab on any device of the user drops its local entry for the deleted row.

- [ ] **Step 1: Add Zustand store import**

Open `hooks/use-generation-events.ts`. After the existing import block at the top, add:

```ts
import { useHistoryStore } from "@/stores/history-store";
```

The final import block should look like:

```ts
"use client";

import * as React from "react";
import { broadcastHistoryRefresh } from "@/hooks/use-history";
import { useHistoryStore } from "@/stores/history-store";
```

- [ ] **Step 2: Replace the shared `deleted` listener with a dedicated one**

Find the two `addEventListener` lines (current lines 32–33):

```ts
es.addEventListener("generation.created", refresh);
es.addEventListener("generation.deleted", refresh);
```

Replace them with:

```ts
es.addEventListener("generation.created", refresh);

// `generation.deleted` carries `{ id: number }`. Drop any Zustand
// entries that reference this server row so the Output panel
// (which merges Zustand + serverToday) stops showing them. This is
// the single source of truth for cross-tab / cross-device delete
// cleanup — the UI trash handlers in Output and History intentionally
// do NOT mutate Zustand themselves.
es.addEventListener("generation.deleted", (ev) => {
  let id: number | null = null;
  try {
    const parsed = JSON.parse((ev as MessageEvent).data) as { id?: unknown };
    if (typeof parsed.id === "number") id = parsed.id;
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

Leave the `open` and `error` listeners below this untouched.

- [ ] **Step 3: Type-check**

Run: `cd E:/my_stable/viewcomfy/wavespeed-claude && npx tsc --noEmit`

Expected: succeeds with zero errors.

- [ ] **Step 4: Commit**

```bash
git add hooks/use-generation-events.ts
git commit -m "feat(use-generation-events): clean Zustand on generation.deleted SSE event"
```

---

## Task 2: Remove inline Zustand cleanup in History sidebar

**Files:**
- Modify: `components/history-sidebar.tsx:134-171`

Now that the SSE subscriber handles Zustand cleanup for every tab (including the initiating one), remove the duplicate inline logic from `handleDelete`. Leave confirm, API call, toast, and `refetch` intact.

- [ ] **Step 1: Remove the inline cleanup block**

Find `handleDelete` (starts at line 134). Inside the `try` block, after `setDeletingIds(...)` and before `toast.success("Удалено")`, locate the block (current lines ~154–164):

```ts
// Also drop the matching entry from the client-side zustand store
// that feeds the Output panel. Exact match via serverGenId, which
// generate-form writes after POST /api/history succeeds. Legacy
// entries (pre-v3 store) and entries from generations whose POST
// failed simply won't match — safe fallback: Output keeps showing
// them and the user can dismiss via the × on the Output card.
const store = useHistoryStore.getState();
const toRemove = store.entries
  .filter((e) => e.serverGenId === gen.id)
  .map((e) => e.id);
for (const id of toRemove) store.remove(id);
```

Delete these lines entirely. The resulting `handleDelete` body should be:

```ts
async function handleDelete(gen: ServerGeneration) {
  if (!username) return;
  if (!confirm("Удалить эту запись из истории?")) return;

  // Pending (not-yet-confirmed) entry: drop it from the client-side
  // singleton. Blob URLs revoked. No server call.
  if (isPending(gen)) {
    removePending(gen.uuid);
    toast.success("Удалено");
    return;
  }

  try {
    const res = await fetch(
      `/api/history?id=${gen.id}&username=${encodeURIComponent(username)}`,
      { method: "DELETE" }
    );
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    setDeletingIds((prev) => new Set(prev).add(gen.id));

    toast.success("Удалено");
    void refetch();
  } catch (e) {
    toast.error(e instanceof Error ? e.message : "Delete failed");
  }
}
```

- [ ] **Step 2: Check if `useHistoryStore` import is still used elsewhere in the file**

Run: `cd E:/my_stable/viewcomfy/wavespeed-claude && npx tsc --noEmit 2>&1 | head -40`

If the type-check reports `useHistoryStore` as unused, remove the import line near the top of `components/history-sidebar.tsx`:

```ts
import { useHistoryStore } from "@/stores/history-store";
```

If TypeScript doesn't flag it (another reference may exist), leave the import in place.

- [ ] **Step 3: Type-check clean**

Run: `cd E:/my_stable/viewcomfy/wavespeed-claude && npx tsc --noEmit`

Expected: zero errors.

- [ ] **Step 4: Commit**

```bash
git add components/history-sidebar.tsx
git commit -m "refactor(history-sidebar): drop inline Zustand cleanup; SSE handles it"
```

---

## Task 3: Fix Output trash handler

**Files:**
- Modify: `components/output-area.tsx`

Replace the broken `onRemove={() => remove(entry.id)}` with a handler that distinguishes local-only entries from server-backed ones and performs the server DELETE for the latter. The handler lives in the parent component (`OutputArea`) because that's where `username` and `remove` already are.

- [ ] **Step 1: Add `handleRemove` inside `OutputArea`**

Open `components/output-area.tsx`. Locate the end of the `todayEntries` memo (the `return merged.slice(0, 10);` at line 121, followed by `}, [entries, todayStart, serverToday, pending]);` at line 122). Directly after that line and before `const hasAny = ...` at line 124, add:

```ts
  // Trash handler for Output cards. Two categories:
  //   1) Local-only entry (no serverGenId — POST failed or legacy row):
  //      silent Zustand dismiss, no confirm, no network. Such a row
  //      is not in the server DB, so symmetry with History is trivial
  //      (History never rendered it either).
  //   2) Server-backed entry (has serverGenId — either a local entry
  //      that reached the server, or a remote serverToday row): confirm,
  //      DELETE /api/history, toast. Zustand cleanup happens via the
  //      SSE generation.deleted event landing in useGenerationEvents
  //      (single source of truth for cross-tab/device consistency).
  const handleRemove = React.useCallback(
    async (entry: HistoryEntry) => {
      if (typeof entry.serverGenId !== "number") {
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
      } catch (e) {
        toast.error(e instanceof Error ? e.message : "Delete failed");
      }
    },
    [remove, username]
  );
```

- [ ] **Step 2: Wire `handleRemove` into `OutputCard`**

Still in `OutputArea`, find the `OutputCard` render at line 159–165:

```tsx
<OutputCard
  key={entry.id}
  entry={entry}
  siblings={todayEntries}
  index={idx}
  onRemove={() => remove(entry.id)}
/>
```

Change only the `onRemove` prop:

```tsx
<OutputCard
  key={entry.id}
  entry={entry}
  siblings={todayEntries}
  index={idx}
  onRemove={() => handleRemove(entry)}
/>
```

Do NOT change any other prop or the `OutputCard` signature — the child still just calls `onRemove()`.

- [ ] **Step 3: Type-check**

Run: `cd E:/my_stable/viewcomfy/wavespeed-claude && npx tsc --noEmit`

Expected: zero errors.

- [ ] **Step 4: Dev-server sanity build**

Run: `cd E:/my_stable/viewcomfy/wavespeed-claude && npx next build 2>&1 | tail -30`

Expected: build succeeds (exits 0, no compilation errors). Warnings about unused vars may appear — only treat compilation errors as blockers.

- [ ] **Step 5: Commit**

```bash
git add components/output-area.tsx
git commit -m "fix(output-area): trash button now deletes from server + history"
```

---

## Task 4: Manual verification

**Files:** (no edits)

Manual browser testing. Requires two separate browser profiles (or incognito + regular) pointing at the same dev server and signed in as the same username. Locally, this is typically `http://localhost:3000` — confirm the port your dev server is using.

Start the dev server in one terminal:

```bash
cd E:/my_stable/viewcomfy/wavespeed-claude && npm run dev
```

- [ ] **Step 1: Setup two sessions**

Open the app in two browsers (Browser A and Browser B) with the same username. Both show an empty-to-normal Output panel and History sidebar.

Expected: both show the same history.

- [ ] **Step 2: Generate an image on A**

In Browser A, trigger a generation. Wait for completion.

Expected: completed tile appears in A's Output. Within ~2s, the same tile appears in B's Output (via SSE). Both History sidebars show the new row.

- [ ] **Step 3: Delete via Output trash on A (primary bug fix)**

Hover the completed tile in A's Output. Click the red trash button. Accept the `confirm` dialog.

Expected on A:
- Toast "Удалено" appears.
- Tile disappears from Output within ~1s (via SSE → Zustand cleanup + `useHistory` refetch).
- Row disappears from History sidebar.

Expected on B (within ~2s, no reload):
- Tile disappears from Output.
- Row disappears from History.

- [ ] **Step 4: Delete via Output trash on a cross-device (remote) tile**

Generate an image on A. Wait for B's Output to show the tile.

On B, click the Output trash on that tile → confirm.

Expected on B: toast, tile disappears from Output + History.
Expected on A (within ~2s): tile disappears from Output + History.

- [ ] **Step 5: Delete via History sidebar (regression check)**

Generate on A. On A, click the trash icon in the History sidebar → confirm.

Expected: same as Step 3 on both A and B.

- [ ] **Step 6: Originating-device delete (closes output-sync follow-up)**

Generate on A. Confirm A's Zustand still has the entry (the tile is rendered in A's Output as a local entry, not just a serverToday one — open React DevTools if needed, or confirm immediately after generation when the local-blob form is visible).

On B, click the trash icon in B's Output → confirm.

Expected on A (within ~2s): Output tile disappears AND the row leaves History. Before this plan, the Output tile would have lingered until reload.

- [ ] **Step 7: Cancel button during generation (no regression)**

Start a generation on A. Before it completes, click the red × (Cancel, not Trash) on the loading tile.

Expected: cancellation behaves as before. The trash-handler change is gated by `!isLoading` — it never fires during loading.

- [ ] **Step 8: Local-only dismiss (no-confirm path)**

Open DevTools Console on A and manually insert an entry without `serverGenId` (simulating a failed POST / pre-v3 legacy):

```js
useHistoryStore = window.__useHistoryStore; // if not exposed, use React DevTools
```

(If the store isn't globally exposed, a simpler check: find an entry that actually has no `serverGenId` in the persisted `localStorage["wavespeed-history"]` from prior sessions. If none exist, skip this step — the code path is a one-line guard and low risk.)

For an entry without `serverGenId`, clicking the trash button should:
- NOT show a `confirm` dialog.
- NOT make a DELETE request (check Network tab).
- Immediately remove the tile from Output.

- [ ] **Step 9: DELETE error path**

In Browser A, disable network (DevTools → Network → Offline). Click the Output trash on any completed tile → confirm.

Expected: `toast.error` with a fetch error message. Tile stays in Output. No Zustand mutation.

Re-enable network; next generation or manual refresh reconciles state.

- [ ] **Step 10: No commit — verification only**

If all steps passed, move on. If anything failed, fix the underlying issue and rerun the affected steps.

---

## Task 5: Update the `output-sync` spec to mark follow-up closed

**Files:**
- Modify: `docs/superpowers/specs/2026-04-12-output-sync-design.md:224-231`

The `output-sync` spec has an open follow-up note about the originating-device delete edge case. This plan closes it — update the note so future readers aren't misled.

- [ ] **Step 1: Update the follow-up note**

Open `docs/superpowers/specs/2026-04-12-output-sync-design.md`. Locate the section at lines 224–231 which currently reads:

```markdown
### Follow-ups still open

- The "originating-device delete" edge case flagged in final review
  (delete arrives from device B while device A still holds the Zustand
  entry with `serverGenId` for that row) is not yet handled. The row
  disappears from server history but the local Output card persists
  until the next manual interaction or reload. Low-priority; tracked
  here for future work.
```

Replace the bullet so the section reads:

```markdown
### Follow-ups still open

- The "originating-device delete" edge case (delete arrives from device
  B while device A still holds the Zustand entry with `serverGenId`)
  was closed by the `2026-04-12-output-delete-symmetry` work:
  `useGenerationEvents` now cleans Zustand on `generation.deleted`.
```

- [ ] **Step 2: Commit**

```bash
git add docs/superpowers/specs/2026-04-12-output-sync-design.md
git commit -m "docs(output-sync): mark originating-device-delete follow-up closed"
```

---

## Done criteria

- `npx tsc --noEmit` clean.
- `npx next build` succeeds.
- Manual verification Task 4 steps all pass.
- All commits on `main` (or the working branch for this task), in the order the tasks ran.
