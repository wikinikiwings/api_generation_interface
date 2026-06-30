# Multiple Slack Webhooks for Low-Balance Alert — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let admins configure multiple per-person Slack webhooks (label + URL) in the admin UI; the low-balance alert broadcasts to all of them.

**Architecture:** Webhooks live in `app_settings` as a JSON list of `{id,label,url}`, managed by a server-only `lib/admin/balance-webhooks.ts` (add/remove/resolve, write-only/masked reads). `sendSlackAlert` becomes `(text, url)`; `checkBalanceAndAlert` resolves all target URLs and broadcasts. A dedicated admin route does GET(masked)/POST(add)/DELETE(remove). The env `FAL_BALANCE_SLACK_WEBHOOK` remains a fallback when the list is empty. No DB schema change.

**Tech Stack:** Next.js 15.1 (route handlers), TypeScript, React, Vitest, better-sqlite3 (`app_settings`), lucide-react.

## Global Constraints

- Test runner: `npm test` (= `vitest run`); focused: `npm test -- <pattern>`. `@/` → repo root.
- Webhook URLs are secrets: NEVER returned to the client. Reads are masked (`label + …last6`). Manage via add/remove, not whole-list PUT.
- `app_settings` key (exact): `falBalanceWebhooks` = JSON array of `{ id: string; label: string; url: string }`.
- A webhook URL must start with `https://hooks.slack.com/`; label non-empty (≤ 80 chars). Invalid → 400, nothing persisted.
- `resolveTargets()`: list URLs if non-empty; else fallback to `[process.env.FAL_BALANCE_SLACK_WEBHOOK]` when set; else `[]`.
- Alert broadcasts to ALL targets; `checkBalanceAndAlert` returns `{ status, sent }` where `sent` is the delivered COUNT (number).
- Admin guard (route): `getCurrentUser(getDb(), req.cookies.get(SESSION_COOKIE_NAME)?.value ?? null)` → 401 no user, 403 non-admin (sync; same as `app/api/admin/models/route.ts`).
- Commit messages end with: `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`
- Work on branch `feat/multi-webhook` (already created; the spec commit is its first commit).

---

### Task 1: Webhook store (`lib/admin/balance-webhooks.ts`)

**Files:**
- Create: `lib/admin/balance-webhooks.ts`
- Test: `lib/admin/__tests__/balance-webhooks.test.ts`

**Interfaces:**
- Consumes: `getAppSetting`/`setAppSetting` (`@/lib/history-db`); `node:crypto` `randomUUID`.
- Produces:
  - `interface Webhook { id: string; label: string; url: string }`
  - `interface MaskedWebhook { id: string; label: string; urlMask: string }`
  - `maskUrl(url: string): string`
  - `listWebhooksMasked(): MaskedWebhook[]`
  - `addWebhook(input: { label: string; url: string }): { id: string }`
  - `removeWebhook(id: string): void`
  - `resolveTargets(): string[]`

- [ ] **Step 1: Write the failing test**

