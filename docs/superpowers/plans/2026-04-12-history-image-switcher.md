# History Image Switcher Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bring the Output-today image switcher UX (arrow nav, keyboard, chevron overlay) into the History sidebar's `ImageDialog`, with reactive siblings, prefetch on approach to tail, and SSE-live updates that survive deletion of the currently viewed entry.

**Architecture:** A new hook `useHistorySiblings` sits on top of the existing `useHistory()`, returns a reactive, filtered, uuid-keyed `HistoryEntry[]`. `HistorySidebar` calls it once, passes `siblings` / `initialIndex` / `onNearEnd` down to each `ServerEntryCard`. `ImageDialog` is refactored from index-tracking to id-tracking, gains an `onNearEnd` prop, and handles the case where the currently viewed entry disappears from siblings.

**Tech Stack:** Next.js 15 App Router, React 19, TypeScript strict, Tailwind CSS, Zustand, `better-sqlite3` on server, native `BroadcastChannel` + `EventSource` for cross-tab/device sync. **No test framework in this project** — verification is via `npm run lint`, `npm run build`, and manual browser checks.

---

## Spec

See `docs/superpowers/specs/2026-04-12-history-image-switcher-design.md` for the full approved design.

## File structure

| File | Change | Responsibility |
|------|--------|---------------|
| `lib/server-gen-adapter.ts` | **Modify** | Add `genToHistoryEntry(gen, opts?)` — a single adapter that covers both server-rows and pending entries, returns stable uuid-based `id`, builds `/api/history/image/*` URLs. Keep existing `serverGenToHistoryEntry` as a thin wrapper for back-compat. |
| `hooks/use-history-siblings.ts` | **Create** | Wraps `useHistory()`. Returns `{ siblings, loadMore, hasMore, loading }`. Filter: viewable entries only (completed or pending-with-blob). Sort: desc by createdAt. |
| `components/image-dialog.tsx` | **Modify** | (a) id-tracking: `currentId` state, `currentIdx` computed. (b) Prop `onNearEnd?: (remainingAhead: number) => void` fired when index advances within ≤2 of the tail. (c) Effect: if `currentId` is no longer in siblings, clamp to old index position; if siblings becomes empty → `onOpenChange(false)`. |
| `components/history-sidebar.tsx` | **Modify** | `HistorySidebar` calls `useHistorySiblings()`. `ServerEntryCard` receives `siblings`, `currentIndex`, `onNearEnd` via props, passes them through to `ImageDialog`. |
| `components/output-area.tsx` | **Verify (no change)** | Must continue to pass `siblings` as `todayEntries` and work identically — regression target. |

## Key existing references

- `hooks/use-history.ts:92-95` — `extractUuid(filepath)` exported already. Use it for uuid-based stable ids on server rows.
- `hooks/use-history.ts:102-198` — `useHistory()` hook signature; `items` is already `mergedItems` (pending + server), `hasMore`, `isLoadingMore`, `loadMore`.
- `lib/pending-history.ts:48-50` — `isPending(gen)` type-narrowing predicate.
- `lib/pending-history.ts:26-45` — `PendingGeneration` shape with `uuid`, `thumbBlobUrl`, `midBlobUrl`, `fullBlobUrl`.
- `lib/server-gen-adapter.ts:37-64` — existing `serverGenToHistoryEntry` that we're extending.
- `components/image-dialog.tsx:15-57` — current props + navigation state that we're refactoring.
- `components/image-dialog.tsx:192-201` — keyboard handler (will keep working once id-tracking lands, because `goNext`/`goPrev` are still the entry points).
- `components/image-dialog.tsx:332-355` — chevron overlay; **no visual changes**, this is what will automatically light up when siblings.length > 1 from History.
- `components/history-sidebar.tsx:295-313` — the render loop over `visibleItems` where we'll pipe `siblings`/`index` props down.
- `components/history-sidebar.tsx:383-420` — the `<ImageDialog entry={...} downloadUrl={...}>` call that needs `siblings={...} initialIndex={...} onNearEnd={...}` added.

---

## Task 1: Add `genToHistoryEntry` shared adapter

**Files:**
- Modify: `lib/server-gen-adapter.ts`

**Goal:** One adapter that turns any `ServerGeneration` (server or pending) into a `HistoryEntry` with:
- Stable uuid-based `id` (so pending→confirmed transition does not change the id).
- `outputUrl` / `previewUrl` / `originalUrl` populated (so `ImageDialog` can render without extra wiring).

- [ ] **Step 1: Read the current file to confirm line numbers before editing**

Run: `cat lib/server-gen-adapter.ts | head -70`

Expected: current file ends at line 64, with `serverGenToHistoryEntry` as the only adapter.

- [ ] **Step 2: Replace contents of `lib/server-gen-adapter.ts` with the extended version**

