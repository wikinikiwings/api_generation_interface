# Low fal.ai balance → Slack alert

**Date:** 2026-06-30
**Status:** Design approved, pending spec review → implementation plan

## Problem / goal

Admins want to be notified in Slack when the fal.ai account balance drops below
a threshold — proactively, without anyone watching the admin panel. Builds on
the shipped balance widget ([[admin-fal-balance]], `getFalBalance()`).

## Key decisions

1. **Channel: Slack incoming webhook.** One webhook URL in env; the server
   `POST`s `{"text": "..."}` to it. No SMTP, no recipient list. (Verified
   manually that an incoming webhook posts to the channel.)
2. **Scheduling: in-process, at admin-configured times of day** (NOT a fixed
   interval, NOT an external/Windows scheduler, NOT browser-driven). The
   container is up "almost always"; if it's down the user explicitly does not
   care about balance. A lightweight ~30s server tick (no fal call) fires the
   actual balance check only at the configured times.
3. **Timezone: store UTC, convert in the browser** — mirrors the proven
   `C:\dev\runpod_manager` approach (`runpod_manager.py` scheduler +
   `utcTimeToLocal`/`localTimeToUtc`/`getTzLabel` JS). Times persist as UTC
   `"HH:MM"`; the admin enters/sees them in their browser-local timezone with a
   `UTC±N` label. No server TZ config, works for any zone, no DST/offset state.
4. **Re-alert policy: edge-triggered + re-arm.** Send once when balance first
   crosses below the threshold; stay silent while it remains low; reset when it
   recovers above the threshold so the next dip alerts again.
5. **Threshold + check times: configured in the admin Settings UI**, stored in
   `app_settings`. Empty = alerting disabled.
6. No DB schema change — all state lives in the existing `app_settings`
   key/value table.

## Data model (`app_settings` keys, all TEXT)

- `falBalanceThreshold` — number as string (e.g. `"10"`). Unset/blank → alerting
  disabled.
- `falBalanceCheckTimes` — JSON array of **UTC** `"HH:MM"` strings, e.g.
  `["05:00","09:00","13:00"]`. Empty/unset → disabled.
- `falBalanceAlerted` — `"true"` / `"false"`. The edge-trigger re-arm flag.
- `falBalanceLastRun` — JSON map `slot → "YYYY-MM-DD"` (UTC date), e.g.
  `{"05:00":"2026-06-30"}`. Per-slot per-UTC-day guard against double-firing and
  for restart safety.

## Components

### 1. `lib/notify/slack.ts` (new, server-only)
`sendSlackAlert(text: string): Promise<boolean>` — `POST` to
`process.env.FAL_BALANCE_SLACK_WEBHOOK` with `Content-Type: application/json;
charset=utf-8` and body `JSON.stringify({ text })` (Node sends UTF-8 — Cyrillic
is fine; the `???` seen in the manual PowerShell test was a PS-only encoding
quirk). Webhook unset → return `false` (alerting disabled, no throw). Network
error caught → `false` (never crashes the tick).

### 2. `lib/admin/balance-alert.ts` (new, server-only)
- `decideAlert({ balance, threshold, alreadyAlerted }): { shouldSend: boolean; nextAlerted: boolean }`
  — **pure** core:
  - `balance < threshold && !alreadyAlerted` → `{ shouldSend: true, nextAlerted: true }`
  - `balance >= threshold && alreadyAlerted` → `{ shouldSend: false, nextAlerted: false }` (re-arm)
  - otherwise → `{ shouldSend: false, nextAlerted: alreadyAlerted }`
- `checkBalanceAndAlert(): Promise<{ status: string; ... }>` — orchestrator:
  reads `falBalanceThreshold` (unset → `{status:"no_threshold"}`), calls
  `getFalBalance()` (not `ok` → `{status:"balance_<status>"}`), reads
  `falBalanceAlerted`, applies `decideAlert`, sends Slack on `shouldSend`,
  persists `falBalanceAlerted`. Returns a summary for logging/manual-trigger.

### 3. `lib/admin/balance-schedule.ts` (new, server-only) — the time logic
- `dueSlots({ now, checkTimes, lastRun }): string[]` — **pure**: given the
  current UTC `Date`, the configured UTC `"HH:MM"` slots, and the per-slot
  last-run-date map, return the slots that are due now (current UTC time has
  reached the slot AND the slot has not run today). "Reached" = current
  UTC minutes-of-day ≥ slot minutes-of-day; "today" = `now` UTC `YYYY-MM-DD`.
  (Reached-and-not-run-today, rather than exact-minute equality, makes a ~30s
  tick and restarts tolerant — a slot still fires once on the first tick at/after
  its time each UTC day.)
- `runScheduledCheck(): Promise<void>` — reads `falBalanceCheckTimes` +
  `falBalanceLastRun`, computes `dueSlots(new Date(), ...)`; if any are due,
  calls `checkBalanceAndAlert()` once and marks each due slot done for today in
  `falBalanceLastRun`.

