# Prompt Preview — Indent & Color Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make matryoshka nesting visually obvious by indenting right-column preview blocks by depth, and tint left-column ticked rows with the same colour the style uses in the right column.

**Architecture:** Raw `depth: number` is computed in `buildPreviewBlocks` and attached to every `PreviewBlock`. The dialog clamps with a 5-level cap and applies `marginLeft = Math.min(depth, 5) * 12px` as inline style to each card in the right column. In the left column, a `colorIndexById: Map<id, int>` is computed once per render and passed into `SortableStyleRow`, which gets a new `colorIndex` prop driving both a 4px absolutely-positioned left bar and the number-badge background via `STYLE_COLORS`.

**Tech Stack:** TypeScript, React 19, Next.js 15, vitest, Tailwind CSS, @dnd-kit (already wired).

**Spec:** `docs/superpowers/specs/2026-04-17-prompt-preview-indent-and-color-design.md`

**Execution notes:**
- Run tests from the repo root: `npm test -- <path>` (`vitest run` script).
- Commit after each task. Message style matches prior commits this session (`feat(prompt-preview): …`, `style(prompt-preview): …`).
- Never skip hooks. Never `--no-verify`.

---

## File Structure

**Modify:**
- `lib/styles/preview.ts` — add `depth: number` to `PreviewBlock`; compute and thread depth through `buildPreviewBlocks`.
- `lib/styles/__tests__/preview.test.ts` — new depth assertions + update existing strict-equality expected literals to include `depth`.
- `components/prompt-preview-dialog.tsx` — right-column `marginLeft` via `style` prop; `colorIndexById` useMemo; `SortableStyleRow` accepts `colorIndex` and renders a coloured bar + recoloured badge.

**Unchanged:**
- `lib/styles/classify.ts`, `lib/styles/inject.ts`, `lib/styles/reorder.ts`.
- `components/__tests__/prompt-preview-dialog-merge.test.ts`.
- `STYLE_COLORS` palette entries.
- Admin UI, store, history, generation routes.

---

## Task 1: `depth` on `PreviewBlock` + `buildPreviewBlocks` computation

**Files:**
- Modify: `lib/styles/preview.ts`
- Modify: `lib/styles/__tests__/preview.test.ts`

- [ ] **Step 1: Write the failing tests for the new depth field**

Append inside the existing `describe("buildPreviewBlocks", ...)` block, before the final closing `});`:

```ts
  it("zero styles: prompt block has depth 1 even with no matryoshka", () => {
    const blocks = buildPreviewBlocks("a cat", []);
    expect(blocks).toEqual<PreviewBlock[]>([
      { kind: "prompt", text: "a cat", depth: 1 },
    ]);
  });

  it("one wrap style: prefix depth 1, prompt depth 2, suffix depth 1", () => {
    const w = style({ id: "w", name: "W", prefix: "P", suffix: "S" });
    const blocks = buildPreviewBlocks("x", [w]);
    expect(blocks.map((b) => [b.kind, b.depth])).toEqual([
      ["prefix", 1],
      ["prompt", 2],
      ["suffix", 1],
    ]);
  });

  it("three wrap styles: diamond depths 1,2,3, prompt 4, then 3,2,1", () => {
    const a = style({ id: "a", name: "A", prefix: "PA", suffix: "SA" });
    const b = style({ id: "b", name: "B", prefix: "PB", suffix: "SB" });
    const c = style({ id: "c", name: "C", prefix: "PC", suffix: "SC" });
    const blocks = buildPreviewBlocks("x", [a, b, c]);
    expect(blocks.map((b) => [b.kind, b.styleId ?? "_", b.depth])).toEqual([
      ["prefix", "a", 1],
      ["prefix", "b", 2],
      ["prefix", "c", 3],
      ["prompt", "_", 4],
      ["suffix", "c", 3],
      ["suffix", "b", 2],
      ["suffix", "a", 1],
    ]);
  });

  it("attach blocks are always depth 0; wrap depths unaffected by attach", () => {
    const pre = style({ id: "p", name: "P", prefix: "PRE", suffix: "" });
    const w = style({ id: "w", name: "W", prefix: "PW", suffix: "SW" });
    const neg = style({ id: "n", name: "N", prefix: "", suffix: "NEG" });
    const blocks = buildPreviewBlocks("x", [pre, w, neg]);
    expect(blocks.map((b) => [b.kind, b.styleId ?? "_", b.depth])).toEqual([
      ["prefix", "p", 0],
      ["prefix", "w", 1],
      ["prompt", "_", 2],
      ["suffix", "w", 1],
      ["suffix", "n", 0],
    ]);
  });

  it("only attach styles: wrap absent → attach at 0, prompt at 1", () => {
    const pre = style({ id: "p", name: "P", prefix: "PRE", suffix: "" });
    const neg = style({ id: "n", name: "N", prefix: "", suffix: "NEG" });
    const blocks = buildPreviewBlocks("x", [pre, neg]);
    expect(blocks.map((b) => [b.kind, b.styleId ?? "_", b.depth])).toEqual([
      ["prefix", "p", 0],
      ["prompt", "_", 1],
      ["suffix", "n", 0],
    ]);
  });
```

