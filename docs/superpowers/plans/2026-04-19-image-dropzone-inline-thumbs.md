# Image Dropzone Inline-Thumbnails Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move thumbnails inside the dashed dropzone container and add an "Add" tile at the end of the grid, preserving every existing behavior.

**Architecture:** Single-file visual refactor of `components/image-dropzone.tsx`. The outer dashed `<div>` becomes the sole top-level node and hosts two mutually-exclusive states (empty / filled). Filled state holds the thumbnail grid (with a trailing add-tile) and a counter footer — all inside the same dashed box. No public API changes.

**Tech Stack:** Next.js 15, React 19, Tailwind, lucide-react, sonner. Tests: none (visual change; manual verification per spec).

**Spec:** `docs/superpowers/specs/2026-04-19-image-dropzone-inline-thumbs-design.md`

---

## File Structure

- **Modify:** `components/image-dropzone.tsx` (only file touched)

No other files change. No tests added.

---

## Task 1: Restructure container — move grid inside, split empty/filled states

**Files:**
- Modify: `components/image-dropzone.tsx` (lines 251–366 — the `return (...)` block)

The outer wrapper `<div className="space-y-3">` is removed; the dashed container becomes the root. The dashed container gains state-aware layout classes. The thumbnail grid moves from sibling to child. The outer `onDragOver` gets a `draggedId` guard so internal reorders don't flicker the outer highlight. Empty-state sub-line drops the `· выбрано N/M` suffix (that count moves to a footer in filled state, added in this task too).

- [ ] **Step 1: Read the current file**

Run: Read `components/image-dropzone.tsx` in full.

Confirm line numbers of the `return (...)` block (expected ~251–366).

- [ ] **Step 2: Replace the entire `return (...)` block**

