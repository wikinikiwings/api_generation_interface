# Prompt Attach Zones — Design

**Date:** 2026-04-17
**Follows:** 2026-04-17-prompt-styles-drag-reorder (shipped earlier today)

## Goal

Stop forcing one-sided styles (only `prefix` or only `suffix`) through
the matryoshka wrap ordering. A style that is just a trailing tag
("negative prompt", "quality booster") should read as an **append**,
not as a wrap layer — so a user who clicks it last sees it last in
the final text, not nested in the middle of the suffix stack.

## The problem

Current `composeFinalPrompt` treats every active style as a wrap:
slot-1 is outermost (farthest from `userPrompt`), slot-N is innermost
(closest to `userPrompt`). For a style with both `prefix` and `suffix`
this is correct — the wrap nests naturally.

For a style with **only a suffix**, the matryoshka logic inverts the
user's intent. To land the suffix at the very end of the output, the
user has to click it **first** (slot-1 = outermost = last line in the
suffix block). Clicking it last (innermost) puts it right after
`userPrompt`, in the middle of the suffix stack.

Same asymmetry for prefix-only styles, though less painful because
first-click = outermost = top is already natural.

The mental model clash: **wrap styles** feel like layers, **one-sided
styles** feel like attachments. Conflating them into a single
matryoshka array forces the user to reason about positions that don't
match the semantics of their content.

## Decisions (brainstorm outcome)

1. **Classify styles at compose time, not in the data model.** A
   style is a `wrap` if both `prefix` and `suffix` have non-whitespace
   content (after `softTrim`); `attach-prefix` if only `prefix`;
   `attach-suffix` if only `suffix`; `empty` if neither.

   No schema change to `Style`. No admin-side field. Classification is
   derived from what's already in the data.

2. **Attach zones live outside the matryoshka.** `attach-prefix`
   styles stack at the very top in click order; `attach-suffix`
   styles stack at the very bottom in click order. Wrap styles keep
   the existing slot-1-outermost matryoshka in the middle.

3. **Zero store-shape change.** `selectedStyleIds` stays a flat
   ordered array. Classification is a render-time concern in compose
   and preview. Reordering a ticked style still mutates the flat
   array; whether its new position is "inside" or "outside" the
   matryoshka is just a matter of which zone its classification
   lands it in.

4. **`kind` override not added now (YAGNI).** An explicit
   `kind: 'wrap' | 'prefix' | 'suffix'` field on `Style` would let
   admins force behavior that conflicts with the data (e.g. mark a
   wrap-looking style as pure suffix). There is no concrete case for
   this today. If one emerges, adding an optional `kind?` later is a
   backwards-compatible extension — styles without `kind` keep
   auto-classification.

## Out of scope

- Admin-side changes (no new field, no new section, no migration).
- Cross-zone drag in the preview modal (zones are data-driven, not
  position-driven).
- Changes to `composeFinalPrompt`'s separator strategy (`"\n\n"`
  between blocks, `"\n"` around `userPrompt` — unchanged).
- Changes to the colour palette or indexing in the right column.
- Behaviour change for styles active in existing history entries
  (history stores the raw composed prompt, it does not recompose).

## Architecture

### New helper

`lib/styles/classify.ts` (new file):

```ts
import { softTrim } from "./inject";
import type { Style } from "./types";

export type StyleZone =
  | "wrap"
  | "attach-prefix"
  | "attach-suffix"
  | "empty";

export function classifyStyle(style: Style): StyleZone {
  const hasP = /\S/.test(softTrim(style.prefix ?? ""));
  const hasS = /\S/.test(softTrim(style.suffix ?? ""));
  if (hasP && hasS) return "wrap";
  if (hasP) return "attach-prefix";
  if (hasS) return "attach-suffix";
  return "empty";
}

export interface PartitionedStyles {
  attachPrefix: Style[];
  wrap: Style[];
  attachSuffix: Style[];
}

export function partitionStyles(
  styles: readonly Style[]
): PartitionedStyles {
  const out: PartitionedStyles = {
    attachPrefix: [],
    wrap: [],
    attachSuffix: [],
  };
  for (const s of styles) {
    const z = classifyStyle(s);
    if (z === "attach-prefix") out.attachPrefix.push(s);
    else if (z === "wrap") out.wrap.push(s);
    else if (z === "attach-suffix") out.attachSuffix.push(s);
    // "empty" → dropped
  }
  return out;
}
```

