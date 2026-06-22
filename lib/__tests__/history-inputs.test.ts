import { describe, it, expect } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import {
  MAX_INPUT_IMAGES,
  inputImageFilename,
  inputThumbFilename,
  isInputAsset,
  extFromContentType,
  writeInputAssets,
} from "@/lib/history-inputs";

const UUID = "0123abcd-4567-89ab-cdef-0123456789ab";

describe("input filename helpers", () => {
  it("caps at 14", () => expect(MAX_INPUT_IMAGES).toBe(14));

  it("builds full and thumb names", () => {
    expect(inputImageFilename(UUID, 0, "png")).toBe(`input_${UUID}_0.png`);
    expect(inputThumbFilename(UUID, 2)).toBe(`input_thumb_${UUID}_2.jpg`);
  });

  it("recognizes full and thumb assets, rejects others", () => {
    expect(isInputAsset(`input_${UUID}_0.png`)).toBe(true);
    expect(isInputAsset(`input_thumb_${UUID}_0.jpg`)).toBe(true);
    expect(isInputAsset(`thumb_${UUID}.jpg`)).toBe(false);
    expect(isInputAsset(`${UUID}.png`)).toBe(false);
  });

  it("maps content types to extensions", () => {
    expect(extFromContentType("image/png")).toBe("png");
    expect(extFromContentType("image/jpeg")).toBe("jpg");
    expect(extFromContentType("image/webp")).toBe("webp");
    expect(extFromContentType("application/octet-stream")).toBe("jpg");
  });
});

describe("writeInputAssets", () => {
  it("writes full+thumb per item and returns rel paths in order", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "inputs-"));
    const relDir = "alice@x.com/2026/06";
    const res = await writeInputAssets(root, relDir, UUID, [
      { thumb: Buffer.from("t0"), full: { buffer: Buffer.from("f0"), ext: "png" } },
      { thumb: Buffer.from("t1"), full: { buffer: Buffer.from("f1"), ext: "webp" } },
    ]);
    expect(res.thumbs).toEqual([
      `${relDir}/input_thumb_${UUID}_0.jpg`,
      `${relDir}/input_thumb_${UUID}_1.jpg`,
    ]);
    expect(res.images).toEqual([
      `${relDir}/input_${UUID}_0.png`,
      `${relDir}/input_${UUID}_1.webp`,
    ]);
    expect((await fs.readFile(path.join(root, relDir, `input_${UUID}_1.webp`))).toString()).toBe("f1");
    expect((await fs.readFile(path.join(root, relDir, `input_thumb_${UUID}_0.jpg`))).toString()).toBe("t0");
  });

  it("supports thumb-only items (legacy backfill) → images[i] null", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "inputs-"));
    const res = await writeInputAssets(root, "alice@x.com/2026/06", UUID, [{ thumb: Buffer.from("t") }]);
    expect(res.thumbs).toEqual([`alice@x.com/2026/06/input_thumb_${UUID}_0.jpg`]);
    expect(res.images).toEqual([null]);
  });

  it("returns empty arrays for no items", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "inputs-"));
    const res = await writeInputAssets(root, "alice@x.com/2026/06", UUID, []);
    expect(res).toEqual({ thumbs: [], images: [] });
  });
});
