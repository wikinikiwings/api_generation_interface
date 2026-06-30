# Low fal.ai Balance → Slack Alert Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Post a Slack alert when the fal.ai balance drops below an admin-configured threshold, checked by an in-process scheduler at admin-configured times of day.

**Architecture:** Times are stored UTC and converted to/from browser-local in the UI (mirrors `C:\dev\runpod_manager`). A ~30s server tick (`instrumentation.ts`) fires the balance check only when a configured time slot is due (per-UTC-day guard). The alert is edge-triggered + re-arm. All state lives in the existing `app_settings` key/value table — no schema change. Pure cores (`decideAlert`, `dueSlots`, tz helpers) are unit-tested; I/O edges are thin.

**Tech Stack:** Next.js 15.1 (app router, route handlers, `instrumentation.ts`), TypeScript, React, Vitest, lucide-react, better-sqlite3 (`app_settings`).

## Global Constraints

- Test runner: `npm test` (= `vitest run`); focused: `npm test -- <pattern>`. `@/` resolves to repo root.
- `FAL_BALANCE_SLACK_WEBHOOK` is server-only; never returned to the client or logged. Unset → alerting disabled (no throw).
- Times persist as **UTC** `"HH:MM"`; the browser converts local↔UTC. No server timezone config.
- `app_settings` keys (TEXT): `falBalanceThreshold` (number-string; blank=disabled), `falBalanceCheckTimes` (JSON array of UTC `"HH:MM"`), `falBalanceAlerted` (`"true"`/`"false"`), `falBalanceLastRun` (JSON map `slot→"YYYY-MM-DD"`).
- `getAppSetting(key): string|null` and `setAppSetting(key, value): void` from `@/lib/history-db`. `getFalBalance()` from `@/lib/providers/fal-billing` returns `{status:"ok",balance,currency,username} | {status:"not_configured"} | {status:"forbidden"} | {status:"error",message}`.
- Admin guard (route): `getCurrentUser(getDb(), req.cookies.get(SESSION_COOKIE_NAME)?.value ?? null)` → 401 if no user, 403 if `role !== "admin"` (sync function; same as `app/api/admin/models/route.ts`).
- Commit messages end with: `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`
- Work on branch `feat/low-balance-alert` (already created; the spec commit is its first commit).

---

### Task 1: Timezone helpers (`lib/time/tz.ts`)

**Files:**
- Create: `lib/time/tz.ts`
- Test: `lib/time/__tests__/tz.test.ts`

**Interfaces:**
- Produces: `utcTimeToLocal(hhmmUtc: string): string`, `localTimeToUtc(hhmmLocal: string): string`, `tzLabel(): string`.

- [ ] **Step 1: Write the failing test**

Create `lib/time/__tests__/tz.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { utcTimeToLocal, localTimeToUtc, tzLabel } from "@/lib/time/tz";

describe("tz helpers", () => {
  it("round-trips local↔UTC for valid HH:MM (offset-independent)", () => {
    for (const t of ["00:00", "09:30", "13:00", "23:45"]) {
      expect(localTimeToUtc(utcTimeToLocal(t))).toBe(t);
    }
  });

  it("pads to HH:MM", () => {
    expect(utcTimeToLocal("9:5")).toMatch(/^\d{2}:\d{2}$/);
  });

  it("passes through malformed input unchanged", () => {
    expect(utcTimeToLocal("nope")).toBe("nope");
    expect(localTimeToUtc("")).toBe("");
  });

  it("tzLabel looks like UTC+N / UTC-N[:MM]", () => {
    expect(tzLabel()).toMatch(/^UTC[+-]\d+(:\d{2})?$/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tz`
Expected: FAIL — cannot resolve `@/lib/time/tz`.

- [ ] **Step 3: Write the implementation**

Create `lib/time/tz.ts`:

```typescript
// Browser-local <-> UTC "HH:MM" conversion + a short tz label, using native
// Date. Mirrors C:\dev\runpod_manager's utcTimeToLocal/localTimeToUtc/getTzLabel.
// Pure; safe on server or client (uses the runtime's local timezone).

const HHMM = /^(\d{1,2}):(\d{1,2})$/;

export function utcTimeToLocal(hhmmUtc: string): string {
  const m = HHMM.exec(hhmmUtc);
  if (!m) return hhmmUtc;
  const d = new Date();
  d.setUTCHours(Number(m[1]), Number(m[2]), 0, 0);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

export function localTimeToUtc(hhmmLocal: string): string {
  const m = HHMM.exec(hhmmLocal);
  if (!m) return hhmmLocal;
  const d = new Date();
  d.setHours(Number(m[1]), Number(m[2]), 0, 0);
  return `${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}`;
}

export function tzLabel(): string {
  const off = -new Date().getTimezoneOffset();
  const sign = off >= 0 ? "+" : "-";
  const abs = Math.abs(off);
  const h = Math.floor(abs / 60);
  const mm = abs % 60;
  return `UTC${sign}${h}${mm ? ":" + String(mm).padStart(2, "0") : ""}`;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- tz`