```ts
import type { ServerGeneration } from "@/hooks/use-history";
import { extractUuid } from "@/hooks/use-history";
import { isPending } from "@/lib/pending-history";
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

function parseCreatedAt(raw: string): number {
  const iso = raw.includes("T") ? raw : raw.replace(" ", "T") + "Z";
  const t = Date.parse(iso);
  return Number.isNaN(t) ? Date.now() : t;
}

function buildServerImageUrl(filepath: string, variant?: "thumb" | "mid"): string {
  const base = filepath.replace(/\.[^.]+$/, "");
  if (variant === "thumb") {
    return `/api/history/image/${encodeURIComponent(`thumb_${base}.jpg`)}`;
  }
  if (variant === "mid") {
    return `/api/history/image/${encodeURIComponent(`mid_${base}.jpg`)}`;
  }
  return `/api/history/image/${encodeURIComponent(filepath)}`;
}

/**
 * Stable, uuid-based key for a generation. Pending entries use their
 * own uuid; server rows extract it from the first image's filepath.
 * Legacy rows without a uuid-shaped filename fall back to the DB id.
 *
 * This id is used as `HistoryEntry.id` for sibling navigation so the
 * pending→confirmed transition doesn't appear to swap out the currently
 * viewed entry (both forms share the same uuid).
 */
export function stableGenerationId(gen: ServerGeneration): string {
  if (isPending(gen)) return gen.uuid.toLowerCase();
  const img = gen.outputs.find((o) => o.content_type.startsWith("image/"));
  const uuid = img ? extractUuid(img.filepath) : null;
  return uuid ?? `server-${gen.id}`;
}

/**
 * Universal adapter: any ServerGeneration (server or pending) → HistoryEntry.
 * Builds `/api/history/image/*` URLs for server rows and uses the pending
 * entry's blob URLs directly for pending rows. Returns `null` when the
 * generation has no usable image (pending with no blob yet, server row
 * with no image output).
 */
export function genToHistoryEntry(gen: ServerGeneration): HistoryEntry | null {
  const data = parsePromptData(gen.prompt_data);
  const firstImage = gen.outputs.find((o) => o.content_type.startsWith("image/"));

  let midUrl: string | undefined;
  let fullUrl: string | undefined;

  if (isPending(gen)) {
    // Pending: use blob URLs. Require at least a mid or full blob to be
    // renderable; otherwise skip — the user shouldn't be able to navigate
    // to an entry that has nothing to display.
    midUrl = gen.midBlobUrl ?? gen.fullBlobUrl;
    fullUrl = gen.fullBlobUrl ?? gen.midBlobUrl;
    if (!midUrl || !fullUrl) return null;
  } else {
    if (!firstImage) return null;
    midUrl = buildServerImageUrl(firstImage.filepath, "mid");
    fullUrl = buildServerImageUrl(firstImage.filepath);
  }

  return {
    id: stableGenerationId(gen),
    taskId: `server-${gen.id}`,
    provider: (data.provider as HistoryEntry["provider"]) || "wavespeed",
    prompt: data.prompt || "",
    model: (data.model as HistoryEntry["model"]) || "nano-banana-pro",
    aspectRatio: (data.aspectRatio as HistoryEntry["aspectRatio"]) || undefined,
    resolution: (data.resolution as HistoryEntry["resolution"]) || "2k",
    outputFormat: (data.outputFormat as HistoryEntry["outputFormat"]) || "png",
    status: "completed",
    createdAt: parseCreatedAt(gen.created_at),
    outputUrl: midUrl,
    previewUrl: midUrl,
    originalUrl: fullUrl,
    inputThumbnails: [],
    serverGenId: isPending(gen) ? undefined : gen.id,
    confirmed: !isPending(gen),
  };
}

/**
 * Back-compat wrapper for existing call sites that already pass a
 * resolved `fullSrc`. Prefer `genToHistoryEntry` for new code.
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
    createdAt: parseCreatedAt(gen.created_at),
    outputUrl: fullSrc,
    inputThumbnails: [],
    serverGenId: gen.id,
    confirmed: true,
  };
}
```

- [ ] **Step 3: TypeScript sanity — run lint**

Run: `npm run lint`

Expected: zero new errors in `lib/server-gen-adapter.ts`. Pre-existing warnings (if any) are fine.

- [ ] **Step 4: Commit**

```bash
git add lib/server-gen-adapter.ts
git commit -m "feat(adapter): add genToHistoryEntry with stable uuid id + URL building"
```

---

## Task 2: Create `useHistorySiblings` hook

**Files:**
- Create: `hooks/use-history-siblings.ts`

**Goal:** A thin reactive wrapper over `useHistory()` that produces the `HistoryEntry[]` list the `ImageDialog` will use for navigation.

- [ ] **Step 1: Create the hook file**

Write `hooks/use-history-siblings.ts`:

```ts
"use client";

import * as React from "react";
import { useHistory } from "@/hooks/use-history";
import { genToHistoryEntry } from "@/lib/server-gen-adapter";
import type { HistoryEntry } from "@/types/wavespeed";

interface UseHistorySiblingsParams {
  username: string | null;
  startDate?: Date;
  endDate?: Date;
}

export interface UseHistorySiblingsResult {
  /** Reactive, uuid-keyed, viewable-only, desc-by-createdAt. */
  siblings: HistoryEntry[];
  /** Pass-through from useHistory — triggers next-page fetch. */
  loadMore: () => void;
  /** Pass-through — true while more server rows exist to fetch. */
  hasMore: boolean;
  /** Pass-through — true while loadMore / refetch is in flight. */
  loading: boolean;
}

