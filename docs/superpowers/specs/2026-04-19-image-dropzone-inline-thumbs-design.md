# Image Dropzone — Inline Thumbnails

**Date:** 2026-04-19
**Scope:** `components/image-dropzone.tsx` only.

## Problem

Added images render in a separate grid **below** the dashed drop-target box, so the widget visually "leaks" — thumbnails sit outside the widget boundary. The user wants thumbnails to render **inside** the same dashed box while preserving every current behavior.

## Goals

- Thumbnails live inside the dashed dropzone container.
- Every existing behavior is preserved:
  - OS file drop (native files).
  - History / cross-app drag-in via `application/x-viewcomfy-media` custom MIME (full-resolution fetch).
  - Global `Ctrl+V` paste from clipboard.
  - Click to open file picker.
  - Tile remove (hover `×`).
  - Tile reorder by drag-and-drop between tiles.
  - `maxImages` limit (default 14) with toasts.
  - Natural width/height read for seedream providers.
- Public API unchanged: `value`, `onChange`, `maxImages`, `DroppedImage`.

## Non-Goals

- No changes to the parent `generate-form.tsx` or any consumer.
- No changes to `fileToDataURL`, `readImageDimensions`, paste semantics, or the ingestion pipeline.
- No new automated tests (visual change; verified manually).
- No bulk-select / bulk-remove / preview-modal — out of scope.

## Design

### Two visual states of one component

**Empty (`value.length === 0`)** — unchanged. Dashed box, Upload icon, hint "Перетащи картинки сюда или кликни", sub-line "PNG, JPEG, WebP · до 14 изображений".

**Filled (`value.length > 0`)** — inside the same dashed box:

1. **Grid** (same responsive `grid-cols-3 sm:grid-cols-4 md:grid-cols-5` as today) containing:
   - N **image tiles** — identical to the existing tile markup: `aspect-square`, `#N` label, hover-`×`, `draggable` for reorder.
   - A final **add-tile** — `aspect-square` with a thinner inner dashed border, centered `Plus` icon + "Добавить" label. Rendered only when `remaining > 0`.
2. **Footer line** inside the same box, below the grid: `text-xs text-muted-foreground`, content `"PNG, JPEG, WebP · выбрано {n}/{max}"`. When `remaining === 0` the text becomes `"Лимит {max} изображений достигнут"`.

### DOM structure

```
<div className="space-y-3">
  <div
    onDragOver onDragLeave onDrop onClick
    className="dashed-container …"
  >
    {/* EMPTY STATE */}
    {value.length === 0 && (
      <>
        <Upload />
        <div>Перетащи картинки сюда или кликни</div>
        <div>PNG, JPEG, WebP · до {maxImages} изображений</div>
      </>
    )}

    {/* FILLED STATE */}
    {value.length > 0 && (
      <>
        <div className="grid …">
          {value.map(img => <ImageTile … />)}
          {remaining > 0 && <AddTile />}
        </div>
        <div className="text-xs text-muted-foreground …">
          {remaining === 0
            ? `Лимит ${maxImages} изображений достигнут`
            : `PNG, JPEG, WebP · выбрано ${value.length}/${maxImages}`}
        </div>
      </>
    )}

    <input type="file" hidden … />
  </div>
</div>
```

### Drag-and-drop semantics

- **External drops (OS files, history payload):** handled on the outer `<div>` — same as today. Unchanged.
- **Internal reorder:** handled at tile level with `e.stopPropagation()` — same as today. Unchanged.
- **Fix — drag-over highlight conflict:** when an internal reorder is in progress, the outer `onDragOver` currently sets `isDragging = true` (because the dragged tile moves over the outer container). Now that the grid lives **inside** the box, that highlight will flicker during reorder. Add a guard at the top of the outer `onDragOver`:
  ```tsx
  if (draggedId) return; // internal reorder in progress
  ```
- **Add-tile:** no drop handlers of its own. Any drop on it bubbles to the outer container and is ingested normally.

### Click-target rules