Expected: PASS (4 tests).

- [ ] **Step 5: Typecheck + commit**

Run: `npx tsc --noEmit` (clean), then:

```bash
git add lib/time/tz.ts lib/time/__tests__/tz.test.ts
git commit -m "feat(time): UTC<->local HH:MM helpers + tz label

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 2: Slack sender (`lib/notify/slack.ts`)

**Files:**
- Create: `lib/notify/slack.ts`
- Test: `lib/notify/__tests__/slack.test.ts`
- Modify: `.env.example`

**Interfaces:**
- Produces: `sendSlackAlert(text: string): Promise<boolean>`.

- [ ] **Step 1: Write the failing test**

Create `lib/notify/__tests__/slack.test.ts`:

```typescript
import { describe, it, expect, vi, afterEach } from "vitest";
import { sendSlackAlert } from "@/lib/notify/slack";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("sendSlackAlert", () => {
  it("returns false and does not fetch when webhook unset", async () => {
    vi.stubEnv("FAL_BALANCE_SLACK_WEBHOOK", "");
    const spy = vi.spyOn(globalThis, "fetch");
    expect(await sendSlackAlert("hi")).toBe(false);
    expect(spy).not.toHaveBeenCalled();
  });

  it("posts {text} as JSON and returns true on 200", async () => {
    vi.stubEnv("FAL_BALANCE_SLACK_WEBHOOK", "https://hooks.slack.com/services/X");
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("ok", { status: 200 }));
    expect(await sendSlackAlert("привет ✅")).toBe(true);
    const [url, init] = spy.mock.calls[0];
    expect(String(url)).toContain("hooks.slack.com");
    expect((init as RequestInit).method).toBe("POST");
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({ text: "привет ✅" });
  });

  it("returns false on non-ok", async () => {
    vi.stubEnv("FAL_BALANCE_SLACK_WEBHOOK", "https://hooks.slack.com/services/X");
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("bad", { status: 500 }));
    expect(await sendSlackAlert("x")).toBe(false);
  });

  it("returns false when fetch throws", async () => {
    vi.stubEnv("FAL_BALANCE_SLACK_WEBHOOK", "https://hooks.slack.com/services/X");
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("down"));
    expect(await sendSlackAlert("x")).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- slack`
Expected: FAIL — cannot resolve `@/lib/notify/slack`.

- [ ] **Step 3: Write the implementation**

Create `lib/notify/slack.ts`:

```typescript
// Server-only. Posts a plain-text message to the configured Slack incoming
// webhook. Webhook unset → no-op (alerting disabled). Never throws.

export async function sendSlackAlert(text: string): Promise<boolean> {
  const url = process.env.FAL_BALANCE_SLACK_WEBHOOK;
  if (!url) return false;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json; charset=utf-8" },
      body: JSON.stringify({ text }),
      cache: "no-store",
    });
    return res.ok;
  } catch {
    return false;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- slack`
Expected: PASS (4 tests).

- [ ] **Step 5: Document the env var**

In `.env.example`, after the `FAL_ADMIN_KEY=...` line, add:

```
# Slack incoming webhook for the low-balance alert (admin panel schedules the
# checks). Blank = alerting disabled. Get one at api.slack.com/apps → Incoming Webhooks.
FAL_BALANCE_SLACK_WEBHOOK=
```

- [ ] **Step 6: Typecheck + commit**

Run: `npx tsc --noEmit` (clean), then:

```bash
git add lib/notify/slack.ts lib/notify/__tests__/slack.test.ts .env.example
git commit -m "feat(notify): sendSlackAlert posts to incoming webhook

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 3: Alert decision + orchestrator (`lib/admin/balance-alert.ts`)

**Files:**
- Create: `lib/admin/balance-alert.ts`
- Test: `lib/admin/__tests__/balance-alert.test.ts`

**Interfaces:**
- Consumes: `getFalBalance` (`@/lib/providers/fal-billing`), `getAppSetting`/`setAppSetting` (`@/lib/history-db`), `sendSlackAlert` (`@/lib/notify/slack`, Task 2).
- Produces:
  - `decideAlert(args: { balance: number; threshold: number; alreadyAlerted: boolean }): { shouldSend: boolean; nextAlerted: boolean }`
  - `checkBalanceAndAlert(): Promise<{ status: string; sent?: boolean }>`

- [ ] **Step 1: Write the failing test**

Create `lib/admin/__tests__/balance-alert.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const settings: Record<string, string | null> = {};
vi.mock("@/lib/history-db", () => ({
  getAppSetting: (k: string) => settings[k] ?? null,
  setAppSetting: (k: string, v: string) => { settings[k] = v; },
}));
const getFalBalance = vi.fn();
vi.mock("@/lib/providers/fal-billing", () => ({ getFalBalance: () => getFalBalance() }));
const sendSlackAlert = vi.fn();
vi.mock("@/lib/notify/slack", () => ({ sendSlackAlert: (t: string) => sendSlackAlert(t) }));

import { decideAlert, checkBalanceAndAlert } from "@/lib/admin/balance-alert";

beforeEach(() => {
  for (const k of Object.keys(settings)) delete settings[k];
  getFalBalance.mockReset();
  sendSlackAlert.mockReset().mockResolvedValue(true);
});
afterEach(() => vi.clearAllMocks());

describe("decideAlert", () => {
  it("sends when below threshold and not yet alerted", () => {
    expect(decideAlert({ balance: 5, threshold: 10, alreadyAlerted: false })).toEqual({ shouldSend: true, nextAlerted: true });
  });
  it("stays silent while below and already alerted", () => {
    expect(decideAlert({ balance: 5, threshold: 10, alreadyAlerted: true })).toEqual({ shouldSend: false, nextAlerted: true });
  });
  it("re-arms when recovered above and was alerted", () => {
    expect(decideAlert({ balance: 12, threshold: 10, alreadyAlerted: true })).toEqual({ shouldSend: false, nextAlerted: false });
  });
  it("noop when above and not alerted", () => {
    expect(decideAlert({ balance: 12, threshold: 10, alreadyAlerted: false })).toEqual({ shouldSend: false, nextAlerted: false });
  });
});

describe("checkBalanceAndAlert", () => {
  it("no_threshold when unset", async () => {
    expect(await checkBalanceAndAlert()).toEqual({ status: "no_threshold" });
    expect(getFalBalance).not.toHaveBeenCalled();
  });

  it("reports balance_<status> when balance not ok", async () => {
    settings.falBalanceThreshold = "10";
    getFalBalance.mockResolvedValue({ status: "forbidden" });
    expect(await checkBalanceAndAlert()).toEqual({ status: "balance_forbidden" });
    expect(sendSlackAlert).not.toHaveBeenCalled();
  });

  it("sends and sets alerted=true when below and not alerted", async () => {
    settings.falBalanceThreshold = "10";
    getFalBalance.mockResolvedValue({ status: "ok", balance: 4.5, currency: "USD", username: "t" });
    const r = await checkBalanceAndAlert();
    expect(r).toEqual({ status: "ok", sent: true });
    expect(sendSlackAlert).toHaveBeenCalledOnce();
    expect(settings.falBalanceAlerted).toBe("true");
  });

  it("suppresses while still low (already alerted)", async () => {
    settings.falBalanceThreshold = "10";
    settings.falBalanceAlerted = "true";
    getFalBalance.mockResolvedValue({ status: "ok", balance: 4.5, currency: "USD", username: "t" });
    const r = await checkBalanceAndAlert();
    expect(r).toEqual({ status: "ok", sent: false });
    expect(sendSlackAlert).not.toHaveBeenCalled();
    expect(settings.falBalanceAlerted).toBe("true");
  });

  it("re-arms (alerted=false) after recovery", async () => {
    settings.falBalanceThreshold = "10";
    settings.falBalanceAlerted = "true";
    getFalBalance.mockResolvedValue({ status: "ok", balance: 20, currency: "USD", username: "t" });
    await checkBalanceAndAlert();
    expect(sendSlackAlert).not.toHaveBeenCalled();
    expect(settings.falBalanceAlerted).toBe("false");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- balance-alert`
Expected: FAIL — cannot resolve `@/lib/admin/balance-alert`.

- [ ] **Step 3: Write the implementation**

Create `lib/admin/balance-alert.ts`:

```typescript
// Server-only. Decides + sends the low-balance Slack alert.
// decideAlert is a pure edge-trigger+re-arm core; checkBalanceAndAlert wires
// it to fal balance, app_settings state, and the Slack sender.

import { getFalBalance } from "@/lib/providers/fal-billing";
import { getAppSetting, setAppSetting } from "@/lib/history-db";
import { sendSlackAlert } from "@/lib/notify/slack";

export function decideAlert(args: {
  balance: number;
  threshold: number;
  alreadyAlerted: boolean;
}): { shouldSend: boolean; nextAlerted: boolean } {
  const { balance, threshold, alreadyAlerted } = args;
  if (balance < threshold && !alreadyAlerted) return { shouldSend: true, nextAlerted: true };
  if (balance >= threshold && alreadyAlerted) return { shouldSend: false, nextAlerted: false };
  return { shouldSend: false, nextAlerted: alreadyAlerted };
}

export async function checkBalanceAndAlert(): Promise<{ status: string; sent?: boolean }> {
  const raw = getAppSetting("falBalanceThreshold");
  const threshold = raw == null || raw.trim() === "" ? NaN : Number(raw);
  if (!Number.isFinite(threshold)) return { status: "no_threshold" };

  const bal = await getFalBalance();
  if (bal.status !== "ok") return { status: `balance_${bal.status}` };

  const alreadyAlerted = getAppSetting("falBalanceAlerted") === "true";
  const { shouldSend, nextAlerted } = decideAlert({ balance: bal.balance, threshold, alreadyAlerted });

  let sent = false;
  if (shouldSend) {
    const text = `⚠️ fal.ai: баланс низкий — ${bal.balance.toFixed(2)} ${bal.currency} (порог ${threshold}). Пополнить: https://fal.ai/dashboard`;
    sent = await sendSlackAlert(text);
  }
  setAppSetting("falBalanceAlerted", nextAlerted ? "true" : "false");
  return { status: "ok", sent };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- balance-alert`
Expected: PASS (10 tests).

- [ ] **Step 5: Typecheck + commit**

Run: `npx tsc --noEmit` (clean), then:

```bash
git add lib/admin/balance-alert.ts lib/admin/__tests__/balance-alert.test.ts
git commit -m "feat(balance-alert): edge-triggered decideAlert + checkBalanceAndAlert

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 4: Schedule logic (`lib/admin/balance-schedule.ts`)

