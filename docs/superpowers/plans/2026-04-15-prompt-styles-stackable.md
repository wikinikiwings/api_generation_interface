# Prompt Styles Stackable Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extend the single-style picker to multi-select with a checkbox dropdown + order numbers, matryoshka-wrap the user prompt around the selected styles, and preserve backward compatibility with pre-feature and single-style history records.

**Architecture:** Data shape migrates from scalar `styleId: string` to array `styleIds: string[]`; `composeFinalPrompt` accepts `Style[]` and wraps matryoshka-style; `applyCopiedPrompt` handles four branches on the array; a new custom dropdown component (checkbox list with order numbers) replaces the native `<select>` for styles.

**Tech Stack:** Next.js 15 App Router + TypeScript, Zustand, sonner toasts, Vitest, Tailwind. No new dependencies. `@radix-ui/react-dialog` is available but not needed; we build the multi-select with plain `useState` + click-outside + `Esc` handler.

**Spec:** `docs/superpowers/specs/2026-04-15-prompt-styles-stackable-design.md`

**Starting state (before Task 1):** single-style picker works end-to-end; tests: 53 passing.

---

## File Structure

**New files:**
- `components/styles-multi-select.tsx` — custom checkbox dropdown.

**Modified files (across tasks):**
- `stores/settings-store.ts` — `selectedStyleIds` array + setter + reconcile + LS v1→v2.
- `lib/styles/types.ts` — no changes expected (`Style`, `DEFAULT_STYLE_ID` remain; `DEFAULT_STYLE_ID` is used only on the legacy hydrate path).
- `lib/styles/inject.ts` — `composeFinalPrompt(userPrompt, activeStyles: readonly Style[])`.
- `lib/styles/apply-copied.ts` — `CopiedEntry.styleIds`, `setSelectedStyleIds`, four branches extended, `joinStyleNames` exported helper.
- `lib/styles/__tests__/inject.test.ts`, `apply-copied.test.ts` — updated + new multi-style tests.
- `lib/history/types.ts` — `HistoryEntry.styleIds?: string[]` replaces `styleId`. Same for `NewPendingInput`.
- `lib/history/mutations.ts` — `addPendingEntry` reads `input.styleIds`.
- `lib/history/store.ts` — `serverGenToEntry` reads `styleIds` with legacy `styleId` fallback.
- `lib/history/__tests__/store.test.ts` — updated + legacy coercion test.
- `components/generate-form.tsx` — adapter first (Task 1), full wiring later (Task 4).
- `components/playground.tsx` — rename `reconcileSelectedStyle` → `reconcileSelectedStyles`.
- `components/output-area.tsx` — badge reads `styleIds`, copy handler passes the array.
- `components/history-sidebar.tsx` — same.

---

## Task 1: Settings store migration + GenerateForm/Playground adapter

**Goal of this task:** migrate the zustand store to an array-shape selection and update the two callers so the project still compiles and tests pass, while keeping the visible UI single-select for now.

**Files:**
- Modify: `stores/settings-store.ts`
- Modify: `components/generate-form.tsx`
- Modify: `components/playground.tsx`

- [ ] **Step 1: Update `stores/settings-store.ts`**

Find the existing constants block near the top (from the earlier feature):

```ts
const STYLE_LS_KEY = "wavespeed:selectedStyle:v1";
const DEFAULT_STYLE_ID = "__default__";

function loadStyleId(): string { /* ... */ }
```

Replace the whole styles-related block with:

```ts
const STYLE_LS_KEY_V1 = "wavespeed:selectedStyle:v1";
const STYLE_LS_KEY_V2 = "wavespeed:selectedStyles:v2";
const DEFAULT_STYLE_ID = "__default__";

/**
 * Load the persisted selection. Supports a one-shot migration from v1
 * (single styleId) to v2 (array of styleIds):
 *   - v1 "__default__" → []
 *   - v1 "<id>"        → ["<id>"]
 * After migration the v1 key is deleted so we only read v2 on subsequent
 * loads. Silent — no UI, no toast.
 */
function loadStyleIds(): string[] {
  if (typeof window === "undefined") return [];
  try {
    const v2 = window.localStorage.getItem(STYLE_LS_KEY_V2);
    if (typeof v2 === "string" && v2.length > 0) {
      const parsed = JSON.parse(v2);
      if (Array.isArray(parsed) && parsed.every((x) => typeof x === "string")) {
        return parsed;
      }
    }
    // Migration from v1
    const v1 = window.localStorage.getItem(STYLE_LS_KEY_V1);
    if (typeof v1 === "string" && v1.length > 0) {
      const migrated = v1 === DEFAULT_STYLE_ID ? [] : [v1];
      window.localStorage.setItem(STYLE_LS_KEY_V2, JSON.stringify(migrated));
      window.localStorage.removeItem(STYLE_LS_KEY_V1);
      return migrated;
    }
  } catch {}
  return [];
}
```

Then find the `SettingsState` interface. Replace the three old style fields:

```ts
  selectedStyleId: string;
  setSelectedStyleId: (id: string) => void;
  reconcileSelectedStyle: (knownIds: readonly string[]) => void;
```

with:

```ts
  selectedStyleIds: string[];
  setSelectedStyleIds: (ids: string[]) => void;
  /**
   * Drop any ids from selectedStyleIds that are not in knownIds (e.g. after
   * an admin deletion). Silent — no toast. If all selected styles go away,
   * selectedStyleIds becomes [] (same as the "Стандартный" state).
   */
  reconcileSelectedStyles: (knownIds: readonly string[]) => void;
```

Then in the `create<SettingsState>()(...)` body, replace the old field initializer and methods:

```ts
  selectedStyleId: loadStyleId(),

  setSelectedStyleId: (id) => {
    set({ selectedStyleId: id });
    try { window.localStorage.setItem(STYLE_LS_KEY, id); } catch {}
  },

  reconcileSelectedStyle: (knownIds) => { /* old body */ },
```

with:

```ts
  selectedStyleIds: loadStyleIds(),

  setSelectedStyleIds: (ids) => {
    set({ selectedStyleIds: ids });
    try {
      window.localStorage.setItem(STYLE_LS_KEY_V2, JSON.stringify(ids));
    } catch {}
  },

  reconcileSelectedStyles: (knownIds) => {
    const current = get().selectedStyleIds;
    const filtered = current.filter((id) => knownIds.includes(id));
    if (filtered.length === current.length) return; // no change
    set({ selectedStyleIds: filtered });
    try {
      window.localStorage.setItem(STYLE_LS_KEY_V2, JSON.stringify(filtered));
    } catch {}
  },
```