Order is preserved from `styles` (which reflects
`selectedStyleIds` click order) → that's how "click order = reading
order inside attach zones" falls out naturally.

### `composeFinalPrompt` rewrite

Same separator policy, new block layout:

```ts
export function composeFinalPrompt(
  userPrompt: string,
  activeStyles: readonly Style[]
): string {
  if (activeStyles.length === 0) return userPrompt;

  const { attachPrefix, wrap, attachSuffix } = partitionStyles(activeStyles);

  const topBlocks: string[] = [
    ...attachPrefix.map((s) => softTrim(s.prefix)),
    ...wrap.map((s) => softTrim(s.prefix)),
  ];

  const bottomBlocks: string[] = [
    ...[...wrap].reverse().map((s) => softTrim(s.suffix)),
    ...attachSuffix.map((s) => softTrim(s.suffix)),
  ];

  if (topBlocks.length === 0 && bottomBlocks.length === 0) return userPrompt;

  const segments: string[] = [];
  if (topBlocks.length > 0) segments.push(topBlocks.join("\n\n"));
  segments.push(userPrompt);
  if (bottomBlocks.length > 0) segments.push(bottomBlocks.join("\n\n"));
  return segments.join("\n");
}
```

Because `attach-prefix` has no suffix and `attach-suffix` has no
prefix, we don't need explicit filtering by kind inside this function
— `partitionStyles` already dropped the empties, and mapping
`s.prefix`/`s.suffix` on the right partition lists only the real
blocks. The `/\S/.test` filter in the old implementation is no longer
needed at this layer.

### `buildPreviewBlocks` rewrite

```ts
export function buildPreviewBlocks(
  prompt: string,
  activeStyles: readonly Style[]
): PreviewBlock[] {
  const { attachPrefix, wrap, attachSuffix } = partitionStyles(activeStyles);
  const indexOf = new Map(activeStyles.map((s, i) => [s.id, i]));

  const blocks: PreviewBlock[] = [];

  for (const s of attachPrefix) {
    blocks.push(block("prefix", s, indexOf.get(s.id)!, s.prefix));
  }
  for (const s of wrap) {
    blocks.push(block("prefix", s, indexOf.get(s.id)!, s.prefix));
  }
  blocks.push({ kind: "prompt", text: prompt });
  for (let i = wrap.length - 1; i >= 0; i--) {
    const s = wrap[i];
    blocks.push(block("suffix", s, indexOf.get(s.id)!, s.suffix));
  }
  for (const s of attachSuffix) {
    blocks.push(block("suffix", s, indexOf.get(s.id)!, s.suffix));
  }

  return blocks;

  function block(
    kind: "prefix" | "suffix",
    s: Style,
    originalIdx: number,
    raw: string
  ): PreviewBlock {
    return {
      kind,
      styleId: s.id,
      styleName: s.name,
      colorIndex: originalIdx % STYLE_COLORS.length,
      text: softTrim(raw),
    };
  }
}
```

`colorIndex` stays pegged to the style's position in `activeStyles`
so the same style keeps its colour regardless of which zone it's in.

### Preview modal — three left-column zones

`components/prompt-preview-dialog.tsx` picks up `partitionStyles` and
renders the ticked list as three sections:

- **В начало** — `attachPrefix` (caption: «перед всем»)
- **Обёртка** — `wrap` (caption: «матрёшка вокруг промта»)
- **В конец** — `attachSuffix` (caption: «после всего»)

Each section is its own `<SortableContext>` with its subset of ids.
Unticked styles render below all three sections as a plain list, as
today.

Empty zones are hidden entirely (no header, no caption) so the
modal stays compact when the user's selection spans only one or two
zones.

`handleDragEnd` needs a small tweak: the subset-to-flat-array merge.
Given a drop in, say, the wrap zone, we reorder just the `wrap`
subset using `arrayMove`, then write the result back into
`selectedStyleIds` by replacing the positions that originally held
wrap styles, preserving attach-prefix and attach-suffix positions.