/**
 * Sibling-navigation view over `useHistory()`.
 *
 * - Converts each viewable ServerGeneration (server or pending) into a
 *   HistoryEntry via `genToHistoryEntry`.
 * - Drops entries that are not currently displayable (pending without a
 *   ready blob, server rows with no image output). These are skipped
 *   for navigation so users don't land on a blank slide.
 * - Keeps the same desc-by-createdAt sort the sidebar already renders.
 * - Exposes `loadMore` / `hasMore` / `loading` so the consumer can wire
 *   prefetch-on-approach without re-entering `useHistory`.
 */
export function useHistorySiblings(
  params: UseHistorySiblingsParams
): UseHistorySiblingsResult {
  const { items, hasMore, isLoading, isLoadingMore, loadMore } = useHistory(params);

  const siblings = React.useMemo<HistoryEntry[]>(() => {
    const mapped: HistoryEntry[] = [];
    for (const gen of items) {
      const entry = genToHistoryEntry(gen);
      if (entry) mapped.push(entry);
    }
    // Items from useHistory are already pending-first, then desc by
    // createdAt among server rows. Re-sort explicitly so a pending
    // row with a slightly newer timestamp than a server row (or vice
    // versa) still lines up correctly with the rendered sidebar.
    mapped.sort((a, b) => b.createdAt - a.createdAt);
    return mapped;
  }, [items]);

  return {
    siblings,
    loadMore: () => void loadMore(),
    hasMore,
    loading: isLoading || isLoadingMore,
  };
}
```

- [ ] **Step 2: Lint**

Run: `npm run lint`

Expected: zero new errors.

- [ ] **Step 3: Build — catches type-level mismatches**

Run: `npm run build`

Expected: build succeeds. If it fails, the most likely cause is a `HistoryEntry` field mismatch from Task 1's adapter — re-read `types/wavespeed.ts:28-84` and correct the adapter.

- [ ] **Step 4: Commit**

```bash
git add hooks/use-history-siblings.ts
git commit -m "feat(hooks): useHistorySiblings reactive sibling view over useHistory"
```

---

## Task 3: Refactor `ImageDialog` to id-tracking

**Files:**
- Modify: `components/image-dialog.tsx:39-57` (state init + nav callbacks) and `:117-140` (`handleOpenChange`)

**Goal:** Replace `currentIdx: useState<number>` with `currentId: useState<string>`. Derive `currentIdx` by `findIndex`. This makes navigation correct when `siblings` is reactive — previously if a new entry was prepended, `currentIdx` would silently point at the wrong slide.

- [ ] **Step 1: Re-read the current state/nav block**

Run: Read `components/image-dialog.tsx` lines 39-57 + 117-140.

Confirm: `const [currentIdx, setCurrentIdx] = React.useState(initialIndex);`, `goPrev`/`goNext` modulo-wrap on `siblings!.length`, `handleOpenChange(true)` sets `setCurrentIdx(initialIndex)`.

- [ ] **Step 2: Replace the state and navigation block (around lines 39-57)**

**Old (lines 39-57):**

```ts
export function ImageDialog({ entry, children, downloadUrl, siblings, initialIndex = 0 }: ImageDialogProps) {
  // Navigation state — which sibling is currently shown. Reset to
  // initialIndex every time the dialog opens (so closing on image #5 and
  // re-opening on tile #2 starts at #2, not #5).
  const [currentIdx, setCurrentIdx] = React.useState(initialIndex);
  const hasSiblings = !!siblings && siblings.length > 1;
  const currentEntry = hasSiblings ? siblings![currentIdx] ?? entry : entry;
  const currentDownloadUrl =
    (hasSiblings ? currentEntry.originalUrl ?? currentEntry.outputUrl : downloadUrl) ??
    currentEntry.outputUrl;

  const goPrev = React.useCallback(() => {
    if (!hasSiblings) return;
    setCurrentIdx((i) => (i - 1 + siblings!.length) % siblings!.length);
  }, [hasSiblings, siblings]);
  const goNext = React.useCallback(() => {
    if (!hasSiblings) return;
    setCurrentIdx((i) => (i + 1) % siblings!.length);
  }, [hasSiblings, siblings]);
```

**New:**

```ts
export function ImageDialog({ entry, children, downloadUrl, siblings, initialIndex = 0 }: ImageDialogProps) {
  // Navigation state — which sibling is currently shown, tracked by id
  // (not index) so that a reactive siblings array (entries inserted /
  // removed while the dialog is open) keeps pointing at the right slide.
  //
  // Seed with the clicked entry's id so that if the sibling array is
  // empty or doesn't yet contain the entry, we still render the trigger
  // entry rather than crashing.
  const siblingsList = siblings ?? [];
  const hasSiblings = siblingsList.length > 1;

  const [currentId, setCurrentId] = React.useState<string>(() => {
    const seed = siblingsList[initialIndex]?.id ?? entry.id;
    return seed;
  });

  // Computed: where `currentId` sits in the (possibly reactive) siblings.
  // -1 means "not present" — handled by the disappearance effect in Task 5.
  const currentIdx = React.useMemo(() => {
    if (!hasSiblings) return 0;
    return siblingsList.findIndex((s) => s.id === currentId);
  }, [hasSiblings, siblingsList, currentId]);

  const currentEntry = hasSiblings
    ? (siblingsList[currentIdx] ?? entry)
    : entry;
  const currentDownloadUrl =
    (hasSiblings ? currentEntry.originalUrl ?? currentEntry.outputUrl : downloadUrl) ??
    currentEntry.outputUrl;

  const goPrev = React.useCallback(() => {
    if (!hasSiblings) return;
    const idx = siblingsList.findIndex((s) => s.id === currentId);
    if (idx < 0) return;
    const next = (idx - 1 + siblingsList.length) % siblingsList.length;
    setCurrentId(siblingsList[next].id);
  }, [hasSiblings, siblingsList, currentId]);

  const goNext = React.useCallback(() => {
    if (!hasSiblings) return;
    const idx = siblingsList.findIndex((s) => s.id === currentId);
    if (idx < 0) return;
    const next = (idx + 1) % siblingsList.length;
    setCurrentId(siblingsList[next].id);
  }, [hasSiblings, siblingsList, currentId]);
```

- [ ] **Step 3: Update `handleOpenChange` (around lines 117-140) to reset by id**

**Old (the relevant lines only, the rest stays):**

```ts
  function handleOpenChange(next: boolean) {
    if (next) {
      captureTriggerRect();
      openAnimPlayedRef.current = false;
      // Reset to the tile that was clicked, not whatever sibling we last
      // navigated to in a previous session.
      setCurrentIdx(initialIndex);
      setOpen(true);
      return;
    }
```

**New:**

```ts
  function handleOpenChange(next: boolean) {
    if (next) {
      captureTriggerRect();
      openAnimPlayedRef.current = false;
      // Reset by id so subsequent re-opens start on the tile that was
      // actually clicked, not the sibling we navigated to last time.
      const seed = siblingsList[initialIndex]?.id ?? entry.id;
      setCurrentId(seed);
      setOpen(true);
      return;
    }
```

Leave the closing branch (lines 127-140) untouched.

- [ ] **Step 4: Lint + build**

Run: `npm run lint && npm run build`

Expected: zero new errors. Build succeeds.

- [ ] **Step 5: Manual regression check — Output-сегодня must still work**

1. `npm run dev`, open the app in a browser.
2. Open a completed Output tile. Arrow keys and chevrons should navigate between today's entries identically to before.
3. Close the dialog, click a different tile. The dialog should open on THAT tile (not where you left off).
4. Hard-reload and repeat — same behavior.

If any step fails, re-read the diff and correct before proceeding.

- [ ] **Step 6: Commit**

```bash
git add components/image-dialog.tsx
git commit -m "refactor(image-dialog): track nav by entry id instead of index"
```

---

## Task 4: Add `onNearEnd` prop to `ImageDialog`

**Files:**
- Modify: `components/image-dialog.tsx` — `ImageDialogProps` interface (lines 15-33) and a new effect after the keyboard effect (after line 201).

**Goal:** When the user advances within 2 positions of the tail of `siblings`, fire `onNearEnd(remainingAhead)` so the consumer (History sidebar) can kick off `loadMore`. Dedup: only fire when `remainingAhead` strictly decreases from the last fire, to avoid hammering `loadMore` on each arrow press while stuck at the end.

- [ ] **Step 1: Extend `ImageDialogProps`**

Find the existing interface around line 15:

```ts
export interface ImageDialogProps {
  entry: HistoryEntry;
  children: React.ReactNode;
  downloadUrl?: string;
  siblings?: HistoryEntry[];
  initialIndex?: number;
}
```

Add the new prop (keep the existing JSDoc for others):

```ts
export interface ImageDialogProps {
  entry: HistoryEntry;
  children: React.ReactNode;
  /**
   * Optional URL used for the Download button. When the dialog is showing
   * a downscaled preview (e.g. `mid_*.png`), callers should pass the full
   * original URL here so "Download" still saves the full-resolution file.
   * Falls back to `entry.outputUrl` when omitted.
   */
  downloadUrl?: string;
  /**
   * Full sibling list — enables in-dialog prev/next navigation via arrow
   * buttons (hover left/right edges) and keyboard arrows. When omitted,
   * the dialog behaves as a single-image viewer.
   */
  siblings?: HistoryEntry[];
  /** Index of `entry` inside `siblings`. Required when siblings is set. */
  initialIndex?: number;
  /**
   * Fired when navigation advances within N positions of the tail of
   * `siblings`, where `remainingAhead = siblings.length - currentIdx - 1`.
   * Consumers typically call `loadMore()` in response. Throttled: only
   * fires when `remainingAhead` strictly decreases from the last fire,
   * so stuck-at-end arrow mashing doesn't re-trigger.
   */
  onNearEnd?: (remainingAhead: number) => void;
}
```

- [ ] **Step 2: Accept the prop in the component signature**

Change the function signature on line 39 to include `onNearEnd`:

**Old:**

```ts
export function ImageDialog({ entry, children, downloadUrl, siblings, initialIndex = 0 }: ImageDialogProps) {
```

**New:**

```ts
export function ImageDialog({ entry, children, downloadUrl, siblings, initialIndex = 0, onNearEnd }: ImageDialogProps) {
```

- [ ] **Step 3: Add the near-end effect**

Place this immediately **after** the keyboard effect (after line 201, before `const effectiveDownloadUrl = currentDownloadUrl;`):

```ts
  // Near-end prefetch signal. Fires onNearEnd when navigation lands
  // within 2 positions of the end of siblings, with strict-decrease
  // throttling so a user mashing → at the tail doesn't re-trigger.
  // Reset the throttle when siblings grow (a new batch loaded in).
  const NEAR_END_THRESHOLD = 2;
  const lastFiredRemainingRef = React.useRef<number | null>(null);
  const lastSiblingsLenRef = React.useRef<number>(siblingsList.length);

  React.useEffect(() => {
    // Siblings grew (loadMore brought in more rows) → reset dedup so we
    // can fire again when the user approaches the new tail.
    if (siblingsList.length > lastSiblingsLenRef.current) {
      lastFiredRemainingRef.current = null;
    }
    lastSiblingsLenRef.current = siblingsList.length;
  }, [siblingsList.length]);

  React.useEffect(() => {
    if (!open || !hasSiblings || !onNearEnd) return;
    if (currentIdx < 0) return;
    const remaining = siblingsList.length - currentIdx - 1;
    if (remaining > NEAR_END_THRESHOLD) return;
    // Strict-decrease throttle: only fire when remaining gets smaller
    // than the last value we fired at. Prevents hammering while the
    // user sits on the last slide.
    const last = lastFiredRemainingRef.current;
    if (last !== null && remaining >= last) return;
    lastFiredRemainingRef.current = remaining;
    onNearEnd(remaining);
  }, [open, hasSiblings, onNearEnd, currentIdx, siblingsList.length]);
```

- [ ] **Step 4: Lint + build**

Run: `npm run lint && npm run build`

Expected: zero new errors. Build succeeds.

- [ ] **Step 5: Commit**

```bash
git add components/image-dialog.tsx
git commit -m "feat(image-dialog): onNearEnd prop for prefetch on tail approach"
```

---

## Task 5: Handle disappearance of `currentId` from siblings

**Files:**
- Modify: `components/image-dialog.tsx` — add a new effect after the Task 4 effect.

**Goal:** When SSE deletes the currently viewed entry (or any other reason `currentId` is no longer in `siblingsList`), smoothly jump to the nearest remaining sibling. If siblings becomes empty, close the dialog via `handleOpenChange(false)`.

- [ ] **Step 1: Add the disappearance effect**

Place this right after the near-end effect from Task 4:

```ts
  // Disappearance handling. If `currentId` is no longer present in the
  // (reactive) siblings — typically because the SSE `generation.deleted`
  // event removed it, or because a filter tightened — snap to the sibling
  // that occupies the same index the deleted one used to hold, clamped
  // to the new end. If siblings becomes empty, close the dialog.
  //
  // We read the "old index" by remembering the last-known idx for this
  // currentId in a ref. Why: once the entry is gone, `siblingsList.findIndex`
  // returns -1 and we've lost positional context without this memo.
  const lastKnownIdxRef = React.useRef<number>(currentIdx);
  React.useEffect(() => {
    if (currentIdx >= 0) {
      lastKnownIdxRef.current = currentIdx;
    }
  }, [currentIdx]);

  React.useEffect(() => {
    if (!open) return;
    if (!hasSiblings) return;
    // currentId is still in siblings → nothing to do.
    if (currentIdx >= 0) return;
    // currentId vanished. If siblings empty — close; otherwise clamp.
    if (siblingsList.length === 0) {
      handleOpenChange(false);
      return;
    }
    const clamped = Math.min(
      Math.max(lastKnownIdxRef.current, 0),
      siblingsList.length - 1
    );
    setCurrentId(siblingsList[clamped].id);
    // Note: we do NOT call onNearEnd here; the follow-up index-change
    // effect in Task 4 will handle that naturally if the clamped slot
    // is near the tail.
  }, [open, hasSiblings, currentIdx, siblingsList]);
```

**Note:** `handleOpenChange` is defined inside the component above this effect — the closure captures it. If the linter complains about a missing dep, it's safe to include `handleOpenChange` in the dep array; it's re-declared on every render but calling it is idempotent.

- [ ] **Step 2: Lint + build**

Run: `npm run lint && npm run build`

Expected: zero new errors. If the ESLint `react-hooks/exhaustive-deps` rule flags missing deps, add them. Build must succeed.

- [ ] **Step 3: Commit**

```bash
git add components/image-dialog.tsx
git commit -m "feat(image-dialog): gracefully handle removal of the current entry"
```

---

## Task 6: Wire siblings into `HistorySidebar` / `ServerEntryCard`

**Files:**
- Modify: `components/history-sidebar.tsx`

**Goal:** `HistorySidebar` calls `useHistorySiblings`, passes the array + the `onNearEnd` handler into each `ServerEntryCard`, which then passes them into `ImageDialog` with the right `initialIndex` for its own entry.

- [ ] **Step 1: Add the hook call in `HistorySidebar`**

Find the existing `useHistory` call in `HistorySidebar` (lines 96-108). Directly after it, add a `useHistorySiblings` call with the same params:

**Old (after the existing `const loading = isLoading;` line 109):**

```tsx
  const {
    items,
    hasMore,
    isLoading,
    isLoadingMore,
    error,
    loadMore,
    refetch,
  } = useHistory({
    username,
    startDate: dateRange.from,
    endDate: dateRange.to,
  });
  const loading = isLoading;
```

**New:**

```tsx
  const {
    items,
    hasMore,
    isLoading,
    isLoadingMore,
    error,
    loadMore,
    refetch,
  } = useHistory({
    username,
    startDate: dateRange.from,
    endDate: dateRange.to,
  });
  const loading = isLoading;

  // Sibling list for in-dialog prev/next nav. Shares the same filter
  // window as the sidebar so what you see is what you can navigate.
  // Note: useHistory is called twice under the hood here (once directly,
  // once inside useHistorySiblings). Both calls share the same fetch
  // cache via the HISTORY_REFRESH_EVENT listener, so this is effectively
  // free — refetches coalesce via the reqIdRef guard in useHistory.
  const {
    siblings: navSiblings,
    loadMore: navLoadMore,
    hasMore: navHasMore,
    loading: navLoading,
  } = useHistorySiblings({
    username,
    startDate: dateRange.from,
    endDate: dateRange.to,
  });

  const handleNearEnd = React.useCallback(() => {
    if (navHasMore && !navLoading) {
      navLoadMore();
    }
  }, [navHasMore, navLoading, navLoadMore]);
```

- [ ] **Step 2: Add the import for the new hook**

At the top of `components/history-sidebar.tsx` (around line 15, where `useHistory` is imported), add:

```tsx
import { useHistorySiblings } from "@/hooks/use-history-siblings";
```

- [ ] **Step 3: Pass siblings down through the render loop**

Find the render loop (around line 296):

**Old:**

```tsx
            {visibleItems.map((g) => (
              <ServerEntryCard
                key={g.id}
                gen={g}
                onDelete={() => handleDelete(g)}
              />
            ))}
```

**New:**

```tsx
            {visibleItems.map((g) => (
              <ServerEntryCard
                key={g.id}
                gen={g}
                onDelete={() => handleDelete(g)}
                siblings={navSiblings}
                onNearEnd={handleNearEnd}
              />
            ))}
```

- [ ] **Step 4: Extend `ServerEntryCard`'s props and pipe them into `ImageDialog`**

Find the `ServerEntryCard` signature at line 321:

**Old:**

```tsx
function ServerEntryCard({
  gen,
  onDelete,
}: {
  gen: ServerGeneration;
  onDelete: () => void;
}) {
```

**New:**

```tsx
function ServerEntryCard({
  gen,
  onDelete,
  siblings,
  onNearEnd,
}: {
  gen: ServerGeneration;
  onDelete: () => void;
  siblings: HistoryEntry[];
  onNearEnd: (remainingAhead: number) => void;
}) {
```

Next, inside `ServerEntryCard`, compute the stable id and initial index. Add this **before** the existing `async function handleCopy()` (around line 371):

```tsx
  // Locate this generation in the shared sibling list. Uses the same
  // stable uuid-based key the hook produced, so pending→confirmed swap
  // doesn't break navigation.
  const stableId = React.useMemo(() => {
    // Inline the stableGenerationId logic — import avoided to keep the
    // component imports minimal. If a reviewer prefers, import instead.
    if ((gen as { pending?: boolean }).pending) {
      return (gen as { uuid: string }).uuid.toLowerCase();
    }
    const img = gen.outputs.find((o) => o.content_type.startsWith("image/"));
    if (img) {
      const m = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\./i.exec(
        img.filepath
      );
      if (m) return m[1].toLowerCase();
    }
    return `server-${gen.id}`;
  }, [gen]);

  const initialSiblingIndex = React.useMemo(
    () => siblings.findIndex((s) => s.id === stableId),
    [siblings, stableId]
  );
```

**Better alternative (cleaner — use the shared helper):** instead of inlining, import `stableGenerationId` at the top:

```tsx
import {
  parsePromptData,
  serverGenToHistoryEntry,
  stableGenerationId,
} from "@/lib/server-gen-adapter";
```

…and replace the inline block with:

```tsx
  const stableId = React.useMemo(() => stableGenerationId(gen), [gen]);
  const initialSiblingIndex = React.useMemo(
    () => siblings.findIndex((s) => s.id === stableId),
    [siblings, stableId]
  );
```

**Use the alternative.** Delete the inline version above.

- [ ] **Step 5: Pass `siblings`, `initialIndex`, `onNearEnd` into `ImageDialog`**

**Critical:** the `entry` prop's `id` MUST match the `id` of the sibling at `initialIndex`, or Task 5's disappearance effect will misfire on every open. `serverGenToHistoryEntry` produces `id = String(gen.id)`, but `siblings` entries are uuid-keyed (from Task 1's `stableGenerationId`). So when this gen is in the sibling list, use the sibling entry itself; when it isn't (legacy row without uuid-shaped filename), fall back to the legacy adapter AND disable navigation for this card.

Find the existing `ImageDialog` usage around line 383-420:

**Old:**

```tsx
          <ImageDialog
            entry={serverGenToHistoryEntry(gen, data, midSrc)}
            downloadUrl={fullSrc}
          >
```

**New (extract the inner `<img>` into a variable first, then pick the wrapper):**

Just before the existing JSX `return (...)` of `ServerEntryCard` (around line 380, where it starts with `return ( <div className="flex w-full flex-col items-center">`), introduce the img JSX as a const. Replace:

```tsx
  return (
    <div className="flex w-full flex-col items-center">
      <div className="mb-2">
        {cardSrc && fullSrc && midSrc ? (
          <ImageDialog
            entry={serverGenToHistoryEntry(gen, data, midSrc)}
            downloadUrl={fullSrc}
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={cardSrc}
              alt={data.prompt || "generation"}
              width={140}
              height={140}
              loading="lazy"
              draggable
              onDragStart={(e) => {
                const payload = {
                  url: fullSrc!,
                  filename: firstImage!.filename,
                  contentType: firstImage!.content_type,
                };
                e.dataTransfer.setData(
                  "application/x-viewcomfy-media",
                  JSON.stringify(payload)
                );
                e.dataTransfer.effectAllowed = "copy";
              }}
              className="h-[140px] w-[140px] cursor-zoom-in rounded-md border border-border object-cover transition-all hover:scale-[1.03] hover:shadow-md"
              onError={() => {
                if (!triedFullRef.current && fullSrc && cardSrc !== fullSrc) {
                  triedFullRef.current = true;
                  setCardSrc(fullSrc);
                }
              }}
            />
          </ImageDialog>
        ) : pendingEntry ? (
```

…with:

```tsx
  // Inner thumbnail JSX — same element in both the navigable and the
  // fallback branches below, hoisted here to avoid duplication.
  const thumbJsx = cardSrc && fullSrc && midSrc ? (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={cardSrc}
      alt={data.prompt || "generation"}
      width={140}
      height={140}
      loading="lazy"
      draggable
      onDragStart={(e) => {
        const payload = {
          url: fullSrc!,
          filename: firstImage!.filename,
          contentType: firstImage!.content_type,
        };
        e.dataTransfer.setData(
          "application/x-viewcomfy-media",
          JSON.stringify(payload)
        );
        e.dataTransfer.effectAllowed = "copy";
      }}
      className="h-[140px] w-[140px] cursor-zoom-in rounded-md border border-border object-cover transition-all hover:scale-[1.03] hover:shadow-md"
      onError={() => {
        if (!triedFullRef.current && fullSrc && cardSrc !== fullSrc) {
          triedFullRef.current = true;
          setCardSrc(fullSrc);
        }
      }}
    />
  ) : null;

  return (
    <div className="flex w-full flex-col items-center">
      <div className="mb-2">
        {thumbJsx ? (
          initialSiblingIndex >= 0 ? (
            <ImageDialog
              entry={siblings[initialSiblingIndex]}
              downloadUrl={fullSrc}
              siblings={siblings.length > 1 ? siblings : undefined}
              initialIndex={initialSiblingIndex}
              onNearEnd={onNearEnd}
            >
              {thumbJsx}
            </ImageDialog>
          ) : (
            // Legacy row without uuid-shaped filename — can't safely
            // place it in the sibling list, so fall back to the old
            // single-image dialog (no chevrons, no keyboard nav).
            <ImageDialog
              entry={serverGenToHistoryEntry(gen, data, midSrc!)}
              downloadUrl={fullSrc}
            >
              {thumbJsx}
            </ImageDialog>
          )
        ) : pendingEntry ? (
```

(Leave the `pendingEntry ? (...) : (...)` block that follows unchanged.)

**Why this works:**
- The happy-path branch (`initialSiblingIndex >= 0`) uses `siblings[initialSiblingIndex]` — the uuid-keyed entry produced by `genToHistoryEntry`. Its `id` matches the `siblings` array, so `ImageDialog` opens on the right slide and the Task 5 effect sees `currentIdx >= 0` (no misfire).
- The fallback branch is for legacy rows whose filepath doesn't parse as a uuid. We keep the old single-image behavior (no `siblings` prop → chevrons don't render → no navigation for this specific card, which is correct since we can't position it in the list).
- The inner `<img>` JSX is duplicated across branches for clarity; a reviewer may DRY it into a helper if preferred, but only after the fix lands and is verified.

**Equivalence check with the old code:**
- Old `entry={serverGenToHistoryEntry(gen, data, midSrc)}` had `outputUrl = midSrc` (the cached blob URL or server URL).
- New `entry={siblings[initialSiblingIndex]}` has `outputUrl = midUrl` (the direct server URL).
- `ImageDialog` internally runs `useCachedImage(outputUrl)` (see `components/image-dialog.tsx:185-189`), which resolves direct URLs to the cached blob when available. So the on-screen pixel result is identical; the caching layer is just consulted one level deeper than before.

- [ ] **Step 6: Lint + build**

Run: `npm run lint && npm run build`

Expected: zero new errors. Build succeeds.

- [ ] **Step 7: Manual verification — the core feature works**

1. `npm run dev`.
2. Open the History sidebar. Wait for the first page to load.
3. Click any card. Dialog opens.
4. Hover left/right quarters of the image — `ChevronLeft` / `ChevronRight` appear, visually identical to Output-today.
5. Press `→` several times — you navigate through siblings in desc-by-createdAt order.
6. Keep pressing `→`. When you're 2 positions from the end of the loaded page, the next page should silently fetch; the arrow never hits a hard wall until `hasMore === false`.
7. Press `←` — works both by keyboard and by clicking the left hover zone.
8. Press `Esc` — dialog closes.

- [ ] **Step 8: Commit**

```bash
git add components/history-sidebar.tsx
git commit -m "feat(history): sibling nav in ImageDialog with prefetch on tail approach"
```

---

## Task 7: Regression sweep + SSE/delete edge cases

**Files:**
- No code changes. Manual verification + final build.

**Goal:** Confirm all the non-golden-path scenarios from the spec's edge case table behave correctly. If any fail, fix inline and re-verify.

- [ ] **Step 1: Output-сегодня regression**

1. Reload the app. Open a today tile from the Output area.
2. Arrow-navigate across today entries. Behavior must be identical to before this plan.
3. Remove the current tile (trash icon inside the dialog area or via the card's X on close). Output should re-render without crashing.
4. Create a new generation. It should appear in Output without duplicate cards and without stealing the dialog's focus.

- [ ] **Step 2: Two-tab SSE test**

1. Open the app in Tab A. Open the History sidebar. Open a card.
2. In Tab B (same origin, same user), run a new generation (or delete a History row).
3. In Tab A with the dialog open:
   - Create: `siblings` should grow; the near-end prefetch logic should tolerate it (no errors in the console).
   - Delete of non-current: the deleted card disappears from siblings; current stays put.
   - Delete of the current card: the dialog re-snaps to the nearest remaining sibling without visible flicker. If Tab B deleted the last remaining item, the dialog closes.

- [ ] **Step 3: Pending → confirmed transition**

1. With the sidebar open, start a new generation (form in the main app).
2. Before the POST completes, the pending card appears in the sidebar. Click it — dialog opens on the pending entry (thumb/mid blob URL visible).
3. Wait for POST to complete (~1-3s). The pending entry is replaced by the server row with the same uuid. The dialog should stay open on the same slide — **the `id` is uuid-stable, so no disappearance handling fires**. The underlying image URL swaps from `blob:` to `/api/history/image/...` but visually this is transparent because the two sources are the same bytes.

- [ ] **Step 4: Prefetch with slow network**

1. Open DevTools → Network → throttle to "Slow 3G".
2. Open History. Click a card. Use `→` to navigate rapidly toward the end of the loaded page.
3. Expected: when `remainingAhead <= 2`, `loadMore` fires (visible in the Network panel as a `GET /api/history?offset=...`). The arrow does not hang; the user can keep navigating within what's loaded. When the fetch resolves, `siblings` grows and further `→` presses continue into the new rows.
4. Reset throttling.

- [ ] **Step 5: End-of-history**

1. Narrow the date filter to something that returns fewer than `PAGE_SIZE` (20) rows.
2. Open a card, navigate to the very last entry. `→` should wrap to the first (modulo behavior — matches Output-today).
3. Confirm `hasMore` stayed `false` throughout (no phantom `loadMore` requests in Network).

- [ ] **Step 6: Final build**

Run: `npm run lint && npm run build`

Expected: both clean.

- [ ] **Step 7: Finalize**

If this plan ran in a worktree or feature branch, offer to merge / PR it using the `superpowers:finishing-a-development-branch` sub-skill. Otherwise, the commits from Tasks 1–6 are already on the working branch.

---

## Acceptance criteria recap

- Clicking any History sidebar card opens the dialog with working `←` / `→` (when `siblings.length > 1`).
- All navigation widgets are visually identical to Output-today (same chevrons, same gradients, same keyboard handler — because the exact same JSX renders for both consumers).
- Prefetch fires at `remainingAhead <= 2`; the user can traverse the entire history without manually scrolling the sidebar.
- SSE `generation.created` adds to siblings reactively.
- SSE `generation.deleted` of the current entry snaps to a sibling; emptying siblings closes the dialog.
- Pending→confirmed transition is transparent (uuid-stable id).
- Output-today works unchanged.
- `npm run lint` and `npm run build` pass with zero new warnings/errors.

## Risk hotspots (watch list)

1. **Reactivity of `siblings` prop in `ImageDialog`.** Task 3 replaces index-state with id-state precisely to survive reactive sibling updates. Any regression where `currentIdx` is cached in a stale closure will manifest as "pressing → moves to the wrong slide after a new row arrives via SSE". Fix by re-confirming `goPrev`/`goNext` read siblings fresh each call.
2. **`findIndex` on every render.** For typical history sizes (< 1000 entries) this is negligible; don't pre-optimize.
3. **Double `useHistory` invocation.** `HistorySidebar` calls it directly; `useHistorySiblings` calls it internally. Both will fire their own `fetchFirstPage` on mount. This is safe (`reqIdRef` guards stale responses) and coalesced by the shared `HISTORY_REFRESH_EVENT`, but it does mean ~2× the network on first paint. Acceptable for MVP; a shared context is an obvious follow-up if it becomes a perf issue.
4. **Pending entry without blob URLs.** `genToHistoryEntry` returns `null` for pending without blobs; these are silently skipped from `siblings`. If the sidebar still renders them as skeletons, they won't be reachable via `→` — which is the designed behavior (vs. Q3 choice C). No action needed, just be aware.

---

**Plan complete and saved to `docs/superpowers/plans/2026-04-12-history-image-switcher.md`.**
