# Google OAuth Rollout Checklist (prod)

> Companion to `2026-04-30-google-auth-implementation.md` (the implementation plan, all 38 tasks landed on branch `auth/google-oauth`). This doc is the operator's checklist for the actual deploy.

**Migration decision: fresh DB on rollout.** Confirmed 2026-04-30. The new schema (Tasks 2.3, 5.4 follow-up) is incompatible with the legacy `username`-keyed tables. Existing prod history at `lgen.maxkdiffused.org` will be wiped; image files under `data/history_images/` are kept on disk but become orphans (no row points at them). See `memory/project_oauth_db_migration_open_question.md` if you want the trade-off rationale.

---

## Pre-flight (do BEFORE merging the branch)

1. **Run the manual smoke list** (Task 12.1, spec §11.3) on a staging instance with real Google OAuth credentials configured. The 13 items:
   1. Non-allowlist email → 403 `not_in_allowlist`.
   2. Unverified email → 403 `email_unverified`.
   3. Valid email → 303 redirect to `?next` target.
   4. `/login?next=https://evil.com` → after auth, redirect lands at `/` (sanitized by `safeNext`).
   5. POST `/api/auth/logout` → cookie cleared, frontend redirects to `/login`.
   6. Admin bans an active user → that user's tab redirects to `/login` within ~1s (SSE `user_banned`).
   7. Set `default_monthly_limit=2` on a model → 3rd generation request returns 429 `quota_exceeded`.
   8. Admin role generates without limit even with `default_monthly_limit=0` (admin-exempt).
   9. Admin raises a user's quota → that user's Generate button unblocks within ~1s (SSE `quota_updated`).
   10. Admin soft-deletes a user → files remain on disk, DB rows remain, the deleted user can't log back in (403 `deleted`).
   11. Two tabs same user → `Мои лимиты` tab updates in both within ~1s of any quota change.
   12. With `ALLOWED_HD=tapclap.com` set, a non-tapclap email → 403 `wrong_hd`.
   13. Hand-craft an `oauth_tx` cookie with `next: "https://evil.com"` → callback redirects to `/`.

   Document any deviations as bugs to fix on the branch before merge.

---

## Google Cloud Console setup

1. Create or open an OAuth 2.0 Client ID (Web application type) in your Google Cloud project.
2. **User Type: Internal** (recommended for tapclap.com Workspace deployments — restricts who can even reach the consent screen).
3. **Authorized redirect URIs** — add ALL of:
   - `https://lgen.maxkdiffused.org/api/auth/callback` (prod)
   - Any dev URL the team uses, e.g. `http://localhost:3000/api/auth/callback`
   - The 192.168.88.76:3000 dev URL if it's hit through Google directly (usually not — dev OAuth uses `localhost`).
4. Note the **Client ID** and **Client Secret**. They're about to land in env.

---

## Prod env vars

Edit `.env.production` (or container env) on the prod host. Required for OAuth:

```
GOOGLE_CLIENT_ID=<from Google Cloud Console>
GOOGLE_CLIENT_SECRET=<from Google Cloud Console>
GOOGLE_REDIRECT_URI=https://lgen.maxkdiffused.org/api/auth/callback
SESSION_COOKIE_SECRET=<32+ bytes hex; generate with: node -e "console.log(require('crypto').randomBytes(32).toString('hex'))">
BOOTSTRAP_ADMIN_EMAILS=weaking1@gmail.com,...other-admin-emails
```

Optional defense-in-depth:
```
ALLOWED_HD=tapclap.com
```

**Remove from prod env** (no longer used after Phase 10.4 cleanup):
```
ADMIN_PASSWORD
```

The other env vars (`WAVESPEED_API_KEY`, `FAL_KEY`, `COMFY_API_KEY`, `HISTORY_DATA_DIR`) stay unchanged.

---

## DB wipe (fresh-DB rollout)

