# History Sync Mechanism Redesign — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace three concurrent history stores + four removal paths + multiple refresh triggers with a single `lib/history/` module that exposes one state-machine, one delete path, and zero public refresh triggers.

**Architecture:** Unified `HistoryEntry` with `state: "pending" | "live" | "deleting" | "removed"`. Single Zustand store. Server hydrates INTO the store via `applyServerRow` — the only function that decides "accept a server row" — protected by an invariant that forbids resurrection of DELETING/REMOVED entries. SSE patches in-place; refetch only on reconnect. Cross-tab via BroadcastChannel; cross-device via SSE; both feed the same state-machine.

**Tech Stack:** Next.js 15, React 19, Zustand 5, TypeScript 5, Vitest (added by this plan).

**Spec:** `docs/superpowers/specs/2026-04-13-history-sync-mechanism-redesign-design.md`

---

## Task 1: Set up Vitest infrastructure

**Files:**
- Create: `vitest.config.ts`
- Modify: `package.json` (add devDependencies + scripts)
- Create: `lib/__tests__/canary.test.ts`

- [ ] **Step 1: Install Vitest and React Testing Library**

```bash
npm install -D vitest @vitest/ui jsdom @testing-library/react @testing-library/jest-dom @testing-library/user-event
```

- [ ] **Step 2: Create `vitest.config.ts`**

```ts
import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./vitest.setup.ts"],
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "."),
    },
  },
});
```

- [ ] **Step 3: Create `vitest.setup.ts`**

```ts
import "@testing-library/jest-dom/vitest";
```

- [ ] **Step 4: Add scripts to `package.json`**

In the `"scripts"` block, add:
```json
"test": "vitest run",
"test:watch": "vitest",
"test:ui": "vitest --ui"
```

- [ ] **Step 5: Write a canary test**

`lib/__tests__/canary.test.ts`:
```ts
import { describe, it, expect } from "vitest";

describe("vitest infra", () => {
  it("runs and finds path alias", async () => {
    const mod = await import("@/lib/history-debug");
    expect(typeof mod.debugHistory).toBe("function");
  });
});
```

- [ ] **Step 6: Run the canary**

Run: `npm test`
Expected: PASS for the canary test.

- [ ] **Step 7: Commit**

```bash
git add vitest.config.ts vitest.setup.ts package.json package-lock.json lib/__tests__/canary.test.ts
git commit -m "$(cat <<'EOF'
chore(test): add Vitest + RTL infrastructure

Adds Vitest with jsdom environment, React Testing Library, and a canary
test verifying the @/ path alias works. No existing tests in repo —
this is the foundation for the lib/history rewrite test matrix.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: Scaffold `lib/history/` foundational files

Foundation files with no logic that other files depend on: types, debug, pending controls.

**Files:**
- Create: `lib/history/types.ts`
- Create: `lib/history/debug.ts`
- Create: `lib/history/pending.ts`

- [ ] **Step 1: Create `lib/history/types.ts`**

```ts
import type { TaskStatus } from "@/types/wavespeed";

export type EntryState = "pending" | "live" | "deleting" | "removed";

export interface HistoryEntry {
  id: string;
  serverGenId?: number;
  state: EntryState;

  prompt: string;
  provider: string;
  workflowName?: string;
  createdAt: number;
  status: TaskStatus;
  error: string | null;

  originalUrl?: string;
  outputUrl?: string;
  previewUrl?: string;
  thumbUrl?: string;

  localBlobUrls?: string[];

  confirmed: boolean;
}

export interface DateRange {
  from?: Date;
  to?: Date;
}

export interface NewPendingInput {
  uuid: string;
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

export interface ServerOutput {
  id: number;
  generation_id: number;
  filename: string;
  filepath: string;
  content_type: string;
  size: number;
}

export interface ServerGeneration {
  id: number;
  username: string;
  workflow_name: string;
  prompt_data: string;
  execution_time_seconds: number;
  created_at: string;
  status: string;
  outputs: ServerOutput[];
}
```

- [ ] **Step 2: Create `lib/history/debug.ts`**

Copy and lightly extend `lib/history-debug.ts` — same flag, same format, but with new event names that include the new state-machine vocabulary in JSDoc.

```ts
"use client";

/**
 * Dev-time logger for history state-machine transitions.
 *
 * Enable: localStorage.setItem("DEBUG_HISTORY_DELETE", "1");
 * Disable: localStorage.removeItem("DEBUG_HISTORY_DELETE");
 *
 * Event names follow the convention: <area>.<event>[.<outcome>]
 * Examples:
 *   deleteEntry.start, deleteEntry.commit, deleteEntry.error, deleteEntry.noop
 *   applyServerRow.insert, applyServerRow.confirm, applyServerRow.ignored
 *   hydrate.ok, hydrate.error, hydrate.cross-device-delete
 *   sse.open, sse.created, sse.deleted, sse.error
 *   broadcast.send, broadcast.recv
 */

function isEnabled(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return window.localStorage.getItem("DEBUG_HISTORY_DELETE") === "1";
  } catch {
    return false;
  }
}

export function debugHistory(event: string, payload?: unknown): void {
  if (!isEnabled()) return;
  const ts = new Date().toISOString().slice(11, 23);
  if (payload === undefined) {
    console.log(`[history:${ts}] ${event}`);
    return;
  }
  let serialized: string;
  try {
    serialized = JSON.stringify(payload);
  } catch {
    serialized = String(payload);
  }
  console.log(`[history:${ts}] ${event}  ${serialized}`);
}
```

- [ ] **Step 3: Create `lib/history/pending.ts`**

A small singleton that holds in-flight upload control callbacks (`retry`, `abort`). Not data — just side-effect handles. NOT exposed publicly through `index.ts`.

```ts
/**
 * In-flight upload control registry. Callbacks aren't serializable and
 * don't belong on the HistoryEntry data record. Module-private to lib/history.
 */

interface PendingControls {
  retry?: () => void;
  abort?: () => void;
}

const map = new Map<string, PendingControls>();

export function setPendingControls(uuid: string, controls: PendingControls): void {
  map.set(uuid, controls);
}

export function getPendingControls(uuid: string): PendingControls | undefined {
  return map.get(uuid);
}

export function clearPendingControls(uuid: string): void {
  map.delete(uuid);
}

/** Test-only: drop everything (e.g. test isolation). */
export function _resetPendingControls(): void {
  map.clear();
}
```

- [ ] **Step 4: TypeScript build green**

Run: `npm run build`
Expected: build succeeds (no new code is consumed yet).

- [ ] **Step 5: Commit**

```bash
git add lib/history/types.ts lib/history/debug.ts lib/history/pending.ts
git commit -m "$(cat <<'EOF'
feat(history): scaffold lib/history — types, debug, pending controls

Foundational files for the unified history module:
- types.ts: HistoryEntry with state field (pending|live|deleting|removed),
  DateRange, NewPendingInput, ServerGeneration re-export
- debug.ts: same flag-gated logger (DEBUG_HISTORY_DELETE), new event
  vocabulary documented in JSDoc
- pending.ts: in-flight upload retry/abort callback registry, not data

Consumers and remaining lib/history files come in subsequent commits.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: Build `lib/history/store.ts` — Zustand store + state helpers + `applyServerRow`

**Files:**
- Create: `lib/history/store.ts`
- Create: `lib/history/__tests__/store.test.ts`

- [ ] **Step 1: Write the failing tests for `applyServerRow` (U1-U5)**