### 4. `instrumentation.ts` (new at repo root) — the tick
Next.js `register()` startup hook. In the **nodejs** runtime only (guard
`process.env.NEXT_RUNTIME === "nodejs"`) and once per process (module-level
flag), start `setInterval(runScheduledCheck, TICK_MS)` where `TICK_MS` =
`(Number(process.env.FAL_BALANCE_TICK_SECONDS) || 30) * 1000`. Each tick is
cheap (reads settings + clock; hits fal only when a slot is due). Errors inside
the tick are caught and logged, never thrown.

### 5. `app/api/admin/balance-config/route.ts` (new) — admin config
Admin-guarded (same `getCurrentUser` 401/403 pattern as
`app/api/admin/models/route.ts`).
- `GET` → `{ threshold: number|null, checkTimesUtc: string[] }` from
  `app_settings`.
- `PUT { threshold: number|null, checkTimesUtc: string[] }` → validates
  (threshold ≥ 0 or null; each time matches `^\d{2}:\d{2}$` and is a valid
  HH:MM), persists `falBalanceThreshold` + `falBalanceCheckTimes`. The client
  sends times already converted to UTC.

### 6. `components/admin/fal-balance-card.tsx` (modify)
Below the balance display add a config block:
- Threshold number input.
- A list of check-time rows, each a `<input type="time">` shown in
  **browser-local** time, with an `×` to remove and a `+` to add a row.
- A `UTC±N` timezone label (from `tzLabel()`).
- Save button → converts each local time to UTC (`localTimeToUtc`) and `PUT`s
  `/api/admin/balance-config`; on load, `GET`s and converts UTC→local
  (`utcTimeToLocal`) for the inputs.

### 7. `lib/time/tz.ts` (new) — TS port of the runpod helpers
`utcTimeToLocal(hhmmUtc)`, `localTimeToUtc(hhmmLocal)`, `tzLabel()` using native
`Date` (`setUTCHours`/`getHours` and inverse), pure and unit-testable.

### 8. `.env.example` (modify)
Add `FAL_BALANCE_SLACK_WEBHOOK=` (incoming webhook URL; blank = alerts off) and
`FAL_BALANCE_TICK_SECONDS=30` (optional tick cadence) with comments.

## Slack message format

```json
{ "text": "⚠️ fal.ai: баланс низкий — 8.50 USD (порог 10). Пополнить: https://fal.ai/dashboard" }
```
(Balance/threshold/currency interpolated from the `ok` result.)

## Error handling

- Webhook unset / network error → `sendSlackAlert` returns `false`, tick
  continues. No alert, no crash.
- `getFalBalance` returns `not_configured`/`forbidden`/`error` → skip alerting
  this run (we can't evaluate the balance), recorded in the summary. The slot is
  still marked run-today so we don't retry-spam the same slot.
- Malformed `app_settings` JSON → treated as empty (disabled), logged.

## Testing

- `lib/time/__tests__/tz.test.ts` — `utcTimeToLocal`/`localTimeToUtc` round-trip
  at a few fixed offsets (stub the offset), `tzLabel` format.
- `lib/admin/__tests__/balance-alert.test.ts` — `decideAlert` truth table
  (below+not-alerted → send; below+alerted → silent; recover+alerted → re-arm;
  above+not-alerted → noop). `checkBalanceAndAlert` with mocked
  `getFalBalance`/settings/slack: no_threshold, balance-not-ok, send, re-arm,
  suppress-while-low.
- `lib/admin/__tests__/balance-schedule.test.ts` — `dueSlots`: a slot whose UTC
  time has passed and not run today → due; already-run-today → not due;
  future slot → not due; multiple slots.
- `app/api/admin/balance-config/__tests__/route.test.ts` — admin guard
  (401/403) + PUT validation (rejects bad time strings / negative threshold) +
  GET shape. (Mock auth via `vi.doMock`, as in the existing fal-balance route
  test.)
- Manual/E2E: set a threshold above current balance and a check time ~1 minute
  out; confirm one Slack message arrives; confirm no repeat on the next slot
  while still low; raise threshold below balance, confirm re-arm.

## Operator setup (post-merge, manual)

1. Create a Slack incoming webhook (done/verified); put its URL in prod
   `.env.local` as `FAL_BALANCE_SLACK_WEBHOOK=https://hooks.slack.com/services/...`.
2. Rebuild the container (`docker compose up -d --build wavespeed-claude`).
3. In the admin Settings tab, set the threshold and add check times (entered in
   your local time; stored as UTC automatically).

## Out of scope

- Email/SMTP channel; multiple channels.
- Per-employee spend (separate future spec).
- Alerting when the balance *read itself* fails (forbidden/error) — logged only.
- A manual "check now" button (could be a tiny follow-up; not required).
