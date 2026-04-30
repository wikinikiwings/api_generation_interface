import { jwtVerify, createLocalJWKSet, type JSONWebKeySet } from "jose";

const GOOGLE_ISSUER = "https://accounts.google.com";

export interface GoogleIdTokenPayload {
  email: string;
  email_verified: boolean;
  sub: string;
  name?: string;
  picture?: string;
  nonce?: string;
  hd?: string;
  iss: string;
  aud: string | string[];
  exp: number;
}

/**
 * Verify a Google id_token. Throws on any failure (signature, iss, aud, exp).
 * Caller is responsible for checking nonce/email_verified/hd/allowlist after this.
 *
 * `jwks` is the parsed JSON Web Key Set. In production this comes from
 * fetching https://www.googleapis.com/oauth2/v3/certs (with caching). In tests
 * we pass it directly.
 */
export async function verifyIdToken(
  token: string,
  opts: { audience: string; jwks: JSONWebKeySet }
): Promise<GoogleIdTokenPayload> {
  const localJwks = createLocalJWKSet(opts.jwks);
  const { payload } = await jwtVerify(token, localJwks, {
    issuer: GOOGLE_ISSUER,
    audience: opts.audience,
  });
  return payload as unknown as GoogleIdTokenPayload;
}

import crypto from "node:crypto";

const GOOGLE_AUTHORIZE_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const GOOGLE_JWKS_URL = "https://www.googleapis.com/oauth2/v3/certs";

export function buildAuthorizeUrl(args: {
  client_id: string;
  redirect_uri: string;
  state: string;
  nonce: string;
  code_challenge: string;
}): string {
  const u = new URL(GOOGLE_AUTHORIZE_URL);
  u.searchParams.set("client_id", args.client_id);
  u.searchParams.set("redirect_uri", args.redirect_uri);
  u.searchParams.set("response_type", "code");
  u.searchParams.set("scope", "openid email profile");
  u.searchParams.set("state", args.state);
  u.searchParams.set("nonce", args.nonce);
  u.searchParams.set("code_challenge", args.code_challenge);
  u.searchParams.set("code_challenge_method", "S256");
  u.searchParams.set("prompt", "select_account");
  u.searchParams.set("access_type", "online");
  return u.toString();
}

export async function generatePkcePair(): Promise<{ code_verifier: string; code_challenge: string }> {
  const code_verifier = crypto.randomBytes(32).toString("base64url");
  const code_challenge = crypto
    .createHash("sha256").update(code_verifier).digest("base64url");
  return { code_verifier, code_challenge };
}

export async function exchangeCodeForTokens(args: {
  code: string;
  code_verifier: string;
  client_id: string;
  client_secret: string;
  redirect_uri: string;
  fetchImpl?: typeof fetch;
}): Promise<{ id_token: string; access_token: string; expires_in: number }> {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code: args.code,
    code_verifier: args.code_verifier,
    client_id: args.client_id,
    client_secret: args.client_secret,
    redirect_uri: args.redirect_uri,
  });
  const f = args.fetchImpl ?? fetch;
  const res = await f(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Google token endpoint ${res.status}: ${text}`);
  }
  return await res.json();
}

// === JWKS cache (in-memory, refreshed on miss/expire) ===
let jwksCache: { fetched_at: number; data: any } | null = null;
const JWKS_TTL_MS = 60 * 60 * 1000;

export async function fetchGoogleJwks(opts: { fetchImpl?: typeof fetch; now?: number } = {}) {
  const now = opts.now ?? Date.now();
  if (jwksCache && now - jwksCache.fetched_at < JWKS_TTL_MS) return jwksCache.data;
  const f = opts.fetchImpl ?? fetch;
  const res = await f(GOOGLE_JWKS_URL);
  if (!res.ok) throw new Error(`Google JWKS fetch failed: ${res.status}`);
  const data = await res.json();
  if (!data || !Array.isArray((data as { keys?: unknown }).keys) || (data as { keys: unknown[] }).keys.length === 0) {
    throw new Error(`Google JWKS malformed: ${JSON.stringify(data).slice(0, 200)}`);
  }
  jwksCache = { fetched_at: now, data };
  return data;
}

/** For tests only — flush the cache between unit tests if needed. */
export function _resetJwksCacheForTests() {
  jwksCache = null;
}
