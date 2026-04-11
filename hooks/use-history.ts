"use client";

import * as React from "react";

export interface ServerOutput {
  id: number;
  generation_id: number;
  filename: string;
  filepath: string;
  content_type: string;
  size: number;
}
export interface ServerGeneration {
  id: number;
  username: string;
  workflow_name: string;
  prompt_data: string;
  execution_time_seconds: number;
  created_at: string;
  status: string;
  outputs: ServerOutput[];
}

export const PAGE_SIZE = 20;
export const HISTORY_REFRESH_EVENT = "wavespeed:history-refresh";

// Cross-tab refresh signaling. The local CustomEvent above only reaches
// listeners in the same tab; when the user has the app open in two tabs and
// generates in tab A, tab B's server-history sidebar would otherwise miss
// the new row until manual refresh. BroadcastChannel ferries the signal
// across same-origin tabs without any server round-trip.
//
// Important: BroadcastChannel does NOT echo to the posting instance, so the
// sender doesn't double-fetch. Receivers re-dispatch the local CustomEvent
// (NOT broadcastHistoryRefresh) to avoid a ping-pong loop between tabs.
const historyChannel: BroadcastChannel | null =
  typeof window !== "undefined" && "BroadcastChannel" in window
    ? new BroadcastChannel("wavespeed:history")
    : null;

if (historyChannel) {
  historyChannel.addEventListener("message", () => {
    // Re-dispatch as a local window event so every mounted useHistory hook
    // in this tab refetches. Do NOT call broadcastHistoryRefresh here —
    // that would re-post to the channel and ping-pong forever.
    window.dispatchEvent(new Event(HISTORY_REFRESH_EVENT));
  });
}

/**
 * Trigger a history refresh in this tab AND every other open tab of the
 * same app. Use this instead of dispatching HISTORY_REFRESH_EVENT directly
 * whenever new server-history data should propagate cross-tab — e.g. after
 * POST /api/history, after delete, after rename.
 */
export function broadcastHistoryRefresh(): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new Event(HISTORY_REFRESH_EVENT));
  historyChannel?.postMessage({ t: Date.now() });
}

interface UseHistoryParams {
  username: string | null;
  startDate?: Date;
  endDate?: Date;
}

function buildUrl(p: UseHistoryParams, offset: number): string {
  const sp = new URLSearchParams();
  sp.set("username", p.username!);
  if (p.startDate) {
    const s = new Date(p.startDate);
    s.setHours(0, 0, 0, 0);
    sp.set("startDate", s.toISOString());
  }
  if (p.endDate) {
    const e = new Date(p.endDate);
    e.setHours(23, 59, 59, 999);
    sp.set("endDate", e.toISOString());
  }
  sp.set("limit", String(PAGE_SIZE));
  sp.set("offset", String(offset));
  return `/api/history?${sp.toString()}`;
}

export function useHistory(params: UseHistoryParams) {
  const { username, startDate, endDate } = params;
  const [items, setItems] = React.useState<ServerGeneration[]>([]);
  const [isLoading, setIsLoading] = React.useState(false);
  const [isLoadingMore, setIsLoadingMore] = React.useState(false);
  const [hasMore, setHasMore] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const reqIdRef = React.useRef(0);

  const fetchFirstPage = React.useCallback(async () => {
    if (!username) {
      setItems([]);
      setHasMore(false);
      return;
    }
    const myReq = ++reqIdRef.current;
    setIsLoading(true);
    setError(null);
    try {
      const res = await fetch(buildUrl({ username, startDate, endDate }, 0), {
        cache: "no-store",
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as ServerGeneration[];
      if (myReq !== reqIdRef.current) return;
      setItems(data);
      setHasMore(data.length >= PAGE_SIZE);
    } catch (e) {
      if (myReq !== reqIdRef.current) return;
      setError(e instanceof Error ? e.message : "Fetch failed");
    } finally {
      if (myReq === reqIdRef.current) setIsLoading(false);
    }
  }, [username, startDate, endDate]);

  const loadMore = React.useCallback(async () => {
    if (!username || isLoadingMore || !hasMore) return;
    setIsLoadingMore(true);
    try {
      const res = await fetch(
        buildUrl({ username, startDate, endDate }, items.length),
        { cache: "no-store" }
      );
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const more = (await res.json()) as ServerGeneration[];
      setItems((prev) => {
        const seen = new Set(prev.map((g) => g.id));
        return [...prev, ...more.filter((g) => !seen.has(g.id))];
      });
      setHasMore(more.length >= PAGE_SIZE);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Load more failed");
    } finally {
      setIsLoadingMore(false);
    }
  }, [username, startDate, endDate, items.length, isLoadingMore, hasMore]);

  React.useEffect(() => {
    void fetchFirstPage();
  }, [fetchFirstPage]);

  React.useEffect(() => {
    const handler = () => void fetchFirstPage();
    window.addEventListener(HISTORY_REFRESH_EVENT, handler);
    return () => window.removeEventListener(HISTORY_REFRESH_EVENT, handler);
  }, [fetchFirstPage]);

  return {
    items,
    hasMore,
    isLoading,
    isLoadingMore,
    error,
    loadMore,
    refetch: fetchFirstPage,
  };
}
