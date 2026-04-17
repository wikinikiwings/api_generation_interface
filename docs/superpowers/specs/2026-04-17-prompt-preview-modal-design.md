# Prompt Preview Modal — Design

**Date:** 2026-04-17
**Follows:** 2026-04-15-prompt-styles-stackable (shipped)

## Goal

Give the user a way to see the full prompt that will be sent to the
generation API — with prefix/suffix wrapping from each selected style —
without guessing from the dropdown. In the same window, let the user
toggle styles and immediately see how the final prompt changes.

## Out of scope

- Editing the user prompt inside the modal (stays on the main form).
- Sandbox / what-if style selection with "Apply / Cancel" — we chose
  hard binding: modal state == form state.
- Drag-and-drop reordering of styles (order is still defined by click
  order in the style list, same as the dropdown).
- A "flat text" tab next to the structured view — the Copy button
  covers the "exactly what gets sent to the API" case.

## Decisions (brainstorm outcome)

1. **Style selection is live-synced to the form.** Toggles inside the
   modal call the same `setSelectedStyleIds` as the dropdown. Closing
   the modal does not revert anything — there is no sandbox state.
2. **User prompt is read-only in the modal.** Shown as a highlighted
   block in the middle of the structured preview. Editing still
   happens in the form's `Промпт` textarea.
3. **Trigger placement: right side of the `Стиль` label row.** Label
   on the left, icon button `👁 Превью` on the right, same row —
   using the empty space next to the label, so the dropdown stays
   full-width and the form does not grow taller.
4. **Preview is structured, not flat.** Each prefix/suffix block is
   rendered as its own tile with a colored left stripe and a header
   like `Film · prefix`. The user prompt sits in the middle as a
   contrast-fg block. Blocks belonging to the same style share a
   color — matryoshka becomes visible at a glance.
5. **Layout: two columns on desktop, stacked on mobile.** Styles list
   on the left, structured preview on the right. On small screens
   (< md) they stack vertically.

## Architecture

### New component: `components/prompt-preview-dialog.tsx`

Client component. Props:

```ts
interface PromptPreviewDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  styles: Style[];              // all available styles (same list passed to GenerateForm)
}
```

The component reads live state from the stores directly:

- `selectedStyleIds` + `setSelectedStyleIds` from `useSettingsStore`
- `prompt` from `usePromptStore`

It does NOT accept these as props — by reading from stores it is
guaranteed to render the same source of truth as the form, and
toggling a style updates both the dropdown and the modal in one go.

Uses the existing `Dialog` / `DialogContent` / `DialogTitle` primitives
from `components/ui/dialog`. `DialogContent` width is `max-w-4xl` and
the content height is bounded by `max-h-[80vh]` with internal scroll
on the right column.

### New pure helper: `lib/styles/preview.ts`

```ts
export interface PreviewBlock {
  kind: "prefix" | "suffix" | "prompt";
  styleId?: string;       // undefined for the prompt block
  styleName?: string;     // undefined for the prompt block
  colorIndex?: number;    // 0..5, undefined for the prompt block
  text: string;           // post-softTrim; may be the placeholder for empty prompt
}

export function buildPreviewBlocks(
  prompt: string,
  activeStyles: readonly Style[]
): PreviewBlock[]
```

Returns the ordered list of blocks to render top-to-bottom. Matryoshka
order matches `composeFinalPrompt` in `lib/styles/inject.ts` (first-clicked
is innermost, last-clicked is outermost — see the composeFinalPrompt
JSDoc for the layout diagram):