- Entire outer `<div>` keeps its `onClick={() => inputRef.current?.click()}` — unchanged. This makes the empty state and the add-tile both trigger the file picker.
- Image tiles stop click propagation where needed (they already do for the `×` button; they don't have an `onClick` themselves, so clicking a tile bubbles up and opens the picker — matches current behavior).

### Styling specifics

- Outer container keeps: `relative rounded-lg border-2 border-dashed border-border bg-muted/30 transition-colors` + `cursor-pointer`, plus `hover:border-primary/50 hover:bg-muted/50`, `isDragging && border-primary bg-primary/5`, `remaining === 0 && pointer-events-none opacity-50`.
- Layout/padding differ by state (same container, conditional classes):
  - Empty: `p-6 text-center flex flex-col items-center justify-center gap-2` (current look).
  - Filled: `p-3 space-y-3` (stacked: grid on top, footer below). No `text-center`, no `flex items-center`.
- The `group` class is dropped on the outer when filled (Upload-icon hover-scale no longer applies). In filled state, add-tile is the hover target instead.
- Add-tile:
  ```
  rounded-md border border-dashed border-border/70
  bg-background/50 hover:bg-muted/60 hover:border-primary/50
  flex flex-col items-center justify-center gap-1
  text-muted-foreground text-xs
  ```
- Footer line: `mt-1 text-xs text-muted-foreground text-left`.

### What is NOT changing

- `DroppedImage` type and its `width`/`height` fields.
- `handleFiles`, `ingestMediaPayload`, paste listener.
- `reorder` helper.
- Tile markup (image, `#N` label, `×` button, drag handlers, `ring-2 ring-primary` drag-over indicator).
- Toast messages and durations.
- `maxImages` default of 14.

## Edge Cases

| Case | Behavior |
|------|----------|
| Drop OS file on an image tile | Tile `onDragOver` early-returns because `draggedId` is null; event bubbles to outer → ingested. |
| Drop OS file on add-tile | Add-tile has no handlers; event bubbles to outer → ingested. |
| Reorder tile dropped on add-tile | Add-tile has no handlers; event bubbles up — but outer `onDrop` checks `e.dataTransfer.files?.length` which will be 0 for reorder drags → no-op. Slight UX gap: the tile doesn't go "to the end" on this gesture. Acceptable — dragging to the last image tile already produces the same end-position. |
| Click add-tile | Bubbles to outer, opens file picker. |
| Click empty space around tiles inside the box (filled state) | Bubbles to outer, opens file picker. Matches current "whole box is clickable" behavior. |
| `remaining === 0` | Add-tile hidden; footer text becomes limit warning; outer container gets `pointer-events-none opacity-50` (unchanged). |
| Internal reorder dragging a tile over empty grid space | Outer `onDragOver` early-returns on `draggedId`, so no spurious `border-primary` highlight. |
| Drag from history while box already at limit | `ingestMediaPayload` early-returns with "Лимит" toast (unchanged). |

## Risks

- **Visual regression:** filled-state layout switch from `flex items-center` (empty) to stacked grid (filled) could look off-balance at boundary (1 image). Acceptable — grid handles single items via `grid-cols-3` responsive.
- **Accidental picker trigger:** clicking inside the filled box anywhere except a tile will still open picker. Same behavior as today; user can close it quickly. Not a regression.
- **Scroll:** box grows taller as images accumulate. Parent form is already scrollable; no fix needed.

## Files Changed

- `components/image-dropzone.tsx` — only file touched.

## Verification

Manual verification checklist (no automated tests):

1. Empty state looks identical to current.
2. Drop one OS file → thumbnail appears inside the box; add-tile appears next to it; footer shows `1/14`.
3. Drop multiple → grid fills inside the box.
4. Paste image (Ctrl+V) → appears inside the box.
5. Drag image from history sidebar → loading toast → full-res thumbnail appears inside the box.
6. Reorder tiles by drag — no outer `border-primary` flicker during the drag; drop lands correctly.
7. Click add-tile → file picker opens.
8. Click `×` on a tile → tile removes; add-tile reappears if was at limit.
9. At limit (14): add-tile hidden; footer shows "Лимит 14 изображений достигнут"; outer box greyed via `pointer-events-none opacity-50`.
10. Drag OS file into filled box → outer box highlights `border-primary bg-primary/5`; drop ingests remaining room.

---

## Follow-up: Unified Layout (same day, 2026-04-19)

After the inline-thumbnails change landed, the user noticed the empty state was still visibly taller than the filled state, causing a size jump when the first image was added. We simplified further: the empty state's distinct "big hint" layout (Upload icon, hint paragraph) was removed entirely. **Both states now share the same shell.**

### What changed vs. the design above

- **Empty state has no special JSX.** The `{!hasImages && (...)}` branch is gone. The dashed container always renders the grid + footer, regardless of `value.length`.
- **With zero images, the grid contains only the `+` add-tile** (first cell). This gives the empty widget the same height as a 1-image widget: 1 tile row + footer + `p-3` padding.
- **Outer container padding is now always `p-3`** (no longer conditional). The `group flex flex-col items-center justify-center gap-2 p-6 text-center` empty-only class string is removed.
- **`Upload` icon and the "Перетащи картинки сюда или кликни" hint are gone.** Visual affordance comes from the dashed border + the `+` add-tile. The lucide-react `Upload` import is dropped.
- **`hasImages` constant is removed** — no longer needed without the branch.
- **Footer text tightened:** `"PNG, JPEG, WebP · выбрано ${n}/${max}"` → `"PNG, JPEG, WebP · ${n}/${max}"`. The `выбрано` word read awkwardly for `0/14`, and removing it lets the same string work for all counts. The `remaining === 0` branch still reads `"Лимит ${max} изображений достигнут"`.

### Rationale

- **Zero size jumps.** Empty and 1-image states are structurally identical (grid with N cells + footer), so height is determined by the same formula. No more visual hop when the first image arrives.
- **Simpler code.** One JSX tree instead of two branches; no `hasImages` branching; fewer imports.
- **Discoverability trade-off.** The explicit "Перетащи картинки сюда или кликни" hint is lost. The dashed container + `+` add-tile + `cursor-pointer` are judged sufficient affordance for this app's audience (power users who already know drag/paste/click patterns). User explicitly accepted this trade-off.

### Final DOM structure (post-follow-up)

```
<div
  className="dashed-container space-y-3 p-3 …"  // no state branching
  onDragOver onDragLeave onDrop onClick
>
  <div className="grid grid-cols-3 gap-2 sm:grid-cols-4 md:grid-cols-5">
    {value.map(img => <ImageTile … />)}
    {remaining > 0 && <AddTile />}          // rendered even when value is empty
  </div>
  <div className="text-xs text-muted-foreground">
    {remaining === 0
      ? `Лимит ${maxImages} изображений достигнут`
      : `PNG, JPEG, WebP · ${value.length}/${maxImages}`}
  </div>
  <input type="file" hidden … />
</div>
```

Commit: `903d169` — `refactor(image-dropzone): unify empty and filled layouts`.