`lib/history/__tests__/store.test.ts`:
```ts
import { describe, it, expect, beforeEach } from "vitest";
import { useHistoryStore, applyServerRow, _resetForTest } from "@/lib/history/store";
import type { ServerGeneration } from "@/lib/history/types";

const mkRow = (overrides: Partial<ServerGeneration> = {}): ServerGeneration => ({
  id: 100,
  username: "alice",
  workflow_name: "test",
  prompt_data: '{"prompt":"hi"}',
  execution_time_seconds: 1,
  created_at: new Date().toISOString(),
  status: "completed",
  outputs: [
    {
      id: 1,
      generation_id: 100,
      filename: "out.png",
      filepath: "550e8400-e29b-41d4-a716-446655440000.png",
      content_type: "image/png",
      size: 1024,
    },
  ],
  ...overrides,
});

beforeEach(() => _resetForTest());

describe("applyServerRow", () => {
  it("U1: inserts new row as state=live", () => {
    applyServerRow(mkRow({ id: 100 }));
    const entries = useHistoryStore.getState().entries;
    expect(entries).toHaveLength(1);
    expect(entries[0].state).toBe("live");
    expect(entries[0].serverGenId).toBe(100);
    expect(entries[0].confirmed).toBe(true);
  });

  it("U2: merges metadata for existing LIVE, keeps blob URLs", () => {
    applyServerRow(mkRow({ id: 100 }));
    // Manually set a blob URL on the entry to simulate local-tab origin
    useHistoryStore.setState((s) => ({
      entries: s.entries.map((e) =>
        e.serverGenId === 100 ? { ...e, outputUrl: "blob:x" } : e
      ),
    }));
    applyServerRow(mkRow({ id: 100, prompt_data: '{"prompt":"updated"}' }));
    const entry = useHistoryStore.getState().entries.find((e) => e.serverGenId === 100)!;
    expect(entry.outputUrl).toBe("blob:x");           // blob URL preserved
    expect(entry.prompt).toBe("updated");              // metadata updated
  });

  it("U3: ignores existing DELETING entry", () => {
    applyServerRow(mkRow({ id: 100 }));
    const id = useHistoryStore.getState().entries[0].id;
    useHistoryStore.setState((s) => ({
      entries: s.entries.map((e) => (e.id === id ? { ...e, state: "deleting" } : e)),
    }));
    applyServerRow(mkRow({ id: 100 }));               // server tries to update
    expect(useHistoryStore.getState().entries[0].state).toBe("deleting");  // unchanged
  });

  it("U4: ignores existing REMOVED entry", () => {
    applyServerRow(mkRow({ id: 100 }));
    const id = useHistoryStore.getState().entries[0].id;
    useHistoryStore.setState((s) => ({
      entries: s.entries.map((e) => (e.id === id ? { ...e, state: "removed" } : e)),
    }));
    applyServerRow(mkRow({ id: 100 }));
    expect(useHistoryStore.getState().entries[0].state).toBe("removed");
  });

  it("U5: PENDING + matching server row → LIVE with serverGenId, blob URLs preserved", () => {
    // Seed a pending entry with a matching uuid
    useHistoryStore.setState({
      entries: [
        {
          id: "550e8400-e29b-41d4-a716-446655440000",
          state: "pending",
          confirmed: false,
          prompt: "hi",
          provider: "wavespeed",
          createdAt: Date.now(),
          status: "completed",
          error: null,
          outputUrl: "blob:y",
        },
      ],
    });
    applyServerRow(mkRow({ id: 200 }));
    const entry = useHistoryStore.getState().entries[0];
    expect(entry.state).toBe("live");
    expect(entry.confirmed).toBe(true);
    expect(entry.serverGenId).toBe(200);
    expect(entry.outputUrl).toBe("blob:y");           // blob URL preserved
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- store.test`
Expected: FAIL with "module not found" or "function not exported".

- [ ] **Step 3: Implement `lib/history/store.ts`**

```ts
"use client";

import { create } from "zustand";
import { extractUuid } from "@/lib/history/util";   // created in Task 4
import { debugHistory } from "@/lib/history/debug";
import type { EntryState, HistoryEntry, ServerGeneration } from "@/lib/history/types";

interface StoreState {
  entries: HistoryEntry[];
  error: string | null;
}

export const useHistoryStore = create<StoreState>(() => ({
  entries: [],
  error: null,
}));

// === STATE HELPERS (private to module) ===

export function setStateOf(id: string, next: EntryState): void {
  useHistoryStore.setState((s) => ({
    entries: s.entries.map((e) => (e.id === id ? { ...e, state: next } : e)),
  }));
}

export function markRemoved(id: string): void {
  setStateOf(id, "removed");
}

export function rollbackDeletion(id: string): void {
  setStateOf(id, "live");
}

// === SERVER → STORE INGESTION ===

/** The single decision point for "accept a server row". Invariant 2:
 *  never resurrects DELETING/REMOVED. */
export function applyServerRow(row: ServerGeneration): void {
  const firstFile = row.outputs[0]?.filepath ?? "";
  const uuid = extractUuid(firstFile) ?? `server-${row.id}`;
  const existing = useHistoryStore.getState().entries.find(
    (e) => e.id === uuid || e.serverGenId === row.id
  );

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
    useHistoryStore.setState((s) => ({
      entries: s.entries.map((e) =>
        e.id === uuid
          ? {
              ...e,
              serverGenId: row.id,
              state: "live",
              confirmed: true,
              createdAt: Date.parse(row.created_at),
              workflowName: fromServer.workflowName,
              prompt: fromServer.prompt,
            }
          : e
      ),
    }));
    debugHistory("applyServerRow.confirm", { id: uuid, serverGenId: row.id });
    return;
  }

  // existing.state === "live": merge metadata, keep blob URLs
  useHistoryStore.setState((s) => ({
    entries: s.entries.map((e) => (e.id === uuid ? mergeKeepingBlobs(e, fromServer) : e)),
  }));
}

function mergeKeepingBlobs(local: HistoryEntry, server: HistoryEntry): HistoryEntry {
  const isBlob = (u?: string) => typeof u === "string" && u.startsWith("blob:");
  return {
    ...server,
    id: local.id,                                     // never re-key
    state: local.state,
    outputUrl: isBlob(local.outputUrl) ? local.outputUrl : server.outputUrl,
    originalUrl: isBlob(local.originalUrl) ? local.originalUrl : server.originalUrl,
    previewUrl: isBlob(local.previewUrl) ? local.previewUrl : server.previewUrl,
    thumbUrl: isBlob(local.thumbUrl) ? local.thumbUrl : server.thumbUrl,
    localBlobUrls: local.localBlobUrls,
  };
}

function serverGenToEntry(row: ServerGeneration, uuid: string): HistoryEntry {
  let prompt = "";
  let workflowName: string | undefined = row.workflow_name;
  try {
    const parsed = JSON.parse(row.prompt_data) as { prompt?: string; workflow?: string };
    prompt = parsed.prompt ?? "";
    workflowName = parsed.workflow ?? row.workflow_name;
  } catch {
    // Malformed prompt_data — keep prompt as "".
  }
  const firstImage = row.outputs.find((o) => o.content_type.startsWith("image/"));
  const filename = firstImage?.filepath ?? "";
  return {
    id: uuid,
    serverGenId: row.id,
    state: "live",
    confirmed: true,
    prompt,
    provider: "wavespeed",                            // server doesn't store provider yet
    workflowName,
    createdAt: Date.parse(row.created_at),
    status: "completed",
    error: null,
    originalUrl: filename ? `/api/history/image/${filename}` : undefined,
    outputUrl: filename
      ? `/api/history/image/mid_${filename.replace(/\.(png|jpg|jpeg|webp)$/i, ".jpg")}`
      : undefined,
    thumbUrl: filename
      ? `/api/history/image/thumb_${filename.replace(/\.(png|jpg|jpeg|webp)$/i, ".jpg")}`
      : undefined,
  };
}

/** Test-only: clear store between tests. */
export function _resetForTest(): void {
  useHistoryStore.setState({ entries: [], error: null });
}
```

- [ ] **Step 4: Run tests to verify all five pass**

Run: `npm test -- store.test`
Expected: PASS U1, U2, U3, U4, U5.

- [ ] **Step 5: Commit**

```bash
git add lib/history/store.ts lib/history/__tests__/store.test.ts
git commit -m "$(cat <<'EOF'
feat(history): store + applyServerRow with invariant 2 (no resurrection)

Zustand store with private state helpers (setStateOf, markRemoved,
rollbackDeletion) and the single server-ingestion function
applyServerRow. The only place that decides whether to accept a server
row — and the only place that enforces invariant 2: DELETING/REMOVED
entries are never resurrected by server input.

Tests U1-U5 cover insert, merge-keeping-blobs, ignore-deleting,
ignore-removed, and PENDING-to-LIVE confirmation.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: Add `extractUuid` util + `applyServerList` cross-device-delete logic

**Files:**
- Create: `lib/history/util.ts`
- Modify: `lib/history/store.ts` (add `applyServerList`)
- Modify: `lib/history/__tests__/store.test.ts` (add U6-U8)

- [ ] **Step 1: Create `lib/history/util.ts`**

```ts
/**
 * Extract uuid from a server-history filepath. Files are stored as
 * <uuid>.<ext>. Returns null for legacy non-uuid filenames.
 */
export function extractUuid(filepath: string): string | null {
  const m = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\./i.exec(
    filepath
  );
  return m ? m[1].toLowerCase() : null;
}
```

- [ ] **Step 2: Write failing tests U6-U8**

Append to `lib/history/__tests__/store.test.ts`:
```ts
import { applyServerList } from "@/lib/history/store";