- [ ] **Step 2: Update `components/playground.tsx`**

Find the existing selector:

```ts
  const reconcileSelectedStyle = useSettingsStore((s) => s.reconcileSelectedStyle);
```

Change to:

```ts
  const reconcileSelectedStyles = useSettingsStore((s) => s.reconcileSelectedStyles);
```

And in the `loadStyles` callback:

```ts
      reconcileSelectedStyle(data.styles.map((s) => s.id));
```

Change to:

```ts
      reconcileSelectedStyles(data.styles.map((s) => s.id));
```

- [ ] **Step 3: Update `components/generate-form.tsx` (adapter layer)**

Find the existing store selectors for styles:

```ts
  const selectedStyleId = useSettingsStore((s) => s.selectedStyleId);
  const setSelectedStyleId = useSettingsStore((s) => s.setSelectedStyleId);
```

Replace with:

```ts
  const selectedStyleIds = useSettingsStore((s) => s.selectedStyleIds);
  const setSelectedStyleIds = useSettingsStore((s) => s.setSelectedStyleIds);

  // Adapter for the current single-Select UI. Task 4 replaces the Select
  // with a real multi-select; until then, we treat the first array element
  // as the single selection and write back as a zero- or one-element array.
  const selectedStyleId = selectedStyleIds[0] ?? DEFAULT_STYLE_ID;
  const setSelectedStyleId = React.useCallback(
    (id: string) =>
      setSelectedStyleIds(id === DEFAULT_STYLE_ID ? [] : [id]),
    [setSelectedStyleIds]
  );
```

The `activeStyle` memo already reads `selectedStyleId` and `styles` — keep it unchanged. The `<Select>` dropdown already uses `value={selectedStyleId}` and `onChange={(e) => setSelectedStyleId(e.target.value)}` — also unchanged. The adapter preserves the current behavior byte-for-byte.

- [ ] **Step 4: Type-check**

Run: `npx tsc --noEmit`
Expected: 0 errors.

- [ ] **Step 5: Tests**

Run: `npm test`
Expected: 53 passing (no test files changed this task).

- [ ] **Step 6: Manual sanity**

`npm run dev`. Visit `/`. Pick a style from the dropdown. Reload. Verify the style is still selected after reload (LS v2 now has `["<id>"]`). Check DevTools → Application → Local Storage to confirm `wavespeed:selectedStyles:v2` has the array and `wavespeed:selectedStyle:v1` is gone after first load.

- [ ] **Step 7: Commit**

```bash
git add stores/settings-store.ts components/playground.tsx components/generate-form.tsx
git commit -m "refactor(styles): migrate settings store to array selection

selectedStyleId (string) becomes selectedStyleIds (string[]).
One-shot localStorage migration from v1 to v2 runs silently on load.
GenerateForm has a thin adapter so the existing single-Select UI
keeps working unchanged; the full multi-select wire-up lands in a
later task."
```

---

## Task 2: Data model migration (styleId → styleIds across helpers, history, consumers)

**Goal:** convert every place that stores, reads, or renders `styleId` to use `styleIds`. After this task the data shape is uniformly array-based, but the visible form UI is still single-select. Hydrate path supports legacy records with `styleId`.

This task modifies ten files. It is intentionally atomic because the types are cross-cutting — any smaller split leaves the project in an uncompilable state at a task boundary.

**Files:**
- Modify: `lib/styles/inject.ts`
- Modify: `lib/styles/__tests__/inject.test.ts`
- Modify: `lib/styles/apply-copied.ts`
- Modify: `lib/styles/__tests__/apply-copied.test.ts`
- Modify: `lib/history/types.ts`
- Modify: `lib/history/mutations.ts`
- Modify: `lib/history/store.ts`
- Modify: `lib/history/__tests__/store.test.ts`
- Modify: `components/generate-form.tsx`
- Modify: `components/output-area.tsx`
- Modify: `components/history-sidebar.tsx`

### Step 1: Update `lib/styles/inject.ts`

Replace the current content with:

```ts
import { type Style } from "./types";

/**
 * Compose the final prompt sent to the generation API by wrapping the
 * user's prompt with the selected styles' prefixes and suffixes.
 *
 * Matryoshka order for activeStyles = [s1, s2, s3]:
 *   p1. p2. p3. userPrompt. s3. s2. s1.
 *
 * s1 is the outermost style — its prefix comes first, its suffix comes
 * last. s(last) is the innermost — prefix closest to the user prompt on
 * the left, suffix closest on the right. Empty parts contribute no
 * separator. prefix/suffix are trimmed at compose time so trailing
 * newlines in the admin textarea don't break the ". " separator.
 */
export function composeFinalPrompt(
  userPrompt: string,
  activeStyles: readonly Style[]
): string {
  if (activeStyles.length === 0) return userPrompt;

  const prefixes = activeStyles
    .map((s) => (s.prefix ?? "").trim())
    .filter((p) => p.length > 0);

  const suffixes = [...activeStyles]
    .reverse()
    .map((s) => (s.suffix ?? "").trim())
    .filter((s) => s.length > 0);

  if (prefixes.length === 0 && suffixes.length === 0) return userPrompt;

  return [...prefixes, userPrompt, ...suffixes].join(". ");
}
```

### Step 2: Rewrite `lib/styles/__tests__/inject.test.ts`

Replace the entire file content with:

```ts
import { describe, it, expect } from "vitest";
import { composeFinalPrompt } from "../inject";
import type { Style } from "../types";

function style(overrides: Partial<Style>): Style {
  return {
    id: "x",
    name: "x",
    prefix: "",
    suffix: "",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("composeFinalPrompt", () => {
  it("returns the user prompt unchanged when no styles are active", () => {
    expect(composeFinalPrompt("a cat", [])).toBe("a cat");
  });

  it("single style with prefix and suffix wraps correctly", () => {
    expect(
      composeFinalPrompt("a cat", [style({ prefix: "cinematic", suffix: "35mm" })])
    ).toBe("cinematic. a cat. 35mm");
  });

  it("single style with empty prefix: no leading separator", () => {
    expect(
      composeFinalPrompt("a cat", [style({ prefix: "", suffix: "35mm" })])
    ).toBe("a cat. 35mm");
  });

  it("single style with empty suffix: no trailing separator", () => {
    expect(
      composeFinalPrompt("a cat", [style({ prefix: "cinematic", suffix: "" })])
    ).toBe("cinematic. a cat");
  });

  it("single style with empty prefix and suffix: passthrough", () => {
    expect(
      composeFinalPrompt("a cat", [style({ prefix: "", suffix: "" })])
    ).toBe("a cat");
  });

  it("trims whitespace on prefix and suffix at compose time", () => {
    expect(
      composeFinalPrompt(
        "a cat",
        [style({ prefix: "  cinematic  \n", suffix: "\n 35mm " })]
      )
    ).toBe("cinematic. a cat. 35mm");
  });

  it("preserves interior newlines in prefix/suffix", () => {
    expect(
      composeFinalPrompt("a cat", [style({ prefix: "line1\nline2", suffix: "" })])
    ).toBe("line1\nline2. a cat");
  });

  it("three styles — matryoshka order", () => {
    const kino = style({ id: "k", prefix: "cinematic", suffix: "35mm" });
    const threeD = style({ id: "3d", prefix: "3d render", suffix: "ray traced" });
    const groza = style({ id: "g", prefix: "storm", suffix: "lightning" });
    // activeStyles order: [kino, threeD, groza]
    // prefixes: cinematic, 3d render, storm
    // suffixes reversed: lightning, ray traced, 35mm
    expect(
      composeFinalPrompt("a cat", [kino, threeD, groza])
    ).toBe("cinematic. 3d render. storm. a cat. lightning. ray traced. 35mm");
  });

  it("three styles — some parts empty, still filters correctly", () => {
    // kino has both; threeD has only prefix; groza has only suffix.
    const kino = style({ id: "k", prefix: "cinematic", suffix: "35mm" });
    const threeD = style({ id: "3d", prefix: "3d render", suffix: "" });
    const groza = style({ id: "g", prefix: "", suffix: "lightning" });
    // prefixes after filter: cinematic, 3d render
    // suffixes reversed+filter: lightning, 35mm
    expect(
      composeFinalPrompt("a cat", [kino, threeD, groza])
    ).toBe("cinematic. 3d render. a cat. lightning. 35mm");
  });

  it("three styles — all prefixes and suffixes empty: passthrough", () => {
    const a = style({ id: "a" });
    const b = style({ id: "b" });
    const c = style({ id: "c" });
    expect(composeFinalPrompt("a cat", [a, b, c])).toBe("a cat");
  });

  it("two styles with whitespace-only parts are filtered", () => {
    expect(
      composeFinalPrompt(
        "a cat",
        [
          style({ id: "a", prefix: "   ", suffix: "35mm" }),
          style({ id: "b", prefix: "storm", suffix: "\n\n" }),
        ]
      )
    ).toBe("storm. a cat. 35mm");
  });

  it("empty user prompt + non-empty styles: still wraps around empty middle", () => {
    expect(
      composeFinalPrompt("", [style({ prefix: "cinematic", suffix: "35mm" })])
    ).toBe("cinematic. . 35mm");
  });
});
```

### Step 3: Run inject tests and confirm they pass

Run: `npm test -- lib/styles/__tests__/inject.test.ts`
Expected: all tests PASS (12 cases).

### Step 4: Update `lib/styles/apply-copied.ts`

Replace the file content with:

```ts
import { type Style } from "./types";

export interface CopiedEntry {
  /** The wrapped prompt as stored. Always present. */
  prompt: string;
  /** Clean user-authored part if the entry was generated post-feature. */
  userPrompt?: string;
  /**
   * Ids of the styles applied at generation. Undefined on pre-feature
   * entries. Empty array means an explicit post-feature "Стандартный".
   */
  styleIds?: string[];
}

export interface ApplyCopiedSetters {
  setPrompt: (s: string) => void;
  setSelectedStyleIds: (ids: string[]) => void;
  toastInfo: (msg: string) => void;
  toastWarn: (msg: string) => void;
}

/**
 * Join style names for display ("Кино + 3D + Гроза"). Falls back to raw
 * id for any id that is no longer in the provided styles list.
 */
export function joinStyleNames(
  ids: readonly string[],
  styles: readonly Style[]
): string {
  return ids.map((id) => styles.find((s) => s.id === id)?.name ?? id).join(" + ");
}

/**
 * Four branches:
 *   1. Pre-feature (styleIds undefined) — paste entry.prompt, leave
 *      selection alone, "Промпт скопирован".
 *   2. Default (styleIds === []) — paste clean userPrompt, clear
 *      selection, "Промпт скопирован".
 *   3. All ids resolve — paste clean userPrompt, set selection to the
 *      stored ids, toast with joined names.
 *   4. At least one id missing — paste wrapped entry.prompt, clear
 *      selection, warn with name of the missing style (or generic plural).
 */
export function applyCopiedPrompt(
  entry: CopiedEntry,
  styles: readonly Style[],
  setters: ApplyCopiedSetters
): void {
  if (entry.styleIds === undefined) {
    setters.setPrompt(entry.prompt);
    setters.toastInfo("Промпт скопирован");
    return;
  }

  if (entry.styleIds.length === 0) {
    setters.setPrompt(entry.userPrompt ?? entry.prompt);
    setters.setSelectedStyleIds([]);
    setters.toastInfo("Промпт скопирован");
    return;
  }

  const knownIds = new Set(styles.map((s) => s.id));
  const missingIds = entry.styleIds.filter((id) => !knownIds.has(id));

  if (missingIds.length === 0) {
    setters.setPrompt(entry.userPrompt ?? entry.prompt);
    setters.setSelectedStyleIds(entry.styleIds);
    const names = joinStyleNames(entry.styleIds, styles);
    const msg =
      entry.styleIds.length === 1
        ? `Промпт скопирован, стиль «${names}» применён`
        : `Промпт скопирован, стили «${names}» применены`;
    setters.toastInfo(msg);
    return;
  }

  // At least one missing — full fallback (variant A).
  setters.setPrompt(entry.prompt);
  setters.setSelectedStyleIds([]);
  const warnMsg =
    missingIds.length === 1
      ? `Стиль «${missingIds[0]}» удалён, промпт вставлен как есть`
      : "Некоторые стили удалены, промпт вставлен как есть";
  setters.toastWarn(warnMsg);
}
```

### Step 5: Rewrite `lib/styles/__tests__/apply-copied.test.ts`

Replace with:

