# Drag-Reorder for Prompt Styles Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the user drag ticked styles in the preview modal's left column to change the matryoshka wrap order, instead of unticking and re-ticking.

**Architecture:** Install `@dnd-kit/core` + `@dnd-kit/sortable`, extract a pure `reorderStyleIds` helper with unit tests, then refactor the left column in `components/prompt-preview-dialog.tsx` into `SortableStyleRow` + `PlainStyleRow` inline components wrapped in `DndContext` + `SortableContext`. The number badge becomes the drag handle. Reorders call `setSelectedStyleIds` on the shared zustand store — preview's right column, form dropdown, and submit body all follow automatically.

**Tech Stack:** React 19, Next.js 15, Tailwind, zustand, `@dnd-kit/core` + `@dnd-kit/sortable`, Vitest, TypeScript.

**Spec:** `docs/superpowers/specs/2026-04-17-prompt-styles-drag-reorder-design.md`

---

## File Structure

**Modify:**
- `package.json` — adds three `@dnd-kit/*` runtime deps. `package-lock.json` regenerates.
- `components/prompt-preview-dialog.tsx`:
  - Exports a new pure function `reorderStyleIds(ids, activeId, overId)`.
  - Defines inline `SortableStyleRow` and `PlainStyleRow` components (same file, right above `PromptPreviewDialog`).
  - Wraps the left-column styles list in `DndContext` + `SortableContext`.
  - Grows badge size from `h-4 w-4` to `h-5 w-5` on both ticked and unticked rows.

**Create:**
- `components/__tests__/prompt-preview-dialog-reorder.test.ts` — unit tests for `reorderStyleIds`.

**Unchanged:** `components/styles-multi-select.tsx` (form dropdown stays non-draggable), `lib/styles/*`, `stores/settings-store.ts`.

---

## Task 1: Add `@dnd-kit` dependencies

**Files:**
- Modify: `package.json`, `package-lock.json`

- [ ] **Step 1: Install the three packages**

Run in the repo root:

```bash
npm install @dnd-kit/core @dnd-kit/sortable @dnd-kit/utilities
```

This adds `@dnd-kit/core` (provides `DndContext`, sensors), `@dnd-kit/sortable` (provides `SortableContext`, `useSortable`, `arrayMove`), and `@dnd-kit/utilities` (provides `CSS.Transform.toString`). The latest versions on npm at time of writing are React-19-compatible.

- [ ] **Step 2: Verify `package.json` was updated**

Open `package.json` and confirm `dependencies` now contains three new entries:

```json
"@dnd-kit/core": "^6.x.x",
"@dnd-kit/sortable": "^10.x.x",
"@dnd-kit/utilities": "^3.x.x",
```

(Exact minor/patch versions may differ — npm pins to whatever is latest when you install.)

- [ ] **Step 3: Build sanity check**

Run: `npx tsc --noEmit`

Expected: clean (no new errors). The types for `@dnd-kit` should resolve.

- [ ] **Step 4: Test sanity check**

Run: `npx vitest run`

Expected: all 78 existing tests still pass. No regression from the install.

- [ ] **Step 5: Commit**

```bash
git add package.json package-lock.json
git commit -m "chore(deps): add @dnd-kit for prompt-style drag reorder"
```

---

## Task 2: `reorderStyleIds` pure helper (TDD)

A tiny pure function that handles drag-end logic. Exported from the dialog file so tests can exercise it without rendering React.

**Files:**
- Modify: `components/prompt-preview-dialog.tsx` (add export)
- Create: `components/__tests__/prompt-preview-dialog-reorder.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `components/__tests__/prompt-preview-dialog-reorder.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { reorderStyleIds } from "../prompt-preview-dialog";