**Files:**
- Create: `lib/admin/balance-schedule.ts`
- Test: `lib/admin/__tests__/balance-schedule.test.ts`

**Interfaces:**
- Consumes: `getAppSetting`/`setAppSetting` (`@/lib/history-db`), `checkBalanceAndAlert` (`./balance-alert`, Task 3).
- Produces:
  - `dueSlots(args: { now: Date; checkTimes: string[]; lastRun: Record<string,string> }): string[]`
  - `runScheduledCheck(now?: Date): Promise<void>`

- [ ] **Step 1: Write the failing test**

Create `lib/admin/__tests__/balance-schedule.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from "vitest";

const settings: Record<string, string | null> = {};
vi.mock("@/lib/history-db", () => ({
  getAppSetting: (k: string) => settings[k] ?? null,
  setAppSetting: (k: string, v: string) => { settings[k] = v; },
}));
const checkBalanceAndAlert = vi.fn();
vi.mock("@/lib/admin/balance-alert", () => ({ checkBalanceAndAlert: () => checkBalanceAndAlert() }));

import { dueSlots, runScheduledCheck } from "@/lib/admin/balance-schedule";

// 2026-06-30T10:05:00Z
const NOW = new Date("2026-06-30T10:05:00.000Z");

beforeEach(() => {
  for (const k of Object.keys(settings)) delete settings[k];
  checkBalanceAndAlert.mockReset().mockResolvedValue({ status: "ok" });
});

describe("dueSlots", () => {
  it("returns slots whose UTC time has passed and not run today", () => {
    expect(dueSlots({ now: NOW, checkTimes: ["09:00", "10:00"], lastRun: {} })).toEqual(["09:00", "10:00"]);
  });
  it("excludes slots already run today", () => {
    expect(dueSlots({ now: NOW, checkTimes: ["09:00"], lastRun: { "09:00": "2026-06-30" } })).toEqual([]);
  });
  it("excludes future slots", () => {
    expect(dueSlots({ now: NOW, checkTimes: ["11:00"], lastRun: {} })).toEqual([]);
  });
  it("ignores malformed slot strings", () => {
    expect(dueSlots({ now: NOW, checkTimes: ["bad", "25:99"], lastRun: {} })).toEqual([]);
  });
  it("re-fires a slot that ran yesterday", () => {
    expect(dueSlots({ now: NOW, checkTimes: ["09:00"], lastRun: { "09:00": "2026-06-29" } })).toEqual(["09:00"]);
  });
});

describe("runScheduledCheck", () => {
  it("does nothing when no check times configured", async () => {
    await runScheduledCheck(NOW);
    expect(checkBalanceAndAlert).not.toHaveBeenCalled();
  });
  it("runs the check once and marks due slots done for today", async () => {
    settings.falBalanceCheckTimes = JSON.stringify(["09:00", "10:00", "11:00"]);
    await runScheduledCheck(NOW);
    expect(checkBalanceAndAlert).toHaveBeenCalledOnce();
    const lastRun = JSON.parse(settings.falBalanceLastRun as string);
    expect(lastRun).toEqual({ "09:00": "2026-06-30", "10:00": "2026-06-30" });
  });
  it("does not run when all due slots already ran today", async () => {
    settings.falBalanceCheckTimes = JSON.stringify(["09:00"]);
    settings.falBalanceLastRun = JSON.stringify({ "09:00": "2026-06-30" });
    await runScheduledCheck(NOW);
    expect(checkBalanceAndAlert).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- balance-schedule`