```ts
import { describe, it, expect, vi } from "vitest";
import { applyCopiedPrompt, joinStyleNames } from "../apply-copied";
import type { Style } from "../types";

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
    setSelectedStyleIds: vi.fn(),
    toastInfo: vi.fn(),
    toastWarn: vi.fn(),
  };
}

describe("joinStyleNames", () => {
  it("joins names with ' + ' in order", () => {
    const kino = makeStyle({ id: "k", name: "Кино" });
    const groza = makeStyle({ id: "g", name: "Гроза" });
    expect(joinStyleNames(["k", "g"], [kino, groza])).toBe("Кино + Гроза");
  });

  it("falls back to raw id when a style is missing", () => {
    const kino = makeStyle({ id: "k", name: "Кино" });
    expect(joinStyleNames(["k", "unknown"], [kino])).toBe("Кино + unknown");
  });

  it("returns empty string for empty ids", () => {
    expect(joinStyleNames([], [])).toBe("");
  });
});

describe("applyCopiedPrompt", () => {
  it("pre-feature entry: pastes entry.prompt, leaves selection alone", () => {
    const setters = makeSetters();
    applyCopiedPrompt(
      { prompt: "a cat", userPrompt: undefined, styleIds: undefined },
      [],
      setters
    );
    expect(setters.setPrompt).toHaveBeenCalledWith("a cat");
    expect(setters.setSelectedStyleIds).not.toHaveBeenCalled();
    expect(setters.toastInfo).toHaveBeenCalledWith("Промпт скопирован");
    expect(setters.toastWarn).not.toHaveBeenCalled();
  });

  it("default entry (empty array): pastes userPrompt, clears selection", () => {
    const setters = makeSetters();
    applyCopiedPrompt(
      { prompt: "a cat", userPrompt: "a cat", styleIds: [] },
      [],
      setters
    );
    expect(setters.setPrompt).toHaveBeenCalledWith("a cat");
    expect(setters.setSelectedStyleIds).toHaveBeenCalledWith([]);
    expect(setters.toastInfo).toHaveBeenCalledWith("Промпт скопирован");
    expect(setters.toastWarn).not.toHaveBeenCalled();
  });

  it("single existing style: pastes userPrompt, sets selection, singular toast", () => {
    const setters = makeSetters();
    const kino = makeStyle({ id: "k", name: "Кино" });
    applyCopiedPrompt(
      {
        prompt: "cinematic. a cat. 35mm",
        userPrompt: "a cat",
        styleIds: ["k"],
      },
      [kino],
      setters
    );
    expect(setters.setPrompt).toHaveBeenCalledWith("a cat");
    expect(setters.setSelectedStyleIds).toHaveBeenCalledWith(["k"]);
    expect(setters.toastInfo).toHaveBeenCalledWith(
      "Промпт скопирован, стиль «Кино» применён"
    );
  });

  it("multiple existing styles: plural toast with joined names", () => {
    const setters = makeSetters();
    const kino = makeStyle({ id: "k", name: "Кино" });
    const threeD = makeStyle({ id: "d", name: "3D" });
    const groza = makeStyle({ id: "g", name: "Гроза" });
    applyCopiedPrompt(
      {
        prompt: "cinematic. 3d. storm. a cat. lightning. ray. 35mm",
        userPrompt: "a cat",
        styleIds: ["k", "d", "g"],
      },
      [kino, threeD, groza],
      setters
    );
    expect(setters.setPrompt).toHaveBeenCalledWith("a cat");
    expect(setters.setSelectedStyleIds).toHaveBeenCalledWith(["k", "d", "g"]);
    expect(setters.toastInfo).toHaveBeenCalledWith(
      "Промпт скопирован, стили «Кино + 3D + Гроза» применены"
    );
  });

  it("one of several deleted: full fallback with id-named warning", () => {
    const setters = makeSetters();
    const kino = makeStyle({ id: "k", name: "Кино" });
    applyCopiedPrompt(
      {
        prompt: "cinematic. a cat. 35mm",
        userPrompt: "a cat",
        styleIds: ["k", "deleted-b12"],
      },
      [kino], // "deleted-b12" not in list
      setters
    );
    expect(setters.setPrompt).toHaveBeenCalledWith("cinematic. a cat. 35mm");
    expect(setters.setSelectedStyleIds).toHaveBeenCalledWith([]);
    expect(setters.toastWarn).toHaveBeenCalledWith(
      "Стиль «deleted-b12» удалён, промпт вставлен как есть"
    );
    expect(setters.toastInfo).not.toHaveBeenCalled();
  });

  it("multiple deleted: generic plural warning", () => {
    const setters = makeSetters();
    const kino = makeStyle({ id: "k", name: "Кино" });
    applyCopiedPrompt(
      {
        prompt: "complex. a cat. wrap",
        userPrompt: "a cat",
        styleIds: ["k", "gone-1", "gone-2"],
      },
      [kino],
      setters
    );
    expect(setters.setPrompt).toHaveBeenCalledWith("complex. a cat. wrap");
    expect(setters.setSelectedStyleIds).toHaveBeenCalledWith([]);
    expect(setters.toastWarn).toHaveBeenCalledWith(
      "Некоторые стили удалены, промпт вставлен как есть"
    );
  });

  it("single style with userPrompt undefined falls back to entry.prompt", () => {
    const setters = makeSetters();
    applyCopiedPrompt(
      { prompt: "a cat", userPrompt: undefined, styleIds: [] },
      [],
      setters
    );
    expect(setters.setPrompt).toHaveBeenCalledWith("a cat");
    expect(setters.setSelectedStyleIds).toHaveBeenCalledWith([]);
  });
});
```

### Step 6: Run apply-copied tests

Run: `npm test -- lib/styles/__tests__/apply-copied.test.ts`
Expected: all tests PASS.

### Step 7: Update `lib/history/types.ts`

In the `HistoryEntry` interface find:

```ts
  userPrompt?: string;
  styleId?: string;
```

Replace with:

```ts
  userPrompt?: string;
  /** Ids of styles applied at generation. Undefined on pre-feature entries.
   *  Empty array means explicit post-feature "Стандартный". */
  styleIds?: string[];
```

Remove the JSDoc block for the old `styleId` field.

In the `NewPendingInput` interface, find:

```ts
  userPrompt?: string;
  styleId?: string;
```

Replace with:

```ts
  userPrompt?: string;
  styleIds?: string[];
```

### Step 8: Update `lib/history/mutations.ts`

In `addPendingEntry`, find:

```ts
    userPrompt: input.userPrompt,
    styleId: input.styleId,
```

Replace with:

```ts
    userPrompt: input.userPrompt,
    styleIds: input.styleIds,
```

### Step 9: Update `lib/history/store.ts` (hydrate parse)

In `serverGenToEntry`, replace the parse block:

```ts
  let prompt = "";
  let workflowName: string | undefined = row.workflow_name;
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

with:

```ts
  let prompt = "";
  let workflowName: string | undefined = row.workflow_name;
  let userPrompt: string | undefined;
  let styleIds: string[] | undefined;
  try {
    const parsed = JSON.parse(row.prompt_data) as {
      prompt?: string;
      workflow?: string;
      userPrompt?: string;
      styleId?: string;
      styleIds?: string[];
    };
    prompt = parsed.prompt ?? "";
    workflowName = parsed.workflow ?? row.workflow_name;
    if (typeof parsed.userPrompt === "string") userPrompt = parsed.userPrompt;
    if (
      Array.isArray(parsed.styleIds) &&
      parsed.styleIds.every((x) => typeof x === "string")
    ) {
      styleIds = parsed.styleIds;
    } else if (typeof parsed.styleId === "string") {
      // Legacy single-style record: coerce to array.
      styleIds = parsed.styleId === "__default__" ? [] : [parsed.styleId];
    }
  } catch {
    // Malformed prompt_data — keep prompt as "".
  }
```

Then in the returned object, replace:

```ts
    prompt,
    userPrompt,
    styleId,
    provider: "wavespeed",
```

with:

```ts
    prompt,
    userPrompt,
    styleIds,
    provider: "wavespeed",
```

### Step 10: Update `lib/history/__tests__/store.test.ts`

Find the existing two tests added in the earlier feature:

```ts
it("hydrates userPrompt and styleId from prompt_data when present", () => { ... });
it("leaves userPrompt and styleId undefined for pre-feature entries", () => { ... });
```

Replace them with these four:

```ts
  it("hydrates userPrompt and styleIds from prompt_data when array present", () => {
    const row = mkRow({
      prompt_data: JSON.stringify({
        prompt: "cinematic. a cat. 35mm",
        userPrompt: "a cat",
        styleIds: ["kino-a3f", "3d-b12"],
      }),
    });
    const entry = serverGenToEntry(row, "uuid-1");
    expect(entry.userPrompt).toBe("a cat");
    expect(entry.styleIds).toEqual(["kino-a3f", "3d-b12"]);
  });

  it("coerces legacy styleId (non-default) to a single-element styleIds array", () => {
    const row = mkRow({
      prompt_data: JSON.stringify({
        prompt: "cinematic. a cat. 35mm",
        userPrompt: "a cat",
        styleId: "kino-a3f",
      }),
    });
    const entry = serverGenToEntry(row, "uuid-2");
    expect(entry.styleIds).toEqual(["kino-a3f"]);
  });

  it("coerces legacy styleId === '__default__' to an empty styleIds array", () => {
    const row = mkRow({
      prompt_data: JSON.stringify({
        prompt: "a cat",
        userPrompt: "a cat",
        styleId: "__default__",
      }),
    });
    const entry = serverGenToEntry(row, "uuid-3");
    expect(entry.styleIds).toEqual([]);
  });

  it("leaves styleIds undefined for pre-feature entries", () => {
    const row = mkRow({ prompt_data: JSON.stringify({ prompt: "a cat" }) });
    const entry = serverGenToEntry(row, "uuid-4");
    expect(entry.styleIds).toBeUndefined();
  });
