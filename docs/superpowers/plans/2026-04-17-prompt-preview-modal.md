# Prompt Preview Modal — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a preview button in the `Стиль` label row that opens a modal showing the final composed prompt with colored, structured blocks per style. Styles can be toggled inside the modal with live sync to the form.

**Architecture:** One new pure helper (`buildPreviewBlocks`), one new client component (`PromptPreviewDialog`), a tiny edit to `composeFinalPrompt`'s module to export `softTrim`, and a wiring change in `generate-form.tsx`. The dialog reads live from `useSettingsStore` and `usePromptStore` so there is one source of truth — toggles inside the modal propagate straight to the form's dropdown.

**Tech Stack:** Next.js 15, React 19, Tailwind, Radix Dialog, Zustand, Vitest, TypeScript.

**Spec:** `docs/superpowers/specs/2026-04-17-prompt-preview-modal-design.md`

---

## File Structure

**Create:**
- `lib/styles/preview.ts` — pure helper `buildPreviewBlocks`, `PreviewBlock` type, and the `STYLE_COLORS` palette.
- `lib/styles/__tests__/preview.test.ts` — unit tests for `buildPreviewBlocks`.
- `components/prompt-preview-dialog.tsx` — the modal component.

**Modify:**
- `lib/styles/inject.ts` — export `softTrim` (it is currently module-private).
- `components/generate-form.tsx` — change the `Стиль` label row to `flex justify-between`, add the trigger button, mount `PromptPreviewDialog`, track `previewOpen` state.

**Unchanged:** `components/styles-multi-select.tsx`, `stores/*`, `lib/history/*`.

---

## Task 1: Export `softTrim` from `inject.ts`

Small mechanical change so `preview.ts` can apply the exact same whitespace rule as `composeFinalPrompt`.

**Files:**
- Modify: `lib/styles/inject.ts:9-14`
- Modify: `lib/styles/__tests__/inject.test.ts` (add one test asserting the export works)

- [ ] **Step 1: Add a failing test for the `softTrim` export**

In `lib/styles/__tests__/inject.test.ts`, at line 2, change the existing import:

```ts
import { composeFinalPrompt } from "../inject";
```

to:

```ts
import { composeFinalPrompt, softTrim } from "../inject";
```

Then append a new `describe` block at the end of the file, after the closing `});` of `describe("composeFinalPrompt", ...)`:

```ts
describe("softTrim", () => {
  it("is exported and strips horizontal whitespace around newlines and at edges", () => {
    expect(softTrim("  cinematic  \n")).toBe("cinematic\n");
    expect(softTrim("\n 35mm ")).toBe("\n35mm");
    expect(softTrim("line1 \n line2")).toBe("line1\nline2");
  });
});
```

- [ ] **Step 2: Run the test and verify it fails**

Run: `npx vitest run lib/styles/__tests__/inject.test.ts`

Expected: failure with an error about `softTrim` not being exported (e.g. `softTrim is not a function` or a type error).

- [ ] **Step 3: Add `export` to `softTrim` in `lib/styles/inject.ts`**

Change line 9 from:

```ts
function softTrim(s: string): string {
```

to:

```ts
export function softTrim(s: string): string {
```

Nothing else changes in that file.

- [ ] **Step 4: Run the full `inject` test suite and verify everything passes**

Run: `npx vitest run lib/styles/__tests__/inject.test.ts`

Expected: all existing `composeFinalPrompt` tests pass AND the new `softTrim` test passes. No behavior change to `composeFinalPrompt`.

- [ ] **Step 5: Commit**

```bash
git add lib/styles/inject.ts lib/styles/__tests__/inject.test.ts
git commit -m "feat(styles): export softTrim for preview reuse"
```

---

## Task 2: Pure helper `buildPreviewBlocks` (TDD)

The dialog will render a vertical stack of blocks. This helper turns `(prompt, activeStyles)` into an ordered `PreviewBlock[]` that mirrors the matryoshka layout in `composeFinalPrompt`.

**Files:**
- Create: `lib/styles/preview.ts`
- Create: `lib/styles/__tests__/preview.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `lib/styles/__tests__/preview.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { buildPreviewBlocks, STYLE_COLORS, type PreviewBlock } from "../preview";
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

