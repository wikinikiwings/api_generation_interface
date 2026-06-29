import { describe, it, expect } from "vitest";
import { resolveWrappedPrompt, styleVersionsOf } from "@/lib/styles/resolve-wrapped";
import type { Style } from "@/lib/styles/types";

const mk = (id: string, prefix: string, suffix: string, updatedAt = "2026-01-01T00:00:00Z"): Style => ({
  id, name: id, prefix, suffix, createdAt: "2026-01-01T00:00:00Z", updatedAt,
});

describe("resolveWrappedPrompt", () => {
  it("returns userPrompt verbatim when no styles apply", () => {
    expect(resolveWrappedPrompt({ userPrompt: "hello", styleIds: [] }, [])).toBe("hello");
  });

  it("wraps userPrompt with a resolved attach-prefix style", () => {
    const styles = [mk("a", "TOP", "")];
    expect(resolveWrappedPrompt({ userPrompt: "hi", styleIds: ["a"] }, styles)).toBe("TOP\nhi");
  });

  it("drops missing style ids and wraps with the survivors", () => {
    const styles = [mk("a", "TOP", "")];
    expect(resolveWrappedPrompt({ userPrompt: "hi", styleIds: ["a", "gone"] }, styles)).toBe("TOP\nhi");
  });

  it("falls back to entry.prompt when userPrompt is absent (legacy)", () => {
    expect(resolveWrappedPrompt({ prompt: "legacy-wrapped" }, [])).toBe("legacy-wrapped");
  });
});

describe("styleVersionsOf", () => {
  it("maps id to updatedAt", () => {
    const styles = [mk("a", "", "", "2026-06-01T00:00:00Z"), mk("b", "", "", "2026-06-02T00:00:00Z")];
    expect(styleVersionsOf(styles)).toEqual({ a: "2026-06-01T00:00:00Z", b: "2026-06-02T00:00:00Z" });
  });
});
