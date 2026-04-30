import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { initSchema } from "@/lib/history-db";
import { writeAuthEvent, type AuthEventType } from "../audit";

let db: Database.Database;

beforeEach(() => {
  db = new Database(":memory:");
  initSchema(db);
});

describe("writeAuthEvent", () => {
  it("inserts a row with the given fields", () => {
    writeAuthEvent(db, {
      event_type: "login_ok",
      email: "alice@x.com",
      user_id: 1,
      ip: "1.2.3.4",
      user_agent: "ua",
      details: { foo: "bar" },
    });
    const row = db.prepare(`SELECT * FROM auth_events ORDER BY id DESC LIMIT 1`).get() as any;
    expect(row.event_type).toBe("login_ok");
    expect(row.email).toBe("alice@x.com");
    expect(row.user_id).toBe(1);
    expect(row.ip).toBe("1.2.3.4");
    expect(row.user_agent).toBe("ua");
    expect(JSON.parse(row.details)).toEqual({ foo: "bar" });
    expect(row.timestamp).toBeTruthy();
  });

  it("accepts minimal payload", () => {
    writeAuthEvent(db, { event_type: "logout" });
    const row = db.prepare(`SELECT * FROM auth_events`).get() as any;
    expect(row.event_type).toBe("logout");
    expect(row.email).toBeNull();
  });

  it("typescript: rejects invalid event_type at compile time", () => {
    // @ts-expect-error — bad event_type
    writeAuthEvent(db, { event_type: "not_a_real_event" });
    // The line above must produce a compile error; we don't need a runtime assertion.
    expect(true).toBe(true);
  });
});
