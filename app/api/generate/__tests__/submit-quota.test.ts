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
  // Omit created_at so the schema default (strftime ISO with Z) fills it.
  // Earlier this row used `datetime('now')`, which yields "YYYY-MM-DD HH:MM:SS"
  // (space separator, no Z) and lex-compared below the ISO lower bound on
  // the 1st of any month — making the test flaky. usageThisMonth does raw
  // string comparison; the schema default matches the bounds exactly.
  const ins = db.prepare(`INSERT INTO generations (user_id, model_id, status) VALUES (?, 'nano-banana-pro', 'completed')`);
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
