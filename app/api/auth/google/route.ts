/**
 * GET /api/auth/google — start of OAuth flow.
 *
 * Generates state/nonce/PKCE pair, sets the HMAC-signed oauth_tx cookie,
 * redirects (302) to Google's authorize endpoint. The callback at
 * /api/auth/callback verifies the response.
 *
 * Hard to unit-test (cookies + 302). Exercised by the manual smoke
 * test list in Phase 12 of the plan.
 */

import { NextResponse, type NextRequest } from "next/server";
import crypto from "node:crypto";
import { buildAuthorizeUrl, generatePkcePair } from "@/lib/auth/google";
import { encodeOAuthTx } from "@/lib/auth/oauth-tx";
import { safeNext } from "@/lib/auth/safe-next";

export const runtime = "nodejs";

const PROD = process.env.NODE_ENV === "production";
const COOKIE_NAME = PROD ? "__Host-oauth_tx" : "oauth_tx";

export async function GET(req: NextRequest) {
  const client_id = process.env.GOOGLE_CLIENT_ID;
  const redirect_uri = process.env.GOOGLE_REDIRECT_URI;
  const secret = process.env.SESSION_COOKIE_SECRET;
  if (!client_id || !redirect_uri || !secret) {
    return NextResponse.json({ error: "OAuth not configured" }, { status: 500 });
  }

  const next = safeNext(req.nextUrl.searchParams.get("next"));
  const state = crypto.randomBytes(32).toString("base64url");
  const nonce = crypto.randomBytes(32).toString("base64url");
  const { code_verifier, code_challenge } = await generatePkcePair();

  const cookieValue = encodeOAuthTx(
    { state, nonce, code_verifier, next, ts: Date.now() },
    secret
  );
  const authorize = buildAuthorizeUrl({ client_id, redirect_uri, state, nonce, code_challenge });

  const res = NextResponse.redirect(authorize, 302);
  res.cookies.set({
    name: COOKIE_NAME,
    value: cookieValue,
    httpOnly: true,
    sameSite: "lax",
    secure: PROD,
    path: "/",
    maxAge: 600,
  });
  return res;
}
