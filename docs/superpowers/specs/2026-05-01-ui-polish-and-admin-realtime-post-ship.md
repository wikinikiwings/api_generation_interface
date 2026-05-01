# UI Polish + Admin Real-Time + Soft-Delete — Post-Ship Handoff

**Date:** 2026-05-01
**Branch:** `auth/google-oauth` (continuation of the auth migration; no merge to main yet)
**Status:** Shipped to local dev, smoke-tested by user. 221/221 vitest pass, `tsc --noEmit` clean. Not yet deployed to prod (lgen.maxkdiffused.org) — bundles cleanly into the auth-rollout PR.
**Intended readers:** any future agent or engineer editing the playground form, history sidebar, admin panel, quota/limit logic, or admin SSE flow.

## Quick-nav

- [Scope of this session](#scope-of-this-session)
- [Bug fixes (the original three reports)](#bug-fixes-the-original-three-reports)
- [UI polish — what moved where](#ui-polish--what-moved-where)
- [Admin Models tab — date range filter](#admin-models-tab--date-range-filter)
- [Admin real-time refresh](#admin-real-time-refresh)
- [Architectural conventions to keep](#architectural-conventions-to-keep)
- [File map (where things live now)](#file-map-where-things-live-now)
- [Pitfalls — easy ways to re-break things](#pitfalls--easy-ways-to-re-break-things)
- [Test coverage](#test-coverage)
- [Open follow-ups](#open-follow-ups)

---

## Scope of this session

Three classes of work, all on top of the (already-shipped-locally) Google OAuth migration:

1. **Three bug fixes** the user reported after their first auth smoke test.
2. **A long UI polish pass** across the playground sidebar, generate button, and admin panel.
3. **Admin real-time refresh** — admins now see per-user / per-model counters tick up live without re-focusing the tab.

No data-layer changes other than the soft-delete invariant on `generations.status`. No new dependencies. No changes to the OAuth code, session middleware, or API surface for non-admin endpoints.

---

## Bug fixes (the original three reports)

### 1. Hydration mismatch in the model picker

**Symptom:** After generating, React reported a hydration error showing `<Label htmlFor="resolution">Разрешение</Label>` on the server vs `<Label htmlFor="aspect">Aspect ratio</Label>` on the client.

**Root cause:** `stores/settings-store.ts:120` previously initialised `selectedModel: loadModel()` at store-creation time. `loadModel()` runs in **both** environments — on the server it returns the default `nano-banana-2`, on the client first render it reads localStorage. If the user had previously picked `nano-banana` (the only model whose `capabilities.resolutions` is `[]`), the client computed `hasResolutions=false`, the resolution `<Label>` block disappeared, and the aspect-ratio label slid into the slot the server had rendered as the resolution label.

**Fix:** SSR-safe defaults + post-mount hydration. Same shape `selectedStyleIds: loadStyleIds()` got the same treatment.

```ts
// stores/settings-store.ts
selectedModel: "nano-banana-2",   // matches server-side default
selectedStyleIds: [],
hydrateClient: () => {
  if (typeof window === "undefined") return;
  set({
    selectedModel: loadModel(),
    selectedStyleIds: loadStyleIds(),
  });
}
```

`Playground` calls `hydrateClient()` from a mount-only `useEffect` BEFORE `hydrateUserModel()` so the per-user server pref still wins.

### 2. Quota progress bar not updating live

**Symptom:** After a successful generation, the bar in `Мои лимиты` only moved when the user switched sidebar tabs.

**Root cause (two layers):**

- `MyQuotasTab` had its own local `useState<Quota[]>(null)` and re-fetched only on mount + on `BroadcastChannel("quotas")` messages. The shared `QuotasProvider` was not consulted.
- The server only emits `quota_updated` on **admin** actions (model edit, override change). It does not emit on a user's own self-generation. So even if `MyQuotasTab` were listening, no event would arrive for self-generation.

**Fix:** `MyQuotasTab` now consumes `useQuotas()` from `QuotasProvider`. The form's optimistic `bumpUsage(selectedModel)` updates the shared state instantly, both the tab's bar and the form's footer reflect it.

### 3. Soft-delete for generations (no quota refund on delete)

**Symptom:** Deleting a generated image rolled the quota counter back. Per the user's product call, the compute cost was already paid — deleting an output should clean up the user's library but not refund the quota.

**Root cause:** `lib/history-db.ts:deleteGeneration` was a hard `DELETE FROM generations WHERE id=? AND user_id=?`. `lib/quotas.ts:usageThisMonth` counted `status='completed'`. Hard-delete made the row vanish from the count.

**Fix (server-only, no UI changes):** soft-delete with status flip + filter on read paths. The DELETE HTTP handler still broadcasts `generation.deleted` so other tabs continue to drop the entry from their UI exactly as before.

```ts
// lib/history-db.ts
deleteGeneration: UPDATE generations SET status='deleted'
                  WHERE id=? AND user_id=? AND status!='deleted'

// added to read queries:
getGenerations:    AND g.status != 'deleted'
getGenerationById: AND g.status != 'deleted'

// lib/quotas.ts
usageThisMonth:    AND status IN ('completed', 'deleted')

// admin counters bumped to the same set:
app/api/admin/users/route.ts        — gens_this_month
app/api/admin/models/route.ts       — total_generations
```

`generation_outputs` is `ON DELETE CASCADE` of `generations`. Soft-delete leaves the rows intact, so the output blobs and disk files survive. That's intentional — it leaves room for a future "trash" view without another schema change. If disk pressure becomes a real concern, add a periodic cleanup that hard-deletes rows where `status='deleted' AND deleted_at < now() - 30d` (will also need a `deleted_at` column).

**Bonus pre-existing bug fixed during the soft-delete work:** `app/api/generate/__tests__/submit-quota.test.ts` was using SQLite's `datetime('now')` which yields `"YYYY-MM-DD HH:MM:SS"` (space separator, no `Z`). `usageThisMonth` does raw string comparison against ISO bounds with `T`+`Z`. On the 1st of any month, `' '` (0x20) sorts below `'T'` (0x54) and the test row falls below the lower bound — flaky test that broke every month-rollover day. Fix: omit `created_at` from the INSERT and let the schema's `strftime('%Y-%m-%dT%H:%M:%fZ', 'now')` default fill it (matches production).

### Not a bug: monthly quota reset on the 1st

The user thought yesterday's filled bar resetting today was a bug. It wasn't — the session ran on 2026-05-01, which was the UTC start of a new month. `lib/quotas.ts:currentMonthBoundsUTC` is the source of truth: counts are scoped to the current calendar month UTC. Reset is by design.

---

## UI polish — what moved where

### Sidebar (formerly "История генераций")

`components/history-sidebar.tsx` and `components/output-area.tsx`.

The sidebar now hosts both `История` and `Мои лимиты` tabs, so the panel itself was renamed:

- Trigger button (`output-area.tsx:86-97`): `<History />` icon → `<Wrench />`, label `История` → `Настройки`.
- Header inside the panel: same icon + title swap. `aria-label="Закрыть"`.
- Filter button moved from the panel header into a history-only mini-toolbar that lives **inside** the history tab branch — it's invisible on the `Мои лимиты` tab where date filtering doesn't apply. The toolbar layout is `[ ⚙ Фильтр ]` left-aligned, `Записей: N` right-aligned, with `entries.length` from `useHistoryEntries`.
- The old `username · Записей: N` block above the entries list was removed (the username is in the header user-menu — no need for a duplicate).

### `Мои лимиты` tab

`components/my-quotas-tab.tsx`.

- Now consumes `useQuotas()` from `QuotasProvider` (see bug fix #2 above) instead of holding its own state.
- Cards are sorted by **picker order** — the index of `model_id` in `listAllModels()` (declaration order in `MODELS_META`). Same convention is used for the admin per-user quota table and any other per-model list that should match what's in the playground picker.

### Generate button

`components/generate-form.tsx:682-708`.

The standalone status line under the button (`{quota.used} / {quota.limit} в этом месяце` etc.) was removed and folded **into** the button:

- `className="w-full justify-between"`
- Left: `<Sparkles />` + label (`Сгенерировать` or `Сгенерировать (в работе: N)`)
- Right: counter `x / n` (or `∞` for unlimited), `tabular-nums` so the digits don't reflow on each tick
- Tooltip (`title=`) carries the longer copy: `Лимит исчерпан · сбросится 1 числа следующего месяца` when exhausted, otherwise `${used} / ${limit} в этом месяце` or `Без ограничений`.

### Admin panel — width

`components/admin-panel.tsx:203` — `max-w-2xl` → `max-w-6xl`. The width was the bottleneck of every admin table; bumping the shared container fixed all four tabs at once. Mobile and tablet are unaffected (it's a max, `mx-auto` + responsive padding still handle small screens).

### Admin Users tab

`components/admin/users-tab.tsx`.

- A `w-6` chevron column was added before `Email`. `<ChevronRight>` when collapsed, `<ChevronDown>` when expanded. Click anywhere on the row toggles, but the chevron is the visual affordance. `colSpan` of the expansion row adjusted from 7 to 8.
- The actions column was redesigned as a **rounded segmented control** (`<div className="inline-flex ... rounded-lg border ... px-1.5 py-1">`) with three internal buttons:
  - Role toggle: `Сделать админом` (blue) / `Снять админку` (orange) — explicit verbs, replacing the old confusing `→ user` / `→ admin` arrows.
  - `Бан` (orange) / `Разбан` (green), conditional on status.
  - `Удалить` (red) / `Восстановить` (green), conditional on status.
- Each internal button is a regular `<button>` with rounded hover background.

The expanded per-user **quota table** (the inner `UserQuotas` component) was rebuilt for header/value alignment:

| Column         | th align | td align | Notes |
|----------------|----------|----------|-------|
| Модель         | left     | left     |       |
| Лимит          | right    | right    | `tabular-nums`; input + ∞ checkbox in edit mode |
| Источник       | center   | center   | colored badge: blue chip for `override`, muted text for `default` |
| Использовано   | right    | right    | `tabular-nums` |
| (actions)      | right    | right    | `whitespace-nowrap`, `[edit]` → `изменить`, `сброс default` → `сброс` |

Rows have `hover:bg-zinc-100/40` for scannability. The model order in this table matches `listAllModels()` (same convention as `MyQuotasTab`).

### Admin Models tab

`components/admin/models-tab.tsx`.

The actions column was **eliminated** entirely. The limit column is now an always-editable inline editor (`LimitEditor` sub-component) with auto-save:

- Number input + `∞` checkbox always rendered. Input is `disabled` when ∞ is checked (visual: `opacity-40`).
- Save triggers:
  - Number input: `onBlur` or Enter (`onKeyDown` blurs the input).
  - ∞ checkbox: immediate commit on toggle (no natural blur point). Going from checked→unchecked just enables the input + sets dirty + auto-focuses; commit waits for the user to type a value and blur. (Without this asymmetry, unchecking ∞ on a previously-unlimited model would snap back to ∞ because the empty-input guard fires.)
- Status indicator (a fixed-width `w-4` slot — never causes layout shift):
  - empty = synced with server
  - 🟠 orange dot = dirty (unsaved local edit)
  - ⏳ spinner (`Loader2`) = save in flight
  - ✅ green check = just saved (1.5s, then fades back to empty)
- On save error: toast `Ошибка сохранения лимита` + status returns to dirty so the user sees they need to retry.
- Empty input + not-unlimited = no-op snap-back (resets to server value; doesn't save `null` and accidentally flip to unlimited).
- `useEffect` re-syncs from server props ONLY when status is `synced`/`saved` — never stomps an in-progress edit.

Column widths are `w-56` for the limit (so input + ∞ + status fits without ever growing) and `w-20` for `Активна`. Header for the limit column reads `Лимит / мес` and is `text-center` to sit visually centered above the editor's compound layout.

### Picker now respects `is_active`

`components/playground.tsx:108-128`.

`modelOptions` is filtered by both `PROVIDER_MODELS[selectedProvider]` AND the set of `model_id`s in `quotas` (the `useQuotas()` hook). `/api/me/quotas` already filters models by `is_active=1`, and `quota_updated` SSE fires when admin flips the checkbox, so the picker now updates within ~1s of an admin disabling a model.

The snap-on-mismatch `useEffect` was extended to also trigger when the currently-selected model becomes inactive — picks the first model that satisfies BOTH "supported by current provider" AND "is_active". Toast `Модель «X» отключена администратором` always fires for the inactive case (the change is by-definition admin-driven, no need to gate on `adminSwitchRef`).

There's a guard against snapping during cold start: until `quotas` has data (`quotasLoading=true && quotas.length===0`), the `is_active` filter is bypassed so the picker isn't briefly empty.

### Avatar referrer policy

`components/header-user-menu.tsx:34-41`.

Google's `lh3.googleusercontent.com` CDN serves anonymous-Referer requests reliably, but blocks some browser default Referer headers (especially from localhost). Adding `referrerPolicy="no-referrer"` on the `<img>` tag fixes the broken-image issue across all environments. **Apply this rule to any future `<img>` that loads from Google's CDN** — it's a one-token defensive habit, not localhost-specific.

---

## Admin Models tab — date range filter

`components/admin/models-tab.tsx` + `app/api/admin/models/route.ts`.

The `Всего генераций` column now supports filtering by date range. Single source of truth: `{ from: string | null, to: string | null }` in YYYY-MM-DD form (`null` = unbounded on that side). Three input modes that all write to the same pair, with mutually-exclusive blue active-state highlighting:

1. **Pre-set chips** — `Всё время`, `Этот месяц`. Click → set/clear range. Active when range exactly matches the preset.
2. **Month stepper** — `◀ [Год▾] [Месяц▾] ▶` inside a rounded border. Arrows step ±1 month (handles year overflow via `Date.UTC(year, month-1, 1)` → 0 = December of prev year). Year dropdown shows current ±3 plus the currently-anchored year (so jumping to old data via От/До doesn't make it disappear from the dropdown). Active when range exactly matches a calendar month BUT isn't the current one (so the chip wins for the current month case).
3. **От / До date inputs** — free-form. Native `min`/`max` attributes prevent picker from selecting an invalid range; `onChange` also rejects pasted/typed `from > to`. Active whenever range is set but doesn't exactly match a calendar month.

Column header has a sub-caption (`за всё время`, `за апрель 2026`, or `с 2026-03-15 по 2026-04-10`) so the active filter is readable from anywhere on the page.

**Server side:** `/api/admin/models` accepts optional `?from=YYYY-MM-DD&to=YYYY-MM-DD` (regex-validated). Builds dynamic `AND created_at >= ? AND created_at < ?` clauses with bound params. `to` is interpreted as **inclusive end-of-day** — the upper bound becomes the start of the next day for the `<` comparison (same pattern as `lib/quotas.ts:currentMonthBoundsUTC`).

**Color contrast on form controls:** all `<select>`, `<option>`, `<input type="date">` use the project's `bg-background` + `text-foreground` theme tokens explicitly. `bg-transparent` was previously causing white-on-white in dark mode because the native dropdown popup falls back to system defaults when the page's `color-scheme` isn't propagated. Apply `bg-background text-foreground` to ANY native form control in this codebase if it's going on a coloured container.

---

## Admin real-time refresh

Admin now sees the `Генераций (мес.)` column in `UsersTab` and `Всего генераций` in `ModelsTab` tick up **without action** — the admin window can keep focus the entire time and the numbers stay live.

### How it works

A new SSE event class was added:

```ts
// lib/sse-broadcast.ts
| { type: "admin.user_generated"; data: { user_id: number } }
```

Server-side, in `app/api/history/route.ts` POST (the path that creates a row in `generations`), after broadcasting the user-scoped `generation.created` we additionally fan out `admin.user_generated` to every active admin:

```ts
const admins = getDb().prepare(
  `SELECT id FROM users WHERE role='admin' AND status='active'`
).all() as { id: number }[];
for (const a of admins) {
  broadcastToUserId(a.id, {
    type: "admin.user_generated",
    data: { user_id: user.id },
  });
}
```

Client-side, both `UsersTab` and `ModelsTab` open their own `EventSource("/api/history/stream")` and listen:

```ts
es.addEventListener("admin.user_generated", () => void refetch());
es.addEventListener("quota_updated", () => void refetch()); // UsersTab only
```

Plus the visibilitychange + (UsersTab only) row-expand refetch paths from before remain as belt-and-suspenders.

### Why a separate event type and not just `generation.created`?

Reusing `generation.created` would have polluted the admin's own history view — `lib/history/sse.ts` listens for `generation.created` and adds the row to the local store. An admin who's also viewing the playground in another tab would have started seeing other users' generations in their personal history. The `admin.*` namespace keeps admin-aggregate concerns separate from per-user history concerns.

### What's NOT covered by the real-time path

- Soft-delete of a generation: the count includes both `completed` and `deleted` rows (see soft-delete fix), so user-side delete doesn't change the count and no broadcast is needed.
- Hard-delete of a user (admin → status='deleted'): already covered by the existing admin `patch()` flow (`refetch()` after the PATCH).
- Quota override changes: admin's own action triggers `refetch()` via the existing optimistic flow.

The only remaining "stale until next interaction" case is multi-process deployments. The SSE registry is in-memory per Node process. For multi-instance prod, swap to Redis pub/sub (already noted in `lib/sse-broadcast.ts:9-10`).

---

## Architectural conventions to keep

These are conventions the session established or reinforced. Future edits should respect them.

1. **Picker model order is canonical.** Any UI that lists models per-row should sort by the index in `listAllModels()` (which is the declaration order in `MODELS_META`). This is what the playground picker uses, and consistency between the picker and the various admin/user views is what the user has explicitly asked for. Implementations: `components/my-quotas-tab.tsx`, `components/admin/users-tab.tsx` (UserQuotas), `components/admin/models-tab.tsx`. Pattern:
   ```ts
   const idx = new Map<string, number>();
   listAllModels().forEach((m, i) => idx.set(m.id, i));
   rows.sort((a, b) => {
     const ai = idx.get(a.model_id);
     const bi = idx.get(b.model_id);
     if (ai !== undefined && bi !== undefined) return ai - bi;
     if (ai !== undefined) return -1;
     if (bi !== undefined) return 1;
     return a.display_name.localeCompare(b.display_name);
   });
   ```

2. **Generations are append-only for billing purposes.** Hard-delete on `generations` is gone; everywhere that previously did `DELETE` now does `UPDATE ... SET status='deleted'`. Quota counts `IN ('completed','deleted')`. If you add a new admin counter or analytics query, use the same `IN` clause unless you specifically want "currently-visible" rows.

3. **Inline auto-save with status indicator** is the preferred edit pattern for single-field forms in admin views. Pattern: always-editable input → `onBlur`/Enter triggers commit → 4-state indicator (synced / dirty / saving / saved) in a fixed-width slot so the layout never reflows. Reference: `LimitEditor` in `components/admin/models-tab.tsx`. Avoid the old `[edit] → input → [Сохранить][Отмена]` modal-edit pattern unless you have a specific reason (multi-field atomicity, etc.).

4. **Zustand stores with localStorage seeds use SSR-safe defaults.** Module-time `loadFromLocalStorage()` returns the default on the server and the persisted value on the client, which causes hydration mismatches. Use literal defaults in the `create()` config and add a `hydrateClient()` action that runs from a client `useEffect`. Reference: `stores/settings-store.ts`.

5. **Native form controls always get explicit `bg-background text-foreground`.** Don't rely on inheritance through `bg-transparent` — native dropdown popups bypass that and fall back to system defaults that don't follow the page's dark mode. Reference: `components/admin/models-tab.tsx` `DateRangeFilter`.

6. **Admin pages that show aggregate per-user data subscribe to `admin.user_generated` SSE.** Don't poll. Don't rely on visibilitychange alone. Pattern in `UsersTab` and `ModelsTab`. New admin views that show counts derived from `generations` should add the same listener.

7. **Google profile pictures use `referrerPolicy="no-referrer"`.** Google's CDN blocks some Referer-bearing requests inconsistently; the no-referrer policy works in all environments tested.

8. **`is_active=0` on a model means it's invisible to users.** Both `/api/me/quotas` (already) and the playground picker (added this session) honour this. If you add another user-facing surface that lists models, filter by what's in `quotas` (the `useQuotas()` hook), not by `listAllModels()` directly.

---

## File map (where things live now)

| Surface                                  | File                                              |
|------------------------------------------|---------------------------------------------------|
| Settings store (selectedModel, styles)   | `stores/settings-store.ts`                        |
| Model picker + provider snap logic       | `components/playground.tsx`                       |
| Generate form + Generate button          | `components/generate-form.tsx`                    |
| Settings sidebar (was "История")         | `components/history-sidebar.tsx`                  |
| Output area (today strip + trigger)      | `components/output-area.tsx`                      |
| Header user menu (avatar, dropdown)      | `components/header-user-menu.tsx`                 |
| Personal quota tab (sidebar)             | `components/my-quotas-tab.tsx`                    |
| Quotas provider                          | `app/providers/quotas-provider.tsx`               |
| Admin panel shell                        | `components/admin-panel.tsx`                      |
| Admin Users tab + UserQuotas             | `components/admin/users-tab.tsx`                  |
| Admin Models tab + LimitEditor + filter  | `components/admin/models-tab.tsx`                 |
| Admin models API (incl. date filter)     | `app/api/admin/models/route.ts`                   |
| Admin users API + admin counter          | `app/api/admin/users/route.ts`                    |
| User quota override API                  | `app/api/admin/users/[id]/quotas/[model]/route.ts`|
| Soft-delete (DB layer)                   | `lib/history-db.ts`                               |
| Quota counting                           | `lib/quotas.ts`                                   |
| SSE event types                          | `lib/sse-broadcast.ts`                            |
| Admin fan-out point                      | `app/api/history/route.ts` (POST handler)         |

---

## Pitfalls — easy ways to re-break things

- **Don't move `loadModel()` / `loadStyleIds()` calls back into the `create()` config** of the settings store. That re-introduces the SSR hydration mismatch. Always go through `hydrateClient()`.

- **Don't change `deleteGeneration` back to `DELETE FROM generations`.** That re-introduces the quota-refund bug. Soft-delete is the contract; `usageThisMonth` and the admin counters depend on it.

- **Don't sort the per-model list alphabetically in any new admin view.** The user has now explicitly asked for picker-order in three different places this session — `MyQuotasTab`, expanded `UserQuotas`, future Models analytics — and is unhappy when one breaks. Use the `listAllModels()` order helper.

- **Don't reuse `generation.created` for admin notifications.** The history SSE handler in `lib/history/sse.ts` listens for that and would inject other users' rows into the admin's personal history. Use `admin.user_generated` (or add a new `admin.*`-prefixed event class for new aggregate concerns).

- **Don't drop the `whitespace-nowrap` on the action group `<td>`** in the Users tab. With three or four conditional buttons, narrow widths cause vertical wrap that breaks the segmented-control look.

- **Don't reorder `applyMonth` arguments** in the date filter. `applyMonth(year, month)` where `month` is 0-indexed. Calling `applyMonth(month, year)` will produce silently wrong dates because `Date.UTC(small_int, large_int, 1)` is technically valid (it overflows back to a real date). The bug won't throw, just make the UI lie.

- **Don't change the admin POST `/api/admin/users` to populate `name` or `picture_url`.** Admin only knows the email. Those fields fill in via the OAuth callback's UPDATE on first login (see `lib/auth/handle-callback.ts:120-123`). The test `app/api/auth/__tests__/callback.test.ts:145-152` pins this contract.

---

## Test coverage

- `lib/__tests__/quotas.test.ts` — covers `usageThisMonth` including the new soft-delete branch (`status IN ('completed', 'deleted')`).
- `app/api/auth/__tests__/callback.test.ts` — pins the admin-pre-add → first-login UPDATE of `name`/`picture_url`/`google_sub` (relevant to the broken-avatar discussion).
- `app/api/generate/__tests__/submit-quota.test.ts` — fixed flaky test (used `datetime('now')` instead of schema default; would fail on the 1st of every month).

UI changes (sidebar, generate button, admin tables, date filter, real-time SSE) are not unit-tested. They're presentational and tested manually by the user. If a regression surfaces in the admin tables, the canonical reproduction is:

1. Open `/admin` in two windows side-by-side
2. In one, generate as a non-admin user (use a second account)
3. In the other (admin), watch `Генераций (мес.)` and `Всего генераций` — they should tick up within ~1s

If they don't tick:
- DevTools → Network → look for an EventSource connection to `/api/history/stream`
- Server console → look for `[history POST] admin broadcast failed:` errors
- Check that the admin row has `role='admin' AND status='active'` in the DB

---

## Open follow-ups

Tracked here so they don't get lost.

- **F1 — Disk cleanup for soft-deleted rows.** `generations` and `generation_outputs` accumulate forever. A nightly job that hard-deletes rows + files for `status='deleted' AND created_at < now() - 30d` would bound disk growth. Will need a `deleted_at TEXT` column for accurate cutoffs (or rely on `created_at` as a proxy, which is fine for an MVP).

- **F2 — Multi-process SSE.** The admin real-time path works on a single Node process. For multi-instance prod, swap the in-memory subscriber map in `lib/sse-broadcast.ts` for a Redis pub/sub. Comment in that file already flags this.

- **F3 — Models tab analytics view.** The date range filter unlocks more aggregate views per model: top users, day-by-day chart, average-per-user. If admin starts asking for those, promote the date filter into a dedicated `Аналитика` tab and reuse the same `DateRangeFilter` component (it's self-contained, just needs hoisting out of `models-tab.tsx`).

- **F4 — Admin Models tab live counts respect filter.** When `admin.user_generated` fires, `ModelsTab.refetch()` queries with the current filter (e.g. `за март 2025`). A new May generation won't change the March count — that's correct. But the user might be confused; consider a small "live (current filter)" badge or auto-bouncing the filter to "current month" when a fresh generation arrives. Not urgent.
