# Admin User Hard-Delete — Post-Ship Handoff

**Date:** 2026-05-07
**Branch:** `auth/google-oauth` (continuation; not yet merged to main)
**Status:** Shipped to local dev, smoke-tested by user (rename retry verified). 252/252 vitest pass, `tsc --noEmit` clean. Bundles cleanly into the auth-rollout PR.
**Intended readers:** any future agent or engineer touching admin user management, the audit log, on-disk image storage, or the soft/hard-delete contract.

## Quick-nav

- [Scope](#scope)
- [User-visible behavior](#user-visible-behavior)
- [Module map](#module-map)
- [Data flow](#data-flow)
- [Soft-delete vs hard-delete contract](#soft-delete-vs-hard-delete-contract)
- [Failure modes and contracts](#failure-modes-and-contracts)
- [Architectural conventions established or reinforced](#architectural-conventions-established-or-reinforced)
- [Pitfalls — easy ways to re-break things](#pitfalls--easy-ways-to-re-break-things)
- [Test coverage](#test-coverage)
- [Open follow-ups](#open-follow-ups)

---

## Scope

The user reported that admins had no way to free a soft-deleted user's email slot — re-adding the same email returned 409 because of the `UNIQUE COLLATE NOCASE` constraint on `users.email`. The shipped feature adds a deliberate, two-step "Стереть навсегда" admin action that:

1. Frees the email slot in the database (so re-adding works).
2. Preserves the user's generated content on disk under a `deleted_{email}/` (or `deleted_2_{email}/`, etc.) cold archive.
3. Drops a `_SUMMARY.csv` in the archive folder with per-month per-model generation counts so billing history can be reconstructed without DB access.

No schema changes; all foreign keys were already correctly configured (`sessions`, `user_quotas`, `user_preferences` cascade; `generations` restrict, removed via explicit transaction; `auth_events` no FK so paper trail survives).

Spec lives at `docs/superpowers/specs/2026-05-07-admin-user-hard-delete-design.md`.
Plan lives at `docs/superpowers/plans/2026-05-07-admin-user-hard-delete.md`.

---

## User-visible behavior

**Where:** Admin panel → Users tab → tick "Показать удалённых" → on any row with `status='deleted'` a new red **"Стереть навсегда"** button appears alongside "Восстановить".

**Click flow:**
1. Click opens a Radix-based confirmation modal (`components/admin/purge-user-dialog.tsx`).
2. Modal warns about irreversibility, lists what will be wiped (user, generations, quota overrides, sessions), and previews the on-disk rename (`{email}/ → deleted_{email}/`).
3. Email-typed gate: confirm button enables only when typed text equals `user.email` (case-insensitive after trim).
4. Submit → DELETE `/api/admin/users/[id]` with `{ confirmation_email: typed.trim() }`.
5. Mid-flight: the dialog blocks both the X close button (Radix `onOpenChange` wrapped) and the Escape key while `submitting=true`.
6. Success → green toast "Пользователь стёрт навсегда", dialog closes, table refetches. Other admin tabs receive `admin.user_purged` SSE and refetch.
7. Success with `warning: rename_failed` → 10-second yellow toast: "Пользователь стёрт. Папка не переименована — переименуйте вручную: `{email}/` → `{intended_target}/`". DB is clean; admin manually fixes the disk.
8. Error → red toast with localized text per error code (`confirmation_mismatch`, `must_be_soft_deleted_first`, `self_purge_forbidden`, `not_found`, `summary_write_failed`, `db_delete_failed`, `invalid_body`).

The original soft-delete "Удалить" button still uses `window.confirm()` — the inconsistency is intentional, soft-delete is reversible.

---

## Module map

```
lib/admin/                          NEW directory
├── folder-rename.ts                Pure FS — find free deleted_N slot, rename with retry
├── summary-csv.ts                  Pure DB query → CSV string (3 # comments + flat data)
├── purge-user.ts                   Orchestration: CSV write → atomic DB transaction; tagged errors
└── __tests__/                      19 unit tests across the three modules

app/api/admin/users/[id]/route.ts   ADDED `DELETE` handler + fanOutUserPurged helper
                                    (existing PATCH untouched)

components/admin/
├── purge-user-dialog.tsx           NEW — Radix modal with email-typed gate + lock-during-submit
└── users-tab.tsx                   MODIFIED 4 places — import, state, SSE listener, button + dialog

lib/auth/audit.ts                   MODIFIED — added `'admin_user_purged'` to AuthEventType union
lib/sse-broadcast.ts                MODIFIED — added `admin.user_purged` to SseEvent union
```

13 commits on `auth/google-oauth`. Diff stats: 11 files, +805 / -8.

---

## Data flow

### Happy path (full purge of a user with content)

```
[Admin clicks "Стереть навсегда"]
        ↓
[Modal: type email → submit]
        ↓
DELETE /api/admin/users/[id]  body: { confirmation_email }
        ↓
1. requireAdmin (cookie session)
2. validateInput: id parseable, not self, body parseable, confirmation non-empty
3. SELECT user → status === 'deleted' check → email match check
4. purgeUser(db, userId, { imagesDir, purgedAtIso }):
   a. SELECT email
   b. buildUserSummaryCsv (LEFT JOIN models, GROUP BY yr/mo/model_id, billing-parity filter)
   c. SELECT COUNT(*) — billing-counted total for CSV header
   d. if total > 0 AND {imagesDir}/{email}/ exists → fs.writeFile _SUMMARY.csv
   e. DB transaction (atomic):
        DELETE generation_outputs WHERE generation_id IN (SELECT id FROM generations WHERE user_id=?)
        DELETE generations WHERE user_id=?     ← capture .changes for actuallyDeleted count
        DELETE users WHERE id=?                ← CASCADE wipes sessions, user_quotas, user_preferences
   f. return { email, generations_deleted: actuallyDeleted, csv_written }
5. Probe folder + findFreeDeletedTarget → renameTarget (predicted, for audit)
6. writeAuthEvent { event_type: 'admin_user_purged', user_id: me.id, email: target.email,
                    details: { target_id, target_email, generations_purged, folder_rename_target } }
7. renameUserFolderToDeleted (which calls renameWithRetry; up to 5 retries on EPERM/EBUSY/ENOTEMPTY)
8. fanOutUserPurged → broadcast SSE admin.user_purged to every active admin
9. Response 200: { ok: true, purged: { email, generations_deleted, summary_csv_written, folder_renamed_to } }
        ↓
[Admin browser receives SSE → refetch → row gone]
[Other admin tabs same]
```

### Audit-before-rename ordering rationale

`writeAuthEvent` runs BEFORE `renameUserFolderToDeleted`. This is intentional: if the rename fails, we still want a permanent record that the purge happened. The audit's `folder_rename_target` field is a **predicted** target (computed by an extra `findFreeDeletedTarget` probe), not the actual one — the response body's `folder_renamed_to` is authoritative for what's on disk. Under concurrent admin activity these can diverge; the inline comment in `app/api/admin/users/[id]/route.ts` documents this for future readers.

### CSV-before-DB ordering rationale

CSV write happens BEFORE the DB transaction. If `fs.writeFile` fails (disk full, permissions, EISDIR), the function throws `PurgeUserError("summary_write_failed", ...)` and the DB stays untouched — admin can retry safely. If we wrote the DB first, a CSV failure would leave billing history irrecoverably gone.

---

## Soft-delete vs hard-delete contract

| Action | Reversible | Email slot | Generations | Files on disk | Audit |
|--------|-----------|-----------|-------------|---------------|-------|
| Soft-delete (existing) | yes via "Восстановить" | held | `status='deleted'` (kept; counts in billing per memory `project_soft_delete_invariant.md`) | untouched | `admin_user_status_changed` |
| Hard-delete (new) | **no** | freed | DELETEd from DB | folder renamed `deleted_{email}/`, `_SUMMARY.csv` added inside | `admin_user_purged` |

The hard-delete is gated on `status='deleted'` first — admins must soft-delete then hard-delete. Single-step purge is intentionally not offered.

---

## Failure modes and contracts

| Failure | HTTP | DB state | Disk state | UI |
|---------|------|----------|-----------|-----|
| Bad confirmation | 400 `confirmation_mismatch` | unchanged | unchanged | Toast "Email не совпадает" |
| User not in `status='deleted'` | 409 `must_be_soft_deleted_first` | unchanged | unchanged | Toast "Сначала переведите в статус «удалён»" |
| Self-purge | 400 `self_purge_forbidden` | unchanged | unchanged | Toast "Нельзя стереть самого себя" |
| Malformed JSON body | 400 `invalid_body` | unchanged | unchanged | Toast fallback (rare in practice) |
| `fs.writeFile` for CSV fails | 500 `summary_write_failed` | unchanged | unchanged (CSV not written) | Toast Russian text, dialog stays open |
| DB transaction fails | 500 `db_delete_failed` | rolled back | CSV may exist (gets overwritten on retry) | Toast Russian text, dialog stays open |
| `fs.rename` fails (after 5 retries) | 200 `warning: rename_failed` | committed | folder NOT renamed at original path | 10s warning toast with manual instruction |
| `fs.rename` fails transiently then succeeds | 200 OK | committed | folder renamed | Standard success toast |

The `rename_failed` warning is a **degraded success**, not a failure — the purge itself succeeded, only the cosmetic on-disk archive name didn't apply.

---

## Architectural conventions established or reinforced

### 1. `lib/admin/` is for admin-specific server code

The directory was created for this feature. Future admin operations that don't fit cleanly into a route handler should land here as small focused modules with their own tests. Three rules of thumb:

- **Pure DB helpers** that take a `Database` parameter (not `getDb()`) so they're testable against `:memory:` (e.g. `summary-csv.ts`).
- **Pure FS helpers** that take `imagesDir` as a parameter (not `getHistoryImagesDir()`) so they're testable against `os.tmpdir()` (e.g. `folder-rename.ts`).
- **Orchestration** modules combine the two via small interfaces; failures get tagged via a discriminated `Error` subclass with a `kind` field (e.g. `PurgeUserError`).

### 2. Tagged errors over message-string-matching

`PurgeUserError` has a `kind: 'not_found' | 'summary_write_failed' | 'db_delete_failed'` field. The route handler `instanceof`-checks and maps `kind` to HTTP status without parsing `message`. This is more robust than the `if (msg.includes("ENOENT"))` antipattern.

### 3. Windows `fs.rename` MUST retry on EPERM/EBUSY/ENOTEMPTY

The `renameWithRetry` helper in `lib/admin/folder-rename.ts` retries 5 times with exponential backoff (50, 100, 200, 400, 800 ms; total ~1.55s). Discovered via smoke test on Windows: the OS holds brief locks after writes inside a directory (file system caches, antivirus, Explorer focus, indexers). This pattern should be applied to ANY future code that renames directories on Windows. Do NOT extend the transient-codes list to include `ENOENT` (source vanished) or `EACCES` (permission denied) — those are non-transient.

### 4. Audit captures intent before risky non-DB operations

The pattern: write the audit event after the DB has been committed but before the disk-side effect (rename). If the disk operation fails, the audit log still records what was attempted and the response body distinguishes outcome from intent. Generalize to: any future destructive admin action should commit DB → write audit (intent) → execute side effect → return outcome (which may diverge from intent).

### 5. Server-side validation as primary; client-side guards for UX only

The dialog does NOT check "is this me" — the server returns `400 self_purge_forbidden`. The dialog does NOT pre-fetch a confirmation token — the email-typed gate is the only client-side check. Server-side is authoritative; client only avoids round-trips when there's a meaningful UX cost (e.g., disabling the submit button until typed matches).

### 6. SSE admin fan-out helpers live next to the writer that fans them out

`fanOutUserPurged` lives in the route handler that triggers it (`app/api/admin/users/[id]/route.ts`), not in a shared helper. Same pattern as `fanOutQuotaChanged` (`/quotas/[model]/route.ts`) and the inline fan-out in `/api/history/route.ts:207-219`. Wrap the broadcast in try/catch — broadcast failure must never 500 the admin write.

### 7. `_SUMMARY.csv` cold-archive format

When archiving user data on disk, prefer:
- File naming starts with `_` so it sorts to the top of any directory listing.
- Three `#` comment lines at the top with metadata (email, timestamp, totals).
- Flat CSV body (year, month, ...) — usable in Excel via "treat # as comment" import.
- UTF-8 no BOM, `\n` line endings.

This format is meant to be human-readable in a text editor AND machine-parseable for future bulk analysis.

---

## Pitfalls — easy ways to re-break things

### Don't extend `_SUMMARY.csv` to include columns with commas without escaping

The current implementation is naive — it joins fields with `,` and assumes no field contains a comma. Today this is safe because `email` and seeded `display_name` are controlled. If a future task allows admin-editable display names with punctuation, RFC 4180 escaping (`"..."` wrap, `""` for embedded quotes) MUST be added. The code reviewer flagged this as a Minor; we deferred.

### Don't move audit AFTER rename

Spec deviation #1 in the final review history. The audit record's purpose is to capture intent regardless of side-effect outcome. Moving the `writeAuthEvent` call after `renameUserFolderToDeleted` would cause us to silently miss audit entries when rename fails (which is the most useful case for forensics).

### Don't reorder the DB DELETE statements inside the transaction

The order is `generation_outputs → generations → users` because:
- `generations.user_id FK` is `RESTRICT` (NOT cascade) — we must clear children first.
- `generation_outputs.generation_id FK` is `CASCADE` — but explicit DELETE is safer and documents intent.
- `users.id` deletion cascades to `sessions`, `user_quotas`, `user_preferences` automatically.

If you swap the order, the transaction will throw on the FK constraint and roll back — but then nobody finds the bug until production data triggers it.

### Don't drop the `findFreeDeletedTarget` pre-probe in the route handler

It looks redundant (the inner call inside `renameUserFolderToDeleted` does the same work) but it's there to populate the audit record's `folder_rename_target` field BEFORE the rename runs. Without it, the audit would record `null` for the predicted target — losing the paper trail that a rename was intended even when it later fails.

### Don't add `if (u.id === me.id)` UX guard to the "Стереть навсегда" button

The plan explicitly omitted this. Reasoning: an admin can't reach their own deleted row in the UI under normal operation (soft-deleting yourself logs you out and revokes admin rights). The server's `400 self_purge_forbidden` is the authoritative check. Adding a client-side guard would require threading `me.id` into `UsersTab`, increasing surface area for a check that only fires in pathological states.

### Don't merge `_SUMMARY.csv` files when `deleted_2_*` collisions happen

The convention is intentional: each purge gets its own folder with its own CSV reflecting the user's history at the time of that purge. If admin re-creates `alice@x.com`, gens new content, purges again, the second `_SUMMARY.csv` (in `deleted_2_alice@x.com/`) covers ONLY the second life cycle. Merging would mix billing histories and break the timeline.

---

## Test coverage

**252/252 vitest tests pass.** New tests added by this feature:

| File | Tests | Notes |
|------|-------|-------|
| `lib/admin/__tests__/folder-rename.test.ts` | 11 | 7 functional + 4 retry-behavior (one takes ~1.5s waiting through full backoff) |
| `lib/admin/__tests__/summary-csv.test.ts` | 4 | Empty body, group+sort, billing parity (failed excluded), NULL model_id |
| `lib/admin/__tests__/purge-user.test.ts` | 8 | No-gens, with-gens+CSV, no-folder skip, CASCADE wipe, auth_events survives, not_found error, EISDIR summary_write_failed, generations_deleted vs billing-counted divergence |

**Untested by unit:**
- DELETE route handler — covered by manual smoke. Reasoning: the handler is mostly delegation; pure logic is in `lib/admin/`.
- Frontend dialog — UI components in this project are mostly not unit-tested (matches existing pattern).
- Real-time SSE between two admin tabs — manual smoke only (verified: cross-tab refetch works).

---

## Open follow-ups

- **Smoke checklist:** user verified happy path (CSV written, folder renamed after EPERM retry). Untested in this session: re-add same email after purge (slot freed), `deleted_2_*` on second purge, validation error paths in browser, multi-admin-tab real-time. Run when convenient — features are unlikely to break but the smoke is cheap.
- **Dialog form polish (deferred per user):** "над формой поработаем позже". Possible directions: better gens-deleted preview (currently `gens_this_month` only — could show all-time count), explicit warning that this is also a billing event, optional checkbox "I understand this is irreversible".
- **Auto-archival of `deleted_*` folders:** none planned. If disk usage becomes a concern, a cron-style task could zip + remove archives older than N months.
- **Importing `_SUMMARY.csv` back into DB:** explicitly out of scope. If admin needs to "undo" a purge, it's currently impossible — that's the entire point of the typed-email confirmation gate.
- **CSV escaping:** RFC 4180 escaping not implemented; safe today because all CSV fields come from controlled sources. Add if admin-editable model display names ever allow punctuation.
- **Self-purge UX guard:** not added; rely on server. Revisit if a future admin UI surfaces deleted users to themselves.
