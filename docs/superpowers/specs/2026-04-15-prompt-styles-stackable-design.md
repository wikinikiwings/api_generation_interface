# Prompt Styles — Stackable (Multi-Select) Design

**Date:** 2026-04-15
**Status:** Approved (brainstorming), awaiting implementation plan
**Builds on:**
- `docs/superpowers/specs/2026-04-15-prompt-styles-design.md` (single-style shipped 2026-04-15)
- `docs/superpowers/specs/2026-04-15-prompt-styles-copy-unwrap-design.md` (copy-unwrap shipped 2026-04-15)

## Problem

Users want to combine multiple styles on a single generation (e.g. "Cinematic" base + "3D render" modifier + "storm weather" detail). Single-style selection caps expressiveness; users naturally reach for layered looks.

## Goal

Multi-select dropdown where each style row has a checkbox. Ticking adds an order number (1, 2, 3, …) reflecting click order. Unticking renumbers. Combined prompt wraps user text matryoshka-style — outermost style added to its prefix first and its suffix last, innermost style closest to the user text on both sides. Soft warning above 3 selected styles.

Back-compat: pre-feature entries and single-style records (from the just-shipped feature) continue to work via graceful fallback.

## Data Model

### `prompt_data` JSON (server-stored)

```json
{
  "prompt": "cinematic. 3d_render. a cat. lightning. 35mm",
  "userPrompt": "a cat",
  "styleIds": ["kino-a3f", "3d-b12", "groza-c8x"]
}
```

- **`styleIds: string[]`** — applied styles in click order. **Empty array** `[]` is the explicit post-feature "Стандартный" state.
- **Missing `styleIds`** (field absent) signals a pre-feature entry — consumers fall back to `entry.prompt` exactly as today.
- The old single-style field `styleId` is **no longer written** but remains supported on the read path during the transition.

### `HistoryEntry` (in-memory)

```ts
userPrompt?: string;
styleIds?: string[];
```

The former `styleId?: string` field is **removed**. In-memory type was never tied to a DB column, so removal is a TypeScript-level change only.

### `useSettingsStore` (localStorage-backed)

```ts
selectedStyleIds: string[];                                    // was: selectedStyleId
setSelectedStyleIds: (ids: string[]) => void;
reconcileSelectedStyles: (knownIds: readonly string[]) => void;
```

LS key: **`wavespeed:selectedStyles:v2`**.

One-shot migration on initial load: if key `wavespeed:selectedStyle:v1` exists, read it, convert (`"__default__" → []`, other `id → [id]`), write to v2, delete v1. Silent — no UI.

`reconcileSelectedStyles(knownIds)` filters `selectedStyleIds` to only those ids present in `knownIds`. If all go away, the array becomes empty (same UX as "Стандартный"). No toast — silent.

### Hydrate read path (`lib/history/store.ts → serverGenToEntry`)

```ts
let styleIds: string[] | undefined;
const parsed = JSON.parse(row.prompt_data) as {
  prompt?: string;
  workflow?: string;
  userPrompt?: string;
  styleId?: string;          // legacy single
  styleIds?: string[];       // new multi
};
if (Array.isArray(parsed.styleIds) && parsed.styleIds.every((x) => typeof x === "string")) {
  styleIds = parsed.styleIds;
} else if (typeof parsed.styleId === "string") {
  // Legacy single-style record → coerce to array
  styleIds = parsed.styleId === DEFAULT_STYLE_ID ? [] : [parsed.styleId];
}
// else: pre-feature — styleIds stays undefined
```

`userPrompt` extraction stays as-is.

### Write path (`components/generate-form.tsx → promptPayload`)

```ts
userPrompt: prompt.trim(),
styleIds: activeStyles.map((s) => s.id),   // empty array when nothing selected
```

`styleId` (the old field) is **no longer written**. The read path still accepts it for records produced during the single-style window.

## UI — Multi-Select Dropdown

### Placement