```

### Step 11: Update `components/generate-form.tsx`

Two sets of edits.

**(a) promptPayload and NewPendingInput construction.**

In `saveToServerHistory`, find the `promptPayload` object:

```ts
      const promptPayload = {
        prompt: composeFinalPrompt(prompt.trim(), activeStyle),
        userPrompt: prompt.trim(),
        styleId: activeStyle ? activeStyle.id : DEFAULT_STYLE_ID,
        resolution: hasResolutions ? resolution : undefined,
```

Replace with:

```ts
      const promptPayload = {
        prompt: composeFinalPrompt(prompt.trim(), activeStyle ? [activeStyle] : []),
        userPrompt: prompt.trim(),
        styleIds: activeStyle ? [activeStyle.id] : [],
        resolution: hasResolutions ? resolution : undefined,
```

Then find the `const entry: NewPendingInput` construction:

```ts
    const entry: NewPendingInput = {
      uuid: historyId,
      taskId: "",
      provider: activeProvider,
      model: getModelString(activeProvider, selectedModel, images.length > 0),
      prompt: composeFinalPrompt(prompt.trim(), activeStyle),
      userPrompt: prompt.trim(),
      styleId: activeStyle ? activeStyle.id : DEFAULT_STYLE_ID,
      resolution,
```

Replace the three changed lines:

```ts
      prompt: composeFinalPrompt(prompt.trim(), activeStyle ? [activeStyle] : []),
      userPrompt: prompt.trim(),
      styleIds: activeStyle ? [activeStyle.id] : [],
```

**(b) The `activeStyle` memo stays the same (still reads from `selectedStyleId` via the Task 1 adapter).** Leave it unchanged.

### Step 12: Update `components/output-area.tsx`

Find the `applyCopiedPrompt` call site (in the copy button's `onClick`):

```tsx
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
```

Replace with:

```tsx
              applyCopiedPrompt(
                {
                  prompt: entry.prompt,
                  userPrompt: entry.userPrompt,
                  styleIds: entry.styleIds,
                },
                styles,
                {
                  setPrompt: (s) => usePromptStore.getState().setPrompt(s),
                  setSelectedStyleIds: (ids) =>
                    useSettingsStore.getState().setSelectedStyleIds(ids),
                  toastInfo: (msg) => toast.success(msg, { duration: 1500 }),
                  toastWarn: (msg) => toast.warning(msg, { duration: 3000 }),
                }
              );
```

Then find the style badge (added in the earlier feature):

```tsx
            {entry.styleId && entry.styleId !== DEFAULT_STYLE_ID && (
              <span className="mt-0.5 inline-flex items-center gap-1 text-[10px] text-muted-foreground">
                <Sparkles className="h-3 w-3" />
                Стиль: {styles.find((s) => s.id === entry.styleId)?.name ?? entry.styleId}
              </span>
            )}
```

Replace with:

```tsx
            {entry.styleIds && entry.styleIds.length > 0 && (
              <span className="mt-0.5 inline-flex items-center gap-1 text-[10px] text-muted-foreground">
                <Sparkles className="h-3 w-3" />
                {entry.styleIds.length === 1 ? "Стиль" : "Стили"}: {joinStyleNames(entry.styleIds, styles)}
              </span>
            )}
```

Add `joinStyleNames` to the existing imports from `@/lib/styles/apply-copied`:

```ts
import { applyCopiedPrompt, joinStyleNames } from "@/lib/styles/apply-copied";
```

If `DEFAULT_STYLE_ID` is no longer used in the file after this change, remove it from the imports too. Keep `Style` and `Sparkles`.

### Step 13: Update `components/history-sidebar.tsx`

Find the `handleCopy` function:

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

Replace with:

```ts
  async function handleCopy() {
    if (!entry.prompt) return;
    const ok = await copyToClipboard(entry.prompt);
    if (!ok) return;
    applyCopiedPrompt(
      {
        prompt: entry.prompt,
        userPrompt: entry.userPrompt,
        styleIds: entry.styleIds,
      },
      styles,
      {
        setPrompt: (s) => usePromptStore.getState().setPrompt(s),
        setSelectedStyleIds: (ids) =>
          useSettingsStore.getState().setSelectedStyleIds(ids),
        toastInfo: (msg) => toast.success(msg, { duration: 1500 }),
        toastWarn: (msg) => toast.warning(msg, { duration: 3000 }),
      }
    );
  }
```

Then find the style badge:

```tsx
          {entry.styleId && entry.styleId !== DEFAULT_STYLE_ID && (
            <span className="mt-0.5 inline-flex items-center gap-1 text-[10px] text-muted-foreground">
              <Sparkles className="h-3 w-3" />
              Стиль: {styles.find((s) => s.id === entry.styleId)?.name ?? entry.styleId}
            </span>
          )}
```

Replace with:

```tsx
          {entry.styleIds && entry.styleIds.length > 0 && (
            <span className="mt-0.5 inline-flex items-center gap-1 text-[10px] text-muted-foreground">
              <Sparkles className="h-3 w-3" />
              {entry.styleIds.length === 1 ? "Стиль" : "Стили"}: {joinStyleNames(entry.styleIds, styles)}
            </span>
          )}
```

Update imports to include `joinStyleNames`:

```ts
import { applyCopiedPrompt, joinStyleNames } from "@/lib/styles/apply-copied";
```

Remove `DEFAULT_STYLE_ID` from imports if no longer referenced.

### Step 14: Type-check

Run: `npx tsc --noEmit`
Expected: 0 errors.

### Step 15: Full test run

Run: `npm test`
Expected: all tests pass. Count is approximately 60 (previous 53 minus 2 replaced tests plus ~9 new ones — exact count will be printed).

### Step 16: Manual smoke

`npm run dev`. Verify:
- Pick a style (still a single-Select UI). Generate. New card shows "Стиль: X" badge (singular, styleIds has length 1).
- Copy from the new card: textarea gets clean prompt, dropdown stays on that style.
- Find an old entry (pre-feature). Its badge is absent, copy pastes wrapped prompt.

### Step 17: Commit

```bash
git add \
  lib/styles/inject.ts \
  lib/styles/__tests__/inject.test.ts \
  lib/styles/apply-copied.ts \
  lib/styles/__tests__/apply-copied.test.ts \
  lib/history/types.ts \
  lib/history/mutations.ts \
  lib/history/store.ts \
  lib/history/__tests__/store.test.ts \
  components/generate-form.tsx \
  components/output-area.tsx \
  components/history-sidebar.tsx
git commit -m "refactor(styles): data model migration styleId → styleIds

Types, hydrate path, helpers, promptPayload, card badges, and copy
handlers all speak array-shaped styleIds now. Hydrate path coerces
legacy single styleId records (both 'kino-xxx' and '__default__')
into the new shape, so existing history continues to render
correctly without a backfill. UI still single-select for now; the
real multi-select dropdown lands in a later task."
```

---

## Task 3: StylesMultiSelect custom component

**Goal:** build the checkbox dropdown in isolation. No wiring. Component is standalone and unit-testable manually.

**Files:**
- Create: `components/styles-multi-select.tsx`

- [ ] **Step 1: Create the component**

Create `components/styles-multi-select.tsx`:

```tsx
"use client";

import * as React from "react";
import { ChevronDown } from "lucide-react";
import { cn } from "@/lib/utils";
import type { Style } from "@/lib/styles/types";

interface StylesMultiSelectProps {
  styles: Style[];
  selectedIds: string[];
  onChange: (ids: string[]) => void;
  id?: string;
  className?: string;
}

/**
 * Checkbox dropdown with order numbers. Click order determines wrap
 * order (matryoshka). Unticking renumbers remaining ticks to stay
 * contiguous (1, 2, 3 — untick 2 — remaining become 1, 2).
 *
 * No styles selected is the "Стандартный" state — the trigger shows
 * that label, and the list does not include a "Стандартный" row
 * (ticking nothing is the same thing).
 *
 * Soft warning appears below the trigger when selectedIds.length > 3.
 */
export function StylesMultiSelect({
  styles,
  selectedIds,
  onChange,
  id,
  className,
}: StylesMultiSelectProps) {
  const [open, setOpen] = React.useState(false);
  const containerRef = React.useRef<HTMLDivElement | null>(null);

  // Close on click outside.
  React.useEffect(() => {
    if (!open) return;
    const onDocClick = (e: MouseEvent) => {
      if (!containerRef.current) return;
      if (!containerRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, [open]);

  // Close on Escape.
  React.useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open]);

  const triggerLabel = React.useMemo(() => {
    if (selectedIds.length === 0) return "Стандартный";
    return selectedIds
      .map((id) => styles.find((s) => s.id === id)?.name ?? id)
      .join(" + ");
  }, [selectedIds, styles]);

  function toggle(id: string) {
    if (selectedIds.includes(id)) {
      onChange(selectedIds.filter((x) => x !== id));
    } else {
      onChange([...selectedIds, id]);
    }
  }

  return (
    <div className={cn("relative", className)} ref={containerRef}>
      <button
        type="button"
        id={id}
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="listbox"
        aria-expanded={open}
        className="flex h-9 w-full items-center justify-between rounded-md border border-input bg-background px-3 py-1 text-sm shadow-sm transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
      >
        <span className="truncate">{triggerLabel}</span>
        <ChevronDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
      </button>

      {open && (
        <div
          role="listbox"
          className="absolute left-0 right-0 z-20 mt-1 max-h-64 overflow-auto rounded-md border border-border bg-background p-1 shadow-md"
        >
          {styles.length === 0 ? (
            <div className="px-2 py-1.5 text-xs text-muted-foreground">
              Стилей пока нет. Создайте в админке.
            </div>
          ) : (
            styles.map((s) => {
              const idx = selectedIds.indexOf(s.id);
              const checked = idx !== -1;
              const order = checked ? idx + 1 : null;
              return (
                <button
                  key={s.id}
                  type="button"
                  role="menuitemcheckbox"
                  aria-checked={checked}
                  onClick={() => toggle(s.id)}
                  className={cn(
                    "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm transition-colors hover:bg-accent hover:text-accent-foreground",
                    checked && "bg-primary/5"
                  )}
                >
                  <span
                    className={cn(
                      "flex h-4 w-4 shrink-0 items-center justify-center rounded border text-[10px] font-semibold",
                      checked
                        ? "border-primary bg-primary text-primary-foreground"
                        : "border-muted-foreground/40"
                    )}
                  >
                    {order ?? ""}
                  </span>
                  <span className="truncate">{s.name}</span>
                </button>
              );
            })
          )}
        </div>
      )}

      {selectedIds.length > 3 && (
        <div className="mt-1 text-[11px] text-muted-foreground">
          ⚠ Больше 3 стилей — может выйти невнятный промпт
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Type-check**

Run: `npx tsc --noEmit`
Expected: 0 errors (component is unused so it contributes no errors elsewhere).

- [ ] **Step 3: Tests**

Run: `npm test`
Expected: unchanged from Task 2 (no tests added or removed).

- [ ] **Step 4: Commit**

```bash
git add components/styles-multi-select.tsx
git commit -m "feat(styles): add StylesMultiSelect checkbox dropdown component

Custom dropdown with per-row checkboxes and click-order numbers.
Click outside or press Esc to close. Soft warning appears below
when more than 3 styles are selected. Not yet wired to the
generation form — Task 4 handles that."
```

---

## Task 4: Wire StylesMultiSelect into GenerateForm

**Goal:** replace the single-Select adapter from Task 1 with the real multi-select, move the picker to its own second row, compute `activeStyles` from `selectedStyleIds`, drop the adapter shims.

**Files:**
- Modify: `components/generate-form.tsx`

- [ ] **Step 1: Update imports**

Remove if no longer needed: the `Select` import (for styles row only — it's still used by Resolution/Aspect/Format; so keep the import). Remove the `DEFAULT_STYLE_ID` import if it's only used in the adapter.

Add:

```ts
import { StylesMultiSelect } from "@/components/styles-multi-select";
```

- [ ] **Step 2: Drop the single-Select adapter, use plural natively**

In the component body, find the Task 1 adapter block:

```ts
  const selectedStyleIds = useSettingsStore((s) => s.selectedStyleIds);
  const setSelectedStyleIds = useSettingsStore((s) => s.setSelectedStyleIds);

  // Adapter for the current single-Select UI. Task 4 replaces the Select
  // with a real multi-select; until then, we treat the first array element
  // as the single selection and write back as a zero- or one-element array.
  const selectedStyleId = selectedStyleIds[0] ?? DEFAULT_STYLE_ID;
  const setSelectedStyleId = React.useCallback(
    (id: string) =>
      setSelectedStyleIds(id === DEFAULT_STYLE_ID ? [] : [id]),
    [setSelectedStyleIds]
  );
```

Simplify to:

```ts
  const selectedStyleIds = useSettingsStore((s) => s.selectedStyleIds);
  const setSelectedStyleIds = useSettingsStore((s) => s.setSelectedStyleIds);
```

- [ ] **Step 3: Replace `activeStyle` memo with `activeStyles`**

Find:

```ts
  const activeStyle = React.useMemo<Style | null>(() => {
    if (selectedStyleId === DEFAULT_STYLE_ID) return null;
    return styles.find((s) => s.id === selectedStyleId) ?? null;
  }, [styles, selectedStyleId]);
```

Replace with:

```ts
  const activeStyles = React.useMemo<Style[]>(() => {
    return selectedStyleIds
      .map((id) => styles.find((s) => s.id === id))
      .filter((s): s is Style => s !== undefined);
  }, [styles, selectedStyleIds]);
```

- [ ] **Step 4: Update both `composeFinalPrompt` callsites**

Find two places with:

```ts
composeFinalPrompt(prompt.trim(), activeStyle ? [activeStyle] : [])
```

Replace each with:

```ts
composeFinalPrompt(prompt.trim(), activeStyles)
```

- [ ] **Step 5: Update `promptPayload.styleIds` and `NewPendingInput.styleIds`**

Find:

```ts
        styleIds: activeStyle ? [activeStyle.id] : [],
```

(twice — in promptPayload and in entry construction). Replace each with:

```ts
        styleIds: activeStyles.map((s) => s.id),
```

- [ ] **Step 6: Remove the single-Select styles UI and add the multi-select on its own row**

Find the pickers grid (added in the earlier feature):

```tsx
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {hasResolutions && (
        <div className="space-y-1.5">
          <Label htmlFor="resolution">Разрешение</Label>
          <Select ... />
        </div>
        )}
        <div className="space-y-1.5">
          <Label htmlFor="aspect">Aspect ratio</Label>
          <Select ... />
        </div>
        {hasFormats && (
        <div className="space-y-1.5">
          <Label htmlFor="format">Формат</Label>
          <Select ... />
        </div>
        )}
        <div className="space-y-1.5">
          <Label htmlFor="style">Стиль</Label>
          <Select
            id="style"
            value={selectedStyleId}
            onChange={(e) => setSelectedStyleId(e.target.value)}
            options={[
              { value: DEFAULT_STYLE_ID, label: "Стандартный" },
              ...styles.map((s) => ({ value: s.id, label: s.name })),
            ]}
          />
        </div>
      </div>
```

Replace with:

```tsx
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        {hasResolutions && (
        <div className="space-y-1.5">
          <Label htmlFor="resolution">Разрешение</Label>
          <Select
            id="resolution"
            value={resolution}
            onChange={(e) => setResolution(e.target.value as Resolution)}
            options={visibleResolutionOptions}
          />
        </div>
        )}
        <div className="space-y-1.5">
          <Label htmlFor="aspect">Aspect ratio</Label>
          <Select
            id="aspect"
            value={aspectRatio}
            onChange={(e) => setAspectRatio(e.target.value)}
            options={ASPECT_OPTIONS}
          />
        </div>
        {hasFormats && (
        <div className="space-y-1.5">
          <Label htmlFor="format">Формат</Label>
          <Select
            id="format"
            value={outputFormat}
            onChange={(e) => setOutputFormat(e.target.value as OutputFormat)}
            options={visibleFormatOptions}
          />
        </div>
        )}
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="style">Стиль</Label>
        <StylesMultiSelect
          id="style"
          styles={styles}
          selectedIds={selectedStyleIds}
          onChange={setSelectedStyleIds}
        />
      </div>
```

**Notes on the layout change:**
- Grid goes back to 3 columns max (dropped `lg:grid-cols-4`) because the Стиль picker is no longer one of the grid cells.
- Style picker is a fresh `<div>` sibling immediately after the grid — full form-card width, its own row.
- `Select`, `Resolution`, etc. bindings inside the grid are reproduced verbatim from the current code — verify those match the file you're editing before removing the old block.

- [ ] **Step 7: Type-check**

Run: `npx tsc --noEmit`
Expected: 0 errors.

- [ ] **Step 8: Tests**

Run: `npm test`
Expected: same count as after Task 2 — no test files touched.

- [ ] **Step 9: Manual smoke**

`npm run dev`. Visit `/`:
- The "Стиль" picker is now on its own row beneath the Resolution/Aspect/Format grid.
- Click trigger → dropdown opens with checkbox rows, no "Стандартный" row.
- Tick a style → number 1 appears, trigger shows the name.
- Tick a second → number 2 appears, trigger shows "A + B".
- Tick a third, fourth → warning line appears below the trigger.
- Untick the first → remaining renumber to 1, 2, 3 (contiguous).
- Click outside or press Esc → closes.
- Reload → selection persists via localStorage v2.
- Submit a generation → new history card shows "Стили: A + B" badge (plural) when ≥ 2 styles; "Стиль: A" (singular) when 1.

- [ ] **Step 10: Commit**

```bash
git add components/generate-form.tsx
git commit -m "feat(styles): multi-select styles picker with matryoshka wrapping

Replace the single Select with the new StylesMultiSelect component.
The picker moves to its own second row beneath the pickers grid.
activeStyle (single) becomes activeStyles (array); composeFinalPrompt
receives the real array now, so matryoshka wrapping kicks in when
more than one style is ticked. Singular/plural badge noun chosen
based on length."
```

---

## Task 5: End-to-end verification

- [ ] **Step 1: Tests**

Run: `npm test`
Expected: full suite green. Approximate count ~60 (exact TBD at runtime).

- [ ] **Step 2: Type-check**

Run: `npx tsc --noEmit`
Expected: 0 errors.

- [ ] **Step 3: Next build**

Run: `npm run build`
Expected: clean build; all API routes still present.

- [ ] **Step 4: Manual E2E walkthrough**

`npm run dev`. Open `/`:

**A — Pre-feature backward compat (critical):**
1. Find an old entry (pre-Prompt-Styles). No badge; card text is the raw prompt as before.
2. Click copy. Textarea receives the prompt. Dropdown state unchanged (whatever you had selected stays). Toast "Промпт скопирован".

**B — Legacy single-style entries (from the single-Select era):**
3. Find an entry generated with exactly one style via the old Select UI. Its prompt_data has `styleId: "<id>"`. Verify the card shows "Стиль: <name>" and the badge renders with the joined name (singular).
4. Click copy. Textarea receives clean userPrompt; dropdown auto-ticks that one style; toast "Промпт скопирован, стиль «<name>» применён".

**C — Default (no style) post-feature:**
5. Ensure no ticks in the dropdown (Стандартный). Submit a prompt. New card has no badge.
6. Copy it → dropdown stays at empty, textarea clean, toast "Промпт скопирован".

**D — Single-style post-feature:**
7. Tick one style. Submit. New card shows "Стиль: X" (singular).
8. Copy it → textarea clean, dropdown re-ticks that style, toast uses singular form.

**E — Multi-style happy path:**
9. Tick three styles A, B, C (in order). Verify trigger shows "A + B + C" and no >3 warning.
10. Submit. In DevTools Network tab → /api/generate/submit request body → `prompt` should be matryoshka-wrapped: `pA. pB. pC. <user>. sC. sB. sA.` (with empty parts filtered).
11. The new card shows "Стили: A + B + C" (plural).
12. Copy it → textarea receives clean prompt; dropdown auto-ticks A, B, C in the same order (check the numbers 1/2/3).
13. Toast uses the plural form with joined names.

**F — Over-3 soft warning:**
14. Tick a fourth style. Warning line "⚠ Больше 3 стилей…" appears beneath the trigger. Submitting still works; no blocking.

**G — Deleted style at copy time:**
15. In `/admin`, delete one of the three styles from step 9. Refocus `/`.
16. The old card's badge falls back to the raw id for the deleted one.
17. Copy the old card → textarea receives the wrapped prompt, dropdown cleared, warning toast names the missing style (by its raw id).

**H — Unticking renumbers:**
18. With three ticks (1, 2, 3), untick the middle one (2). Remaining two become 1, 2 contiguous. Trigger label updates to the two remaining names joined.

**I — LocalStorage migration:**
19. Before visiting in a browser that has the v1 key (if you have one around), check LS: `wavespeed:selectedStyle:v1`. Load the app. After load, only `wavespeed:selectedStyles:v2` is present, and its value is the migrated array.

- [ ] **Step 5: Mark task complete and report**

If any step fails, file it explicitly rather than silently patching.

---

## Self-Review Notes

**Spec coverage:**
- UI (checkbox dropdown, second row, soft >3 warning) → Task 3 + Task 4.
- Data model (`styleIds: string[]`, empty = default, pre-feature fallback) → Task 2.
- LocalStorage migration v1→v2 → Task 1.
- Matryoshka composition → Task 2 (inject.ts rewrite + tests).
- Hydrate back-compat for legacy `styleId` → Task 2 (serverGenToEntry + test cases).
- Copy-unwrap four branches on array → Task 2 (apply-copied.ts + test cases).
- Card badge (singular/plural, joinStyleNames fallback) → Task 2.

**Type consistency:** `selectedStyleIds`, `setSelectedStyleIds`, `reconcileSelectedStyles`, `styleIds`, `activeStyles`, `CopiedEntry.styleIds`, `ApplyCopiedSetters.setSelectedStyleIds`, `joinStyleNames` — all names used consistently across tasks.

**No placeholders:** every step has concrete code. One deliberate "~60 tests" approximation in Task 5 is acceptable because the exact count depends on whether any existing test setups reshuffled during Task 2; the verification is "green" not a specific number.

**Known sharp edges:**
- Task 2 is large (11 files). It is bundled because any narrower split creates TS errors that span task boundaries. Subagent should be briefed to expect this size.
- The soft-warning label text uses a leading ⚠ emoji per the spec. If the codebase style disfavors emoji in UI text, substitute with a plain word (e.g., "Внимание:") in Task 3 and let the reviewer choose.
- If manual smoke in Task 4 Step 9 fails because of LS state pollution from earlier testing, clear LS and retry. Expected transient, not a bug.
