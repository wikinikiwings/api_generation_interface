import { describe, it, expect } from "vitest";
import { mergeZoneReorder } from "../prompt-preview-dialog";

describe("mergeZoneReorder", () => {
  it("reorders a zone subset inside the flat list, preserving non-zone positions", () => {
    // flat: [w1, pre, w2, neg, w3] — reorder the wrap zone [w1, w2, w3] → [w3, w1, w2]
    const flat = ["w1", "pre", "w2", "neg", "w3"];
    const reorderedZone = ["w3", "w1", "w2"];
    expect(mergeZoneReorder(flat, reorderedZone)).toEqual([
      "w3",
      "pre",
      "w1",
      "neg",
      "w2",
    ]);
  });

  it("reordering attach-suffix does not move wrap or attach-prefix entries", () => {
    const flat = ["pre", "w1", "negA", "w2", "negB"];
    const reorderedZone = ["negB", "negA"];
    expect(mergeZoneReorder(flat, reorderedZone)).toEqual([
      "pre",
      "w1",
      "negB",
      "w2",
      "negA",
    ]);
  });

  it("preserves length and set-equality of the flat list", () => {
    const flat = ["a", "b", "c", "d", "e"];
    const reorderedZone = ["d", "b"];
    const out = mergeZoneReorder(flat, reorderedZone);
    expect(out).toHaveLength(flat.length);
    expect(new Set(out)).toEqual(new Set(flat));
  });

  it("single-element zone is a no-op", () => {
    const flat = ["a", "b", "c"];
    expect(mergeZoneReorder(flat, ["b"])).toEqual(["a", "b", "c"]);
  });

  it("empty zone returns the flat list unchanged", () => {
    const flat = ["a", "b", "c"];
    expect(mergeZoneReorder(flat, [])).toEqual(["a", "b", "c"]);
  });
});