Create `lib/admin/__tests__/balance-webhooks.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const store: Record<string, string | null> = {};
vi.mock("@/lib/history-db", () => ({
  getAppSetting: (k: string) => store[k] ?? null,
  setAppSetting: (k: string, v: string) => { store[k] = v; },
}));

import {
  maskUrl, listWebhooksMasked, addWebhook, removeWebhook, resolveTargets,
} from "@/lib/admin/balance-webhooks";

beforeEach(() => { for (const k of Object.keys(store)) delete store[k]; });
afterEach(() => { vi.unstubAllEnvs(); });

describe("maskUrl", () => {
  it("shows only the last 6 chars", () => {
    expect(maskUrl("https://hooks.slack.com/services/A/B/abcdef123456")).toBe("…123456");
  });
});

describe("addWebhook / listWebhooksMasked / removeWebhook", () => {
  it("adds a valid webhook and lists it masked (never the full url)", () => {
    const { id } = addWebhook({ label: "Маша", url: "https://hooks.slack.com/services/A/B/secret99" });
    expect(typeof id).toBe("string");
    const list = listWebhooksMasked();
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ id, label: "Маша", urlMask: "…ecret99".slice(-7) });
    expect(JSON.stringify(list)).not.toContain("hooks.slack.com");
  });

  it("rejects a non-Slack url", () => {
    expect(() => addWebhook({ label: "x", url: "https://evil.example/abc" })).toThrow();
    expect(listWebhooksMasked()).toHaveLength(0);
  });

  it("rejects an empty label", () => {
    expect(() => addWebhook({ label: "  ", url: "https://hooks.slack.com/services/A/B/c" })).toThrow();
  });

  it("removes by id", () => {
    const { id } = addWebhook({ label: "a", url: "https://hooks.slack.com/services/A/B/c" });
    addWebhook({ label: "b", url: "https://hooks.slack.com/services/A/B/d" });
    removeWebhook(id);
    const list = listWebhooksMasked();
    expect(list).toHaveLength(1);
    expect(list[0].label).toBe("b");
  });

  it("tolerates malformed stored JSON (treats as empty)", () => {
    store.falBalanceWebhooks = "not-json";
    expect(listWebhooksMasked()).toEqual([]);
  });
});

describe("resolveTargets", () => {
  it("returns configured urls when the list is non-empty", () => {
    addWebhook({ label: "a", url: "https://hooks.slack.com/services/A/B/c" });
    addWebhook({ label: "b", url: "https://hooks.slack.com/services/A/B/d" });
    expect(resolveTargets()).toEqual([
      "https://hooks.slack.com/services/A/B/c",
      "https://hooks.slack.com/services/A/B/d",
    ]);
  });

  it("falls back to the env webhook when the list is empty", () => {
    vi.stubEnv("FAL_BALANCE_SLACK_WEBHOOK", "https://hooks.slack.com/services/ENV");
    expect(resolveTargets()).toEqual(["https://hooks.slack.com/services/ENV"]);
  });

  it("returns [] when list empty and env unset", () => {
    vi.stubEnv("FAL_BALANCE_SLACK_WEBHOOK", "");
    expect(resolveTargets()).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- balance-webhooks`
Expected: FAIL — cannot resolve `@/lib/admin/balance-webhooks`.

- [ ] **Step 3: Write the implementation**

Create `lib/admin/balance-webhooks.ts`:

```typescript
// Server-only. Stores the per-person Slack webhooks for the low-balance alert
// in app_settings (key falBalanceWebhooks). URLs are secrets: reads are masked,
// the full URL never leaves the server except as an outbound POST.

import { getAppSetting, setAppSetting } from "@/lib/history-db";
import { randomUUID } from "node:crypto";

export interface Webhook {
  id: string;
  label: string;
  url: string;
}
export interface MaskedWebhook {
  id: string;
  label: string;
  urlMask: string;
}

const KEY = "falBalanceWebhooks";
const SLACK_PREFIX = "https://hooks.slack.com/";
const LABEL_MAX = 80;

export function maskUrl(url: string): string {
  return `…${url.slice(-6)}`;
}

function parse(): Webhook[] {
  const raw = getAppSetting(KEY);
  if (!raw) return [];
  try {
    const a = JSON.parse(raw);
    if (!Array.isArray(a)) return [];
    return a.filter(
      (x): x is Webhook =>
        !!x &&
        typeof x === "object" &&
        typeof (x as Webhook).id === "string" &&
        typeof (x as Webhook).label === "string" &&
        typeof (x as Webhook).url === "string"
    );
  } catch {
    return [];
  }
}

function persist(list: Webhook[]): void {
  setAppSetting(KEY, JSON.stringify(list));
}

export function listWebhooksMasked(): MaskedWebhook[] {
  return parse().map((w) => ({ id: w.id, label: w.label, urlMask: maskUrl(w.url) }));
}

export function addWebhook(input: { label: string; url: string }): { id: string } {
  const label = (input.label ?? "").trim();
  const url = (input.url ?? "").trim();
  if (!label) throw new Error("label is required");
  if (label.length > LABEL_MAX) throw new Error(`label must be <= ${LABEL_MAX} chars`);
  if (!url.startsWith(SLACK_PREFIX)) {
    throw new Error("url must be a Slack incoming webhook (https://hooks.slack.com/...)");
  }
  const list = parse();
  const id = randomUUID();
  list.push({ id, label, url });
  persist(list);
  return { id };
}

export function removeWebhook(id: string): void {
  persist(parse().filter((w) => w.id !== id));
}

export function resolveTargets(): string[] {
  const list = parse();
  if (list.length > 0) return list.map((w) => w.url);
  const env = process.env.FAL_BALANCE_SLACK_WEBHOOK;
  return env ? [env] : [];
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- balance-webhooks`
Expected: PASS (9 tests).

