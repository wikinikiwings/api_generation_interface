import type Database from "better-sqlite3";
import { deleteSession, deleteSessionsForUser, maybeRenewSession } from "./session";

export interface CurrentUser {
  id: number;
  email: string;
  name: string | null;
  picture_url: string | null;
  role: "user" | "admin";
}

interface JoinedRow {
  sid: string;
  expires_at: string;
  last_seen_at: string | null;
  created_at_session: string;
  user_id: number;
  email: string;
  name: string | null;
  picture_url: string | null;
  role: "user" | "admin";
  status: "active" | "banned" | "deleted";
}

export function getCurrentUser(
  db: Database.Database,
  sid: string | null | undefined,
  opts: { now?: number } = {}
): CurrentUser | null {
  if (!sid) return null;
  const row = db.prepare(`
    SELECT s.id AS sid, s.expires_at, s.last_seen_at, s.created_at AS created_at_session,
           u.id AS user_id, u.email, u.name, u.picture_url, u.role, u.status
    FROM sessions s JOIN users u ON u.id = s.user_id
    WHERE s.id = ?
  `).get(sid) as JoinedRow | undefined;
  if (!row) return null;

  const now = opts.now ?? Date.now();

  if (new Date(row.expires_at).getTime() < now) {
    deleteSession(db, sid);
    return null;
  }
  if (row.status !== "active") {
    deleteSessionsForUser(db, row.user_id);
    return null;
  }

  const lastSeen = row.last_seen_at ?? row.created_at_session;
  maybeRenewSession(db, sid, lastSeen, now);

  return {
    id: row.user_id,
    email: row.email,
    name: row.name,
    picture_url: row.picture_url,
    role: row.role,
  };
}
