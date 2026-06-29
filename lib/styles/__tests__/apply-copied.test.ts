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

  it("one of several deleted: degrade to userPrompt, keep survivors, id-named warning", () => {
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
    expect(setters.setPrompt).toHaveBeenCalledWith("a cat");
    expect(setters.setSelectedStyleIds).toHaveBeenCalledWith(["k"]);
    expect(setters.toastWarn).toHaveBeenCalledWith(
      "Стиль «deleted-b12» удалён, применены остальные"
    );
    expect(setters.toastInfo).not.toHaveBeenCalled();
  });

  it("multiple deleted: degrade to userPrompt, keep survivors, generic plural warning", () => {
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
    expect(setters.setPrompt).toHaveBeenCalledWith("a cat");
    expect(setters.setSelectedStyleIds).toHaveBeenCalledWith(["k"]);
    expect(setters.toastWarn).toHaveBeenCalledWith(
      "Некоторые стили удалены, применены остальные"
    );
  });

  it("appends a 'style changed' note when updatedAt differs from styleVersions", () => {
    const styles = [{ id: "a", name: "Кино", prefix: "P", suffix: "", createdAt: "x", updatedAt: "2026-06-02T00:00:00Z" }];
    const setters = { setPrompt: vi.fn(), setSelectedStyleIds: vi.fn(), toastInfo: vi.fn(), toastWarn: vi.fn() };
    applyCopiedPrompt(
      { prompt: "ignored", userPrompt: "hi", styleIds: ["a"], styleVersions: { a: "2026-06-01T00:00:00Z" } },
      styles,
      setters
    );
    expect(setters.setPrompt).toHaveBeenCalledWith("hi");
    expect(setters.setSelectedStyleIds).toHaveBeenCalledWith(["a"]);
    expect(setters.toastInfo).toHaveBeenCalledWith(expect.stringContaining("изменён"));
  });

  it("does NOT append the note when styleVersions matches", () => {
    const styles = [{ id: "a", name: "Кино", prefix: "P", suffix: "", createdAt: "x", updatedAt: "2026-06-01T00:00:00Z" }];
    const setters = { setPrompt: vi.fn(), setSelectedStyleIds: vi.fn(), toastInfo: vi.fn(), toastWarn: vi.fn() };
    applyCopiedPrompt(
      { prompt: "ignored", userPrompt: "hi", styleIds: ["a"], styleVersions: { a: "2026-06-01T00:00:00Z" } },
      styles,
      setters
    );
    expect(setters.toastInfo).toHaveBeenCalledWith(expect.not.stringContaining("изменён"));
  });

  it("on a deleted style: pastes userPrompt and selects only the survivors", () => {
    const styles = [{ id: "a", name: "Кино", prefix: "P", suffix: "", createdAt: "x", updatedAt: "y" }];
    const setters = { setPrompt: vi.fn(), setSelectedStyleIds: vi.fn(), toastInfo: vi.fn(), toastWarn: vi.fn() };
    applyCopiedPrompt(
      { prompt: "wrapped-old", userPrompt: "hi", styleIds: ["a", "gone"] },
      styles,
      setters
    );
    expect(setters.setPrompt).toHaveBeenCalledWith("hi");
    expect(setters.setSelectedStyleIds).toHaveBeenCalledWith(["a"]);
    expect(setters.toastWarn).toHaveBeenCalled();
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