Replace lines 251–366 (the full `return (...)` statement, ending with the closing `);` before the component's closing `}`) with:

```tsx
  const hasImages = value.length > 0;

  return (
    <div
      onDragOver={(e) => {
        // Internal tile reorder fires outer dragOver when the dragged
        // tile moves over empty grid space inside the box. Early-return
        // so the outer highlight doesn't flicker during a reorder.
        if (draggedId) return;
        e.preventDefault();
        setIsDragging(true);
      }}
      onDragLeave={() => setIsDragging(false)}
      onDrop={onDrop}
      onClick={() => inputRef.current?.click()}
      className={cn(
        "relative cursor-pointer rounded-lg border-2 border-dashed border-border bg-muted/30 transition-colors",
        "hover:border-primary/50 hover:bg-muted/50",
        isDragging && "border-primary bg-primary/5",
        remaining === 0 && "pointer-events-none opacity-50",
        hasImages
          ? "space-y-3 p-3"
          : "group flex flex-col items-center justify-center gap-2 p-6 text-center"
      )}
    >
      {!hasImages && (
        <>
          <Upload className="h-6 w-6 text-muted-foreground transition-transform group-hover:scale-110" />
          <div className="text-sm font-medium">
            {remaining === 0
              ? `Лимит ${maxImages} изображений достигнут`
              : "Перетащи картинки сюда или кликни"}
          </div>
          <div className="text-xs text-muted-foreground">
            PNG, JPEG, WebP · до {maxImages} изображений
          </div>
        </>
      )}

      {hasImages && (
        <>
          <div className="grid grid-cols-3 gap-2 sm:grid-cols-4 md:grid-cols-5">
            {value.map((img, idx) => (
              <div
                key={img.id}
                draggable
                onDragStart={(e) => {
                  setDraggedId(img.id);
                  e.dataTransfer.effectAllowed = "move";
                  // Some browsers require data to be set for drag to start.
                  e.dataTransfer.setData("text/plain", img.id);
                }}
                onDragEnd={() => {
                  setDraggedId(null);
                  setDragOverId(null);
                }}
                onDragOver={(e) => {
                  // Only react to internal tile drags, not file-from-OS drags.
                  if (!draggedId) return;
                  e.preventDefault();
                  e.stopPropagation();
                  e.dataTransfer.dropEffect = "move";
                  if (dragOverId !== img.id) setDragOverId(img.id);
                }}
                onDragLeave={(e) => {
                  if (!draggedId) return;
                  e.stopPropagation();
                  if (dragOverId === img.id) setDragOverId(null);
                }}
                onDrop={(e) => {
                  if (!draggedId) return;
                  e.preventDefault();
                  // Block bubbling so the outer file-drop zone doesn't try to
                  // ingest this as a new upload.
                  e.stopPropagation();
                  reorder(draggedId, img.id);
                  setDraggedId(null);
                  setDragOverId(null);
                }}
                className={cn(
                  "group relative aspect-square cursor-grab overflow-hidden rounded-md border border-border bg-background p-1 transition-all active:cursor-grabbing",
                  draggedId === img.id && "opacity-40",
                  dragOverId === img.id &&
                    draggedId !== img.id &&
                    "ring-2 ring-primary ring-offset-1 ring-offset-background"
                )}
              >
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={img.dataUrl}
                  alt={img.file.name}
                  draggable={false}
                  className="h-full w-full select-none object-contain"
                />
                <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/70 to-transparent p-1.5">
                  <span className="text-[10px] text-white">#{idx + 1}</span>
                </div>
                <Button
                  type="button"
                  variant="destructive"
                  size="icon"
                  className="absolute right-1 top-1 h-6 w-6 opacity-0 transition-opacity group-hover:opacity-100"
                  onClick={(e) => {
                    e.stopPropagation();
                    handleRemove(img.id);
                  }}
                  aria-label="Remove image"
                >
                  <X className="h-3 w-3" />
                </Button>
              </div>
            ))}
          </div>
          <div className="text-xs text-muted-foreground">
            {remaining === 0
              ? `Лимит ${maxImages} изображений достигнут`
              : `PNG, JPEG, WebP · выбрано ${value.length}/${maxImages}`}
          </div>
        </>
      )}

      <input
        ref={inputRef}
        type="file"
        accept={ACCEPTED}
        multiple
        className="hidden"
        onChange={(e) => {
          if (e.target.files) void handleFiles(e.target.files);
          e.target.value = "";
        }}
      />
    </div>
  );
```

Notes for the engineer:
- The outer `<div className="space-y-3">` wrapper is GONE — we now return the dashed container directly. The parent form (`components/generate-form.tsx:572`) uses `gap-2` on its flex column, so sibling spacing is already handled upstream.
- `hasImages` is computed once, just above the `return`. Both states reference it.
- Empty-state sub-line no longer includes `· выбрано ${value.length}/${maxImages}` — that info is now in the filled-state footer (the second `<div className="text-xs text-muted-foreground">` inside `{hasImages && (...)}`).
- The tile markup is byte-identical to the pre-change tile — it just moved inside the container. Do not simplify or refactor it in this task.

- [ ] **Step 3: Verify TypeScript compiles**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 4: Verify lint is clean**

Run: `npm run lint`
Expected: no new warnings/errors in `components/image-dropzone.tsx`.

- [ ] **Step 5: Smoke-check the dev build**

Run: `npm run dev` (background), open `http://localhost:3000`, confirm:
- Page loads without runtime errors (check browser console).
- Empty dropzone looks identical to previous.
- After dropping one file: the thumbnail appears INSIDE the dashed box, and a tiny "PNG, JPEG, WebP · выбрано 1/14" line appears under the grid, still inside the box.
- Reorder a tile by dragging — outer dashed border should NOT flash `border-primary` during the reorder (this is the new guard at work).

Stop the dev server.

- [ ] **Step 6: Commit**

```bash
git add components/image-dropzone.tsx
git commit -m "refactor(image-dropzone): host thumbnails inside the dashed box"
```

---

## Task 2: Add the trailing "+" add-tile inside the grid

**Files:**
- Modify: `components/image-dropzone.tsx` (import line 4; inside the `{value.map(...)}` grid added in Task 1)

The add-tile renders only when `remaining > 0`. It has no click or drop handlers — clicks and drops bubble to the outer container, which already opens the file picker on click and ingests files on drop.

- [ ] **Step 1: Add `Plus` to the lucide-react import**

Replace line 4:

```tsx
import { Upload, X } from "lucide-react";
```

with:

```tsx
import { Plus, Upload, X } from "lucide-react";
```

- [ ] **Step 2: Add the add-tile at the end of the grid**

Inside the `{hasImages && (...)}` block, find the grid `<div>`:

```tsx
<div className="grid grid-cols-3 gap-2 sm:grid-cols-4 md:grid-cols-5">
  {value.map((img, idx) => (
    ...
  ))}
</div>
```

Insert the add-tile as the last child of that grid, immediately after the closing `))}` of `value.map(...)` and before the closing `</div>` of the grid:

```tsx
            {remaining > 0 && (
              <div
                className={cn(
                  "flex aspect-square cursor-pointer flex-col items-center justify-center gap-1 rounded-md border border-dashed border-border/70 bg-background/50 text-xs text-muted-foreground transition-colors",
                  "hover:border-primary/50 hover:bg-muted/60"
                )}
                aria-label="Добавить изображение"
              >
                <Plus className="h-5 w-5" />
                <span>Добавить</span>
              </div>
            )}
```

The final grid block should look like:

```tsx
          <div className="grid grid-cols-3 gap-2 sm:grid-cols-4 md:grid-cols-5">
            {value.map((img, idx) => (
              <div
                key={img.id}
                /* ...tile contents as in Task 1... */
              >
                /* ...tile contents as in Task 1... */
              </div>
            ))}
            {remaining > 0 && (
              <div
                className={cn(
                  "flex aspect-square cursor-pointer flex-col items-center justify-center gap-1 rounded-md border border-dashed border-border/70 bg-background/50 text-xs text-muted-foreground transition-colors",
                  "hover:border-primary/50 hover:bg-muted/60"
                )}
                aria-label="Добавить изображение"
              >
                <Plus className="h-5 w-5" />
                <span>Добавить</span>
              </div>
            )}
          </div>
```

Notes:
- No `onClick` on the add-tile. Clicks bubble up to the outer container's `onClick={() => inputRef.current?.click()}`.
- No `draggable` attribute. No drop handlers. Drops bubble up and are handled by the outer `onDrop`.
- No `key` prop — it's not inside `.map()`, so React doesn't need one.

- [ ] **Step 3: Verify TypeScript compiles**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 4: Verify lint is clean**

Run: `npm run lint`
Expected: no new warnings/errors.

- [ ] **Step 5: Smoke-check the add-tile**

Run: `npm run dev` (background), open `http://localhost:3000`, confirm:
- With 0 images: no add-tile (empty state is showing the full hint).
- Drop 1 image → 1 image-tile + 1 add-tile in the grid. Add-tile has a dashed border and shows a `+` icon with "Добавить" label.
- Click the add-tile → the file picker opens.
- Drop OS files onto the add-tile → images are ingested (drop bubbled to outer).
- Fill the widget to 14 images → add-tile disappears; footer shows "Лимит 14 изображений достигнут"; the outer container is visually greyed out (existing `pointer-events-none opacity-50`).
- Remove one image from full state → add-tile reappears.

Stop the dev server.

- [ ] **Step 6: Commit**

```bash
git add components/image-dropzone.tsx
git commit -m "feat(image-dropzone): add trailing '+' add-tile to the thumbnail grid"
```

---

## Task 3: Full manual verification against the spec checklist

**Files:** none modified in this task.

Run the full verification checklist from the spec (`docs/superpowers/specs/2026-04-19-image-dropzone-inline-thumbs-design.md` — "Verification" section). This is a human-in-the-loop smoke test in a real browser.

- [ ] **Step 1: Start the dev server**

Run: `npm run dev`
Open: `http://localhost:3000`

- [ ] **Step 2: Walk the checklist**

Verify each of these behaviors end-to-end. All must pass:

1. [ ] Empty state is visually identical to pre-change (large dashed box, Upload icon, "Перетащи картинки сюда или кликни", sub-line "PNG, JPEG, WebP · до 14 изображений").
2. [ ] Drop one OS file from desktop → thumbnail appears INSIDE the dashed box; add-tile appears at the end of the grid; footer shows "PNG, JPEG, WebP · выбрано 1/14" inside the box.
3. [ ] Drop multiple OS files (e.g. 3 at once) → all render inside the box; add-tile remains last; counter updates.
4. [ ] Ctrl+V paste of a clipboard image (e.g. screenshot) → appears inside the box; "Изображение вставлено из буфера" toast fires.
5. [ ] Drag from history sidebar → "Загружаю оригинал…" loading toast → on success "Добавлено в исходном качестве" toast, full-resolution thumbnail appears inside the box.
6. [ ] Reorder tiles by drag — the outer dashed border does NOT flash `border-primary` during the drag (this is the `if (draggedId) return` guard). Drop lands at the expected position.
7. [ ] Click the add-tile → the file picker opens.
8. [ ] Click the `×` button on a tile → that tile is removed; add-tile reappears if the widget was at the limit.
9. [ ] At limit (14 images): add-tile is hidden; footer shows "Лимит 14 изображений достигнут"; outer container is greyed via `pointer-events-none opacity-50`.
10. [ ] Drag OS file(s) into the filled box → outer gets `border-primary bg-primary/5` highlight during hover; drop ingests up to the remaining room; excess files are silently skipped (pre-existing behavior — `room = maxImages - current.length`).
11. [ ] Drop a reorder drag on empty space inside the box (between tiles) → no-op, no crash, no phantom upload (outer `onDrop` sees no `files`, early-returns).
12. [ ] Click empty space inside the filled box (not on a tile) → file picker opens (outer `onClick` still fires).

- [ ] **Step 3: Fix anything that fails**

If any checklist item fails, stop and investigate. Common failure modes:
- `border-primary` flicker during reorder → the `if (draggedId) return` guard is missing or placed after `e.preventDefault()`. It must be the very first line of the outer `onDragOver`.
- Add-tile doesn't open picker → check it has NO `onClick` stopping propagation; the click must bubble.
- Footer missing counter when filled → the `{hasImages && (...)}` block is missing its second `<div className="text-xs text-muted-foreground">`.

Fix inline, re-verify the specific checklist item, then any item that depends on it.

- [ ] **Step 4: Stop the dev server**

Stop the dev server (Ctrl+C in its terminal).

- [ ] **Step 5: No commit needed**

This task is verification only. If any fixes were made in Step 3, commit them with:

```bash
git add components/image-dropzone.tsx
git commit -m "fix(image-dropzone): address manual-verification follow-ups"
```

Otherwise, skip.

---

## Spec Coverage

| Spec section | Implementing task |
|---|---|
| Empty state unchanged | Task 1 (Step 2 — `{!hasImages && (...)}` block) |
| Filled state: grid inside container | Task 1 (Step 2 — `{hasImages && (...)}` grid) |
| Filled state: add-tile at end of grid | Task 2 |
| Filled state: footer line | Task 1 (Step 2 — second text-xs div inside `{hasImages}`) |
| DOM structure matches spec | Task 1 + Task 2 |
| `draggedId` guard on outer `onDragOver` | Task 1 (Step 2 — guard at top of outer onDragOver) |
| Add-tile has no drop/click handlers | Task 2 (no handlers attached) |
| Click targets (whole box → picker) | Task 1 (Step 2 — outer `onClick` preserved) |
| Styling specifics (conditional classes) | Task 1 (Step 2 — `cn(..., hasImages ? ... : ...)`) |
| `group` class only in empty state | Task 1 (Step 2 — `group` is in the empty-only branch of the class list) |
| `DroppedImage`, API, helpers unchanged | Both tasks — no touching of lines 1–249 |
| Verification checklist | Task 3 |

No spec requirement is left without a task.
