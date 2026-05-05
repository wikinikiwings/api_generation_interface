# Users Tab Polish Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Migrate `QuotaRowEditor` to inline auto-save, add cross-tab admin real-time for quotas via a new `admin.quota_changed` SSE event, and replace raw `last_login_at` ISO with relative time + Google profile picture in the Email column of the admin Users tab.

**Architecture:** Five small server changes (one new SSE event type + three fan-out points + one extra column in the users SELECT) feed two client changes (rewrite the inner per-user quota editor + add an SSE listener + new helper for relative-time + avatar component). Reference patterns: `LimitEditor` in `components/admin/models-tab.tsx:328` for inline auto-save, `admin.user_generated` fan-out in `app/api/history/route.ts` POST for SSE plumbing.

**Tech Stack:** Next.js App Router (Node runtime), better-sqlite3 via `lib/history-db.ts`, in-memory SSE registry in `lib/sse-broadcast.ts`, vitest, lucide-react icons, sonner toasts.

**Spec:** `docs/superpowers/specs/2026-05-05-users-tab-polish-design.md`

**Branch:** `auth/google-oauth` (no new branch — continues UI-polish line on the auth-rollout branch)

---

## File Structure

| File                                                    | Status   | Responsibility                                                     |
|---------------------------------------------------------|----------|--------------------------------------------------------------------|
| `lib/format/relative-time.ts`                           | NEW      | `formatRelativeTime(iso, now?)` — Russian-locale humanized time    |
| `lib/format/__tests__/relative-time.test.ts`            | NEW      | Table-driven coverage of all eight branches                        |
| `lib/sse-broadcast.ts`                                  | MODIFY   | Add `admin.quota_changed` event type to the union                  |
| `app/api/admin/users/route.ts`                          | MODIFY   | Add `u.picture_url` to GET SELECT                                  |
| `app/api/admin/users/[id]/quotas/[model]/route.ts`      | MODIFY   | Fan out `admin.quota_changed` from PUT and DELETE                  |
| `app/api/admin/models/[model_id]/route.ts`              | MODIFY   | Fan out `admin.quota_changed` (user_id=0) from `defaultChanged`    |
| `components/admin/users-tab.tsx`                        | MODIFY   | `picture_url` on type, Email-cell avatar, relative-time render, `UserQuotas` SSE listener, `QuotaRowEditor` rewrite to inline auto-save |

---

## Task 1: `formatRelativeTime` helper + tests

**Files:**
- Create: `lib/format/relative-time.ts`
- Create: `lib/format/__tests__/relative-time.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `lib/format/__tests__/relative-time.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { formatRelativeTime } from "../relative-time";

// Fixed reference "now" so the test is deterministic regardless of run time.
// 2026-05-05T15:00:00Z (a Tuesday).
const NOW = new Date("2026-05-05T15:00:00.000Z");