- [ ] **Step 5: Typecheck + commit**

Run: `npx tsc --noEmit` (clean), then:

```bash
git add lib/admin/balance-webhooks.ts lib/admin/__tests__/balance-webhooks.test.ts
git commit -m "feat(balance-webhooks): app_settings store for per-person Slack webhooks

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 2: Broadcast send path (`slack.ts` signature + `balance-alert` fan-out)

**Files:**
- Modify: `lib/notify/slack.ts`
- Modify: `lib/notify/__tests__/slack.test.ts`
- Modify: `lib/admin/balance-alert.ts`
- Modify: `lib/admin/__tests__/balance-alert.test.ts`

**Interfaces:**
- Consumes: `resolveTargets()` from `@/lib/admin/balance-webhooks` (Task 1).
- Produces: `sendSlackAlert(text: string, url: string): Promise<boolean>`; `checkBalanceAndAlert(): Promise<{ status: string; sent?: number }>`.

This task couples together because changing `sendSlackAlert`'s signature breaks its only caller (`checkBalanceAndAlert`); both move in one commit so typecheck stays green.

- [ ] **Step 1: Update the slack test to the new `(text, url)` signature**

Replace the body of `lib/notify/__tests__/slack.test.ts` with:

```typescript
import { describe, it, expect, vi, afterEach } from "vitest";
import { sendSlackAlert } from "@/lib/notify/slack";

afterEach(() => {
  vi.restoreAllMocks();
});

const URL = "https://hooks.slack.com/services/X";

describe("sendSlackAlert", () => {
  it("returns false and does not fetch when url is empty", async () => {
    const spy = vi.spyOn(globalThis, "fetch");
    expect(await sendSlackAlert("hi", "")).toBe(false);
    expect(spy).not.toHaveBeenCalled();
  });

  it("posts {text} as JSON to the given url and returns true on 200", async () => {
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("ok", { status: 200 }));
    expect(await sendSlackAlert("привет ✅", URL)).toBe(true);
    const [url, init] = spy.mock.calls[0];
    expect(String(url)).toBe(URL);
    expect((init as RequestInit).method).toBe("POST");
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({ text: "привет ✅" });
  });

  it("returns false on non-ok", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("bad", { status: 500 }));
    expect(await sendSlackAlert("x", URL)).toBe(false);
  });

  it("returns false when fetch throws", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("down"));
    expect(await sendSlackAlert("x", URL)).toBe(false);
  });
});
```

- [ ] **Step 2: Run it — RED**

Run: `npm test -- "notify/__tests__/slack"`
Expected: FAIL — current `sendSlackAlert` ignores the 2nd arg and reads env (the empty-url and given-url assertions fail).

- [ ] **Step 3: Change `sendSlackAlert` to take an explicit url**

Replace `lib/notify/slack.ts` with:

```typescript
// Server-only. Posts a plain-text message to a given Slack incoming webhook
// URL. Falsy url → no-op. Never throws. (Callers resolve which url(s) to use.)

