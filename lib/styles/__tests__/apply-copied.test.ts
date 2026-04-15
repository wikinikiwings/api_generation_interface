import { describe, it, expect, vi } from "vitest";
import { applyCopiedPrompt, joinStyleNames } from "../apply-copied";
import type { Style } from "../types";

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
    setSelectedStyleIds: vi.fn(),
    toastInfo: vi.fn(),
    toastWarn: vi.fn(),
  };
}

describe("joinStyleNames", () => {
  it("joins names with ' + ' in order", () => {
    const kino = makeStyle({ id: "k", name: "Кино" });
    const groza = makeStyle({ id: "g", name: "Гроза" });
    expect(joinStyleNames(["k", "g"], [kino, groza])).toBe("Кино + Гроза");
  });

  it("falls back to raw id when a style is missing", () => {
    const kino = makeStyle({ id: "k", name: "Кино" });
    expect(joinStyleNames(["k", "unknown"], [kino])).toBe("Кино + unknown");
  });

  it("returns empty string for empty ids", () => {
    expect(joinStyleNames([], [])).toBe("");
  });
});

describe("applyCopiedPrompt", () => {
  it("pre-feature entry: pastes entry.prompt, leaves selection alone", () => {
    const setters = makeSetters();
    applyCopiedPrompt(
      { prompt: "a cat", userPrompt: undefined, styleIds: undefined },
      [],
      setters
    );
    expect(setters.setPrompt).toHaveBeenCalledWith("a cat");
    expect(setters.setSelectedStyleIds).not.toHaveBeenCalled();
    expect(setters.toastInfo).toHaveBeenCalledWith("Промпт скопирован");
    expect(setters.toastWarn).not.toHaveBeenCalled();
  });

  it("default entry (empty array): pastes userPrompt, clears selection", () => {
    const setters = makeSetters();
    applyCopiedPrompt(
      { prompt: "a cat", userPrompt: "a cat", styleIds: [] },
      [],
      setters
    );
    expect(setters.setPrompt).toHaveBeenCalledWith("a cat");
    expect(setters.setSelectedStyleIds).toHaveBeenCalledWith([]);
    expect(setters.toastInfo).toHaveBeenCalledWith("Промпт скопирован");
    expect(setters.toastWarn).not.toHaveBeenCalled();
  });

  it("single existing style: pastes userPrompt, sets selection, singular toast", () => {
    const setters = makeSetters();
    const kino = makeStyle({ id: "k", name: "Кино" });
    applyCopiedPrompt(
      {
        prompt: "cinematic. a cat. 35mm",
        userPrompt: "a cat",
        styleIds: ["k"],
      },
      [kino],
      setters
    );
    expect(setters.setPrompt).toHaveBeenCalledWith("a cat");
    expect(setters.setSelectedStyleIds).toHaveBeenCalledWith(["k"]);
    expect(setters.toastInfo).toHaveBeenCalledWith(
      "Промпт скопирован, стиль «Кино» применён"
    );
  });

  it("multiple existing styles: plural toast with joined names", () => {
    const setters = makeSetters();
    const kino = makeStyle({ id: "k", name: "Кино" });
    const threeD = makeStyle({ id: "d", name: "3D" });
    const groza = makeStyle({ id: "g", name: "Гроза" });
    applyCopiedPrompt(
      {
        prompt: "cinematic. 3d. storm. a cat. lightning. ray. 35mm",
        userPrompt: "a cat",
        styleIds: ["k", "d", "g"],
      },
      [kino, threeD, groza],
      setters
    );
    expect(setters.setPrompt).toHaveBeenCalledWith("a cat");
    expect(setters.setSelectedStyleIds).toHaveBeenCalledWith(["k", "d", "g"]);
    expect(setters.toastInfo).toHaveBeenCalledWith(
      "Промпт скопирован, стили «Кино + 3D + Гроза» применены"
    );
  });

  it("one of several deleted: full fallback with id-named warning", () => {
    const setters = makeSetters();
    const kino = makeStyle({ id: "k", name: "Кино" });
    applyCopiedPrompt(
      {
        prompt: "cinematic. a cat. 35mm",
        userPrompt: "a cat",
        styleIds: ["k", "deleted-b12"],
      },
      [kino], // "deleted-b12" not in list
      setters
    );
    expect(setters.setPrompt).toHaveBeenCalledWith("cinematic. a cat. 35mm");
    expect(setters.setSelectedStyleIds).toHaveBeenCalledWith([]);
    expect(setters.toastWarn).toHaveBeenCalledWith(
      "Стиль «deleted-b12» удалён, промпт вставлен как есть"
    );
    expect(setters.toastInfo).not.toHaveBeenCalled();
  });

  it("multiple deleted: generic plural warning", () => {
    const setters = makeSetters();
    const kino = makeStyle({ id: "k", name: "Кино" });
    applyCopiedPrompt(
      {
        prompt: "complex. a cat. wrap",
        userPrompt: "a cat",
        styleIds: ["k", "gone-1", "gone-2"],
      },
      [kino],
      setters
    );
    expect(setters.setPrompt).toHaveBeenCalledWith("complex. a cat. wrap");
    expect(setters.setSelectedStyleIds).toHaveBeenCalledWith([]);
    expect(setters.toastWarn).toHaveBeenCalledWith(
      "Некоторые стили удалены, промпт вставлен как есть"
    );
  });

  it("single style with userPrompt undefined falls back to entry.prompt", () => {
    const setters = makeSetters();
    applyCopiedPrompt(
      { prompt: "a cat", userPrompt: undefined, styleIds: [] },
      [],
      setters
    );
    expect(setters.setPrompt).toHaveBeenCalledWith("a cat");
    expect(setters.setSelectedStyleIds).toHaveBeenCalledWith([]);
  });
});
