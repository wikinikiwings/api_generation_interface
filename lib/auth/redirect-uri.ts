/**
 * Compute the OAuth redirect_uri from the incoming request.
 *
 * Why dynamic instead of an env var: we want one OAuth client to serve
 * multiple deployment surfaces — http://localhost:3000 (local dev),
 * http://192.168.88.76:3000 (LAN access over VPN), and
 * https://localgen.maxkdiffused.org (production). A static env var can
 * only encode one of these.
 *
 * Security: the Host header is attacker-controlled. We mitigate that with
 * an allowlist (ALLOWED_REDIRECT_HOSTS). Anything outside the list falls
 * back to GOOGLE_REDIRECT_URI (env). Google itself is the second line of
 * defence — it rejects any redirect_uri not registered in the OAuth client
 * config, so even a successful header forgery cannot redirect the auth
 * code to an attacker-controlled host.
 *
 * Behind Caddy: NEXT.js inside the container sees http://localhost:3000
 * from Caddy's perspective. To get the public scheme/host, we honour
 * X-Forwarded-Proto and X-Forwarded-Host when present. Caddy's
 * reverse_proxy directive sets both by default.
 */

import type { NextRequest } from "next/server";

const FALLBACK_PATH = "/api/auth/callback";

/**
 * Parses a comma-separated allowlist from env. Each entry is "host" or
 * "host:port" (no scheme). Example:
 *   ALLOWED_REDIRECT_HOSTS=localhost:3000,192.168.88.76:3000,localgen.maxkdiffused.org
 */
function parseAllowedHosts(): Set<string> {
  const raw = process.env.ALLOWED_REDIRECT_HOSTS ?? "";
  return new Set(
    raw
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean)
  );
}

/**
 * Returns the public-facing origin (scheme://host[:port]) for this request,
 * trusting X-Forwarded-* headers ONLY when the resulting host is in the
 * allowlist. Returns null if no trustworthy origin can be derived.
 */
function getTrustedOrigin(req: NextRequest): string | null {
  const allowed = parseAllowedHosts();
  if (allowed.size === 0) return null; // allowlist not configured → caller falls back to env

  const xfHost = req.headers.get("x-forwarded-host");
  const xfProto = req.headers.get("x-forwarded-proto");
  const host = req.headers.get("host");

  // Prefer X-Forwarded-Host if present (Caddy sets it), else fall back to Host.
  const candidateHost = (xfHost ?? host ?? "").split(",")[0].trim().toLowerCase();
  if (!candidateHost) return null;
  if (!allowed.has(candidateHost)) return null;

  // Scheme: trust X-Forwarded-Proto when set, else default by port-implication.
  // localhost / LAN IPs imply http; public domain implies https.
  let scheme = (xfProto ?? "").split(",")[0].trim().toLowerCase();
  if (scheme !== "http" && scheme !== "https") {
    scheme = candidateHost.startsWith("localhost") || /^\d+\.\d+\.\d+\.\d+/.test(candidateHost)
      ? "http"
      : "https";
  }

  return `${scheme}://${candidateHost}`;
}

/**
 * Public entry point. Returns the redirect_uri to use for this request.
 * Order of preference:
 *   1. Origin derived from request headers, if host is in ALLOWED_REDIRECT_HOSTS
 *   2. GOOGLE_REDIRECT_URI from env (legacy fallback)
 *   3. null — caller should treat as misconfiguration
 */
export function resolveRedirectUri(req: NextRequest): string | null {
  const origin = getTrustedOrigin(req);
  if (origin) return `${origin}${FALLBACK_PATH}`;
  return process.env.GOOGLE_REDIRECT_URI ?? null;
}
