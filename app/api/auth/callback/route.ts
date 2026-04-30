import { type NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/history-db";
import { handleCallback } from "@/lib/auth/handle-callback";
import { fetchGoogleJwks } from "@/lib/auth/google";

export const runtime = "nodejs";

const PROD = process.env.NODE_ENV === "production";
const TX_COOKIE = PROD ? "__Host-oauth_tx" : "oauth_tx";
const SESSION_COOKIE = PROD ? "__Host-session" : "session";

export async function GET(req: NextRequest) {
  const cookieSecret = process.env.SESSION_COOKIE_SECRET;
  const client_id = process.env.GOOGLE_CLIENT_ID;
  const client_secret = process.env.GOOGLE_CLIENT_SECRET;
  const redirect_uri = process.env.GOOGLE_REDIRECT_URI;
  if (!cookieSecret || !client_id || !client_secret || !redirect_uri) {
    return NextResponse.json({ error: "OAuth not configured" }, { status: 500 });
  }

  const db = getDb();
  const jwks = await fetchGoogleJwks();

  const result = await handleCallback(db, {
    code: req.nextUrl.searchParams.get("code"),
    state_in_query: req.nextUrl.searchParams.get("state"),
    oauth_tx_cookie: req.cookies.get(TX_COOKIE)?.value ?? null,
    ip: req.headers.get("x-forwarded-for")?.split(",")[0].trim() ?? null,
    user_agent: req.headers.get("user-agent") ?? null,
    env: { client_id, client_secret, redirect_uri, cookie_secret: cookieSecret, allowed_hd: process.env.ALLOWED_HD },
    jwks,
  });

  if (result.kind === "error") {
    const res = NextResponse.json({ error: result.reason }, { status: result.status });
    res.cookies.set({ name: TX_COOKIE, value: "", maxAge: 0, path: "/" });
    return res;
  }

  const res = NextResponse.redirect(new URL(result.redirect_to, req.url), 303);
  res.cookies.set({
    name: SESSION_COOKIE,
    value: result.session_id,
    httpOnly: true,
    sameSite: "lax",
    secure: PROD,
    path: "/",
    maxAge: 30 * 24 * 60 * 60,
  });
  res.cookies.set({ name: TX_COOKIE, value: "", maxAge: 0, path: "/" });
  return res;
}