describe("buildPreviewBlocks", () => {
  it("zero styles returns a single prompt block with the raw prompt text", () => {
    const blocks = buildPreviewBlocks("a cat", []);
    expect(blocks).toEqual<PreviewBlock[]>([
      { kind: "prompt", text: "a cat" },
    ]);
  });

  it("zero styles with empty prompt returns one prompt block with empty text", () => {
    const blocks = buildPreviewBlocks("", []);
    expect(blocks).toEqual<PreviewBlock[]>([{ kind: "prompt", text: "" }]);
  });

  it("single style with prefix and suffix returns [prefix, prompt, suffix] with matching colorIndex", () => {
    const s = style({ id: "k", name: "Kino", prefix: "cinematic", suffix: "35mm" });
    const blocks = buildPreviewBlocks("a cat", [s]);
    expect(blocks).toEqual<PreviewBlock[]>([
      { kind: "prefix", styleId: "k", styleName: "Kino", colorIndex: 0, text: "cinematic" },
      { kind: "prompt", text: "a cat" },
      { kind: "suffix", styleId: "k", styleName: "Kino", colorIndex: 0, text: "35mm" },
    ]);
  });

  it("empty prefix (whitespace only, post-softTrim) is omitted; suffix still appears", () => {
    const s = style({ id: "k", name: "Kino", prefix: "  \n \t ", suffix: "35mm" });
    const blocks = buildPreviewBlocks("a cat", [s]);
    expect(blocks).toEqual<PreviewBlock[]>([
      { kind: "prompt", text: "a cat" },
      { kind: "suffix", styleId: "k", styleName: "Kino", colorIndex: 0, text: "35mm" },
    ]);
  });

  it("style with both prefix and suffix empty contributes no tiles", () => {
    const empty = style({ id: "e", name: "Empty", prefix: "", suffix: "" });
    const real = style({ id: "k", name: "Kino", prefix: "cinematic", suffix: "35mm" });
    const blocks = buildPreviewBlocks("a cat", [empty, real]);
    // "empty" is index 0 but contributes no tiles; "real" is index 1 → colorIndex 1
    expect(blocks).toEqual<PreviewBlock[]>([
      { kind: "prefix", styleId: "k", styleName: "Kino", colorIndex: 1, text: "cinematic" },
      { kind: "prompt", text: "a cat" },
      { kind: "suffix", styleId: "k", styleName: "Kino", colorIndex: 1, text: "35mm" },
    ]);
  });

  it("three styles — matryoshka order: prefixes 0..N-1, prompt, suffixes N-1..0", () => {
    const a = style({ id: "a", name: "A", prefix: "PA", suffix: "SA" });
    const b = style({ id: "b", name: "B", prefix: "PB", suffix: "SB" });
    const c = style({ id: "c", name: "C", prefix: "PC", suffix: "SC" });
    const blocks = buildPreviewBlocks("x", [a, b, c]);
    expect(blocks.map((b) => [b.kind, b.styleId ?? "_", b.text])).toEqual([
      ["prefix", "a", "PA"],
      ["prefix", "b", "PB"],
      ["prefix", "c", "PC"],
      ["prompt", "_", "x"],
      ["suffix", "c", "SC"],
      ["suffix", "b", "SB"],
      ["suffix", "a", "SA"],
    ]);
  });

  it("three styles — prefix and suffix of the same style share colorIndex", () => {
    const a = style({ id: "a", name: "A", prefix: "PA", suffix: "SA" });
    const b = style({ id: "b", name: "B", prefix: "PB", suffix: "SB" });
    const c = style({ id: "c", name: "C", prefix: "PC", suffix: "SC" });
    const blocks = buildPreviewBlocks("x", [a, b, c]);
    const byId: Record<string, number[]> = {};
    for (const blk of blocks) {
      if (blk.kind === "prompt") continue;
      byId[blk.styleId!] ??= [];
      byId[blk.styleId!].push(blk.colorIndex!);
    }
    expect(byId).toEqual({ a: [0, 0], b: [1, 1], c: [2, 2] });
  });

  it("applies softTrim to prefix/suffix text before rendering", () => {
    const s = style({ id: "k", name: "Kino", prefix: "  cinematic  \n", suffix: "\n 35mm " });
    const blocks = buildPreviewBlocks("a cat", [s]);
    expect(blocks[0]).toMatchObject({ kind: "prefix", text: "cinematic\n" });
    expect(blocks[2]).toMatchObject({ kind: "suffix", text: "\n35mm" });
  });

  it("STYLE_COLORS is a length-6 palette of Tailwind bg-* classes", () => {
    expect(STYLE_COLORS).toHaveLength(6);
    for (const c of STYLE_COLORS) expect(c).toMatch(/^bg-/);
  });

  it("colorIndex beyond palette length wraps (index % 6)", () => {
    // Build seven non-empty styles; the 7th (index 6) should wrap to colorIndex 0.
    const styles = Array.from({ length: 7 }, (_, i) =>
      style({ id: `s${i}`, name: `S${i}`, prefix: `P${i}`, suffix: `S${i}` })
    );
    const blocks = buildPreviewBlocks("x", styles);
    const seventhPrefix = blocks.find((b) => b.kind === "prefix" && b.styleId === "s6");
    expect(seventhPrefix?.colorIndex).toBe(0);
  });
});
```

- [ ] **Step 2: Run the test and verify it fails**

Run: `npx vitest run lib/styles/__tests__/preview.test.ts`

Expected: failure — `lib/styles/preview` does not exist yet (module-not-found error).

- [ ] **Step 3: Implement `buildPreviewBlocks`**

Create `lib/styles/preview.ts`:

```ts
import { softTrim } from "./inject";
import type { Style } from "./types";

