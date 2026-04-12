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

import { create, type UseBoundStore, type StoreApi } from "zustand";
import { debugHistory } from "@/lib/history-debug";

interface DeletionsState {
  ids: ReadonlySet<number>;
}

/**
 * HMR resilience: Next.js dev rebuilds this module on edit, which in a
 * naive `const useDeletionsStore = create(...)` pattern drops every
 * previously-marked deletion. The user then sees already-hidden rows
 * re-surface via refetch until they re-delete. Cache the store on
 * `globalThis` so the same instance survives module reloads.
 *
 * Only matters in dev. In prod there's no HMR; the global cache is a
 * no-op since the module is only evaluated once.
 */
type DeletionsStore = UseBoundStore<StoreApi<DeletionsState>>;
const globalKey = "__wavespeed_historyDeletionsStore" as const;
type Globals = { [globalKey]?: DeletionsStore };
const globals = globalThis as Globals;
const useDeletionsStore: DeletionsStore =
  globals[globalKey] ??
  (globals[globalKey] = create<DeletionsState>(() => ({
    ids: new Set<number>(),
  })));

/** Mark a server generation id as deleted. Idempotent. */
export function markGenerationDeleted(id: number): void {
  const current = useDeletionsStore.getState().ids;
  if (current.has(id)) {
    debugHistory("markDeleted.skip", { id, reason: "already-present" });
    return;
  }
  const next = new Set(current);
  next.add(id);
  useDeletionsStore.setState({ ids: next });
  debugHistory("markDeleted", { id, size: next.size });
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
