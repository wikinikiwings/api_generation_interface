# Admin fal.ai balance widget

**Date:** 2026-06-30
**Status:** Design approved, pending spec review → implementation plan

## Problem / goal

Admins want to see the fal.ai account credit balance without leaving the app
for the fal dashboard. fal.ai exposes this via its platform billing API. Add a
small balance card to the admin panel's **Settings** tab.

## External API (verified against fal docs)

```
GET https://api.fal.ai/v1/account/billing?expand=credits
Authorization: Key <ADMIN_API_KEY>
```
Response:
```json
{ "username": "...", "credits": { "current_balance": 24.5, "currency": "USD" } }
```
`credits` is only present when `expand=credits`. Source:
https://fal.ai/docs/platform-apis/v1/account/billing

Note the host is `api.fal.ai` (platform API), distinct from `fal.run`
(inference, used by `lib/providers/fal.ts`). The Authorization scheme is the
same `Key <token>` form the inference provider already uses.

## Key decisions

1. **Dedicated `FAL_ADMIN_KEY` env var** (not reused `FAL_KEY`). The billing
   endpoint needs an admin-scoped key; least privilege keeps the inference key
   off billing and vice versa.
2. **Placement: a card on the Settings tab** (`components/admin-panel.tsx`
   `SettingsContent`), alongside the provider list — balance lives where the
   fal.ai provider status already shows.
3. **Refresh: fetch on mount + a manual refresh button.** No polling (admin
   traffic is tiny; balance changes slowly; avoid hammering the billing API).
4. **Failure states are explicit, not hidden** — mirror the provider list's
   "no key" treatment. Missing key / no billing scope / API error each render a
   distinct, actionable message rather than disappearing.

## Components

### 1. `lib/providers/fal-billing.ts` (new, server-only)

```ts
type FalBalanceResult =
  | { status: "ok"; balance: number; currency: string; username: string }
  | { status: "not_configured" }
  | { status: "forbidden" }
  | { status: "error"; message: string };

export async function getFalBalance(): Promise<FalBalanceResult>;
```

- Reads `process.env.FAL_ADMIN_KEY`. Absent / placeholder → `not_configured`.
- `GET https://api.fal.ai/v1/account/billing?expand=credits`, header
  `Authorization: Key <FAL_ADMIN_KEY>`, `cache: "no-store"`.
- HTTP 401/403 → `forbidden` (key lacks billing scope).
- Other non-OK / thrown / network error → `error` with a human message
  (reuse `extractFalError`-style extraction).
- 200 → map `credits.current_balance` / `credits.currency` / `username` to `ok`.
  If the JSON is missing `credits` (e.g. expand ignored) → `error`.
- The key is never returned to the caller or logged.

Kept in a separate file (not `fal.ts`) — `fal.ts` is the generation provider;
billing is a distinct concern with a different host and key.

### 2. `app/api/admin/fal-balance/route.ts` (new)

- `runtime = "nodejs"`.
- `requireAdmin(req)` guard (same shape as
  `app/api/admin/variants/stats/route.ts`): 401 if no user, 403 if not admin.
- Calls `getFalBalance()`, returns the result as JSON with HTTP 200.
  `not_configured` / `forbidden` / `error` are expected states carried in the
  `status` field, NOT HTTP error codes (the request itself succeeded).

### 3. `components/admin/fal-balance-card.tsx` (new, client)

- Fetches `/api/admin/fal-balance` (`cache: "no-store"`) on mount and on a
  manual **refresh** button (lucide `RefreshCw`, spinner while loading).
- States:
  - `loading` → spinner.
  - `ok` → balance formatted as e.g. `$24.50 USD` (large), `username` (muted).
  - `not_configured` → "FAL_ADMIN_KEY не задан" hint (mirrors provider "no key").
  - `forbidden` → "ключ без прав на биллинг".
  - `error` → the error message.
- Card chrome matches the existing Settings section styling
  (`rounded-xl border ...`).

### 4. `components/admin-panel.tsx` (modify)

Render `<FalBalanceCard />` inside `SettingsContent`, near the provider list.

### 5. `.env.example` (modify)

Add `FAL_ADMIN_KEY=` with a comment: admin-scoped fal.ai key, used only for the
billing/balance read; separate from `FAL_KEY` (inference).

## Testing

- `lib/providers/__tests__/fal-billing.test.ts` — mock `global.fetch` and set/
  unset `FAL_ADMIN_KEY`:
  - `ok`: 200 with `{username, credits:{current_balance, currency}}` → mapped
    result; assert the request used `Authorization: Key <token>` and the
    `expand=credits` URL.
  - `not_configured`: env unset → no fetch performed.
  - `forbidden`: 403 → `{ status: "forbidden" }`.
  - `error`: 500 or thrown fetch → `{ status: "error" }` with a message.
- Light route test (if the admin-route test harness allows): no admin cookie →
  401/403 from the guard; success path with `getFalBalance` mocked.

## Out of scope

- Other providers' balances (wavespeed/comfy have no such API) — no generalized
  abstraction (YAGNI).
- Spend history / usage charts.
- Caching / polling.