export async function sendSlackAlert(text: string, url: string): Promise<boolean> {
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

- [ ] **Step 4: Run the slack test — GREEN**

Run: `npm test -- "notify/__tests__/slack"`
Expected: PASS (4 tests).

- [ ] **Step 5: Update the balance-alert test for broadcast + count**

In `lib/admin/__tests__/balance-alert.test.ts`: (a) add a `resolveTargets` mock, (b) change the send-path expectations from `sent: true/false` (boolean) to a delivered count, (c) add a multi-target broadcast case. Add this mock alongside the existing `vi.mock` calls (with the others, before the import of balance-alert):

```typescript
const resolveTargets = vi.fn();
vi.mock("@/lib/admin/balance-webhooks", () => ({ resolveTargets: () => resolveTargets() }));
```

In the test's `beforeEach`, default it to one target:

```typescript
  resolveTargets.mockReset().mockReturnValue(["https://hooks.slack.com/services/A"]);
```

Then update the `checkBalanceAndAlert` cases so the assertions read:
- "sends ... when below ...": `expect(r).toEqual({ status: "ok", sent: 1 });` (one target, send resolves true).
- "suppresses while still low": `expect(r).toEqual({ status: "ok", sent: 0 });`
- "re-arms after recovery": unchanged except it asserts `sendSlackAlert` not called and `falBalanceAlerted === "false"` (no `sent` assertion needed).

Add a new broadcast test:

```typescript
it("broadcasts to every resolved target and counts deliveries", async () => {
  settings.falBalanceThreshold = "10";
  resolveTargets.mockReturnValue([
    "https://hooks.slack.com/services/A",
    "https://hooks.slack.com/services/B",
  ]);
  getFalBalance.mockResolvedValue({ status: "ok", balance: 4, currency: "USD", username: "t" });
  const r = await checkBalanceAndAlert();
  expect(sendSlackAlert).toHaveBeenCalledTimes(2);
  expect(r).toEqual({ status: "ok", sent: 2 });
});
```

(The existing `vi.mock("@/lib/notify/slack", ...)` already wraps `sendSlackAlert` as a `vi.fn()` resolving `true`; keep it.)

- [ ] **Step 6: Run it — RED**

Run: `npm test -- balance-alert`
Expected: FAIL — `checkBalanceAndAlert` still calls `sendSlackAlert(text)` once and returns a boolean `sent`.

- [ ] **Step 7: Change `checkBalanceAndAlert` to broadcast**

In `lib/admin/balance-alert.ts`:

a) Add the import near the others:

```typescript
import { resolveTargets } from "@/lib/admin/balance-webhooks";
```

b) Change the return type and the send block. Replace the function's signature and send section so it reads:

```typescript
export async function checkBalanceAndAlert(): Promise<{ status: string; sent?: number }> {
  const raw = getAppSetting("falBalanceThreshold");
  const threshold = raw == null || raw.trim() === "" ? NaN : Number(raw);
  if (!Number.isFinite(threshold)) return { status: "no_threshold" };

  const bal = await getFalBalance();
  if (bal.status !== "ok") return { status: `balance_${bal.status}` };

  const alreadyAlerted = getAppSetting("falBalanceAlerted") === "true";
  const { shouldSend, nextAlerted } = decideAlert({ balance: bal.balance, threshold, alreadyAlerted });

  let sent = 0;
  if (shouldSend) {
    const text = `⚠️ fal.ai: баланс низкий — ${bal.balance.toFixed(2)} ${bal.currency} (порог ${threshold}). Пополнить: https://fal.ai/dashboard`;
    const urls = resolveTargets();
    const results = await Promise.all(urls.map((u) => sendSlackAlert(text, u)));
    sent = results.filter(Boolean).length;
  }
  setAppSetting("falBalanceAlerted", nextAlerted ? "true" : "false");
  return { status: "ok", sent };
}
```

(`decideAlert` is unchanged.)

- [ ] **Step 8: Run tests — GREEN**

Run: `npm test -- balance-alert` then `npm test -- "notify/__tests__/slack"`
Expected: PASS.

- [ ] **Step 9: Typecheck, full suite, commit**

Run: `npx tsc --noEmit` (clean) and `npm test` (all green), then:

```bash
git add lib/notify/slack.ts lib/notify/__tests__/slack.test.ts lib/admin/balance-alert.ts lib/admin/__tests__/balance-alert.test.ts
git commit -m "feat(balance-alert): broadcast to all resolved webhooks; sendSlackAlert(text,url)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 3: Admin webhooks route (`app/api/admin/balance-webhooks/route.ts`)

**Files:**
- Create: `app/api/admin/balance-webhooks/route.ts`
- Test: `app/api/admin/balance-webhooks/__tests__/route.test.ts`

**Interfaces:**
- Consumes: `getDb` (`@/lib/history-db`), `getCurrentUser`, `SESSION_COOKIE_NAME`, and `listWebhooksMasked`/`addWebhook`/`removeWebhook` (`@/lib/admin/balance-webhooks`, Task 1).
- Produces: `GET`/`POST`/`DELETE` at `/api/admin/balance-webhooks`.

- [ ] **Step 1: Write the failing test**

Create `app/api/admin/balance-webhooks/__tests__/route.test.ts`:

```typescript
import { describe, it, expect, vi, afterEach } from "vitest";

afterEach(() => {
  vi.resetModules();
  vi.restoreAllMocks();
});

const fakeReq = (body?: unknown) =>
  ({ cookies: { get: () => ({ value: "sid" }) }, json: async () => body ?? {} } as never);

function mocks(opts: { role?: string | null } = {}) {
  vi.doMock("@/lib/history-db", () => ({ getDb: () => ({}) }));
  vi.doMock("@/lib/auth/current-user", () => ({
    getCurrentUser: () => (opts.role === undefined ? { role: "admin" } : opts.role === null ? null : { role: opts.role }),
  }));
  const addWebhook = vi.fn(() => ({ id: "id-1" }));
  const removeWebhook = vi.fn();
  const listWebhooksMasked = vi.fn(() => [{ id: "id-1", label: "Маша", urlMask: "…123456" }]);
  vi.doMock("@/lib/admin/balance-webhooks", () => ({ addWebhook, removeWebhook, listWebhooksMasked }));
  return { addWebhook, removeWebhook, listWebhooksMasked };
}

describe("/api/admin/balance-webhooks", () => {
  it("GET 401 when unauthenticated", async () => {
    mocks({ role: null });
    const { GET } = await import("@/app/api/admin/balance-webhooks/route");
    expect((await GET(fakeReq())).status).toBe(401);
  });

  it("GET 403 for non-admin", async () => {
    mocks({ role: "user" });
    const { GET } = await import("@/app/api/admin/balance-webhooks/route");
    expect((await GET(fakeReq())).status).toBe(403);
  });

  it("GET returns masked webhooks (no full url) for admin", async () => {
    mocks();
    const { GET } = await import("@/app/api/admin/balance-webhooks/route");
    const res = await GET(fakeReq());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ webhooks: [{ id: "id-1", label: "Маша", urlMask: "…123456" }] });
    expect(JSON.stringify(body)).not.toContain("hooks.slack.com");
  });

  it("POST adds a valid webhook → ok + id", async () => {
    const m = mocks();
    const { POST } = await import("@/app/api/admin/balance-webhooks/route");
    const res = await POST(fakeReq({ label: "Маша", url: "https://hooks.slack.com/services/A/B/c" }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, id: "id-1" });
    expect(m.addWebhook).toHaveBeenCalledWith({ label: "Маша", url: "https://hooks.slack.com/services/A/B/c" });
  });

  it("POST 400 when addWebhook rejects (bad url)", async () => {
    const m = mocks();
    m.addWebhook.mockImplementation(() => { throw new Error("url must be a Slack incoming webhook"); });
    const { POST } = await import("@/app/api/admin/balance-webhooks/route");
    const res = await POST(fakeReq({ label: "x", url: "https://evil/abc" }));
    expect(res.status).toBe(400);
  });

  it("DELETE removes by id → ok", async () => {
    const m = mocks();
    const { DELETE } = await import("@/app/api/admin/balance-webhooks/route");
    const res = await DELETE(fakeReq({ id: "id-1" }));
    expect(res.status).toBe(200);
    expect(m.removeWebhook).toHaveBeenCalledWith("id-1");
  });

  it("DELETE 400 when id missing", async () => {
    mocks();
    const { DELETE } = await import("@/app/api/admin/balance-webhooks/route");
    expect((await DELETE(fakeReq({}))).status).toBe(400);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- balance-webhooks/__tests__/route`
Expected: FAIL — cannot resolve `@/app/api/admin/balance-webhooks/route`.

- [ ] **Step 3: Write the route**

Create `app/api/admin/balance-webhooks/route.ts`:

```typescript
import { type NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/history-db";
import { getCurrentUser } from "@/lib/auth/current-user";
import { SESSION_COOKIE_NAME } from "@/lib/auth/cookie-name";
import { listWebhooksMasked, addWebhook, removeWebhook } from "@/lib/admin/balance-webhooks";

export const runtime = "nodejs";

function guard(req: NextRequest): NextResponse | null {
  const user = getCurrentUser(getDb(), req.cookies.get(SESSION_COOKIE_NAME)?.value ?? null);
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (user.role !== "admin") return NextResponse.json({ error: "forbidden" }, { status: 403 });
  return null;
}

export async function GET(req: NextRequest) {
  const denied = guard(req);
  if (denied) return denied;
  return NextResponse.json({ webhooks: listWebhooksMasked() });
}

export async function POST(req: NextRequest) {
  const denied = guard(req);
  if (denied) return denied;
  const body = (await req.json().catch(() => ({}))) as { label?: unknown; url?: unknown };
  const label = typeof body.label === "string" ? body.label : "";
  const url = typeof body.url === "string" ? body.url : "";
  try {
    const { id } = addWebhook({ label, url });
    return NextResponse.json({ ok: true, id });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "invalid" }, { status: 400 });
  }
}

export async function DELETE(req: NextRequest) {
  const denied = guard(req);
  if (denied) return denied;
  const body = (await req.json().catch(() => ({}))) as { id?: unknown };
  if (typeof body.id !== "string" || !body.id) {
    return NextResponse.json({ error: "id required" }, { status: 400 });
  }
  removeWebhook(body.id);
  return NextResponse.json({ ok: true });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- balance-webhooks/__tests__/route`
Expected: PASS (7 tests).

- [ ] **Step 5: Typecheck + commit**

Run: `npx tsc --noEmit` (clean), then:

```bash
git add app/api/admin/balance-webhooks/route.ts app/api/admin/balance-webhooks/__tests__/route.test.ts
git commit -m "feat(admin-api): GET/POST/DELETE /api/admin/balance-webhooks (masked)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 4: Recipients UI (`fal-balance-alert-config.tsx`)

**Files:**
- Modify: `components/admin/fal-balance-alert-config.tsx`

**Interfaces:**
- Consumes: `GET`/`POST`/`DELETE /api/admin/balance-webhooks` (Task 3) — `GET` → `{ webhooks: { id, label, urlMask }[] }`.
- Produces: a "Получатели уведомления" sub-section in the existing config card.

**Note:** UI glue — no unit test harness (consistent with the other admin cards). Verify via `npx tsc --noEmit` + full `npm test`.

- [ ] **Step 1: Replace the component with the version that adds the recipients section**

Replace the entire contents of `components/admin/fal-balance-alert-config.tsx` with:

```tsx
"use client";

