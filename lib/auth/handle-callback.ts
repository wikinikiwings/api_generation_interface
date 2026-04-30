import type Database from "better-sqlite3";
import type { JSONWebKeySet } from "jose";
import { decodeOAuthTx } from "./oauth-tx";
import { verifyIdToken, exchangeCodeForTokens, type GoogleIdTokenPayload } from "./google";
import { writeAuthEvent } from "./audit";
import { createSession } from "./session";

export type CallbackResult =
  | { kind: "ok"; session_id: string; user_id: number; redirect_to: string }
  | { kind: "error"; status: number; reason: string };

export interface CallbackInputs {
  code: string | null;
  state_in_query: string | null;
  oauth_tx_cookie: string | null;
  ip: string | null;
  user_agent: string | null;
  // Injection
  env: {
    client_id: string;
    client_secret: string;
    redirect_uri: string;
    cookie_secret: string;
    allowed_hd?: string;
  };
  jwks: JSONWebKeySet;
  fetchImpl?: typeof fetch;
  now?: number;
}

export async function handleCallback(
  db: Database.Database,
  inp: CallbackInputs
): Promise<CallbackResult> {
  if (!inp.code || !inp.state_in_query) {
    writeAuthEvent(db, { event_type: "login_denied_invalid_state", ip: inp.ip, user_agent: inp.user_agent });
    return { kind: "error", status: 400, reason: "missing_params" };
  }
  if (!inp.oauth_tx_cookie) {
    writeAuthEvent(db, { event_type: "login_denied_invalid_state", ip: inp.ip, user_agent: inp.user_agent });
    return { kind: "error", status: 400, reason: "missing_oauth_tx" };
  }
  let tx;
  try {
    tx = decodeOAuthTx(inp.oauth_tx_cookie, inp.env.cookie_secret, { now: inp.now });
  } catch {
    writeAuthEvent(db, { event_type: "login_denied_invalid_state", ip: inp.ip, user_agent: inp.user_agent });
    return { kind: "error", status: 400, reason: "bad_oauth_tx" };
  }
  if (tx.state !== inp.state_in_query) {
    writeAuthEvent(db, { event_type: "login_denied_invalid_state", ip: inp.ip, user_agent: inp.user_agent });
    return { kind: "error", status: 400, reason: "state_mismatch" };
  }

  let tokens;
  try {
    tokens = await exchangeCodeForTokens({
      code: inp.code,
      code_verifier: tx.code_verifier,
      client_id: inp.env.client_id,
      client_secret: inp.env.client_secret,
      redirect_uri: inp.env.redirect_uri,
      fetchImpl: inp.fetchImpl,
    });
  } catch (err) {
    writeAuthEvent(db, {
      event_type: "login_denied_invalid_token",
      ip: inp.ip, user_agent: inp.user_agent,
      details: { stage: "code_exchange", message: (err as Error).message },
    });
    return { kind: "error", status: 400, reason: "code_exchange_failed" };
  }

  let payload: GoogleIdTokenPayload;
  try {
    payload = await verifyIdToken(tokens.id_token, { audience: inp.env.client_id, jwks: inp.jwks });
  } catch (err) {
    writeAuthEvent(db, {
      event_type: "login_denied_invalid_token",
      ip: inp.ip, user_agent: inp.user_agent,
      details: { stage: "verify", message: (err as Error).message },
    });
    return { kind: "error", status: 400, reason: "id_token_invalid" };
  }
  if (payload.nonce !== tx.nonce) {
    writeAuthEvent(db, { event_type: "login_denied_invalid_token", ip: inp.ip, user_agent: inp.user_agent, email: payload.email, details: { stage: "nonce_mismatch" } });
    return { kind: "error", status: 400, reason: "nonce_mismatch" };
  }
  if (!payload.email_verified) {
    writeAuthEvent(db, { event_type: "login_denied_email_unverified", ip: inp.ip, user_agent: inp.user_agent, email: payload.email });
    return { kind: "error", status: 403, reason: "email_unverified" };
  }
  if (inp.env.allowed_hd && payload.hd !== inp.env.allowed_hd) {
    writeAuthEvent(db, { event_type: "login_denied_wrong_hd", ip: inp.ip, user_agent: inp.user_agent, email: payload.email, details: { hd: payload.hd ?? null } });
    return { kind: "error", status: 403, reason: "wrong_hd" };
  }

  const email = payload.email.toLowerCase();
  const row = db.prepare(
    `SELECT id, role, status, google_sub FROM users WHERE email=?`
  ).get(email) as { id: number; role: string; status: string; google_sub: string | null } | undefined;
  if (!row) {
    writeAuthEvent(db, { event_type: "login_denied_not_in_allowlist", ip: inp.ip, user_agent: inp.user_agent, email });
    return { kind: "error", status: 403, reason: "not_in_allowlist" };
  }
  if (row.status === "banned") {
    writeAuthEvent(db, { event_type: "login_denied_banned", ip: inp.ip, user_agent: inp.user_agent, email, user_id: row.id });
    return { kind: "error", status: 403, reason: "banned" };
  }
  if (row.status === "deleted") {
    writeAuthEvent(db, { event_type: "login_denied_account_deleted", ip: inp.ip, user_agent: inp.user_agent, email, user_id: row.id });
    return { kind: "error", status: 403, reason: "deleted" };
  }
  if (row.google_sub && row.google_sub !== payload.sub) {
    writeAuthEvent(db, { event_type: "login_denied_sub_mismatch", ip: inp.ip, user_agent: inp.user_agent, email, user_id: row.id, details: { old_sub: row.google_sub, new_sub: payload.sub } });
    return { kind: "error", status: 403, reason: "sub_mismatch" };
  }

  db.prepare(
    `UPDATE users SET google_sub=?, name=?, picture_url=?, last_login_at=datetime('now') WHERE id=?`
  ).run(payload.sub, payload.name ?? null, payload.picture ?? null, row.id);

  const sid = createSession(db, { user_id: row.id, ip: inp.ip, user_agent: inp.user_agent, now: inp.now });
  writeAuthEvent(db, { event_type: "login_ok", email, user_id: row.id, ip: inp.ip, user_agent: inp.user_agent });
  return { kind: "ok", session_id: sid, user_id: row.id, redirect_to: tx.next };
}