describe("formatRelativeTime", () => {
  it("returns '—' for null", () => {
    expect(formatRelativeTime(null, NOW)).toBe("—");
  });

  it("returns 'только что' for < 60 seconds ago", () => {
    expect(formatRelativeTime("2026-05-05T14:59:30.000Z", NOW)).toBe("только что");
  });

  it("returns 'N мин назад' for < 60 minutes", () => {
    expect(formatRelativeTime("2026-05-05T14:55:00.000Z", NOW)).toBe("5 мин назад");
    expect(formatRelativeTime("2026-05-05T14:01:00.000Z", NOW)).toBe("59 мин назад");
  });

  it("returns 'N ч назад' for < 24 hours", () => {
    expect(formatRelativeTime("2026-05-05T12:00:00.000Z", NOW)).toBe("3 ч назад");
    expect(formatRelativeTime("2026-05-04T16:00:00.000Z", NOW)).toBe("23 ч назад");
  });

  it("returns 'вчера' when the date is yesterday's calendar day", () => {
    // > 24h ago but on yesterday's local calendar date.
    expect(formatRelativeTime("2026-05-04T10:00:00.000Z", NOW)).toBe("вчера");
  });

  it("returns 'N дн назад' for < 7 days when not yesterday", () => {
    expect(formatRelativeTime("2026-05-02T15:00:00.000Z", NOW)).toBe("3 дн назад");
    expect(formatRelativeTime("2026-04-29T15:00:00.000Z", NOW)).toBe("6 дн назад");
  });

  it("returns 'D MMM' for older dates within the same year", () => {
    expect(formatRelativeTime("2026-04-15T10:00:00.000Z", NOW)).toBe("15 апр");
    expect(formatRelativeTime("2026-01-03T10:00:00.000Z", NOW)).toBe("3 янв");
  });

  it("returns 'D MMM YYYY' for prior years", () => {
    expect(formatRelativeTime("2025-12-31T10:00:00.000Z", NOW)).toBe("31 дек 2025");
    expect(formatRelativeTime("2024-06-01T10:00:00.000Z", NOW)).toBe("1 июн 2024");
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run lib/format/__tests__/relative-time.test.ts`

Expected: FAIL — `Cannot find module '../relative-time'` (the module doesn't exist yet).

- [ ] **Step 3: Implement the helper**

Create `lib/format/relative-time.ts`:

```ts
const MONTHS_SHORT_RU = [
  "янв", "фев", "мар", "апр", "май", "июн",
  "июл", "авг", "сен", "окт", "ноя", "дек",
] as const;

/**
 * Russian-locale humanized time. Pure function — pass a fixed `now`
 * for deterministic tests. Local timezone is used for the calendar-day
 * boundaries ("вчера", "same year"), matching how the user reads dates.
 */
export function formatRelativeTime(iso: string | null, now: Date = new Date()): string {
  if (iso === null) return "—";
  const then = new Date(iso);
  const diffMs = now.getTime() - then.getTime();
  const diffSec = Math.floor(diffMs / 1000);
  if (diffSec < 60) return "только что";
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin} мин назад`;
  const diffHour = Math.floor(diffMin / 60);
  if (diffHour < 24) return `${diffHour} ч назад`;

  // Calendar-day comparisons (local timezone).
  const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const today = startOfDay(now);
  const thenDay = startOfDay(then);
  const diffDays = Math.round((today.getTime() - thenDay.getTime()) / (24 * 60 * 60 * 1000));

  if (diffDays === 1) return "вчера";
  if (diffDays < 7) return `${diffDays} дн назад`;

  const day = then.getDate();
  const month = MONTHS_SHORT_RU[then.getMonth()];
  if (then.getFullYear() === now.getFullYear()) return `${day} ${month}`;
  return `${day} ${month} ${then.getFullYear()}`;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run lib/format/__tests__/relative-time.test.ts`

Expected: PASS — all 8 tests green.

- [ ] **Step 5: Run the full suite to confirm no regression**

Run: `npx vitest run`

Expected: PASS — full suite green (was 221/221 before; should be 229/229 after this task).

- [ ] **Step 6: Commit**

```bash
git add lib/format/relative-time.ts lib/format/__tests__/relative-time.test.ts
git commit -m "feat(format): add formatRelativeTime helper for admin Users tab

Pure Russian-locale time formatter — null → '—', < 60s → 'только что',
< 60min → 'N мин назад', < 24h → 'N ч назад', yesterday's calendar
day → 'вчера', < 7d → 'N дн назад', same year → 'D MMM',
otherwise → 'D MMM YYYY'. Local timezone for day boundaries.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: API GET returns `picture_url`; client type follows

**Files:**
- Modify: `app/api/admin/users/route.ts:19-29`
- Modify: `components/admin/users-tab.tsx:7-16`

- [ ] **Step 1: Edit the SELECT in the GET handler**

In `app/api/admin/users/route.ts`, find the SQL block (currently lines 19-29):

```ts
  const sql = `
    SELECT u.id, u.email, u.name, u.role, u.status, u.last_login_at, u.created_at,
      (SELECT COUNT(*) FROM generations g
        WHERE g.user_id = u.id
          AND g.status IN ('completed', 'deleted')
          AND g.created_at >= strftime('%Y-%m-01T00:00:00.000Z', 'now')
      ) AS gens_this_month
    FROM users u
    ${showDeleted ? "" : "WHERE u.status != 'deleted'"}
    ORDER BY u.created_at DESC
  `;
```

Replace it with the same query plus `u.picture_url` after `u.name`:

```ts
  const sql = `
    SELECT u.id, u.email, u.name, u.picture_url, u.role, u.status, u.last_login_at, u.created_at,
      (SELECT COUNT(*) FROM generations g
        WHERE g.user_id = u.id
          AND g.status IN ('completed', 'deleted')
          AND g.created_at >= strftime('%Y-%m-01T00:00:00.000Z', 'now')
      ) AS gens_this_month
    FROM users u
    ${showDeleted ? "" : "WHERE u.status != 'deleted'"}
    ORDER BY u.created_at DESC
  `;
```

- [ ] **Step 2: Update the `AdminUser` type**

In `components/admin/users-tab.tsx`, find the interface (currently lines 7-16):

```ts
interface AdminUser {
  id: number;
  email: string;
  name: string | null;
  role: "user" | "admin";
  status: "active" | "banned" | "deleted";
  last_login_at: string | null;
  created_at: string;
  gens_this_month: number;
}
```

Add `picture_url: string | null;` after `name`:

```ts
interface AdminUser {
  id: number;
  email: string;
  name: string | null;
  picture_url: string | null;
  role: "user" | "admin";
  status: "active" | "banned" | "deleted";
  last_login_at: string | null;
  created_at: string;
  gens_this_month: number;
}
```

- [ ] **Step 3: Verify type-check**

Run: `npx tsc --noEmit`

Expected: PASS — no type errors. (The new field is optional in usage; nothing references it yet.)

- [ ] **Step 4: Commit**

```bash
git add app/api/admin/users/route.ts components/admin/users-tab.tsx
git commit -m "feat(admin/users): include picture_url in GET /api/admin/users

Wire the schema column already populated by the OAuth callback through
to the admin users list. Consumed by the avatar render in the next task.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: Email-cell avatar + relative-time render

**Files:**
- Modify: `components/admin/users-tab.tsx`

- [ ] **Step 1: Add the `formatRelativeTime` import**

At the top of `components/admin/users-tab.tsx`, find:

```ts
import { sortByPickerOrder } from "@/lib/providers/models";
```

Add immediately below it:

```ts
import { formatRelativeTime } from "@/lib/format/relative-time";
```

- [ ] **Step 2: Add the `UserAvatar` component**

At the bottom of `components/admin/users-tab.tsx` (after the existing `QuotaRowEditor` function), add:

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

- [ ] **Step 3: Render the avatar in the email cell**

In `components/admin/users-tab.tsx`, find the email `<td>` (currently line 146):

```tsx
                <td className="py-2">{u.email}</td>
```

Replace with:

```tsx
                <td className="py-2">
                  <span className="inline-flex items-center gap-2">
                    <UserAvatar src={u.picture_url} email={u.email} />
                    <span>{u.email}</span>
                  </span>
                </td>
```

- [ ] **Step 4: Render the formatted last-login**

In `components/admin/users-tab.tsx`, find the last-login cell (currently line 150):

```tsx
                <td>{u.last_login_at ?? "—"}</td>
```

Replace with:

```tsx
                <td>
                  {u.last_login_at
                    ? <span title={u.last_login_at}>{formatRelativeTime(u.last_login_at)}</span>
                    : "—"}
                </td>
```

- [ ] **Step 5: Verify type-check + tests**

Run in parallel:
- `npx tsc --noEmit` — Expected: PASS
- `npx vitest run` — Expected: PASS, no regressions

- [ ] **Step 6: Smoke check in dev**

Start dev (or have it running): `npm run dev`. Open `/admin`. Confirm:
- Email column shows a 24px circle aligned with the email text (Google avatar for OAuth users, initial-letter circle for admin-pre-added users).
- "Последний вход" shows readable text ("3 ч назад", "вчера", "15 апр", or "—").
- Hover over the relative time → tooltip shows full ISO.

If avatars appear broken (alt text visible / broken-image icon), confirm `referrerPolicy="no-referrer"` is on the `<img>` — Google's CDN blocks browser-default Referer requests inconsistently.

- [ ] **Step 7: Commit**

```bash
git add components/admin/users-tab.tsx
git commit -m "feat(admin/users): avatar in Email column + relative time for last login

24px circle (rounded-full <img> with referrerPolicy='no-referrer' per
post-ship convention #7; falls back to initial-letter chip when
picture_url is null). Last-login column uses formatRelativeTime with
the full ISO available on hover via title=.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: Inline auto-save `QuotaRowEditor` rewrite

**Files:**
- Modify: `components/admin/users-tab.tsx` — `UserQuotas` thead/tbody and `QuotaRowEditor` body

- [ ] **Step 1: Add icon imports**

In `components/admin/users-tab.tsx`, find the lucide-react import (currently line 4):

```ts
import { ChevronRight, ChevronDown } from "lucide-react";
```

Replace with:

```ts
import { ChevronRight, ChevronDown, Check, Loader2, Undo2 } from "lucide-react";
```

- [ ] **Step 2: Add the `EditorStatus` type alias**

In `components/admin/users-tab.tsx`, immediately below the `QuotaRow` interface (currently ends at line 27), add:

```ts
type EditorStatus = "synced" | "dirty" | "saving" | "saved";
```

- [ ] **Step 3: Drop the actions column from `UserQuotas` `<thead>`**

In `components/admin/users-tab.tsx`, find the `<thead>` block (currently lines 240-248):

```tsx
      <thead className="text-zinc-500">
        <tr className="border-b border-zinc-200 dark:border-zinc-800">
          <th className="py-1.5 pr-3 text-left font-medium">Модель</th>
          <th className="py-1.5 px-3 text-right font-medium">Лимит</th>
          <th className="py-1.5 px-3 text-center font-medium">Источник</th>
          <th className="py-1.5 px-3 text-right font-medium">Использовано</th>
          <th className="py-1.5 pl-3"></th>
        </tr>
      </thead>
```

Replace with (one fewer `<th>`):

```tsx
      <thead className="text-zinc-500">
        <tr className="border-b border-zinc-200 dark:border-zinc-800">
          <th className="py-1.5 pr-3 text-left font-medium">Модель</th>
          <th className="py-1.5 px-3 text-right font-medium">Лимит</th>
          <th className="py-1.5 px-3 text-center font-medium">Источник</th>
          <th className="py-1.5 pl-3 text-right font-medium">Использовано</th>
        </tr>
      </thead>
```

(Note: the `Использовано` column went from `px-3 text-right` to `pl-3 text-right` since it's now the last column — matches the no-padding-right convention used elsewhere.)

- [ ] **Step 4: Update the call site in `UserQuotas` (drop `onSave`, pass `userId`)**

The new editor saves itself directly (via the `userId` we already have in scope), so `onSave` becomes dead. In `UserQuotas`, find the call site (currently line 250):

```tsx
        {sortedRows.map((r) => <QuotaRowEditor key={r.model_id} row={r} onSave={setOverride} onClear={clearOverride} />)}
```

Replace with:

```tsx
        {sortedRows.map((r) => <QuotaRowEditor key={r.model_id} row={r} userId={userId} onClear={clearOverride} />)}
```

- [ ] **Step 5: Remove the now-orphaned `setOverride` from `UserQuotas`**

In `UserQuotas` (currently lines 220-227), delete the entire `setOverride` block:

```tsx
  async function setOverride(model_id: string, monthly_limit: number | null) {
    const r = await fetch(`/api/admin/users/${userId}/quotas/${model_id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ monthly_limit }),
    });
    if (r.ok) { toast.success("Сохранено"); void refetch(); } else toast.error("Ошибка");
  }
```

`clearOverride` stays — the `↺` button in the new editor still uses it.

- [ ] **Step 6: Replace the `QuotaRowEditor` function body with the inline auto-save version**

In `components/admin/users-tab.tsx`, find the entire `QuotaRowEditor` function (currently lines 256-344) and replace it with the version below. Note the new signature (`userId` replaces `onSave`) and the direct fetch to `/api/admin/users/${userId}/quotas/${row.model_id}` inside `commit`:

```tsx
function QuotaRowEditor({ row, userId, onClear }: {
  row: QuotaRow;
  userId: number;
  onClear: (model_id: string) => void;
}) {
  const [val, setVal] = React.useState<string>(row.applicable_limit?.toString() ?? "");
  const [unlimited, setUnlimited] = React.useState(row.applicable_limit === null);
  const [status, setStatus] = React.useState<EditorStatus>("synced");
  const savedTimerRef = React.useRef<number | null>(null);
  const inputRef = React.useRef<HTMLInputElement | null>(null);

  // Re-sync from props when the row changes (e.g. SSE-driven refetch),
  // but never stomp an in-progress edit.
  React.useEffect(() => {
    if (status === "dirty" || status === "saving") return;
    setVal(row.applicable_limit?.toString() ?? "");
    setUnlimited(row.applicable_limit === null);
  }, [row.applicable_limit, status]);

  React.useEffect(() => () => {
    if (savedTimerRef.current) window.clearTimeout(savedTimerRef.current);
  }, []);

  function flashSaved() {
    setStatus("saved");
    if (savedTimerRef.current) window.clearTimeout(savedTimerRef.current);
    savedTimerRef.current = window.setTimeout(() => setStatus("synced"), 1500);
  }

  async function commit(nextUnlim: boolean, nextRaw: string) {
    // Empty input + not unlimited = no actionable value. Snap back.
    if (!nextUnlim && nextRaw.trim() === "") {
      setVal(row.applicable_limit?.toString() ?? "");
      setUnlimited(row.applicable_limit === null);
      setStatus("synced");
      return;
    }
    const next = nextUnlim ? null : Number(nextRaw);
    // Skip PUT only when the override row already has this exact value —
    // an admin who types the default value into a row WITHOUT an override
    // is making the explicit gesture "I want an override" and we honor it.
    if (row.has_override && next === row.applicable_limit) {
      setStatus("synced");
      return;
    }
    setStatus("saving");
    try {
      const r = await fetch(`/api/admin/users/${userId}/quotas/${row.model_id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ monthly_limit: next }),
      });
      if (r.ok) flashSaved();
      else throw new Error("save failed");
    } catch {
      toast.error("Ошибка сохранения квоты");
      setStatus("dirty");
    }
  }

  return (
    <tr className="border-t border-zinc-100 dark:border-zinc-900 hover:bg-zinc-100/40 dark:hover:bg-zinc-900/40">
      <td className="py-1.5 pr-3">{row.display_name}</td>
      <td className="py-1.5 px-3 text-right">
        <span className="inline-flex items-center justify-end gap-2">
          <input
            ref={inputRef}
            type="number"
            value={val}
            disabled={unlimited}
            onChange={(e) => { setVal(e.target.value); setStatus("dirty"); }}
            onBlur={() => void commit(unlimited, val)}
            onKeyDown={(e) => {
              if (e.key === "Enter") (e.currentTarget as HTMLInputElement).blur();
            }}
            className="w-20 rounded border px-2 py-0.5 text-right tabular-nums disabled:opacity-40"
          />
          <label className="inline-flex items-center gap-1 text-xs">
            <input
              type="checkbox"
              checked={unlimited}
              onChange={(e) => {
                const nextUnlim = e.target.checked;
                setUnlimited(nextUnlim);
                if (nextUnlim) {
                  void commit(true, val);
                } else {
                  setStatus("dirty");
                  window.requestAnimationFrame(() => inputRef.current?.focus());
                }
              }}
            />
            <span>∞</span>
          </label>
          {row.has_override && (
            <button
              type="button"
              onClick={() => onClear(row.model_id)}
              disabled={status === "saving"}
              title="Сбросить override → default"
              className="rounded p-0.5 text-zinc-400 hover:text-orange-600 disabled:opacity-30"
            >
              <Undo2 className="h-3.5 w-3.5" />
            </button>
          )}
          <span
            className="inline-flex h-4 w-4 items-center justify-center"
            aria-live="polite"
            aria-label={
              status === "dirty" ? "не сохранено"
                : status === "saving" ? "сохраняем"
                : status === "saved" ? "сохранено"
                : ""
            }
          >
            {status === "saving" && <Loader2 className="h-3.5 w-3.5 animate-spin text-zinc-400" />}
            {status === "saved" && <Check className="h-3.5 w-3.5 text-green-500" />}
            {status === "dirty" && <span className="h-2 w-2 rounded-full bg-orange-400" />}
          </span>
        </span>
      </td>
      <td className="py-1.5 px-3 text-center">
        <span
          className={`inline-flex rounded px-1.5 py-0.5 text-[10px] font-medium ${
            row.source === "override"
              ? "bg-blue-100 text-blue-700 dark:bg-blue-950 dark:text-blue-300"
              : "text-zinc-400 dark:text-zinc-500"
          }`}
        >
          {row.source}
        </span>
      </td>
      <td className="py-1.5 pl-3 text-right tabular-nums">{row.usage_this_month}</td>
    </tr>
  );
}
```

- [ ] **Step 7: Verify type-check + tests**

Run in parallel:
- `npx tsc --noEmit` — Expected: PASS
- `npx vitest run` — Expected: PASS, no regressions

If `tsc` complains about `EditorStatus` being unused outside `QuotaRowEditor` — leave the type at module scope (it documents the state machine).

- [ ] **Step 8: Smoke check in dev**

Open `/admin`, expand any user, confirm:
- Inner table now has 4 columns (Модель / Лимит / Источник / Использовано). No actions column.
- Limit cell shows: `[number input] [☐ ∞] [↺ if has_override] [status slot]`.
- Type a number → orange dot appears immediately → tab away → spinner → green check → fades after 1.5s. Source badge flips to `override`.
- Toggle `∞` on a default row → immediate save (no need to blur), spinner → check → badge `override`, input greyed.
- Toggle `∞` off → input enables, focuses, dirty dot. Type a number, blur → save.
- Click `↺` on an override row → reverts to default, badge `default`, `↺` disappears.
- Empty the input field, blur → snaps back to server value silently.

Watch for: layout shift when status icons swap (should be none — `w-4` slot keeps it stable).

- [ ] **Step 9: Commit**

```bash
git add components/admin/users-tab.tsx
git commit -m "refactor(admin/users): inline auto-save for per-user quota editor

