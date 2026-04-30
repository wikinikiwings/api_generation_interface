import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { initSchema, seedModels } from "@/lib/history-db";
import { applicableLimit, usageThisMonth } from "@/lib/quotas";

let db: Database.Database;
let userId: number;

beforeEach(() => {
  db = new Database(":memory:");
  initSchema(db);
  seedModels(db);
  userId = db.prepare(`INSERT INTO users (email) VALUES ('a@x.com')`).run().lastInsertRowid as number;
});

it("blocks when usage equals limit", () => {
  db.prepare(`UPDATE models SET default_monthly_limit=2 WHERE model_id='nano-banana-pro'`).run();
  const ins = db.prepare(`INSERT INTO generations (user_id, model_id, status, created_at) VALUES (?, 'nano-banana-pro', 'completed', datetime('now'))`);
  ins.run(userId);
  ins.run(userId);
  expect(usageThisMonth(db, userId, "nano-banana-pro")).toBe(2);
  expect(applicableLimit(db, userId, "nano-banana-pro")).toBe(2);
});

it("allows when override is unlimited (NULL) even with low default", () => {
  db.prepare(`UPDATE models SET default_monthly_limit=1 WHERE model_id='nano-banana-pro'`).run();
  db.prepare(`INSERT INTO user_quotas (user_id, model_id, monthly_limit) VALUES (?, ?, NULL)`).run(userId, "nano-banana-pro");
  expect(applicableLimit(db, userId, "nano-banana-pro")).toBeNull();
});
