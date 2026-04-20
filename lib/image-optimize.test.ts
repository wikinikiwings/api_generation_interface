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

import {
  needsOptimizeByTriggers,
  computeTargetDims,
  renameForOptimized,
  MAX_LONG_SIDE,
} from "@/lib/image-optimize";

describe("needsOptimizeByTriggers", () => {
  it("returns false when both size and longSide are under the caps", () => {
    expect(needsOptimizeByTriggers(5 * 1024 * 1024, 1920, 1080)).toBe(false);
  });
  it("returns true when longSide exceeds MAX_LONG_SIDE", () => {
    expect(needsOptimizeByTriggers(1 * 1024 * 1024, 8000, 6000)).toBe(true);
    expect(needsOptimizeByTriggers(1 * 1024 * 1024, 4097, 100)).toBe(true);
  });
  it("returns true when bytes exceed MAX_FILE_BYTES even if pixels are small", () => {
    expect(needsOptimizeByTriggers(13 * 1024 * 1024, 2000, 2000)).toBe(true);
  });
  it("returns false exactly at the boundaries", () => {
    expect(needsOptimizeByTriggers(12 * 1024 * 1024, 4096, 4096)).toBe(false);
  });
});

describe("computeTargetDims", () => {
  it("keeps original dims when longSide is under cap", () => {
    expect(computeTargetDims(1920, 1080, 4096)).toEqual({ width: 1920, height: 1080 });
  });
  it("scales landscape down so long side = cap", () => {
    expect(computeTargetDims(8000, 6000, 4096)).toEqual({ width: 4096, height: 3072 });
  });
  it("scales portrait down so long side = cap", () => {
    expect(computeTargetDims(6000, 8000, 4096)).toEqual({ width: 3072, height: 4096 });
  });
  it("rounds to integer pixels", () => {
    const r = computeTargetDims(4500, 3000, 4096);
    expect(Number.isInteger(r.width)).toBe(true);
    expect(Number.isInteger(r.height)).toBe(true);
  });
  it("uses the pass-2 cap when passed", () => {
    expect(computeTargetDims(8000, 6000, 3072)).toEqual({ width: 3072, height: 2304 });
  });
});

describe("renameForOptimized", () => {
  it("appends -opt before the extension when format is preserved", () => {
    expect(renameForOptimized("photo.png", "image/png")).toBe("photo-opt.png");
    expect(renameForOptimized("pic.webp", "image/webp")).toBe("pic-opt.webp");
  });
  it("changes the extension when the output type differs", () => {
    expect(renameForOptimized("photo.png", "image/jpeg")).toBe("photo-opt.jpg");
    expect(renameForOptimized("shot.PNG", "image/jpeg")).toBe("shot-opt.jpg");
  });
  it("handles names without an extension", () => {
    expect(renameForOptimized("image", "image/jpeg")).toBe("image-opt.jpg");
  });
  it("keeps dotted base names intact", () => {
    expect(renameForOptimized("some.name.v2.png", "image/jpeg")).toBe("some.name.v2-opt.jpg");
  });
});
