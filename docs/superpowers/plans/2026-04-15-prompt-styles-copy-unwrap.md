# Prompt Styles Copy-Unwrap Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When a user copies a prompt from a past generation, unwrap the style prefix/suffix, set the style dropdown to the style that was used, and show a context-aware toast — instead of pasting the already-wrapped string back into the textarea where it would be double-wrapped on submit.

**Architecture:** Persist two new fields (`userPrompt`, `styleId`) in the existing `prompt_data` JSON blob. Read them on hydrate, write them on generation. A pure `applyCopiedPrompt` helper handles four branches (pre-feature / default / existing / deleted). Lift the `styles` state from `GenerateForm` up to the shared parent `playground.tsx` so all three consumers (form, output, sidebar) see the same list. UI renders the clean user text plus a style badge in history cards, falling back to the wrapped string for old entries.

**Tech Stack:** Next.js 15 App Router + TypeScript, Zustand (`useSettingsStore`, `usePromptStore`), better-sqlite3, Vitest, sonner toasts, Tailwind.

**Spec:** `docs/superpowers/specs/2026-04-15-prompt-styles-copy-unwrap-design.md`

---

## File Structure

**New files:**
- `lib/styles/apply-copied.ts` — pure helper `applyCopiedPrompt(entry, styles, setters)` with the four-branch logic.
- `lib/styles/__tests__/apply-copied.test.ts` — four unit tests mapping to the four branches.

**Modified files:**
- `lib/history/types.ts` — add `userPrompt?: string; styleId?: string` to `HistoryEntry`.
- `lib/history/store.ts` — extend `serverGenToEntry` to read the new fields from `prompt_data`.
- `lib/history/__tests__/store.test.ts` — add two tests for the new fields (post-feature roundtrip + pre-feature fallback).
- `components/generate-form.tsx` — write the new fields into `promptPayload`; remove local styles fetch/state (moved to parent); accept `styles` prop.
- `components/playground.tsx` — lift styles state, fetch, reconcile, focus listener; pass `styles` down to three children.
- `components/output-area.tsx` — accept `styles` prop; use `displayPromptText`; render style badge; copy button calls `applyCopiedPrompt`.
- `components/history-sidebar.tsx` — same three changes as output-area.

---

## Task 1: Extend HistoryEntry type

**Files:**
- Modify: `lib/history/types.ts`

- [ ] **Step 1: Edit the interface**

Open `lib/history/types.ts`. Find the `HistoryEntry` interface (starts around line 18). Inside the `// === Generation metadata ===` section, after the existing `prompt: string;` line (around line 38), add:

```ts
  /** Clean user-authored part of the prompt (before style wrapping).
   *  Undefined on pre-feature entries — consumers must fall back to `prompt`. */
  userPrompt?: string;

  /** Id of the style applied at generation time (e.g. "kino-a3f" or
   *  "__default__" for explicit no-op). Undefined on pre-feature entries. */
  styleId?: string;
```

- [ ] **Step 2: Type-check**

Run: `npx tsc --noEmit`
Expected: no new errors.

- [ ] **Step 3: Commit**

```bash
git add lib/history/types.ts
git commit -m "feat(history): add optional userPrompt and styleId to HistoryEntry"
```

---

## Task 2: Hydrate parse — read userPrompt and styleId

**Files:**
- Modify: `lib/history/store.ts` (specifically `serverGenToEntry`, around lines 113-142)
- Modify: `lib/history/__tests__/store.test.ts`

- [ ] **Step 1: Write the failing tests**

Open `lib/history/__tests__/store.test.ts`. Find the existing `mkRow` helper and the tests that use it. Add two new tests (append to the appropriate `describe` block that already exercises `applyServerRow` / `serverGenToEntry`). The pattern mirrors existing tests; use this exact code:

