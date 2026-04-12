# Cross-device Output sync Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Output panel reflects the user's completed generations from today across ALL devices within ≤2 seconds, via Server-Sent Events broadcast from the Next.js server to every connected client for that username.

**Architecture:** New `/api/history/stream` SSE endpoint + in-memory subscriber registry (`lib/sse-broadcast.ts`). `POST`/`DELETE /api/history` broadcast events. Client-side `useGenerationEvents` hook bridges SSE → existing `HISTORY_REFRESH_EVENT`. OutputArea merges server-today entries with Zustand entries, deduplicated by `serverGenId`.

**Tech Stack:** Next.js 15 streaming route handlers, React 19, TypeScript strict, SQLite (better-sqlite3), Zustand persist, `EventSource`. Single-instance deployment (multi-instance scale-out deferred — see spec "Future Work").

---

## Spec reference

`docs/superpowers/specs/2026-04-12-output-sync-design.md`

## Important architectural notes

- **Single-instance only.** The in-memory `Map<username, Set<controller>>` does not cross Node processes. If this app is ever horizontally scaled, swap the registry for a Redis pub/sub — out of scope here, documented in spec Future Work.
- **No new test runner.** The project uses manual verification via the dev server. Streaming endpoints are hard to unit-test; this plan relies on manual and browser-devtools verification only.
- **Coexists with BroadcastChannel.** Do NOT remove the existing `BroadcastChannel("wavespeed:history")` in `hooks/use-history.ts`. SSE is an additive cross-device layer.
- **Server auth is pre-existing** (`?username=X` query param, same as `GET /api/history`). Do NOT tighten in this plan.

## File Structure

### New files

- **`lib/sse-broadcast.ts`** — server-side in-memory subscriber registry and broadcast helper.
- **`app/api/history/stream/route.ts`** — SSE endpoint.
- **`hooks/use-generation-events.ts`** — client hook that opens an `EventSource` and bridges events into `HISTORY_REFRESH_EVENT`.

### Modified files

- **`lib/history-db.ts`** — add `getGenerationById(id)` helper to fetch a single row with its outputs (needed for the `generation.created` broadcast payload).
- **`app/api/history/route.ts`** — call `broadcastToUser` on POST success and DELETE success.
- **`components/output-area.tsx`** — call `useHistory` for today's server entries + `useGenerationEvents(username)`; merge + dedup server and Zustand entries; slice(0, 10).
- **`components/history-sidebar.tsx`** — export the `serverGenToHistoryEntry` adapter so `OutputArea` can reuse it, OR promote it to a shared location (see Task 5).

### No changes

- `stores/history-store.ts` — Zustand persistence unchanged.
- All other routes and components.

---

## Task 1: `getGenerationById` helper in `lib/history-db.ts`

**Files:**
- Modify: `lib/history-db.ts`

- [ ] **Step 1: Add helper after `getGenerations`**

Find the `getGenerations` function (around lines 170–206). Directly after its closing `}`, add:

```ts
export function getGenerationById(id: number): IGenerationRecord | null {
  const db = getDb();
  const gen = db
    .prepare(`SELECT * FROM generations WHERE id = ?`)
    .get(id) as IGenerationRecord | undefined;
  if (!gen) return null;
  const outs = db
    .prepare(`SELECT * FROM generation_outputs WHERE generation_id = ?`)
    .all(id) as IGenerationOutput[];
  gen.outputs = outs;
  return gen;
}
```

- [ ] **Step 2: Type-check compiles**

Run: `cd E:/my_stable/viewcomfy/wavespeed-claude && npx tsc --noEmit`
Expected: succeeds with zero errors.

- [ ] **Step 3: Commit**

```
git add lib/history-db.ts
git commit -m "feat(history-db): add getGenerationById helper"
```

---

## Task 2: `lib/sse-broadcast.ts` — subscriber registry

**Files:**
- Create: `lib/sse-broadcast.ts`

- [ ] **Step 1: Create the module**

