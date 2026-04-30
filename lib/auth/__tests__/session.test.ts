import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { initSchema } from "@/lib/history-db";
import { createSession, getSessionRow, deleteSession, deleteSessionsForUser, maybeRenewSession, SESSION_TTL_MS, SLIDING_THROTTLE_MS } from "../session";

let db: Database.Database;
let userId: number;

beforeEach(() => {
  db = new Database(":memory:");
  initSchema(db);
  userId = db.prepare(`INSERT INTO users (email) VALUES ('alice@x.com')`).run().lastInsertRowid as number;
});

describe("createSession", () => {
  it("returns a session_id and inserts a row", () => {
    const sid = createSession(db, { user_id: userId, ip: "1.2.3.4", user_agent: "ua", now: 1700000000000 });
    expect(sid).toMatch(/^[A-Za-z0-9_-]{43}$/); // base64url of 32 bytes (no padding) is 43 chars
    const row = db.prepare(`SELECT * FROM sessions WHERE id=?`).get(sid) as any;
    expect(row.user_id).toBe(userId);
    expect(row.ip).toBe("1.2.3.4");
    expect(new Date(row.expires_at).getTime()).toBe(1700000000000 + SESSION_TTL_MS);
  });

  it("each call generates a unique id", () => {
    const a = createSession(db, { user_id: userId });
    const b = createSession(db, { user_id: userId });
    expect(a).not.toBe(b);
  });
});

describe("getSessionRow", () => {
  it("returns row for an active session", () => {
    const sid = createSession(db, { user_id: userId });
    const row = getSessionRow(db, sid);
    expect(row).toBeTruthy();
    expect(row!.user_id).toBe(userId);
  });

  it("returns null for unknown sid", () => {
    expect(getSessionRow(db, "nonexistent")).toBeNull();
  });
});

describe("deleteSession", () => {
  it("removes a session by id", () => {
    const sid = createSession(db, { user_id: userId });
    deleteSession(db, sid);
    expect(getSessionRow(db, sid)).toBeNull();
  });
});

describe("deleteSessionsForUser", () => {
  it("removes all sessions for a user", () => {
    createSession(db, { user_id: userId });
    createSession(db, { user_id: userId });
    deleteSessionsForUser(db, userId);
    const rows = db.prepare(`SELECT * FROM sessions WHERE user_id=?`).all(userId);
    expect(rows).toHaveLength(0);
  });
});

describe("maybeRenewSession", () => {
  it("skips when last_seen_at is within the throttle window", () => {
    const baseNow = 1_700_000_000_000;
    const sid = createSession(db, { user_id: userId, now: baseNow });
    const lastSeen = new Date(baseNow).toISOString();
    expect(maybeRenewSession(db, sid, lastSeen, baseNow + 30 * 60 * 1000)).toBe(false);
  });

  it("renews when last_seen_at is older than the throttle window", () => {
    const baseNow = 1_700_000_000_000;
    const sid = createSession(db, { user_id: userId, now: baseNow });
    const lastSeen = new Date(baseNow).toISOString();
    const later = baseNow + 2 * 60 * 60 * 1000;
    expect(maybeRenewSession(db, sid, lastSeen, later)).toBe(true);
    const row = getSessionRow(db, sid)!;
    expect(new Date(row.expires_at).getTime()).toBe(later + SESSION_TTL_MS);
    expect(new Date(row.last_seen_at!).getTime()).toBe(later);
  });

  it("treats exactly-throttle-old as still fresh", () => {
    const baseNow = 1_700_000_000_000;
    const sid = createSession(db, { user_id: userId, now: baseNow });
    const lastSeen = new Date(baseNow).toISOString();
    expect(
      maybeRenewSession(db, sid, lastSeen, baseNow + SLIDING_THROTTLE_MS)
    ).toBe(false);
  });
});
