# Multiple Slack webhooks for the low-balance alert

**Date:** 2026-06-30
**Status:** Design approved, pending spec review → implementation plan

## Problem / goal

The low-balance Slack alert ([[low-balance-slack-alert]]) currently posts to a
single `FAL_BALANCE_SLACK_WEBHOOK` env var. The operator wants to notify several
individuals — one webhook per person (DM-style), not a shared channel — and to
add/remove people from the admin UI without a redeploy.

## Key decisions

1. **Storage: admin UI, in `app_settings`** (not env). Adding a person is
   self-service, no rebuild.
2. **Secrets are write-only / masked on read.** The full webhook URL is NEVER
   returned to the browser. The admin sees `label + …last6`; to change a URL you
   remove and re-add. Keeps the secret server-side.
3. **Add/remove operations (not whole-list PUT).** Because the form never holds
   the real URLs of existing entries, webhooks are managed via a dedicated route
   with `POST` (add) / `DELETE` (remove) — separate from the `balance-config`
   PUT that round-trips threshold + times wholesale.
4. **Broadcast to all.** A low-balance alert is sent to every configured
   webhook.
5. **Per-person label.** Each webhook carries a human label so the admin knows
   whose it is.
6. **Env fallback for backward-compat.** When the admin list is empty,
   `resolveTargets()` falls back to `process.env.FAL_BALANCE_SLACK_WEBHOOK` —
   the current prod setup keeps working until the operator adds entries.
7. No DB schema change — a new `app_settings` key holds the list.

## Data model (`app_settings`, TEXT)

- `falBalanceWebhooks` — JSON array of `{ id: string, label: string, url: string }`.
  `id` is a generated stable identifier (so removal works despite masked URLs).
  Unset/blank → empty list.

## Components

### 1. `lib/admin/balance-webhooks.ts` (new, server-only)
- `maskUrl(url: string): string` — returns `…` + last 6 chars (or the whole
  string if shorter), never the full secret.
- `listWebhooksMasked(): { id: string; label: string; urlMask: string }[]` —
  parses `falBalanceWebhooks`; full `url` never included.
- `addWebhook(input: { label: string; url: string }): { id: string }` —
  validates `url` starts with `https://hooks.slack.com/` (throws on invalid),
  trims/validates `label` (non-empty, capped), generates an `id`
  (`crypto.randomUUID()`), appends, persists. Returns the new id.
- `removeWebhook(id: string): void` — drops the entry with that id, persists.
- `resolveTargets(): string[]` — full URLs from the list; **if the list is
  empty, falls back to `[process.env.FAL_BALANCE_SLACK_WEBHOOK]` when set**,
  else `[]`. Server-only; full URLs never leave the server except as outbound
  POSTs.
- Defensive parse: malformed JSON / non-object entries → treated as empty.

### 2. `lib/notify/slack.ts` (modify)
Change `sendSlackAlert` to take an explicit URL:
`sendSlackAlert(text: string, url: string): Promise<boolean>`. It no longer
reads the env var (the caller resolves targets). POST body / `charset=utf-8` /
caught-error → `false` behavior is unchanged. Empty/falsy `url` → `false`, no
fetch.

### 3. `lib/admin/balance-alert.ts` `checkBalanceAndAlert` (modify)
On `shouldSend`, instead of one `sendSlackAlert(text)`:
```
const urls = resolveTargets();
const results = await Promise.all(urls.map((u) => sendSlackAlert(text, u)));
const sent = results.filter(Boolean).length;
```
Return `{ status: "ok", sent }` where `sent` is the delivered count (0 when no
targets configured — same "silent" outcome as today). `falBalanceAlerted` is
still persisted with `nextAlerted` (the edge-trigger state flips regardless of
delivery count, matching current behavior).

### 4. `app/api/admin/balance-webhooks/route.ts` (new)
Admin-guarded (same `getCurrentUser` 401/403 pattern), `runtime = "nodejs"`.
- `GET` → `{ webhooks: { id, label, urlMask }[] }` (masked).
- `POST { label, url }` → validates (label non-empty; url starts with
  `https://hooks.slack.com/`); 400 on invalid; on success adds and returns
  `{ ok: true, id }`.
- `DELETE { id }` → removes; `{ ok: true }`.

### 5. `components/admin/fal-balance-alert-config.tsx` (modify)
Add a "Получатели уведомления" sub-section below the times:
- A list of rows: `label — …mask` with an `×` delete button (calls `DELETE`).
- An add form: a text input for the label + a text input for the webhook URL +
  an "Добавить" button (calls `POST`, then refreshes the masked list).
- The URL input is cleared after a successful add (the value is write-only).
- Reuses the existing card's fetch/toast patterns. The threshold + times block
  is unchanged.

## Error handling

- Invalid webhook URL (not a Slack hook) → `POST` 400 with a message; the UI
  toasts it; nothing persisted.
- One webhook failing at send time (network/non-ok) → that target counts as not
  delivered; others still get the message; the tick never throws.
- Malformed `falBalanceWebhooks` JSON → treated as empty list (no crash).

## Testing

- `lib/admin/__tests__/balance-webhooks.test.ts` — `maskUrl` (long/short);
  `addWebhook` validation (rejects non-Slack URL, empty label) + persists with a
  generated id; `removeWebhook` drops by id; `listWebhooksMasked` never exposes
  the full URL; `resolveTargets` (list present → list; list empty + env set →
  env; both empty → `[]`). Mock `@/lib/history-db` `get/setAppSetting` with a
  live store; stub env where needed.
- `lib/notify/__tests__/slack.test.ts` — update to the `(text, url)` signature:
  posts to the given url; empty url → false, no fetch; non-ok/throw → false.
- `lib/admin/__tests__/balance-alert.test.ts` — `checkBalanceAndAlert` now
  broadcasts to every target from a mocked `resolveTargets` and reports the
  delivered count; 0 targets → `sent: 0`, no send.
- `app/api/admin/balance-webhooks/__tests__/route.test.ts` — admin guard
  (401/403); `POST` valid add + 400 on bad URL; `DELETE` removes; `GET` returns
  masked entries only (no full URL in the body). Mock auth via `vi.doMock`.

## Operator note

Existing prod `FAL_BALANCE_SLACK_WEBHOOK` keeps working (fallback). To switch to
per-person DMs: in admin Settings, add each person's webhook (label + URL); once
≥1 is added, the env fallback is no longer used. Removing all of them reverts to
the env fallback.

## Out of scope

- Per-webhook routing (different alerts to different people) — all configured
  webhooks get every low-balance alert.
- Editing a webhook URL in place (write-only: remove + re-add).
- Email/other channels; per-employee spend (separate future specs).
