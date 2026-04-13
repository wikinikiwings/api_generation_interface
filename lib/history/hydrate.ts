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

let activeReqId = 0;
let pendingHydrate: Promise<void> | null = null;
let debounceTimer: ReturnType<typeof setTimeout> | null = null;

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
 * Race-guards:
 * - activeReqId: stale responses from earlier requests are discarded.
 * - pendingHydrate: concurrent callers share one Promise (no duplicate fetch).
 * - HYDRATE_DEBOUNCE_MS: rapid storms collapse to one fetch.
 */
export function hydrateFromServer(opts: HydrateOpts): Promise<void> {
  if (pendingHydrate) return pendingHydrate;

  pendingHydrate = new Promise((resolve) => {
    debounceTimer = setTimeout(async () => {
      const myReq = ++activeReqId;
      debounceTimer = null;
      try {
        const res = await fetch(buildUrl(opts), { cache: "no-store" });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const rows = (await res.json()) as ServerGeneration[];
        if (myReq !== activeReqId) return;
        applyServerList(rows, { offset: opts.offset ?? 0 });
        debugHistory("hydrate.ok", { count: rows.length, reqId: myReq });
      } catch (e) {
        if (myReq !== activeReqId) return;
        useHistoryStore.setState({ error: String(e) });
        debugHistory("hydrate.error", { message: String(e) });
      } finally {
        pendingHydrate = null;
        resolve();
      }
    }, HYDRATE_DEBOUNCE_MS);
  });
  return pendingHydrate;
}

/**
 * Test-only: reset internal state.
 * - keepReqId=true (default): preserves activeReqId so stale-discard
 *   semantics survive a mid-test "fresh hydration window" reset.
 * - keepReqId=false: full reset; use in beforeEach for test isolation.
 */
export function _resetHydrateForTest(opts: { keepReqId?: boolean } = {}): void {
  if (!opts.keepReqId) activeReqId = 0;
  pendingHydrate = null;
  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = null;
}