describe("reorderStyleIds", () => {
  it("returns null when overId is null (drop outside)", () => {
    expect(reorderStyleIds(["a", "b", "c"], "a", null)).toBeNull();
  });

  it("returns null when activeId === overId (dropped on self)", () => {
    expect(reorderStyleIds(["a", "b", "c"], "b", "b")).toBeNull();
  });

  it("returns null when activeId is not in the list", () => {
    expect(reorderStyleIds(["a", "b", "c"], "z", "b")).toBeNull();
  });

  it("returns null when overId is not in the list", () => {
    expect(reorderStyleIds(["a", "b", "c"], "a", "z")).toBeNull();
  });

  it("moves forward: [a,b,c] active=a over=c → [b,c,a]", () => {
    expect(reorderStyleIds(["a", "b", "c"], "a", "c")).toEqual(["b", "c", "a"]);
  });

  it("moves backward: [a,b,c] active=c over=a → [c,a,b]", () => {
    expect(reorderStyleIds(["a", "b", "c"], "c", "a")).toEqual(["c", "a", "b"]);
  });

  it("swap adjacent: [a,b,c] active=a over=b → [b,a,c]", () => {
    expect(reorderStyleIds(["a", "b", "c"], "a", "b")).toEqual(["b", "a", "c"]);
  });

  it("preserves length and set-equality", () => {
    const before = ["a", "b", "c", "d"];
    const after = reorderStyleIds(before, "b", "d");
    expect(after).not.toBeNull();
    expect(after!.length).toBe(before.length);
    expect([...after!].sort()).toEqual([...before].sort());
  });

  it("does not mutate the input array", () => {
    const input = ["a", "b", "c"];
    const snapshot = [...input];
    reorderStyleIds(input, "a", "c");
    expect(input).toEqual(snapshot);
  });

  it("single-element list: dropping on self is a no-op", () => {
    expect(reorderStyleIds(["only"], "only", "only")).toBeNull();
  });
});
```

- [ ] **Step 2: Run the test and verify it fails**

Run: `npx vitest run components/__tests__/prompt-preview-dialog-reorder.test.ts`

Expected: failure — `reorderStyleIds` is not exported from `../prompt-preview-dialog` yet.

- [ ] **Step 3: Add the export to `components/prompt-preview-dialog.tsx`**

Open `components/prompt-preview-dialog.tsx`. Right after the existing `import type { Style } from "@/lib/styles/types";` line (currently line 12) and BEFORE the `interface PromptPreviewDialogProps` declaration, add:

```tsx
import { arrayMove } from "@dnd-kit/sortable";

/**
 * Pure reorder helper for @dnd-kit's onDragEnd. Returns the new
 * ordered id list, or null when no change should happen (drop
 * outside, dropped on self, or either id missing from the list).
 */
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

`arrayMove` from `@dnd-kit/sortable` accepts a mutable array — we pass `ids.slice()` to respect the `readonly` input and keep the function non-mutating (the test at step 1 locks this invariant in).

- [ ] **Step 4: Run the test and verify it passes**

Run: `npx vitest run components/__tests__/prompt-preview-dialog-reorder.test.ts`

Expected: all 10 tests pass.

- [ ] **Step 5: Run the full test suite to catch regressions**

Run: `npx vitest run`

Expected: 88 tests pass (previous 78 + new 10). No failures.

- [ ] **Step 6: Commit**

```bash
git add components/prompt-preview-dialog.tsx components/__tests__/prompt-preview-dialog-reorder.test.ts
git commit -m "feat(prompt-preview): add reorderStyleIds pure helper"
```

---

## Task 3: Wire DndContext + sortable rows in the dialog

Refactor the left column's `styles.map(...)` body into two inline components (`SortableStyleRow` and `PlainStyleRow`). Add `DndContext` and `SortableContext` wrappers. Grow badges from `h-4 w-4` to `h-5 w-5`. Wire `handleDragEnd` to call `reorderStyleIds` and update the store.

**Files:**
- Modify: `components/prompt-preview-dialog.tsx` (refactor left column; add imports; add two inline components; grow badges; add DnD wiring).

- [ ] **Step 1: Add the dnd-kit imports**