Expected: FAIL — cannot resolve `@/lib/admin/balance-schedule`.

- [ ] **Step 3: Write the implementation**

Create `lib/admin/balance-schedule.ts`:

```typescript
// Server-only. Decides which configured time-slots are due now (pure dueSlots)
// and runs the balance check once per due tick (runScheduledCheck). Times are
// UTC "HH:MM"; the per-slot UTC-day guard in falBalanceLastRun prevents
// double-firing and survives restarts.

import { getAppSetting, setAppSetting } from "@/lib/history-db";
import { checkBalanceAndAlert } from "./balance-alert";

function slotMinutes(hhmm: string): number | null {
  const m = /^(\d{2}):(\d{2})$/.exec(hhmm);
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return h * 60 + min;
}

export function dueSlots(args: {
  now: Date;
  checkTimes: string[];
  lastRun: Record<string, string>;
}): string[] {
  const { now, checkTimes, lastRun } = args;
  const today = now.toISOString().slice(0, 10); // YYYY-MM-DD (UTC)
  const nowMin = now.getUTCHours() * 60 + now.getUTCMinutes();
  return checkTimes.filter((slot) => {
    const sm = slotMinutes(slot);
    if (sm == null) return false;
    if (nowMin < sm) return false;          // not reached yet today
    if (lastRun[slot] === today) return false; // already ran today
    return true;
  });
}

function parseArray(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const a = JSON.parse(raw);
    return Array.isArray(a) ? a.filter((x) => typeof x === "string") : [];
  } catch {
    return [];
  }
}

function parseMap(raw: string | null): Record<string, string> {
  if (!raw) return {};
  try {
    const o = JSON.parse(raw);
    return o && typeof o === "object" && !Array.isArray(o) ? (o as Record<string, string>) : {};
  } catch {
    return {};
  }
}

export async function runScheduledCheck(now: Date = new Date()): Promise<void> {
  const checkTimes = parseArray(getAppSetting("falBalanceCheckTimes"));
  if (checkTimes.length === 0) return;
  const lastRun = parseMap(getAppSetting("falBalanceLastRun"));
  const due = dueSlots({ now, checkTimes, lastRun });
  if (due.length === 0) return;

  await checkBalanceAndAlert();

  const today = now.toISOString().slice(0, 10);
  for (const slot of due) lastRun[slot] = today;
  setAppSetting("falBalanceLastRun", JSON.stringify(lastRun));
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- balance-schedule`
Expected: PASS (8 tests).