import * as React from "react";
import { Plus, X, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { utcTimeToLocal, localTimeToUtc, tzLabel } from "@/lib/time/tz";

interface MaskedWebhook { id: string; label: string; urlMask: string }

export function FalBalanceAlertConfig() {
  const [threshold, setThreshold] = React.useState<string>("");
  const [localTimes, setLocalTimes] = React.useState<string[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [saving, setSaving] = React.useState(false);

  const [webhooks, setWebhooks] = React.useState<MaskedWebhook[]>([]);
  const [newLabel, setNewLabel] = React.useState("");
  const [newUrl, setNewUrl] = React.useState("");
  const [adding, setAdding] = React.useState(false);

  const loadWebhooks = React.useCallback(async () => {
    const r = await fetch("/api/admin/balance-webhooks", { cache: "no-store" });
    if (!r.ok) return;
    const d = (await r.json()) as { webhooks: MaskedWebhook[] };
    setWebhooks(d.webhooks);
  }, []);

  React.useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const r = await fetch("/api/admin/balance-config", { cache: "no-store" });
        if (r.ok) {
          const d = (await r.json()) as { threshold: number | null; checkTimesUtc: string[] };
          if (!cancelled) {
            setThreshold(d.threshold === null ? "" : String(d.threshold));
            setLocalTimes(d.checkTimesUtc.map(utcTimeToLocal));
          }
        }
        await loadWebhooks();
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [loadWebhooks]);

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

  const addWebhook = async () => {
    setAdding(true);
    try {
      const r = await fetch("/api/admin/balance-webhooks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ label: newLabel.trim(), url: newUrl.trim() }),
      });
      if (r.ok) {
        setNewLabel("");
        setNewUrl("");
        await loadWebhooks();
        toast.success("Получатель добавлен");
      } else {
        const b = await r.json().catch(() => ({}));
        toast.error(`Ошибка: ${b?.error ?? r.status}`);
      }
    } catch {
      toast.error("Сетевая ошибка при добавлении");
    } finally {
      setAdding(false);
    }
  };

  const deleteWebhook = async (id: string) => {
    try {
      const r = await fetch("/api/admin/balance-webhooks", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id }),
      });
      if (r.ok) await loadWebhooks();
      else toast.error("Не удалось удалить получателя");
    } catch {
      toast.error("Сетевая ошибка при удалении");
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

            <div className="space-y-2 border-t border-border pt-4">
              <span className="text-sm text-muted-foreground">
                Получатели уведомления (Slack, по одному на человека)
              </span>
              {webhooks.length === 0 ? (
                <p className="text-xs text-muted-foreground">
                  Пока нет получателей — используется webhook из .env (если задан).
                </p>
              ) : (
                webhooks.map((w) => (
                  <div key={w.id} className="flex items-center gap-2 text-sm">
                    <span className="font-medium">{w.label}</span>
                    <span className="text-xs text-muted-foreground">{w.urlMask}</span>
                    <button
                      type="button"
                      onClick={() => void deleteWebhook(w.id)}
                      aria-label="Удалить получателя"
                      className="inline-flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground hover:bg-muted/60"
                    >
                      <X className="h-4 w-4" />
                    </button>
                  </div>
                ))
              )}
              <div className="flex flex-wrap items-center gap-2 pt-1">
                <input
                  type="text"
                  value={newLabel}
                  onChange={(e) => setNewLabel(e.target.value)}
                  placeholder="Имя"
                  className="w-32 rounded-md border border-border bg-background px-2 py-1 text-sm"
                />
                <input
                  type="text"
                  value={newUrl}
                  onChange={(e) => setNewUrl(e.target.value)}
                  placeholder="https://hooks.slack.com/services/..."
                  className="w-72 rounded-md border border-border bg-background px-2 py-1 text-sm"
                />
                <button
                  type="button"
                  onClick={() => void addWebhook()}
                  disabled={adding || !newLabel.trim() || !newUrl.trim()}
                  className="inline-flex items-center gap-1 rounded-md border border-border px-2 py-1 text-xs text-muted-foreground hover:bg-muted/60 disabled:opacity-50"
                >
                  {adding ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Plus className="h-3.5 w-3.5" />}
                  Добавить
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </section>
  );
}
```

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 3: Run the full suite (no regressions)**

Run: `npm test`
Expected: PASS (all suites).

- [ ] **Step 4: Commit**

```bash
git add components/admin/fal-balance-alert-config.tsx
git commit -m "feat(admin-ui): manage per-person Slack webhooks (add/remove, masked)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Operator note

No new env required. Existing `FAL_BALANCE_SLACK_WEBHOOK` stays as the fallback when the admin list is empty. After deploy: admin → Settings → "Получатели уведомления" → add each person's label + webhook URL. Once ≥1 is added, the env fallback is no longer used; removing all reverts to it.

## Self-Review

**Spec coverage:**
- `app_settings.falBalanceWebhooks` `{id,label,url}` model → Task 1.
- maskUrl / listWebhooksMasked / addWebhook (validation) / removeWebhook / resolveTargets (env fallback) → Task 1.
- `sendSlackAlert(text,url)` + broadcast-to-all + delivered count → Task 2.
- Dedicated route GET(masked)/POST(add,400)/DELETE(remove), admin-guarded → Task 3.
- Recipients UI (masked list + add form, label+url) → Task 4.
- Write-only secrets (full URL never to client) → Task 1 (`listWebhooksMasked`), Task 3 (GET returns masked; test asserts no `hooks.slack.com` in body), Task 4 (renders `urlMask`).
- Env fallback / backward compat → Task 1 `resolveTargets`.
- No schema change → only `app_settings`.
- Out of scope (per-webhook routing, in-place edit, email, per-employee spend) → not in any task.

**Placeholder scan:** none — every code step carries full code.

**Type consistency:** `Webhook`/`MaskedWebhook` shapes and `{id,label,url}` / `{id,label,urlMask}` are identical across Task 1 (lib), Task 3 (route returns `{webhooks: MaskedWebhook[]}`), and Task 4 (client `MaskedWebhook`). `resolveTargets(): string[]` (Task 1) consumed by Task 2. `sendSlackAlert(text,url)` (Task 2) signature matches its test and caller. `checkBalanceAndAlert` return `sent` is a number consistently in Task 2 code + tests. The `app_settings` key `falBalanceWebhooks` matches between lib and tests.
