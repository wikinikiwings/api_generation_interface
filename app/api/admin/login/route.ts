import { NextResponse } from "next/server";

/**
 * Compute the value stored in the `admin_auth` cookie.
 *
 * This is a salted SHA-256 hash of the password, NOT the plaintext.
 * Using a fixed salt (`wavespeed-admin-v1:`) makes the hash specific
 * to this app so it isn't trivially exchangeable with hashes from
 * other services that happen to use the same password.
 *
 * This function is duplicated (not imported) from middleware.ts to avoid
 * runtime boundary issues — middleware runs in Edge runtime, API routes
 * run in Node by default, and sharing a file between them can be finicky
 * with bundling. Both use only Web Crypto API, so they stay compatible.
 */
async function computeAdminCookieValue(password: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(`wavespeed-admin-v1:${password}`);
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(hashBuffer))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * POST /api/admin/login
 *
 * Accepts `{ password: string }` JSON body. If it matches `ADMIN_PASSWORD`
 * from env, sets the `admin_auth` cookie with the computed hash and returns
 * `{ ok: true }`. On mismatch, returns 401 without setting any cookie.
 *
 * The cookie is:
 *   - httpOnly (JS cannot read it — mitigates XSS)
 *   - sameSite=lax (CSRF-safe for typical navigation)
 *   - secure in production (HTTPS only)
 *   - path=/ (available across the app)
 *   - 7 day expiry
 *
 * Note: this endpoint is publicly accessible — middleware.ts explicitly
 * skips the auth check for /api/admin/login, otherwise no one could log in.
 */
export async function POST(request: Request) {
  const envPassword = process.env.ADMIN_PASSWORD;
  if (!envPassword) {
    return NextResponse.json(
      { error: "Admin is disabled on server (ADMIN_PASSWORD not set)" },
      { status: 503 }
    );
  }

  let body: { password?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  if (typeof body.password !== "string" || body.password.length === 0) {
    return NextResponse.json(
      { error: "Password is required" },
      { status: 400 }
    );
  }

  if (body.password !== envPassword) {
    return NextResponse.json({ error: "Incorrect password" }, { status: 401 });
  }

  const cookieValue = await computeAdminCookieValue(envPassword);
  const response = NextResponse.json({ ok: true });
  response.cookies.set("admin_auth", cookieValue, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 60 * 60 * 24 * 7, // 7 days
  });
  return response;
}