```ts
/**
 * In-memory SSE subscriber registry.
 *
 * Holds per-username sets of ReadableStreamDefaultController so that
 * `broadcastToUser` can enqueue events to every connected client for
 * that username.
 *
 * Single-process only. For multi-instance deployment this would need
 * to be backed by Redis pub/sub (see spec Future Work).
 */

type Controller = ReadableStreamDefaultController<Uint8Array>;

interface Subscriber {
  controller: Controller;
  /** Per-connection heartbeat timer, cleared on unsubscribe. */
  heartbeat: ReturnType<typeof setInterval> | null;
}

const subscribers = new Map<string, Set<Subscriber>>();

const encoder = new TextEncoder();

const HEARTBEAT_MS = 25_000;

/**
 * Serialize a named SSE event. The `id:` line is advisory (we do not
 * implement ring-buffer catch-up; on reconnect the client refetches).
 */
function serialize(event: string, data: unknown): Uint8Array {
  const payload =
    `event: ${event}\n` +
    `data: ${JSON.stringify(data)}\n` +
    `\n`;
  return encoder.encode(payload);
}

function serializeComment(text: string): Uint8Array {
  return encoder.encode(`: ${text}\n\n`);
}

export function addSubscriber(
  username: string,
  controller: Controller
): Subscriber {
  const entry: Subscriber = { controller, heartbeat: null };
  let set = subscribers.get(username);
  if (!set) {
    set = new Set();
    subscribers.set(username, set);
  }
  set.add(entry);

  // Initial comment so the client knows the stream is live.
  try {
    controller.enqueue(serializeComment("connected"));
  } catch {
    // If even the first enqueue fails the client has gone away mid-open.
    // Remove immediately.
    set.delete(entry);
    if (set.size === 0) subscribers.delete(username);
    return entry;
  }

  entry.heartbeat = setInterval(() => {
    try {
      controller.enqueue(serializeComment("heartbeat"));
    } catch {
      // Controller is closed. The cancel() path on the route handler
      // will also remove us; this is defensive.
      removeSubscriber(username, entry);
    }
  }, HEARTBEAT_MS);

  return entry;
}

export function removeSubscriber(
  username: string,
  entry: Subscriber
): void {
  const set = subscribers.get(username);
  if (!set) return;
  set.delete(entry);
  if (set.size === 0) subscribers.delete(username);
  if (entry.heartbeat) {
    clearInterval(entry.heartbeat);
    entry.heartbeat = null;
  }
  try {
    entry.controller.close();
  } catch {
    // Already closed.
  }
}

/**
 * Fan out an event to every connected client for this username.
 * Dead controllers (enqueue throws) are removed from the registry.
 */
export function broadcastToUser(
  username: string,
  event: { type: string; data: unknown }
): void {
  const set = subscribers.get(username);
  if (!set || set.size === 0) return;
  const bytes = serialize(event.type, event.data);
  const dead: Subscriber[] = [];
  for (const sub of set) {
    try {
      sub.controller.enqueue(bytes);
    } catch {
      dead.push(sub);
    }
  }
  for (const d of dead) removeSubscriber(username, d);
}

/** Test / debug hook. */
export function _subscriberCount(username: string): number {
  return subscribers.get(username)?.size ?? 0;
}
```

- [ ] **Step 2: Type-check compiles**

Run: `npx tsc --noEmit`
Expected: succeeds.

- [ ] **Step 3: Commit**

```
git add lib/sse-broadcast.ts
git commit -m "feat(sse): add in-memory subscriber registry + broadcast helper"
```

---

## Task 3: `app/api/history/stream/route.ts` — SSE endpoint

**Files:**
- Create: `app/api/history/stream/route.ts`

- [ ] **Step 1: Create the file**