At the top of `components/prompt-preview-dialog.tsx`, add these imports to the existing import block (sensible location: right after the existing `arrayMove` import added in Task 2):

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
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
```

Note: `arrayMove` stays imported from `@dnd-kit/sortable` as added in Task 2. Merge the two `@dnd-kit/sortable` imports into one — your import block should end up with a single line like:

```tsx
import {
  arrayMove,
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
```

- [ ] **Step 2: Add `SortableStyleRow` and `PlainStyleRow` inline components**

Directly above the `export function PromptPreviewDialog(...)` declaration, add:

```tsx
interface StyleRowProps {
  style: Style;
  onToggle: () => void;
}

function SortableStyleRow({
  style,
  order,
  onToggle,
}: StyleRowProps & { order: number }) {
  const {
    setNodeRef,
    attributes,
    listeners,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: style.id });

  const dragStyle = {
    transform: CSS.Transform.toString(transform),
    transition,
  };

  return (
    <div
      ref={setNodeRef}
      style={dragStyle}
      role="menuitemcheckbox"
      aria-checked
      className={cn(
        "flex items-center gap-1 rounded-md bg-primary/5 transition-colors",
        isDragging && "z-10 opacity-50"
      )}
    >
      <button
        type="button"
        {...attributes}
        {...listeners}
        title="Потяни чтобы изменить порядок"
        aria-label={`Позиция ${order}. Потяни чтобы изменить порядок`}
        className="flex h-5 w-5 shrink-0 cursor-grab items-center justify-center rounded border border-primary bg-primary text-[11px] font-semibold text-primary-foreground active:cursor-grabbing"
      >
        {order}
      </button>
      <button
        type="button"
        onClick={onToggle}
        className="flex min-w-0 flex-1 items-center rounded-md px-2 py-1.5 text-left text-sm transition-colors hover:bg-accent hover:text-accent-foreground"
      >
        <span className="truncate">{style.name}</span>
      </button>
    </div>
  );
}

function PlainStyleRow({ style, onToggle }: StyleRowProps) {
  return (
    <button
      type="button"
      onClick={onToggle}
      role="menuitemcheckbox"
      aria-checked={false}
      className="flex min-w-0 items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm transition-colors hover:bg-accent hover:text-accent-foreground"
    >
      <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded border border-muted-foreground/40 text-[10px]" />
      <span className="truncate">{style.name}</span>
    </button>
  );
}
```

- [ ] **Step 3: Add sensors and `handleDragEnd` inside `PromptPreviewDialog`**

Inside the `PromptPreviewDialog` function body, after the existing `const copyDisabled = finalPrompt.length === 0;` line and BEFORE the `return (` statement, add:

```tsx
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  );

  function handleDragEnd(e: DragEndEvent) {
    const next = reorderStyleIds(
      selectedStyleIds,
      String(e.active.id),
      e.over ? String(e.over.id) : null
    );
    if (next) setSelectedStyleIds(next);
  }
```

- [ ] **Step 4: Add `untickedStyles` memo**

The file already computes `activeStyles` (line 29-33) — the ticked styles in `selectedStyleIds` order, with orphans (deleted styles still in the id list) filtered out. That is exactly the rendering order @dnd-kit needs. We'll reuse `activeStyles` for the ticked-row loop.

Add a second memo for the unticked subset. In the `PromptPreviewDialog` body, directly after the existing `activeStyles` memo (currently at lines 29-33), insert:

```tsx
  const untickedStyles = React.useMemo<Style[]>(
    () => styles.filter((s) => !selectedStyleIds.includes(s.id)),
    [styles, selectedStyleIds]
  );
```

- [ ] **Step 5: Replace the left-column `styles.map(...)` block**

Find the current left-column block in `PromptPreviewDialog`'s return (the one that renders `styles.length === 0 ? ... : styles.map((s) => { ... return <button ...>...</button>; })`).

Replace the entire `{styles.length === 0 ? (...) : (styles.map(...))}` expression with:

```tsx
            {styles.length === 0 ? (
              <div className="px-2 py-1.5 text-xs text-muted-foreground">
                Стилей пока нет. Создайте в админке.
              </div>
            ) : (
              <DndContext sensors={sensors} onDragEnd={handleDragEnd}>
                <SortableContext
                  items={activeStyles.map((s) => s.id)}
                  strategy={verticalListSortingStrategy}
                >
                  {activeStyles.map((s, i) => (
                    <SortableStyleRow
                      key={s.id}
                      style={s}
                      order={i + 1}
                      onToggle={() => toggle(s.id)}
                    />
                  ))}
                </SortableContext>
                {untickedStyles.map((s) => (
                  <PlainStyleRow
                    key={s.id}
                    style={s}
                    onToggle={() => toggle(s.id)}
                  />
                ))}
              </DndContext>
            )}
