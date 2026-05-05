# Users Tab — Inline Auto-Save + Cross-Tab Real-Time + Avatar/Last-Login Polish

**Date:** 2026-05-05
**Branch:** `auth/google-oauth` (continues UI-polish line from `e9b0c3a` and post-ship doc `docs/superpowers/specs/2026-05-01-ui-polish-and-admin-realtime-post-ship.md`)
**Status:** Spec — not yet implemented.
**Intended readers:** the agent or engineer who picks up implementation, plus future maintainers of `components/admin/users-tab.tsx`.

## Scope

Three improvements to the admin **Users** tab, all bundled into one ship:

1. **`QuotaRowEditor` → inline auto-save.** The expanded per-user quota table still uses the legacy `[изменить] → input → [Сохранить][Отмена]` modal-edit pattern. Migrate it to the inline auto-save pattern that `LimitEditor` in `models-tab.tsx` already uses (post-ship convention #3).
2. **Cross-tab admin real-time for quotas.** Today, if admin A views user B's quotas in one window and admin C edits user B's overrides in another, A sees nothing until they refocus the tab. Add an admin-scoped SSE event so any admin viewing the affected user's quotas refetches live.
3. **`last_login_at` readability + avatar in the Email column.** Replace raw ISO strings with relative-time (`3 ч назад`, `вчера`, `15 апр`) with full ISO available on hover. Add the user's Google profile picture as a 24px circle next to the email.

Out of scope (intentionally): the «+ Добавить» form's loading/validation polish (item #3 in the originating discussion was skipped). No data-model migration. No new dependencies. The real-time path for `gens_this_month` (admin.user_generated → outer UsersTab refetch) is left untouched — additions only, no rewrites.

## Non-goals

- No alphabetical or other sort change; per-model rows continue to honour `sortByPickerOrder` (post-ship convention #1).
- No change to soft-delete semantics (`generations.status IN ('completed','deleted')` stays the source of truth for billing).
- No change to the action segmented-control in the user row (Сделать админом / Бан / Удалить).
- No "trash" view for soft-deleted generations (still F1 follow-up).
- No multi-process SSE (still F2 follow-up).

## Section 1 — `QuotaRowEditor` inline auto-save

### Layout

The actions column is **eliminated**. The table goes from 5 columns to 4:

| Column        | Width / align | Contents                                                                 |
|---------------|---------------|--------------------------------------------------------------------------|
| Модель        | left          | `row.display_name`                                                        |
| Лимит         | right         | `<input number>` + `☐ ∞` + `↺` (conditional) + status-slot `w-4`          |
| Источник      | center        | colored badge — `override` (blue) / `default` (muted) — auto-derived     |
| Использовано  | right         | `row.usage_this_month`, `tabular-nums`                                    |

All edit affordances live inside the `Лимит` cell, mirroring `LimitEditor` in `models-tab.tsx`.

### State machine

Per-row local state, identical shape to `LimitEditor`:

- `val: string` — current input value
- `unlimited: boolean` — checkbox state
- `status: "synced" | "dirty" | "saving" | "saved"` — drives the indicator slot

Initial values come from `row.applicable_limit` and `row.applicable_limit === null`.

### Save triggers

- **Number input** — `onBlur` and Enter (Enter blurs the input). PUT `{ monthly_limit: Number(val) }`.
- **`∞` checkbox check** (unchecked → checked) — immediate PUT `{ monthly_limit: null }`. No natural blur point on a checkbox; commit on toggle.
- **`∞` checkbox uncheck** (checked → unchecked) — enables the input, sets `dirty`, `autoFocus`. PUT waits for the user to type a value and blur. Without this asymmetry, unchecking ∞ on a previously-unlimited row would snap back to ∞ via the empty-input guard.
- **Empty input + not unlimited** — no-op snap-back to the server value (does not save `null` and accidentally flip to unlimited).
- **PUT failure** — `toast.error("Ошибка сохранения квоты")`, status returns to `dirty` so the admin sees retry is needed.
- **Saved** — status becomes `saved` for 1.5s (green check), then fades back to `synced`.

### `↺` reset button

- Lucide icon `Undo2` or `RotateCcw`, `h-3.5 w-3.5`, `text-zinc-400 hover:text-orange-600 disabled:opacity-30`.
- Visible **only when `row.has_override === true`**. When the row is on default, the slot is empty (kept stable width to avoid layout shift on hover).
- `title="Сбросить override → default"`.
- Click → `DELETE /api/admin/users/[id]/quotas/[model]`. On success: `toast.success("Сброшено")` and the SSE flow (Section 2) brings the refreshed row in.
- Disabled while `status === "saving"`.

### Source badge

No changes. After a save (PUT or DELETE), the SSE refetch updates `source` and the badge re-renders. Until then, the badge reflects the last known server state — a small lag is acceptable since the dirty/saving indicator already communicates "in flight".

### Re-sync from props

`useEffect` watching `row` updates the local `val`/`unlimited` ONLY when `status` is `synced` or `saved`. Mid-edit refetches (triggered by SSE events, see Section 2) do not stomp the in-flight value.

### "Equal to default" semantics

Any commit creates an override unconditionally — even if the typed value equals the current default. To revert to default the admin must click `↺`. This was an explicit design choice over the alternative "auto-DELETE on equality" because:

- It would be surprising when the default is `∞` (typing nothing-then-checking-∞ would silently un-override).
- It hides a state change behind data equality — admins editing values rarely intend to remove their override.
- It complicates the save handler (extra GET to know the current default; race conditions with model-default changes).

## Section 2 — cross-tab admin real-time for `UserQuotas`

### Problem

`broadcastToUserId(targetUser, "quota_updated")` reaches the **affected** user, not other admins viewing them. The existing `es.addEventListener("quota_updated", ...)` on outer `UsersTab` fires only when:

- The admin viewing the page is themselves the affected user (rare).
- A model's `is_active` flip broadcasts to all active users (admins included).

So the "watch user B's quotas in tab 1, edit them in tab 2" workflow does not refresh tab 1 today.

### Server-side

Add a new admin-scoped event to `lib/sse-broadcast.ts`:

```ts
| { type: "admin.quota_changed"; data: { user_id: number; model_id: string } }
```

`user_id` carries the **target** user (whose quotas changed), not the admin who made the change. `user_id: 0` is a sentinel meaning "all users affected" — used for model-default changes that shift everyone's `applicable_limit` for that model.

Fan-out points:

| File                                                       | Where                                                                  | Payload                                  |
|------------------------------------------------------------|------------------------------------------------------------------------|------------------------------------------|
| `app/api/admin/users/[id]/quotas/[model]/route.ts` PUT     | After `broadcastToUserId(userId, { type: "quota_updated" })`           | `{ user_id: userId, model_id: model }`   |
| `app/api/admin/users/[id]/quotas/[model]/route.ts` DELETE  | After the same broadcast, only when `result.changes > 0`               | `{ user_id: userId, model_id: model }`   |
| `app/api/admin/models/[model_id]/route.ts` PATCH           | Inside the existing `defaultChanged` block, after the per-user fan-out | `{ user_id: 0, model_id }`               |

Admin lookup: `SELECT id FROM users WHERE role='admin' AND status='active'` — same query shape as the existing `admin.user_generated` fan-out in `app/api/history/route.ts` POST. Loop and call `broadcastToUserId(adminId, ...)`.

### Why a separate event (not `quota_updated`)

Reusing `quota_updated` (which has no payload) would mean every admin refetches on every quota change anywhere — and the **outer `UsersTab` already listens for it**, which would trigger a full users-list refetch (heavier than the inner per-row refetch). A typed `admin.quota_changed` with `user_id` lets `UserQuotas` filter precisely. Same architectural reasoning that justified `admin.user_generated` over `generation.created` in the post-ship doc.

### Client-side

`UserQuotas` (the inner component, mounted only when a row is expanded) subscribes:

```ts
React.useEffect(() => {
  if (typeof EventSource === "undefined") return;
  const es = new EventSource("/api/history/stream");
  es.addEventListener("admin.quota_changed", (e) => {
    const { user_id } = JSON.parse((e as MessageEvent).data);
    if (user_id === userId || user_id === 0) void refetch();
  });
  // Bonus: keeps the per-model `Использовано` column in step with
  // the outer `Генераций (мес.)` counter when a user generates.
  es.addEventListener("admin.user_generated", (e) => {
    const { user_id } = JSON.parse((e as MessageEvent).data);
    if (user_id === userId) void refetch();
  });
  es.onerror = () => es.close();
  return () => es.close();
}, [userId, refetch]);
```

`refetch` is the existing `() => fetch('/api/admin/users/${userId}/quotas')` already in `UserQuotas`. The re-sync guard in Section 1 prevents stomping mid-edit.

### What this does NOT change

- Outer `UsersTab` continues to listen for `admin.user_generated` and `quota_updated` and to refetch the users list. `gens_this_month` still ticks live exactly as today.
- The optimistic-refetch on save (`if (r.ok) { toast.success(...); void refetch(); }` in `setOverride` / `clearOverride`) stays. SSE arrival of the same change yields a redundant refetch — that's fine and matches the same defensive belt-and-suspenders pattern in the outer tab.

## Section 3 — `last_login_at` relative time + Email-cell avatar

### API

`app/api/admin/users/route.ts` GET — add `picture_url` to the SELECT projection:

```sql
SELECT u.id, u.email, u.name, u.picture_url, u.role, u.status,
       u.last_login_at, u.created_at,
  (SELECT COUNT(*) FROM generations g
    WHERE g.user_id = u.id
      AND g.status IN ('completed', 'deleted')
      AND g.created_at >= strftime('%Y-%m-01T00:00:00.000Z', 'now')
  ) AS gens_this_month
FROM users u
${showDeleted ? "" : "WHERE u.status != 'deleted'"}
ORDER BY u.created_at DESC
```

`AdminUser` type in `users-tab.tsx` gains `picture_url: string | null;`.

### `formatRelativeTime` helper

New file `lib/format/relative-time.ts`. No dependencies (no date-fns). Russian locale, single function:

```ts
export function formatRelativeTime(iso: string | null, now: Date = new Date()): string;
```

Mapping:

| Δ from `now`                   | Output            |
|--------------------------------|-------------------|
| `iso === null`                 | `—`               |
| `< 60s`                        | `только что`      |
| `< 60min`                      | `${n} мин назад`  |
| `< 24h`                        | `${n} ч назад`    |
| within yesterday's calendar day (local) | `вчера`  |
| `< 7 дней` (calendar)          | `${n} дн назад`   |
| same calendar year             | `${day} ${monthShort}` (e.g. `15 апр`) |
| otherwise                      | `${day} ${monthShort} ${year}` (e.g. `15 апр 2025`) |

`monthShort` array: `['янв','фев','мар','апр','май','июн','июл','авг','сен','окт','ноя','дек']`. Local timezone (use `Date` arithmetic against the local clock for "yesterday" / "same year"). The full ISO is preserved for hover via `<span title={iso}>`.

### `UserAvatar` component

Inline in `users-tab.tsx` (small enough not to warrant a separate file):

```tsx
function UserAvatar({ src, email, size = 24 }: {
  src: string | null;
  email: string;
  size?: number;
}) {
  if (src) {
    return (
      <img
        src={src}
        alt=""
        width={size}
        height={size}
        referrerPolicy="no-referrer"
        className="rounded-full shrink-0"
      />
    );
  }
  return (
    <span
      style={{ width: size, height: size }}
      className="rounded-full bg-zinc-200 dark:bg-zinc-700 text-zinc-600 dark:text-zinc-300 inline-flex items-center justify-center text-xs font-medium shrink-0"
    >
      {email[0]?.toUpperCase() ?? "?"}
    </span>
  );
}
```

`referrerPolicy="no-referrer"` is mandatory per post-ship convention #7 — Google's CDN inconsistently blocks Referer-bearing requests. Fallback to an initial-letter circle when `picture_url` is null (admin-pre-added users who haven't logged in yet).

### Row rendering

```tsx
<td className="py-2">
  <span className="inline-flex items-center gap-2">
    <UserAvatar src={u.picture_url} email={u.email} />
    <span>{u.email}</span>
  </span>
</td>
```

The `Имя` column stays unchanged (`u.name ?? "—"`).

The `Последний вход` column becomes:

```tsx
<td>
  {u.last_login_at
    ? <span title={u.last_login_at}>{formatRelativeTime(u.last_login_at)}</span>
    : "—"}
</td>
```

## File map

| File                                                    | Change                                                            |
|---------------------------------------------------------|-------------------------------------------------------------------|
| `lib/sse-broadcast.ts`                                  | +`admin.quota_changed` event type                                 |
| `lib/format/relative-time.ts`                           | **new** — `formatRelativeTime()` helper                           |
| `app/api/admin/users/route.ts`                          | +`picture_url` in SELECT (GET)                                    |
| `app/api/admin/users/[id]/quotas/[model]/route.ts`      | admin fan-out in PUT and DELETE                                   |
| `app/api/admin/models/[model_id]/route.ts`              | admin fan-out in `defaultChanged` block                           |
| `components/admin/users-tab.tsx`                        | `QuotaRowEditor` rewrite, `UserQuotas` SSE, Email-cell avatar, relative-time render, `picture_url` on `AdminUser` |

## Acceptance criteria

- `tsc --noEmit` clean.
- Existing vitest suite (`vitest run`) still passes (no test changes expected — UI presentational).
- Manual smoke in two browser windows on the same dev server:
  1. Window A: open `/admin`, expand any user with `has_override` rows.
  2. Window B (incognito or different admin): change that user's override on a model. Window A's row updates within ~1s without focus change. ✓
  3. Window A: type a number into the limit input → orange dirty dot appears immediately → tab/click away → spinner → green check → fade. Source badge flips to `override`. ✓
  4. Click `↺`. Row reverts to default value, badge flips to `default`, `↺` disappears. ✓
  5. Toggle `∞` on a default row. PUT fires immediately, status indicator goes through `dirty → saving → saved`. ✓
  6. In Window A, while a different (non-admin) user generates an image: the expanded row's `Использовано` column for the right model ticks up within ~1s. ✓
  7. Email column shows 24px circle aligned with the email text. Google profile pic loads (no broken-image icon — confirms `referrerPolicy`). ✓
  8. `Последний вход` shows `5 мин назад` / `вчера` / `15 апр` etc. Hover → tooltip reveals full ISO. ✓
- A regression check that `gens_this_month` in the outer row still ticks live (no regression to the existing real-time path).

## Pitfalls (carry into implementation)

- **Don't drop the re-sync guard.** Without `if (status === 'synced' || status === 'saved')` around the prop-driven `setVal/setUnlimited`, an SSE refetch arriving mid-edit will overwrite the admin's typed value.
- **Don't broadcast `admin.quota_changed` from non-admin endpoints.** Only the three admin routes listed in Section 2 fan it out. Confusing user-driven events with admin-driven ones is what `admin.*` namespace exists to prevent (post-ship doc reasoning).
- **Don't forget `referrerPolicy="no-referrer"` on `<img>`.** Without it, Google CDN avatars break sporadically depending on environment.
- **`colSpan` of the expansion `<tr>` stays at 8.** The OUTER users table still has 8 columns (chevron, email, имя, роль, статус, last_login, gens, actions — actions on the OUTER row stays as the segmented control). Only the INNER `UserQuotas` table loses its actions column (5 → 4).
- **Don't move `formatRelativeTime` calls to module scope.** Compute relative time at render with a fresh `new Date()` so a long-open admin tab eventually rolls `только что` → `5 мин назад` on the next render. (Re-renders are triggered by SSE refetches every time anything happens; idle staleness is acceptable.)
- **Don't add a date-fns / dayjs dependency** for `formatRelativeTime`. The mapping is small and Russian-locale; a plain function is cheaper than the bundle hit.

## Test coverage

- `lib/format/__tests__/relative-time.test.ts` — table-driven test of the seven branches (null, <60s, <60min, <24h, yesterday, <7d, same year, prior year). Single new test file.
- No new tests for `users-tab.tsx` itself (presentational, follows post-ship precedent).
- No new tests for the SSE fan-out points; they mirror the established `admin.user_generated` pattern which already has implicit coverage via the dev-mode smoke loop documented in the post-ship doc.

## Open follow-ups

- **U1.** When the admin is the originator of a change in a different tab, the SSE arrival now triggers a redundant refetch (the optimistic `void refetch()` fired first). Cheap but wasteful. If/when the SSE event grows a `correlation_id`, the client could de-dup. Not urgent.
- **U2.** `formatRelativeTime` does not auto-tick on idle (no `setInterval`). For a tab left open for hours, the value displayed is from the last render. Considered and accepted: the SSE-driven refetch cycle gives natural updates whenever activity happens, and an idle admin tab seeing stale relative times is an edge case.
- **U3.** Avatars are loaded directly from Google's CDN every page load. No proxy / no caching headers tuned. If admin-list pages start feeling slow, consider proxying through a `/api/avatar/[user_id]` endpoint with `Cache-Control: public, max-age=86400`. Not relevant at current scale.