- [ ] **Step 5: Typecheck + commit**

Run: `npx tsc --noEmit` (clean), then:

```bash
git add lib/admin/balance-schedule.ts lib/admin/__tests__/balance-schedule.test.ts
git commit -m "feat(balance-schedule): dueSlots + runScheduledCheck (UTC-day guard)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 5: In-process tick (`instrumentation.ts`)

**Files:**
- Create: `instrumentation.ts` (repo root)
- Modify: `.env.example`

**Interfaces:**
- Consumes: `runScheduledCheck` (`@/lib/admin/balance-schedule`, Task 4).
- Produces: `export async function register(): Promise<void>` (Next.js startup hook).

**Note:** Next 15.1 picks up a root `instrumentation.ts` automatically — no `next.config.mjs` change needed. No unit test (it's a process-lifecycle hook); verified by typecheck + the suite staying green (the file is not imported by tests) + a manual boot check.

- [ ] **Step 1: Create the file**

Create `instrumentation.ts`:

```typescript
// Next.js instrumentation hook (runs once at server startup). Starts the
// in-process low-balance ticker in the nodejs runtime only. Each tick is cheap
// (reads app_settings + the clock); it hits fal.ai only when a configured slot
// is due. Errors are logged, never thrown.

export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;

  const g = globalThis as typeof globalThis & { __falBalanceTick?: ReturnType<typeof setInterval> };
  if (g.__falBalanceTick) return; // guard against double-registration (dev/HMR)

  const { runScheduledCheck } = await import("@/lib/admin/balance-schedule");
  const seconds = Number(process.env.FAL_BALANCE_TICK_SECONDS) || 30;

  g.__falBalanceTick = setInterval(() => {
    runScheduledCheck().catch((e) => console.error("[balance-tick]", e));
  }, seconds * 1000);
}
```

- [ ] **Step 2: Document the env var**

In `.env.example`, right after the `FAL_BALANCE_SLACK_WEBHOOK=` line (added in Task 2), add:

```
# Seconds between balance-check ticks (the tick only calls fal.ai when a
# configured check time is due). Default 30.
FAL_BALANCE_TICK_SECONDS=30
```

- [ ] **Step 3: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 4: Run the full suite (no regressions)**

Run: `npm test`
Expected: PASS (all suites — instrumentation.ts is not imported by any test).

- [ ] **Step 5: Commit**

```bash
git add instrumentation.ts .env.example
git commit -m "feat(instrumentation): in-process low-balance check ticker

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 6: Admin config route (`app/api/admin/balance-config/route.ts`)

**Files:**
- Create: `app/api/admin/balance-config/route.ts`
- Test: `app/api/admin/balance-config/__tests__/route.test.ts`

**Interfaces:**
- Consumes: `getDb`/`getAppSetting`/`setAppSetting` (`@/lib/history-db`), `getCurrentUser`, `SESSION_COOKIE_NAME`.
- Produces: `GET(req): NextResponse` → `{ threshold: number|null, checkTimesUtc: string[] }`; `PUT(req): NextResponse` accepting `{ threshold: number|null, checkTimesUtc: string[] }`.

