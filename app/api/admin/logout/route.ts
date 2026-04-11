import { NextResponse } from "next/server";

/**
 * POST /api/admin/logout
 *
 * Clears the `admin_auth` cookie. After this call, any subsequent request
 * to /admin/* or /api/admin/* will be rejected by the middleware until
 * the user logs in again.
 *
 * Note: this route is protected by the admin middleware, so only
 * authenticated users can log themselves out (which is the expected
 * behavior — anonymous users have nothing to log out from).
 */
export async function POST() {
  const response = NextResponse.json({ ok: true });
  response.cookies.delete("admin_auth");
  return response;
}