```ts
function mergeZoneReorder(
  flat: readonly string[],
  zoneIds: readonly string[],  // the full current subset, in flat-order
  reorderedZoneIds: readonly string[]
): string[] {
  const zoneSet = new Set(zoneIds);
  const iter = reorderedZoneIds[Symbol.iterator]();
  return flat.map((id) => (zoneSet.has(id) ? iter.next().value! : id));
}
```

Cross-zone drags are impossible: each zone is a separate
`SortableContext`, @dnd-kit only fires drop events within a single
context unless explicitly configured otherwise.

`SortableStyleRow` and `PlainStyleRow` are unchanged — they take
`style` + `order` + `onToggle` and don't care which zone they're in.
The parent computes `order` per-zone (1..N within that zone) for the
number badge.

### Number badge semantics

Per-zone numbering is the clean read — a user looking at "В конец"
sees `1, 2, 3` and thinks "three tags, in order". A single global
numbering would put e.g. `4, 5` on the attach-suffix zone, which is
noisy when the wrap zone is the only place slot-order actually means
"matryoshka depth".

## Data flow

```
user clicks/drags in preview modal
  → classify helper derives zones from selectedStyleIds + styles catalogue
  → three SortableContext regions render their subsets
  → drop fires → mergeZoneReorder writes new flat array to store
  → composeFinalPrompt and buildPreviewBlocks re-run with new order
  → right column re-renders with new block sequence
  → form dropdown label reflects new order
  → next submit sends new styleIds order in body
```

## Edge cases

- **Style with only whitespace/newlines in both fields** → classified
  as `empty`, dropped from all three zones, does not occupy a colour
  slot in the preview, does not appear anywhere in the preview modal.
  The flat `selectedStyleIds` still retains its id (the user clicked
  it); the user untiks via the form's dropdown. If the admin later
  fills a field, it reappears in the preview automatically. Empty
  styles are a pre-existing possibility — the admin form does not
  require either field — and this design preserves the previous
  compose-level skip behaviour for them.
- **Style with only `\n` or spaces in one field** → after `softTrim`,
  the resulting string has no non-whitespace character, so
  `classifyStyle` treats that side as empty and classifies by the
  other side.
- **Admin edits a ticked wrap-style to empty its suffix** → on the
  next render the style moves from wrap zone to attach-prefix. The
  left column re-layouts. The right column shows the suffix block
  disappearing and any downstream blocks moving up. No user action
  needed, no stale state.
- **All active styles are attach-prefix** → wrap and attach-suffix
  zones hidden; output is `[prefixes]\nuserPrompt`. No trailing
  newline, no empty block.
- **All active styles are attach-suffix** → output is
  `userPrompt\n[suffixes]`. Symmetric.
- **Zero active styles** → `composeFinalPrompt` returns `userPrompt`
  untouched (early-return preserved).
- **Drag within a single-style zone** → same guard as existing
  dialog: `active.id === over.id` short-circuits, no-op.
- **Dragging during admin edit** → the admin page is a separate
  route; if admin edits happen via another tab, the next render on
  the form picks up the new classification. No special handling.

## Testing

### Unit — `classify.ts`

`lib/styles/__tests__/classify.test.ts`:

- `classifyStyle` returns `"wrap"` when both have non-whitespace content.
- returns `"attach-prefix"` when only `prefix` has content.
- returns `"attach-suffix"` when only `suffix` has content.
- returns `"empty"` when both fields are empty or whitespace-only.
- treats fields containing only newlines and/or spaces as empty
  (softTrim normalises them; the `/\S/` check rejects).
- `partitionStyles` preserves input order within each bucket.
- `partitionStyles` drops `empty` styles from all three buckets.

### Unit — `inject.ts` (extend existing)

`lib/styles/__tests__/inject.test.ts`, new cases:

- one wrap + one attach-suffix → attach-suffix appears after the
  wrap's suffix line, at the very end.
- two attach-suffix in click order `[A, B]` → output ends with A
  then B (click-order = reading-order).
- mixed `[wrap, attach-prefix, wrap, attach-suffix]` → attach-prefix
  on top, then two wrap prefixes in order, then prompt, then two wrap
  suffixes reversed, then attach-suffix.