```ts
import { type NextRequest, NextResponse } from "next/server";
import { addSubscriber, removeSubscriber } from "@/lib/sse-broadcast";

// SSE connections are long-lived. maxDuration at 5 minutes keeps them
// tidy under proxy timeouts and forces a periodic reconnect even in
// the absence of network issues — which is good hygiene.
export const maxDuration = 300;

// Disable Next.js response caching for this route. SSE responses must
// never be cached; setting dynamic = 'force-dynamic' tells Next.js to
// always render fresh.
export const dynamic = "force-dynamic";

/**
 * GET /api/history/stream?username=X
 *
 * Opens an SSE stream of history events scoped to the given username.
 * Emits:
 *   event: generation.created   data: { ...ServerGeneration }
 *   event: generation.deleted   data: { id: number }
 *
 * Plus periodic `: heartbeat` comments to keep proxy connections warm.
 */
export async function GET(request: NextRequest) {
  const username = request.nextUrl.searchParams.get("username");
  if (!username) {
    return NextResponse.json({ error: "username is required" }, { status: 400 });
  }

  let unsubscribe: (() => void) | null = null;

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const entry = addSubscriber(username, controller);
      unsubscribe = () => removeSubscriber(username, entry);
      // If the request is aborted before cancel() fires (some runtimes
      // deliver only one of these), clean up here as a fallback.
      request.signal.addEventListener("abort", () => {
        unsubscribe?.();
        unsubscribe = null;
      });
    },
    cancel() {
      unsubscribe?.();
      unsubscribe = null;
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      // Nginx default buffers proxied responses — this header disables
      // that behavior per-response, keeping latency low.
      "X-Accel-Buffering": "no",
    },
  });
}
```

- [ ] **Step 2: Type-check compiles**

Run: `npx tsc --noEmit`
Expected: succeeds.

- [ ] **Step 3: Smoke test**

Start dev server: `npm run dev`. In the browser console (logged in as a user):

```js
const es = new EventSource("/api/history/stream?username=" + encodeURIComponent("test"));
es.onmessage = (e) => console.log("msg", e);
es.onopen = () => console.log("open");
es.onerror = (e) => console.log("error", e);
es.addEventListener("generation.created", (e) => console.log("created", e.data));
es.addEventListener("generation.deleted", (e) => console.log("deleted", e.data));
```

Expected: "open" log within ~1 second. The EventSource stays connected indefinitely. Observe network tab — the request should stay "pending" with Content-Type `text/event-stream`.

Call `es.close()` to disconnect.

- [ ] **Step 4: Commit**

```
git add app/api/history/stream/route.ts
git commit -m "feat(api/history/stream): SSE endpoint for history events"
```

---

## Task 4: Broadcast from `POST` and `DELETE`

**Files:**
- Modify: `app/api/history/route.ts`

- [ ] **Step 1: Add imports**

Near the top of `app/api/history/route.ts`, alongside the existing imports, add:

```ts
import { getGenerationById } from "@/lib/history-db";
import { broadcastToUser } from "@/lib/sse-broadcast";
```

Note: `saveGeneration`, `getGenerations`, `deleteGeneration`, `getHistoryImagesDir` are already imported from `@/lib/history-db`; adjust the existing import to include `getGenerationById` instead of adding a second import line.

- [ ] **Step 2: Broadcast on POST success**

Inside the POST handler, find the success return:

```ts
    return NextResponse.json({
      id,
      success: true,
      fullUrl: `/api/history/image/${encodeURIComponent(originalFilename)}`,
      thumbUrl: `/api/history/image/${encodeURIComponent(thumbFilename)}`,
      midUrl: `/api/history/image/${encodeURIComponent(midFilename)}`,
    });
```

Immediately BEFORE this return, insert:

```ts
    // Fan out the new row to every connected client of this username.
    // Errors are caught so a broadcast failure never affects the HTTP
    // response — clients will catch up on next reconnect's refetch.
    try {
      const newRow = getGenerationById(id);
      if (newRow) {
        broadcastToUser(username, {
          type: "generation.created",
          data: newRow,
        });
      }
    } catch (err) {
      console.error("[history POST] broadcast failed:", err);
    }
```

- [ ] **Step 3: Broadcast on DELETE success**

Inside the DELETE handler, find:

```ts
    const { deleted } = deleteGeneration(parseInt(id), username);
    return NextResponse.json({ success: deleted });
```

Replace with:

