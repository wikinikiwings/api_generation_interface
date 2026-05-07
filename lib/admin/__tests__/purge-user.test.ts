import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { initSchema, seedModels } from "@/lib/history-db";
import { purgeUser } from "../purge-user";

let db: Database.Database;
let imagesDir: string;
let userId: number;

beforeEach(async () => {
  db = new Database(":memory:");
  initSchema(db);
  seedModels(db);
  imagesDir = await fs.mkdtemp(path.join(os.tmpdir(), "purge-fs-"));
  userId = db.prepare(`INSERT INTO users (email, status) VALUES ('alice@x.com', 'deleted')`)
    .run().lastInsertRowid as number;
});
afterEach(async () => {
  await fs.rm(imagesDir, { recursive: true, force: true });
});

function insertGen(model: string | null, createdAt: string, status = "completed"): number {
  return db.prepare(
    `INSERT INTO generations (user_id, model_id, status, created_at) VALUES (?, ?, ?, ?)`
  ).run(userId, model, status, createdAt).lastInsertRowid as number;
}

describe("purgeUser", () => {
  it("user with no generations: no CSV written, user row deleted", async () => {
    const result = await purgeUser(db, userId, {
      imagesDir,
      purgedAtIso: "2026-05-07T13:45:00.000Z",
    });
    expect(result.generations_deleted).toBe(0);
    expect(result.csv_written).toBe(false);
    expect(result.email).toBe("alice@x.com");

    expect(db.prepare(`SELECT id FROM users WHERE id=?`).get(userId)).toBeUndefined();
  });

  it("user with generations: CSV written into {email}/, then DB rows deleted", async () => {
    const userDir = path.join(imagesDir, "alice@x.com");
    await fs.mkdir(userDir);
    const genId = insertGen("nano-banana-pro", "2026-05-12T10:00:00.000Z");
    db.prepare(
      `INSERT INTO generation_outputs (generation_id, filename, filepath, content_type)
       VALUES (?, 'a.jpg', 'alice@x.com/2026/05/uuid.jpg', 'image/jpeg')`
    ).run(genId);

    const result = await purgeUser(db, userId, {
      imagesDir,
      purgedAtIso: "2026-05-07T13:45:00.000Z",
    });
    expect(result.generations_deleted).toBe(1);
    expect(result.csv_written).toBe(true);

    const csv = await fs.readFile(path.join(userDir, "_SUMMARY.csv"), "utf8");
    expect(csv).toContain("# email: alice@x.com");
    expect(csv).toContain("2026,05,nano-banana-pro,Nano Banana Pro,1");

    expect(db.prepare(`SELECT id FROM users WHERE id=?`).get(userId)).toBeUndefined();
    expect(db.prepare(`SELECT id FROM generations WHERE user_id=?`).get(userId)).toBeUndefined();
    expect(db.prepare(`SELECT id FROM generation_outputs WHERE generation_id=?`).get(genId)).toBeUndefined();
  });

  it("user with generations but no folder on disk: skips CSV (gens still purged)", async () => {
    insertGen("nano-banana-pro", "2026-05-12T10:00:00.000Z");
    const result = await purgeUser(db, userId, {
      imagesDir,
      purgedAtIso: "2026-05-07T13:45:00.000Z",
    });
    expect(result.generations_deleted).toBe(1);
    expect(result.csv_written).toBe(false);
    expect(db.prepare(`SELECT id FROM generations WHERE user_id=?`).get(userId)).toBeUndefined();
  });

  it("CASCADE wipes sessions, user_quotas, user_preferences", async () => {
    const userDir = path.join(imagesDir, "alice@x.com");
    await fs.mkdir(userDir);
    db.prepare(`INSERT INTO sessions (id, user_id, expires_at) VALUES ('s1', ?, '2099-01-01')`).run(userId);
    db.prepare(`INSERT INTO user_quotas (user_id, model_id, monthly_limit) VALUES (?, 'nano-banana-pro', 100)`).run(userId);
    db.prepare(`INSERT INTO user_preferences (user_id, selected_model) VALUES (?, 'nano-banana-pro')`).run(userId);

    await purgeUser(db, userId, { imagesDir, purgedAtIso: "2026-05-07T13:45:00.000Z" });

    expect(db.prepare(`SELECT id FROM sessions WHERE user_id=?`).get(userId)).toBeUndefined();
    expect(db.prepare(`SELECT user_id FROM user_quotas WHERE user_id=?`).get(userId)).toBeUndefined();
    expect(db.prepare(`SELECT user_id FROM user_preferences WHERE user_id=?`).get(userId)).toBeUndefined();
  });

  it("auth_events for the user are preserved (no FK)", async () => {
    db.prepare(`INSERT INTO auth_events (event_type, user_id, email) VALUES ('login_ok', ?, 'alice@x.com')`).run(userId);
    await purgeUser(db, userId, { imagesDir, purgedAtIso: "2026-05-07T13:45:00.000Z" });
    const ev = db.prepare(`SELECT email FROM auth_events WHERE user_id=?`).get(userId) as { email: string } | undefined;
    expect(ev?.email).toBe("alice@x.com");
  });

  it("throws PurgeUserError(not_found) if user does not exist", async () => {
    const err = await purgeUser(db, 999_999, { imagesDir, purgedAtIso: "2026-05-07T13:45:00.000Z" })
      .then(() => null)
      .catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err.kind).toBe("not_found");
  });

  it("tags csv write failures as kind='summary_write_failed' (DB untouched)", async () => {
    insertGen("nano-banana-pro", "2026-05-12T10:00:00.000Z");
    const userDir = path.join(imagesDir, "alice@x.com");
    await fs.mkdir(userDir);
    // Force fs.writeFile to fail with EISDIR by pre-creating _SUMMARY.csv as a directory.
    await fs.mkdir(path.join(userDir, "_SUMMARY.csv"));

    const err = await purgeUser(db, userId, { imagesDir, purgedAtIso: "2026-05-07T13:45:00.000Z" })
      .then(() => null)
      .catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err.kind).toBe("summary_write_failed");
    // DB untouched
    expect(db.prepare(`SELECT id FROM users WHERE id=?`).get(userId)).toBeTruthy();
  });

  it("generations_deleted reflects actual rows deleted, not billing-counted total", async () => {
    // SQLite schema has no CHECK on status; we can directly insert a 'failed' row
    // to simulate a future-state where billing and deletion diverge.
    insertGen("nano-banana-pro", "2026-05-12T10:00:00.000Z", "completed");
    insertGen("nano-banana-pro", "2026-05-13T10:00:00.000Z", "failed");
    return purgeUser(db, userId, { imagesDir, purgedAtIso: "2026-05-07T13:45:00.000Z" })
      .then((result) => {
        // 2 rows were physically deleted; only 1 counts toward billing summary.
        expect(result.generations_deleted).toBe(2);
      });
  });
});
