"use client";

import * as React from "react";
import { useHistory } from "@/hooks/use-history";
import { genToHistoryEntry } from "@/lib/server-gen-adapter";
import type { HistoryEntry } from "@/types/wavespeed";

interface UseHistorySiblingsParams {
  username: string | null;
  startDate?: Date;
  endDate?: Date;
}

export interface UseHistorySiblingsResult {
  /** Reactive, uuid-keyed, viewable-only, desc-by-createdAt. */
  siblings: HistoryEntry[];
  /** Pass-through from useHistory — triggers next-page fetch. */
  loadMore: () => void;
  /** Pass-through — true while more server rows exist to fetch. */
  hasMore: boolean;
  /** Pass-through — true while loadMore / refetch is in flight. */
  loading: boolean;
}

/**
 * Sibling-navigation view over `useHistory()`.
 *
 * - Converts each viewable ServerGeneration (server or pending) into a
 *   HistoryEntry via `genToHistoryEntry`.
 * - Drops entries that are not currently displayable (pending without a
 *   ready blob, server rows with no image output). These are skipped
 *   for navigation so users don't land on a blank slide.
 * - Keeps the same desc-by-createdAt sort the sidebar already renders.
 * - Exposes `loadMore` / `hasMore` / `loading` so the consumer can wire
 *   prefetch-on-approach without re-entering `useHistory`.
 */
export function useHistorySiblings(
  params: UseHistorySiblingsParams
): UseHistorySiblingsResult {
  const { items, hasMore, isLoading, isLoadingMore, loadMore } = useHistory(params);

  const siblings = React.useMemo<HistoryEntry[]>(() => {
    const mapped: HistoryEntry[] = [];
    for (const gen of items) {
      const entry = genToHistoryEntry(gen);
      if (entry) mapped.push(entry);
    }
    // Items from useHistory are already pending-first, then desc by
    // createdAt among server rows. Re-sort explicitly so a pending
    // row with a slightly newer timestamp than a server row (or vice
    // versa) still lines up correctly with the rendered sidebar.
    mapped.sort((a, b) => b.createdAt - a.createdAt);
    return mapped;
  }, [items]);

  return {
    siblings,
    loadMore: () => void loadMore(),
    hasMore,
    loading: isLoading || isLoadingMore,
  };
}
