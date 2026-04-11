import { NextResponse, type NextRequest } from "next/server";

/**
 * Admin auth middleware.
 *
 * Protects /admin/* pages and /api/admin/* endpoints behind a password
 * stored in the ADMIN_PASSWORD env var. The password is never stored in
 * the cookie as plaintext — instead we store a salted SHA-256 hash of
 * it. Middleware compares the cookie value to the same hash of the env
 * password to decide access.
 *
 * ============================================================
 * Modes of operation
 * ============================================================
 *
 * 1. Dev mode, no password (NODE_ENV=development AND ADMIN_PASSWORD unset):
 *    → everyone is let through. This is the default for local development
 *      so you don't have to set up a password to click around.
 *
 * 2. Production mode, no password:
 *    → admin pages and API return 503 "Admin disabled".
 *      The deployer MUST set ADMIN_PASSWORD in the container env to enable
 *      the admin.
 *
 * 3. Any mode, password set:
 *    → admin pages require the auth cookie. Without it, pages redirect to
 *      /admin/login and APIs return 401 JSON.
 *
 * ============================================================
 * Explicitly public paths (not gated)
 * ============================================================
 *   - /admin/login          (obviously, users need to access the login page)
 *   - /api/admin/login      (needed to POST the password)
 *
 * Everything else under /admin/* or /api/admin/* requires auth.
 *
 * ============================================================
 * Extra hardening (production deployment)
 * ============================================================
 * For containerized public deployments, you can additionally restrict
 * /admin/* and /api/admin/* at the reverse proxy level (Caddy/nginx/
 * Traefik) to only allow requests from trusted IPs or your internal LAN.
 * That gives you two layers of defense: network-level access control +
 * application-level password auth.
 *
 * ============================================================
 * Edge runtime notes
 * ============================================================
 * Next.js middleware runs in the Edge runtime, which has limited Node
 * APIs. We use Web Crypto (crypto.subtle) which is globally available
 * in Edge, avoiding any `node:crypto` import.
 */

async function computeAdminCookieValue(password: string): Promise<string> {
  // Salted SHA-256 using the Web Crypto API.
  const encoder = new TextEncoder();
  const data = encoder.encode(`wavespeed-admin-v1:${password}`);
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(hashBuffer))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  // --------------------------------------------------------
  // Publicly accessible endpoints (bypass auth check)
  // --------------------------------------------------------
  if (pathname === "/admin/login" || pathname === "/api/admin/login") {
    return NextResponse.next();
  }

  const isAdminPage = pathname.startsWith("/admin");
  const isAdminApi = pathname.startsWith("/api/admin");
  if (!isAdminPage && !isAdminApi) {
    // Shouldn't actually reach here thanks to the matcher config below,
    // but defensive bail-out in case the matcher is misconfigured.
    return NextResponse.next();
  }

  const password = process.env.ADMIN_PASSWORD;

  // --------------------------------------------------------
  // No password configured
  // --------------------------------------------------------
  if (!password) {
    // Dev mode: wave through so development is frictionless.
    if (process.env.NODE_ENV === "development") {
      return NextResponse.next();
    }
    // Production: refuse access.
    if (isAdminApi) {
      return new NextResponse(
        JSON.stringify({
          error: "Admin is disabled: ADMIN_PASSWORD not configured on server",
        }),
        { status: 503, headers: { "Content-Type": "application/json" } }
      );
    }
    return new NextResponse(
      "Admin is disabled (ADMIN_PASSWORD not configured)",
      { status: 503 }
    );
  }

  // --------------------------------------------------------
  // Password set → check cookie
  // --------------------------------------------------------
  const expectedCookieValue = await computeAdminCookieValue(password);
  const cookieValue = request.cookies.get("admin_auth")?.value;

  if (!cookieValue || cookieValue !== expectedCookieValue) {
    if (isAdminApi) {
      return new NextResponse(
        JSON.stringify({ error: "Unauthorized" }),
        { status: 401, headers: { "Content-Type": "application/json" } }
      );
    }
    // Redirect pages to login, preserving the original path in `?next=`
    // so we can bounce back after successful auth.
    const loginUrl = new URL("/admin/login", request.url);
    if (pathname !== "/admin") {
      loginUrl.searchParams.set("next", pathname);
    }
    return NextResponse.redirect(loginUrl);
  }

  return NextResponse.next();
}

export const config = {
  /**
   * Only run this middleware for admin routes. Matching everywhere would
   * add latency to every request including static assets.
   */
  matcher: ["/admin/:path*", "/api/admin/:path*"],
};