describe("applyServerList cross-device delete", () => {
  it("U6: LIVE entry with serverGenId absent from response → REMOVED", () => {
    applyServerRow(mkRow({ id: 100, created_at: "2026-04-13T10:00:00Z" }));
    applyServerRow(mkRow({ id: 200, created_at: "2026-04-13T11:00:00Z" }));
    expect(useHistoryStore.getState().entries.filter(e => e.state === "live")).toHaveLength(2);

    // Server response now only contains id=200; id=100 was deleted on another device.
    applyServerList([mkRow({ id: 200, created_at: "2026-04-13T11:00:00Z" })], { offset: 0 });

    const states = useHistoryStore.getState().entries.map((e) => ({
      serverGenId: e.serverGenId, state: e.state,
    }));
    expect(states).toContainEqual({ serverGenId: 100, state: "removed" });
    expect(states).toContainEqual({ serverGenId: 200, state: "live" });
  });

  it("U7: with offset > 0, cross-device-delete is skipped (pagination case)", () => {
    applyServerRow(mkRow({ id: 100, created_at: "2026-04-13T10:00:00Z" }));
    applyServerList([mkRow({ id: 200, created_at: "2026-04-13T11:00:00Z" })], { offset: 20 });
    const entry = useHistoryStore.getState().entries.find((e) => e.serverGenId === 100)!;
    expect(entry.state).toBe("live");                 // not removed because offset > 0
  });

  it("U8: entry with createdAt older than oldest in response is preserved", () => {
    // Old entry from yesterday
    applyServerRow(mkRow({ id: 100, created_at: "2026-04-12T10:00:00Z" }));
    // Server response contains only today's rows
    applyServerList([mkRow({ id: 200, created_at: "2026-04-13T11:00:00Z" })], { offset: 0 });
    const entry = useHistoryStore.getState().entries.find((e) => e.serverGenId === 100)!;
    expect(entry.state).toBe("live");                 // outside response window → preserved
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `npm test -- store.test`
Expected: FAIL on U6, U7, U8 (`applyServerList not exported`).

- [ ] **Step 4: Implement `applyServerList` in `lib/history/store.ts`**

Append after `applyServerRow`:
```ts
export interface HydrateOpts {
  offset?: number;
}

export function applyServerList(rows: ServerGeneration[], opts: HydrateOpts): void {
  const incomingByGenId = new Map(rows.map((r) => [r.id, r]));
  for (const row of rows) applyServerRow(row);

  if (rows.length === 0) return;
  if (opts.offset && opts.offset > 0) return;

  const oldest = Math.min(...rows.map((r) => Date.parse(r.created_at)));
  const state = useHistoryStore.getState();
  const toRemove: string[] = [];
  for (const e of state.entries) {
    if (e.state !== "live") continue;
    if (typeof e.serverGenId !== "number") continue;
    if (incomingByGenId.has(e.serverGenId)) continue;
    if (e.createdAt < oldest) continue;
    toRemove.push(e.id);
    debugHistory("hydrate.cross-device-delete", {
      id: e.id, serverGenId: e.serverGenId,
    });
  }
  for (const id of toRemove) markRemoved(id);
}
```

- [ ] **Step 5: Run tests**

Run: `npm test -- store.test`
Expected: PASS U6, U7, U8 (and U1-U5 still pass).

- [ ] **Step 6: Commit**

```bash
git add lib/history/util.ts lib/history/store.ts lib/history/__tests__/store.test.ts
git commit -m "$(cat <<'EOF'
feat(history): applyServerList + cross-device delete via response absence

applyServerList iterates rows through applyServerRow, then implements
invariant 7: a LIVE entry whose serverGenId is absent from the server
response is marked REMOVED, but only on the first page (offset=0) and
only within the response time window. Pagination case (offset>0) and
out-of-window entries are left alone.

This is the mechanism that makes cross-device delete propagate
automatically: phone deletes X → next /api/history GET on PC doesn't
include X → PC's store transitions X to REMOVED → both Output strip
and History sidebar drop X simultaneously.

Tests U6, U7, U8.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: Build `lib/history/hydrate.ts` with race-guard tests

**Files:**
- Create: `lib/history/hydrate.ts`
- Create: `lib/history/__tests__/hydrate.test.ts`

- [ ] **Step 1: Write failing tests U16-U18**

`lib/history/__tests__/hydrate.test.ts`:
```ts
import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { hydrateFromServer, _resetHydrateForTest } from "@/lib/history/hydrate";
import { useHistoryStore, _resetForTest } from "@/lib/history/store";

beforeEach(() => {
  _resetForTest();
  _resetHydrateForTest();
  vi.useFakeTimers();
  global.fetch = vi.fn();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const mockOk = (rows: unknown[]) =>
  (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
    ok: true,
    json: async () => rows,
  } as Response);

describe("hydrateFromServer", () => {
  it("U16: concurrent calls share one fetch", async () => {
    mockOk([]);
    const p1 = hydrateFromServer({ username: "alice" });
    const p2 = hydrateFromServer({ username: "alice" });
    expect(p1).toBe(p2);
    await vi.runAllTimersAsync();
    await p1;
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  it("U17: stale response is discarded if newer request fired", async () => {
    let resolveFirst!: (v: unknown) => void;
    let resolveSecond!: (v: unknown) => void;
    (global.fetch as ReturnType<typeof vi.fn>)
      .mockImplementationOnce(() => new Promise((r) => { resolveFirst = r; }))
      .mockImplementationOnce(() => new Promise((r) => { resolveSecond = r; }));

    const p1 = hydrateFromServer({ username: "alice" });
    await vi.advanceTimersByTimeAsync(60);
    // Fire a second hydration before first resolves
    _resetHydrateForTest();   // simulate next debounce window opening
    const p2 = hydrateFromServer({ username: "alice" });
    await vi.advanceTimersByTimeAsync(60);

    // Resolve the SECOND first (newer reqId), then first (stale)
    resolveSecond({ ok: true, json: async () => [{ id: 999 }] });
    await p2;
    resolveFirst({ ok: true, json: async () => [{ id: 1 }] });
    await p1;

    // Stale response from p1 should be ignored; store should reflect p2.
    const ids = useHistoryStore.getState().entries.map((e) => e.serverGenId);
    expect(ids).not.toContain(1);
  });

  it("U18: 5 rapid calls collapse to one fetch via 50ms debounce", async () => {
    mockOk([]);
    for (let i = 0; i < 5; i++) hydrateFromServer({ username: "alice" });
    await vi.runAllTimersAsync();
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- hydrate.test`
Expected: FAIL on import error.

- [ ] **Step 3: Implement `lib/history/hydrate.ts`**

```ts
"use client";

import { applyServerList, useHistoryStore } from "@/lib/history/store";
import { debugHistory } from "@/lib/history/debug";
import type { ServerGeneration, DateRange } from "@/lib/history/types";

export interface HydrateOpts {
  username: string;
  range?: DateRange;
  offset?: number;
  limit?: number;
}

const HYDRATE_DEBOUNCE_MS = 50;
const PAGE_SIZE_DEFAULT = 20;

let activeReqId = 0;
let pendingHydrate: Promise<void> | null = null;
let debounceTimer: ReturnType<typeof setTimeout> | null = null;

function buildUrl(opts: HydrateOpts): string {
  const sp = new URLSearchParams();
  sp.set("username", opts.username);
  if (opts.range?.from) {
    const d = new Date(opts.range.from);
    d.setHours(0, 0, 0, 0);
    sp.set("startDate", d.toISOString());
  }
  if (opts.range?.to) {
    const d = new Date(opts.range.to);
    d.setHours(23, 59, 59, 999);
    sp.set("endDate", d.toISOString());
  }
  sp.set("limit", String(opts.limit ?? PAGE_SIZE_DEFAULT));
  sp.set("offset", String(opts.offset ?? 0));
  return `/api/history?${sp.toString()}`;
}

export function hydrateFromServer(opts: HydrateOpts): Promise<void> {
  if (debounceTimer) clearTimeout(debounceTimer);
  if (pendingHydrate) return pendingHydrate;

  pendingHydrate = new Promise((resolve) => {
    debounceTimer = setTimeout(async () => {
      const myReq = ++activeReqId;
      try {
        const res = await fetch(buildUrl(opts), { cache: "no-store" });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const rows = (await res.json()) as ServerGeneration[];
        if (myReq !== activeReqId) return;
        applyServerList(rows, { offset: opts.offset ?? 0 });
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

/** Test-only: reset internal state. */
export function _resetHydrateForTest(): void {
  activeReqId = 0;
  pendingHydrate = null;
  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = null;
}
```

- [ ] **Step 4: Run tests**

Run: `npm test -- hydrate.test`
Expected: PASS U16, U17, U18.

- [ ] **Step 5: Commit**

```bash
git add lib/history/hydrate.ts lib/history/__tests__/hydrate.test.ts
git commit -m "$(cat <<'EOF'
feat(history): hydrate.ts with race-guard, dedup, and 50ms debounce

Internal hydrateFromServer is the single entry point for /api/history
GET. activeReqId discards stale responses; pendingHydrate dedupes
concurrent callers (they share one Promise); 50ms debounce collapses
storms (mount + SSE open + BroadcastChannel + refetch firing in the
same tick).

Tests U16, U17, U18.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 6: Build `lib/history/mutations.ts` — `deleteEntry` and pending lifecycle

**Files:**
- Create: `lib/history/mutations.ts`
- Modify: `lib/history/pending.ts` (no changes; add docstring noting mutations.ts uses it)
- Create: `lib/history/__tests__/mutations.test.ts`

- [ ] **Step 1: Write failing tests U9-U15**

`lib/history/__tests__/mutations.test.ts`:
```ts
import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { deleteEntry, addPendingEntry, setUsernameForTest } from "@/lib/history/mutations";
import { useHistoryStore, applyServerRow, _resetForTest } from "@/lib/history/store";
import { setPendingControls, _resetPendingControls } from "@/lib/history/pending";
import type { ServerGeneration } from "@/lib/history/types";

const mkRow = (id: number, uuid = "550e8400-e29b-41d4-a716-446655440000"): ServerGeneration => ({
  id, username: "alice", workflow_name: "test",
  prompt_data: '{"prompt":"hi"}', execution_time_seconds: 1,
  created_at: new Date().toISOString(), status: "completed",
  outputs: [{ id: 1, generation_id: id, filename: "out.png",
    filepath: `${uuid}.png`, content_type: "image/png", size: 1024 }],
});

beforeEach(() => {
  _resetForTest();
  _resetPendingControls();
  setUsernameForTest("alice");
  global.fetch = vi.fn();
  global.URL.revokeObjectURL = vi.fn();
});
afterEach(() => vi.restoreAllMocks());

describe("deleteEntry", () => {
  it("U9: PENDING entry → REMOVED, no fetch, abort called", async () => {
    const abort = vi.fn();
    addPendingEntry({
      uuid: "abc", prompt: "hi", provider: "wavespeed",
      createdAt: Date.now(), localBlobUrls: ["blob:foo"],
    });
    setPendingControls("abc", { abort });
    await deleteEntry("abc");
    expect(abort).toHaveBeenCalled();
    expect(global.fetch).not.toHaveBeenCalled();
    const entry = useHistoryStore.getState().entries.find((e) => e.id === "abc")!;
    expect(entry.state).toBe("removed");
  });

  it("U10: LIVE happy path → DELETING → REMOVED, fetch DELETE called", async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: true } as Response);
    applyServerRow(mkRow(100));
    const id = useHistoryStore.getState().entries[0].id;
    await deleteEntry(id);
    expect(global.fetch).toHaveBeenCalledWith(
      "/api/history?id=100&username=alice", { method: "DELETE" }
    );
    expect(useHistoryStore.getState().entries[0].state).toBe("removed");
  });

  it("U11: LIVE with HTTP 500 → rollback to LIVE, toast.error called", async () => {
    const toastModule = await import("sonner");
    const errSpy = vi.spyOn(toastModule.toast, "error");
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: false, status: 500 } as Response);
    applyServerRow(mkRow(100));
    const id = useHistoryStore.getState().entries[0].id;
    await deleteEntry(id);
    expect(useHistoryStore.getState().entries[0].state).toBe("live");
    expect(errSpy).toHaveBeenCalled();
  });

  it("U12: idempotent on DELETING", async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: true } as Response);
    applyServerRow(mkRow(100));
    const id = useHistoryStore.getState().entries[0].id;
    const p1 = deleteEntry(id);
    const p2 = deleteEntry(id);                       // second call while first in flight
    await Promise.all([p1, p2]);
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  it("U13: idempotent on REMOVED", async () => {
    applyServerRow(mkRow(100));
    const id = useHistoryStore.getState().entries[0].id;
    useHistoryStore.setState((s) => ({
      entries: s.entries.map((e) => (e.id === id ? { ...e, state: "removed" } : e)),
    }));
    await deleteEntry(id);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("U14: deleteEntry(serverGenId: number) finds by serverGenId", async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: true } as Response);
    applyServerRow(mkRow(100));
    await deleteEntry(100);
    expect(useHistoryStore.getState().entries[0].state).toBe("removed");
  });

  it("U15: skipServerDelete=true skips fetch", async () => {
    applyServerRow(mkRow(100));
    await deleteEntry(100, { skipServerDelete: true });
    expect(global.fetch).not.toHaveBeenCalled();
    expect(useHistoryStore.getState().entries[0].state).toBe("removed");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- mutations.test`
Expected: FAIL on import.

- [ ] **Step 3: Implement `lib/history/mutations.ts`**

```ts
"use client";

import { toast } from "sonner";
import {
  useHistoryStore,
  setStateOf,
  markRemoved,
  rollbackDeletion,
  applyServerRow,
} from "@/lib/history/store";
import { broadcast } from "@/lib/history/broadcast";          // created in Task 7
import { getPendingControls, setPendingControls, clearPendingControls } from "@/lib/history/pending";
import { debugHistory } from "@/lib/history/debug";
import type { HistoryEntry, NewPendingInput } from "@/lib/history/types";

const ANIMATION_HOLD_MS = 0;

let currentUsername: string | null = null;

/** Set by useGenerationEvents on mount. Read by deleteEntry. */
export function setCurrentUsername(username: string | null): void {
  currentUsername = username;
}

/** Test-only convenience to seed username without mounting hooks. */
export function setUsernameForTest(username: string | null): void {
  currentUsername = username;
}

function findEntry(idOrServerGenId: string | number): HistoryEntry | undefined {
  const entries = useHistoryStore.getState().entries;
  if (typeof idOrServerGenId === "number") {
    return entries.find((e) => e.serverGenId === idOrServerGenId);
  }
  return entries.find((e) => e.id === idOrServerGenId);
}

function revokeBlobs(urls: string[] | undefined): void {
  if (!urls) return;
  for (const u of urls) {
    if (!u || !u.startsWith("blob:")) continue;
    try { URL.revokeObjectURL(u); } catch { /* ignore */ }
  }
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export async function deleteEntry(
  idOrServerGenId: string | number,
  opts?: { skipServerDelete?: boolean }
): Promise<void> {
  const entry = findEntry(idOrServerGenId);
  if (!entry) return;

  if (entry.state === "deleting" || entry.state === "removed") {
    debugHistory("deleteEntry.noop", { id: entry.id, state: entry.state });
    return;
  }

  if (entry.state === "pending") {
    debugHistory("deleteEntry.pending", { id: entry.id });
    getPendingControls(entry.id)?.abort?.();
    clearPendingControls(entry.id);
    markRemoved(entry.id);
    revokeBlobs(entry.localBlobUrls);
    broadcast.post({ type: "delete", id: entry.id });
    return;
  }

  // LIVE
  setStateOf(entry.id, "deleting");
  debugHistory("deleteEntry.start", { id: entry.id, serverGenId: entry.serverGenId });
  broadcast.post({ type: "delete", id: entry.id, serverGenId: entry.serverGenId });

  if (typeof entry.serverGenId !== "number") {
    markRemoved(entry.id);
    debugHistory("deleteEntry.no-server-id", { id: entry.id });
    return;
  }

  if (opts?.skipServerDelete) {
    if (ANIMATION_HOLD_MS > 0) await sleep(ANIMATION_HOLD_MS);
    markRemoved(entry.id);
    revokeBlobs(entry.localBlobUrls);
    debugHistory("deleteEntry.commit.no-server", { id: entry.id });
    return;
  }

  if (!currentUsername) {
    rollbackDeletion(entry.id);
    debugHistory("deleteEntry.no-username", { id: entry.id });
    return;
  }

  const url = `/api/history?id=${entry.serverGenId}&username=${encodeURIComponent(currentUsername)}`;
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

// === Pending lifecycle ===

export function addPendingEntry(input: NewPendingInput): void {
  const entry: HistoryEntry = {
    id: input.uuid,
    state: "pending",
    confirmed: false,
    prompt: input.prompt,
    provider: input.provider,
    workflowName: input.workflowName,
    createdAt: input.createdAt,
    status: "pending",
    error: null,
    thumbUrl: input.thumbUrl,
    previewUrl: input.previewUrl,
    originalUrl: input.originalUrl,
    outputUrl: input.outputUrl,
    localBlobUrls: input.localBlobUrls,
  };
  useHistoryStore.setState((s) => ({ entries: [entry, ...s.entries] }));
  debugHistory("addPendingEntry", { id: input.uuid });
}

export function updatePendingEntry(
  uuid: string,
  patch: Partial<Pick<HistoryEntry, "thumbUrl" | "previewUrl" | "originalUrl" | "outputUrl" | "localBlobUrls">>
): void {
  useHistoryStore.setState((s) => ({
    entries: s.entries.map((e) => (e.id === uuid ? { ...e, ...patch } : e)),
  }));
}

export function confirmPendingEntry(
  uuid: string,
  payload: { serverGenId: number; serverUrls: { thumb?: string; mid?: string; full?: string } }
): void {
  useHistoryStore.setState((s) => ({
    entries: s.entries.map((e) =>
      e.id === uuid
        ? {
            ...e,
            serverGenId: payload.serverGenId,
            state: "live" as const,
            confirmed: true,
            status: "completed" as const,
            // Server URLs are made available; blob URLs stay until natural revoke.
            originalUrl: payload.serverUrls.full ?? e.originalUrl,
            outputUrl: payload.serverUrls.mid ?? e.outputUrl,
            thumbUrl: payload.serverUrls.thumb ?? e.thumbUrl,
          }
        : e
    ),
  }));
  clearPendingControls(uuid);
  debugHistory("confirmPendingEntry", { uuid, serverGenId: payload.serverGenId });
}

export function markPendingError(uuid: string, message: string): void {
  useHistoryStore.setState((s) => ({
    entries: s.entries.map((e) =>
      e.id === uuid ? { ...e, error: message, status: "failed" as const } : e
    ),
  }));
  debugHistory("markPendingError", { uuid, message });
}

export { setPendingControls, getPendingControls };
```

- [ ] **Step 4: Run tests (will fail until Task 7 ships broadcast.ts)**

Run: `npm test -- mutations.test`
Expected: FAIL on import of `@/lib/history/broadcast`.

- [ ] **Step 5: Create stub `lib/history/broadcast.ts` (minimal, real impl in Task 7)**

```ts
"use client";
export const broadcast = { post(_: unknown): void { /* stub for Task 7 */ } };
```

- [ ] **Step 6: Run tests**

Run: `npm test -- mutations.test`
Expected: PASS U9-U15.

- [ ] **Step 7: Commit**

```bash
git add lib/history/mutations.ts lib/history/broadcast.ts lib/history/__tests__/mutations.test.ts
git commit -m "$(cat <<'EOF'
feat(history): mutations.ts — deleteEntry single-path + pending lifecycle

deleteEntry is the single removal path for Output, Sidebar, SSE,
BroadcastChannel, and any future shortcut. Idempotent on DELETING and
REMOVED. PENDING goes straight to REMOVED with abort() callback.
LIVE does optimistic state-transition + async DELETE + rollback on
failure. skipServerDelete=true is for cross-device events (server
already knows).

addPendingEntry / updatePendingEntry / confirmPendingEntry / markPendingError
replace the old lib/pending-history.ts singleton API.

Stub broadcast.ts for now; real impl in Task 7.

Tests U9-U15.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 7: Implement `lib/history/broadcast.ts` (real)

**Files:**
- Modify: `lib/history/broadcast.ts` (replace stub)

- [ ] **Step 1: Replace stub with real BroadcastChannel implementation**

```ts
"use client";

import { deleteEntry } from "@/lib/history/mutations";
import { hydrateFromServer } from "@/lib/history/hydrate";
import { debugHistory } from "@/lib/history/debug";

type BroadcastMessage =
  | { type: "delete"; id: string; serverGenId?: number }
  | { type: "rehydrate"; username: string };

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
        void hydrateFromServer({ username: msg.username });
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

- [ ] **Step 2: Verify mutation tests still pass (no regression)**

Run: `npm test -- mutations.test`
Expected: PASS U9-U15.

- [ ] **Step 3: Build green**

Run: `npm run build`
Expected: success.

- [ ] **Step 4: Commit**

```bash
git add lib/history/broadcast.ts
git commit -m "$(cat <<'EOF'
feat(history): broadcast.ts — cross-tab via BroadcastChannel

Posts {type:"delete", id, serverGenId} on local deleteEntry; receivers
in other tabs of the same browser apply the same state-transition
through deleteEntry({skipServerDelete:true}) — idempotency makes the
self-tab no-op (BroadcastChannel doesn't echo to sender).

{type:"rehydrate", username} is escape-hatch for future use (e.g.
explicit username swap propagation).

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 8: Build `lib/history/sse.ts` with tests

**Files:**
- Create: `lib/history/sse.ts`
- Create: `lib/history/__tests__/sse.test.ts`

- [ ] **Step 1: Write failing tests U19-U22**

`lib/history/__tests__/sse.test.ts`:
```ts
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { _testTriggerSseEvent, _openForTest, _closeForTest } from "@/lib/history/sse";
import { useHistoryStore, _resetForTest } from "@/lib/history/store";
import { _resetHydrateForTest } from "@/lib/history/hydrate";

class MockEventSource {
  static instances: MockEventSource[] = [];
  url: string;
  readyState = 1;
  listeners = new Map<string, (ev: unknown) => void>();
  constructor(url: string) {
    this.url = url;
    MockEventSource.instances.push(this);
  }
  addEventListener(type: string, cb: (ev: unknown) => void): void {
    this.listeners.set(type, cb);
  }
  fire(type: string, payload: unknown): void {
    this.listeners.get(type)?.({ data: JSON.stringify(payload) } as MessageEvent);
  }
  close(): void { this.readyState = 2; }
}

beforeEach(() => {
  _resetForTest();
  _resetHydrateForTest();
  MockEventSource.instances = [];
  (global as unknown as { EventSource: typeof MockEventSource }).EventSource = MockEventSource;
  global.fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => [] } as Response);
});

afterEach(() => {
  _closeForTest();
  vi.restoreAllMocks();
});

describe("sse handler", () => {
  it("U19: generation.created → applyServerRow, no fetch", () => {
    _openForTest("alice");
    const es = MockEventSource.instances[0];
    es.fire("generation.created", {
      id: 100, username: "alice", workflow_name: "t", prompt_data: "{}",
      execution_time_seconds: 1, created_at: new Date().toISOString(), status: "completed",
      outputs: [{ id: 1, generation_id: 100, filename: "a.png",
        filepath: "550e8400-e29b-41d4-a716-446655440000.png",
        content_type: "image/png", size: 100 }],
    });
    expect(useHistoryStore.getState().entries.find((e) => e.serverGenId === 100)).toBeDefined();
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("U20: generation.deleted → deleteEntry with skipServerDelete=true", async () => {
    // Seed an entry first
    useHistoryStore.setState({
      entries: [{
        id: "abc", serverGenId: 100, state: "live", confirmed: true,
        prompt: "", provider: "wavespeed", createdAt: Date.now(),
        status: "completed", error: null,
      }],
      error: null,
    });
    _openForTest("alice");
    const es = MockEventSource.instances[0];
    es.fire("generation.deleted", { id: 100 });
    await new Promise((r) => setTimeout(r, 0));
    expect(useHistoryStore.getState().entries[0].state).toBe("removed");
    expect(global.fetch).not.toHaveBeenCalled();   // skipServerDelete
  });

  it("U21: open event triggers hydrateFromServer", async () => {
    vi.useFakeTimers();
    _openForTest("alice");
    const es = MockEventSource.instances[0];
    es.fire("open", {});
    await vi.advanceTimersByTimeAsync(60);
    expect(global.fetch).toHaveBeenCalled();
    const url = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    expect(url).toContain("username=alice");
    vi.useRealTimers();
  });

  it("U22: malformed payload doesn't crash", () => {
    _openForTest("alice");
    const es = MockEventSource.instances[0];
    expect(() => es.listeners.get("generation.created")?.({ data: "not json" } as MessageEvent))
      .not.toThrow();
    expect(() => es.listeners.get("generation.deleted")?.({ data: "not json" } as MessageEvent))
      .not.toThrow();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- sse.test`
Expected: FAIL on import.

- [ ] **Step 3: Implement `lib/history/sse.ts`**

```ts
"use client";

import * as React from "react";
import { applyServerRow } from "@/lib/history/store";
import { deleteEntry, setCurrentUsername } from "@/lib/history/mutations";
import { hydrateFromServer } from "@/lib/history/hydrate";
import { debugHistory } from "@/lib/history/debug";
import type { ServerGeneration } from "@/lib/history/types";

let es: EventSource | null = null;
let currentUsername: string | null = null;

export function useGenerationEvents(username: string | null): void {
  React.useEffect(() => {
    if (!username) {
      setCurrentUsername(null);
      return;
    }
    if (typeof window === "undefined" || typeof EventSource === "undefined") return;
    setCurrentUsername(username);
    open(username);
    return () => {
      close();
      setCurrentUsername(null);
    };
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
    void hydrateFromServer({ username });
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

// === Test-only helpers ===
export function _openForTest(username: string): void { open(username); }
export function _closeForTest(): void { close(); }
export function _testTriggerSseEvent(): void { /* placeholder for direct triggering */ }
```

- [ ] **Step 4: Run tests**

Run: `npm test -- sse.test`
Expected: PASS U19-U22.

- [ ] **Step 5: Commit**

```bash
git add lib/history/sse.ts lib/history/__tests__/sse.test.ts
git commit -m "$(cat <<'EOF'
feat(history): sse.ts — thin event translator + useGenerationEvents

EventSource events translate to in-place state mutations via the
store-internal API:
- generation.created → applyServerRow (no fetch)
- generation.deleted → deleteEntry({skipServerDelete:true}) (no fetch)
- open → hydrateFromServer (single sync point on connect/reconnect)
- error → log only; let browser auto-reconnect

useGenerationEvents also feeds setCurrentUsername so deleteEntry from
non-React contexts (broadcast receiver, programmatic) has the
username available.

Tests U19-U22.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 9: Build `lib/history/hooks.ts` — `useHistoryEntries`, `useEntryById`

**Files:**
- Create: `lib/history/hooks.ts`

- [ ] **Step 1: Implement `lib/history/hooks.ts`**

```ts
"use client";

import * as React from "react";
import { useHistoryStore } from "@/lib/history/store";
import { hydrateFromServer } from "@/lib/history/hydrate";
import { debugHistory } from "@/lib/history/debug";
import type { HistoryEntry, DateRange } from "@/lib/history/types";

const PAGE_SIZE = 20;

interface UseHistoryEntriesOpts {
  username: string | null;
  range?: DateRange;
  excludeDeleting?: boolean;
}

export function useHistoryEntries(opts: UseHistoryEntriesOpts): {
  entries: HistoryEntry[];
  isLoading: boolean;
  isLoadingMore: boolean;
  hasMore: boolean;
  loadMore: () => void;
  error: string | null;
  refetch: () => void;
} {
  const { username, range, excludeDeleting } = opts;
  const allEntries = useHistoryStore((s) => s.entries);
  const error = useHistoryStore((s) => s.error);

  const [isLoading, setIsLoading] = React.useState(false);
  const [isLoadingMore, setIsLoadingMore] = React.useState(false);
  const [hasMore, setHasMore] = React.useState(false);
  const offsetRef = React.useRef(0);

  // Mount + dependency-change hydration.
  React.useEffect(() => {
    if (!username) return;
    setIsLoading(true);
    offsetRef.current = 0;
    void hydrateFromServer({ username, range }).finally(() => {
      setIsLoading(false);
      setHasMore(false);    // refined by loadMore; first page hasMore unknown without count
    });
  }, [username, range?.from?.getTime(), range?.to?.getTime()]);

  const refetch = React.useCallback(() => {
    if (!username) return;
    void hydrateFromServer({ username, range });
  }, [username, range]);

  const loadMore = React.useCallback(() => {
    if (!username || isLoadingMore) return;
    setIsLoadingMore(true);
    offsetRef.current += PAGE_SIZE;
    void hydrateFromServer({ username, range, offset: offsetRef.current })
      .finally(() => setIsLoadingMore(false));
  }, [username, range, isLoadingMore]);

  const entries = React.useMemo(() => {
    return allEntries
      .filter((e) => {
        if (e.state === "removed") return false;
        if (excludeDeleting && e.state === "deleting") return false;
        if (range?.from && e.createdAt < range.from.getTime()) return false;
        if (range?.to && e.createdAt > range.to.getTime()) return false;
        return true;
      })
      .sort((a, b) => b.createdAt - a.createdAt);
  }, [allEntries, range?.from?.getTime(), range?.to?.getTime(), excludeDeleting]);

  return { entries, isLoading, isLoadingMore, hasMore, loadMore, error, refetch };
}

export function useEntryById(id: string): HistoryEntry | undefined {
  return useHistoryStore((s) => s.entries.find((e) => e.id === id));
}
```

- [ ] **Step 2: Build green**

Run: `npm run build`
Expected: success.

- [ ] **Step 3: Commit**

```bash
git add lib/history/hooks.ts
git commit -m "$(cat <<'EOF'
feat(history): hooks.ts — useHistoryEntries + useEntryById

useHistoryEntries subscribes to the store directly, triggers
hydrateFromServer on mount + on username/range change, exposes
refetch() as a programmatic escape-hatch (NOT for UI buttons —
project-wide UX principle is invisible sync). Default filter excludes
REMOVED; opt-in excludeDeleting flag for surfaces that don't render
the deletion animation.

useEntryById is a thin selector for single-entry consumers.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 10: Build `lib/history/index.ts` public surface

**Files:**
- Create: `lib/history/index.ts`

- [ ] **Step 1: Create `lib/history/index.ts`**

```ts
// Public API for the history module. Anything not re-exported here is
// considered private and may not be imported from outside lib/history.

export { useHistoryEntries, useEntryById } from "@/lib/history/hooks";
export { useGenerationEvents } from "@/lib/history/sse";
export {
  deleteEntry,
  addPendingEntry,
  updatePendingEntry,
  confirmPendingEntry,
  markPendingError,
  setPendingControls,
  getPendingControls,
} from "@/lib/history/mutations";

export type {
  HistoryEntry,
  EntryState,
  DateRange,
  NewPendingInput,
  ServerGeneration,
} from "@/lib/history/types";
```

- [ ] **Step 2: Build green**

Run: `npm run build && npm test`
Expected: success on both.

- [ ] **Step 3: Commit**

```bash
git add lib/history/index.ts
git commit -m "$(cat <<'EOF'
feat(history): public index.ts — single import surface

Components import only from @/lib/history. Internals (store, mutations,
hydrate, sse, broadcast, pending) are not re-exported and may not be
deep-imported. ESLint rule blocks deep imports in Task 16.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 11: Migrate `components/generate-form.tsx` to `@/lib/history`

**Files:**
- Modify: `components/generate-form.tsx`

- [ ] **Step 1: Read the file to identify all uses**

Run: `grep -n "pending-history\|pendingHistory\." components/generate-form.tsx`
Expected: list of 10-15 references to migrate.

- [ ] **Step 2: Replace imports**

Old:
```ts
import * as pendingHistory from "@/lib/pending-history";
```
New:
```ts
import {
  addPendingEntry,
  updatePendingEntry,
  confirmPendingEntry,
  markPendingError,
  setPendingControls,
} from "@/lib/history";
```

- [ ] **Step 3: Replace each call-site**

| Old | New |
|---|---|
| `pendingHistory.addPending({ ...gen, pending: true, uuid })` | `addPendingEntry({ uuid, prompt, provider, workflowName, createdAt, ...blobUrls })` |
| `pendingHistory.updatePending(uuid, patch)` | `updatePendingEntry(uuid, patch)` |
| `pendingHistory.confirmPending(uuid)` | `confirmPendingEntry(uuid, { serverGenId, serverUrls })` |
| `pendingHistory.markError(uuid, msg)` | `markPendingError(uuid, msg)` |
| `pendingHistory.removePending(uuid)` | `deleteEntry(uuid)` (PENDING path is built-in) |
| Setting `retry`/`abort` callbacks via `updatePending` | `setPendingControls(uuid, { retry, abort })` |

For each call-site that previously created a `PendingGeneration` shape (with `outputs[]`, `pending: true`, etc.), reduce to the simpler `NewPendingInput` shape: `{uuid, prompt, provider, workflowName, createdAt, thumbUrl, previewUrl, originalUrl, outputUrl, localBlobUrls}`.

For `confirmPending(uuid)` call-sites that previously relied on the server refetch to bring in URLs: now pass server URLs explicitly through `confirmPendingEntry(uuid, {serverGenId: response.id, serverUrls: {thumb, mid, full}})`. The server response from POST `/api/history` already returns the row with paths — derive URLs via `/api/history/image/<filename>` template.

- [ ] **Step 4: Build green**

Run: `npm run build`
Expected: success. TypeScript may flag missing fields — derive from existing variables in the same scope.

- [ ] **Step 5: Manual smoke test**

Run: `npm run dev`. Open browser, generate one image. Verify: appears in Output strip immediately, then becomes confirmed (server URL replaces blob URL silently).

- [ ] **Step 6: Commit**

```bash
git add components/generate-form.tsx
git commit -m "$(cat <<'EOF'
refactor(history): migrate generate-form to @/lib/history

addPendingEntry / updatePendingEntry / confirmPendingEntry / markPendingError
replace pendingHistory.* singleton calls. setPendingControls registers
retry/abort separately from data. confirmPendingEntry now takes server
URLs explicitly (no implicit refetch dependency).

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 12: Migrate `components/output-area.tsx` to `@/lib/history`

**Files:**
- Modify: `components/output-area.tsx`

- [ ] **Step 1: Replace imports**

Remove:
```ts
import { useHistory, extractUuid, broadcastHistoryRefresh, type ServerGeneration } from "@/hooks/use-history";
import { useHistoryStore } from "@/stores/history-store";
import { markGenerationDeleted } from "@/lib/history-deletions";
import { debugHistory } from "@/lib/history-debug";
```

Add:
```ts
import { useHistoryEntries, deleteEntry, type HistoryEntry } from "@/lib/history";
```

- [ ] **Step 2: Replace `useHistory(...)` with `useHistoryEntries(...)`**

The Output strip filters today's entries. Replace:
```ts
const { items, ... } = useHistory({ username, startDate: todayStart, endDate: todayEnd });
```
With:
```ts
const { entries, isLoading, error } = useHistoryEntries({
  username,
  range: { from: todayStart, to: todayEnd },
});
```

- [ ] **Step 3: Drop the `entries` (Zustand-local) merge logic**

The `useHistoryStore` Zustand-local entries no longer exist as a separate concern — `useHistoryEntries` already returns a unified view (PENDING + LIVE + DELETING from one store). Delete the manual merge/dedup code in this component.

- [ ] **Step 4: Replace `handleRemove` with `deleteEntry`**

Old (~50 lines):
```ts
const handleRemove = React.useCallback(async (entry: HistoryEntry) => {
  if (typeof entry.serverGenId !== "number") { remove(entry.id); return; }
  if (!username) return;
  if (!confirm("Удалить эту запись из истории?")) return;
  // ... debugHistory, optimistic, markGenerationDeleted, broadcastHistoryRefresh, fetch DELETE, toast ...
}, [remove, username]);
```

New:
```ts
const handleRemove = React.useCallback(async (entry: HistoryEntry) => {
  if (!confirm("Удалить эту запись из истории?")) return;
  await deleteEntry(entry.id);
}, []);
```

- [ ] **Step 5: Add empty-state skeleton tiles for the loading window**

While `isLoading && entries.length === 0`, render N skeleton tiles instead of `EmptyState`. (User concern: avoid flicker on reload.)

```tsx
{isLoading && entries.length === 0 ? (
  <div className="flex flex-wrap gap-4">
    {Array.from({ length: 4 }).map((_, i) => (
      <div key={i} className="h-40 w-40 animate-pulse rounded-md bg-muted" />
    ))}
  </div>
) : !hasAny ? (
  <EmptyState />
) : (
  /* existing grid */
)}
```

- [ ] **Step 6: Build green**

Run: `npm run build`

- [ ] **Step 7: Manual smoke test**

Generate an image, click trash on it. Verify: instant hide, server DELETE confirmed in Network tab, sidebar also updates.

- [ ] **Step 8: Commit**

```bash
git add components/output-area.tsx
git commit -m "$(cat <<'EOF'
refactor(output-area): migrate to useHistoryEntries + deleteEntry

handleRemove collapses from ~50 lines into one deleteEntry call. Drops
imports of useHistoryStore, markGenerationDeleted, broadcastHistoryRefresh.
The Zustand-local merge logic is gone — useHistoryEntries returns a
unified view. Adds skeleton tiles for the first-load window so the
strip doesn't flash empty before /api/history responds.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 13: Migrate `components/history-sidebar.tsx` to `@/lib/history`

**Files:**
- Modify: `components/history-sidebar.tsx`

- [ ] **Step 1: Replace imports**

Remove:
```ts
import { useHistory, HISTORY_REFRESH_EVENT, broadcastHistoryRefresh, type ServerGeneration } from "@/hooks/use-history";
import { useHistoryStore } from "@/stores/history-store";
import { markGenerationDeleted } from "@/lib/history-deletions";
import { isPending, removePending } from "@/lib/pending-history";
```

Add:
```ts
import { useHistoryEntries, deleteEntry, type HistoryEntry } from "@/lib/history";
```

- [ ] **Step 2: Replace `useHistory(...)` with `useHistoryEntries(...)`**

```ts
const { entries, isLoading, isLoadingMore, hasMore, loadMore, error } = useHistoryEntries({
  username,
  range: { from: dateRange.from, to: dateRange.to },
});
```

- [ ] **Step 3: Drop `setDeletingIds` local state and `visibleItems` filter**

The store already filters DELETING/REMOVED via `useHistoryEntries`. Delete:
```ts
const [deletingIds, setDeletingIds] = React.useState<Set<number>>(new Set());
const visibleItems = React.useMemo(...);
```

Use `entries` directly.

- [ ] **Step 4: Replace `handleDelete` with `deleteEntry`**

Old (~40 lines): branch on `isPending(gen)` → `removePending(gen.uuid)`; otherwise `setDeletingIds + markGenerationDeleted + Zustand.remove + fetch DELETE + toast + refetch`.

New:
```ts
async function handleDelete(entry: HistoryEntry) {
  if (!confirm("Удалить эту запись из истории?")) return;
  await deleteEntry(entry.id);
}
```

- [ ] **Step 5: Update card renderer to consume `HistoryEntry` instead of `ServerGeneration`**

The sidebar card previously rendered `ServerGeneration` rows directly. Now it gets `HistoryEntry`. Rendering changes:
- `gen.outputs[0].filepath` → `entry.thumbUrl ?? thumbUrlForEntry(entry)`
- `isPending(gen)` → `entry.state === "pending"`
- `gen.id` (number) → `entry.serverGenId` for DELETE URL building (no longer needed; deleteEntry handles)
- Keep BlurUpImage usage as-is.

- [ ] **Step 6: Build green**

Run: `npm run build`

- [ ] **Step 7: Manual smoke test**

Open sidebar, click trash on a card. Verify: instant hide, server DELETE confirmed in Network tab.

- [ ] **Step 8: Commit**

```bash
git add components/history-sidebar.tsx
git commit -m "$(cat <<'EOF'
refactor(history-sidebar): migrate to useHistoryEntries + deleteEntry

handleDelete collapses into one deleteEntry call (was 40 lines with
pending/non-pending branching, optimistic state, markGenerationDeleted,
broadcastHistoryRefresh). Local setDeletingIds state removed — the
store handles DELETING. Card renderer adapted to consume HistoryEntry
instead of ServerGeneration.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 14: Repoint SSE-mount point + remaining consumers

**Files:**
- Modify: file that currently calls `useGenerationEvents` (likely `components/app-shell.tsx` or similar)
- Modify: any other consumer of removed modules

- [ ] **Step 1: Find the SSE mount site**

Run: `grep -rn "useGenerationEvents" components app`
Expected: 1-2 hits.

- [ ] **Step 2: Repoint import**

Replace:
```ts
import { useGenerationEvents } from "@/hooks/use-generation-events";
```
With:
```ts
import { useGenerationEvents } from "@/lib/history";
```

- [ ] **Step 3: Find remaining consumers of the old modules**

Run all four:
```bash
grep -rn "from \"@/hooks/use-history\"" components app hooks lib
grep -rn "from \"@/lib/pending-history\"" components app hooks lib
grep -rn "from \"@/lib/history-deletions\"" components app hooks lib
grep -rn "from \"@/lib/history-debug\"" components app hooks lib
grep -rn "from \"@/stores/history-store\"" components app hooks lib
grep -rn "from \"@/hooks/use-generation-events\"" components app hooks lib
```

For each remaining consumer, repoint to `@/lib/history` and adapt API calls.

- [ ] **Step 4: Build green**

Run: `npm run build`
Expected: success. If any file imports a removed name (e.g. `broadcastHistoryRefresh`), TypeScript will flag it — replace with `deleteEntry` or remove the call (refresh is implicit now).

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "$(cat <<'EOF'
refactor(history): repoint all consumers to @/lib/history

SSE mount site moved to @/lib/history's useGenerationEvents. All
remaining @/hooks/use-history, @/lib/pending-history, @/lib/history-deletions,
@/lib/history-debug, @/stores/history-store, @/hooks/use-generation-events
imports replaced. Old call-sites that depended on broadcastHistoryRefresh
or HISTORY_REFRESH_EVENT either drop the call (refresh is implicit) or
switch to deleteEntry as appropriate.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 15: Delete superseded modules

**Files:**
- Delete: `hooks/use-history.ts`
- Delete: `hooks/use-generation-events.ts`
- Delete: `lib/pending-history.ts`
- Delete: `lib/history-deletions.ts`
- Delete: `lib/history-debug.ts`
- Delete: `stores/history-store.ts`

- [ ] **Step 1: Verify no remaining references**

```bash
grep -rn "use-history\\|pending-history\\|history-deletions\\|history-debug\\|history-store\\|use-generation-events" components app hooks lib
```
Expected: only matches inside `lib/history/` (the new module). If any external match remains, fix it before deleting.

- [ ] **Step 2: Delete the six files**

```bash
git rm hooks/use-history.ts hooks/use-generation-events.ts lib/pending-history.ts lib/history-deletions.ts lib/history-debug.ts stores/history-store.ts
```

- [ ] **Step 3: Build + tests green**

```bash
npm run build && npm test
```
Expected: success on both.

- [ ] **Step 4: Commit**

```bash
git commit -m "$(cat <<'EOF'
refactor(history): delete six superseded modules

All consumers migrated to @/lib/history in prior commits. Removed:
- hooks/use-history.ts
- hooks/use-generation-events.ts
- lib/pending-history.ts
- lib/history-deletions.ts
- lib/history-debug.ts
- stores/history-store.ts

The exports broadcastHistoryRefresh, HISTORY_REFRESH_EVENT,
markGenerationDeleted, useDeletedIds, getDeletedIds, useHistoryStore,
useHistory, useGenerationEvents (old), pendingHistory.* no longer
exist. Refresh is implicit (state-machine + SSE patches).

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 16: One-time `localStorage` cleanup + ESLint deep-import rule

**Files:**
- Modify: `lib/history/store.ts` (add cleanup call)
- Modify: `.eslintrc` (or create) — Next 15 uses `next/core-web-vitals`; add `no-restricted-imports` rule

- [ ] **Step 1: Add localStorage cleanup to `lib/history/store.ts`**

Append to the bottom of `lib/history/store.ts`:
```ts
// One-time cleanup: the previous mechanism persisted under "wavespeed-history".
// New store doesn't persist; remove the stale key so it doesn't sit in
// localStorage forever. No-op if already absent.
if (typeof window !== "undefined") {
  try {
    window.localStorage.removeItem("wavespeed-history");
  } catch {
    // ignore (private mode, quota, etc.)
  }
}
```

- [ ] **Step 2: Check the existing ESLint setup**

Run: `cat .eslintrc.json 2>/dev/null || cat .eslintrc.js 2>/dev/null || ls -la | grep eslint`
If no config exists, the project uses Next's default via `next lint`. Create `.eslintrc.json`:

```json
{
  "extends": "next/core-web-vitals",
  "rules": {
    "no-restricted-imports": [
      "error",
      {
        "patterns": [
          {
            "group": [
              "@/lib/history/store",
              "@/lib/history/mutations",
              "@/lib/history/hydrate",
              "@/lib/history/sse",
              "@/lib/history/broadcast",
              "@/lib/history/pending",
              "@/lib/history/util",
              "@/lib/history/debug",
              "@/lib/history/hooks",
              "@/lib/history/types"
            ],
            "message": "Import from '@/lib/history' (the public index) instead. Internal modules are private to lib/history/."
          }
        ]
      }
    ]
  }
}
```

If a config DOES exist, merge the `no-restricted-imports` rule in.

- [ ] **Step 3: Override the rule for files inside `lib/history/`**

`lib/history/.eslintrc.json` (new file):
```json
{
  "rules": {
    "no-restricted-imports": "off"
  }
}
```

- [ ] **Step 4: Verify lint passes**

Run: `npm run lint`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add lib/history/store.ts .eslintrc.json lib/history/.eslintrc.json
git commit -m "$(cat <<'EOF'
chore(history): one-time localStorage cleanup + ESLint deep-import guard

Drops the stale "wavespeed-history" localStorage key on first store
mount (new store doesn't persist).

ESLint no-restricted-imports rule blocks deep imports of @/lib/history/*
internals from outside the module. Override inside lib/history/ allows
internal cross-imports.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 17: README + operator's manual + delete superseded spec

**Files:**
- Create: `lib/history/README.md`
- Delete: `docs/superpowers/specs/2026-04-12-history-delete-sync-cleanup.md`

- [ ] **Step 1: Create `lib/history/README.md`**

```markdown
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
- **REMOVED** — gone. Tombstone in store; never resurrected by server input.

## Three places to look when editing

1. **`store.ts`** — types, state transitions, `applyServerRow` (the only
   place that decides "accept a server row" — invariant 2 lives here).
2. **`mutations.ts`** — `deleteEntry` (the only removal path),
   `addPendingEntry` / `confirmPendingEntry` lifecycle.
3. **`index.ts`** — public surface. If a consumer needs something not
   listed here, it doesn't exist.

## Operator's manual

Enable the debug flag in DevTools console:

```
localStorage.setItem("DEBUG_HISTORY_DELETE", "1");
```

Then perform the action and read the console.

| Symptom | Where to look |
|---|---|
| Card won't disappear on delete | `deleteEntry.start` → `deleteEntry.commit` sequence. Missing commit → DELETE hung; check Network. Missing start → click handler not wired. |
| Card reappears after another generation | `applyServerRow.ignored` for the entry. If absent, invariant 2 broken. Inspect `useHistoryStore.getState()`. |
| Cross-tab delete doesn't propagate | `broadcast.send` / `broadcast.recv` in respective tabs. Sender shows send but no recv → BroadcastChannel support / extension blocking. |
| Cross-device delete doesn't propagate | DevTools → Network → EventStream. Missing `generation.deleted` → server's `broadcastToUser` didn't fan out (HMR in dev; check server logs in prod). |
| Output strip empty after reload | Network tab for `/api/history`. 200 → check `applyServerList` log. 4xx/5xx → server side. Persistent empty + skeleton stuck → check throttling. |

## Spec

`docs/superpowers/specs/2026-04-13-history-sync-mechanism-redesign-design.md`
```

- [ ] **Step 2: Delete the superseded spec**

```bash
git rm docs/superpowers/specs/2026-04-12-history-delete-sync-cleanup.md
```

- [ ] **Step 3: Build green**

```bash
npm run build
```

- [ ] **Step 4: Commit**

```bash
git add lib/history/README.md
git commit -m "$(cat <<'EOF'
docs(history): module README + operator's manual; remove superseded spec

lib/history/README.md gives a one-page mental model: state diagram,
three places to edit, debug flag instructions, "when X breaks check Y"
table.

Removes 2026-04-12-history-delete-sync-cleanup.md (the patch-in-place
proposal that was superseded by the 2026-04-13 redesign — both were
flagged as such in the latter's frontmatter).

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 18: Manual verification matrix

**Files:** none (verification only).

This task does NOT produce a commit. It is the gate before merge.

Run the dev server: `npm run dev`. Open `localhost:3000` (and a second tab + a phone connection if testing cross-device).

Enable debug flag in DevTools: `localStorage.setItem("DEBUG_HISTORY_DELETE", "1");`

- [ ] **M1:** Generate image. Click trash on it in Output. Verify: instant hide; Network shows `DELETE /api/history?id=...`; store has the entry as `removed` (check via `useHistoryStore.getState()`).

- [ ] **M2:** Open in second device/tab. Trash a row that was generated on the OTHER device. Verify: instant hide locally; sidebar of OTHER device updates within 2s via SSE.

- [ ] **M3:** Trash a confirmed row in Sidebar. Verify: vanishes from Sidebar AND Output simultaneously.

- [ ] **M4:** Start a generation, immediately trash the in-flight pending row in Sidebar (uuid-only, no serverGenId yet). Verify: instant hide; no DELETE network call; upload aborted (check Network for cancelled POST).

- [ ] **M5 (the resurrection test):** Trash X. While DELETE for X is in flight (throttle network if needed), start generating Y. Y completes. Verify: **X never reappears**.

- [ ] **M6:** Open two tabs. Trash X in tab A. Verify: tab B drops X within 50ms (no network).

- [ ] **M7:** Trash X on PC. Verify: phone (logged in same username) drops X within 1-2s via SSE.

- [ ] **M8:** Throttle network to "Offline". Click trash. Verify: `Не удалось удалить` toast; entry returns to LIVE.

- [ ] **M9:** With debug flag on, perform delete + generate + delete. Verify: console log shows clean transition trace; no duplicate state-transitions; no orphan event names.

- [ ] **M10 (HMR; dev only):** Edit a comment in `lib/history/store.ts` while a generation is mid-delete. Note any state loss; verify NO cascade to wrong row.

- [ ] **M11:** Trash a card while its BlurUpImage curtain is still revealing. Verify: animation completes or interrupts cleanly; no stuck animation, no console errors.

- [ ] **M12:** Open with a PRE-DEPLOY browser tab still alive (i.e. localStorage has `wavespeed-history`). Reload. Verify: localStorage no longer has the key after first mount.

- [ ] **M13:** On PC, generate a new image. Verify: phone (same user) sees it appear in Output within 1-2s via SSE `generation.created`.

- [ ] **M14:** Trash an Output card. Verify: Sidebar (in same tab, if open) updates instantly.

- [ ] **M15:** Trash a Sidebar card. Verify: Output (in same tab) updates instantly.

- [ ] **M16 (animation hook validation):** Temporarily change `ANIMATION_HOLD_MS` from 0 to 200 in `mutations.ts`. Add a quick CSS class with `transition: opacity 200ms` and `opacity: 0` for `data-state="deleting"`. Verify: card visibly fades over 200ms before eviction; functionally still removed at click time. Revert the change.

When all 16 pass, the redesign is ready to merge.

---

## Self-Review

**Spec coverage:**
- Module structure → Tasks 2-10
- Types → Task 2
- State machine + invariants → Task 3 (invariant 2), Task 4 (invariant 7), Task 6 (idempotency invariants)
- Public API → Task 10
- Hydration → Task 5
- deleteEntry → Task 6
- SSE → Task 8
- BroadcastChannel → Task 7
- Migration → Tasks 11-15
- Test matrix unit → Tasks 3-8
- Test matrix manual → Task 18
- localStorage cleanup → Task 16
- ESLint deep-import → Task 16
- README + delete superseded → Task 17
- Implementation plan section of spec (12 commits) → matches Tasks 2-17 plus Vitest setup (Task 1)

All sections covered.

**Placeholder scan:** No TBDs, no "implement later", no "similar to Task N", no missing code blocks. Each test step has full test code; each implementation step has full source code.

**Type consistency:** `setStateOf` (Task 3) used by `markRemoved`, `rollbackDeletion` (Task 3), `deleteEntry` (Task 6). `applyServerRow` exported from store.ts (Task 3), consumed by hydrate.ts (Task 5) and sse.ts (Task 8). `applyServerList` exported from store.ts (Task 4), consumed by hydrate.ts (Task 5). `broadcast` exported from broadcast.ts (Task 7), consumed by mutations.ts (Task 6 with stub, then real in Task 7). `setCurrentUsername` defined in mutations.ts (Task 6), consumed by sse.ts (Task 8). All consistent.

`HistoryEntry` shape stable across Tasks 2-10. `EntryState` enum stable.

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-04-13-history-sync-mechanism-redesign.md`. Two execution options:

**1. Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration.

**2. Inline Execution** — Execute tasks in this session using executing-plans, batch execution with checkpoints.

Which approach?
