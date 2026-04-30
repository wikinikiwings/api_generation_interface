/** @vitest-environment node */
import { describe, it, expect, beforeEach } from "vitest";
import { generateKeyPair, SignJWT, exportJWK, type JWK } from "jose";
import Database from "better-sqlite3";
import { initSchema } from "@/lib/history-db";
import { encodeOAuthTx } from "@/lib/auth/oauth-tx";
import { handleCallback } from "@/lib/auth/handle-callback";

const COOKIE_SECRET = "0".repeat(64);
const CLIENT_ID = "cid";
const CLIENT_SECRET = "csec";
const REDIRECT = "http://localhost:3000/api/auth/callback";
const NOW = 1700000000000;

let db: Database.Database;
let publicJwk: JWK;
let signedToken: string;

async function buildToken(claims: Record<string, unknown>) {
  const { publicKey, privateKey } = await generateKeyPair("RS256");
  const pj = await exportJWK(publicKey); pj.alg = "RS256"; pj.use = "sig"; pj.kid = "k1";
  publicJwk = pj;
  return await new SignJWT(claims)
    .setProtectedHeader({ alg: "RS256", kid: "k1" })
    .setIssuer("https://accounts.google.com")
    .setAudience(CLIENT_ID)
    .setExpirationTime("1h").setIssuedAt().sign(privateKey);
}

function makeFetch(idToken: string, status = 200) {
  return async () => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => ({ id_token: idToken, access_token: "at", expires_in: 3600 }),
    text: async () => JSON.stringify({ id_token: idToken }),
  } as any);
}

beforeEach(async () => {
  db = new Database(":memory:");
  initSchema(db);
  signedToken = await buildToken({
    email: "alice@x.com", email_verified: true, sub: "sub1", nonce: "n1", name: "A", picture: "p",
  });
});

const txCookie = (overrides: Partial<{ state: string; nonce: string; cv: string; next: string; ts: number }> = {}) =>
  encodeOAuthTx({
    state: overrides.state ?? "s1",
    nonce: overrides.nonce ?? "n1",
    code_verifier: overrides.cv ?? "cv",
    next: overrides.next ?? "/dashboard",
    ts: overrides.ts ?? NOW,
  }, COOKIE_SECRET);

const baseInputs = (extra: Partial<Parameters<typeof handleCallback>[1]> = {}) => ({
  code: "abc",
  state_in_query: "s1",
  oauth_tx_cookie: txCookie(),
  ip: "1.1.1.1",
  user_agent: "ua",
  env: { client_id: CLIENT_ID, client_secret: CLIENT_SECRET, redirect_uri: REDIRECT, cookie_secret: COOKIE_SECRET },
  jwks: { keys: [publicJwk] },
  fetchImpl: makeFetch(signedToken),
  now: NOW + 1000,
  ...extra,
});

describe("handleCallback", () => {
  it("rejects when email not in allowlist", async () => {
    const r = await handleCallback(db, baseInputs());
    expect(r).toEqual({ kind: "error", status: 403, reason: "not_in_allowlist" });
    const ev = db.prepare(`SELECT event_type FROM auth_events ORDER BY id DESC`).all() as any[];
    expect(ev[0].event_type).toBe("login_denied_not_in_allowlist");
  });

  it("creates a session for an active allowlisted user", async () => {
    db.prepare(`INSERT INTO users (email, status) VALUES ('alice@x.com', 'active')`).run();
    const r = await handleCallback(db, baseInputs());
    expect(r.kind).toBe("ok");
    if (r.kind === "ok") {
      expect(r.redirect_to).toBe("/dashboard");
      const sess = db.prepare(`SELECT * FROM sessions WHERE id=?`).get(r.session_id) as any;
      expect(sess.user_id).toBe(r.user_id);
    }
  });

  it("rejects banned user", async () => {
    db.prepare(`INSERT INTO users (email, status) VALUES ('alice@x.com', 'banned')`).run();
    const r = await handleCallback(db, baseInputs());
    expect(r).toEqual({ kind: "error", status: 403, reason: "banned" });
  });

  it("rejects deleted user", async () => {
    db.prepare(`INSERT INTO users (email, status) VALUES ('alice@x.com', 'deleted')`).run();
    const r = await handleCallback(db, baseInputs());
    expect(r).toEqual({ kind: "error", status: 403, reason: "deleted" });
  });

  it("rejects state mismatch", async () => {
    const r = await handleCallback(db, baseInputs({ state_in_query: "different" }));
    expect(r).toEqual(expect.objectContaining({ kind: "error", reason: "state_mismatch" }));
  });

  it("rejects nonce mismatch (token nonce ≠ tx nonce)", async () => {
    db.prepare(`INSERT INTO users (email) VALUES ('alice@x.com')`).run();
    const tokenWithBadNonce = await buildToken({
      email: "alice@x.com", email_verified: true, sub: "sub1", nonce: "WRONG",
    });
    const r = await handleCallback(db, {
      ...baseInputs(),
      jwks: { keys: [publicJwk] },
      fetchImpl: makeFetch(tokenWithBadNonce),
    });
    expect(r).toEqual(expect.objectContaining({ kind: "error", reason: "nonce_mismatch" }));
  });

  it("rejects email_verified=false", async () => {
    db.prepare(`INSERT INTO users (email) VALUES ('alice@x.com')`).run();
    const tok = await buildToken({ email: "alice@x.com", email_verified: false, sub: "sub1", nonce: "n1" });
    const r = await handleCallback(db, {
      ...baseInputs(), jwks: { keys: [publicJwk] }, fetchImpl: makeFetch(tok),
    });
    expect(r).toEqual(expect.objectContaining({ kind: "error", reason: "email_unverified" }));
  });

  it("rejects wrong hd when ALLOWED_HD set", async () => {
    db.prepare(`INSERT INTO users (email) VALUES ('alice@x.com')`).run();
    const tok = await buildToken({ email: "alice@x.com", email_verified: true, sub: "sub1", nonce: "n1", hd: "other.com" });
    const r = await handleCallback(db, {
      ...baseInputs(),
      env: { client_id: CLIENT_ID, client_secret: CLIENT_SECRET, redirect_uri: REDIRECT, cookie_secret: COOKIE_SECRET, allowed_hd: "tapclap.com" },
      jwks: { keys: [publicJwk] },
      fetchImpl: makeFetch(tok),
    });
    expect(r).toEqual(expect.objectContaining({ kind: "error", reason: "wrong_hd" }));
  });

  it("rejects sub mismatch", async () => {
    db.prepare(`INSERT INTO users (email, google_sub) VALUES ('alice@x.com', 'OLD_SUB')`).run();
    const r = await handleCallback(db, baseInputs());
    expect(r).toEqual(expect.objectContaining({ kind: "error", reason: "sub_mismatch" }));
  });

  it("updates name/picture/sub on first login", async () => {
    db.prepare(`INSERT INTO users (email) VALUES ('alice@x.com')`).run();
    await handleCallback(db, baseInputs());
    const u = db.prepare(`SELECT name, picture_url, google_sub FROM users WHERE email='alice@x.com'`).get() as any;
    expect(u.name).toBe("A");
    expect(u.picture_url).toBe("p");
    expect(u.google_sub).toBe("sub1");
  });
});