- [ ] **Step 1: Write the failing test**

Create `app/api/admin/balance-config/__tests__/route.test.ts`:

```typescript
import { describe, it, expect, vi, afterEach } from "vitest";

afterEach(() => {
  vi.resetModules();
  vi.restoreAllMocks();
});

const fakeReq = (body?: unknown) =>
  ({ cookies: { get: () => ({ value: "sid" }) }, json: async () => body ?? {} } as never);

function mockDb() {
  const store: Record<string, string> = {};
  vi.doMock("@/lib/history-db", () => ({
    getDb: () => ({}),
    getAppSetting: (k: string) => store[k] ?? null,
    setAppSetting: (k: string, v: string) => { store[k] = v; },
  }));
  return store;
}

describe("GET /api/admin/balance-config", () => {
  it("401 when not authenticated", async () => {
    mockDb();
    vi.doMock("@/lib/auth/current-user", () => ({ getCurrentUser: () => null }));
    const { GET } = await import("@/app/api/admin/balance-config/route");
    expect((await GET(fakeReq())).status).toBe(401);
  });

  it("403 when not admin", async () => {
    mockDb();
    vi.doMock("@/lib/auth/current-user", () => ({ getCurrentUser: () => ({ role: "user" }) }));
    const { GET } = await import("@/app/api/admin/balance-config/route");
    expect((await GET(fakeReq())).status).toBe(403);
  });

  it("returns stored threshold + times for admin", async () => {
    const store = mockDb();
    store.falBalanceThreshold = "10";
    store.falBalanceCheckTimes = JSON.stringify(["09:00"]);
    vi.doMock("@/lib/auth/current-user", () => ({ getCurrentUser: () => ({ role: "admin" }) }));
    const { GET } = await import("@/app/api/admin/balance-config/route");
    const res = await GET(fakeReq());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ threshold: 10, checkTimesUtc: ["09:00"] });
  });
});

describe("PUT /api/admin/balance-config", () => {
  it("403 for non-admin", async () => {
    mockDb();
    vi.doMock("@/lib/auth/current-user", () => ({ getCurrentUser: () => ({ role: "user" }) }));
    const { PUT } = await import("@/app/api/admin/balance-config/route");
    expect((await PUT(fakeReq({ threshold: 10, checkTimesUtc: [] }))).status).toBe(403);
  });

  it("400 on bad time string", async () => {
    mockDb();
    vi.doMock("@/lib/auth/current-user", () => ({ getCurrentUser: () => ({ role: "admin" }) }));
    const { PUT } = await import("@/app/api/admin/balance-config/route");
    expect((await PUT(fakeReq({ threshold: 10, checkTimesUtc: ["9am"] }))).status).toBe(400);
  });

  it("400 on negative threshold", async () => {
    mockDb();
    vi.doMock("@/lib/auth/current-user", () => ({ getCurrentUser: () => ({ role: "admin" }) }));
    const { PUT } = await import("@/app/api/admin/balance-config/route");
    expect((await PUT(fakeReq({ threshold: -1, checkTimesUtc: [] }))).status).toBe(400);
  });

  it("persists valid config and returns 200", async () => {
    const store = mockDb();
    vi.doMock("@/lib/auth/current-user", () => ({ getCurrentUser: () => ({ role: "admin" }) }));
    const { PUT } = await import("@/app/api/admin/balance-config/route");
    const res = await PUT(fakeReq({ threshold: 15, checkTimesUtc: ["05:00", "17:30"] }));
    expect(res.status).toBe(200);
    expect(store.falBalanceThreshold).toBe("15");
    expect(JSON.parse(store.falBalanceCheckTimes)).toEqual(["05:00", "17:30"]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- balance-config`
Expected: FAIL — cannot resolve `@/app/api/admin/balance-config/route`.

- [ ] **Step 3: Write the route**

Create `app/api/admin/balance-config/route.ts`:

```typescript
import { type NextRequest, NextResponse } from "next/server";
import { getDb, getAppSetting, setAppSetting } from "@/lib/history-db";
import { getCurrentUser } from "@/lib/auth/current-user";
import { SESSION_COOKIE_NAME } from "@/lib/auth/cookie-name";

export const runtime = "nodejs";

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

function guard(req: NextRequest): NextResponse | null {
  const user = getCurrentUser(getDb(), req.cookies.get(SESSION_COOKIE_NAME)?.value ?? null);
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (user.role !== "admin") return NextResponse.json({ error: "forbidden" }, { status: 403 });
  return null;
}

export async function GET(req: NextRequest) {
  const denied = guard(req);
  if (denied) return denied;

  const raw = getAppSetting("falBalanceThreshold");
  const n = raw == null || raw.trim() === "" ? null : Number(raw);
  const threshold = typeof n === "number" && Number.isFinite(n) ? n : null;

  let checkTimesUtc: string[] = [];
  try {
    const p = JSON.parse(getAppSetting("falBalanceCheckTimes") ?? "[]");
    if (Array.isArray(p)) checkTimesUtc = p.filter((x) => typeof x === "string");
  } catch {
    // malformed → empty
  }
  return NextResponse.json({ threshold, checkTimesUtc });
}

export async function PUT(req: NextRequest) {
  const denied = guard(req);
  if (denied) return denied;

  const body = (await req.json().catch(() => ({}))) as {
    threshold?: unknown;
    checkTimesUtc?: unknown;
  };
  const { threshold, checkTimesUtc } = body;

  if (
    threshold !== null &&
    (typeof threshold !== "number" || !Number.isFinite(threshold) || threshold < 0)
  ) {
    return NextResponse.json({ error: "threshold must be a number >= 0 or null" }, { status: 400 });
  }
  if (
    !Array.isArray(checkTimesUtc) ||
    !checkTimesUtc.every((t) => typeof t === "string" && HHMM.test(t))
  ) {
    return NextResponse.json({ error: "checkTimesUtc must be an array of HH:MM strings" }, { status: 400 });
  }

  setAppSetting("falBalanceThreshold", threshold === null ? "" : String(threshold));
  setAppSetting("falBalanceCheckTimes", JSON.stringify(checkTimesUtc));
  return NextResponse.json({ ok: true, threshold, checkTimesUtc });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- balance-config`
Expected: PASS (7 tests).

- [ ] **Step 5: Typecheck + commit**

Run: `npx tsc --noEmit` (clean), then:

```bash
git add app/api/admin/balance-config/route.ts app/api/admin/balance-config/__tests__/route.test.ts
git commit -m "feat(admin-api): GET/PUT /api/admin/balance-config (threshold + UTC times)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 7: Config UI (`components/admin/fal-balance-alert-config.tsx`) + wiring

**Files:**
- Create: `components/admin/fal-balance-alert-config.tsx`
- Modify: `components/admin-panel.tsx` (render the config card in `SettingsContent`)

**Interfaces:**
- Consumes: `GET`/`PUT /api/admin/balance-config` (Task 6); `utcTimeToLocal`/`localTimeToUtc`/`tzLabel` (`@/lib/time/tz`, Task 1).
- Produces: `export function FalBalanceAlertConfig(): JSX.Element`.

**Note:** UI glue — no unit test harness here (consistent with the existing admin cards). Verify via `npx tsc --noEmit` + full suite. Logic it depends on (tz conversion, route validation) is already unit-tested in Tasks 1 and 6.

- [ ] **Step 1: Create the component**

Create `components/admin/fal-balance-alert-config.tsx`:

```tsx
"use client";

