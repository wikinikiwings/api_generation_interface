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

import {
  needsAggregatePass2,
  collectPass2Candidates,
  MAX_AGGREGATE_BYTES,
} from "@/lib/image-optimize";
import type { OptimizeFileResult, OptimizeResult } from "@/lib/image-optimize";

function mkResult(over: Partial<OptimizeFileResult>): OptimizeFileResult {
  return {
    file: new File([], "x"),
    wasOptimized: false,
    originalBytes: 0,
    newBytes: 0,
    originalDims: { width: 0, height: 0 },
    newDims: { width: 0, height: 0 },
    hasAlpha: false,
    pass: 0,
    ...over,
  };
}

describe("needsAggregatePass2", () => {
  it("returns false when sum is under cap", () => {
    const rs = [
      mkResult({ file: new File([new Uint8Array(10_000_000)], "a") }),
      mkResult({ file: new File([new Uint8Array(10_000_000)], "b") }),
    ];
    expect(needsAggregatePass2(rs)).toBe(false);
  });
  it("returns true when sum exceeds MAX_AGGREGATE_BYTES", () => {
    const big = new Uint8Array(MAX_AGGREGATE_BYTES + 1);
    const rs = [mkResult({ file: new File([big], "big") })];
    expect(needsAggregatePass2(rs)).toBe(true);
  });
});

describe("collectPass2Candidates", () => {
  it("excludes untouched files (wasOptimized=false)", () => {
    const a = mkResult({ wasOptimized: false });
    const b = mkResult({
      wasOptimized: true,
      hasAlpha: false,
      file: new File([new Uint8Array(5_000_000)], "b"),
    });
    const { indices } = collectPass2Candidates([a, b]);
    expect(indices).toEqual([1]);
  });
  it("excludes alpha-PNGs below 4 MB", () => {
    const small = mkResult({
      wasOptimized: true,
      hasAlpha: true,
      file: new File([new Uint8Array(3_000_000)], "small"),
    });
    const big = mkResult({
      wasOptimized: true,
      hasAlpha: true,
      file: new File([new Uint8Array(6_000_000)], "big"),
    });
    const { indices } = collectPass2Candidates([small, big]);
    expect(indices).toEqual([1]);
  });
  it("includes all sized JPEG-output entries", () => {
    const a = mkResult({
      wasOptimized: true,
      hasAlpha: false,
      file: new File([new Uint8Array(100_000)], "a"),
    });
    const b = mkResult({
      wasOptimized: true,
      hasAlpha: false,
      file: new File([new Uint8Array(8_000_000)], "b"),
    });
    const { indices } = collectPass2Candidates([a, b]);
    expect(indices).toEqual([0, 1]);
  });
});

import { buildSuccessMessage, plural } from "@/lib/image-optimize";

describe("plural", () => {
  it("returns the correct Russian form", () => {
    expect(plural(1)).toBe("изображение");
    expect(plural(2)).toBe("изображения");
    expect(plural(3)).toBe("изображения");
    expect(plural(4)).toBe("изображения");
    expect(plural(5)).toBe("изображений");
    expect(plural(11)).toBe("изображений");
    expect(plural(21)).toBe("изображение");
    expect(plural(22)).toBe("изображения");
    expect(plural(25)).toBe("изображений");
  });
});

describe("buildSuccessMessage", () => {
  it("formats the no-optimization case", () => {
    const r: OptimizeResult = {
      files: [new File([], "a")],
      results: [mkResult({})],
      errors: [],
      aggregatePass2Triggered: false,
    };
    expect(buildSuccessMessage(r, 3)).toBe("Добавлено: 3");
  });

  it("formats the single-optimization-in-small-batch case with dims", () => {
    const r: OptimizeResult = {
      files: [new File([], "a"), new File([], "b")],
      results: [
        mkResult({ wasOptimized: false }),
        mkResult({
          wasOptimized: true,
          originalDims: { width: 8000, height: 6000 },
          newDims: { width: 4096, height: 3072 },
        }),
      ],
      errors: [],
      aggregatePass2Triggered: false,
    };
    expect(buildSuccessMessage(r, 2)).toBe(
      "1 из 2 оптимизирована: 8000×6000 → 4096×3072"
    );
  });

  it("formats the many-optimized case", () => {
    const results = Array.from({ length: 10 }, () =>
      mkResult({ wasOptimized: true })
    );
    const r: OptimizeResult = {
      files: results.map((x) => x.file),
      results,
      errors: [],
      aggregatePass2Triggered: false,
    };
    expect(buildSuccessMessage(r, 10)).toBe("Оптимизировано: 10 из 10");
  });
});
