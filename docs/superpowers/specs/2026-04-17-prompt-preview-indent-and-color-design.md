# Prompt Preview — Indent & Color Design

**Date:** 2026-04-17
**Follows:** 2026-04-17-prompt-attach-zones (shipped earlier today)

## Goal

Make the matryoshka nesting legible at a glance. Today the preview's
right column is a flat vertical list of coloured blocks; the
matryoshka semantics are visible only by reading the names and
colours. Visually indent wrap blocks by their nesting depth so the
"doll inside a doll" shape jumps out. In parallel, tint the
left-column ticked-row with the same colour the style uses in the
right column, so the two columns read as one connected view.

## Decisions (brainstorm outcome)

1. **Depth is data, cap is view.** Raw `depth: number` lives on
   `PreviewBlock`; the dialog clamps at render time. Tests assert the
   raw values. Means the data layer stays uncoupled from layout
   constants, and if we ever want a different indent rule we change
   one function in the view.

2. **Indent formula.** Attach-blocks are outside the matryoshka → `depth
   = 0`. Wrap-prefix at wrap-list index `i` gets `depth = i + 1` (slot-1
   = 1, slot-N = N). Wrap-suffix mirrors — `depth = i + 1` for the same
   style. The user prompt is the nugget — one level deeper than the
   innermost wrap → `depth = wrap.length + 1`. With zero wraps the
   prompt still gets `depth = 1` so it visually stands apart from any
   attach blocks; that's intentional — the prompt is always the
   subject of the composition, even when there's no nesting around it.

3. **Indent step: 12px per level, cap at 5.** Concretely
   `Math.min(depth, 5) * 12px`. 12px is enough to read as "one level
   deeper" without burning horizontal space; the cap prevents the
   right column from running out of width when users stack 6+ wraps
   (an anti-pattern we already warn about via the `> 3 styles`
   toast). Beyond 5, blocks stop indenting further and visually stack
   at the same column.

4. **Inline `style={{ paddingLeft }}` over Tailwind classes.** Dynamic
   `pl-{n}` values aren't in the Tailwind JIT's scan unless the exact
   class text is present somewhere. A tiny inline style is the simplest
   path and keeps the cap math next to where it's applied.

5. **Left column gets both a coloured badge and a coloured left bar
   (option C-d from brainstorm).** Strongest visual link to the right
   column. Tinting the whole row was considered and rejected — reads
   as noise when 4+ styles are ticked.

6. **`STYLE_COLORS` palette is the single source of truth.** Both the
   right-column bar, the left-column bar, and the left-column badge
   read from the same six-colour array, keyed by position in
   `activeStyles`. A `Map<id, colorIndex>` is computed once per render
   in the dialog and passed into `SortableStyleRow`. Colour stays
   constant whether the row is in attach-prefix, wrap, or
   attach-suffix — matches the guarantee already locked in by
   `buildPreviewBlocks`.

## Out of scope

- Changes to the right column's colour bar, border, or padding.
- Changes to the prompt block's own card styling (only its
  `paddingLeft` shifts).
- Animations / transitions around indent (static values only).
- Dark-mode tweaks — `STYLE_COLORS` are saturated 500-level and look
  acceptable on both Next.js theme backgrounds already in use.
- Any changes to `composeFinalPrompt`. Depth is a preview-only
  concept; the generated text never encodes indent.
- Unticked row (`PlainStyleRow`) styling — it stays neutral; the
  colour is a "you picked this" signal.

## Architecture

### `PreviewBlock` gains a `depth` field

```ts
export interface PreviewBlock {
  kind: "prefix" | "suffix" | "prompt";
  styleId?: string;
  styleName?: string;
  colorIndex?: number;
  depth: number;        // new, always present
  text: string;
}
```

`depth` is required (not optional) so every block has a
deterministic value the view can trust without null-coalescing.

### `buildPreviewBlocks` computes depth

Pseudocode, applied on top of the existing zone-partitioned emission
order:

```ts
const wrapCount = wrap.length;
const promptDepth = wrapCount + 1;

for (const s of attachPrefix) push("prefix", s, 0, s.prefix);
for (let i = 0; i < wrap.length; i++)
  push("prefix", wrap[i], i + 1, wrap[i].prefix);
blocks.push({ kind: "prompt", depth: promptDepth, text: prompt });
for (let i = wrap.length - 1; i >= 0; i--)
  push("suffix", wrap[i], i + 1, wrap[i].suffix);
for (const s of attachSuffix) push("suffix", s, 0, s.suffix);
```

The inner `push` helper grows one param:
`push(kind, style, depth, raw)`.

### Right column — indent application

Inside the dialog's block renderer (both the prompt card and the
prefix/suffix cards), wrap the existing className with a computed
`style`:

```tsx
const MAX_INDENT_DEPTH = 5;
const INDENT_PX_PER_LEVEL = 12;
const indentPx = Math.min(blk.depth, MAX_INDENT_DEPTH) * INDENT_PX_PER_LEVEL;
// ...
<div
  key={...}
  className="flex gap-2 rounded-md border border-border bg-muted/20 p-2"
  style={{ marginLeft: indentPx }}
>
  ...
</div>
```

`marginLeft` (not `paddingLeft`) because we want the block's own
internal padding to stay constant — it's the block's *position* that
shifts, not its *internal* padding. Left-bar colour and text alignment
inside each block stay identical to before.

The prompt card gets the same treatment:

```tsx
<div
  key="prompt"
  className="rounded-md border border-primary/40 bg-primary/5 p-2"
  style={{ marginLeft: indentPx }}
>
  ...
</div>
```

### Left column — colour via badge + left bar

`SortableStyleRow` gains a `colorIndex: number` prop.

The row stays a single `<button>` (preserves the drag/click unification
shipped in `dc84960`). A coloured bar is absolutely positioned inside
the button, `aria-hidden`:

```tsx
<button
  ref={setNodeRef}
  style={dragStyle}
  onClick={onToggle}
  {...attributes}
  {...listeners}
  role="menuitemcheckbox"
  aria-checked
  aria-label={...}
  title={...}
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
```

Three things changed on the row:

- Container gains `relative` (for the absolutely-positioned bar).
- The ml-1 on the badge becomes ml-2 to clear the 4px left bar.
- The badge drops its `border border-primary bg-primary
  text-primary-foreground` trio for `text-white` + the palette colour
  — a cleaner look that lets the palette carry the identity.

Bar colour and badge colour are both `STYLE_COLORS[colorIndex]`.
Because every palette entry in `STYLE_COLORS` is a Tailwind
`bg-<hue>-500` class, `text-white` has sufficient contrast on all six.

### Dialog — `colorIndexById` map

Computed once per render near the existing `partitioned` memo:

```ts
const colorIndexById = React.useMemo(
  () =>
    new Map(
      activeStyles.map((s, i) => [s.id, i % STYLE_COLORS.length])
    ),
  [activeStyles]
);
```

Passed into each `SortableStyleRow`:

```tsx
<SortableStyleRow
  key={s.id}
  style={s}
  order={i + 1}
  colorIndex={colorIndexById.get(s.id) ?? 0}
  onToggle={() => toggle(s.id)}
/>
```

The `?? 0` is defensive — `activeStyles` is the authoritative source
for what's ticked, and the ticked-row rendering loop only iterates
zones built from `partitionStyles(activeStyles)`, so every id is
always in the map. The fallback guards against a late-arriving
mismatch without crashing.

`STYLE_COLORS` is re-exported from `@/lib/styles/preview` already
(the dialog imports it there). No new module.

## Data flow

```
selectedStyleIds (store)
  → activeStyles (dialog useMemo)
      → colorIndexById: Map<id, int>   (dialog useMemo)
      → partitioned: { attachPrefix, wrap, attachSuffix }  (dialog useMemo)
      → buildPreviewBlocks(...)
          → each block carries depth + colorIndex

left column:
  zones.map(zoneStyles.map(row))
    → SortableStyleRow(colorIndex=colorIndexById.get(s.id))
      → bar + badge tinted via STYLE_COLORS[colorIndex]

right column:
  blocks.map(blk → <card style={{ marginLeft: clamp(depth) * 12 }} />)
    → existing STYLE_COLORS[blk.colorIndex] left bar

user reorders within a zone:
  → selectedStyleIds mutates → activeStyles recomputes → colorIndexById rebuilds
  → all colour/indent reassigns consistently in the same tick
```

No new store state. No new effect. The render path stays one-way.

## Edge cases

- **All-attach selection (no wrap styles).** `wrap.length = 0` → prompt
  depth = 1 → prompt card indents 12px; attach blocks at 0. The
  "always indent the prompt" rule makes the prompt stand out even
  with zero matryoshka.
- **6+ wrap styles.** Depth values up to `wrap.length + 1` still appear
  on `PreviewBlock.depth`; the view clamps at 5 so blocks 6+ stack at
  the same horizontal offset as block 5. Users who do this are
  already outside the recommended 3-style heuristic.
- **Single wrap style + prompt.** Wrap prefix at 1, prompt at 2,
  wrap suffix at 1 — three levels of visible indent, the smallest
  meaningful matryoshka. Visual feedback confirms something happened
  without feeling noisy.
- **Zero styles active.** `activeStyles = []` → `colorIndexById` empty,
  no rows in the left column's ticked zones, right column renders
  only the prompt block at depth 1. The existing "стили не выбраны"
  hint still renders.
- **Style ticked by id is deleted from admin mid-session.**
  `activeStyles`'s `.filter(s => s !== undefined)` guard already
  strips missing ids before they reach either the colour map or the
  block builder. The id lingers in `selectedStyleIds` as a ghost
  until the next toggle or manual cleanup, same as today.