```ts
it("hydrates userPrompt and styleId from prompt_data when present", () => {
  const row = mkRow({
    prompt_data: JSON.stringify({
      prompt: "cinematic. a cat. 35mm",
      userPrompt: "a cat",
      styleId: "kino-a3f",
    }),
  });
  const entry = serverGenToEntry(row, "uuid-1");
  expect(entry.prompt).toBe("cinematic. a cat. 35mm");
  expect(entry.userPrompt).toBe("a cat");
  expect(entry.styleId).toBe("kino-a3f");
});

it("leaves userPrompt and styleId undefined for pre-feature entries", () => {
  const row = mkRow({
    prompt_data: JSON.stringify({ prompt: "a cat" }),
  });
  const entry = serverGenToEntry(row, "uuid-2");
  expect(entry.prompt).toBe("a cat");
  expect(entry.userPrompt).toBeUndefined();
  expect(entry.styleId).toBeUndefined();
});
```

**Note:** The tests reference `serverGenToEntry` which is currently **not exported** from `lib/history/store.ts`. You must export it in Step 3 so the tests can import it. Add the import in the test file header:

```ts
import { serverGenToEntry } from "../store";
```

(If the existing tests already exercise this function via a different path such as `applyServerRow`, adapt the calls to match — but read the existing file first and prefer the direct function call if possible. Check how `mkRow` is defined in the existing test file so your new tests match its signature.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- lib/history/__tests__/store.test.ts`
Expected: FAIL — new tests fail on undefined import and/or missing fields.

- [ ] **Step 3: Export and extend `serverGenToEntry`**

In `lib/history/store.ts`:

- First, change `function serverGenToEntry(...)` at line 113 to `export function serverGenToEntry(...)` so tests can import it.

- Replace the `JSON.parse` block (lines 117-122) with this extended parse:

```ts
  let userPrompt: string | undefined;
  let styleId: string | undefined;
  try {
    const parsed = JSON.parse(row.prompt_data) as {
      prompt?: string;
      workflow?: string;
      userPrompt?: string;
      styleId?: string;
    };
    prompt = parsed.prompt ?? "";
    workflowName = parsed.workflow ?? row.workflow_name;
    if (typeof parsed.userPrompt === "string") userPrompt = parsed.userPrompt;
    if (typeof parsed.styleId === "string") styleId = parsed.styleId;
  } catch {
    // Malformed prompt_data — keep prompt as "".
  }
```

- In the returned `HistoryEntry` object (lines 126-141), add the two new fields right after `prompt,`:

```ts
  return {
    id: uuid,
    serverGenId: row.id,
    state: "live",
    confirmed: true,
    prompt,
    userPrompt,
    styleId,
    provider: "wavespeed",
    // ...rest unchanged
  };
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- lib/history/__tests__/store.test.ts`
Expected: all tests pass (including the two new ones).

Also run the full suite to confirm nothing else regressed:
Run: `npm test`
Expected: 48+ tests pass (46 previous + 2 new).

- [ ] **Step 5: Commit**

```bash
git add lib/history/store.ts lib/history/__tests__/store.test.ts
git commit -m "feat(history): read userPrompt and styleId from prompt_data on hydrate"
```

---

## Task 3: Write userPrompt and styleId at generation time

**Files:**
- Modify: `components/generate-form.tsx` (specifically the `promptPayload` object inside `saveToServerHistory`)

**Context:** After the shipped styles feature, `components/generate-form.tsx` constructs a `promptPayload` object inside the `saveToServerHistory` inner function (around line 237). That object is serialized into the server's `prompt_data` TEXT column. We add two new fields there. The existing `activeStyle` memo and `composeFinalPrompt` call are already in place.

- [ ] **Step 1: Edit the promptPayload object**

In `components/generate-form.tsx`, find the `promptPayload` object. It currently looks like this:

```ts
      const promptPayload = {
        prompt: composeFinalPrompt(prompt.trim(), activeStyle),
        resolution: hasResolutions ? resolution : undefined,
        aspectRatio: aspectRatio || undefined,
        outputFormat,
        provider: activeProvider,
        modelId: selectedModel,
        model: getModelString(activeProvider, selectedModel, hasImages),
        inputThumbnails: thumbnails,
      };
```

Replace it with:

```ts
      const promptPayload = {
        prompt: composeFinalPrompt(prompt.trim(), activeStyle),
        userPrompt: prompt.trim(),
        styleId: activeStyle ? activeStyle.id : DEFAULT_STYLE_ID,
        resolution: hasResolutions ? resolution : undefined,
        aspectRatio: aspectRatio || undefined,
        outputFormat,
        provider: activeProvider,
        modelId: selectedModel,
        model: getModelString(activeProvider, selectedModel, hasImages),
        inputThumbnails: thumbnails,
      };
```

**Do not change** the fetch body at `/api/generate/submit` — that payload is the live request to the provider and does not go through `prompt_data`.

- [ ] **Step 2: Type-check**

Run: `npx tsc --noEmit`
Expected: no new errors. `DEFAULT_STYLE_ID` is already imported at the top of the file from Task 9 of the previous plan.

- [ ] **Step 3: Tests**

Run: `npm test`
Expected: 48 tests pass.

- [ ] **Step 4: Commit**

```bash
git add components/generate-form.tsx
git commit -m "feat(styles): persist userPrompt and styleId in generation history"
```

---

## Task 4: applyCopiedPrompt pure helper + tests (TDD)

**Files:**
- Create: `lib/styles/apply-copied.ts`
- Create: `lib/styles/__tests__/apply-copied.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `lib/styles/__tests__/apply-copied.test.ts` with this exact content:

```ts
import { describe, it, expect, vi } from "vitest";
import { applyCopiedPrompt } from "../apply-copied";
import { DEFAULT_STYLE_ID, type Style } from "../types";

function makeStyle(overrides: Partial<Style>): Style {
  return {
    id: "kino-a3f",
    name: "Кино",
    prefix: "cinematic",
    suffix: "35mm",
    createdAt: "2026-04-15T00:00:00.000Z",
    updatedAt: "2026-04-15T00:00:00.000Z",
    ...overrides,
  };
}

function makeSetters() {
  return {
    setPrompt: vi.fn(),
    setSelectedStyleId: vi.fn(),
    toastInfo: vi.fn(),
    toastWarn: vi.fn(),
  };
}

describe("applyCopiedPrompt", () => {
  it("pre-feature entry: pastes entry.prompt, leaves dropdown alone", () => {
    const setters = makeSetters();
    applyCopiedPrompt(
      { prompt: "a cat", userPrompt: undefined, styleId: undefined },
      [],
      setters
    );
    expect(setters.setPrompt).toHaveBeenCalledWith("a cat");
    expect(setters.setSelectedStyleId).not.toHaveBeenCalled();
    expect(setters.toastInfo).toHaveBeenCalledWith("Промпт скопирован");
    expect(setters.toastWarn).not.toHaveBeenCalled();
  });

  it("default-style entry: pastes userPrompt, resets dropdown to default", () => {
    const setters = makeSetters();
    applyCopiedPrompt(
      { prompt: "a cat", userPrompt: "a cat", styleId: DEFAULT_STYLE_ID },
      [],
      setters
    );
    expect(setters.setPrompt).toHaveBeenCalledWith("a cat");
    expect(setters.setSelectedStyleId).toHaveBeenCalledWith(DEFAULT_STYLE_ID);
    expect(setters.toastInfo).toHaveBeenCalledWith("Промпт скопирован");
    expect(setters.toastWarn).not.toHaveBeenCalled();
  });

  it("existing-style entry: pastes userPrompt, sets dropdown, toast with style name", () => {
    const setters = makeSetters();
    const kino = makeStyle({});
    applyCopiedPrompt(
      {
        prompt: "cinematic. a cat. 35mm",
        userPrompt: "a cat",
        styleId: "kino-a3f",
      },
      [kino],
      setters
    );
    expect(setters.setPrompt).toHaveBeenCalledWith("a cat");
    expect(setters.setSelectedStyleId).toHaveBeenCalledWith("kino-a3f");
    expect(setters.toastInfo).toHaveBeenCalledWith(
      'Промпт скопирован, стиль «Кино» применён'
    );
    expect(setters.toastWarn).not.toHaveBeenCalled();
  });

  it("deleted-style entry: pastes wrapped prompt, resets dropdown, warning toast", () => {
    const setters = makeSetters();
    applyCopiedPrompt(
      {
        prompt: "cinematic. a cat. 35mm",
        userPrompt: "a cat",
        styleId: "kino-a3f",
      },
      [], // style no longer in list
      setters
    );
    expect(setters.setPrompt).toHaveBeenCalledWith("cinematic. a cat. 35mm");
    expect(setters.setSelectedStyleId).toHaveBeenCalledWith(DEFAULT_STYLE_ID);
    expect(setters.toastInfo).not.toHaveBeenCalled();
    expect(setters.toastWarn).toHaveBeenCalledWith(
      "Стиль больше не существует, промпт вставлен как есть"
    );
  });

  it("falls back to entry.prompt when userPrompt is missing but styleId is default", () => {
    // Unusual but possible: styleId present, userPrompt absent (malformed record).
    const setters = makeSetters();
    applyCopiedPrompt(
      { prompt: "a cat", userPrompt: undefined, styleId: DEFAULT_STYLE_ID },
      [],
      setters
    );
    expect(setters.setPrompt).toHaveBeenCalledWith("a cat");
    expect(setters.setSelectedStyleId).toHaveBeenCalledWith(DEFAULT_STYLE_ID);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- lib/styles/__tests__/apply-copied.test.ts`
Expected: FAIL — `../apply-copied` does not exist yet.

- [ ] **Step 3: Write the helper**

Create `lib/styles/apply-copied.ts` with this exact content:

```ts
import { DEFAULT_STYLE_ID, type Style } from "./types";

export interface CopiedEntry {
  /** The wrapped prompt as stored. Always present. */
  prompt: string;
  /** Clean user-authored part if the entry was generated post-feature. */
  userPrompt?: string;
  /** Id of the style applied at generation, or undefined on pre-feature entries. */
  styleId?: string;
}

export interface ApplyCopiedSetters {
  setPrompt: (s: string) => void;
  setSelectedStyleId: (id: string) => void;
  toastInfo: (msg: string) => void;
  toastWarn: (msg: string) => void;
}

/**
 * Four branches:
 *   1. Pre-feature (no styleId) — paste entry.prompt, leave dropdown alone.
 *   2. Default style — paste clean userPrompt, reset dropdown to default.
 *   3. Existing style — paste clean userPrompt, set dropdown, toast style name.
 *   4. Deleted style — paste wrapped entry.prompt, reset dropdown, warn.
 */
export function applyCopiedPrompt(
  entry: CopiedEntry,
  styles: readonly Style[],
  setters: ApplyCopiedSetters
): void {
  if (entry.styleId === undefined) {
    setters.setPrompt(entry.prompt);
    setters.toastInfo("Промпт скопирован");
    return;
  }

  if (entry.styleId === DEFAULT_STYLE_ID) {
    setters.setPrompt(entry.userPrompt ?? entry.prompt);
    setters.setSelectedStyleId(DEFAULT_STYLE_ID);
    setters.toastInfo("Промпт скопирован");
    return;
  }

  const existing = styles.find((s) => s.id === entry.styleId);
  if (existing) {
    setters.setPrompt(entry.userPrompt ?? entry.prompt);
    setters.setSelectedStyleId(entry.styleId);
    setters.toastInfo(`Промпт скопирован, стиль «${existing.name}» применён`);
    return;
  }

  // Deleted
  setters.setPrompt(entry.prompt);
  setters.setSelectedStyleId(DEFAULT_STYLE_ID);
  setters.toastWarn("Стиль больше не существует, промпт вставлен как есть");
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- lib/styles/__tests__/apply-copied.test.ts`
Expected: all 5 tests PASS.

Run: `npm test`
Expected: 53 tests pass.

- [ ] **Step 5: Commit**

```bash
git add lib/styles/apply-copied.ts lib/styles/__tests__/apply-copied.test.ts
git commit -m "feat(styles): add applyCopiedPrompt pure helper with four-branch logic"
```

---

## Task 5: Lift styles state from GenerateForm to Playground

**Files:**
- Modify: `components/playground.tsx` — lift state.
- Modify: `components/generate-form.tsx` — remove local state, accept props.

**Context:** Currently `GenerateForm` holds `styles` state, the `loadStyles` callback, the focus listener, and the `activeStyle` memo. The copy feature needs `styles` in sibling components too, so we move the state and loader to the shared parent `playground.tsx` (clean, 179-line file) and pass `styles` down as a prop.

### Part 5a — Modify `components/playground.tsx`

- [ ] **Step 1: Add imports**

Near the existing imports (around line 14), add:

```ts
import type { Style } from "@/lib/styles/types";
```

Also ensure `useSettingsStore`'s `reconcileSelectedStyle` is selectable. `useSettingsStore` is already imported; we'll pull `reconcileSelectedStyle` inside the component body.

- [ ] **Step 2: Add state + loader + focus listener inside `Playground`**

Right after the existing `useSettingsStore` reads (around line 48), add:

```ts
  const reconcileSelectedStyle = useSettingsStore((s) => s.reconcileSelectedStyle);
  const [styles, setStyles] = React.useState<Style[]>([]);

  const loadStyles = React.useCallback(async () => {
    try {
      const res = await fetch("/api/styles", { cache: "no-store" });
      if (!res.ok) return;
      const data = (await res.json()) as { styles: Style[] };
      setStyles(data.styles);
      reconcileSelectedStyle(data.styles.map((s) => s.id));
    } catch (err) {
      console.warn("[playground] failed to load styles:", err);
    }
  }, [reconcileSelectedStyle]);

  React.useEffect(() => {
    void loadStyles();
    const onFocus = () => void loadStyles();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [loadStyles]);
```

- [ ] **Step 3: Pass `styles` to the three children**

In the JSX (around lines 163, 170, 174), change the three component invocations:

From:
```tsx
              <GenerateForm />
```
To:
```tsx
              <GenerateForm styles={styles} />
```

From:
```tsx
          <OutputArea
            historyOpen={historyOpen}
            onToggleHistory={() => setHistoryOpen((v) => !v)}
          />
```
To:
```tsx
          <OutputArea
            historyOpen={historyOpen}
            onToggleHistory={() => setHistoryOpen((v) => !v)}
            styles={styles}
          />
```

From:
```tsx
          <HistorySidebar open={historyOpen} setOpen={setHistoryOpen} />
```
To:
```tsx
          <HistorySidebar open={historyOpen} setOpen={setHistoryOpen} styles={styles} />
```

### Part 5b — Modify `components/generate-form.tsx`

- [ ] **Step 4: Accept `styles` prop; drop local fetch/state/effect**

Find the `GenerateForm` component signature (around line 121). It currently looks like:

```tsx
export function GenerateForm() {
```

Change to:

```tsx
interface GenerateFormProps {
  styles: Style[];
}

export function GenerateForm({ styles }: GenerateFormProps) {
```

Then locate the block added in Task 9 of the previous plan that contains `const [styles, setStyles] = React.useState<Style[]>([])`, `const loadStyles = React.useCallback(...)`, and the `useEffect` with the `window` focus listener, plus `reconcileSelectedStyle` (if selected here).

**Delete** that entire block, including:
- The `const selectedStyleId = useSettingsStore((s) => s.selectedStyleId);` line (keep this one — still used by the dropdown below).
- The `const setSelectedStyleId = useSettingsStore((s) => s.setSelectedStyleId);` line (keep this one too).
- The `const reconcileSelectedStyle = useSettingsStore((s) => s.reconcileSelectedStyle);` line — **remove**, moved to playground.
- `const [styles, setStyles] = React.useState<Style[]>([])` — **remove**, now prop.
- `const loadStyles = React.useCallback(...)` — **remove**.
- `React.useEffect(() => { void loadStyles(); ... window.addEventListener("focus", onFocus); ... })` — **remove**.

**Keep** the `activeStyle` memo (still used by `composeFinalPrompt` calls):

```ts
  const activeStyle = React.useMemo<Style | null>(() => {
    if (selectedStyleId === DEFAULT_STYLE_ID) return null;
    return styles.find((s) => s.id === selectedStyleId) ?? null;
  }, [styles, selectedStyleId]);
```

- [ ] **Step 5: Type-check**

Run: `npx tsc --noEmit`
Expected: no new errors. If any appear about missing `styles` on children, re-check that the three child components got the prop in Step 3.

- [ ] **Step 6: Tests**

Run: `npm test`
Expected: 53 tests still pass (no test files changed).

- [ ] **Step 7: Manual smoke — confirm no regression**

Run `npm run dev`. Open the main page. Verify:
- The Стиль dropdown in the form still loads after page load.
- The dropdown still updates when you add a style in /admin and refocus the main tab (focus listener now lives in the parent, effect is the same).
- Submitting a prompt with a style still wraps it correctly.

- [ ] **Step 8: Commit**

```bash
git add components/playground.tsx components/generate-form.tsx
git commit -m "refactor(styles): lift styles state from GenerateForm to Playground"
```

---

## Task 6: Sidebar + output-area — badge, clean display, copy refactor

**Files:**
- Modify: `components/history-sidebar.tsx` (lines 261-269 copy handler, line 274 alt, line 341 disabled, lines 358-361 prompt text display)
- Modify: `components/output-area.tsx` (line 184 alt, lines 324-331 prompt text display, lines 336-344 copy handler)

**Context:** Each file has three modifications: (1) accept a new `styles` prop, (2) compute `displayText = entry.userPrompt ?? entry.prompt` and use it in prompt text render, (3) replace the inline copy handler with a call to `applyCopiedPrompt`, and (4) render the style badge conditionally.

Both files use shadcn `Sparkles` icon from `lucide-react`. Check the existing imports — `Sparkles` is already imported in `generate-form.tsx` but may not be in these two files. Add the import if absent.

### Part 6a — `components/history-sidebar.tsx`

- [ ] **Step 1: Update imports and component signature**

At the top of the file, add (or extend existing lines) these imports:

```ts
import { Sparkles } from "lucide-react";
import { DEFAULT_STYLE_ID, type Style } from "@/lib/styles/types";
import { applyCopiedPrompt } from "@/lib/styles/apply-copied";
import { useSettingsStore } from "@/stores/settings-store";
```

Locate the existing exported component (the function that renders the sidebar — likely `HistorySidebar` with existing props `open` and `setOpen`). Extend the props to include `styles: Style[]`.

Also locate the card sub-component inside this file — it's the one that uses `entry.prompt`. That sub-component needs the same `styles` prop drilled in from its parent.

- [ ] **Step 2: Update the copy handler**

Replace the existing `handleCopy` (lines 262-269):

```ts
  async function handleCopy() {
    if (!entry.prompt) return;
    const ok = await copyToClipboard(entry.prompt);
    if (ok) {
      usePromptStore.getState().setPrompt(entry.prompt);
      toast.success("Промпт применён и скопирован", { duration: 1500 });
    }
  }
```

with:

```ts
  async function handleCopy() {
    if (!entry.prompt) return;
    const ok = await copyToClipboard(entry.prompt);
    if (!ok) return;
    applyCopiedPrompt(
      {
        prompt: entry.prompt,
        userPrompt: entry.userPrompt,
        styleId: entry.styleId,
      },
      styles,
      {
        setPrompt: (s) => usePromptStore.getState().setPrompt(s),
        setSelectedStyleId: (id) =>
          useSettingsStore.getState().setSelectedStyleId(id),
        toastInfo: (msg) => toast.success(msg, { duration: 1500 }),
        toastWarn: (msg) => toast.warning(msg, { duration: 3000 }),
      }
    );
  }
```

- [ ] **Step 3: Update the rendered prompt text**

Find the block (lines 358-362):

```tsx
      {entry.prompt && (
        <div className="mt-1 w-full">
          <p className="line-clamp-3 text-xs italic text-muted-foreground">
            {entry.prompt}
          </p>
```

Change to:

```tsx
      {(entry.userPrompt ?? entry.prompt) && (
        <div className="mt-1 w-full">
          <p className="line-clamp-3 text-xs italic text-muted-foreground">
            {entry.userPrompt ?? entry.prompt}
          </p>
          {entry.styleId && entry.styleId !== DEFAULT_STYLE_ID && (
            <span className="mt-0.5 inline-flex items-center gap-1 text-[10px] text-muted-foreground">
              <Sparkles className="h-3 w-3" />
              Стиль: {styles.find((s) => s.id === entry.styleId)?.name ?? entry.styleId}
            </span>
          )}
```

**Do not change** the `alt={entry.prompt || "generation"}` at line 274 — alt text keeps the full wrapped string for a11y/SEO.

**Do not change** the `disabled={!entry.prompt}` at line 341 — button disable condition stays based on wrapped prompt presence (which is always present for any real entry).

- [ ] **Step 4: Type-check**

Run: `npx tsc --noEmit`
Expected: no new errors.

### Part 6b — `components/output-area.tsx`

- [ ] **Step 5: Update imports and component signature**

Add (or extend existing imports):

```ts
import { Sparkles } from "lucide-react";
import { DEFAULT_STYLE_ID, type Style } from "@/lib/styles/types";
import { applyCopiedPrompt } from "@/lib/styles/apply-copied";
import { useSettingsStore } from "@/stores/settings-store";
```

Extend `OutputArea`'s props to include `styles: Style[]`. The existing props are `historyOpen`, `onToggleHistory` — add `styles` alongside them.

- [ ] **Step 6: Update the copy button's inline handler**

Find the copy button in `output-area.tsx` (lines 336-344). It currently looks like:

```tsx
            onClick={async (e) => {
              e.stopPropagation();
              e.preventDefault();
              const ok = await copyToClipboard(entry.prompt);
              if (ok) {
                usePromptStore.getState().setPrompt(entry.prompt);
                toast.success("Промпт применён и скопирован", { duration: 1500 });
              }
            }}
```

Replace with:

```tsx
            onClick={async (e) => {
              e.stopPropagation();
              e.preventDefault();
              const ok = await copyToClipboard(entry.prompt);
              if (!ok) return;
              applyCopiedPrompt(
                {
                  prompt: entry.prompt,
                  userPrompt: entry.userPrompt,
                  styleId: entry.styleId,
                },
                styles,
                {
                  setPrompt: (s) => usePromptStore.getState().setPrompt(s),
                  setSelectedStyleId: (id) =>
                    useSettingsStore.getState().setSelectedStyleId(id),
                  toastInfo: (msg) => toast.success(msg, { duration: 1500 }),
                  toastWarn: (msg) => toast.warning(msg, { duration: 3000 }),
                }
              );
            }}
```

- [ ] **Step 7: Update the rendered prompt text**

Find the block at lines 324-331:

```tsx
      {entry.prompt && (
        <div className="flex w-full items-start gap-1.5 px-1">
          <p
            className="flex-1 line-clamp-3 text-xs italic text-muted-foreground"
            title={entry.prompt}
          >
            {entry.prompt}
          </p>
```

Change to:

```tsx
      {(entry.userPrompt ?? entry.prompt) && (
        <div className="flex w-full items-start gap-1.5 px-1">
          <div className="flex-1 min-w-0">
            <p
              className="line-clamp-3 text-xs italic text-muted-foreground"
              title={entry.prompt}
            >
              {entry.userPrompt ?? entry.prompt}
            </p>
            {entry.styleId && entry.styleId !== DEFAULT_STYLE_ID && (
              <span className="mt-0.5 inline-flex items-center gap-1 text-[10px] text-muted-foreground">
                <Sparkles className="h-3 w-3" />
                Стиль: {styles.find((s) => s.id === entry.styleId)?.name ?? entry.styleId}
              </span>
            )}
          </div>
```

**Note:** the outer `<div>` gains a `min-w-0` wrapper around the `<p>` so `line-clamp-3` still behaves in a flex layout. The `title={entry.prompt}` deliberately keeps the wrapped version so hover-tooltip reveals the full sent text.

Make sure the trailing structure (the copy `<Button>` after the `<p>`) stays intact — you're replacing the `<p>` with a wrapper that contains `<p>` + the badge, not deleting the button.

**Do not change** the `alt={entry.prompt}` at line 184.

- [ ] **Step 8: Type-check**

Run: `npx tsc --noEmit`
Expected: no new errors.

- [ ] **Step 9: Tests**

Run: `npm test`
Expected: 53 tests pass (no test files modified in Task 6; only components).

- [ ] **Step 10: Commit**

```bash
git add components/history-sidebar.tsx components/output-area.tsx
git commit -m "feat(styles): unwrap prompt on copy, show style badge in history cards"
```

---

## Task 7: End-to-end verification

- [ ] **Step 1: Full test suite**

Run: `npm test`
Expected: 53 tests pass (46 pre-plan + 2 new hydrate tests + 5 new apply-copied tests).

- [ ] **Step 2: Type-check**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 3: Next build**

Run: `npm run build`
Expected: clean build; no new warnings related to the modified files.

- [ ] **Step 4: Manual E2E walkthrough**

Run `npm run dev`. Open browser to `http://localhost:3001/` (or the port shown).

**Pre-feature backward compatibility check (critical):**
1. Scroll the history sidebar until you see an entry generated BEFORE this feature (no `userPrompt` / `styleId` in its record — anything before the first generation that includes them).
2. Verify the card shows the entry's prompt text exactly as it did before (no badge rendered).
3. Click copy on that entry. Verify: textarea gets the prompt, the current style dropdown selection is unchanged, toast says "Промпт скопирован".

**Default-style generation + copy:**
4. With dropdown on "Стандартный", submit a prompt "a cat". Wait for completion.
5. On the new entry's card: verify no style badge appears. Verify prompt text reads "a cat".
6. Click copy. Verify textarea gets "a cat", dropdown stays on "Стандартный", toast says "Промпт скопирован".

**Existing-style generation + copy (happy path):**
7. Create a style "Кино" with prefix "cinematic" and suffix "35mm" in /admin.
8. Return to `/`, refocus the tab, select "Кино", submit prompt "a cat".
9. On the new entry: verify prompt text reads "a cat" and a small badge below reads "Стиль: Кино".
10. Verify the image's alt text still contains the full wrapped prompt (use DevTools on the image).
11. Click copy. Verify textarea gets "a cat", dropdown switches to "Кино", toast says 'Промпт скопирован, стиль «Кино» применён'.
12. Verify the request body sent to `/api/generate/submit` on the next submit wraps correctly (DevTools → Network → submit payload → `prompt` field).

**Deleted-style scenario:**
13. In /admin, delete "Кино". Refocus `/` so the styles list refreshes.
14. Find the entry that was generated with Кино.
15. The badge should fall back to the raw style id (e.g. "Стиль: kino-abc") — that's intentional.
16. Click copy on that entry. Verify textarea gets the WRAPPED prompt ("cinematic. a cat. 35mm"), dropdown switches to "Стандартный", toast says "Стиль больше не существует, промпт вставлен как есть".
17. Submit the wrapped prompt as-is (with Стандартный selected, no double wrap will occur).

**No regression in output area main card:**
18. The main output card (center) shows the current generation. Verify the copy button there works identically to the sidebar button (uses the same logic).

- [ ] **Step 5: If any walkthrough step fails, file a bug**

Don't patch issues invisibly — file a task or note explicitly what went wrong and stop.

---

## Self-Review Notes

**Spec coverage:**
- Data model (new fields on HistoryEntry + prompt_data JSON) → Task 1, Task 3.
- Hydrate read path → Task 2.
- `applyCopiedPrompt` helper → Task 4.
- Lifting styles state → Task 5.
- Display + badge + copy handler updates → Task 6.
- Backward compat → verified in Task 7 step 4.

**Type consistency:**
- `CopiedEntry` / `ApplyCopiedSetters` introduced in Task 4 are consumed in Task 6 identically.
- `styles: Style[]` prop signature is consistent across `GenerateForm`, `OutputArea`, `HistorySidebar`, and the parent wiring in Task 5.
- `userPrompt?: string` / `styleId?: string` names match between the type (Task 1), the hydrate parser (Task 2), the write path (Task 3), and the UI readers (Task 6).

**No placeholders:** every task has concrete code blocks, exact file paths, and exact expected test counts.

**Known trade-off recorded:** the deleted-style case rendering the raw `styleId` as label text is intentional per the spec — no task to beautify it.