import * as React from "react";
import { Plus, X, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { utcTimeToLocal, localTimeToUtc, tzLabel } from "@/lib/time/tz";

export function FalBalanceAlertConfig() {
  const [threshold, setThreshold] = React.useState<string>("");
  const [localTimes, setLocalTimes] = React.useState<string[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [saving, setSaving] = React.useState(false);

  React.useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const r = await fetch("/api/admin/balance-config", { cache: "no-store" });
        if (!r.ok) return;
        const d = (await r.json()) as { threshold: number | null; checkTimesUtc: string[] };
        if (cancelled) return;
        setThreshold(d.threshold === null ? "" : String(d.threshold));
        setLocalTimes(d.checkTimesUtc.map(utcTimeToLocal));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const addRow = () => setLocalTimes((t) => [...t, "09:00"]);
  const removeRow = (i: number) => setLocalTimes((t) => t.filter((_, idx) => idx !== i));
  const setRow = (i: number, v: string) =>
    setLocalTimes((t) => t.map((x, idx) => (idx === i ? v : x)));

  const save = async () => {
    setSaving(true);
    try {
      const thr = threshold.trim() === "" ? null : Number(threshold);
      const checkTimesUtc = localTimes.filter(Boolean).map(localTimeToUtc);
      const r = await fetch("/api/admin/balance-config", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ threshold: thr, checkTimesUtc }),
      });
      if (r.ok) toast.success("Настройки оповещения сохранены");
      else {
        const b = await r.json().catch(() => ({}));
        toast.error(`Ошибка: ${b?.error ?? r.status}`);
      }
    } catch {
      toast.error("Сетевая ошибка при сохранении");
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className="rounded-xl border border-border bg-background shadow-sm">
      <div className="border-b border-border px-5 py-4">
        <h2 className="text-base font-semibold">Оповещение о низком балансе</h2>
        <p className="mt-1 text-xs text-muted-foreground">
          Slack-уведомление, когда баланс ниже порога. Проверки идут в заданные
          времена ({tzLabel()}). Пусто = выключено.
        </p>
      </div>
      <div className="p-5">
        {loading ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" /> Загрузка...
          </div>
        ) : (
          <div className="space-y-4">
            <label className="block text-sm">
              <span className="text-muted-foreground">Порог (USD)</span>
              <input
                type="number"
                min={0}
                step="0.01"
                value={threshold}
                onChange={(e) => setThreshold(e.target.value)}
                placeholder="напр. 10"
                className="mt-1 block w-40 rounded-md border border-border bg-background px-2 py-1 text-sm"
              />
            </label>

            <div className="space-y-2">
              <span className="text-sm text-muted-foreground">Времена проверок ({tzLabel()})</span>
              {localTimes.map((t, i) => (
                <div key={i} className="flex items-center gap-2">
                  <input
                    type="time"
                    value={t}
                    onChange={(e) => setRow(i, e.target.value)}
                    className="rounded-md border border-border bg-background px-2 py-1 text-sm"
                  />
                  <button
                    type="button"
                    onClick={() => removeRow(i)}
                    aria-label="Удалить время"
                    className="inline-flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground hover:bg-muted/60"
                  >
                    <X className="h-4 w-4" />
                  </button>
                </div>
              ))}
              <button
                type="button"
                onClick={addRow}
                className="inline-flex items-center gap-1 rounded-md border border-border px-2 py-1 text-xs text-muted-foreground hover:bg-muted/60"
              >
                <Plus className="h-3.5 w-3.5" /> Добавить время
              </button>
            </div>

            <button
              type="button"
              onClick={() => void save()}
              disabled={saving}
              className="inline-flex h-9 items-center rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground disabled:opacity-50"
            >
              {saving ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
              Сохранить
            </button>
          </div>
        )}
      </div>
    </section>
  );
}
```

- [ ] **Step 2: Wire it into the Settings tab**

In `components/admin-panel.tsx`:

a) Add the import next to the existing `FalBalanceCard` import (line 20):

```tsx
import { FalBalanceAlertConfig } from "@/components/admin/fal-balance-alert-config";
```

b) In `SettingsContent`, the return currently wraps `<FalBalanceCard />` and the provider `<section>` in `<div className="space-y-6">`. Add `<FalBalanceAlertConfig />` immediately after `<FalBalanceCard />`:

```tsx
      <div className="space-y-6">
        <FalBalanceCard />
        <FalBalanceAlertConfig />
        <section className="rounded-xl border border-border bg-background shadow-sm">
          {/* ...existing provider-list section unchanged... */}
        </section>
      </div>
```

- [ ] **Step 3: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 4: Run the full suite (no regressions)**

Run: `npm test`
Expected: PASS (all suites).

- [ ] **Step 5: Commit**

```bash
git add components/admin/fal-balance-alert-config.tsx components/admin-panel.tsx
git commit -m "feat(admin-ui): low-balance alert config (threshold + local times)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Operator setup (post-merge, manual)

1. Put the Slack incoming webhook URL in prod `.env.local` as
   `FAL_BALANCE_SLACK_WEBHOOK=https://hooks.slack.com/services/...` (already
   created + verified).
2. `docker compose up -d --build wavespeed-claude`.
3. Admin → Settings → "Оповещение о низком балансе": set a threshold and add
   check times (entered in your local time, stored UTC automatically).
4. Verify: temporarily set threshold above current balance and a check time
   ~1–2 minutes out; confirm one Slack message; confirm no repeat while still
   low; raise threshold below balance to re-arm.

---

## Self-Review

**Spec coverage:**
- Slack webhook channel → Task 2 (`sendSlackAlert`, `.env.example`).
- In-process scheduler at configured times → Task 4 (`dueSlots`/`runScheduledCheck`) + Task 5 (`instrumentation.ts` tick).
- UTC storage + browser-local conversion → Task 1 (`tz.ts`) + Task 7 (UI uses it).
- Edge-triggered + re-arm → Task 3 (`decideAlert`/`checkBalanceAndAlert`).
- Threshold + times in admin UI, stored in `app_settings` → Task 6 (route) + Task 7 (UI). app_settings keys match the spec verbatim.
- Error handling (webhook unset/network, balance not ok, malformed JSON) → Tasks 2, 3, 4.
- No schema change → only `app_settings` used.
- Out of scope (email, per-employee spend, alert-on-read-failure, manual button) → not in any task.

**Placeholder scan:** none — every code step has full code.

**Type consistency:** `app_settings` keys (`falBalanceThreshold`, `falBalanceCheckTimes`, `falBalanceAlerted`, `falBalanceLastRun`) identical across Tasks 3, 4, 6. `decideAlert`/`checkBalanceAndAlert` (Task 3) consumed by Task 4 with matching signatures. `dueSlots`/`runScheduledCheck` (Task 4) consumed by Task 5. `tz` helpers (Task 1) consumed by Task 7. Route shape `{ threshold: number|null, checkTimesUtc: string[] }` identical between Task 6 (route) and Task 7 (client fetch). Slack message uses the `ok` result's `balance`/`currency` fields, matching `getFalBalance`'s contract.
