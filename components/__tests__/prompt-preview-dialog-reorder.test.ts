import { describe, it, expect } from "vitest";
import { reorderStyleIds } from "@/lib/styles/reorder";

describe("reorderStyleIds", () => {
  it("returns null when overId is null (drop outside)", () => {
    expect(reorderStyleIds(["a", "b", "c"], "a", null)).toBeNull();
  });

  it("returns null when activeId === overId (dropped on self)", () => {
    expect(reorderStyleIds(["a", "b", "c"], "b", "b")).toBeNull();
  });

  it("returns null when activeId is not in the list", () => {
    expect(reorderStyleIds(["a", "b", "c"], "z", "b")).toBeNull();
  });

  it("returns null when overId is not in the list", () => {
    expect(reorderStyleIds(["a", "b", "c"], "a", "z")).toBeNull();
  });

  it("moves forward: [a,b,c] active=a over=c → [b,c,a]", () => {
    expect(reorderStyleIds(["a", "b", "c"], "a", "c")).toEqual(["b", "c", "a"]);
  });

  it("moves backward: [a,b,c] active=c over=a → [c,a,b]", () => {
    expect(reorderStyleIds(["a", "b", "c"], "c", "a")).toEqual(["c", "a", "b"]);
  });

  it("swap adjacent: [a,b,c] active=a over=b → [b,a,c]", () => {
    expect(reorderStyleIds(["a", "b", "c"], "a", "b")).toEqual(["b", "a", "c"]);
  });

  it("preserves length and set-equality", () => {
    const before = ["a", "b", "c", "d"];
    const after = reorderStyleIds(before, "b", "d");
    expect(after).not.toBeNull();
    expect(after!.length).toBe(before.length);
    expect([...after!].sort()).toEqual([...before].sort());
  });

  it("does not mutate the input array", () => {
    const input = ["a", "b", "c"];
    const snapshot = [...input];
    reorderStyleIds(input, "a", "c");
    expect(input).toEqual(snapshot);
  });

  it("single-element list: dropping on self is a no-op", () => {
    expect(reorderStyleIds(["only"], "only", "only")).toBeNull();
  });
});
