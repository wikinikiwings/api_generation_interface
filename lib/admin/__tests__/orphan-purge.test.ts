/** @vitest-environment node */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { initSchema } from "@/lib/history-db";
import { scanOrphans, purgeOrphans } from "../orphan-purge";

let db: Database.Database;
let imagesDir: string;
let userId: number;

async function seedFile(rel: string, bytes = "x") {
  const abs = path.join(imagesDir, rel);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, bytes);
}

function insertGenWithOutput(filepath: string, ct = "image/png"): number {
  const genId = db
    .prepare(`INSERT INTO generations (user_id, status) VALUES (?, 'completed')`)
    .run(userId).lastInsertRowid as number;
  db.prepare(
    `INSERT INTO generation_outputs (generation_id, filename, filepath, content_type)
     VALUES (?, 'a.png', ?, ?)`
  ).run(genId, filepath, ct);
  return genId;
}

beforeEach(async () => {
  db = new Database(":memory:");
  initSchema(db);
  imagesDir = await fs.mkdtemp(path.join(os.tmpdir(), "orphan-test-"));
  userId = db
    .prepare(`INSERT INTO users (email, status) VALUES ('alice@x.com', 'active')`)
    .run().lastInsertRowid as number;
});

afterEach(async () => {
  await fs.rm(imagesDir, { recursive: true, force: true });
});

describe("scanOrphans", () => {
  it("returns 0 on empty root", async () => {
    const r = await scanOrphans(db, imagesDir);
    expect(r.count).toBe(0);
    expect(r.files).toEqual([]);
  });

  it("file referenced in generation_outputs is not an orphan", async () => {
    const id = "11111111-1111-1111-1111-111111111111";
    await seedFile(`alice@x.com/2026/05/${id}.png`);
    insertGenWithOutput(`alice@x.com/2026/05/${id}.png`);
    const r = await scanOrphans(db, imagesDir);
    expect(r.count).toBe(0);
  });

  it("file not in DB is an orphan", async () => {
    const id = "22222222-2222-2222-2222-222222222222";
    await seedFile(`alice@x.com/2026/05/${id}.png`);
    const r = await scanOrphans(db, imagesDir);
    expect(r.count).toBe(1);
    expect(r.files).toEqual([`alice@x.com/2026/05/${id}.png`]);
  });

  it("thumb_/mid_ files are ignored even if not referenced", async () => {
    const id = "33333333-3333-3333-3333-333333333333";
    await seedFile(`alice@x.com/2026/05/thumb_${id}.jpg`);
    await seedFile(`alice@x.com/2026/05/mid_${id}.jpg`);
    const r = await scanOrphans(db, imagesDir);
    expect(r.count).toBe(0);
  });

  it("non-UUID basenames are ignored (only <uuid>.<ext> shapes)", async () => {
    await seedFile(`alice@x.com/2026/05/notes.txt`);
    await seedFile(`alice@x.com/2026/05/random-file.png`);
    const r = await scanOrphans(db, imagesDir);
    expect(r.count).toBe(0);
  });

  it("deleted_*/ archives are ignored", async () => {
    const id = "44444444-4444-4444-4444-444444444444";
    await seedFile(`deleted_alice@x.com/2026/05/${id}.png`);
    const r = await scanOrphans(db, imagesDir);
    expect(r.count).toBe(0);
  });
});

describe("purgeOrphans", () => {
  it("deletes only orphan files; referenced files remain", async () => {
    const id1 = "55555555-5555-5555-5555-555555555555";
    const id2 = "66666666-6666-6666-6666-666666666666";
    await seedFile(`alice@x.com/2026/05/${id1}.png`);
    await seedFile(`alice@x.com/2026/05/${id2}.png`);
    insertGenWithOutput(`alice@x.com/2026/05/${id1}.png`);

    const r = await purgeOrphans(db, imagesDir);
    expect(r.deleted).toBe(1);
    await expect(
      fs.access(path.join(imagesDir, `alice@x.com/2026/05/${id1}.png`))
    ).resolves.toBeUndefined();
    await expect(
      fs.access(path.join(imagesDir, `alice@x.com/2026/05/${id2}.png`))
    ).rejects.toThrow();
  });

  it("is idempotent — second run finds nothing", async () => {
    const id = "77777777-7777-7777-7777-777777777777";
    await seedFile(`alice@x.com/2026/05/${id}.png`);
    const r1 = await purgeOrphans(db, imagesDir);
    expect(r1.deleted).toBe(1);
    const r2 = await purgeOrphans(db, imagesDir);
    expect(r2.deleted).toBe(0);
  });
});
