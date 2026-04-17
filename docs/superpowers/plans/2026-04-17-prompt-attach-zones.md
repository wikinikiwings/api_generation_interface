# Prompt Attach Zones Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Treat one-sided styles (prefix-only, suffix-only) as attachments placed outside the matryoshka, so that a suffix-only "negative prompt" clicked last reads last in the final text.

**Architecture:** Classification is derived at compose time by a pure helper (`partitionStyles`) from `prefix`/`suffix` content — no schema change, no admin UI. `composeFinalPrompt` and `buildPreviewBlocks` route blocks into three lanes: attach-prefix (top), wrap matryoshka (middle), attach-suffix (bottom). The preview dialog renders three sibling zones in the left column, each as its own isolated `DndContext` + `SortableContext`, so drag reorder stays within a single zone.

**Tech Stack:** TypeScript, React 19, Next.js 15, vitest, @dnd-kit/core, @dnd-kit/sortable, zustand.

**Spec:** `docs/superpowers/specs/2026-04-17-prompt-attach-zones-design.md`

**Execution notes:**
- Run tests from the repo root: `npm test -- <path>` uses the `vitest run` script.
- Tests live next to the code they cover under `__tests__/` and use `vitest` + `@testing-library/react`.
- Never skip tests or hooks. Never use `--no-verify` on commits.
- Commit after each Task. Message style matches today's commits (`feat(styles): ...`, `fix(prompt-preview): ...`, etc.).

---

## File Structure

**Create:**
- `lib/styles/classify.ts` — `classifyStyle`, `partitionStyles`, zone types.
- `lib/styles/__tests__/classify.test.ts` — unit tests for the helper.
- `components/__tests__/prompt-preview-dialog-merge.test.ts` — unit tests for `mergeZoneReorder`.

**Modify:**
- `lib/styles/inject.ts` — rewrite `composeFinalPrompt` via `partitionStyles`. `softTrim` export unchanged.
- `lib/styles/__tests__/inject.test.ts` — add mixed-zone cases + explicit all-wrap regression.
- `lib/styles/preview.ts` — rewrite `buildPreviewBlocks` via `partitionStyles`. Keep `PreviewBlock`, `STYLE_COLORS` exports.
- `lib/styles/__tests__/preview.test.ts` — add mixed-zone cases.
- `components/prompt-preview-dialog.tsx` — three zone sections in the left column, three isolated `DndContext`s, per-zone badge numbering, `mergeZoneReorder` helper (exported for tests).

**Unchanged:**
- `lib/styles/types.ts`, `lib/styles/store.ts`, `lib/styles/store.impl.ts`, `lib/styles/reorder.ts`.
- Admin-side UI (`app/admin/**`, `components/admin/**`).
- `components/styles-multi-select.tsx`.
- `stores/settings-store.ts` (continues to own `selectedStyleIds` as a flat array).

---

## Task 1: Classify helper — `classifyStyle` + `partitionStyles`

**Files:**
- Create: `lib/styles/classify.ts`
- Test: `lib/styles/__tests__/classify.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `lib/styles/__tests__/classify.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { classifyStyle, partitionStyles } from "../classify";
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

describe("classifyStyle", () => {
  it("returns 'wrap' when both prefix and suffix have non-whitespace content", () => {
    expect(
      classifyStyle(style({ prefix: "cinematic", suffix: "35mm" }))
    ).toBe("wrap");
  });

  it("returns 'attach-prefix' when only prefix has content", () => {
    expect(
      classifyStyle(style({ prefix: "cinematic", suffix: "" }))
    ).toBe("attach-prefix");
  });

  it("returns 'attach-suffix' when only suffix has content", () => {
    expect(
      classifyStyle(style({ prefix: "", suffix: "low quality, blurry" }))
    ).toBe("attach-suffix");
  });

  it("returns 'empty' when both fields are empty", () => {
    expect(classifyStyle(style({}))).toBe("empty");
  });

  it("treats fields with only spaces/tabs/newlines as empty", () => {
    expect(
      classifyStyle(style({ prefix: "   \n\t ", suffix: "\n\n" }))
    ).toBe("empty");
  });

  it("prefix-only with suffix of only newlines is attach-prefix", () => {
    expect(
      classifyStyle(style({ prefix: "cinematic", suffix: "\n\n" }))
    ).toBe("attach-prefix");
  });

  it("suffix-only with prefix of only spaces is attach-suffix", () => {
    expect(
      classifyStyle(style({ prefix: "   ", suffix: "35mm" }))
    ).toBe("attach-suffix");
  });
});