- only attach styles (no wrap) → `[prefixes]\nprompt\n[suffixes]`.
- **regression:** all-wrap input produces identical output to the
  old implementation (snapshot one case from the current inject test).

### Unit — `preview.ts` (extend existing)

`lib/styles/__tests__/preview.test.ts`, new cases:

- block ordering matches `composeFinalPrompt`'s block ordering for
  the same input (structural, not text-equality).
- `colorIndex` on an attach block equals the style's position in
  `activeStyles`, not its position within its zone.
- an attach-suffix whose style is at `activeStyles[0]` gets
  `colorIndex = 0` even though it renders last.

### Component — dialog (optional)

No new component tests. The zone rendering is a straightforward
`partitionStyles(...)` call + three conditional sections. The drag
path reuses `reorderStyleIds`; only `mergeZoneReorder` is new and
that gets a small unit test:

`components/__tests__/prompt-preview-dialog-merge.test.ts`:

- merges a reordered zone subset back into the flat array,
  preserving positions of ids not in the zone.
- preserves total length and set-equality.
- handles a single-element zone (no-op).

### Manual verification

- Create a suffix-only style in admin (leave `prefix` empty, put
  something like `— negative prompt, low quality` in `suffix`).
- On the form, tick two wrap styles, then tick the suffix-only
  style. Open preview. Confirm the suffix-only block appears **below**
  both wrap-suffix blocks.
- Untick, re-tick in a different click order. Confirm the suffix-only
  still lands at the very bottom, regardless of click position.
- Create a second suffix-only style. Tick both. Confirm they appear
  in click order in the "В конец" section, and in the right column
  the second-clicked one is below the first-clicked one.
- Drag inside "В конец" to swap order. Confirm right column updates
  on release.
- Drag inside "Обёртка" to reorder wrap layers — behaviour matches
  what shipped today (dc84960), unchanged.
- Try to drag from "Обёртка" into "В конец" — should be impossible
  (separate SortableContexts).
- Create a prefix-only style, tick it alongside a wrap and a
  suffix-only. Confirm three distinct sections render in the left
  column.
- Untick all attach styles → their zone headers disappear.
- Edit the prefix-only style in admin and add a suffix → refresh
  form, confirm it now appears in "Обёртка" instead of "В начало".
- Submit a generation with mixed zones. Confirm the generated
  history entry's stored prompt matches the preview's right column.

## Files

**Create:**
- `lib/styles/classify.ts` — `classifyStyle`, `partitionStyles`,
  `StyleZone`, `PartitionedStyles`.
- `lib/styles/__tests__/classify.test.ts` — unit tests.
- `components/__tests__/prompt-preview-dialog-merge.test.ts` — unit
  tests for `mergeZoneReorder`.

**Modify:**
- `lib/styles/inject.ts` — rewrite `composeFinalPrompt` to use
  `partitionStyles`. `softTrim` export unchanged.
- `lib/styles/preview.ts` — rewrite `buildPreviewBlocks` via
  `partitionStyles`. `PreviewBlock` interface and `STYLE_COLORS`
  unchanged.
- `lib/styles/__tests__/inject.test.ts` — add mixed-zone cases +
  all-wrap regression.
- `lib/styles/__tests__/preview.test.ts` — add mixed-zone cases +
  colorIndex assertions.
- `components/prompt-preview-dialog.tsx` — render three zone
  sections; per-zone `SortableContext`; `mergeZoneReorder` helper;
  per-zone order numbering for the badge.

**Unchanged:**
- `lib/styles/types.ts` — `Style` shape stays `{ id, name, prefix,
  suffix, createdAt, updatedAt }`.
- `lib/styles/store.ts` / `store.impl.ts` — flat
  `selectedStyleIds: string[]` stays as-is.
- `lib/styles/reorder.ts` — `reorderStyleIds` reused on zone subsets.
- Admin-side — no UI changes, no new fields.
- `components/styles-multi-select.tsx` — dropdown stays a flat
  checkbox list in admin order, unchanged.
- History / generation routes — compose output is written to
  history exactly as produced; classification is invisible outside
  the compose layer.
