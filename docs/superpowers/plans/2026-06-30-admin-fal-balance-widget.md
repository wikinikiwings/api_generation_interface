# Admin fal.ai Balance Widget Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show the fal.ai account credit balance on the admin panel's Settings tab, fetched from fal's platform billing API with a dedicated admin key.

**Architecture:** A server-only `getFalBalance()` (in `lib/providers/fal-billing.ts`) reads `FAL_ADMIN_KEY` and calls `api.fal.ai/v1/account/billing`, mapping success/missing-key/forbidden/error into a discriminated union. A thin admin route exposes it; a client card renders the states with a manual refresh. No DB/schema changes.

**Tech Stack:** Next.js (app router, route handlers), TypeScript, React, Vitest, lucide-react icons.

## Global Constraints

- Test runner: `npm test` (= `vitest run`); focused: `npm test -- <pattern>`. The `@/` alias resolves to repo root.
- Auth/billing key is `FAL_ADMIN_KEY` (NOT the inference `FAL_KEY`). It is server-only and MUST never be returned to the client or logged.
- fal billing endpoint: `GET https://api.fal.ai/v1/account/billing?expand=credits`, header `Authorization: Key <FAL_ADMIN_KEY>`. Response: `{ "username": string, "credits": { "current_balance": number, "currency": string } }`.
- `not_configured` / `forbidden` / `error` are expected states returned with HTTP 200 in the route (carried in a `status` field), NOT HTTP error codes. The route only returns 401/403 for the admin guard itself.
- Admin guard pattern: `getCurrentUser(getDb(), req.cookies.get(SESSION_COOKIE_NAME)?.value ?? null)` → 401 if no user, 403 if `role !== "admin"` (same as `app/api/admin/models/route.ts`).
- Commit messages end with: `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`
- Work on branch `feat/admin-fal-balance` (already created; the spec commit is its first commit).

---

### Task 1: `getFalBalance()` server function + unit tests

**Files:**
- Create: `lib/providers/fal-billing.ts`
- Test: `lib/providers/__tests__/fal-billing.test.ts`

**Interfaces:**
- Consumes: nothing (reads `process.env.FAL_ADMIN_KEY`, calls global `fetch`).
- Produces:
  - `type FalBalanceResult = { status: "ok"; balance: number; currency: string; username: string } | { status: "not_configured" } | { status: "forbidden" } | { status: "error"; message: string }`
  - `export async function getFalBalance(): Promise<FalBalanceResult>`

- [ ] **Step 1: Write the failing tests**

Create `lib/providers/__tests__/fal-billing.test.ts`:

```typescript
import { describe, it, expect, vi, afterEach } from "vitest";
import { getFalBalance } from "@/lib/providers/fal-billing";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("getFalBalance", () => {
  it("not_configured when FAL_ADMIN_KEY is unset — performs no network call", async () => {
    vi.stubEnv("FAL_ADMIN_KEY", "");
    const spy = vi.spyOn(globalThis, "fetch");
    expect(await getFalBalance()).toEqual({ status: "not_configured" });
    expect(spy).not.toHaveBeenCalled();
  });

  it("ok: maps credits and sends Key auth + expand=credits", async () => {
    vi.stubEnv("FAL_ADMIN_KEY", "admin-tok");
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({ username: "team", credits: { current_balance: 24.5, currency: "USD" } }),
        { status: 200 }
      )
    );
    const r = await getFalBalance();
    expect(r).toEqual({ status: "ok", balance: 24.5, currency: "USD", username: "team" });
    const [url, init] = spy.mock.calls[0];
    expect(String(url)).toContain("expand=credits");
    expect((init as RequestInit).headers).toMatchObject({ Authorization: "Key admin-tok" });
  });

  it("forbidden on 403", async () => {
    vi.stubEnv("FAL_ADMIN_KEY", "admin-tok");
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("nope", { status: 403 }));
    expect(await getFalBalance()).toEqual({ status: "forbidden" });
  });

  it("error on non-ok status", async () => {
    vi.stubEnv("FAL_ADMIN_KEY", "admin-tok");
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("boom", { status: 500 }));
    const r = await getFalBalance();
    expect(r.status).toBe("error");
  });

  it("error when fetch throws", async () => {
    vi.stubEnv("FAL_ADMIN_KEY", "admin-tok");
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network down"));
    expect(await getFalBalance()).toMatchObject({ status: "error" });
  });

  it("error when the response shape is unexpected (missing credits)", async () => {
    vi.stubEnv("FAL_ADMIN_KEY", "admin-tok");
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ username: "team" }), { status: 200 })
    );
    expect(await getFalBalance()).toMatchObject({ status: "error" });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- fal-billing`
