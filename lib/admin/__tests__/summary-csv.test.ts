import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { initSchema, seedModels } from "@/lib/history-db";
import { buildUserSummaryCsv } from "../summary-csv";

let db: Database.Database;
let userId: number;

beforeEach(() => {
  db = new Database(":memory:");
  initSchema(db);
  seedModels(db);
  userId = db.prepare(`INSERT INTO users (email) VALUES ('alice@x.com')`).run().lastInsertRowid as number;
});

function insertGen(model: string | null, createdAt: string, status: string = "completed") {
  db.prepare(
    `INSERT INTO generations (user_id, model_id, status, created_at) VALUES (?, ?, ?, ?)`
  ).run(userId, model, status, createdAt);
}

describe("buildUserSummaryCsv", () => {
  it("renders empty body when user has no generations", () => {
    const csv = buildUserSummaryCsv(db, userId, "alice@x.com", "2026-05-07T13:45:00.000Z");
    expect(csv).toContain("# email: alice@x.com");
    expect(csv).toContain("# purged_at: 2026-05-07T13:45:00.000Z");
    expect(csv).toContain("# total_generations: 0");
    expect(csv).toContain("year,month,model_id,model_display_name,generations");
    const lines = csv.trimEnd().split("\n");
    expect(lines[lines.length - 1]).toBe("year,month,model_id,model_display_name,generations");
  });

  it("groups by year+month+model with display name from models table", () => {
    insertGen("nano-banana-pro", "2026-05-12T10:00:00.000Z");
    insertGen("nano-banana-pro", "2026-05-13T10:00:00.000Z");
    insertGen("seedream-4-5",    "2026-05-14T10:00:00.000Z");
    insertGen("nano-banana-pro", "2026-04-01T10:00:00.000Z");
    const csv = buildUserSummaryCsv(db, userId, "alice@x.com", "2026-05-07T13:45:00.000Z");
    expect(csv).toContain("# total_generations: 4");
    const dataRows = csv.trimEnd().split("\n").slice(4);
    expect(dataRows).toEqual([
      "2026,05,nano-banana-pro,Nano Banana Pro,2",
      "2026,05,seedream-4-5,Seedream 4.5,1",
      "2026,04,nano-banana-pro,Nano Banana Pro,1",
    ]);
  });

  it("counts both completed and deleted generations (billing parity)", () => {
    insertGen("nano-banana-pro", "2026-05-12T10:00:00.000Z", "completed");
    insertGen("nano-banana-pro", "2026-05-13T10:00:00.000Z", "deleted");
    insertGen("nano-banana-pro", "2026-05-14T10:00:00.000Z", "failed");
    const csv = buildUserSummaryCsv(db, userId, "alice@x.com", "2026-05-07T13:45:00.000Z");
    expect(csv).toContain("# total_generations: 2");
    expect(csv).toContain("2026,05,nano-banana-pro,Nano Banana Pro,2");
  });

  it("renders NULL model_id as empty model_id and (unknown) display name", () => {
    insertGen(null, "2026-05-12T10:00:00.000Z");
    const csv = buildUserSummaryCsv(db, userId, "alice@x.com", "2026-05-07T13:45:00.000Z");
    expect(csv).toContain("2026,05,,(unknown),1");
  });
});