describe("partitionStyles", () => {
  it("preserves input order within each bucket", () => {
    const a = style({ id: "a", prefix: "PA", suffix: "SA" }); // wrap
    const b = style({ id: "b", prefix: "PB", suffix: "" }); // attach-prefix
    const c = style({ id: "c", prefix: "", suffix: "SC" }); // attach-suffix
    const d = style({ id: "d", prefix: "PD", suffix: "SD" }); // wrap
    const e = style({ id: "e", prefix: "", suffix: "SE" }); // attach-suffix
    const { attachPrefix, wrap, attachSuffix } = partitionStyles([a, b, c, d, e]);
    expect(attachPrefix.map((s) => s.id)).toEqual(["b"]);
    expect(wrap.map((s) => s.id)).toEqual(["a", "d"]);
    expect(attachSuffix.map((s) => s.id)).toEqual(["c", "e"]);
  });

  it("drops empty-classified styles from all three buckets", () => {
    const a = style({ id: "a", prefix: "PA", suffix: "SA" });
    const empty = style({ id: "e", prefix: "  ", suffix: "\n" });
    const { attachPrefix, wrap, attachSuffix } = partitionStyles([a, empty]);
    expect(attachPrefix).toEqual([]);
    expect(wrap.map((s) => s.id)).toEqual(["a"]);
    expect(attachSuffix).toEqual([]);
  });

  it("handles empty input", () => {
    expect(partitionStyles([])).toEqual({
      attachPrefix: [],
      wrap: [],
      attachSuffix: [],
    });
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -- lib/styles/__tests__/classify.test.ts`
Expected: FAIL with "Cannot find module '../classify'".

- [ ] **Step 3: Implement `classify.ts`**

Create `lib/styles/classify.ts`:

```ts
import { softTrim } from "./inject";
import type { Style } from "./types";

export type StyleZone =
  | "wrap"
  | "attach-prefix"
  | "attach-suffix"
  | "empty";

export interface PartitionedStyles {
  attachPrefix: Style[];
  wrap: Style[];
  attachSuffix: Style[];
}

export function classifyStyle(style: Style): StyleZone {
  const hasP = /\S/.test(softTrim(style.prefix ?? ""));
  const hasS = /\S/.test(softTrim(style.suffix ?? ""));
  if (hasP && hasS) return "wrap";
  if (hasP) return "attach-prefix";
  if (hasS) return "attach-suffix";
  return "empty";
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
    // "empty" is intentionally dropped.
  }
  return out;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test -- lib/styles/__tests__/classify.test.ts`
Expected: PASS (10 tests green).

- [ ] **Step 5: Commit**

```bash
git add lib/styles/classify.ts lib/styles/__tests__/classify.test.ts
git commit -m "$(cat <<'EOF'
feat(styles): add classifyStyle and partitionStyles helper

Classifies each style by what its prefix/suffix actually contain —
wrap when both are non-empty, attach-prefix when only the prefix is,
attach-suffix when only the suffix is, empty when neither is. A pure
helper, no data-model change; the admin form stays as-is and existing
styles flow through untouched.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: Rewrite `composeFinalPrompt` via `partitionStyles`

**Files:**
- Modify: `lib/styles/inject.ts`
- Modify: `lib/styles/__tests__/inject.test.ts`

- [ ] **Step 1: Add failing tests for the new behaviour and the all-wrap regression**

Append to `lib/styles/__tests__/inject.test.ts` inside the existing `describe("composeFinalPrompt", ...)` block (add the cases below; keep existing cases untouched):

```ts
  it("attach-suffix lands after all wrap suffixes (very end of output)", () => {
    const kino = style({ id: "k", prefix: "cinematic", suffix: "35mm" });
    const neg = style({ id: "n", prefix: "", suffix: "low quality" });
    expect(
      composeFinalPrompt("a cat", [kino, neg])
    ).toBe("cinematic\na cat\n35mm\n\nlow quality");
  });

  it("two attach-suffix styles stack in click order (first-clicked reads first)", () => {
    const a = style({ id: "a", prefix: "", suffix: "tag-A" });
    const b = style({ id: "b", prefix: "", suffix: "tag-B" });
    expect(composeFinalPrompt("a cat", [a, b])).toBe(
      "a cat\ntag-A\n\ntag-B"
    );
  });

  it("two attach-prefix styles stack in click order (first-clicked reads first)", () => {
    const a = style({ id: "a", prefix: "pre-A", suffix: "" });
    const b = style({ id: "b", prefix: "pre-B", suffix: "" });
    expect(composeFinalPrompt("a cat", [a, b])).toBe(
      "pre-A\n\npre-B\na cat"
    );
  });

  it("attach-prefix precedes wrap prefixes in the top block", () => {
    const wrap = style({ id: "w", prefix: "cinematic", suffix: "35mm" });
    const preOnly = style({ id: "p", prefix: "HEADER:", suffix: "" });
    expect(
      composeFinalPrompt("a cat", [wrap, preOnly])
    ).toBe("HEADER:\n\ncinematic\na cat\n35mm");
  });

  it("mixed: attach-prefix, two wraps, attach-suffix — full layout", () => {
    const preOnly = style({ id: "p", prefix: "HEADER:", suffix: "" });
    const w1 = style({ id: "w1", prefix: "P1", suffix: "S1" });
    const w2 = style({ id: "w2", prefix: "P2", suffix: "S2" });
    const neg = style({ id: "n", prefix: "", suffix: "NEG" });
    expect(
      composeFinalPrompt("a cat", [preOnly, w1, w2, neg])
    ).toBe("HEADER:\n\nP1\n\nP2\na cat\nS2\n\nS1\n\nNEG");
  });

  it("only attach styles (no wrap) — prefixes on top, suffixes at bottom", () => {
    const p = style({ id: "p", prefix: "pre", suffix: "" });
    const s = style({ id: "s", prefix: "", suffix: "post" });
    expect(composeFinalPrompt("a cat", [p, s])).toBe(
      "pre\na cat\npost"
    );
  });

  it("regression: all-wrap output matches the old slot-1-outermost matryoshka", () => {
    // Same input as the existing three-style matryoshka test; the rewrite
    // must produce byte-identical output to lock in backward compatibility
    // for users whose selections are entirely wrap styles.
    const kino = style({ id: "k", prefix: "cinematic", suffix: "35mm" });
    const threeD = style({ id: "3d", prefix: "3d render", suffix: "ray traced" });
    const groza = style({ id: "g", prefix: "storm", suffix: "lightning" });
    expect(composeFinalPrompt("a cat", [kino, threeD, groza])).toBe(
      "cinematic\n\n3d render\n\nstorm\na cat\nlightning\n\nray traced\n\n35mm"
    );
  });
```

- [ ] **Step 2: Run the suite to verify the new cases fail where intended**

Run: `npm test -- lib/styles/__tests__/inject.test.ts`
Expected: Some new cases FAIL. Specifically, the attach-suffix and attach-prefix ordering tests fail — the old implementation routes one-sided styles through the matryoshka. The all-wrap regression case should already PASS (it matches the pre-existing behaviour); keep it — it locks in that the rewrite doesn't regress.

- [ ] **Step 3: Rewrite `composeFinalPrompt` in `lib/styles/inject.ts`**

Replace the body of `composeFinalPrompt` (keep `softTrim` and its JSDoc). The new body:

```ts
import { partitionStyles } from "./classify";

// ...softTrim stays here, unchanged...

/**
 * Compose the final prompt sent to the generation API.
 *
 * Styles are classified by content:
 *   - wrap (both prefix and suffix non-empty) → matryoshka in the middle,
 *     slot-1 outermost, slot-N closest to userPrompt.
 *   - attach-prefix (only prefix non-empty) → stacked above the wrap
 *     prefixes, in click order (first-clicked reads first).
 *   - attach-suffix (only suffix non-empty) → stacked below the wrap
 *     suffixes, in click order (first-clicked reads first).
 *   - empty → dropped.
 *
 * Separator policy is unchanged: "\n\n" between stacked blocks on the
 * same side, "\n" around userPrompt.
 */
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

Drop the old `/\S/.test(p)` filters — `partitionStyles` already excludes empty styles, and by construction every remaining style's relevant side is non-empty.

- [ ] **Step 4: Run the full inject suite to verify everything passes**

Run: `npm test -- lib/styles/__tests__/inject.test.ts`
Expected: PASS. All existing cases keep passing (backward-compatible for their scenarios), new cases now pass.

- [ ] **Step 5: Commit**

```bash
git add lib/styles/inject.ts lib/styles/__tests__/inject.test.ts
git commit -m "$(cat <<'EOF'
feat(styles)!: compose routes one-sided styles as attach zones

composeFinalPrompt now partitions active styles into attach-prefix,
wrap, and attach-suffix zones. Wrap styles keep the existing matryoshka
(slot-1 outermost, slot-N closest to userPrompt). Attach-prefix stacks
above the wrap prefixes in click order; attach-suffix stacks below the
wrap suffixes in click order — so a suffix-only style clicked last now
reads last, instead of being buried in the middle of the suffix stack.

Behaviour change: existing one-sided selections compose to a different
final prompt (moved out of the matryoshka). All-wrap selections are
unchanged — a regression test locks this in.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: Rewrite `buildPreviewBlocks` via `partitionStyles`

**Files:**
- Modify: `lib/styles/preview.ts`
- Modify: `lib/styles/__tests__/preview.test.ts`

- [ ] **Step 1: Add failing tests**

Append to `lib/styles/__tests__/preview.test.ts` inside the existing `describe("buildPreviewBlocks", ...)` block:

```ts
  it("attach-suffix block lands after wrap suffixes", () => {
    const wrap = style({ id: "w", name: "W", prefix: "PW", suffix: "SW" });
    const neg = style({ id: "n", name: "N", prefix: "", suffix: "NEG" });
    const blocks = buildPreviewBlocks("x", [wrap, neg]);
    expect(blocks.map((b) => [b.kind, b.styleId ?? "_", b.text])).toEqual([
      ["prefix", "w", "PW"],
      ["prompt", "_", "x"],
      ["suffix", "w", "SW"],
      ["suffix", "n", "NEG"],
    ]);
  });

  it("attach-prefix block precedes wrap prefixes", () => {
    const wrap = style({ id: "w", name: "W", prefix: "PW", suffix: "SW" });
    const pre = style({ id: "p", name: "P", prefix: "PRE", suffix: "" });
    const blocks = buildPreviewBlocks("x", [wrap, pre]);
    expect(blocks.map((b) => [b.kind, b.styleId ?? "_", b.text])).toEqual([
      ["prefix", "p", "PRE"],
      ["prefix", "w", "PW"],
      ["prompt", "_", "x"],
      ["suffix", "w", "SW"],
    ]);
  });

  it("mixed zones — full layout matches composeFinalPrompt ordering", () => {
    const pre = style({ id: "p", name: "P", prefix: "HEADER:", suffix: "" });
    const w1 = style({ id: "w1", name: "W1", prefix: "P1", suffix: "S1" });
    const w2 = style({ id: "w2", name: "W2", prefix: "P2", suffix: "S2" });
    const neg = style({ id: "n", name: "N", prefix: "", suffix: "NEG" });
    const blocks = buildPreviewBlocks("x", [pre, w1, w2, neg]);
    expect(blocks.map((b) => [b.kind, b.styleId ?? "_", b.text])).toEqual([
      ["prefix", "p", "HEADER:"],
      ["prefix", "w1", "P1"],
      ["prefix", "w2", "P2"],
      ["prompt", "_", "x"],
      ["suffix", "w2", "S2"],
      ["suffix", "w1", "S1"],
      ["suffix", "n", "NEG"],
    ]);
  });

  it("colorIndex on an attach-suffix block equals the style's position in activeStyles, not its rendered index", () => {
    // Style at activeStyles[0] is attach-suffix; it renders last but
    // must keep colorIndex 0.
    const neg = style({ id: "n", name: "N", prefix: "", suffix: "NEG" });
    const wrap = style({ id: "w", name: "W", prefix: "PW", suffix: "SW" });
    const blocks = buildPreviewBlocks("x", [neg, wrap]);
    const negBlock = blocks.find((b) => b.styleId === "n");
    const wrapPrefix = blocks.find((b) => b.kind === "prefix" && b.styleId === "w");
    expect(negBlock?.colorIndex).toBe(0);
    expect(wrapPrefix?.colorIndex).toBe(1);
  });
```

- [ ] **Step 2: Run the preview suite to verify the new cases fail**

Run: `npm test -- lib/styles/__tests__/preview.test.ts`
Expected: FAIL on the new attach-ordering cases (the old impl runs all styles through the matryoshka). Existing cases still PASS.

- [ ] **Step 3: Rewrite `buildPreviewBlocks` in `lib/styles/preview.ts`**

Replace the `buildPreviewBlocks` function (keep `PreviewBlock` and `STYLE_COLORS`):

```ts
import { softTrim } from "./inject";
import { partitionStyles } from "./classify";
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
  const { attachPrefix, wrap, attachSuffix } = partitionStyles(activeStyles);
  const indexOf = new Map(activeStyles.map((s, i) => [s.id, i]));
  const blocks: PreviewBlock[] = [];

  const push = (kind: "prefix" | "suffix", s: Style, raw: string) => {
    blocks.push({
      kind,
      styleId: s.id,
      styleName: s.name,
      colorIndex: (indexOf.get(s.id) ?? 0) % STYLE_COLORS.length,
      text: softTrim(raw),
    });
  };

  for (const s of attachPrefix) push("prefix", s, s.prefix);
  for (const s of wrap) push("prefix", s, s.prefix);
  blocks.push({ kind: "prompt", text: prompt });
  for (let i = wrap.length - 1; i >= 0; i--) push("suffix", wrap[i], wrap[i].suffix);
  for (const s of attachSuffix) push("suffix", s, s.suffix);

  return blocks;
}
```

- [ ] **Step 4: Run the preview suite to verify it passes**

Run: `npm test -- lib/styles/__tests__/preview.test.ts`
Expected: PASS (all existing + new cases).

- [ ] **Step 5: Commit**

```bash
git add lib/styles/preview.ts lib/styles/__tests__/preview.test.ts
git commit -m "$(cat <<'EOF'
feat(styles): preview blocks mirror attach-zone compose ordering

buildPreviewBlocks now routes blocks through partitionStyles so the
right column of the preview modal shows attach-prefix on top,
wrap-prefix matryoshka, prompt, wrap-suffix matryoshka reversed, and
attach-suffix at the bottom. colorIndex stays pegged to position in
activeStyles so a style keeps its colour regardless of zone.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: `mergeZoneReorder` helper for zone-local drag

**Files:**
- Modify: `components/prompt-preview-dialog.tsx` (export the new helper)
- Create: `components/__tests__/prompt-preview-dialog-merge.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `components/__tests__/prompt-preview-dialog-merge.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { mergeZoneReorder } from "../prompt-preview-dialog";

describe("mergeZoneReorder", () => {
  it("reorders a zone subset inside the flat list, preserving non-zone positions", () => {
    // flat: [w1, pre, w2, neg, w3] — reorder the wrap zone [w1, w2, w3] → [w3, w1, w2]
    const flat = ["w1", "pre", "w2", "neg", "w3"];
    const reorderedZone = ["w3", "w1", "w2"];
    expect(mergeZoneReorder(flat, reorderedZone)).toEqual([
      "w3",
      "pre",
      "w1",
      "neg",
      "w2",
    ]);
  });

  it("reordering attach-suffix does not move wrap or attach-prefix entries", () => {
    const flat = ["pre", "w1", "negA", "w2", "negB"];
    const reorderedZone = ["negB", "negA"];
    expect(mergeZoneReorder(flat, reorderedZone)).toEqual([
      "pre",
      "w1",
      "negB",
      "w2",
      "negA",
    ]);
  });

  it("preserves length and set-equality of the flat list", () => {
    const flat = ["a", "b", "c", "d", "e"];
    const reorderedZone = ["d", "b"];
    const out = mergeZoneReorder(flat, reorderedZone);
    expect(out).toHaveLength(flat.length);
    expect(new Set(out)).toEqual(new Set(flat));
  });

  it("single-element zone is a no-op", () => {
    const flat = ["a", "b", "c"];
    expect(mergeZoneReorder(flat, ["b"])).toEqual(["a", "b", "c"]);
  });

  it("empty zone returns the flat list unchanged", () => {
    const flat = ["a", "b", "c"];
    expect(mergeZoneReorder(flat, [])).toEqual(["a", "b", "c"]);
  });
});
```

- [ ] **Step 2: Run to verify the tests fail**

Run: `npm test -- components/__tests__/prompt-preview-dialog-merge.test.ts`
Expected: FAIL with "has no exported member 'mergeZoneReorder'" or similar.

- [ ] **Step 3: Export the helper from `components/prompt-preview-dialog.tsx`**

At the top-level of the file (outside the component), add:

```ts
export function mergeZoneReorder(
  flat: readonly string[],
  reorderedZoneIds: readonly string[]
): string[] {
  const zoneSet = new Set(reorderedZoneIds);
  const iter = reorderedZoneIds[Symbol.iterator]();
  return flat.map((id) => (zoneSet.has(id) ? iter.next().value! : id));
}
```

- [ ] **Step 4: Run to verify the tests pass**

Run: `npm test -- components/__tests__/prompt-preview-dialog-merge.test.ts`
Expected: PASS (5 tests green).

- [ ] **Step 5: Commit**

```bash
git add components/prompt-preview-dialog.tsx components/__tests__/prompt-preview-dialog-merge.test.ts
git commit -m "$(cat <<'EOF'
feat(prompt-preview): add mergeZoneReorder helper

Pure function that takes the flat selectedStyleIds and a reordered
subset of one zone, and writes the subset back in place — preserving
positions of ids from other zones. Enables zone-local drag without
perturbing the matryoshka order of wrap styles when the user
reorders inside an attach zone, and vice versa.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: Render three zones in the preview dialog's left column

**Files:**
- Modify: `components/prompt-preview-dialog.tsx`

This task is UI wiring. No new unit tests — we cover the pure bits in Task 4; the dialog integration is verified in Task 6 (manual).

- [ ] **Step 1: Read the current dialog file and confirm structure**

Run: `cat components/prompt-preview-dialog.tsx | head -60`
Expected output includes the imports block and the `SortableStyleRow`, `PlainStyleRow` definitions. Confirm `reorderStyleIds` is imported from `@/lib/styles/reorder` and `mergeZoneReorder` is exported from this file (added in Task 4).

- [ ] **Step 2: Add imports and zone metadata**

At the top of `components/prompt-preview-dialog.tsx`, add (next to existing `partitionStyles`-neighbours):

```ts
import { partitionStyles, type StyleZone } from "@/lib/styles/classify";
import { arrayMove } from "@dnd-kit/sortable";
```

`reorderStyleIds` import can stay, but it is no longer used — remove the line `import { reorderStyleIds } from "@/lib/styles/reorder";`. (The helper itself is not deleted; other callers may still use it, and `reorder.ts` is listed as unchanged.)

Inside the component file, above `PromptPreviewDialog`, add a small zone-meta table:

```ts
const ZONE_META: Record<Exclude<StyleZone, "empty">, { title: string; caption: string }> = {
  "attach-prefix": { title: "В начало", caption: "перед всем" },
  wrap: { title: "Обёртка", caption: "матрёшка вокруг промта" },
  "attach-suffix": { title: "В конец", caption: "после всего" },
};
```

- [ ] **Step 3: Partition the ticked styles inside `PromptPreviewDialog`**

Replace the existing `activeStyles` `useMemo` block with partitioning. After the existing declarations for `selectedStyleIds`, `setSelectedStyleIds`, `prompt`:

```ts
  const activeStyles = React.useMemo<Style[]>(() => {
    return selectedStyleIds
      .map((id) => styles.find((s) => s.id === id))
      .filter((s): s is Style => s !== undefined);
  }, [styles, selectedStyleIds]);

  const partitioned = React.useMemo(
    () => partitionStyles(activeStyles),
    [activeStyles]
  );
```

`untickedStyles`, `blocks`, `finalPrompt`, `toggle`, `copyFinal`, `copyDisabled`, `sensors` stay as they are.

- [ ] **Step 4: Replace the single `handleDragEnd` with a zone-aware factory**

Remove the existing `handleDragEnd` function. Add:

```ts
  function makeZoneDragEnd(zoneIds: readonly string[]) {
    return (e: DragEndEvent) => {
      const { active, over } = e;
      if (!over || active.id === over.id) return;
      const oldIdx = zoneIds.indexOf(String(active.id));
      const newIdx = zoneIds.indexOf(String(over.id));
      if (oldIdx === -1 || newIdx === -1) return;
      const reorderedZone = arrayMove(zoneIds.slice(), oldIdx, newIdx);
      setSelectedStyleIds(mergeZoneReorder(selectedStyleIds, reorderedZone));
    };
  }
```

The `arrayMove` import is the one already added in Step 2.

- [ ] **Step 5: Rewrite the left-column JSX as three zones**

Inside the return, replace the existing `<div className="flex flex-col gap-1 md:overflow-y-auto md:pr-2"> ... </div>` block with:

```tsx
          {/* Left: styles list, grouped into zones */}
          <div className="flex flex-col gap-3 md:overflow-y-auto md:pr-2">
            {styles.length === 0 ? (
              <div className="px-2 py-1.5 text-xs text-muted-foreground">
                Стилей пока нет. Создайте в админке.
              </div>
            ) : (
              <>
                {(["attach-prefix", "wrap", "attach-suffix"] as const).map(
                  (zone) => {
                    const zoneStyles =
                      zone === "attach-prefix"
                        ? partitioned.attachPrefix
                        : zone === "wrap"
                        ? partitioned.wrap
                        : partitioned.attachSuffix;
                    if (zoneStyles.length === 0) return null;
                    const zoneIds = zoneStyles.map((s) => s.id);
                    const meta = ZONE_META[zone];
                    return (
                      <div key={zone} className="flex flex-col gap-1">
                        <div className="px-2">
                          <div className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                            {meta.title}
                          </div>
                          <div className="text-[10px] text-muted-foreground/70">
                            {meta.caption}
                          </div>
                        </div>
                        <DndContext
                          sensors={sensors}
                          onDragEnd={makeZoneDragEnd(zoneIds)}
                        >
                          <SortableContext
                            items={zoneIds}
                            strategy={verticalListSortingStrategy}
                          >
                            {zoneStyles.map((s, i) => (
                              <SortableStyleRow
                                key={s.id}
                                style={s}
                                order={i + 1}
                                onToggle={() => toggle(s.id)}
                              />
                            ))}
                          </SortableContext>
                        </DndContext>
                      </div>
                    );
                  }
                )}

                {untickedStyles.length > 0 && (
                  <div className="flex flex-col gap-1">
                    {activeStyles.length > 0 && (
                      <div className="px-2 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                        Доступны
                      </div>
                    )}
                    {untickedStyles.map((s) => (
                      <PlainStyleRow
                        key={s.id}
                        style={s}
                        onToggle={() => toggle(s.id)}
                      />
                    ))}
                  </div>
                )}
              </>
            )}
            {selectedStyleIds.length > 3 && (
              <div className="mt-1 px-2 text-[11px] text-muted-foreground">
                ⚠ Больше 3 стилей — может выйти невнятный промпт
              </div>
            )}
          </div>
```

Points to notice:
- Three separate `DndContext`s (one per zone) isolate drops — a drag that starts in zone A cannot end in zone B, because @dnd-kit's event routing is per-context.
- Per-zone `order` numbering (`i + 1`) — the user sees `1, 2, 3` inside each zone, not a global offset.
- `activeStyles.length > 0` check before the "Доступны" header prevents a lonely header when nothing is ticked.
- The `> 3` warning still uses `selectedStyleIds.length` globally — zone split doesn't change the "too many styles" heuristic.

- [ ] **Step 6: Verify the file compiles and existing unit tests still pass**

Run: `npm test -- lib/styles components/__tests__/prompt-preview-dialog-merge.test.ts`
Expected: all previously-passing tests still pass (classify, inject, preview, merge).

Then run type check: `npx tsc --noEmit -p tsconfig.json`
Expected: no new errors introduced by the dialog edit. If errors surface about `StyleZone` / `ZONE_META` indexing, it's most likely a missing `as const` or a typo — fix inline before proceeding.

- [ ] **Step 7: Commit**

```bash
git add components/prompt-preview-dialog.tsx
git commit -m "$(cat <<'EOF'
feat(prompt-preview): render three zones in left column

Left column now splits ticked styles into three sections — «В начало»,
«Обёртка», «В конец» — driven by partitionStyles. Each zone is its
own DndContext + SortableContext, so drag-reorder stays within the
zone; cross-zone drops are structurally impossible. Number badges
count 1..N within each zone. Empty zones are hidden. Unticked styles
render below under a «Доступны» header when any style is ticked.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 6: Manual browser verification

**No file changes.** This task validates the end-to-end behaviour in a real browser. The unit suite cannot verify drag + focus + modal interactions, so this is the acceptance gate.

- [ ] **Step 1: Start the dev server**

Run (in a separate terminal): `npm run dev`
Expected: Next.js boots, app reachable at `http://localhost:3000` (or `http://192.168.88.76:3000` on LAN).

- [ ] **Step 2: Prepare test data in the admin styles page**

Navigate to the admin styles section (route under `app/admin/**`, typically `/admin`). Create four styles:

- `Cinematic` — prefix `cinematic shot,`, suffix `shot on 35mm film`.
- `Dramatic` — prefix `dramatic lighting,`, suffix `high contrast`.
- `HeaderOnly` — prefix `[STYLE GUIDE:\n`, suffix empty.
- `NegativeOnly` — prefix empty, suffix `--negative low quality, blurry, watermark`.

Save each. Expected: all four appear in the admin list, order persists after page reload.

- [ ] **Step 3: Verify attach-suffix lands at the very end**

On the main form: tick `Cinematic`, then `Dramatic`, then `NegativeOnly` (in that click order). Enter `a cat` as the user prompt. Open the preview modal (eye button in the Стиль row).

Expected in the right column:
```
[prefix: Cinematic]  cinematic shot,
[prefix: Dramatic]   dramatic lighting,
[prompt]             a cat
[suffix: Dramatic]   high contrast
[suffix: Cinematic]  shot on 35mm film
[suffix: NegativeOnly] --negative low quality, blurry, watermark
```

`NegativeOnly` is last, not in the middle of the suffix stack.

Expected in the left column:
- «Обёртка» section with `1. Cinematic`, `2. Dramatic`.
- «В конец» section with `1. NegativeOnly`.
- No «В начало» section (none ticked).
- «Доступны» section with `HeaderOnly`.

- [ ] **Step 4: Verify click order within a zone**

Still in the modal, untick `NegativeOnly`. Create a second suffix-only style from admin: `ExtraTags` (prefix empty, suffix `masterpiece, 4k`). Reload the form, tick `NegativeOnly` then `ExtraTags`.

Expected right column, bottom:
```
[suffix: NegativeOnly] --negative low quality, blurry, watermark
[suffix: ExtraTags]    masterpiece, 4k
```

`NegativeOnly` (clicked first) reads first. `ExtraTags` (clicked second) reads second.

- [ ] **Step 5: Verify attach-prefix**

Untick the two attach-suffix styles. Tick `HeaderOnly`, `Cinematic`, `Dramatic`.

Expected right column:
```
[prefix: HeaderOnly] [STYLE GUIDE:
[prefix: Cinematic]  cinematic shot,
[prefix: Dramatic]   dramatic lighting,
[prompt]             a cat
[suffix: Dramatic]   high contrast
[suffix: Cinematic]  shot on 35mm film
```

`HeaderOnly` renders above the wrap prefixes. Left column shows both «В начало» (HeaderOnly) and «Обёртка» (Cinematic, Dramatic), no «В конец».

- [ ] **Step 6: Verify drag inside a zone**

Tick everything so all three zones are populated (HeaderOnly, Cinematic, Dramatic, NegativeOnly, ExtraTags). In the modal, drag the `ExtraTags` row above `NegativeOnly` in the «В конец» section.

Expected:
- Right column updates on release: `ExtraTags` block is now above `NegativeOnly` block.
- Left column: «В конец» now reads `1. ExtraTags`, `2. NegativeOnly`.
- «Обёртка» order is unchanged (`Cinematic`, `Dramatic`).
- «В начало» order is unchanged (`HeaderOnly`).

- [ ] **Step 7: Verify cross-zone drag is impossible**

Try to drag `ExtraTags` (in «В конец») and drop it on `Cinematic` (in «Обёртка»).

Expected: drag visual ends as a snap-back; no state change; right column unchanged; zones unchanged.

- [ ] **Step 8: Verify live reclassification on admin edit**

Keep the modal open (or re-open after changes). In the admin page, edit `Cinematic`: clear the `suffix` field, save. Back on the form, re-open the preview.

Expected: `Cinematic` has moved from the «Обёртка» section to the «В начало» section. Its position in the right column is now in the attach-prefix block. `Dramatic` remains in «Обёртка» alone.

Restore `Cinematic`'s suffix after verifying.

- [ ] **Step 9: Verify submit sends the new order**

With a mixed-zone selection ticked (and a reasonable prompt), submit a generation. Check the network request body (DevTools → Network → POST to the generation endpoint): `styleIds` (or whatever the request shape is — search `fetch` in `GenerateForm` if unsure) reflects the current `selectedStyleIds` order.

Verify the generated history entry's stored composed prompt matches what the preview showed. (The history card already renders the user prompt with a style badge after prompt-styles copy-unwrap — spot-check that the trailing text content is what you expect.)

- [ ] **Step 10: Verify history compatibility (no recomposition)**

Open a history entry that predates this change (or just one generated before edits in step 8). Confirm:
- The stored prompt displayed in the entry is unchanged from what was generated at that time.
- No runtime error in the console about `partitionStyles` or `classify`.

History stores the composed prompt as-is; the classification change is invisible to history.

- [ ] **Step 11: Close dev server**

Stop the `npm run dev` process (Ctrl+C).

No commit — this task is verification only. If any step fails, return to the failing task (usually Task 5) and fix before marking this task complete.

---

## Self-Review

**Spec coverage:** Every spec section maps to at least one task.
- Classification helper (spec §Architecture/New helper) → Task 1.
- `composeFinalPrompt` rewrite (spec §composeFinalPrompt) → Task 2.
- `buildPreviewBlocks` rewrite (spec §buildPreviewBlocks) → Task 3.
- `mergeZoneReorder` (spec §Preview modal / zone merge) → Task 4.
- Three-zone left column (spec §Preview modal — three left-column zones) → Task 5.
- Empty-zone hiding, per-zone badge numbering, no cross-zone drag (spec §Number badge semantics, §Edge cases) → Task 5, Task 6 step 7.
- Live reclassification (spec §Edge cases) → Task 6 step 8.
- History non-recomposition (spec §Out of scope, §Files/Unchanged) → Task 6 step 10.
- All-wrap regression lock-in (spec §Testing) → Task 2 step 1.

**Placeholder scan:** No `TBD`, no `TODO`, no "fill in", no "similar to". Every step has exact code or exact commands.

**Type consistency:**
- `StyleZone` defined in Task 1, consumed in Task 5 (`ZONE_META: Record<Exclude<StyleZone, "empty">, ...>`).
- `partitionStyles` signature `(styles: readonly Style[]) => PartitionedStyles` consistent across Tasks 1, 2, 3, 5.
- `mergeZoneReorder(flat, reorderedZoneIds)` — same two-arg signature in Task 4 export and Task 5 call site.
- `makeZoneDragEnd(zoneIds)` signature matches `@dnd-kit`'s `(e: DragEndEvent) => void`.
