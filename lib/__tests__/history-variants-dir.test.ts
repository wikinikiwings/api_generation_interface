/** @vitest-environment node */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";

let tmp: string;
let prevImagesDataDir: string | undefined;
let prevVariantsDir: string | undefined;

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "variants-dir-test-"));
  prevImagesDataDir = process.env.HISTORY_DATA_DIR;
  prevVariantsDir = process.env.HISTORY_VARIANTS_DIR;
  vi.resetModules();
});
afterEach(async () => {
  if (prevImagesDataDir === undefined) delete process.env.HISTORY_DATA_DIR;
  else process.env.HISTORY_DATA_DIR = prevImagesDataDir;
  if (prevVariantsDir === undefined) delete process.env.HISTORY_VARIANTS_DIR;
  else process.env.HISTORY_VARIANTS_DIR = prevVariantsDir;
  await fs.rm(tmp, { recursive: true, force: true });
});

describe("getHistoryVariantsDir", () => {
  it("defaults to <DATA_DIR>/history_variants/ and creates the dir", async () => {
    process.env.HISTORY_DATA_DIR = tmp;
    delete process.env.HISTORY_VARIANTS_DIR;
    const mod = await import("@/lib/history-db");
    const dir = mod.getHistoryVariantsDir();
    expect(dir).toBe(path.join(tmp, "history_variants"));
    await expect(fs.access(dir)).resolves.toBeUndefined();
  });

  it("honours HISTORY_VARIANTS_DIR override and creates that dir", async () => {
    process.env.HISTORY_DATA_DIR = tmp;
    const customDir = path.join(tmp, "custom_variants_root");
    process.env.HISTORY_VARIANTS_DIR = customDir;
    const mod = await import("@/lib/history-db");
    const dir = mod.getHistoryVariantsDir();
    expect(dir).toBe(customDir);
    await expect(fs.access(dir)).resolves.toBeUndefined();
  });
});
