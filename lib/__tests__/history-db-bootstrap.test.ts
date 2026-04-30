import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { initSchema, seedModels, bootstrapAdmins } from "@/lib/history-db";

let db: Database.Database;

beforeEach(() => {
  db = new Database(":memory:");
  initSchema(db);
});

describe("seedModels", () => {
  it("inserts a row per known model", () => {
    seedModels(db);
    const rows = db.prepare(`SELECT model_id, display_name, default_monthly_limit FROM models`).all();
    const ids = (rows as any[]).map((r) => r.model_id);
    expect(ids).toEqual(
      expect.arrayContaining([
        "nano-banana-pro", "nano-banana-2", "nano-banana",
        "seedream-4-5", "seedream-5-0-lite",
      ])
    );
    // Defaults are NULL (unlimited) until admin sets them
    expect((rows as any[])[0].default_monthly_limit).toBeNull();
  });

  it("is idempotent (running twice doesn't duplicate)", () => {
    seedModels(db);
    seedModels(db);
    const count = (db.prepare(`SELECT COUNT(*) AS n FROM models`).get() as any).n;
    expect(count).toBe(5);
  });

  it("does not reset default_monthly_limit if already set by admin", () => {
    seedModels(db);
    db.prepare(`UPDATE models SET default_monthly_limit=100 WHERE model_id='nano-banana-pro'`).run();
    seedModels(db);
    const r = db.prepare(`SELECT default_monthly_limit FROM models WHERE model_id='nano-banana-pro'`).get() as any;
    expect(r.default_monthly_limit).toBe(100);
  });
});

describe("bootstrapAdmins", () => {
  it("creates admin users from CSV env", () => {
    bootstrapAdmins(db, "alice@x.com,bob@y.com");
    const rows = db.prepare(`SELECT email, role, status FROM users ORDER BY email`).all() as any[];
    expect(rows).toEqual([
      { email: "alice@x.com", role: "admin", status: "active" },
      { email: "bob@y.com",   role: "admin", status: "active" },
    ]);
  });

  it("lowercases and trims", () => {
    bootstrapAdmins(db, "  ALICE@x.com  , Bob@Y.com ");
    const rows = db.prepare(`SELECT email FROM users ORDER BY email`).all() as any[];
    expect(rows.map((r) => r.email)).toEqual(["alice@x.com", "bob@y.com"]);
  });

  it("is idempotent and promotes existing user to admin", () => {
    db.prepare(`INSERT INTO users (email, role) VALUES (?, 'user')`).run("alice@x.com");
    bootstrapAdmins(db, "alice@x.com");
    const r = db.prepare(`SELECT role, status FROM users WHERE email='alice@x.com'`).get() as any;
    expect(r.role).toBe("admin");
    expect(r.status).toBe("active");
  });

  it("does NOT resurrect a soft-deleted user", () => {
    db.prepare(`INSERT INTO users (email, role, status) VALUES (?, 'user', 'deleted')`).run("alice@x.com");
    bootstrapAdmins(db, "alice@x.com");
    const r = db.prepare(`SELECT role, status FROM users WHERE email='alice@x.com'`).get() as any;
    // Status remains 'deleted' — explicit policy: rest of session won't auto-resurrect
    expect(r.status).toBe("deleted");
  });

  it("handles empty/missing env gracefully", () => {
    bootstrapAdmins(db, "");
    bootstrapAdmins(db, undefined);
    const count = (db.prepare(`SELECT COUNT(*) AS n FROM users`).get() as any).n;
    expect(count).toBe(0);
  });
});