The picker **moves out of the current Resolution/Aspect/Format grid onto its own row** (second row, full form-card width). Horizontal room for the checkbox list and for the comma-plus label in the closed trigger.

### Component

New file: `components/styles-multi-select.tsx`. Built on a shadcn `Popover` primitive if available in the project, else a minimal `useState` + click-outside custom implementation. Not a native `<select>` — `<select multiple>` does not support per-row checkboxes + order numbers.

### Trigger (closed state)

- **0 selected:** label reads `Стандартный`.
- **1+ selected:** label reads as ordered names joined with `+`, e.g. `Кино + 3D + Гроза`. Truncated with ellipsis on overflow.
- `ChevronDown` icon on the right.
- Full width of its row.

### List (open state)

- Scrollable if overflow.
- Each row: `[☐] <style name>` by default. When ticked, transforms to `[☑ N] <style name>` where `N` is the style's 1-based slot in `selectedStyleIds`.
- "Стандартный" is **not shown** as a row — empty selection is the default state.
- Click anywhere on the row toggles the checkbox.
- Unticking renumbers the remaining ticks to stay contiguous (`[1][2][3]` with middle untucked becomes `[1][2]`).
- Close triggers: click outside, press `Esc`, click the trigger again.

### Over-3 warning

Inline small text below the dropdown (`text-xs text-muted-foreground`), visible only when `selectedStyleIds.length > 3`:

> ⚠ Больше 3 стилей — может выйти невнятный промпт

Non-blocking. Vanishes at 3 or below.

### Accessibility

- Trigger is a real `<button>` — keyboard focusable, Space/Enter opens.
- Each row is `<button role="menuitemcheckbox">` with `aria-checked` reflecting its state.
- Focus trapped inside the open popover. Arrow keys move focus between rows. `Esc` closes and restores focus to the trigger.

## Composition — Matryoshka

### `composeFinalPrompt` new signature

```ts
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

### Wrapping order

Given `activeStyles = [s1, s2, s3]` (in click order):

- Output shape: `p1. p2. p3. userPrompt. s3. s2. s1.`
- `s1` is the **outermost** style — its prefix comes first, its suffix comes last.
- `s3` is the **innermost** — its prefix last before the user prompt, its suffix first after.

Rationale: pick-order reads as "main style → refining modifier". Outer layer dominates token positions at both ends.

### Edge cases

- Empty `activeStyles` → identity.
- All prefixes and all suffixes empty → identity.
- A style with only prefix (suffix is empty) contributes only to the left side; the right-side reverse iteration skips it naturally via the length filter.
- Each `prefix`/`suffix` is `trim()`ed at compose time (not stored-trimmed) so trailing newlines from the admin textarea don't break the `". "` separator.

### Backward compatibility

The single-style shipped code called `composeFinalPrompt(userPrompt, activeStyle)` with `Style | null`. Change those callsites (both in `generate-form.tsx`) to pass `activeStyles: Style[]` instead — a zero- or one-length array behaves identically to the old `null`/single style.

## Copy-Unwrap

### `applyCopiedPrompt` new interfaces

```ts
interface CopiedEntry {
  prompt: string;
  userPrompt?: string;
  styleIds?: string[];
}