- [ ] **Step 2: Run the tests to verify the new cases fail**

Run: `npm test -- lib/styles/__tests__/preview.test.ts`

Expected: FAIL. Specifically the 5 new cases compile but fail on `.depth` being `undefined` (or TypeScript complains at the first strict-equality test because the expected literal has a `depth` key that's not on the current `PreviewBlock` type).

- [ ] **Step 3: Add `depth: number` to `PreviewBlock`**

Open `lib/styles/preview.ts`. Change the `PreviewBlock` interface from:

```ts
export interface PreviewBlock {
  kind: "prefix" | "suffix" | "prompt";
  styleId?: string;
  styleName?: string;
  colorIndex?: number;
  text: string;
}
```

to:

```ts
export interface PreviewBlock {
  kind: "prefix" | "suffix" | "prompt";
  styleId?: string;
  styleName?: string;
  colorIndex?: number;
  depth: number;
  text: string;
}
```

- [ ] **Step 4: Update `buildPreviewBlocks` to thread `depth` through**

Replace the body of `buildPreviewBlocks` (keep imports and `STYLE_COLORS` untouched):

```ts
export function buildPreviewBlocks(
  prompt: string,
  activeStyles: readonly Style[]
): PreviewBlock[] {
  const { attachPrefix, wrap, attachSuffix } = partitionStyles(activeStyles);
  const indexOf = new Map(activeStyles.map((s, i) => [s.id, i]));
  const blocks: PreviewBlock[] = [];
  const promptDepth = wrap.length + 1;

  const push = (
    kind: "prefix" | "suffix",
    s: Style,
    depth: number,
    raw: string
  ) => {
    blocks.push({
      kind,
      styleId: s.id,
      styleName: s.name,
      colorIndex: (indexOf.get(s.id) ?? 0) % STYLE_COLORS.length,
      depth,
      text: softTrim(raw),
    });
  };

  for (const s of attachPrefix) push("prefix", s, 0, s.prefix);
  for (let i = 0; i < wrap.length; i++) push("prefix", wrap[i], i + 1, wrap[i].prefix);
  blocks.push({ kind: "prompt", depth: promptDepth, text: prompt });
  for (let i = wrap.length - 1; i >= 0; i--) push("suffix", wrap[i], i + 1, wrap[i].suffix);
  for (const s of attachSuffix) push("suffix", s, 0, s.suffix);

  return blocks;
}
```

Changes:
- `push` gains a `depth` param (third).
- Computed `promptDepth = wrap.length + 1`.
- Attach-zone pushes pass `0`.
- Wrap-zone pushes pass `i + 1`.
- Prompt block literal gains `depth: promptDepth`.

- [ ] **Step 5: Update the 5 existing strict-equality tests to include `depth`**

Five existing tests in `lib/styles/__tests__/preview.test.ts` use `.toEqual<PreviewBlock[]>(...)` with explicit block literals. Each needs `depth` added to match the new required field. Update each as follows.

**Test at lines ~18-23 — "zero styles returns a single prompt block":**

Change from:
```ts
    expect(blocks).toEqual<PreviewBlock[]>([
      { kind: "prompt", text: "a cat" },
    ]);
```
to:
```ts
    expect(blocks).toEqual<PreviewBlock[]>([
      { kind: "prompt", text: "a cat", depth: 1 },
    ]);
```

**Test at lines ~25-28 — "zero styles with empty prompt":**

Change from:
```ts
    expect(blocks).toEqual<PreviewBlock[]>([{ kind: "prompt", text: "" }]);
```
to:
```ts
    expect(blocks).toEqual<PreviewBlock[]>([{ kind: "prompt", text: "", depth: 1 }]);
```

**Test at lines ~30-38 — "single style with prefix and suffix":**

Change from:
```ts
    expect(blocks).toEqual<PreviewBlock[]>([
      { kind: "prefix", styleId: "k", styleName: "Kino", colorIndex: 0, text: "cinematic" },
      { kind: "prompt", text: "a cat" },
      { kind: "suffix", styleId: "k", styleName: "Kino", colorIndex: 0, text: "35mm" },
    ]);
```
to:
```ts
    expect(blocks).toEqual<PreviewBlock[]>([
      { kind: "prefix", styleId: "k", styleName: "Kino", colorIndex: 0, text: "cinematic", depth: 1 },
      { kind: "prompt", text: "a cat", depth: 2 },
      { kind: "suffix", styleId: "k", styleName: "Kino", colorIndex: 0, text: "35mm", depth: 1 },
    ]);
```

**Test at lines ~40-47 — "empty prefix (whitespace only, post-softTrim) is omitted; suffix still appears":**

Under the attach-zones semantics (shipped in Task 3 of the previous plan), a style with empty prefix + non-empty suffix is `attach-suffix`. So wrap is empty (`wrap.length = 0`), promptDepth = 1, attach-suffix depth = 0.

Change from:
```ts
    expect(blocks).toEqual<PreviewBlock[]>([
      { kind: "prompt", text: "a cat" },
      { kind: "suffix", styleId: "k", styleName: "Kino", colorIndex: 0, text: "35mm" },
    ]);
```
to:
```ts
    expect(blocks).toEqual<PreviewBlock[]>([
      { kind: "prompt", text: "a cat", depth: 1 },
      { kind: "suffix", styleId: "k", styleName: "Kino", colorIndex: 0, text: "35mm", depth: 0 },
    ]);
```

**Test at lines ~49-58 — "style with both prefix and suffix empty contributes no tiles":**

Empty style is dropped; Kino is wrap. `wrap.length = 1`, so Kino prefix depth 1, prompt depth 2, Kino suffix depth 1. Kino's `colorIndex` is its `activeStyles` position (1, since empty is at 0), which is already reflected in the pre-existing expected literal.

Change from:
```ts
    expect(blocks).toEqual<PreviewBlock[]>([
      { kind: "prefix", styleId: "k", styleName: "Kino", colorIndex: 1, text: "cinematic" },
      { kind: "prompt", text: "a cat" },
      { kind: "suffix", styleId: "k", styleName: "Kino", colorIndex: 1, text: "35mm" },
    ]);
```
to:
```ts
    expect(blocks).toEqual<PreviewBlock[]>([
      { kind: "prefix", styleId: "k", styleName: "Kino", colorIndex: 1, text: "cinematic", depth: 1 },
      { kind: "prompt", text: "a cat", depth: 2 },
      { kind: "suffix", styleId: "k", styleName: "Kino", colorIndex: 1, text: "35mm", depth: 1 },
    ]);
```

No other existing test needs a change (all others use `.map(b => [...])` tuple subsets, `.toMatchObject`, or `.find` + field reads — none assert on the full block shape).

- [ ] **Step 6: Run the preview suite to verify everything passes**

Run: `npm test -- lib/styles/__tests__/preview.test.ts`

Expected: PASS on all cases — 9 existing (5 updated + 4 untouched) + 5 new = 14 tests green.

- [ ] **Step 7: Run the full lib/styles suite to confirm no regressions**

Run: `npm test -- lib/styles`

Expected: PASS. Classify, inject, preview, and any other suites in `lib/styles/__tests__/` all green.

- [ ] **Step 8: Commit**

```bash
git add lib/styles/preview.ts lib/styles/__tests__/preview.test.ts
git commit -m "$(cat <<'EOF'
feat(styles): add depth to PreviewBlock for matryoshka indent

Each PreviewBlock now carries a raw depth: 0 for attach-prefix and
attach-suffix, i+1 for wrap at position i, wrap.length+1 for the
prompt. This is a view-agnostic number; the dialog caps and scales
it into pixels. Existing strict-equality tests updated to include
the new field; five new tests lock in depth values for the
single-wrap, three-wrap, mixed-zone, and no-wrap cases.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: Right-column indent via `marginLeft`

**Files:**
- Modify: `components/prompt-preview-dialog.tsx`

No new unit tests. Visual change, covered by Task 4 manual verification.

- [ ] **Step 1: Add indent constants above `PromptPreviewDialog`**

In `components/prompt-preview-dialog.tsx`, near the existing `ZONE_META` constant (above `PromptPreviewDialog`), add:

```ts
const MAX_INDENT_DEPTH = 5;
const INDENT_PX_PER_LEVEL = 12;
```

- [ ] **Step 2: Apply `marginLeft` to the prompt card**

Find the prompt-card rendering inside the right column's `blocks.map(...)` (the `if (blk.kind === "prompt") { ... }` branch). It currently looks like:

```tsx
return (
  <div
    key="prompt"
    className="rounded-md border border-primary/40 bg-primary/5 p-2"
  >
    ...
  </div>
);
```

Compute `indentPx` just above the `return`, and apply `style`:

```tsx
if (blk.kind === "prompt") {
  const empty = blk.text.trim().length === 0;
  const indentPx = Math.min(blk.depth, MAX_INDENT_DEPTH) * INDENT_PX_PER_LEVEL;
  return (
    <div
      key="prompt"
      className="rounded-md border border-primary/40 bg-primary/5 p-2"
      style={{ marginLeft: indentPx }}
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
```

- [ ] **Step 3: Apply `marginLeft` to the prefix/suffix cards**

Below the prompt branch, the prefix/suffix card rendering currently looks like:

```tsx
const color =
  STYLE_COLORS[blk.colorIndex! % STYLE_COLORS.length];
return (
  <div
    key={`${blk.kind}:${blk.styleId}`}
    className="flex gap-2 rounded-md border border-border bg-muted/20 p-2"
  >
    ...
  </div>
);
```

Compute `indentPx` right next to the `color` computation and apply `style`:

```tsx
const color =
  STYLE_COLORS[blk.colorIndex! % STYLE_COLORS.length];
const indentPx = Math.min(blk.depth, MAX_INDENT_DEPTH) * INDENT_PX_PER_LEVEL;
return (
  <div
    key={`${blk.kind}:${blk.styleId}`}
    className="flex gap-2 rounded-md border border-border bg-muted/20 p-2"
    style={{ marginLeft: indentPx }}
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
```

Do not change anything else in the card. Left-bar, body, typography — all unchanged.

- [ ] **Step 4: Verify the file still compiles and existing tests pass**

Run: `npm test`

Expected: full suite still green (no test should regress — no test file touches this render path).

Run: `npx tsc --noEmit -p tsconfig.json`

Expected: 0 errors.

- [ ] **Step 5: Commit**

```bash
git add components/prompt-preview-dialog.tsx
git commit -m "$(cat <<'EOF'
feat(prompt-preview): indent right-column blocks by matryoshka depth

Each card in the right column now shifts marginLeft by
min(depth, 5) * 12px. Attach blocks stay flush (depth 0); wrap
prefixes indent 12px per slot; the prompt sits one level deeper than
the innermost wrap; wrap suffixes unwind back out. The matryoshka
shape is now obvious at a glance instead of something you have to
read off the style names and colours.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: Left-column coloured badge + left bar

**Files:**
- Modify: `components/prompt-preview-dialog.tsx`

No new unit tests. Visual change covered by Task 4.

- [ ] **Step 1: Add `colorIndexById` memo inside `PromptPreviewDialog`**

Near the existing `partitioned` useMemo, add:

```ts
const colorIndexById = React.useMemo(
  () =>
    new Map(
      activeStyles.map((s, i) => [s.id, i % STYLE_COLORS.length])
    ),
  [activeStyles]
);
```

`STYLE_COLORS` is already imported from `@/lib/styles/preview` — no import change needed.

- [ ] **Step 2: Add `colorIndex: number` prop to `SortableStyleRow`**

Find the `interface StyleRowProps { style: Style; onToggle: () => void; }` near the top of the file and leave it as-is — `PlainStyleRow` keeps taking `StyleRowProps`, unchanged.

Change `SortableStyleRow`'s signature from:

```tsx
function SortableStyleRow({
  style,
  order,
  onToggle,
}: StyleRowProps & { order: number }) {
```

to:

```tsx
function SortableStyleRow({
  style,
  order,
  colorIndex,
  onToggle,
}: StyleRowProps & { order: number; colorIndex: number }) {
```

- [ ] **Step 3: Rewrite `SortableStyleRow`'s markup to render the coloured bar + recoloured badge**

Replace the body of `SortableStyleRow`'s `return` with:

```tsx
  return (
    <button
      type="button"
      ref={setNodeRef}
      style={dragStyle}
      onClick={onToggle}
      {...attributes}
      {...listeners}
      role="menuitemcheckbox"
      aria-checked={true}
      aria-label={`Снять стиль ${style.name}, позиция ${order}. Потяни чтобы изменить порядок`}
      title="Клик — снять стиль. Потяни — изменить порядок."
      className={cn(
        "relative flex items-center gap-1 rounded-md bg-primary/5 text-left transition-colors cursor-grab hover:bg-accent hover:text-accent-foreground active:cursor-grabbing",
        isDragging && "z-10 opacity-50"
      )}
    >
      <span
        aria-hidden
        className={cn(
          "absolute inset-y-0 left-0 w-1 rounded-l-md",
          STYLE_COLORS[colorIndex]
        )}
      />
      <span
        className={cn(
          "ml-2 flex h-6 w-6 shrink-0 items-center justify-center rounded text-[11px] font-semibold text-white",
          STYLE_COLORS[colorIndex]
        )}
      >
        {order}
      </span>
      <span className="min-w-0 flex-1 truncate px-2 py-1.5 text-sm">
        {style.name}
      </span>
    </button>
  );
```

Changes summary:
- Outer button gains `relative`.
- New `<span aria-hidden>` — absolutely-positioned 4px-wide bar on the left edge, coloured via `STYLE_COLORS[colorIndex]`.
- Badge `<span>` changes from `ml-1 ... border border-primary bg-primary text-primary-foreground` to `ml-2 ... text-white` + `STYLE_COLORS[colorIndex]`. `ml-2` clears the 4px bar.
- Name `<span>` unchanged.

`PlainStyleRow` is **not** modified — unticked rows stay neutral.

- [ ] **Step 4: Pass `colorIndex` into each `SortableStyleRow` call site**

In the three-zone loop inside the return (inside the `zones.map(zone => ...)`), find the `zoneStyles.map((s, i) => <SortableStyleRow ... />)` block. Currently:

```tsx
{zoneStyles.map((s, i) => (
  <SortableStyleRow
    key={s.id}
    style={s}
    order={i + 1}
    onToggle={() => toggle(s.id)}
  />
))}
```

Change to:

```tsx
{zoneStyles.map((s, i) => (
  <SortableStyleRow
    key={s.id}
    style={s}
    order={i + 1}
    colorIndex={colorIndexById.get(s.id) ?? 0}
    onToggle={() => toggle(s.id)}
  />
))}
```

- [ ] **Step 5: Run tests + typecheck + build**

Run: `npm test`

Expected: full suite green.

Run: `npx tsc --noEmit -p tsconfig.json`

Expected: 0 errors. If TypeScript complains that `colorIndex` isn't part of `StyleRowProps`, re-check Step 2 — the prop is added only to `SortableStyleRow`'s signature (via the `& { order: number; colorIndex: number }` intersection), not to the shared `StyleRowProps` interface.

Run: `npm run build`

Expected: clean Next.js build.

- [ ] **Step 6: Commit**

```bash
git add components/prompt-preview-dialog.tsx
git commit -m "$(cat <<'EOF'
feat(prompt-preview): colour ticked rows to match right-column palette

SortableStyleRow gains a colorIndex prop. A 4px absolutely-positioned
bar on the left edge and the number badge both use STYLE_COLORS[idx].
colorIndex tracks position in activeStyles, so the same style shows
the same colour in both columns — left-right visual link 1:1.
PlainStyleRow stays neutral (colour is a "you picked this" signal).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: Manual browser verification

**No file changes.** End-to-end verification in a real browser. Covers both this plan's changes and the still-pending verification from the attach-zones plan (they share the same preview modal).

- [ ] **Step 1: Start the dev server**

In a separate terminal: `npm run dev`

Expected: Next.js boots at `http://localhost:3000` (or `http://192.168.88.76:3000` on LAN).

- [ ] **Step 2: Prepare styles in admin**

Open the admin styles page. Create (or confirm existence of) five styles:

- `Cinematic` — prefix `cinematic shot,`, suffix `shot on 35mm film`.
- `Dramatic` — prefix `dramatic lighting,`, suffix `high contrast`.
- `Storm` — prefix `storm clouds,`, suffix `lightning crackling`.
- `HeaderOnly` — prefix `[STYLE GUIDE:\n`, suffix empty.
- `NegativeOnly` — prefix empty, suffix `--negative low quality, blurry, watermark`.

- [ ] **Step 3: Verify indent with three wrap styles**

On the form: tick `Cinematic`, `Dramatic`, `Storm` in that order. Enter `a cat` as the prompt. Open the preview modal.

Expected in the right column (read top-to-bottom):
- `Cinematic` prefix — flush-ish (12px from container edge).
- `Dramatic` prefix — indented 24px.
- `Storm` prefix — indented 36px.
- `Промпт` card — indented 48px (deepest).
- `Storm` suffix — 36px.
- `Dramatic` suffix — 24px.
- `Cinematic` suffix — 12px.

Visual result should read as a clear diamond. Each pair of prefix/suffix for a given wrap is at the same horizontal offset.

- [ ] **Step 4: Verify attach blocks are flush and wrap/prompt still indent**

Untick nothing; add `HeaderOnly` (attach-prefix) and `NegativeOnly` (attach-suffix). Open preview again.

Expected in the right column:
- `HeaderOnly` prefix — `marginLeft: 0` (flush with container edge).
- `Cinematic` prefix — 12px.
- `Dramatic` prefix — 24px.
- `Storm` prefix — 36px.
- `Промпт` — 48px.
- `Storm` suffix — 36px.
- `Dramatic` suffix — 24px.
- `Cinematic` suffix — 12px.
- `NegativeOnly` suffix — 0px (flush again).

- [ ] **Step 5: Verify 7-wrap cap**

Create two more wrap styles (`Extra1`, `Extra2` with prefix + suffix both filled) in admin. Tick 7 wraps total. Open preview.

Expected: slots 1–5 indent at 12/24/36/48/60px. Slot 6 and slot 7 both indent at 60px (cap). Prompt indents at 60px (depth 8, capped to 5 × 12 = 60px). Wrap suffixes unwind: slot 7 at 60, slot 6 at 60, slot 5 at 60, slot 4 at 48, etc. No horizontal overflow, no broken layout.

Untick the extras after verifying.

- [ ] **Step 6: Verify left-column colours**

Tick `Cinematic`, `Dramatic`, `NegativeOnly` in order. Open preview.

Expected in the left column:
- `Cinematic` row — sky-500 (blue) bar on its left edge, sky-500 number badge showing `1`.
- `Dramatic` row — violet-500 bar, violet-500 badge showing `2`.
- `NegativeOnly` row — amber-500 bar (third colour), amber-500 badge showing `1` (because it's `1` within the «В конец» zone).
- Unticked `HeaderOnly`, `Storm`, etc. — no bar, empty neutral badge square.

- [ ] **Step 7: Verify left-right colour correspondence**

With the same selection: check that the right column's cards for `Cinematic` show a sky-500 left bar; `Dramatic` cards a violet-500 bar; `NegativeOnly` card an amber-500 bar. Colours match 1:1 with the left column.

- [ ] **Step 8: Verify reorder drag keeps colours stable**

Drag `Cinematic` below `Dramatic` inside the «Обёртка» zone. Expected:
- Right column re-renders on release.
- `Dramatic` is now the outermost wrap (12px indent, colour stays violet — its `activeStyles` position is now 0, but the palette rotates with position, so its colour becomes sky-500).

Wait — re-read spec §Architecture. `colorIndexById` is `activeStyles.map((s, i) => [s.id, i % 6])`. So after reorder, `Dramatic` is at index 0 → sky-500; `Cinematic` at index 1 → violet-500. Colours swap with the reorder. This is expected: colour tracks position, not identity. Verify both columns reflect the swap consistently.

If you expected colour to stay bound to style identity across reorders, STOP and report — we'd need to reshape the colour-assignment logic. But the plan is explicit: colour follows position.

- [ ] **Step 9: Verify drag-in-attach-zone doesn't shift colours of non-attach styles**

Add a second suffix-only style (`ExtraTags`, prefix empty + suffix `masterpiece, 4k`). Tick it after `NegativeOnly`. Drag inside «В конец» to swap the two attach-suffix styles.

Expected: wrap rows' colours unchanged; attach-suffix rows swap their positions in `activeStyles`, so their colours swap too. Same rule as Step 8, zone-local.

- [ ] **Step 10: Verify the prompt-only case**

Untick every style. Open preview.

Expected: only the Промпт card renders, indented 12px from the container edge (depth 1, the "always indent prompt" rule). Left column shows all styles as unticked `PlainStyleRow`s with no colour.

- [ ] **Step 11: Close the dev server**

Stop the `npm run dev` process (Ctrl+C).

No commit — this task is verification only.

If any step fails, return to the failing task and fix. Common categories:
- Wrong indent values → check the `Math.min(blk.depth, MAX_INDENT_DEPTH) * INDENT_PX_PER_LEVEL` expression in both right-column card renderers.
- Missing/mismatched colours → check `colorIndexById` construction and the prop threading into `SortableStyleRow`.
- Bar covers text → verify `ml-2` on the badge and the name `<span>`'s padding are enough to clear a 4px bar.
- Right-column colour doesn't swap on reorder → confirm `buildPreviewBlocks` uses `activeStyles`-position for `colorIndex`, not the zone-local index.

---

## Self-Review

**1. Spec coverage:**
- `PreviewBlock.depth` field (spec §Architecture) → Task 1 Step 3.
- Depth computation rule (spec §Decisions #2) → Task 1 Step 4.
- 12px step, cap 5, inline `marginLeft` (spec §Decisions #3-4) → Task 2 Steps 1-3.
- `colorIndexById` map (spec §Dialog — colorIndexById) → Task 3 Step 1.
- `SortableStyleRow` accepts `colorIndex`; coloured left bar + recoloured badge (spec §Left column) → Task 3 Steps 2-3.
- Unticked rows stay neutral (spec §Out of scope) → Task 3 Step 3 (PlainStyleRow not modified).
- `STYLE_COLORS` palette stays single source of truth (spec §Decisions #6) → Tasks 1, 3 both import it from `@/lib/styles/preview`.
- Existing strict-equality test adjustments (spec §Testing, preview.ts audit) → Task 1 Step 5 (5 tests enumerated explicitly).
- Manual verification cases (spec §Testing — manual verification) → Task 4 Steps 3-10.

**2. Placeholder scan:** No `TBD`, `TODO`, `fill in`, or `similar to Task N`. Every step has exact code or commands.

**3. Type consistency:**
- `PreviewBlock.depth: number` (required, not optional) — consistent across Task 1 interface, Task 1 `buildPreviewBlocks`, Task 2 `indentPx` computation (reads `blk.depth`), Task 4 verification.
- `colorIndexById: Map<string, number>` — built in Task 3 Step 1, read in Task 3 Step 4 (`colorIndexById.get(s.id) ?? 0`).
- `SortableStyleRow` signature — extended via intersection type in Task 3 Step 2, matches the Step 4 call sites.
- `MAX_INDENT_DEPTH` / `INDENT_PX_PER_LEVEL` constants — declared in Task 2 Step 1, used in Task 2 Steps 2 and 3. Not referenced outside that component file.
