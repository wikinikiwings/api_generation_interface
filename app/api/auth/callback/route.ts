import { type NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/history-db";
import { handleCallback } from "@/lib/auth/handle-callback";
import { fetchGoogleJwks } from "@/lib/auth/google";
import { SESSION_COOKIE_NAME, TX_COOKIE_NAME } from "@/lib/auth/cookie-name";
import { getTrustedOrigin } from "@/lib/auth/redirect-uri";

export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  const cookieSecret = process.env.SESSION_COOKIE_SECRET;
  const client_id = process.env.GOOGLE_CLIENT_ID;
  const client_secret = process.env.GOOGLE_CLIENT_SECRET;
  if (!cookieSecret || !client_id || !client_secret) {
    return NextResponse.json({ error: "OAuth not configured" }, { status: 500 });
  }

  // redirect_uri is resolved per-request and persisted in oauth_tx by
  // /api/auth/google. handleCallback reads it from the decoded tx
  // (falling back to env GOOGLE_REDIRECT_URI for legacy cookies).
  const redirect_uri_fallback = process.env.GOOGLE_REDIRECT_URI ?? "";

  const db = getDb();
  const jwks = await fetchGoogleJwks();

  const result = await handleCallback(db, {
    code: req.nextUrl.searchParams.get("code"),
    state_in_query: req.nextUrl.searchParams.get("state"),
    oauth_tx_cookie: req.cookies.get(TX_COOKIE_NAME)?.value ?? null,
    ip: req.headers.get("x-forwarded-for")?.split(",")[0].trim() ?? null,
    user_agent: req.headers.get("user-agent") ?? null,
    env: { client_id, client_secret, redirect_uri: redirect_uri_fallback, cookie_secret: cookieSecret, allowed_hd: process.env.ALLOWED_HD },
    jwks,
  });

  const PROD = process.env.NODE_ENV === "production";

  if (result.kind === "error") {
    const res = NextResponse.json({ error: result.reason }, { status: result.status });
    res.cookies.set({ name: TX_COOKIE_NAME, value: "", maxAge: 0, path: "/" });
    return res;
  }

  // Resolve the public-facing origin from request headers, NOT from
  // req.url. Inside Docker, req.url has the container-internal hostname
  // (e.g. http://0.0.0.0:3000), which would otherwise leak into the
  // Location header and send the user to a broken URL after login.
  const publicOrigin = getTrustedOrigin(req) ?? new URL(req.url).origin;
  const res = NextResponse.redirect(new URL(result.redirect_to, publicOrigin), 303);
  res.cookies.set({
    name: SESSION_COOKIE_NAME,
    value: result.session_id,
    httpOnly: true,
    sameSite: "lax",
    secure: PROD,
    path: "/",
    maxAge: 30 * 24 * 60 * 60,
  });
  res.cookies.set({ name: TX_COOKIE_NAME, value: "", maxAge: 0, path: "/" });
  return res;
}
