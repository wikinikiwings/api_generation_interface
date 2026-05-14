/** @vitest-environment node */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import sharp from "sharp";
import { initSchema, seedModels } from "@/lib/history-db";
import { runRebuild } from "../variants-runner";
import {
  tryStartJob,
  getJob,
  _resetForTests,
} from "../variants-jobs";

let db: Database.Database;
let imagesDir: string;
let variantsDir: string;
let userId: number;

async function makePng(w: number, h: number) {
  return sharp({ create: { width: w, height: h, channels: 3, background: { r: 0, g: 0, b: 0 } } })
    .png().toBuffer();
}

async function placeOriginal(rel: string, buf: Buffer) {
  const abs = path.join(imagesDir, rel);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, buf);
}

function insertGen(filepath: string): number {
  const genId = db.prepare(
    `INSERT INTO generations (user_id, status) VALUES (?, 'completed')`
  ).run(userId).lastInsertRowid as number;
  db.prepare(
    `INSERT INTO generation_outputs (generation_id, filename, filepath, content_type)
     VALUES (?, 'a.png', ?, 'image/png')`
  ).run(genId, filepath);
  return genId;
}

beforeEach(async () => {
  _resetForTests();
  db = new Database(":memory:");
  initSchema(db);
  seedModels(db);
  imagesDir = await fs.mkdtemp(path.join(os.tmpdir(), "vr-img-"));
  variantsDir = await fs.mkdtemp(path.join(os.tmpdir(), "vr-var-"));
  userId = db.prepare(`INSERT INTO users (email, status) VALUES ('alice@x.com', 'active')`)
    .run().lastInsertRowid as number;
});
afterEach(async () => {
  await fs.rm(imagesDir, { recursive: true, force: true });
  await fs.rm(variantsDir, { recursive: true, force: true });
});

describe("runRebuild", () => {
  it("processes all selected generations and finishes the job", async () => {
    const buf = await makePng(800, 600);
    await placeOriginal("alice@x.com/2026/05/a.png", buf);
    await placeOriginal("alice@x.com/2026/05/b.png", buf);
    insertGen("alice@x.com/2026/05/a.png");
    insertGen("alice@x.com/2026/05/b.png");

    const start = tryStartJob({ scope: "user", userId, total: 2 });
    if (!start.started) throw new Error("expected started");

    await runRebuild(db, start.jobId, {
      scope: "user",
      userId,
      imagesDir,
      variantsDir,
      broadcast: () => {},
    });

    const job = getJob(start.jobId);
    expect(job?.finished).toBe(true);
    expect(job?.done).toBe(2);
    expect(job?.errors.length).toBe(0);

    await expect(fs.access(path.join(variantsDir, "alice@x.com/2026/05/thumb_a.jpg"))).resolves.toBeUndefined();
    await expect(fs.access(path.join(variantsDir, "alice@x.com/2026/05/thumb_b.jpg"))).resolves.toBeUndefined();
  });

  it("records per-row errors but continues", async () => {
    insertGen("alice@x.com/2026/05/missing.png");  // no file on disk
    const start = tryStartJob({ scope: "user", userId, total: 1 });
    if (!start.started) throw new Error("expected started");

    await runRebuild(db, start.jobId, {
      scope: "user",
      userId,
      imagesDir,
      variantsDir,
      broadcast: () => {},
    });
    const job = getJob(start.jobId);
    expect(job?.finished).toBe(true);
    expect(job?.errors.length).toBe(1);
    expect(job?.errors[0].reason).toBe("original_missing");
  });

  it("scope=all processes every active user with image generations", async () => {
    const bobId = db.prepare(`INSERT INTO users (email, status) VALUES ('bob@y.com', 'active')`)
      .run().lastInsertRowid as number;
    const buf = await makePng(200, 200);
    await placeOriginal("alice@x.com/2026/05/a.png", buf);
    await placeOriginal("bob@y.com/2026/05/b.png", buf);
    insertGen("alice@x.com/2026/05/a.png");
    db.prepare(
      `INSERT INTO generations (user_id, status) VALUES (?, 'completed')`
    ).run(bobId);
    const bobGen = db.prepare(`SELECT last_insert_rowid() AS id`).get() as { id: number };
    db.prepare(
      `INSERT INTO generation_outputs (generation_id, filename, filepath, content_type)
       VALUES (?, 'b.png', 'bob@y.com/2026/05/b.png', 'image/png')`
    ).run(bobGen.id);

    const start = tryStartJob({ scope: "all", total: 2 });
    if (!start.started) throw new Error("expected started");

    await runRebuild(db, start.jobId, {
      scope: "all",
      imagesDir,
      variantsDir,
      broadcast: () => {},
    });
    expect(getJob(start.jobId)?.finished).toBe(true);
    expect(getJob(start.jobId)?.done).toBe(2);
  });
});
