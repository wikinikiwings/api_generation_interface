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

  it("three styles — matryoshka order: prefixes N-1..0 (outer first), prompt, suffixes 0..N-1 (inner first)", () => {
    const a = style({ id: "a", name: "A", prefix: "PA", suffix: "SA" });
    const b = style({ id: "b", name: "B", prefix: "PB", suffix: "SB" });
    const c = style({ id: "c", name: "C", prefix: "PC", suffix: "SC" });
    const blocks = buildPreviewBlocks("x", [a, b, c]);
    expect(blocks.map((b) => [b.kind, b.styleId ?? "_", b.text])).toEqual([
      ["prefix", "c", "PC"],
      ["prefix", "b", "PB"],
      ["prefix", "a", "PA"],
      ["prompt", "_", "x"],
      ["suffix", "a", "SA"],
      ["suffix", "b", "SB"],
      ["suffix", "c", "SC"],
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
});
