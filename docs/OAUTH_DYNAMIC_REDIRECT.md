# Dynamic OAuth redirect_uri

## Problem

A single Google OAuth client needs to support three deployment surfaces:

| Surface | URL |
|---|---|
| Local dev (Next.js dev server) | `http://localhost:3000` |
| LAN over VPN | `http://192.168.88.76:3000` |
| Production (Caddy + Docker) | `https://localgen.maxkdiffused.org` |

`GOOGLE_REDIRECT_URI` as a static env var can only encode one of these.
A static value pinned to prod breaks dev; pinned to dev breaks prod.

## Solution

`redirect_uri` is now resolved **per request** from incoming HTTP headers,
validated against an allowlist, and persisted in the `oauth_tx` cookie so
that the callback echoes it byte-for-byte during code exchange (Google
returns `invalid_grant` if the two URIs don't match exactly).

### Files

- `lib/auth/redirect-uri.ts` — `resolveRedirectUri(req)`: reads
  `X-Forwarded-Proto` / `X-Forwarded-Host` / `Host`, validates host against
  `ALLOWED_REDIRECT_HOSTS`, returns full callback URL. Falls back to
  `GOOGLE_REDIRECT_URI` env if allowlist not configured.
- `lib/auth/oauth-tx.ts` — `OAuthTxPayload.redirect_uri` (optional field).
  Optional for backward compat with cookies issued before this change.
- `app/api/auth/google/route.ts` — calls `resolveRedirectUri(req)`,
  stores result in the tx cookie.
- `app/api/auth/callback/route.ts` — passes env `GOOGLE_REDIRECT_URI`
  only as a legacy fallback. Real value comes from the tx cookie.
- `lib/auth/handle-callback.ts` — prefers `tx.redirect_uri` over
  `inp.env.redirect_uri` when both are available.

### Security model

The `Host` header is attacker-controlled. The mitigation is a strict
allowlist (`ALLOWED_REDIRECT_HOSTS` env var, CSV of `host` or
`host:port`). Unknown hosts get rejected at the helper level → the call
falls through to env, which is either correct or unset.

Even if an attacker forges a Host header that happens to be in the
allowlist, Google itself validates `redirect_uri` against the OAuth
client's registered URIs. So the worst case is "auth fails", not "auth
code leaks to attacker".

## Required env vars (production)

```env
ALLOWED_REDIRECT_HOSTS=localhost:3000,192.168.88.76:3000,localgen.maxkdiffused.org
GOOGLE_CLIENT_ID=...
GOOGLE_CLIENT_SECRET=...
# GOOGLE_REDIRECT_URI is now optional — kept as a legacy fallback only.
```

## Required Google Cloud Console config

OAuth client → **Authorized redirect URIs** must list every surface:

- `http://localhost:3000/api/auth/callback`
- `http://192.168.88.76:3000/api/auth/callback`
- `https://localgen.maxkdiffused.org/api/auth/callback`

OAuth client → **Authorized JavaScript origins** (no path, no trailing slash):

- `http://localhost:3000`
- `http://192.168.88.76:3000`
- `https://localgen.maxkdiffused.org`

## Caddy

Caddy's `reverse_proxy` directive sets `X-Forwarded-Proto`,
`X-Forwarded-Host`, and `X-Forwarded-For` by default. No special config
needed beyond:

```caddy
localgen.maxkdiffused.org {
    reverse_proxy localhost:3000
}
```

## Caveats

- Cookie name flips to `__Host-oauth_tx` when `NODE_ENV=production`,
  which requires `Secure` (i.e. HTTPS at the browser level). LAN access
  via `http://192.168.88.76:3000` only works if `NODE_ENV !== production`
  on that build. For now, LAN access is dev-only; if LAN access in prod
  becomes a requirement, we'd need to relax the `__Host-` prefix.