- prefixes of `activeStyles[N-1]`, `[N-2]`, … `[0]` (outermost first, so
  the last-clicked style's prefix sits on top)
- the user-prompt block
- suffixes of `activeStyles[0]`, `[1]`, … `[N-1]` (innermost first, so
  the first-clicked style's suffix sits directly under userPrompt)

Blocks whose text is empty after `softTrim` are omitted (same rule as
`composeFinalPrompt` applies to the API string, so the preview matches).
`colorIndex` is `index % 6` for each style, stable across prefix and
suffix — both tiles of the same style share a color.

The prompt block's `text` is the user's prompt verbatim; if empty, the
caller renders a placeholder (the helper does not inject placeholder
text itself — keeps it pure and easy to test).

### Export `softTrim` from `lib/styles/inject.ts`

Currently `softTrim` is module-private. Export it so `buildPreviewBlocks`
can apply the same trim rule. Keeps the preview and the real
composition in sync — if someone changes `softTrim` later, both paths
change together.

### Trigger button in `components/generate-form.tsx`

Replace the current label row:

```tsx
<Label htmlFor="style">Стиль</Label>
```

with a flex row:

```tsx
<div className="flex items-center justify-between">
  <Label htmlFor="style">Стиль</Label>
  <button
    type="button"
    onClick={() => setPreviewOpen(true)}
    className="flex items-center gap-1 rounded text-xs text-muted-foreground hover:text-foreground transition-colors"
  >
    <Eye className="h-3.5 w-3.5" />
    Превью
  </button>
</div>
```

State: `const [previewOpen, setPreviewOpen] = React.useState(false)`.
Dialog rendered at the bottom of the form tree:

```tsx
<PromptPreviewDialog
  open={previewOpen}
  onOpenChange={setPreviewOpen}
  styles={styles}
/>
```

## Rendering detail

### Left column — styles list

Vertical list of rows. Each row mirrors the dropdown's existing pattern
(number badge, name), but:

- No Info / Copy icons (the preview itself is the "info").
- Rows are full-width checkable areas; click toggles selection.
- `selectedIds.length > 3` warning appears under the list.
- Empty-state copy: `Стилей пока нет. Создайте в админке.`

Toggle logic reuses the same rule as `StylesMultiSelect.toggle`:
click-order determines matryoshka order, unticking renumbers
remaining ticks.

### Right column — structured preview

Top row: header `Итоговый промпт` on the left, `Copy` icon button
on the right.

Below: vertical stack of tiles, one per `PreviewBlock`.

**Style tile (prefix or suffix)**
```
┌─ colored-stripe ──────────────────┐
│ Film · prefix                     │  <- header row, small muted label
│                                   │
│   monospace text, whitespace-pre  │
│                                   │
└───────────────────────────────────┘
```
- Left stripe: `w-1` (4px), color from palette by `colorIndex`.
- Header: `text-xs text-muted-foreground`, `Name · prefix|suffix`.
- Body: `font-mono text-xs whitespace-pre-wrap`.

**Prompt tile**
- No left stripe, or a distinct accent (e.g. `border-primary`).
- Header: `Промпт` in `text-xs font-medium`.
- Body: `font-mono text-sm` (slightly larger than style tiles).
- If `prompt.trim() === ""`: italic placeholder `(пустой промпт)`.

**Zero-styles case**
- Left column shows the styles list unchanged.
- Right column shows a single tile (prompt) plus a muted hint under it:
  `стили не выбраны — промпт уходит как есть`.

**Palette**
Six Tailwind-friendly colors via CSS variables so both themes work.
Concrete choice:

```ts
const STYLE_COLORS = [
  "bg-sky-500",
  "bg-violet-500",
  "bg-amber-500",
  "bg-emerald-500",
  "bg-rose-500",
  "bg-indigo-500",
];
```

Indexing is `selectedIds.indexOf(styleId) % 6`, so the same style keeps
the same color across its prefix/suffix tiles.

### Copy button

Calls `composeFinalPrompt(prompt, activeStyles)` (not the block array)
and passes the result to `copyToClipboard` from `lib/utils`. That
guarantees what you copy is byte-for-byte what the form would submit.
Toast: `Финальный промпт скопирован`.

If `prompt.trim() === ""` AND `activeStyles.length === 0`, the final
string is empty — disable the Copy button.

## Data flow summary

```
user clicks 👁 Превью
  → setPreviewOpen(true)
  → PromptPreviewDialog renders
  → reads selectedStyleIds, styles, prompt
  → computes activeStyles, blocks = buildPreviewBlocks(prompt, activeStyles)
  → renders left list (styles) + right stack (blocks)

user ticks a style in modal
  → setSelectedStyleIds(newIds) in the shared store
  → both the modal and the underlying form dropdown re-render
  → blocks recomputed, preview updates in place

user clicks Copy
  → composeFinalPrompt(prompt, activeStyles)
  → copyToClipboard(...)
  → toast

user closes modal
  → setPreviewOpen(false)
  → state already persisted to the form — no reconcile step
```

## Error / edge cases

- **Empty styles list (admin hasn't created any):** left column shows
  the existing empty-state string; right column shows only the prompt
  tile; Copy reflects whatever prompt is.
- **`softTrim` makes a prefix empty:** block is omitted (matches
  `composeFinalPrompt`'s filter).
- **Prompt contains Markdown / control chars:** preview uses
  `whitespace-pre-wrap`, no HTML injection risk (React escapes text
  by default).
- **Styles deleted while modal is open:** `selectedIds` may contain
  IDs that no longer exist in `styles`. `activeStyles` filter already
  handles this (see `generate-form.tsx:146-150`). Apply the same
  filter in the dialog — do not crash on missing style.

## Testing

**Unit — `lib/styles/preview.ts`**
- 0 styles → `[prompt]`.
- 1 style, non-empty prefix + non-empty suffix → `[prefix, prompt, suffix]` with matching `colorIndex`.
- 1 style with empty prefix (whitespace only) → `[prompt, suffix]`.
- 3 styles → correct order: `pfx[2], pfx[1], pfx[0], prompt, sfx[0], sfx[1], sfx[2]` (prefixes outermost-first, suffixes innermost-first); each style's prefix and suffix share the same `colorIndex`.
- Empty prompt → `prompt` block text is `""` (caller handles placeholder).
- Style with both prefix and suffix empty → style contributes no tiles.

**Unit — `lib/styles/inject.ts`**
- No behavior change; verify `softTrim` export does not break existing tests in `__tests__/inject.test.ts`.

**Manual / visual**
- Open modal with: 0, 1, 3, 5 styles selected. Toggle, confirm live update.
- Verify that each style's prefix + suffix share one color, different from neighbors.
- Resize to mobile width — columns stack, right column scrolls.
- Empty prompt + styles selected — placeholder renders, Copy enabled.
- Empty prompt + 0 styles — Copy disabled.
- Copy produces the exact string that would go to the API (compare
  against what hits the network on submit).

## Files touched

New:
- `components/prompt-preview-dialog.tsx`
- `lib/styles/preview.ts`
- `lib/styles/__tests__/preview.test.ts`

Modified:
- `lib/styles/inject.ts` — export `softTrim`.
- `components/generate-form.tsx` — add trigger button in label row, mount dialog.

Unchanged (but referenced):
- `components/styles-multi-select.tsx` — dropdown stays as-is.
- `lib/history/*`, `components/history-sidebar.tsx` — no history-side changes, the preview modal only affects the compose step.
