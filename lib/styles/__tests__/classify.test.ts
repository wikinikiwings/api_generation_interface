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