```ts
    const { deleted } = deleteGeneration(parseInt(id), username);
    if (deleted) {
      try {
        broadcastToUser(username, {
          type: "generation.deleted",
          data: { id: parseInt(id) },
        });
      } catch (err) {
        console.error("[history DELETE] broadcast failed:", err);
      }
    }
    return NextResponse.json({ success: deleted });
```

- [ ] **Step 4: Type-check compiles**

Run: `npx tsc --noEmit`
Expected: succeeds.

- [ ] **Step 5: Manual smoke test**

With dev server running and the EventSource open from Task 3's smoke test (adjust username to match your real login), trigger a generation. In the browser console you should see `created` log with the row's shape. Then delete the history entry from the sidebar — you should see `deleted` log.

- [ ] **Step 6: Commit**

```
git add app/api/history/route.ts
git commit -m "feat(api/history): broadcast SSE events on create and delete"
```

---

## Task 5: Promote `serverGenToHistoryEntry` adapter

**Files:**
- Modify: `components/history-sidebar.tsx`
- Create (or modify): a shared helper location

The existing `serverGenToHistoryEntry` function (lines ~62–82 of `components/history-sidebar.tsx`) adapts a `ServerGeneration` to a `HistoryEntry` shape that the `ImageDialog` expects. `OutputArea` needs the same conversion. Promote it to a shared module.

- [ ] **Step 1: Create `lib/server-gen-adapter.ts`**

New file:

```ts
import type { ServerGeneration } from "@/hooks/use-history";
import type { HistoryEntry } from "@/types/wavespeed";

export interface ParsedPromptData {
  prompt?: string;
  resolution?: string;
  aspectRatio?: string;
  outputFormat?: string;
  provider?: string;
  model?: string;
}

export function parsePromptData(raw: string): ParsedPromptData {
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (typeof parsed.prompt === "string") {
      return parsed as ParsedPromptData;
    }
    // viewcomfy node-prefixed prompt keys
    const textKey = Object.keys(parsed).find((k) => {
      const cleaned = k.replace(/^\d+-inputs-/, "").replace(/^\d+-/, "");
      return cleaned === "text" || cleaned === "prompt";
    });
    if (textKey && typeof parsed[textKey] === "string") {
      return { prompt: parsed[textKey] as string };
    }
    return {};
  } catch {
    return {};
  }
}

/**
 * Adapter: ServerGeneration (snake_case, SQLite-shape) → HistoryEntry
 * (zustand-shape expected by <ImageDialog>, <OutputCard>).
 */
export function serverGenToHistoryEntry(
  gen: ServerGeneration,
  data: ParsedPromptData,
  fullSrc: string
): HistoryEntry {
  return {
    id: String(gen.id),
    taskId: `server-${gen.id}`,
    provider: (data.provider as HistoryEntry["provider"]) || "wavespeed",
    prompt: data.prompt || "",
    model: (data.model as HistoryEntry["model"]) || "nano-banana-pro",
    aspectRatio: (data.aspectRatio as HistoryEntry["aspectRatio"]) || undefined,
    resolution: (data.resolution as HistoryEntry["resolution"]) || "2k",
    outputFormat: (data.outputFormat as HistoryEntry["outputFormat"]) || "png",
    status: "completed",
    createdAt: (() => {
      const iso = gen.created_at.includes("T")
        ? gen.created_at
        : gen.created_at.replace(" ", "T") + "Z";
      const t = Date.parse(iso);
      return Number.isNaN(t) ? Date.now() : t;
    })(),
    outputUrl: fullSrc,
    inputThumbnails: [],
    serverGenId: gen.id,
    confirmed: true,
  };
}
```

- [ ] **Step 2: Replace the inline definitions in `components/history-sidebar.tsx`**

Find the inline `parsePromptData` and `serverGenToHistoryEntry` functions (and their supporting interface `ParsedPromptData`) at the top of the file. Delete them.

Add an import:

```ts
import {
  parsePromptData,
  serverGenToHistoryEntry,
} from "@/lib/server-gen-adapter";
```

Do not change the call sites — they use the same names.

- [ ] **Step 3: Type-check compiles**

Run: `npx tsc --noEmit`
Expected: succeeds. If the `createdAt` computation for the server entry changed semantics, the `useMemo` around `createdAtMs` in `ServerEntryCard` still handles it — the existing logic was duplicated.

