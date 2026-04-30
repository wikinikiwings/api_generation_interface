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