export interface PreviewBlock {
  kind: "prefix" | "suffix" | "prompt";
  styleId?: string;
  styleName?: string;
  colorIndex?: number;
  text: string;
}

export const STYLE_COLORS = [
  "bg-sky-500",
  "bg-violet-500",
  "bg-amber-500",
  "bg-emerald-500",
  "bg-rose-500",
  "bg-indigo-500",
] as const;

export function buildPreviewBlocks(
  prompt: string,
  activeStyles: readonly Style[]
): PreviewBlock[] {
  const blocks: PreviewBlock[] = [];

  activeStyles.forEach((s, i) => {
    const trimmed = softTrim(s.prefix ?? "");
    if (/\S/.test(trimmed)) {
      blocks.push({
        kind: "prefix",
        styleId: s.id,
        styleName: s.name,
        colorIndex: i % STYLE_COLORS.length,
        text: trimmed,
      });
    }
  });

  blocks.push({ kind: "prompt", text: prompt });

  for (let i = activeStyles.length - 1; i >= 0; i--) {
    const s = activeStyles[i];
    const trimmed = softTrim(s.suffix ?? "");
    if (/\S/.test(trimmed)) {
      blocks.push({
        kind: "suffix",
        styleId: s.id,
        styleName: s.name,
        colorIndex: i % STYLE_COLORS.length,
        text: trimmed,
      });
    }
  }

  return blocks;
}
```

- [ ] **Step 4: Run the test and verify it passes**

Run: `npx vitest run lib/styles/__tests__/preview.test.ts`

Expected: all nine tests pass.

- [ ] **Step 5: Run the full styles test suite to catch any cross-module regression**

Run: `npx vitest run lib/styles`

Expected: all tests in `inject.test.ts`, `apply-copied.test.ts`, and `preview.test.ts` pass.

- [ ] **Step 6: Commit**

```bash
git add lib/styles/preview.ts lib/styles/__tests__/preview.test.ts
git commit -m "feat(styles): add buildPreviewBlocks helper for prompt preview"
```

---

## Task 3: `PromptPreviewDialog` component

The modal. Reads live from stores, renders two columns (styles list + structured preview), exposes a Copy button. No automated test for this task — the spec's testing plan for the dialog is manual (Task 5), and the pure logic is already covered by Task 2.

**Files:**
- Create: `components/prompt-preview-dialog.tsx`

- [ ] **Step 1: Create the component**

Create `components/prompt-preview-dialog.tsx`:

```tsx
"use client";