- [ ] **Step 4: Commit**

```
git add lib/server-gen-adapter.ts components/history-sidebar.tsx
git commit -m "refactor(history): extract server-gen adapter to shared module"
```

---

## Task 6: `hooks/use-generation-events.ts`

**Files:**
- Create: `hooks/use-generation-events.ts`

- [ ] **Step 1: Create the hook**

```ts
"use client";

import * as React from "react";
import { broadcastHistoryRefresh } from "@/hooks/use-history";

/**
 * Open an EventSource to /api/history/stream for the given username
 * and translate incoming events into the existing
 * `HISTORY_REFRESH_EVENT` bus (via `broadcastHistoryRefresh`). Every
 * mounted `useHistory` instance will refetch and rerender.
 *
 * Browsers' built-in EventSource auto-reconnects on network dropouts.
 * We additionally refetch on connection open, so any events missed
 * during a disconnect window are reconciled via the next server pull.
 *
 * No-op when `username` is null (not signed in).
 */
export function useGenerationEvents(username: string | null): void {
  React.useEffect(() => {
    if (!username) return;
    if (typeof window === "undefined") return;
    if (typeof EventSource === "undefined") return;

    const url = `/api/history/stream?username=${encodeURIComponent(username)}`;
    const es = new EventSource(url);

    const refresh = () => broadcastHistoryRefresh();

    // Both event types trigger the same local refresh bus — useHistory
    // listeners refetch. The event payload is intentionally unused
    // here: we rely on the fetch being cheap and idempotent.
    es.addEventListener("generation.created", refresh);
    es.addEventListener("generation.deleted", refresh);

    // Refetch on (re)connect so any missed events are reconciled.
    es.addEventListener("open", refresh);

    // Don't toast on error — EventSource auto-reconnects; an error
    // during reconnection attempts would be visible spam. Log once.
    es.addEventListener("error", () => {
      // EventSource.readyState === 0 means CONNECTING (reconnecting);
      // === 2 means CLOSED (gave up). We don't currently re-open on
      // CLOSED because modern browsers handle this themselves.
      console.debug("[use-generation-events] connection error", es.readyState);
    });

    return () => {
      es.close();
    };
  }, [username]);
}
```

- [ ] **Step 2: Type-check compiles**

Run: `npx tsc --noEmit`
Expected: succeeds.

- [ ] **Step 3: Commit**

```
git add hooks/use-generation-events.ts
git commit -m "feat(hooks): add useGenerationEvents SSE subscriber hook"
```

---

## Task 7: `OutputArea` merges server-today + Zustand

**Files:**
- Modify: `components/output-area.tsx`

The panel currently reads only from Zustand. Add: today's server entries via `useHistory`, SSE subscription via `useGenerationEvents`, merge + dedup.

- [ ] **Step 1: Add imports**

At the top of `components/output-area.tsx`, after the existing imports, add:

```ts
import { useUser } from "@/app/providers/user-provider";
import { useHistory, type ServerGeneration } from "@/hooks/use-history";
import { useGenerationEvents } from "@/hooks/use-generation-events";
import { parsePromptData, serverGenToHistoryEntry } from "@/lib/server-gen-adapter";
```

- [ ] **Step 2: Wire up data sources inside `OutputArea`**

Near the top of the `OutputArea` component body (after the existing `entries`/`remove`/`mounted` declarations), add:

```ts
  const { username } = useUser();
  // Fetch today's server-backed generations for this username. This
  // picks up completed rows from other devices. The endpoint filters
  // by date using ISO strings; we pass start/end of the local "today".
  const todayDateRange = React.useMemo(() => {
    const now = new Date();
    const start = new Date(now);
    start.setHours(0, 0, 0, 0);
    const end = new Date(now);
    end.setHours(23, 59, 59, 999);
    return { startDate: start, endDate: end };
  }, []);
  const { items: serverToday } = useHistory({
    username,
    startDate: todayDateRange.startDate,
    endDate: todayDateRange.endDate,
  });
  // Subscribe to server-pushed history events for near-real-time
  // cross-device sync. No-op when username is null.
  useGenerationEvents(username);
```

