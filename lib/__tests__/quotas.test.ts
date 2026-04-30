import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { initSchema, seedModels } from "@/lib/history-db";
import { applicableLimit, usageThisMonth, currentMonthBoundsUTC } from "../quotas";

let db: Database.Database;
let userId: number;

beforeEach(() => {
  db = new Database(":memory:");
  initSchema(db);
  seedModels(db);
  userId = db.prepare(`INSERT INTO users (email) VALUES ('alice@x.com')`).run().lastInsertRowid as number;
});

describe("currentMonthBoundsUTC", () => {
  it("returns ISO start and end-of-current-month for a given date", () => {
    const [start, end] = currentMonthBoundsUTC(new Date(Date.UTC(2026, 3, 15, 12, 0, 0))); // April 15 noon UTC
    expect(start).toBe("2026-04-01T00:00:00.000Z");
    expect(end).toBe("2026-05-01T00:00:00.000Z");
  });

  it("handles December → January correctly", () => {
    const [start, end] = currentMonthBoundsUTC(new Date(Date.UTC(2026, 11, 31, 23, 59, 59)));
    expect(start).toBe("2026-12-01T00:00:00.000Z");
    expect(end).toBe("2027-01-01T00:00:00.000Z");
  });
});

describe("applicableLimit", () => {
  it("returns NULL (unlimited) when no override and default is NULL", () => {
    expect(applicableLimit(db, userId, "nano-banana-pro")).toBeNull();
  });

  it("returns default when set on models and no override", () => {
    db.prepare(`UPDATE models SET default_monthly_limit=100 WHERE model_id='nano-banana-pro'`).run();
    expect(applicableLimit(db, userId, "nano-banana-pro")).toBe(100);
  });

  it("override wins over default (number)", () => {
    db.prepare(`UPDATE models SET default_monthly_limit=100 WHERE model_id='nano-banana-pro'`).run();
    db.prepare(`INSERT INTO user_quotas (user_id, model_id, monthly_limit) VALUES (?, ?, ?)`).run(userId, "nano-banana-pro", 50);
    expect(applicableLimit(db, userId, "nano-banana-pro")).toBe(50);
  });

  it("override NULL means unlimited even if default is set", () => {
    db.prepare(`UPDATE models SET default_monthly_limit=100 WHERE model_id='nano-banana-pro'`).run();
    db.prepare(`INSERT INTO user_quotas (user_id, model_id, monthly_limit) VALUES (?, ?, NULL)`).run(userId, "nano-banana-pro");
    expect(applicableLimit(db, userId, "nano-banana-pro")).toBeNull();
  });

  it("returns 0 (block) for unknown model_id (closed by default)", () => {
    expect(applicableLimit(db, userId, "no-such-model")).toBe(0);
  });
});

describe("usageThisMonth", () => {
  it("returns 0 when no generations", () => {
    expect(usageThisMonth(db, userId, "nano-banana-pro", new Date(Date.UTC(2026, 3, 15)))).toBe(0);
  });

  it("counts only completed generations in current month", () => {
    const ins = db.prepare(`INSERT INTO generations (user_id, model_id, status, created_at) VALUES (?, ?, ?, ?)`);
    ins.run(userId, "nano-banana-pro", "completed", "2026-04-10T12:00:00Z");
    ins.run(userId, "nano-banana-pro", "completed", "2026-04-25T12:00:00Z");
    ins.run(userId, "nano-banana-pro", "failed",    "2026-04-15T12:00:00Z");   // not counted
    ins.run(userId, "nano-banana-pro", "completed", "2026-03-30T12:00:00Z");   // previous month
    ins.run(userId, "nano-banana-pro", "completed", "2026-05-01T00:00:00Z");   // next month boundary
    ins.run(userId, "seedream-4-5",    "completed", "2026-04-15T12:00:00Z");   // different model

    const now = new Date(Date.UTC(2026, 3, 30));
    expect(usageThisMonth(db, userId, "nano-banana-pro", now)).toBe(2);
    expect(usageThisMonth(db, userId, "seedream-4-5", now)).toBe(1);
  });
});
