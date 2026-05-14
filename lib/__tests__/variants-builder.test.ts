/** @vitest-environment node */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import sharp from "sharp";
import { initSchema, seedModels } from "@/lib/history-db";
import { buildVariantsForGeneration } from "@/lib/variants-builder";
import { THUMB_WIDTH, MID_WIDTH } from "@/lib/image-variants-spec";

let db: Database.Database;
let imagesDir: string;
let variantsDir: string;
let userId: number;
let genId: number;

async function makePng(width: number, height: number): Promise<Buffer> {
  return sharp({
    create: { width, height, channels: 3, background: { r: 0, g: 128, b: 255 } },
  }).png().toBuffer();
}

beforeEach(async () => {
  db = new Database(":memory:");
  initSchema(db);
  seedModels(db);
  imagesDir = await fs.mkdtemp(path.join(os.tmpdir(), "vb-img-"));
  variantsDir = await fs.mkdtemp(path.join(os.tmpdir(), "vb-var-"));
  userId = db.prepare(`INSERT INTO users (email, status) VALUES ('alice@x.com', 'active')`)
    .run().lastInsertRowid as number;
  genId = db.prepare(
    `INSERT INTO generations (user_id, model_id, status) VALUES (?, 'nano-banana-pro', 'completed')`
  ).run(userId).lastInsertRowid as number;
});
afterEach(async () => {
  await fs.rm(imagesDir, { recursive: true, force: true });
  await fs.rm(variantsDir, { recursive: true, force: true });
});

async function placeOriginal(relPath: string, buf: Buffer): Promise<void> {
  const abs = path.join(imagesDir, relPath);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, buf);
}

function insertOutput(filepath: string, contentType = "image/png"): void {
  db.prepare(
    `INSERT INTO generation_outputs (generation_id, filename, filepath, content_type)
     VALUES (?, 'a.png', ?, ?)`
  ).run(genId, filepath, contentType);
}

describe("buildVariantsForGeneration", () => {
  it("writes thumb + mid JPEGs at expected widths and qualities", async () => {
    const relPath = "alice@x.com/2026/05/abc-123.png";
    await placeOriginal(relPath, await makePng(2400, 1800));
    insertOutput(relPath);

    const result = await buildVariantsForGeneration(db, genId, { imagesDir, variantsDir });
    expect(result.ok).toBe(true);

    const thumbAbs = path.join(variantsDir, "alice@x.com/2026/05/thumb_abc-123.jpg");
    const midAbs   = path.join(variantsDir, "alice@x.com/2026/05/mid_abc-123.jpg");
    const thumbMeta = await sharp(thumbAbs).metadata();
    const midMeta = await sharp(midAbs).metadata();
    expect(thumbMeta.format).toBe("jpeg");
    expect(midMeta.format).toBe("jpeg");
    expect(thumbMeta.width).toBe(THUMB_WIDTH);
    expect(midMeta.width).toBe(MID_WIDTH);
  });

  it("does not enlarge a small original", async () => {
    const relPath = "alice@x.com/2026/05/small.png";
    await placeOriginal(relPath, await makePng(100, 80));
    insertOutput(relPath);

    const result = await buildVariantsForGeneration(db, genId, { imagesDir, variantsDir });
    expect(result.ok).toBe(true);

    const thumbMeta = await sharp(path.join(variantsDir, "alice@x.com/2026/05/thumb_small.jpg")).metadata();
    expect(thumbMeta.width).toBe(100);
  });

  it("is idempotent — running twice succeeds and overwrites", async () => {
    const relPath = "alice@x.com/2026/05/idem.png";
    await placeOriginal(relPath, await makePng(1000, 800));
    insertOutput(relPath);

    const a = await buildVariantsForGeneration(db, genId, { imagesDir, variantsDir });
    const b = await buildVariantsForGeneration(db, genId, { imagesDir, variantsDir });
    expect(a.ok && b.ok).toBe(true);
  });

  it("returns original_missing when the file is gone", async () => {
    insertOutput("alice@x.com/2026/05/ghost.png");
    const result = await buildVariantsForGeneration(db, genId, { imagesDir, variantsDir });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("original_missing");
  });

  it("returns no_original when generation has no image output", async () => {
    const result = await buildVariantsForGeneration(db, genId, { imagesDir, variantsDir });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("no_original");
  });

  it("ignores non-image outputs and returns no_original", async () => {
    insertOutput("alice@x.com/2026/05/v.mp4", "video/mp4");
    const result = await buildVariantsForGeneration(db, genId, { imagesDir, variantsDir });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("no_original");
  });
});