- [ ] **Step 3: Replace the `todayEntries` computation with a merged version**

Find:

```ts
  const todayStart = React.useMemo(() => startOfToday(), []);
  const todayEntries = React.useMemo(
    () =>
      entries
        .filter((e) => e.createdAt >= todayStart)
        .slice(0, 10),
    [entries, todayStart]
  );
```

Replace with:

```ts
  const todayStart = React.useMemo(() => startOfToday(), []);

  const todayEntries = React.useMemo(() => {
    // Zustand entries for today (may include in-flight + optimistic).
    const local = entries.filter((e) => e.createdAt >= todayStart);
    // Keys already present locally — don't duplicate them from server.
    const localServerGenIds = new Set(
      local.map((e) => e.serverGenId).filter((x): x is number => typeof x === "number")
    );

    // Server entries that are NOT represented by a local Zustand row.
    // These are cross-device completions (or rows from a reload where
    // the optimistic local entry was not persisted).
    const remote: HistoryEntry[] = [];
    for (const gen of serverToday as ServerGeneration[]) {
      if (localServerGenIds.has(gen.id)) continue;
      const firstImage = gen.outputs.find((o) =>
        o.content_type.startsWith("image/")
      );
      if (!firstImage) continue;
      const data = parsePromptData(gen.prompt_data);
      const base = firstImage.filepath.replace(/\.[^.]+$/, "");
      const thumbUrl = `/api/history/image/${encodeURIComponent(`thumb_${base}.jpg`)}`;
      const midUrl = `/api/history/image/${encodeURIComponent(`mid_${base}.jpg`)}`;
      const fullUrl = `/api/history/image/${encodeURIComponent(firstImage.filepath)}`;
      const adapted = serverGenToHistoryEntry(gen, data, midUrl);
      // The adapter uses `fullSrc` as `outputUrl`. Add preview/original
      // so Output-area's existing preview/originalUrl reads work the
      // same way they do for Zustand entries.
      remote.push({
        ...adapted,
        previewUrl: midUrl,
        originalUrl: fullUrl,
        outputUrl: midUrl,
      });
      // Suppress unused var warning for thumbUrl (not currently
      // surfaced to OutputArea — sidebar preloader handles it).
      void thumbUrl;
    }

    // Merge and sort desc by createdAt. Cap at 10.
    const merged = [...local, ...remote].sort(
      (a, b) => b.createdAt - a.createdAt
    );
    return merged.slice(0, 10);
  }, [entries, todayStart, serverToday]);
```

- [ ] **Step 4: Type-check compiles**

Run: `npx tsc --noEmit`
Expected: succeeds.

- [ ] **Step 5: Commit**

```
git add components/output-area.tsx
git commit -m "feat(output-area): merge cross-device server entries + SSE sync"
```

---

## Task 8: End-to-end manual verification

**Files:**
- No code changes.

- [ ] **Step 1: Start dev server**

`npm run dev`. Sign in as a user (note the username).

- [ ] **Step 2: Single-device regression**

Generate an image. Output shows the card. No regressions in existing behavior. Delete from sidebar. Card disappears from Output too.

- [ ] **Step 3: Two-device sync test**

Open the app in a second browser profile / incognito window pointed at the same dev server (or a real second device on the LAN — use `http://<local-ip>:3000`). Log in as the SAME username.

Generate on device A. Within ~2 seconds, device B's Output panel should show the new card. No reload required.

Delete on device A. Device B's Output updates within ~2 seconds.

- [ ] **Step 4: Reconnect test**

With two devices connected, stop the dev server. In devtools Network tab on device B, observe the `/api/history/stream` request goes red. Restart the dev server. The EventSource should auto-reconnect within ~3 seconds (browser backoff).

Generate on device A. Device B should pick it up on first post-reconnect event.

- [ ] **Step 5: Heartbeat test**

In devtools Network tab, click the `/api/history/stream` request and observe the response body. Every ~25 seconds a `: heartbeat` line should appear. This is how the connection survives proxy idle timeouts.

