/**
 * Sanitize an untrusted `?next=` query param. Accepts only relative paths
 * (single leading slash). Anything else collapses to "/" — protects from
 * open-redirect attacks where the attacker links to /login?next=https://evil.com
 * and a careless callback redirects to evil.com after auth.
 */
export function safeNext(raw: string | null | undefined): string {
  if (!raw) return "/";
  if (!raw.startsWith("/")) return "/";
  if (raw.startsWith("//")) return "/";        // protocol-relative
  if (raw.includes("\\")) return "/";          // backslash tricks
  return raw;
}
