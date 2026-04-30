import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { initSchema } from "@/lib/history-db";
import { createSession, SLIDING_THROTTLE_MS, SESSION_TTL_MS } from "../session";
import { getCurrentUser } from "../current-user";

let db: Database.Database;
let userId: number;
let sid: string;

beforeEach(() => {
  db = new Database(":memory:");
  initSchema(db);
  userId = db.prepare(
    `INSERT INTO users (email, name, role, status) VALUES ('alice@x.com', 'Alice', 'user', 'active')`
  ).run().lastInsertRowid as number;
  sid = createSession(db, { user_id: userId, now: 1700000000000 });
});

describe("getCurrentUser", () => {
  it("returns user object for valid sid", () => {
    const u = getCurrentUser(db, sid, { now: 1700000000000 });
    expect(u).toEqual(expect.objectContaining({
      id: userId, email: "alice@x.com", name: "Alice", role: "user",
    }));
  });

  it("returns null for unknown sid", () => {
    expect(getCurrentUser(db, "no-such-sid")).toBeNull();
  });

  it("returns null and deletes session if expired", () => {
    const farFuture = 1700000000000 + SESSION_TTL_MS + 1000;
    expect(getCurrentUser(db, sid, { now: farFuture })).toBeNull();
    expect(db.prepare(`SELECT * FROM sessions WHERE id=?`).get(sid)).toBeUndefined();
  });

  it("returns null and deletes ALL user sessions if user is banned", () => {
    const sid2 = createSession(db, { user_id: userId, now: 1700000000000 });
    db.prepare(`UPDATE users SET status='banned' WHERE id=?`).run(userId);
    expect(getCurrentUser(db, sid, { now: 1700000000000 })).toBeNull();
    expect(db.prepare(`SELECT * FROM sessions WHERE user_id=?`).all(userId)).toHaveLength(0);
    // sid2 also gone
    void sid2;
  });

  it("returns null and deletes sessions if user is soft-deleted", () => {
    db.prepare(`UPDATE users SET status='deleted' WHERE id=?`).run(userId);
    expect(getCurrentUser(db, sid, { now: 1700000000000 })).toBeNull();
    expect(db.prepare(`SELECT * FROM sessions WHERE user_id=?`).all(userId)).toHaveLength(0);
  });

  it("renews session if last_seen older than throttle", () => {
    const now = 1700000000000 + SLIDING_THROTTLE_MS + 1000;
    const before = (db.prepare(`SELECT expires_at FROM sessions WHERE id=?`).get(sid) as any).expires_at;
    getCurrentUser(db, sid, { now });
    const after = (db.prepare(`SELECT expires_at FROM sessions WHERE id=?`).get(sid) as any).expires_at;
    expect(after).not.toBe(before);
  });

  it("does NOT renew if recently seen", () => {
    const now = 1700000000000 + 100; // very fresh
    const before = (db.prepare(`SELECT expires_at FROM sessions WHERE id=?`).get(sid) as any).expires_at;
    getCurrentUser(db, sid, { now });
    const after = (db.prepare(`SELECT expires_at FROM sessions WHERE id=?`).get(sid) as any).expires_at;
    expect(after).toBe(before);
  });
});
