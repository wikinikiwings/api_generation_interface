import { describe, it, expect, vi } from "vitest";
import { applyCopiedPrompt } from "../apply-copied";
import { DEFAULT_STYLE_ID, type Style } from "../types";

function makeStyle(overrides: Partial<Style>): Style {
  return {
    id: "kino-a3f",
    name: "Кино",
    prefix: "cinematic",
    suffix: "35mm",
    createdAt: "2026-04-15T00:00:00.000Z",
    updatedAt: "2026-04-15T00:00:00.000Z",
    ...overrides,
  };
}

function makeSetters() {
  return {
    setPrompt: vi.fn(),
    setSelectedStyleId: vi.fn(),
    toastInfo: vi.fn(),
    toastWarn: vi.fn(),
  };
}

describe("applyCopiedPrompt", () => {
  it("pre-feature entry: pastes entry.prompt, leaves dropdown alone", () => {
    const setters = makeSetters();
    applyCopiedPrompt(
      { prompt: "a cat", userPrompt: undefined, styleId: undefined },
      [],
      setters
    );
    expect(setters.setPrompt).toHaveBeenCalledWith("a cat");
    expect(setters.setSelectedStyleId).not.toHaveBeenCalled();
    expect(setters.toastInfo).toHaveBeenCalledWith("Промпт скопирован");
    expect(setters.toastWarn).not.toHaveBeenCalled();
  });

  it("default-style entry: pastes userPrompt, resets dropdown to default", () => {
    const setters = makeSetters();
    applyCopiedPrompt(
      { prompt: "a cat", userPrompt: "a cat", styleId: DEFAULT_STYLE_ID },
      [],
      setters
    );
    expect(setters.setPrompt).toHaveBeenCalledWith("a cat");
    expect(setters.setSelectedStyleId).toHaveBeenCalledWith(DEFAULT_STYLE_ID);
    expect(setters.toastInfo).toHaveBeenCalledWith("Промпт скопирован");
    expect(setters.toastWarn).not.toHaveBeenCalled();
  });

  it("existing-style entry: pastes userPrompt, sets dropdown, toast with style name", () => {
    const setters = makeSetters();
    const kino = makeStyle({});
    applyCopiedPrompt(
      {
        prompt: "cinematic. a cat. 35mm",
        userPrompt: "a cat",
        styleId: "kino-a3f",
      },
      [kino],
      setters
    );
    expect(setters.setPrompt).toHaveBeenCalledWith("a cat");
    expect(setters.setSelectedStyleId).toHaveBeenCalledWith("kino-a3f");
    expect(setters.toastInfo).toHaveBeenCalledWith(
      'Промпт скопирован, стиль «Кино» применён'
    );
    expect(setters.toastWarn).not.toHaveBeenCalled();
  });

  it("deleted-style entry: pastes wrapped prompt, resets dropdown, warning toast", () => {
    const setters = makeSetters();
    applyCopiedPrompt(
      {
        prompt: "cinematic. a cat. 35mm",
        userPrompt: "a cat",
        styleId: "kino-a3f",
      },
      [],
      setters
    );
    expect(setters.setPrompt).toHaveBeenCalledWith("cinematic. a cat. 35mm");
    expect(setters.setSelectedStyleId).toHaveBeenCalledWith(DEFAULT_STYLE_ID);
    expect(setters.toastInfo).not.toHaveBeenCalled();
    expect(setters.toastWarn).toHaveBeenCalledWith(
      "Стиль больше не существует, промпт вставлен как есть"
    );
  });

  it("falls back to entry.prompt when userPrompt is missing but styleId is default", () => {
    const setters = makeSetters();
    applyCopiedPrompt(
      { prompt: "a cat", userPrompt: undefined, styleId: DEFAULT_STYLE_ID },
      [],
      setters
    );
    expect(setters.setPrompt).toHaveBeenCalledWith("a cat");
    expect(setters.setSelectedStyleId).toHaveBeenCalledWith(DEFAULT_STYLE_ID);
  });
});
