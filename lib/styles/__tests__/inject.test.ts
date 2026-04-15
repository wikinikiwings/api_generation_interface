import { describe, it, expect } from "vitest";
import { composeFinalPrompt } from "../inject";
import { DEFAULT_STYLE_ID, type Style } from "../types";

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
  it("returns the user prompt unchanged when style is null", () => {
    expect(composeFinalPrompt("a cat", null)).toBe("a cat");
  });

  it("returns the user prompt unchanged for the default style id", () => {
    expect(
      composeFinalPrompt("a cat", style({ id: DEFAULT_STYLE_ID }))
    ).toBe("a cat");
  });

  it("returns the user prompt unchanged when prefix and suffix are empty", () => {
    expect(composeFinalPrompt("a cat", style({ prefix: "", suffix: "" }))).toBe(
      "a cat"
    );
  });

  it("joins prefix + prompt + suffix with '. '", () => {
    expect(
      composeFinalPrompt("a cat", style({ prefix: "cinematic", suffix: "35mm" }))
    ).toBe("cinematic. a cat. 35mm");
  });

  it("omits empty prefix without leaving a leading separator", () => {
    expect(
      composeFinalPrompt("a cat", style({ prefix: "", suffix: "35mm" }))
    ).toBe("a cat. 35mm");
  });

  it("omits empty suffix without leaving a trailing separator", () => {
    expect(
      composeFinalPrompt("a cat", style({ prefix: "cinematic", suffix: "" }))
    ).toBe("cinematic. a cat");
  });

  it("trims leading/trailing whitespace on prefix and suffix", () => {
    expect(
      composeFinalPrompt(
        "a cat",
        style({ prefix: "  cinematic  \n", suffix: "\n 35mm " })
      )
    ).toBe("cinematic. a cat. 35mm");
  });

  it("preserves interior newlines in prefix/suffix", () => {
    expect(
      composeFinalPrompt(
        "a cat",
        style({ prefix: "line1\nline2", suffix: "" })
      )
    ).toBe("line1\nline2. a cat");
  });

  it("returns empty string when both user prompt and style are empty", () => {
    expect(composeFinalPrompt("", style({ prefix: "", suffix: "" }))).toBe("");
  });

  it("still wraps when user prompt is empty but style is not", () => {
    expect(
      composeFinalPrompt("", style({ prefix: "cinematic", suffix: "35mm" }))
    ).toBe("cinematic. . 35mm");
  });
});