- [ ] **Step 6: In-flight exclusion test**

Generate on device A. While it's still generating (spinner visible on A), check device B's Output. Device B should NOT show a spinner card. Once A's generation completes, B's Output shows the completed card. (This is the "in-flight stays device-local" design decision.)

- [ ] **Step 7: Subscriber cleanup test**

Close device B's tab. On the server console (dev server terminal), there should be no errors. Optional sanity check: add a temporary `console.log("subs:", _subscriberCount(username))` inside the broadcast helper, and verify the count drops.

- [ ] **Step 8: Full production build**

`npm run build`. Must succeed.

- [ ] **Step 9: No commit needed**

This task is verification only. If temporary logging was added in Step 7, remove it before the final commit is tagged.

---

## Self-review checklist (for the engineer)

- [ ] Spec success criteria satisfied:
  - [ ] Cross-device sync within ≤2 seconds.
  - [ ] Deletions propagate.
  - [ ] In-flight stays device-local (no spinner on other device).
  - [ ] `npm run build` succeeds.
- [ ] No `sharp` or other server-heavy dependencies added.
- [ ] SSE endpoint correctly terminates on client disconnect (subscriber removed from registry).
- [ ] Heartbeat visible every ~25 seconds in the network tab.
- [ ] `BroadcastChannel` is NOT removed (still live for cross-tab same-device).
- [ ] Authentication follows existing pattern (`?username=X` query param).
- [ ] The Zustand persistence path is untouched.

## Known follow-ups (out of scope — do NOT implement)

- Multi-instance deployment via Redis pub/sub.
- Session-cookie auth on the SSE endpoint (pre-existing security posture unchanged).
- Ring-buffer event recovery.
- Polling fallback (the refetch-on-reconnect path is sufficient).

---

## Implementation log (2026-04-12)

All 7 implementation tasks shipped directly to `main`. Task 8 (manual E2E)
was partially automated (`npx tsc --noEmit` clean, `npm run build` succeeds
with `/api/history/stream` registered as a dynamic function route); the
two-device browser verification was handed to the human operator.

| # | Commit | Subject |
|---|--------|---------|
| 1 | `fb65155` | `feat(history-db): add getGenerationById helper` |
| 2 | `e349bbe` | `feat(sse): add in-memory subscriber registry + broadcast helper` |
| 3 | `3e494dd` | `feat(api/history/stream): SSE endpoint for history events` |
| 4 | `d16f9db` | `feat(api/history): broadcast SSE events on create and delete` |
| 5 | `5196e0f` | `refactor(history): extract server-gen adapter to shared module` |
| 6 | `278ba3d` | `feat(hooks): add useGenerationEvents SSE subscriber hook` |
| 7 | `498c27c` | `feat(output-area): merge cross-device server entries + SSE sync` |

### Post-implementation fix — pending-uuid dedup (`d446681`)

Browser testing surfaced a same-device race: the SSE `generation.created`
event fired in parallel with the POST response, so `useHistory` refetched
and the new server row entered the merge *before* the Zustand entry
received its `serverGenId`. Result: a brief duplicate card — the local
blob-URL entry rendered instantly, and a second card using the server's
`mid_<uuid>.jpg` URL flashed as a "broken" image while the browser
fetched bytes it hadn't cached yet. Once the POST response landed,
`serverGenId` was set, the dedup filter kicked in, and the duplicate
disappeared. Cross-device behavior was unaffected.

**Fix** (`components/output-area.tsx` + `hooks/use-history.ts`):

- Exported the existing private `extractUuid(filepath)` helper from
  `hooks/use-history.ts`.
- `OutputArea` now also subscribes to `lib/pending-history` via
  `useSyncExternalStore` and builds a `Set<uuid>` of in-flight uploads
  from THIS device.
- The server-row iteration skips any row whose output filepath uuid is
  in the pending set. The existing `serverGenId` filter still handles
  the post-race steady state (and any legacy rows with non-uuid
  filenames, for which `extractUuid` returns null).
- On other devices `pending` is empty, so cross-device rows flow
  through unchanged.
