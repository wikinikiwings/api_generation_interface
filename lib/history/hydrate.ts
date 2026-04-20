"use client";

import { applyServerList, useHistoryStore } from "@/lib/history/store";
import { debugHistory } from "@/lib/history/debug";
import type { ServerGeneration, DateRange } from "@/lib/history/types";

export interface HydrateOpts {
  username: string;
  range?: DateRange;
  offset?: number;
  limit?: number;
}

const HYDRATE_DEBOUNCE_MS = 50;
const PAGE_SIZE_DEFAULT = 20;

// Each in-flight fetch is keyed by its serialized opts so simultaneous
// callers with DIFFERENT ranges (e.g. OutputArea's today-range + Sidebar's
// 7-day range + SSE's no-range reconnect hydrate) each get their own
// request instead of collapsing into the first caller's opts. Same-opts
// callers still dedupe to one fetch.
const pendingByKey = new Map<string, Promise<number>>();
const timersByKey = new Map<string, ReturnType<typeof setTimeout>>();
// Monotonic counter per key: if a newer same-key call arrives while an
// older one is in flight, the older response is discarded on return.
const reqIdByKey = new Map<string, number>();

function optsKey(opts: HydrateOpts): string {
  return JSON.stringify({
    u: opts.username,
    f: opts.range?.from ? new Date(opts.range.from).setHours(0, 0, 0, 0) : null,
    t: opts.range?.to ? new Date(opts.range.to).setHours(23, 59, 59, 999) : null,
    o: opts.offset ?? 0,
    l: opts.limit ?? PAGE_SIZE_DEFAULT,
  });
}

function buildUrl(opts: HydrateOpts): string {
  const sp = new URLSearchParams();
  sp.set("username", opts.username);
  if (opts.range?.from) {
    const d = new Date(opts.range.from);
    d.setHours(0, 0, 0, 0);
    sp.set("startDate", d.toISOString());
  }
  if (opts.range?.to) {
    const d = new Date(opts.range.to);
    d.setHours(23, 59, 59, 999);
    sp.set("endDate", d.toISOString());
  }
  sp.set("limit", String(opts.limit ?? PAGE_SIZE_DEFAULT));
  sp.set("offset", String(opts.offset ?? 0));
  return `/api/history?${sp.toString()}`;
}

/**
 * The single entry point for /api/history GET. Internal-only; consumers
 * call refetch() on the hook (which routes here) or trigger via
 * username/range change. SSE open also calls this on (re)connect.
 *
 * Resolves with the number of rows returned by the server (0 on error or
 * when the response is discarded by the stale-request guard). Hooks use
 * this count to decide `hasMore` — a full page means there may be more.
 *
 * Race-guards:
 * - pendingByKey: same-opts callers share one Promise (no duplicate fetch).
 *   Different-opts callers each get their own request.
 * - reqIdByKey: if a newer same-key call supersedes an older one, the
 *   older response is discarded.
 * - HYDRATE_DEBOUNCE_MS: rapid same-key storms collapse to one fetch.
 */
export function hydrateFromServer(opts: HydrateOpts): Promise<number> {
  const key = optsKey(opts);
  const existing = pendingByKey.get(key);
  if (existing) return existing;

  const p = new Promise<number>((resolve) => {
    const timer = setTimeout(async () => {
      const myReq = (reqIdByKey.get(key) ?? 0) + 1;
      reqIdByKey.set(key, myReq);
      timersByKey.delete(key);
      let rowCount = 0;
      try {
        const res = await fetch(buildUrl(opts), { cache: "no-store" });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const rows = (await res.json()) as ServerGeneration[];
        if (myReq !== reqIdByKey.get(key)) return;
        applyServerList(rows, {
          offset: opts.offset ?? 0,
          rangeFrom: opts.range?.from ? new Date(opts.range.from).setHours(0, 0, 0, 0) : undefined,
          rangeTo: opts.range?.to ? new Date(opts.range.to).setHours(23, 59, 59, 999) : undefined,
        });
        rowCount = rows.length;
        debugHistory("hydrate.ok", { count: rows.length, reqId: myReq });
      } catch (e) {
        if (myReq !== reqIdByKey.get(key)) return;
        useHistoryStore.setState({ error: String(e) });
        debugHistory("hydrate.error", { message: String(e) });
      } finally {
        pendingByKey.delete(key);
        resolve(rowCount);
      }
    }, HYDRATE_DEBOUNCE_MS);
    timersByKey.set(key, timer);
  });
  pendingByKey.set(key, p);
  return p;
}

/**
 * Test-only: reset internal state.
 * - keepReqId=true (default): preserves reqId counters so stale-discard
 *   semantics survive a mid-test "fresh hydration window" reset.
 * - keepReqId=false: full reset; use in beforeEach for test isolation.
 */
export function _resetHydrateForTest(opts: { keepReqId?: boolean } = {}): void {
  if (!opts.keepReqId) reqIdByKey.clear();
  pendingByKey.clear();
  for (const t of timersByKey.values()) clearTimeout(t);
  timersByKey.clear();
}
