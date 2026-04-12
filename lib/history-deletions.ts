/**
 * Tiny cross-component registry for "recently deleted server generation
 * IDs". Lets a delete triggered in one surface (e.g. Output strip) hide
 * the matching row in another surface (e.g. History sidebar) instantly,
 * without waiting for the server refetch + re-render round-trip.
 *
 * The registry is additive — IDs stay in the set forever within a
 * session. Safe because server IDs are monotonically increasing and
 * never reused. On full reload the set resets, which is also fine: the
 * deleted row is gone from the server too, so refetch won't surface it.
 */

import * as React from "react";

let deletedIds: ReadonlySet<number> = new Set<number>();
const listeners = new Set<() => void>();

function notify(): void {
  for (const l of listeners) l();
}

/** Mark a server generation id as deleted. Idempotent. */
export function markGenerationDeleted(id: number): void {
  if (deletedIds.has(id)) return;
  const next = new Set(deletedIds);
  next.add(id);
  deletedIds = next;
  notify();
}

/** Sync snapshot. Used by the React hook + ad-hoc filtering. */
export function getDeletedIds(): ReadonlySet<number> {
  return deletedIds;
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

/**
 * React hook: returns the current set of locally-deleted generation IDs.
 * Re-renders the caller whenever the set grows.
 */
export function useDeletedIds(): ReadonlySet<number> {
  return React.useSyncExternalStore(subscribe, getDeletedIds, getDeletedIds);
}
