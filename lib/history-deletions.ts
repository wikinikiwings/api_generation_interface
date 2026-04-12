/**
 * Tiny cross-component registry for "recently deleted server generation
 * IDs". Lets a delete triggered in one surface (e.g. Output strip) hide
 * the matching row in another surface (e.g. History sidebar) instantly,
 * without waiting for the server refetch + re-render round-trip.
 *
 * Backed by Zustand — the app's existing subscription primitive — so
 * the re-render story is identical to every other store in the codebase.
 *
 * The registry is additive: IDs stay in the set for the lifetime of the
 * session and never get evicted. Safe because server IDs are
 * monotonically increasing and never reused. On full reload the store
 * resets, which is also fine — the deleted row is gone from the server
 * too, so a refetch won't surface it.
 */

"use client";

import { create } from "zustand";

interface DeletionsState {
  ids: ReadonlySet<number>;
}

const useDeletionsStore = create<DeletionsState>(() => ({
  ids: new Set<number>(),
}));

/** Mark a server generation id as deleted. Idempotent. */
export function markGenerationDeleted(id: number): void {
  const current = useDeletionsStore.getState().ids;
  if (current.has(id)) return;
  const next = new Set(current);
  next.add(id);
  useDeletionsStore.setState({ ids: next });
}

/** Sync snapshot — for reading outside a React render context. */
export function getDeletedIds(): ReadonlySet<number> {
  return useDeletionsStore.getState().ids;
}

/**
 * React hook: returns the current set of locally-deleted generation IDs.
 * Re-renders the caller whenever the set grows.
 */
export function useDeletedIds(): ReadonlySet<number> {
  return useDeletionsStore((s) => s.ids);
}
