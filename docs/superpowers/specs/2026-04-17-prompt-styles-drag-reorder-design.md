# Drag-Reorder for Prompt Styles — Design

**Date:** 2026-04-17
**Follows:** 2026-04-17-prompt-preview-modal (shipped earlier today)

## Goal

Let the user change the matryoshka wrap order by dragging ticked styles
in the preview modal's left column, instead of unticking and
re-ticking in the right sequence.

## Out of scope

- Drag inside the main-form dropdown (`components/styles-multi-select.tsx`).
- Drag from the right-column preview tiles (they reflect order, they
  are not the source of truth).
- Dragging an unticked style directly into a position (that is "tick
  it + place it", two operations — still requires a click to tick).
- Virtualized or paginated style lists (the admin caps are low).

## Decisions (brainstorm outcome)

1. **Drag location: preview modal's left column only.** Dropdown stays
   unchanged. Preview is the natural venue for fine-tuning order
   because the right column shows the effect in real time after drop.
2. **Library: `@dnd-kit/core` + `@dnd-kit/sortable`.** De-facto React
   sortable stack, ~15kb gzip, touch + mouse + keyboard sensors
   included. `arrayMove` utility does the list reorder for us.
3. **Drag handle: the order-number badge.** The badge already means
   "position in the matryoshka", so dragging by the number is
   semantically clean. Unticked styles have no badge → not draggable.
   Badge grows from `h-4 w-4` to `h-5 w-5` to accommodate the handle
   role and `cursor-grab`/`cursor-grabbing` affordance.

## Architecture

### Dependency additions

Add to `package.json` `dependencies`:

```json
"@dnd-kit/core": "^6.3.1",
"@dnd-kit/sortable": "^10.0.0"
```

(Use versions compatible with React 19 — these are the latest at time
of writing and declare `react@^19` support.)

### Touched file

Only `components/prompt-preview-dialog.tsx` changes. No new
component files. The row-markup change is contained.

### New row structure in the left column

Current (single flat button per row, regardless of tick state):

```tsx
<button onClick={() => toggle(s.id)} role="menuitemcheckbox" ...>
  <span className="badge">{order ?? ""}</span>
  <span>{s.name}</span>
</button>
```

After — two row variants, conditional on `checked`:

**Ticked row** — wrapped in `useSortable`, split into drag-handle + name:

```tsx
<div
  ref={setNodeRef}
  style={{ transform: CSS.Transform.toString(transform), transition }}
  className={cn(
    "flex items-center gap-1 rounded-md bg-primary/5 transition-colors",
    isDragging && "opacity-50 z-10"
  )}
  role="menuitemcheckbox"
  aria-checked
>
  <button
    type="button"
    {...attributes}
    {...listeners}
    title="Потяни чтобы изменить порядок"
    aria-label={`Позиция ${order}. Потяни чтобы изменить порядок`}
    className="flex h-5 w-5 shrink-0 items-center justify-center rounded border border-primary bg-primary text-[11px] font-semibold text-primary-foreground cursor-grab active:cursor-grabbing"
  >
    {order}
  </button>
  <button
    type="button"
    onClick={() => toggle(s.id)}
    className="flex min-w-0 flex-1 items-center rounded-md px-2 py-1.5 text-left text-sm transition-colors hover:bg-accent hover:text-accent-foreground"
  >
    <span className="truncate">{s.name}</span>
  </button>
</div>
```

**Unticked row** — unchanged markup shape (single toggle button):

```tsx
<button
  type="button"
  onClick={() => toggle(s.id)}
  className="flex min-w-0 items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm transition-colors hover:bg-accent hover:text-accent-foreground"
  role="menuitemcheckbox"
  aria-checked={false}
>
  <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded border border-muted-foreground/40 text-[10px]" />
  <span className="truncate">{s.name}</span>
</button>
```

Note the empty badge is now `h-5 w-5` (up from `h-4`) so the row height
matches its ticked counterpart. The `gap-1` on ticked vs `gap-2` on
unticked keeps the name tight against the handle button.

### Sensor + context wiring

Inside `PromptPreviewDialog`, add the DnD context around the left
column only. Imports:

```tsx
import {
  DndContext,
  type DragEndEvent,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import {
  arrayMove,
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
```

Inside the component body:

```tsx
const sensors = useSensors(
  useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
  useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
);

function handleDragEnd(e: DragEndEvent) {
  const { active, over } = e;
  if (!over || active.id === over.id) return;
  const oldIdx = selectedStyleIds.indexOf(String(active.id));
  const newIdx = selectedStyleIds.indexOf(String(over.id));
  if (oldIdx === -1 || newIdx === -1) return;
  setSelectedStyleIds(arrayMove(selectedStyleIds, oldIdx, newIdx));
}
```

The left-column JSX becomes:

```tsx
<div className="flex flex-col gap-1 md:overflow-y-auto md:pr-2">
  {styles.length === 0 ? (
    <div className="px-2 py-1.5 text-xs text-muted-foreground">
      Стилей пока нет. Создайте в админке.
    </div>
  ) : (
    <DndContext sensors={sensors} onDragEnd={handleDragEnd}>
      <SortableContext items={selectedStyleIds} strategy={verticalListSortingStrategy}>
        {styles.map((s) => {
          const idx = selectedStyleIds.indexOf(s.id);
          const checked = idx !== -1;
          if (checked) {
            return (
              <SortableStyleRow
                key={s.id}
                style={s}
                order={idx + 1}
                onToggle={() => toggle(s.id)}
              />
            );
          }
          return (
            <PlainStyleRow
              key={s.id}
              style={s}
              onToggle={() => toggle(s.id)}
            />
          );
        })}
      </SortableContext>
    </DndContext>
  )}
  {/* >3 warning stays as-is */}
</div>
```

`SortableStyleRow` and `PlainStyleRow` are small local components
defined in the same file (they are tiny — splitting them into new
files is premature). `SortableStyleRow` calls `useSortable({ id:
style.id })` and returns the ticked-row markup shown above.
`PlainStyleRow` returns the unticked-row markup.

### Why inline components instead of inlining everything

`useSortable` is a hook and has to be called per row. That requires
one component per row. Two small helpers beat a 60-line IIFE inside
`.map()`. They stay in the same file because they read no state
beyond their props and exist solely for this dialog.

## Data flow

```
user grabs the order badge on a ticked row
  → @dnd-kit PointerSensor fires after 4px movement
  → DragOverlay-less drag: row translates via CSS transform
  → other ticked rows smoothly shift (SortableContext)
  → user releases over another ticked row
  → handleDragEnd fires
  → arrayMove(selectedStyleIds, oldIdx, newIdx)
  → setSelectedStyleIds(newArray)
  → zustand broadcasts:
     • left column re-renders with new indexOf order
     • right column re-renders (buildPreviewBlocks reflects new order)
     • form dropdown label ("A + B + C") updates
     • submit body on next generation uses the new order
```

Right column does not update during the drag — only after `onDragEnd`
fires. This avoids visual chatter.

## Edge cases

- **0 ticked styles:** `selectedStyleIds` is `[]`, `SortableContext`
  wraps nothing draggable. No-op.
- **1 ticked style:** `SortableContext items=[id]`, cannot drop it on
  itself (handled by `active.id === over.id` guard). Drag visual
  still works but does nothing on release.
- **Drag cancelled (ESC or drop outside):** @dnd-kit's default
  behavior cancels and `onDragEnd` fires with `over === null` — our
  guard returns early. No state change.
- **Style deleted mid-drag:** unlikely in practice; `activeStyles`
  filter in the dialog already strips missing ids from the rendered
  list. If the dragged row disappears during drag, @dnd-kit cancels
  the operation cleanly.
- **Touch:** `PointerSensor` covers it. 4px activation distance plus
  the small handle mean accidental drags on scroll are unlikely — on
  mobile the user has to land on the badge specifically.
- **Keyboard:** `KeyboardSensor` — Tab to the badge button, Space to
  pick up, Up/Down to reorder, Space to drop, Esc to cancel. @dnd-kit
  announces via `LiveRegion` automatically.

## Testing

### Unit — `handleDragEnd`

Extract the handler's logic into a tiny pure function for
testability:

```ts
// Still inside components/prompt-preview-dialog.tsx, exported for tests.
export function reorderStyleIds(
  ids: readonly string[],
  activeId: string,
  overId: string | null
): string[] | null {
  if (!overId || activeId === overId) return null;
  const oldIdx = ids.indexOf(activeId);
  const newIdx = ids.indexOf(overId);
  if (oldIdx === -1 || newIdx === -1) return null;
  return arrayMove(ids.slice(), oldIdx, newIdx);
}
```

`handleDragEnd` calls it and calls `setSelectedStyleIds` iff the
return is non-null.

Tests in `components/__tests__/prompt-preview-dialog-reorder.test.ts`:

- returns `null` when `overId` is null → no-op.
- returns `null` when `active === over` → no-op.
- returns `null` when either id is not in the list.
- returns reordered array for a typical move (forward).
- returns reordered array for a typical move (backward).
- preserves length and set-equality.

### No @dnd-kit runtime tests

The library is trusted. We test our thin wrapper, not its sensors or
internals.

### Manual verification

- Open preview with 3 ticked styles. Drag slot-2's badge onto slot-1.
  Numbers renumber (`1↔2`), right column updates on release.
- Drag slot-1's badge onto slot-3. Numbers become `3, 1, 2` in old
  order → renumbered to `1, 2, 3` with new arrangement.
- Drag same slot onto itself → no visual change, no state update.
- Press Tab to focus the badge, Space to pick up, ArrowDown → row
  moves down visually, Space → drop, Esc when picked-up → cancel.
- Resize modal to mobile width — drag still works via touch emulation
  in DevTools.
- Reorder, close modal, reopen — order persists (store-backed).
- Reorder, submit a generation — request body's `styleIds` reflects
  the new order.
- Dropdown in the form shows the same order in its trigger label
  after reorder.

## Files

**Modify:**
- `package.json` — add `@dnd-kit/core`, `@dnd-kit/sortable`.
- `package-lock.json` — regenerated by `npm install`.
- `components/prompt-preview-dialog.tsx` — inline `SortableStyleRow`,
  `PlainStyleRow`, `handleDragEnd`, `reorderStyleIds`, DnD context
  around the styles list. Badge grows to `h-5 w-5`. Unticked empty
  badge matches size.

**Create:**
- `components/__tests__/prompt-preview-dialog-reorder.test.ts` — unit
  tests for `reorderStyleIds`.

**Unchanged:**
- `components/styles-multi-select.tsx` — dropdown stays non-draggable.
- `lib/styles/*` — no change. The store is the integration point.
- `stores/settings-store.ts` — already has `setSelectedStyleIds`.
