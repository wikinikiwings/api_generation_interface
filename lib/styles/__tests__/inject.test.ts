import { describe, it, expect } from "vitest";
import { composeFinalPrompt } from "../inject";
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

describe("composeFinalPrompt", () => {
  it("returns the user prompt unchanged when no styles are active", () => {
    expect(composeFinalPrompt("a cat", [])).toBe("a cat");
  });

  it("single style with prefix and suffix wraps correctly", () => {
    expect(
      composeFinalPrompt("a cat", [style({ prefix: "cinematic", suffix: "35mm" })])
    ).toBe("cinematic\na cat\n35mm");
  });

  it("single style with empty prefix: no leading separator", () => {
    expect(
      composeFinalPrompt("a cat", [style({ prefix: "", suffix: "35mm" })])
    ).toBe("a cat\n35mm");
  });

  it("single style with empty suffix: no trailing separator", () => {
    expect(
      composeFinalPrompt("a cat", [style({ prefix: "cinematic", suffix: "" })])
    ).toBe("cinematic\na cat");
  });

  it("single style with empty prefix and suffix: passthrough", () => {
    expect(
      composeFinalPrompt("a cat", [style({ prefix: "", suffix: "" })])
    ).toBe("a cat");
  });

  it("strips horizontal whitespace but preserves admin-authored newlines", () => {
    // Leading \n on suffix and trailing \n on prefix are intentional
    // (admin hit Shift+Enter) and bleed through as extra blank lines
    // around the user prompt. Horizontal spaces/tabs around each \n and
    // at the string edges are cleaned up.
    expect(
      composeFinalPrompt(
        "a cat",
        [style({ prefix: "  cinematic  \n", suffix: "\n 35mm " })]
      )
    ).toBe("cinematic\n\na cat\n\n35mm");
  });

  it("preserves interior newlines in prefix/suffix", () => {
    expect(
      composeFinalPrompt("a cat", [style({ prefix: "line1\nline2", suffix: "" })])
    ).toBe("line1\nline2\na cat");
  });

  it("preserves interior blank lines in a single part", () => {
    expect(
      composeFinalPrompt(
        "a cat",
        [style({ prefix: "para1\n\npara2", suffix: "" })]
      )
    ).toBe("para1\n\npara2\na cat");
  });

  it("admin-authored trailing newline in prefix adds blank line before user prompt", () => {
    // prefix "[STYLE GUIDE:\n" + join "\n" + userPrompt → blank line.
    expect(
      composeFinalPrompt("a cat", [style({ prefix: "[STYLE GUIDE:\n", suffix: "" })])
    ).toBe("[STYLE GUIDE:\n\na cat");
  });

  it("admin-authored leading newline in suffix adds blank line after user prompt", () => {
    expect(
      composeFinalPrompt("a cat", [style({ prefix: "", suffix: "\nend note" })])
    ).toBe("a cat\n\nend note");
  });

  it("stacked styles with trailing newlines stack their blank lines", () => {
    // First style ends with \n; the \n\n join between stacked prefixes
    // plus the trailing \n produces three consecutive \n (two blank
    // lines). Admin-controlled extra vertical room.
    const a = style({ id: "a", prefix: "[block A:\n", suffix: "" });
    const b = style({ id: "b", prefix: "[block B:", suffix: "" });
    expect(composeFinalPrompt("a cat", [a, b])).toBe(
      "[block A:\n\n\n[block B:\na cat"
    );
  });

  it("whitespace-only prefix (spaces, tabs, newlines mixed) is filtered", () => {
    expect(
      composeFinalPrompt(
        "a cat",
        [style({ prefix: " \n \t\n ", suffix: "35mm" })]
      )
    ).toBe("a cat\n35mm");
  });

  it("three styles — matryoshka order with blank line between stacked styles", () => {
    const kino = style({ id: "k", prefix: "cinematic", suffix: "35mm" });
    const threeD = style({ id: "3d", prefix: "3d render", suffix: "ray traced" });
    const groza = style({ id: "g", prefix: "storm", suffix: "lightning" });
    // prefixes joined with \n\n: "cinematic\n\n3d render\n\nstorm"
    // suffixes (reversed) joined with \n\n: "lightning\n\nray traced\n\n35mm"
    // glue: prefix-block \n userPrompt \n suffix-block
    expect(
      composeFinalPrompt("a cat", [kino, threeD, groza])
    ).toBe(
      "cinematic\n\n3d render\n\nstorm\na cat\nlightning\n\nray traced\n\n35mm"
    );
  });

  it("three styles — some parts empty, still filters correctly", () => {
    // kino has both; threeD has only prefix; groza has only suffix.
    const kino = style({ id: "k", prefix: "cinematic", suffix: "35mm" });
    const threeD = style({ id: "3d", prefix: "3d render", suffix: "" });
    const groza = style({ id: "g", prefix: "", suffix: "lightning" });
    // prefixes after filter joined: "cinematic\n\n3d render"
    // suffixes reversed+filter joined: "lightning\n\n35mm"
    expect(
      composeFinalPrompt("a cat", [kino, threeD, groza])
    ).toBe("cinematic\n\n3d render\na cat\nlightning\n\n35mm");
  });

  it("three styles — all prefixes and suffixes empty: passthrough", () => {
    const a = style({ id: "a" });
    const b = style({ id: "b" });
    const c = style({ id: "c" });
    expect(composeFinalPrompt("a cat", [a, b, c])).toBe("a cat");
  });

  it("two styles with whitespace-only parts are filtered", () => {
    expect(
      composeFinalPrompt(
        "a cat",
        [
          style({ id: "a", prefix: "   ", suffix: "35mm" }),
          style({ id: "b", prefix: "storm", suffix: "\n\n" }),
        ]
      )
    ).toBe("storm\na cat\n35mm");
  });

  it("empty user prompt + non-empty styles: collapses to blank line between parts", () => {
    expect(
      composeFinalPrompt("", [style({ prefix: "cinematic", suffix: "35mm" })])
    ).toBe("cinematic\n\n35mm");
  });
});
