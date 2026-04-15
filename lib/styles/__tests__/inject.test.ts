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
    ).toBe("cinematic. a cat. 35mm");
  });

  it("single style with empty prefix: no leading separator", () => {
    expect(
      composeFinalPrompt("a cat", [style({ prefix: "", suffix: "35mm" })])
    ).toBe("a cat. 35mm");
  });

  it("single style with empty suffix: no trailing separator", () => {
    expect(
      composeFinalPrompt("a cat", [style({ prefix: "cinematic", suffix: "" })])
    ).toBe("cinematic. a cat");
  });

  it("single style with empty prefix and suffix: passthrough", () => {
    expect(
      composeFinalPrompt("a cat", [style({ prefix: "", suffix: "" })])
    ).toBe("a cat");
  });

  it("trims whitespace on prefix and suffix at compose time", () => {
    expect(
      composeFinalPrompt(
        "a cat",
        [style({ prefix: "  cinematic  \n", suffix: "\n 35mm " })]
      )
    ).toBe("cinematic. a cat. 35mm");
  });

  it("preserves interior newlines in prefix/suffix", () => {
    expect(
      composeFinalPrompt("a cat", [style({ prefix: "line1\nline2", suffix: "" })])
    ).toBe("line1\nline2. a cat");
  });

  it("three styles — matryoshka order", () => {
    const kino = style({ id: "k", prefix: "cinematic", suffix: "35mm" });
    const threeD = style({ id: "3d", prefix: "3d render", suffix: "ray traced" });
    const groza = style({ id: "g", prefix: "storm", suffix: "lightning" });
    // activeStyles order: [kino, threeD, groza]
    // prefixes: cinematic, 3d render, storm
    // suffixes reversed: lightning, ray traced, 35mm
    expect(
      composeFinalPrompt("a cat", [kino, threeD, groza])
    ).toBe("cinematic. 3d render. storm. a cat. lightning. ray traced. 35mm");
  });

  it("three styles — some parts empty, still filters correctly", () => {
    // kino has both; threeD has only prefix; groza has only suffix.
    const kino = style({ id: "k", prefix: "cinematic", suffix: "35mm" });
    const threeD = style({ id: "3d", prefix: "3d render", suffix: "" });
    const groza = style({ id: "g", prefix: "", suffix: "lightning" });
    // prefixes after filter: cinematic, 3d render
    // suffixes reversed+filter: lightning, 35mm
    expect(
      composeFinalPrompt("a cat", [kino, threeD, groza])
    ).toBe("cinematic. 3d render. a cat. lightning. 35mm");
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
    ).toBe("storm. a cat. 35mm");
  });

  it("empty user prompt + non-empty styles: still wraps around empty middle", () => {
    expect(
      composeFinalPrompt("", [style({ prefix: "cinematic", suffix: "35mm" })])
    ).toBe("cinematic. . 35mm");
  });
});
