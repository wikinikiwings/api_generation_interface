import { describe, it, expect, vi } from "vitest";
import { runPool } from "@/lib/image-optimize";

describe("runPool", () => {
  it("processes all items and preserves index order in the result", async () => {
    const items = ["a", "b", "c", "d", "e"];
    const worker = vi.fn(async (item: string, i: number) => `${i}:${item}`);
    const out = await runPool(items, 2, worker);
    expect(out).toEqual(["0:a", "1:b", "2:c", "3:d", "4:e"]);
    expect(worker).toHaveBeenCalledTimes(5);
  });

  it("caps concurrency to the given value", async () => {
    let running = 0;
    let peak = 0;
    const worker = async () => {
      running++;
      peak = Math.max(peak, running);
      await new Promise((r) => setTimeout(r, 10));
      running--;
      return null;
    };
    await runPool([1, 2, 3, 4, 5, 6, 7, 8], 3, worker);
    expect(peak).toBeLessThanOrEqual(3);
    expect(peak).toBeGreaterThan(0);
  });

  it("returns empty array for empty input without invoking worker", async () => {
    const worker = vi.fn();
    const out = await runPool([], 4, worker);
    expect(out).toEqual([]);
    expect(worker).not.toHaveBeenCalled();
  });

  it("propagates a worker rejection", async () => {
    const worker = async (item: number) => {
      if (item === 2) throw new Error("boom");
      return item * 10;
    };
    await expect(runPool([1, 2, 3], 2, worker)).rejects.toThrow("boom");
  });
});
