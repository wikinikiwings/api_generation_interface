import type Database from "better-sqlite3";

export type AuthEventType =
  | "login_ok"
  | "login_denied_invalid_state"
  | "login_denied_invalid_token"
  | "login_denied_email_unverified"
  | "login_denied_not_in_allowlist"
  | "login_denied_banned"
  | "login_denied_account_deleted"
  | "login_denied_sub_mismatch"
  | "login_denied_wrong_hd"
  | "logout"
  | "quota_exceeded"
  | "session_revoked_ban"
  | "session_revoked_role_change"
  | "admin_user_created"
  | "admin_user_role_changed"
  | "admin_user_status_changed"
  | "admin_user_purged"
  | "admin_quota_changed"
  | "admin_model_default_changed";

export interface AuthEventInput {
  event_type: AuthEventType;
  email?: string | null;
  user_id?: number | null;
  ip?: string | null;
  user_agent?: string | null;
  details?: Record<string, unknown> | null;
}

/**
 * Append-only audit log writer. Never throws — failures are logged and swallowed
 * because audit failure must not break the user-visible flow.
 */
export function writeAuthEvent(db: Database.Database, ev: AuthEventInput): void {
  try {
    db.prepare(
      `INSERT INTO auth_events (event_type, email, user_id, ip, user_agent, details)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).run(
      ev.event_type,
      ev.email ?? null,
      ev.user_id ?? null,
      ev.ip ?? null,
      ev.user_agent ?? null,
      ev.details ? JSON.stringify(ev.details) : null
    );
  } catch (err) {
    console.error("[audit] writeAuthEvent failed:", err);
  }
}