On the prod host, BEFORE starting the new build:

```bash
# Stop the old build (whatever you use):
systemctl stop wavespeed-claude   # OR docker compose down  OR pm2 stop  OR kill the process

# Wipe the legacy DB (this is the destructive step — make sure you're done with the old data):
rm "$HISTORY_DATA_DIR/history.db"
rm -f "$HISTORY_DATA_DIR/history.db-shm" "$HISTORY_DATA_DIR/history.db-wal"  # WAL leftovers

# Optional: prune orphan images from the legacy flat layout. The new code
# writes under <email>/YYYY/MM/, so the legacy flat <uuid>.<ext> files are
# unreachable from the UI but still on disk:
# rm -rf "$HISTORY_DATA_DIR/history_images/"*
```

If you want to archive instead of delete, `mv` the files to `$HISTORY_DATA_DIR/legacy_archive/` first.

---

## Deploy

1. Push the merged branch to whatever build pipeline produces the prod artifact.
2. Start the new build. On first request:
   - `getDb()` opens a fresh `history.db`, runs `initSchema(_db)` to create the new 9-table schema.
   - `seedModels(_db)` populates the 5 known model rows (`nano-banana-pro`, `nano-banana-2`, `nano-banana`, `seedream-4-5`, `seedream-5-0-lite`) with `default_monthly_limit = NULL` (unlimited).
   - `bootstrapAdmins(_db, process.env.BOOTSTRAP_ADMIN_EMAILS)` upserts each CSV email as an admin user.

---

## Post-deploy verification

1. **Admin first-login**: visit `https://lgen.maxkdiffused.org`, get redirected to `/login`, click "Войти через Google", land back on `/` with admin badge in header. Verify `/admin` is reachable (Settings / Styles / Users / Models tabs all render).
2. **Add user via admin UI**: open Users tab, add a teammate's email. They can now sign in.
3. **Set a default quota** (optional): Models tab → Nano Banana Pro → set `default_monthly_limit = 100` (or whatever you want). New users will see this; admins remain unlimited.
4. **Test a non-allowlist email**: have someone outside the allowlist try to sign in. They should hit 403 `not_in_allowlist`.

If any of those fail, check:
- The `auth_events` table for the most recent event_type and details: `sqlite3 "$HISTORY_DATA_DIR/history.db" "SELECT * FROM auth_events ORDER BY id DESC LIMIT 10;"`.
- Server logs for `[history POST]`, `[user/preferences]`, `[audit] writeAuthEvent failed:`.
- Browser DevTools → Application → Cookies — confirm `__Host-session` is set, HttpOnly, Secure (in prod).

---

## Rollback (if needed)

1. Stop the new build.
2. Restore the archived `history.db` (if you `mv`'d instead of `rm`'d).
3. Deploy the prior commit from main.
4. Restart.

The legacy build expected `username` cookie + `ADMIN_PASSWORD` env, so make sure both are back in env if you rolled back.

---

## What gets cleaned up later (deferred follow-ups)

These are flagged in `MEMORY.md` and the plan reviews:

- **Phase 10 cleanup** — the `username: string` field on `IGenerationRecord` is still populated from `users.email` via JOIN (legacy field name). Phase 10 / future task can rename to `email` and migrate downstream consumers.
- **`stores/settings-store.ts`** — `currentUsername` is now vestigial after Task 7.2's URL strip. Marked for Phase 10 cleanup.
- **`getGenerationById` ownership check** — currently no `user_id` filter; the image-route (Task 7.4) gates by path, but a defensive parameter would close the gap.
- **`/api/admin/settings` route** — has a TODO note added in Task 10.4 that the role check should move from the middleware (which only checks session presence) into the route handler itself.
- **Schema timestamp consistency** — most write sites use `strftime('%Y-%m-%dT%H:%M:%fZ','now')` per commit `5dda318`; verify no new `datetime('now')` usages slipped in.
