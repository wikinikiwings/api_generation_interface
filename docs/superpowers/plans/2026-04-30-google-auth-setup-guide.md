# Google OAuth — Setup Guide (dev → prod)

> Step-by-step instructions to configure Google OAuth and run the Phase 12 smoke list. Companion to `2026-04-30-google-auth-implementation.md` (the plan, all 38 tasks landed) and `2026-04-30-google-auth-rollout.md` (the operator's deploy checklist).
>
> **Read this when you're ready to actually test/deploy** — code is done, branch is `auth/google-oauth` (48 commits ahead of `main`, 220 vitest cases green).

---

## TL;DR — minimum to log in locally

1. Create OAuth client at [console.cloud.google.com](https://console.cloud.google.com/) → Credentials → Create credentials → OAuth client ID → Web application.
2. Set redirect URI: `http://localhost:3000/api/auth/callback`.
3. Copy Client ID + Client Secret.
4. Generate session secret: `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`.
5. `cp .env.example .env.local`, fill the 5 new vars.
6. `npm run dev` → open `http://localhost:3000` → Google login → done.

The full walkthrough below covers the screens you'll see, plus prod setup, plus the smoke list.

---

## Step 1 — Google Cloud project

If you already have a Cloud project for tapclap.com / Workspace, use it. Otherwise:

1. Open [console.cloud.google.com](https://console.cloud.google.com/).
2. Top bar → project dropdown → New Project.
3. Name it `lgen` (or whatever; not user-visible).
4. Wait for the project to provision (~10 sec).
5. Confirm the project dropdown shows the new name.

---

## Step 2 — OAuth consent screen

1. Left nav → APIs & Services → OAuth consent screen.
2. **User Type:**
   - **Internal** (recommended) if you have Google Workspace at tapclap.com — only @tapclap.com accounts can even reach the consent screen. Best UX, strongest gate.
   - **External** if no Workspace OR you need non-tapclap users. Adds a "Verification status: Testing" banner; needs explicit Test User entries (up to 100) until you go through Google's verification.
3. **App information:**
   - App name: `LGen` (or whatever you want — users see this on the consent screen).
   - User support email: your address.
   - Developer contact: your address.
4. **Scopes:** click "Add or Remove Scopes" → check `openid`, `userinfo.email`, `userinfo.profile`. Save. (These three are exactly what `buildAuthorizeUrl` requests — `scope: "openid email profile"`.)
5. **Test users** (External only): add the emails you'll test with. Anyone not in this list gets blocked at Google's screen, BEFORE our callback even runs.
6. Save & Continue through the rest. Publish status stays "In production" (Internal) or "Testing" (External) — both fine for this app.

---

## Step 3 — OAuth Client ID (web app)

1. Left nav → APIs & Services → Credentials.
2. Top → "+ Create Credentials" → "OAuth client ID".
3. Application type: **Web application**.
4. Name: `lgen-dev` (or split dev/prod into separate clients — recommended for cleaner key rotation).

5. **Authorized JavaScript origins** — add these as needed:
   - `http://localhost:3000` (local dev)
   - `http://192.168.88.76:3000` (LAN dev, if you use it)
   - `https://lgen.maxkdiffused.org` (prod)

6. **Authorized redirect URIs** — add ONE per environment:
   - `http://localhost:3000/api/auth/callback` (local dev)
   - `http://192.168.88.76:3000/api/auth/callback` (LAN dev)
   - `https://lgen.maxkdiffused.org/api/auth/callback` (prod)

   The redirect URI must match `GOOGLE_REDIRECT_URI` in env exactly — including scheme, port, path. A typo causes Google to reject the redirect with `redirect_uri_mismatch`.

7. Click Create. A modal shows your **Client ID** and **Client Secret**. Copy both. (You can see them again later under Credentials → click the row.)

---

## Step 4 — Local `.env.local`

```bash
cp .env.example .env.local
```

Edit `.env.local`. The 5 new auth vars are at the bottom (the existing vars like `WAVESPEED_API_KEY`, `FAL_KEY`, `COMFY_API_KEY`, `HISTORY_DATA_DIR` stay unchanged):

```
GOOGLE_CLIENT_ID=<paste from Step 3>
GOOGLE_CLIENT_SECRET=<paste from Step 3>
GOOGLE_REDIRECT_URI=http://localhost:3000/api/auth/callback

SESSION_COOKIE_SECRET=<run the command below and paste>

BOOTSTRAP_ADMIN_EMAILS=weaking1@gmail.com
# CSV; add other admins comma-separated. Idempotent — leave on; rerunning seeds.
# Removing emails here does NOT demote existing admins (manage via /admin/users).

# Optional defense-in-depth: only @tapclap.com accounts can sign in.
# ALLOWED_HD=tapclap.com
```

Generate the session secret (32 bytes hex):

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

You can leave `ADMIN_PASSWORD` blank (or remove it entirely) — Phase 10.4 cleanup deleted the legacy admin route that read it.

---

## Step 5 — Wipe DB and start dev server

The dev DB at `data/history.db` was created under the legacy `username` schema. **Delete it before starting** so the new schema initialises clean:

```bash
# Stop the dev server first if running.
rm -f data/history.db data/history.db-shm data/history.db-wal
# (Optional) wipe legacy flat-layout images:
# rm -rf data/history_images/*

npm run dev
```

On first request, the singleton in `lib/history-db.ts:29` runs:
- `initSchema(_db)` → creates 9 fresh tables.
- `seedModels(_db)` → inserts 5 model rows with `default_monthly_limit=NULL` (unlimited).
- `bootstrapAdmins(_db, BOOTSTRAP_ADMIN_EMAILS)` → upserts each CSV email as `role='admin'`.

---

## Step 6 — First login

1. Open `http://localhost:3000`.
2. Middleware sees no session cookie → 307 to `/login?next=/`.
3. `/login` shows the "Войти через Google" card.
4. Click → `/api/auth/google?next=%2F` → state/nonce/PKCE generated, `oauth_tx` cookie set, 302 to Google.
5. Google's consent screen appears. If you set up External + you're not in Test Users, you get blocked here. Otherwise pick the account.
6. Google redirects to `/api/auth/callback?code=...&state=...`.
7. Callback: decodes oauth_tx → exchanges code → verifies id_token → checks email_verified + (optional) hd + allowlist → UPSERTs your `users` row (your bootstrap row gets `google_sub`, `name`, `picture_url`, `last_login_at` populated) → creates session → 303 to `/`.
8. You land on `/` with the header showing your name + admin badge (because `BOOTSTRAP_ADMIN_EMAILS` includes your email).

If something fails:
- DevTools → Network → look for the failing request (likely `/api/auth/callback` returns 4xx).
- DevTools → Application → Cookies → check `oauth_tx` exists pre-login, `session` exists post-login.
- Server console: every reject path writes a structured `[audit] writeAuthEvent` log. Failed login? `sqlite3 data/history.db "SELECT * FROM auth_events ORDER BY id DESC LIMIT 5;"` shows the reason.

---

## Step 7 — Manual smoke (Task 12.1)

The 13 items from spec §11.3, designed to run against a real OAuth-configured instance:

| # | Scenario | Expected result |
|---|----------|----------------|
| 1 | Sign in with an email NOT in `users` table → | `/api/auth/callback` audits `login_denied_not_in_allowlist`, returns 403; UI shows error. |
| 2 | Sign in with `email_verified=false` (Google account that hasn't completed verification) → | audits `login_denied_email_unverified`, returns 403. |
| 3 | Visit `/foo` → redirected to `/login?next=/foo` → sign in → land at `/foo`. |
| 4 | Visit `/login?next=https://evil.com` → sign in → land at `/` (sanitized by `safeNext`). |
| 5 | Click "Выйти" in header menu → POST `/api/auth/logout` → cookie cleared → redirect to `/login`. |
| 6 | Two browsers: as admin in browser A, /admin → Users → ban Alice. Browser B (Alice) within ~1s: redirect to `/login`. |
| 7 | As admin: /admin → Models → set `nano-banana-pro` `default_monthly_limit=2`. Switch to Alice. Generate twice (200 OK), 3rd attempt: 429 with `quota_exceeded` toast. |
| 8 | As admin: confirm Generate works regardless of any limit (admin-exempt). |
| 9 | While Alice is at her limit: as admin raise it. Within ~1s, Alice's Generate button unblocks (SSE `quota_updated` → BroadcastChannel("quotas") → QuotasProvider refetch). |
| 10 | As admin: /admin → Users → soft-delete Alice. Files on disk and rows in DB stay. Alice tries to log back in → 403 `deleted`. |
| 11 | As Alice: open two tabs. In tab 1 generate. In tab 2 the "Мои лимиты" used count increments. |
| 12 | Set `ALLOWED_HD=tapclap.com` in env, restart dev. Sign in with `weaking1@gmail.com` → 403 `wrong_hd`. Sign in with a `@tapclap.com` Google account → success. |
| 13 | Hand-craft an `oauth_tx` cookie (you'd need the secret) with `next: "https://evil.com"` — even if accepted, the callback redirects to `/` (defense-in-depth via `safeNext` re-validation in callback). |

Document any failures as bugs to fix on the branch BEFORE merging to main.

---

## Step 8 — Production deploy

When the smoke list passes locally, follow `2026-04-30-google-auth-rollout.md`:

1. Add a separate `lgen-prod` OAuth client (or reuse the dev client by adding the prod redirect URI — separate clients are cleaner for key rotation).
2. Set prod env on `lgen.maxkdiffused.org` host (or container env): same 5 vars but with `GOOGLE_REDIRECT_URI=https://lgen.maxkdiffused.org/api/auth/callback`.
3. Wipe prod `history.db` (decision recorded in `memory/project_oauth_db_migration_open_question.md`).
4. Remove `ADMIN_PASSWORD` from prod env.
5. Deploy.
6. First admin login → /admin → Users → invite the rest of the team.

---

## Common gotchas

- **`redirect_uri_mismatch`**: the URI in `.env.local` doesn't byte-match what's in Cloud Console. Trailing slash matters; `http` vs `https` matters; port matters. Fix in either side.
- **`access_blocked` in browser**: External user type, your account isn't a Test User. Add yourself in Cloud Console → OAuth consent screen → Test users.
- **`Email not verified` reject** with email_verified=false: this is rare for ordinary Google accounts. If it bites you on a custom Workspace setup, check the user's Google account settings.
- **`Lost session every page load`**: usually `SESSION_COOKIE_SECRET` isn't actually 32+ bytes hex, or it's getting rotated between requests (HMR resets `process.env`?). Set in `.env.local`, restart dev server.
- **CSP / `__Host-` cookie not setting** on http://localhost: the code uses plain `session` (not `__Host-session`) when `NODE_ENV !== "production"`. Confirm `process.env.NODE_ENV === "development"` in dev (Next sets this automatically; don't override it in `.env.local`).
- **JWKS fetch fails behind a corp proxy**: `lib/auth/google.ts:fetchGoogleJwks` requires outbound HTTPS to `https://www.googleapis.com/oauth2/v3/certs`. If your dev environment blocks egress, configure `HTTPS_PROXY` env var or run the dev server outside the proxy.

---

## What's deferred (post-merge polish)

Listed at the end of `2026-04-30-google-auth-rollout.md`:

- Rename `IGenerationRecord.username` → `email` and migrate consumers (Phase 10 cleanup).
- Drop vestigial `currentUsername` in `stores/settings-store.ts`.
- Move admin role check from middleware (which only checks session presence) into `/api/admin/settings` route handler.
- Audit any remaining `datetime('now')` usages (vs the standardized `strftime('%Y-%m-%dT%H:%M:%fZ','now')`).
- Tighten the negative tests in `lib/auth/__tests__/google-verify.test.ts` so wrong-issuer / wrong-audience cases test the actual claim mismatch (currently they fail on signature mismatch first because each negative case generates a fresh keypair). Reviewer-flagged for a follow-up.

These don't block merge or deploy; they're cleanup after the auth flow is verified working.
