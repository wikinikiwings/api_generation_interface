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
    // Cancellation guard: if range changes while a hydrate is in flight,
    // the stale `.then` is skipped so it can't clobber fresh hasMore.
    let cancelled = false;
    setIsLoading(true);
    offsetRef.current = 0;
    void hydrateFromServer({ username, range }).then((count) => {
      if (cancelled) return;
      setIsLoading(false);
      setHasMore(count >= PAGE_SIZE);
    });
    return () => {
      cancelled = true;
    };
  }, [username, rangeFromKey, rangeToKey, range]);

  const refetch = React.useCallback(() => {
    if (!username) return;
    void hydrateFromServer({ username, range }).then((count) => {
      setHasMore(count >= PAGE_SIZE);
    });
  }, [username, range]);

  const loadMore = React.useCallback(() => {
    if (!username || isLoadingMore) return;
    setIsLoadingMore(true);
    offsetRef.current += PAGE_SIZE;
    void hydrateFromServer({
      username,
      range,
      offset: offsetRef.current,
    }).then((count) => {
      setIsLoadingMore(false);
      // If the server returned a full page, there may be older rows still.
      setHasMore(count >= PAGE_SIZE);
    });
  }, [username, range, isLoadingMore]);

  const entries = React.useMemo(() => {
    return allEntries
      .filter((e) => {
        if (e.state === "removed") return false;
        if (excludeDeleting && e.state === "deleting") return false;
        if (rangeFromKey != null && e.createdAt < rangeFromKey) return false;
        if (rangeToKey != null && e.createdAt > rangeToKey) return false;
        return true;
      })
      .sort((a, b) => b.createdAt - a.createdAt);
  }, [allEntries, rangeFromKey, rangeToKey, excludeDeleting]);

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
