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
    const styles = Array.from({ length: 7 }, (_, i) =>
      style({ id: `s${i}`, name: `S${i}`, prefix: `P${i}`, suffix: `S${i}` })
    );
    const blocks = buildPreviewBlocks("x", styles);
    const seventhPrefix = blocks.find((b) => b.kind === "prefix" && b.styleId === "s6");
    expect(seventhPrefix?.colorIndex).toBe(0);
  });

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
});
