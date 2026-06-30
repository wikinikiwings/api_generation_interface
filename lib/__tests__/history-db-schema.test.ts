import { describe, it, expect } from "vitest";
import Database from "better-sqlite3";
import { initSchema } from "@/lib/history-db";

function freshDb() {
  const db = new Database(":memory:");
  initSchema(db);
  return db;
}

describe("schema initialization", () => {
  it("creates all expected tables", () => {
    const db = freshDb();
    const rows = db.prepare(
      `SELECT name FROM sqlite_master WHERE type='table' ORDER BY name`
    ).all() as { name: string }[];
    const names = rows.map((r) => r.name);
    expect(names).toEqual(
      expect.arrayContaining([
        "users", "sessions", "models", "user_quotas", "auth_events",
        "generations", "generation_outputs", "user_preferences", "app_settings",
      ])
    );
  });

  it("users.email is unique and case-insensitive", () => {
    const db = freshDb();
    db.prepare(`INSERT INTO users (email) VALUES (?)`).run("alice@example.com");
    expect(() =>
      db.prepare(`INSERT INTO users (email) VALUES (?)`).run("ALICE@example.com")
    ).toThrow(/UNIQUE/);
  });

  it("users.role and users.status enforce CHECK constraints", () => {
    const db = freshDb();
    expect(() =>
      db.prepare(`INSERT INTO users (email, role) VALUES (?, ?)`).run("a@b.c", "superuser")
    ).toThrow(/CHECK/);
    expect(() =>
      db.prepare(`INSERT INTO users (email, status) VALUES (?, ?)`).run("a@b.c", "weird")
    ).toThrow(/CHECK/);
  });

  it("generations.user_id ON DELETE RESTRICT prevents user delete with generations", () => {
    const db = freshDb();
    db.exec(`PRAGMA foreign_keys = ON`);
    const uid = (db.prepare(`INSERT INTO users (email) VALUES (?)`).run("a@b.c").lastInsertRowid as number);
    db.prepare(`INSERT INTO generations (user_id, model_id, status) VALUES (?, ?, 'completed')`).run(uid, "m1");
    expect(() => db.prepare(`DELETE FROM users WHERE id=?`).run(uid)).toThrow(/FOREIGN KEY/);
  });

  it("creates the covering index for the admin monthly-generation count", () => {
    const db = freshDb();
    const idx = db.prepare(
      `SELECT name FROM sqlite_master WHERE type='index' AND name='idx_generations_user_created_status'`
    ).get();
    expect(idx).toBeTruthy();
  });

  it("admin monthly-count query is index-only (covering) — never reads bloated table pages", () => {
    const db = freshDb();
    // The GROUP BY pass used by GET /api/admin/users. With prompt_data holding
    // ~1GB of base64 images in prod, this MUST stay index-only or the admin
    // users tab slows to a crawl and the container can stall under SSE bursts.
    const plan = db.prepare(`
      EXPLAIN QUERY PLAN
      SELECT user_id, COUNT(*) AS n
      FROM generations
      WHERE status IN ('completed','deleted')
        AND created_at >= strftime('%Y-%m-01T00:00:00.000Z','now')
      GROUP BY user_id
    `).all() as { detail: string }[];
    const detail = plan.map((r) => r.detail).join(" | ");
    expect(detail).toMatch(/COVERING INDEX idx_generations_user_created_status/);
  });

  it("creates the covering index for the admin per-model generation count", () => {
    const db = freshDb();
    const idx = db.prepare(
      `SELECT name FROM sqlite_master WHERE type='index' AND name='idx_generations_model_status_created'`
    ).get();
    expect(idx).toBeTruthy();
  });

  it("admin per-model count query is index-only (covering) — never reads bloated table pages", () => {
    const db = freshDb();
    // The correlated subquery used by GET /api/admin/models (the per-model
    // total_generations column). Without a (model_id, status, created_at)
    // covering index this full-scans generations once PER MODEL on the default
    // all-time view — the same bloat-page problem the users tab had.
    const plan = db.prepare(`
      EXPLAIN QUERY PLAN
      SELECT COUNT(*) FROM generations g
      WHERE g.model_id = 'm1' AND g.status IN ('completed','deleted')
    `).all() as { detail: string }[];
    const detail = plan.map((r) => r.detail).join(" | ");
    expect(detail).toMatch(/COVERING INDEX idx_generations_model_status_created/);
  });

  it("sessions cascade-delete when user is deleted", () => {
    const db = freshDb();
    db.exec(`PRAGMA foreign_keys = ON`);
    const uid = db.prepare(`INSERT INTO users (email) VALUES (?)`).run("a@b.c").lastInsertRowid as number;
    db.prepare(`INSERT INTO sessions (id, user_id, expires_at) VALUES (?, ?, datetime('now','+1 day'))`).run("sid1", uid);
    db.prepare(`DELETE FROM users WHERE id=?`).run(uid);
    const rows = db.prepare(`SELECT * FROM sessions WHERE user_id=?`).all(uid);
    expect(rows).toHaveLength(0);
  });
});