Migrates QuotaRowEditor from the legacy [изменить]→input→[Сохранить][Отмена]
modal-edit pattern to the inline auto-save pattern established by
LimitEditor in models-tab.tsx (post-ship convention #3). The actions
column is eliminated; ↺ reset (clears override → default) lives inside
the limit cell next to the 4-state status indicator. Inner UserQuotas
table goes from 5 to 4 columns.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: Add `admin.quota_changed` event type

**Files:**
- Modify: `lib/sse-broadcast.ts:20-30`

- [ ] **Step 1: Extend the `SseEvent` union**

In `lib/sse-broadcast.ts`, find the `SseEvent` type (currently lines 20-30):

```ts
export type SseEvent =
  | { type: "generation.created"; data: any }
  | { type: "generation.deleted"; data: { id: number } }
  | { type: "quota_updated" }
  | { type: "user_banned" }
  | { type: "user_role_changed" }
  // Admin-only fan-out: emitted whenever ANY user successfully creates
  // a generation. Admins listen to refresh aggregate views (Users tab
  // counts, Models tab counts) in real time. Carries the originating
  // user_id so future admin views can target updates if needed.
  | { type: "admin.user_generated"; data: { user_id: number } };
```

Add a new arm to the union, after `admin.user_generated`:

```ts
export type SseEvent =
  | { type: "generation.created"; data: any }
  | { type: "generation.deleted"; data: { id: number } }
  | { type: "quota_updated" }
  | { type: "user_banned" }
  | { type: "user_role_changed" }
  // Admin-only fan-out: emitted whenever ANY user successfully creates
  // a generation. Admins listen to refresh aggregate views (Users tab
  // counts, Models tab counts) in real time. Carries the originating
  // user_id so future admin views can target updates if needed.
  | { type: "admin.user_generated"; data: { user_id: number } }
  // Admin-only fan-out: emitted on per-user override save/clear and on
  // model-default change. user_id=0 sentinel = "all users affected"
  // (model default change). The expanded UserQuotas listens and refetches
  // when the event matches the user it's currently displaying.
  | { type: "admin.quota_changed"; data: { user_id: number; model_id: string } };
```

- [ ] **Step 2: Verify type-check**

Run: `npx tsc --noEmit`

Expected: PASS — no consumers reference the new type yet, so the union extension is purely additive.

- [ ] **Step 3: Commit**

```bash
git add lib/sse-broadcast.ts
git commit -m "feat(sse): add admin.quota_changed event type

Admin-scoped event for per-user quota override changes and model-default
changes. user_id=0 sentinel means 'all users affected'. Mirrors the
admin.user_generated pattern. Producers and listeners follow in next
commits.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 6: Server fan-out from quota PUT/DELETE

**Files:**
- Modify: `app/api/admin/users/[id]/quotas/[model]/route.ts`

- [ ] **Step 1: Add a small helper for admin fan-out at the top of the file**

In `app/api/admin/users/[id]/quotas/[model]/route.ts`, immediately below the existing imports, add:

```ts
function fanOutQuotaChanged(targetUserId: number, modelId: string) {
  const admins = getDb().prepare(
    `SELECT id FROM users WHERE role='admin' AND status='active'`
  ).all() as { id: number }[];
  for (const a of admins) {
    broadcastToUserId(a.id, {
      type: "admin.quota_changed",
      data: { user_id: targetUserId, model_id: modelId },
    });
  }
}
```

- [ ] **Step 2: Call the helper from the PUT handler**

In the same file, find the PUT handler. After this line (currently line 36):

```ts
  broadcastToUserId(userId, { type: "quota_updated" });
```

Add immediately below it:

```ts
  fanOutQuotaChanged(userId, model);
```

- [ ] **Step 3: Call the helper from the DELETE handler (gated on `result.changes > 0`)**

In the same file, find the DELETE handler's broadcast block (currently lines 51-57):

```ts
  if (result.changes > 0) {
    writeAuthEvent(getDb(), {
      event_type: "admin_quota_changed", user_id: me.id,
      details: { target_user_id: userId, model_id: model, action: "removed_override" },
    });
    broadcastToUserId(userId, { type: "quota_updated" });
  }
```

Add `fanOutQuotaChanged(userId, model);` inside the `if` block, after `broadcastToUserId`:

```ts
  if (result.changes > 0) {
    writeAuthEvent(getDb(), {
      event_type: "admin_quota_changed", user_id: me.id,
      details: { target_user_id: userId, model_id: model, action: "removed_override" },
    });
    broadcastToUserId(userId, { type: "quota_updated" });
    fanOutQuotaChanged(userId, model);
  }
```

- [ ] **Step 4: Verify type-check**

Run: `npx tsc --noEmit`

Expected: PASS — `admin.quota_changed` from Task 5 satisfies the union.

- [ ] **Step 5: Commit**

```bash
git add app/api/admin/users/[id]/quotas/[model]/route.ts
git commit -m "feat(sse): fan out admin.quota_changed from quota PUT/DELETE

Each admin override save/clear now notifies every active admin so other
admin sessions viewing the same user's quotas refetch live. Mirrors the
admin.user_generated fan-out pattern from app/api/history/route.ts POST.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 7: Server fan-out from model PATCH (default change)

**Files:**
- Modify: `app/api/admin/models/[model_id]/route.ts`

- [ ] **Step 1: Add the fan-out helper at the top of the file**

In `app/api/admin/models/[model_id]/route.ts`, immediately below the existing imports, add:

```ts
function fanOutQuotaChangedAllUsers(modelId: string) {
  const admins = getDb().prepare(
    `SELECT id FROM users WHERE role='admin' AND status='active'`
  ).all() as { id: number }[];
  for (const a of admins) {
    broadcastToUserId(a.id, {
      type: "admin.quota_changed",
      data: { user_id: 0, model_id: modelId },
    });
  }
}
```

- [ ] **Step 2: Call the helper inside the `defaultChanged` block**

Find the PATCH handler's `defaultChanged` block (currently lines 44-57). After this line (the per-user fan-out):

```ts
    for (const { id } of affected) broadcastToUserId(id, { type: "quota_updated" });
```

Add immediately below it (still inside the `if (defaultChanged) {` block):

```ts
    fanOutQuotaChangedAllUsers(model_id);
```

The full block now reads:

```ts
  if (defaultChanged) {
    writeAuthEvent(getDb(), {
      event_type: "admin_model_default_changed", user_id: me.id,
      details: { model_id, from: before.default_monthly_limit, to: body.default_monthly_limit ?? null },
    });
    // Broadcast to active users without an override on this model — their
    // applicable_limit just changed, so refetch their quotas.
    const affected = getDb().prepare(`
      SELECT u.id FROM users u
      WHERE u.status='active'
        AND u.id NOT IN (SELECT user_id FROM user_quotas WHERE model_id=?)
    `).all(model_id) as { id: number }[];
    for (const { id } of affected) broadcastToUserId(id, { type: "quota_updated" });
    fanOutQuotaChangedAllUsers(model_id);
  }
```

(The `is_active` block does NOT get this fan-out — `is_active` change is already covered by the existing per-user `quota_updated` broadcast and doesn't affect override values.)

- [ ] **Step 3: Verify type-check**

Run: `npx tsc --noEmit`

Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add app/api/admin/models/[model_id]/route.ts
git commit -m "feat(sse): fan out admin.quota_changed from model default change

When admin changes a model's default_monthly_limit, every user without
an override on that model has their applicable_limit shift. Notify all
admins with user_id=0 sentinel so any expanded UserQuotas view refetches
its values.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 8: `UserQuotas` SSE subscribe + smoke test

**Files:**
- Modify: `components/admin/users-tab.tsx` — `UserQuotas` function

- [ ] **Step 1: Add the SSE listener inside `UserQuotas`**

In `components/admin/users-tab.tsx`, find `UserQuotas` (currently around line 212). Immediately after this block:

```tsx
  React.useEffect(() => { void refetch(); }, [refetch]);
```

Add a new effect:

```tsx
  // Cross-tab admin real-time: another admin (or this admin from another
  // tab) saving an override on this user, OR a model default change, OR
  // any user posting a generation that affects usage_this_month — all
  // refetch our rows so values stay live without manual interaction.
  React.useEffect(() => {
    if (typeof EventSource === "undefined") return;
    const es = new EventSource("/api/history/stream");
    es.addEventListener("admin.quota_changed", (e) => {
      try {
        const { user_id } = JSON.parse((e as MessageEvent).data) as { user_id: number };
        if (user_id === userId || user_id === 0) void refetch();
      } catch {
        // Malformed payload — defensive ignore.
      }
    });
    es.addEventListener("admin.user_generated", (e) => {
      try {
        const { user_id } = JSON.parse((e as MessageEvent).data) as { user_id: number };
        if (user_id === userId) void refetch();
      } catch {
        // Malformed payload — defensive ignore.
      }
    });
    es.onerror = () => es.close();
    return () => es.close();
  }, [userId, refetch]);
```

- [ ] **Step 2: Verify type-check + tests**

Run in parallel:
- `npx tsc --noEmit` — Expected: PASS
- `npx vitest run` — Expected: PASS, no regressions

- [ ] **Step 3: Two-window smoke test**

Open two windows on `localhost:3000` (or `192.168.88.76:3000`), both signed in as admin (different accounts is ideal but the same admin in two browsers also works).

In window A:
1. Navigate to `/admin` → Users tab.
2. Expand any user that has at least one override.

In window B:
1. Navigate to `/admin` → Users tab.
2. Expand the same user.
3. Change one of their overrides — type a new number, blur. Or click ↺ to clear an override.

In window A (no focus change, no clicks):
- The corresponding row's value updates within ~1s.
- The source badge flips if the override was cleared.

Now in window B:
1. Navigate to Models tab.
2. Change the `default_monthly_limit` for a model. Save.

In window A:
- Rows for users without an override on that model show the new default within ~1s.

Now generate as a non-admin user in a third tab/browser:
- The expanded user's `Использовано` cell ticks up within ~1s in window A.

If any of these don't fire:
- DevTools → Network → confirm an active `EventSource` connection to `/api/history/stream`.
- Server console → grep for `[history POST]` and admin user lookup errors.
- Confirm both admin sessions have `role='admin' AND status='active'` in the DB.

- [ ] **Step 4: Regression check on the existing real-time path**

Confirm the OUTER row's `Генераций (мес.)` counter still ticks live (separate from the inner table updates) when a user generates. This is the existing `admin.user_generated` listener on `UsersTab` — it should be unaffected by all the changes in this plan.

- [ ] **Step 5: Commit**

```bash
git add components/admin/users-tab.tsx
git commit -m "feat(admin/users): UserQuotas subscribes to admin.quota_changed SSE

Inner per-user quota table now refetches on (a) admin.quota_changed
matching this user_id (per-user override edit), (b) admin.quota_changed
with user_id=0 (model default change), (c) admin.user_generated matching
this user_id (live usage_this_month tick). Closes the cross-tab admin
gap where editing a user's override in one tab left another admin
session showing stale values until refocus.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Final acceptance check

Run once more after Task 8:

- [ ] `npx tsc --noEmit` — clean.
- [ ] `npx vitest run` — full suite green (229 expected if Task 1's 8 new tests added).
- [ ] All 8 acceptance criteria from `docs/superpowers/specs/2026-05-05-users-tab-polish-design.md` § "Acceptance criteria" hand-verified in dev.
- [ ] `git log --oneline -10` shows the 8 commits in order: helper + tests, picture_url SELECT, avatar render, QuotaRowEditor rewrite, sse type, quota fan-out, model fan-out, UserQuotas listener.