Expected: FAIL — cannot resolve module `@/lib/providers/fal-billing`.

- [ ] **Step 3: Write the implementation**

Create `lib/providers/fal-billing.ts`:

```typescript
// Server-only. fal.ai PLATFORM billing — account credit balance.
//
// Distinct from lib/providers/fal.ts (inference on fal.run): this hits
// api.fal.ai and uses an admin-scoped key (FAL_ADMIN_KEY), NEVER the
// inference FAL_KEY. The key is never returned to the caller or logged.

const BILLING_URL = "https://api.fal.ai/v1/account/billing?expand=credits";

export type FalBalanceResult =
  | { status: "ok"; balance: number; currency: string; username: string }
  | { status: "not_configured" }
  | { status: "forbidden" }
  | { status: "error"; message: string };

function getAdminKey(): string | null {
  const k = process.env.FAL_ADMIN_KEY;
  if (!k || k === "your-fal-admin-key-here") return null;
  return k;
}

export async function getFalBalance(): Promise<FalBalanceResult> {
  const key = getAdminKey();
  if (!key) return { status: "not_configured" };

  let res: Response;
  try {
    res = await fetch(BILLING_URL, {
      method: "GET",
      headers: { Authorization: `Key ${key}` },
      cache: "no-store",
    });
  } catch (err) {
    return { status: "error", message: err instanceof Error ? err.message : "network error" };
  }

  if (res.status === 401 || res.status === 403) return { status: "forbidden" };

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    return { status: "error", message: text || `HTTP ${res.status}` };
  }

  let body: { username?: unknown; credits?: { current_balance?: unknown; currency?: unknown } };
  try {
    body = (await res.json()) as typeof body;
  } catch {
    return { status: "error", message: "invalid JSON from fal billing API" };
  }

  const bal = body.credits?.current_balance;
  const cur = body.credits?.currency;
  const username = body.username;
  if (typeof bal !== "number" || typeof cur !== "string" || typeof username !== "string") {
    return { status: "error", message: "unexpected billing response shape" };
  }
  return { status: "ok", balance: bal, currency: cur, username };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- fal-billing`
Expected: PASS (6 tests).

- [ ] **Step 5: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add lib/providers/fal-billing.ts lib/providers/__tests__/fal-billing.test.ts
git commit -m "feat(fal-billing): getFalBalance reads account credits via admin key

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 2: Admin route `GET /api/admin/fal-balance`

**Files:**
- Create: `app/api/admin/fal-balance/route.ts`
- Test: `app/api/admin/fal-balance/__tests__/route.test.ts`

**Interfaces:**
- Consumes: `getFalBalance()` from `@/lib/providers/fal-billing` (Task 1); `getCurrentUser` from `@/lib/auth/current-user`; `SESSION_COOKIE_NAME` from `@/lib/auth/cookie-name`; `getDb` from `@/lib/history-db`.
- Produces: `export async function GET(req: NextRequest): Promise<NextResponse>` at route path `/api/admin/fal-balance`.

- [ ] **Step 1: Write the failing tests**

Create `app/api/admin/fal-balance/__tests__/route.test.ts`:

```typescript
import { describe, it, expect, vi, afterEach } from "vitest";

afterEach(() => {
  vi.resetModules();
  vi.restoreAllMocks();
});

const fakeReq = () => ({ cookies: { get: () => ({ value: "sid" }) } } as never);

describe("GET /api/admin/fal-balance", () => {
  it("401 when not authenticated", async () => {
    vi.doMock("@/lib/history-db", () => ({ getDb: () => ({}) }));
    vi.doMock("@/lib/auth/current-user", () => ({ getCurrentUser: () => null }));
    const { GET } = await import("@/app/api/admin/fal-balance/route");
    const res = await GET(fakeReq());
    expect(res.status).toBe(401);
  });

  it("403 when authenticated but not admin", async () => {
    vi.doMock("@/lib/history-db", () => ({ getDb: () => ({}) }));
    vi.doMock("@/lib/auth/current-user", () => ({
      getCurrentUser: () => ({ id: 1, email: "u@x.com", role: "user" }),
    }));
    const { GET } = await import("@/app/api/admin/fal-balance/route");
    const res = await GET(fakeReq());
    expect(res.status).toBe(403);
  });

  it("200 + delegates to getFalBalance for an admin", async () => {
    vi.doMock("@/lib/history-db", () => ({ getDb: () => ({}) }));
    vi.doMock("@/lib/auth/current-user", () => ({
      getCurrentUser: () => ({ id: 1, email: "a@x.com", role: "admin" }),
    }));
    vi.doMock("@/lib/providers/fal-billing", () => ({
      getFalBalance: async () => ({ status: "ok", balance: 10, currency: "USD", username: "t" }),
    }));
    const { GET } = await import("@/app/api/admin/fal-balance/route");
    const res = await GET(fakeReq());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok", balance: 10, currency: "USD", username: "t" });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- fal-balance/__tests__/route`
Expected: FAIL — cannot resolve module `@/app/api/admin/fal-balance/route`.

- [ ] **Step 3: Write the route**

Create `app/api/admin/fal-balance/route.ts`:

```typescript
import { type NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/history-db";
import { getCurrentUser } from "@/lib/auth/current-user";
import { SESSION_COOKIE_NAME } from "@/lib/auth/cookie-name";
import { getFalBalance } from "@/lib/providers/fal-billing";

export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  const user = getCurrentUser(getDb(), req.cookies.get(SESSION_COOKIE_NAME)?.value ?? null);
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (user.role !== "admin") return NextResponse.json({ error: "forbidden" }, { status: 403 });

  const result = await getFalBalance();
  return NextResponse.json(result);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- fal-balance/__tests__/route`
Expected: PASS (3 tests).

- [ ] **Step 5: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add app/api/admin/fal-balance/route.ts app/api/admin/fal-balance/__tests__/route.test.ts
git commit -m "feat(admin-api): GET /api/admin/fal-balance (admin-guarded balance)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 3: Balance card component + panel wiring + env example

**Files:**
- Create: `components/admin/fal-balance-card.tsx`
- Modify: `components/admin-panel.tsx` (import + render inside `SettingsContent`)
- Modify: `.env.example` (add `FAL_ADMIN_KEY`)

**Interfaces:**
- Consumes: the route `GET /api/admin/fal-balance` (Task 2) returning the `FalBalanceResult` JSON shape.
- Produces: `export function FalBalanceCard(): JSX.Element`.

- [ ] **Step 1: Create the card component**

Create `components/admin/fal-balance-card.tsx`:

```tsx
"use client";

import * as React from "react";
import { Loader2, RefreshCw } from "lucide-react";

type Balance =
  | { status: "ok"; balance: number; currency: string; username: string }
  | { status: "not_configured" }
  | { status: "forbidden" }
  | { status: "error"; message: string };

export function FalBalanceCard() {
  const [data, setData] = React.useState<Balance | null>(null);
  const [loading, setLoading] = React.useState(true);

  const refetch = React.useCallback(async () => {
    setLoading(true);
    try {
      const r = await fetch("/api/admin/fal-balance", { cache: "no-store" });
      setData((await r.json()) as Balance);
    } catch {
      setData({ status: "error", message: "network error" });
    } finally {
      setLoading(false);
    }
  }, []);

  React.useEffect(() => {
    void refetch();
  }, [refetch]);

  return (
    <section className="rounded-xl border border-border bg-background shadow-sm">
      <div className="flex items-center justify-between border-b border-border px-5 py-4">
        <div>
          <h2 className="text-base font-semibold">Баланс fal.ai</h2>
          <p className="mt-1 text-xs text-muted-foreground">
            Кредиты аккаунта fal.ai (читается admin-ключом FAL_ADMIN_KEY).
          </p>
        </div>
        <button
          type="button"
          onClick={() => void refetch()}
          disabled={loading}
          aria-label="Обновить баланс"
          className="inline-flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted/60 disabled:opacity-50"
        >
          <RefreshCw className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} />
        </button>
      </div>
      <div className="p-5">
        {loading && data === null ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" /> Загрузка...
          </div>
        ) : data?.status === "ok" ? (
          <div>
            <div className="text-2xl font-semibold">
              {data.balance.toFixed(2)} {data.currency}
            </div>
            <div className="mt-0.5 text-xs text-muted-foreground">{data.username}</div>
          </div>
        ) : data?.status === "not_configured" ? (
          <div className="text-sm text-amber-600 dark:text-amber-500">
            FAL_ADMIN_KEY не задан — добавь admin-ключ fal.ai в{" "}
            <code className="rounded bg-muted px-1 py-0.5 text-[11px]">.env.local</code> и
            перезапусти контейнер.
          </div>
        ) : data?.status === "forbidden" ? (
          <div className="text-sm text-amber-600 dark:text-amber-500">
            Ключ без прав на биллинг — нужен admin-scoped ключ fal.ai.
          </div>
        ) : (
          <div className="text-sm text-destructive">
            Ошибка: {data?.status === "error" ? data.message : "unknown"}
          </div>
        )}
      </div>
    </section>
  );
}
```

- [ ] **Step 2: Wire the card into the Settings tab**

In `components/admin-panel.tsx`:

a) Add the import alongside the other admin component imports (near line 16-19):

```tsx
import { FalBalanceCard } from "@/components/admin/fal-balance-card";
```

b) In `function SettingsContent()`, the body currently `return (<section ...>...</section>);`. Wrap the balance card and the existing provider section together. Change the `return (` ... `);` so it reads:

```tsx
    return (
      <div className="space-y-6">
        <FalBalanceCard />
        <section className="rounded-xl border border-border bg-background shadow-sm">
          {/* ...existing provider-list section body unchanged... */}
        </section>
      </div>
    );
```

Keep the entire existing `<section>...</section>` content exactly as-is; only wrap it in the `<div className="space-y-6">` with `<FalBalanceCard />` placed before it.

- [ ] **Step 3: Add the env var to `.env.example`**

In `.env.example`, immediately after the `FAL_KEY=your-fal-key-here` line (~line 12), add:

```
# Admin-scoped fal.ai key for the billing/balance widget in the admin panel.
# Separate from FAL_KEY (inference) — least privilege. Leave blank to hide.
FAL_ADMIN_KEY=your-fal-admin-key-here
```

- [ ] **Step 4: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 5: Run the full suite (no regressions)**

Run: `npm test`
Expected: PASS (all suites, including the new fal-billing + route tests).

- [ ] **Step 6: Commit**

```bash
git add components/admin/fal-balance-card.tsx components/admin-panel.tsx .env.example
git commit -m "feat(admin-ui): fal.ai balance card on the Settings tab

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Self-Review

**Spec coverage:**
- `getFalBalance()` server fn (not_configured/forbidden/error/ok, key never leaked) → Task 1.
- Dedicated `FAL_ADMIN_KEY` → Task 1 (`getAdminKey`), Task 3 (`.env.example`).
- Thin admin route, expected states as HTTP 200, guard 401/403 → Task 2.
- Card on Settings tab, fetch-on-mount + manual refresh, 4 explicit states → Task 3.
- Tests: unit (Task 1) + route guard/delegate (Task 2) + typecheck/full-suite (Task 3) → matches spec's testing section.
- Out of scope (other providers, spend history, caching/polling) → nothing in the plan adds them.

**Placeholder scan:** none — every code step carries full code.

**Type consistency:** `FalBalanceResult` union (Task 1) is mirrored exactly by the route delegate (Task 2) and the client `Balance` type (Task 3): same four `status` discriminants and the same `ok` fields (`balance: number`, `currency: string`, `username: string`). `getFalBalance` signature is identical where consumed. Env var name `FAL_ADMIN_KEY` and placeholder `your-fal-admin-key-here` match across Task 1 and Task 3.
