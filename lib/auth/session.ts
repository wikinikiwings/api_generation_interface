import crypto from "node:crypto";
import type Database from "better-sqlite3";

export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
export const SLIDING_THROTTLE_MS = 60 * 60 * 1000;      // 1 hour

export interface SessionRow {
  id: string;
  user_id: number;
  created_at: string;
  expires_at: string;
  last_seen_at: string | null;
  user_agent: string | null;
  ip: string | null;
}

function newSessionId(): string {
  return crypto.randomBytes(32).toString("base64url");
}

export function createSession(
  db: Database.Database,
  args: { user_id: number; ip?: string | null; user_agent?: string | null; now?: number }
): string {
  const sid = newSessionId();
  const now = args.now ?? Date.now();
  const expires = new Date(now + SESSION_TTL_MS).toISOString();
  const lastSeen = new Date(now).toISOString();
  db.prepare(
    `INSERT INTO sessions (id, user_id, expires_at, last_seen_at, ip, user_agent)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(sid, args.user_id, expires, lastSeen, args.ip ?? null, args.user_agent ?? null);
  return sid;
}

export function getSessionRow(db: Database.Database, sid: string): SessionRow | null {
  const row = db.prepare(`SELECT * FROM sessions WHERE id=?`).get(sid) as SessionRow | undefined;
  return row ?? null;
}

export function deleteSession(db: Database.Database, sid: string): void {
  db.prepare(`DELETE FROM sessions WHERE id=?`).run(sid);
}

export function deleteSessionsForUser(db: Database.Database, user_id: number): void {
  db.prepare(`DELETE FROM sessions WHERE user_id=?`).run(user_id);
}

/**
 * Sliding renewal: bump expires_at and last_seen_at, but only if `last_seen_at`
 * is older than SLIDING_THROTTLE_MS. Avoids writing to the DB on every request.
 *
 * Returns true if the renewal happened, false if it was skipped (still fresh).
 */
export function maybeRenewSession(
  db: Database.Database,
  sid: string,
  lastSeenIso: string,
  now = Date.now()
): boolean {
  const ageMs = now - new Date(lastSeenIso).getTime();
  if (ageMs <= SLIDING_THROTTLE_MS) return false;
  const newExpires = new Date(now + SESSION_TTL_MS).toISOString();
  const newLastSeen = new Date(now).toISOString();
  db.prepare(`UPDATE sessions SET expires_at=?, last_seen_at=? WHERE id=?`).run(
    newExpires, newLastSeen, sid
  );
  return true;
}