- **7th ticked style wraps around the palette.** `i % STYLE_COLORS.length`
  gives `colorIndex = 0` to style #7, matching `STYLE_COLORS[0]`
  (sky-500). The 1st and 7th styles share a colour — consistent with
  the existing right-column behaviour (test at
  `preview.test.ts:102-109` already locks this in).

## Testing

### Unit — `preview.ts` (extend existing)

`lib/styles/__tests__/preview.test.ts`, new cases:

- single wrap + prompt → prefix depth 1, prompt depth 2, suffix depth 1.
- three wraps + prompt → prefix depths 1,2,3, prompt depth 4, suffix
  depths 3,2,1.
- attach-prefix + wrap + attach-suffix → attach-prefix depth 0, wrap
  prefix depth 1, prompt depth 2, wrap suffix depth 1, attach-suffix
  depth 0.
- zero styles + prompt → prompt depth 1 (load-bearing for the
  "always indent prompt" rule).
- only attach styles → all attach depth 0, prompt depth 1.

All existing preview tests pass unchanged — the `depth` field is a new
property on the block; none of the existing `.toEqual(...)` assertions
mention it, they use `toMatchObject`, partial `.map(b => [...])`
tuples, or only check the fields they care about. **Verify this
before implementation.** If any existing test does a strict
`toEqual({ kind, styleId, styleName, colorIndex, text })` block
literal and asserts equality — those will fail once `depth` is added.
If so, either update to include `depth` in the expected literal or
relax the assertion to `toMatchObject`. Flag it in the plan.

### Manual verification (deferred to after Task 5 of the implementation plan)

- Tick 1 wrap + 1 attach-suffix: preview shows wrap blocks indented
  one level, prompt indented two, attach-suffix flush left.
- Tick 3 wraps: diamond shape is obvious — each wrap prefix indents
  one level further; prompt sits at the deepest indent; wrap suffixes
  unwind back out.
- Tick 7 wraps: indents 1..5 visible, 6 and 7 stack at level 5 (no
  overflow, no layout break).
- Left column: each ticked row shows a 4px coloured bar on its left
  matching the right column's bar for that style; the number badge
  is the same colour; unticked rows unchanged.
- Reorder a wrap up/down: both columns reflect the new positions in
  one render tick; colours track the new positions.
- Add a 7th ticked style: colours wrap (1st and 7th share a colour);
  not a bug, matches existing behaviour.
- Delete a ticked style from admin: row disappears from left column
  on next render; right-column colour indices shift down by one for
  later styles; no stale reference.

## Files

**Modify:**
- `lib/styles/preview.ts` — add `depth: number` to `PreviewBlock`;
  update `buildPreviewBlocks` to thread depth through the inner
  `push` helper and compute the correct value per zone.
- `lib/styles/__tests__/preview.test.ts` — add depth assertions per
  the cases above. Audit existing strict-equality assertions and
  adjust if they would now fail due to the new field.
- `components/prompt-preview-dialog.tsx` — add `colorIndexById`
  useMemo; add `colorIndex: number` prop to `SortableStyleRow`;
  render left bar + recoloured badge; apply `marginLeft` from
  `blk.depth` to each right-column card.

**Unchanged:**
- `lib/styles/classify.ts`, `lib/styles/inject.ts`, `lib/styles/reorder.ts`.
- `components/__tests__/prompt-preview-dialog-merge.test.ts`.
- Admin UI, store, history, composeFinalPrompt output.
- `STYLE_COLORS` palette itself (same six entries).

## Follow-up: colour by identity (2026-04-20)

Decision #6 above was reversed after ship. Colour is now keyed by the
style's position in the full admin `styles` list (identity), not by
the position in `activeStyles` (slot). Motivation: during drag-reorder,
the user wanted to *see* blocks swap — position-keyed colour made the
palette feel static while blocks moved through it. Identity-keyed
colour makes the colours travel with the blocks.

Change is dialog-local (`components/prompt-preview-dialog.tsx`):

- `colorIndexById` is built from `styles` (admin order) instead of
  `activeStyles`.
- Right-column renderer reads colour via
  `colorIndexById.get(blk.styleId!)` instead of `blk.colorIndex`.

`buildPreviewBlocks` and its tests are untouched — `PreviewBlock.colorIndex`
is still emitted by the pure helper (slot-based, as before) but is no
longer consumed by the only production consumer. Leaving it avoids a
test churn for what is a purely visual tweak; a future cleanup can
remove it if/when a second consumer appears.

Palette is still shared across zones. With >6 styles in the admin list
colour collisions can occur — accepted, matches the prior collision
behaviour for >6 *active* styles. `wrap`-zone styles keep the prefix
and suffix blocks on the same colour (both indexed by the same
`styleId`).
