"use client";

import * as React from "react";
import { useHistoryStore } from "@/lib/history/store";
import { hydrateFromServer } from "@/lib/history/hydrate";
import type { HistoryEntry, DateRange } from "@/lib/history/types";

const PAGE_SIZE = 20;

interface UseHistoryEntriesOpts {
  username: string | null;
  range?: DateRange;
  excludeDeleting?: boolean;
}

/**
 * Main consumer hook. Subscribes to the store, triggers mount/dependency
 * hydration, and filters the unified entries list. REMOVED is always
 * filtered out; DELETING is rendered by default (for animation), opt out
 * via excludeDeleting=true.
 *
 * refetch() is a programmatic escape-hatch — NOT for UI buttons.
 * Project-wide UX principle: sync is invisible.
 */
export function useHistoryEntries(opts: UseHistoryEntriesOpts): {
  entries: HistoryEntry[];
  isLoading: boolean;
  isLoadingMore: boolean;
  hasMore: boolean;
  loadMore: () => void;
  error: string | null;
  refetch: () => void;
} {
  const { username, range, excludeDeleting } = opts;
  const allEntries = useHistoryStore((s) => s.entries);
  const error = useHistoryStore((s) => s.error);

  const [isLoading, setIsLoading] = React.useState(false);
  const [isLoadingMore, setIsLoadingMore] = React.useState(false);
  const [hasMore, setHasMore] = React.useState(false);
  const offsetRef = React.useRef(0);

  // Stable keys for range so useEffect doesn't re-fire on identity change.
  const rangeFromKey = range?.from?.getTime();
  const rangeToKey = range?.to?.getTime();

  React.useEffect(() => {
    if (!username) return;
    setIsLoading(true);
    offsetRef.current = 0;
    void hydrateFromServer({ username, range }).finally(() => {
      setIsLoading(false);
      // hasMore is approximate; refined by loadMore based on returned page size.
      setHasMore(false);
    });
  }, [username, rangeFromKey, rangeToKey, range]);

  const refetch = React.useCallback(() => {
    if (!username) return;
    void hydrateFromServer({ username, range });
  }, [username, range]);

  const loadMore = React.useCallback(() => {
    if (!username || isLoadingMore) return;
    setIsLoadingMore(true);
    offsetRef.current += PAGE_SIZE;
    void hydrateFromServer({
      username,
      range,
      offset: offsetRef.current,
    }).finally(() => setIsLoadingMore(false));
  }, [username, range, isLoadingMore]);

  const entries = React.useMemo(() => {
    return allEntries
      .filter((e) => {
        if (e.state === "removed") return false;
        if (excludeDeleting && e.state === "deleting") return false;
        if (range?.from && e.createdAt < range.from.getTime()) return false;
        if (range?.to && e.createdAt > range.to.getTime()) return false;
        return true;
      })
      .sort((a, b) => b.createdAt - a.createdAt);
  }, [allEntries, rangeFromKey, rangeToKey, excludeDeleting, range]);

  return {
    entries,
    isLoading,
    isLoadingMore,
    hasMore,
    loadMore,
    error,
    refetch,
  };
}

export function useEntryById(id: string): HistoryEntry | undefined {
  return useHistoryStore((s) => s.entries.find((e) => e.id === id));
}
