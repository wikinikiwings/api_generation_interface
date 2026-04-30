import crypto from "node:crypto";

export interface OAuthTxPayload {
  state: string;
  nonce: string;
  code_verifier: string;
  next: string;
  ts: number;
}

const TTL_MS = 10 * 60 * 1000;

function b64urlEncode(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64urlDecode(str: string): Buffer {
  const pad = (4 - (str.length % 4)) % 4;
  return Buffer.from(str.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat(pad), "base64");
}

function hmac(secret: string, data: string): string {
  return b64urlEncode(crypto.createHmac("sha256", secret).update(data).digest());
}

/**
 * Encode `payload` as `<b64url(JSON)>.<HMAC>`. Cookie-safe.
 * The signature covers the b64-encoded JSON, not the raw object — that way
 * we don't have to care about JSON-key-order canonicalization.
 */
export function encodeOAuthTx(payload: OAuthTxPayload, secret: string): string {
  const body = b64urlEncode(Buffer.from(JSON.stringify(payload), "utf-8"));
  const sig = hmac(secret, body);
  return `${body}.${sig}`;
}

/**
 * Decode and validate. Throws on:
 *  - malformed input
 *  - signature mismatch (tampered or wrong secret)
 *  - payload older than TTL_MS (default 10 min)
 *
 * `opts.now` is for testability.
 */
export function decodeOAuthTx(
  token: string,
  secret: string,
  opts: { now?: number } = {}
): OAuthTxPayload {
  if (!token || typeof token !== "string") throw new Error("oauth_tx: malformed");
  const dot = token.indexOf(".");
  if (dot < 0) throw new Error("oauth_tx: malformed");
  const body = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  if (!body || !sig) throw new Error("oauth_tx: malformed");

  const expected = hmac(secret, body);
  // Constant-time compare
  if (expected.length !== sig.length || !crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(sig))) {
    throw new Error("oauth_tx: signature mismatch");
  }

  let payload: OAuthTxPayload;
  try {
    payload = JSON.parse(b64urlDecode(body).toString("utf-8"));
  } catch {
    throw new Error("oauth_tx: malformed payload");
  }

  const now = opts.now ?? Date.now();
  if (typeof payload.ts !== "number" || now - payload.ts > TTL_MS) {
    throw new Error("oauth_tx: expired");
  }

  return payload;
}