import * as React from "react";
import { Copy } from "lucide-react";
import { toast } from "sonner";
import { cn, copyToClipboard } from "@/lib/utils";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { useSettingsStore } from "@/stores/settings-store";
import { usePromptStore } from "@/stores/prompt-store";
import { composeFinalPrompt } from "@/lib/styles/inject";
import { buildPreviewBlocks, STYLE_COLORS } from "@/lib/styles/preview";
import type { Style } from "@/lib/styles/types";

interface PromptPreviewDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  styles: Style[];
}

export function PromptPreviewDialog({
  open,
  onOpenChange,
  styles,
}: PromptPreviewDialogProps) {
  const selectedStyleIds = useSettingsStore((s) => s.selectedStyleIds);
  const setSelectedStyleIds = useSettingsStore((s) => s.setSelectedStyleIds);
  const prompt = usePromptStore((s) => s.prompt);

  const activeStyles = React.useMemo<Style[]>(() => {
    return selectedStyleIds
      .map((id) => styles.find((s) => s.id === id))
      .filter((s): s is Style => s !== undefined);
  }, [styles, selectedStyleIds]);

  const blocks = React.useMemo(
    () => buildPreviewBlocks(prompt, activeStyles),
    [prompt, activeStyles]
  );

  function toggle(id: string) {
    if (selectedStyleIds.includes(id)) {
      setSelectedStyleIds(selectedStyleIds.filter((x) => x !== id));
    } else {
      setSelectedStyleIds([...selectedStyleIds, id]);
    }
  }

  async function copyFinal() {
    const final = composeFinalPrompt(prompt, activeStyles);
    if (final.length === 0) return;
    const ok = await copyToClipboard(final);
    if (ok) toast.success("Финальный промпт скопирован");
    else toast.error("Не удалось скопировать");
  }

  const copyDisabled =
    prompt.trim().length === 0 && activeStyles.length === 0;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-4xl max-h-[85vh] overflow-hidden rounded-lg border border-border bg-background p-5 shadow-xl">
        <DialogTitle>Превью промпта</DialogTitle>

        <div className="grid gap-4 md:grid-cols-[minmax(0,280px)_minmax(0,1fr)] md:max-h-[70vh] md:overflow-hidden">
          {/* Left: styles list */}
          <div className="flex flex-col gap-1 md:overflow-y-auto md:pr-2">
            {styles.length === 0 ? (
              <div className="px-2 py-1.5 text-xs text-muted-foreground">
                Стилей пока нет. Создайте в админке.
              </div>
            ) : (
              styles.map((s) => {
                const idx = selectedStyleIds.indexOf(s.id);
                const checked = idx !== -1;
                const order = checked ? idx + 1 : null;
                return (
                  <button
                    key={s.id}
                    type="button"
                    onClick={() => toggle(s.id)}
                    className={cn(
                      "flex min-w-0 items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm transition-colors hover:bg-accent hover:text-accent-foreground",
                      checked && "bg-primary/5"
                    )}
                    role="menuitemcheckbox"
                    aria-checked={checked}
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
            {selectedStyleIds.length > 3 && (
              <div className="mt-1 px-2 text-[11px] text-muted-foreground">
                ⚠ Больше 3 стилей — может выйти невнятный промпт
              </div>
            )}
          </div>

          {/* Right: structured preview */}
          <div className="flex min-w-0 flex-col md:overflow-hidden">
            <div className="mb-2 flex items-center justify-between">
              <div className="text-xs font-medium text-muted-foreground">
                Итоговый промпт
              </div>
              <button
                type="button"
                onClick={copyFinal}
                disabled={copyDisabled}
                title="Скопировать финальный промпт"
                aria-label="Скопировать финальный промпт"
                className="flex h-7 w-7 items-center justify-center rounded text-muted-foreground/70 transition-colors hover:bg-accent hover:text-foreground disabled:pointer-events-none disabled:opacity-40"
              >
                <Copy className="h-3.5 w-3.5" />
              </button>
            </div>

            <div className="flex min-w-0 flex-col gap-2 md:overflow-y-auto md:pr-1">
              {blocks.map((blk, i) => {
                if (blk.kind === "prompt") {
                  const empty = blk.text.trim().length === 0;
                  return (
                    <div
                      key={i}
                      className="rounded-md border border-primary/40 bg-primary/5 p-2"
                    >
                      <div className="mb-1 text-[11px] font-medium uppercase tracking-wide text-primary">
                        Промпт
                      </div>
                      {empty ? (
                        <div className="font-mono text-xs italic text-muted-foreground">
                          (пустой промпт)
                        </div>
                      ) : (
                        <div className="whitespace-pre-wrap break-words font-mono text-sm text-foreground">
                          {blk.text}
                        </div>
                      )}
                    </div>
                  );
                }

                const color =
                  STYLE_COLORS[blk.colorIndex! % STYLE_COLORS.length];
                return (
                  <div
                    key={i}
                    className="flex gap-2 rounded-md border border-border bg-muted/20 p-2"
                  >
                    <div className={cn("w-1 shrink-0 rounded-sm", color)} />
                    <div className="min-w-0 flex-1">
                      <div className="mb-1 text-[11px] text-muted-foreground">
                        {blk.styleName} · {blk.kind}
                      </div>
                      <div className="whitespace-pre-wrap break-words font-mono text-xs text-muted-foreground">
                        {blk.text}
                      </div>
                    </div>
                  </div>
                );
              })}

              {activeStyles.length === 0 && (
                <div className="px-2 text-[11px] text-muted-foreground">
                  стили не выбраны — промпт уходит как есть
                </div>
              )}
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
```

- [ ] **Step 2: TypeScript + lint check**

Run: `npx tsc --noEmit` and `npm run lint`

Expected: no new errors. If lint complains about unused imports, remove them; if about a hook-deps warning, review carefully — the `useMemo` deps above are correct (`prompt`, `activeStyles`).

- [ ] **Step 3: Commit**

```bash
git add components/prompt-preview-dialog.tsx
git commit -m "feat(styles): add PromptPreviewDialog component"
```

---

## Task 4: Wire trigger button into `generate-form.tsx`

Replace the bare `<Label>` for the `Стиль` row with a flex row that also contains the `👁 Превью` button, and mount the dialog.

**Files:**
- Modify: `components/generate-form.tsx:583-591` (the `Стиль` block) and its imports near the top.

- [ ] **Step 1: Add the state and imports**

Open `components/generate-form.tsx`. Near the other `lucide-react` imports at the top of the file (there is already an import line for lucide icons — e.g. `Sparkles`), add `Eye`:

Before:
```tsx
import { Sparkles /* , ... */ } from "lucide-react";
```
After:
```tsx
import { Sparkles, Eye /* , ... */ } from "lucide-react";
```

(Merge `Eye` into the existing `lucide-react` import — do not create a new import line. If `Eye` is already imported for another reason, skip this sub-step.)

Add the dialog import alongside the other `@/components/...` imports:

```tsx
import { PromptPreviewDialog } from "@/components/prompt-preview-dialog";
```

Inside the `GenerateForm` component body, near the other `React.useState` calls (e.g. right after `const [activeCount, setActiveCount] = React.useState(0);` around line 178), add:

```tsx
const [previewOpen, setPreviewOpen] = React.useState(false);
```

- [ ] **Step 2: Replace the `Стиль` label row**

Find the existing block at `components/generate-form.tsx:583-591`:

```tsx
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

Replace it with:

```tsx
<div className="space-y-1.5">
  <div className="flex items-center justify-between">
    <Label htmlFor="style">Стиль</Label>
    <button
      type="button"
      onClick={() => setPreviewOpen(true)}
      className="flex items-center gap-1 rounded px-1 text-xs text-muted-foreground transition-colors hover:text-foreground"
      aria-label="Открыть превью итогового промпта"
      title="Превью итогового промпта"
    >
      <Eye className="h-3.5 w-3.5" />
      Превью
    </button>
  </div>
  <StylesMultiSelect
    id="style"
    styles={styles}
    selectedIds={selectedStyleIds}
    onChange={setSelectedStyleIds}
  />
</div>
```

- [ ] **Step 3: Mount the dialog**

At the very bottom of the form's returned JSX — inside the top-level `<form>` tag, right before its closing `</form>` (currently at `components/generate-form.tsx:643`) — add:

```tsx
<PromptPreviewDialog
  open={previewOpen}
  onOpenChange={setPreviewOpen}
  styles={styles}
/>
```

Placing it inside the form is safe — the dialog renders in a React portal (see `components/ui/dialog.tsx:36` — `DialogPortal`), so nested form submission is not triggered.

- [ ] **Step 4: TypeScript + lint check**

Run: `npx tsc --noEmit` and `npm run lint`

Expected: no new errors.

- [ ] **Step 5: Commit**

```bash
git add components/generate-form.tsx
git commit -m "feat(generate-form): add prompt preview button in Стиль row"
```

---

## Task 5: Manual verification in the browser

Vitest + tsc do not cover the dialog's visual behavior. Run through this checklist manually before calling the feature done.

**Files:** none

- [ ] **Step 1: Start the dev server**

Run in a separate terminal: `npm run dev`

Wait for `Ready in ...` in the output. Open http://localhost:3000 (or, if the user mentions LAN access, http://192.168.88.76:3000).

- [ ] **Step 2: Verify the trigger button**

- The `Стиль` label row shows `Стиль` on the left and `👁 Превью` on the right.
- Hover on `👁 Превью` makes it darker.
- Dropdown below still spans full width — nothing squished.

- [ ] **Step 3: Open modal with zero styles selected**

- Make sure no styles are ticked in the dropdown.
- Click `👁 Превью`.
- Modal opens. Right column shows the prompt block only (or a placeholder `(пустой промпт)` if prompt is empty) and the hint `стили не выбраны — промпт уходит как есть`.
- Close with `Esc` — modal goes away, selection unchanged.

- [ ] **Step 4: Live toggle test**

- Type a short prompt e.g. `a cat on a rooftop` in the form's `Промпт` textarea.
- Open `👁 Превью`.
- Tick 3 styles one by one from the left column.
- After each tick: right column updates immediately, block order matches matryoshka (prefix 1 on top, prompt in the middle with primary accent, suffix 1 at the bottom), and each style's prefix and suffix tiles share one color.
- Close the modal. Open the main dropdown — the same 3 styles are still ticked in the same order. One source of truth confirmed.

- [ ] **Step 5: Copy button test**

- With 2 styles selected and a prompt typed, click the `Copy` icon in the right column header.
- Toast `Финальный промпт скопирован` appears.
- Paste into a text editor — the pasted text matches exactly what `composeFinalPrompt` produces (matryoshka-wrapped, `\n\n` between stacked styles, single `\n` around the user prompt).
- Clear prompt and untick all styles. Copy button becomes disabled (visually faded, no toast on click).

- [ ] **Step 6: Admin-authored whitespace rendering**

- In the admin panel (`/admin/styles` or wherever styles are edited), pick a style whose prefix ends with `Shift+Enter` (a trailing newline).
- In the form, tick that style only.
- Open the preview. The prefix tile's body preserves the trailing newline (the last line inside the tile is visibly blank). Same rule as `composeFinalPrompt` output in the network panel.

- [ ] **Step 7: Mobile / narrow layout**

- Resize the browser window to ~420px wide (DevTools responsive mode is fine).
- Open the preview. Columns stack vertically: styles on top, preview below.
- No horizontal scroll. Right column content scrolls internally if it overflows the viewport.

- [ ] **Step 8: Empty list edge case**

- If possible, temporarily delete all styles in the admin panel (or if that's disruptive, skip and note it).
- Open the preview: left column shows `Стилей пока нет. Создайте в админке.`, right column shows just the prompt block.

- [ ] **Step 9: Run the full test suite one last time**

Run: `npx vitest run`

Expected: all tests pass. No regressions in `lib/styles`, `lib/history`, or elsewhere.

- [ ] **Step 10: No commit needed unless the manual run uncovered an issue**

If an issue is found, fix it in a dedicated commit with a message like `fix(prompt-preview): <what was wrong>`. If everything works, this task closes without a commit.