```

This renders ticked styles at the top (in `selectedStyleIds` order — the actual matryoshka order — so `@dnd-kit`'s `verticalListSortingStrategy` computes correct transforms), unticked styles below. Keep the `>3 styles` warning div exactly as-is immediately AFTER this block (no change to it).

- [ ] **Step 6: Type-check and lint**

Run: `npx tsc --noEmit`

Expected: no new errors. If you see `'Style' is defined but never used` — it's still used in `StyleRowProps`; no issue.

Run: `npm run lint`

Expected: no new warnings or errors. Pre-existing warnings in `image-dialog.tsx` and `lib/utils.ts` are expected — ignore them.

- [ ] **Step 7: Run the full test suite**

Run: `npx vitest run`

Expected: 88 tests pass. The new `reorderStyleIds` tests still pass (logic unchanged). The dialog has no automated render tests — manual verification is in Task 4.

- [ ] **Step 8: Commit**

```bash
git add components/prompt-preview-dialog.tsx
git commit -m "feat(prompt-preview): drag-reorder styles via number badge"
```

---

## Task 4: Manual browser verification

Walk through the drag UX in the browser before calling the feature done. The pure logic is covered by unit tests; the DnD interaction is covered here.

**Files:** none.

- [ ] **Step 1: Start the dev server**

Run in a separate terminal: `npm run dev`

Open http://localhost:3000 (or http://192.168.88.76:3000 for LAN).

- [ ] **Step 2: Pick 3 styles to work with**

Type any non-empty prompt in the form's `Промпт` textarea. Tick three styles in the `Стиль` dropdown in any order — say you tick `A`, `B`, `C` in that click order. Click `👁 Превью` to open the modal.

- [ ] **Step 3: Mouse reorder — forward**

Grab slot 1's badge (the `1`) on style `A`. Drag it down past `C` and release. Expected:
- Other rows smoothly shift to make room during the drag.
- On release: `A` goes to the bottom; numbers renumber so the three ticked rows read `1, 2, 3` for `B, C, A`.
- Right column re-renders: now `B`'s prefix is outermost, `A` is innermost.

- [ ] **Step 4: Mouse reorder — backward**

Drag the new slot-3's badge (on `A`) up onto slot-1 (`B`). Expected: `A` moves to the top, rows become `A, B, C` again with numbers `1, 2, 3`. Right column reflects.

- [ ] **Step 5: Drop on self is a no-op**

Grab slot 1's badge and release over the same row without moving far. Expected: no state change (the drag might flash briefly if you cross the 4px threshold and return, but `active.id === over.id` short-circuits).

- [ ] **Step 6: Drop outside any row is a no-op**

Grab a badge and drop it far outside the list (e.g., into the right column). Expected: `over === null`, `reorderStyleIds` returns null, no state change.

- [ ] **Step 7: Keyboard reorder**

Tab until the focus ring lands on a badge button. Press `Space` — the row visually lifts (aria-live announces "picked up"). Press `↓` once or twice — the row moves down. Press `Space` — drop. The store updates; right column refreshes. Press `Esc` while a row is picked up — the drag cancels with no state change.

- [ ] **Step 8: Single-style case**

Untick all but one style. Open the preview. The single ticked row is draggable but has nothing to reorder against; dropping on self is a no-op.

- [ ] **Step 9: Cross-check the form**

After reordering inside the preview, close the modal. Open the `Стиль` dropdown. Expected: the ticked rows show numbers matching the new order; the trigger's `A + B + C` label reflects the new order too.

- [ ] **Step 10: Cross-check a submit**

With a reordered selection, submit a generation. Open DevTools Network panel → inspect the POST body to `/api/generate/*`. Expected: the `styleIds` array in the body mirrors the reordered list. The `prompt` field (result of `composeFinalPrompt`) reflects the new matryoshka wrapping.

- [ ] **Step 11: Unticked rows stay static**

Confirm that rows without a number (unticked styles) remain non-draggable — their cursor does not become `grab`, and attempting to drag does nothing. Click still ticks them.

- [ ] **Step 12: Mobile touch (DevTools emulation)**

In DevTools, toggle device emulation (any mobile device). Open the preview, tick 3 styles, and drag a badge with the touch emulator. Expected: drag works — `PointerSensor` handles both mouse and touch.

- [ ] **Step 13: No-commit unless an issue surfaced**

If everything works, close this task. If you find a bug, fix it in a focused commit like `fix(prompt-preview): <what was wrong>`.