interface ApplyCopiedSetters {
  setPrompt: (s: string) => void;
  setSelectedStyleIds: (ids: string[]) => void;
  toastInfo: (msg: string) => void;
  toastWarn: (msg: string) => void;
}
```

### Four branches (extended)

1. **`styleIds === undefined`** — pre-feature. `setPrompt(entry.prompt)`; selection untouched; toastInfo `"Промпт скопирован"`.

2. **`styleIds.length === 0`** — post-feature "Стандартный". `setPrompt(entry.userPrompt ?? entry.prompt)`; `setSelectedStyleIds([])`; toastInfo `"Промпт скопирован"`.

3. **All ids resolve in the current styles list.** `setPrompt(entry.userPrompt ?? entry.prompt)`; `setSelectedStyleIds(entry.styleIds)`; toastInfo:
   - One style: `Промпт скопирован, стиль «Кино» применён`
   - Multiple: `Промпт скопирован, стили «Кино + 3D + Гроза» применены`

4. **At least one id missing** from current styles list. `setPrompt(entry.prompt)` (the wrapped prompt, identity behavior on resubmit); `setSelectedStyleIds([])` (clear all ticks); toastWarn:
   - Single id missing out of N: `Стиль «<id>» удалён, промпт вставлен как есть` — id shown raw because the name is gone with the deleted style.
   - Multiple missing: `Некоторые стили удалены, промпт вставлен как есть`.

### Helper

A pure helper `joinStyleNames(ids: readonly string[], styles: readonly Style[]): string` joins style names with `" + "`, falling back to raw id if a name is not found. Used both in the copy toast and in the history card badge.

## History Card Badge

In both `components/output-area.tsx` and `components/history-sidebar.tsx`, the badge logic becomes:

```tsx
{entry.styleIds && entry.styleIds.length > 0 && (
  <span className="mt-0.5 inline-flex items-center gap-1 text-[10px] text-muted-foreground">
    <Sparkles className="h-3 w-3" />
    {entry.styleIds.length === 1 ? "Стиль" : "Стили"}: {joinStyleNames(entry.styleIds, styles)}
  </span>
)}
```

- `entry.styleIds === undefined` (pre-feature) → no badge.
- `entry.styleIds === []` (post-feature default) → no badge.
- Missing style in record is rendered as raw id in the `+`-list — no explicit `(удалён)` marker. The user will see the full story on copy via the warning toast. Keeping the badge clean.

Prompt display text (`entry.userPrompt ?? entry.prompt`) is unchanged.

## Admin UI

**No changes.** Styles are still authored one at a time in the admin panel. Stacking is a purely consumer-side concept — the admin doesn't need to know.

## Testing

### Updated

- `lib/styles/__tests__/inject.test.ts` — adapt existing tests to the new signature (wrap in `[]` or use single-element arrays). Add:
  - Empty array → identity.
  - One style (round-trip regression).
  - Three styles, all parts populated → matryoshka order verified.
  - Three styles, one with only prefix, another with only suffix → filter works.
  - Three styles with trailing newlines in admin text → trim works.

- `lib/styles/__tests__/apply-copied.test.ts` — update existing 5 tests for the new array-shape `CopiedEntry` and `setSelectedStyleIds` setter. Add:
  - Multi-style happy path (3 ids, all exist, plural toast wording with "+" separator).
  - Multi-style with one missing (full fallback, selection cleared, single-name warning toast using raw id).
  - Multi-style with two missing (generic "Некоторые стили удалены" toast).

- `lib/history/__tests__/store.test.ts` — update existing 2 hydrate tests. Add:
  - Legacy single `styleId` present (non-default) → `styleIds: [that_id]`.
  - Legacy `styleId === "__default__"` → `styleIds: []`.
  - New `styleIds: [...]` present → used verbatim.
  - Neither → `styleIds: undefined` (pre-feature).

### Not added

- UI render tests for the new `StylesMultiSelect` component — the project has no React Testing Library setup; manual browser smoke covers it.

## Non-Goals

- Auto-suggesting style combinations.
- Drag-and-drop reordering of selected styles (click-order is the order — untick + retick moves to the end).
- Saved preset bundles ("favourite combos").
- Syncing selection between admin tab and generation tab (styles list already refreshes on focus; selection is per-tab).
- Human-readable snapshot of style names inside `prompt_data` (rejected as YAGNI — would add sync complexity for a rare deletion case).
- Cross-admin-action warnings (e.g., "editing this style affects 4 recent generations") — out of scope.

## Open Questions

None at brainstorming close. All five clarifications resolved:
1. UI: checkbox dropdown with order numbers, moved to second row.
2. Max styles: soft warning above 3, no hard cap.
3. Order: matryoshka — outermost click dominates both ends.
4. Deleted style on copy: full fallback (variant A).
5. Display: names joined with " + " in both trigger and badge; "Стиль/Стили" noun per count.
