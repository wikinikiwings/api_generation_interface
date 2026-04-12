"use client";

import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";
import type { HistoryEntry, TaskStatus } from "@/types/wavespeed";

/**
 * Idempotent: safe to call for the same URL multiple times. The store
 * invokes this on remove/clear; pending-history.ts (Task 5) also
 * revokes its own blob URLs on confirmPending. Because ownership of a
 * blob URL can be shared between the two registries during the Output
 * panel → pending-sidebar transition, both paths may fire for the same
 * URL. The try/catch is intentional — do not remove.
 */
function revokeLocalBlobUrls(entries: HistoryEntry[]): void {
  if (typeof window === "undefined") return;
  for (const e of entries) {
    if (!e.localBlobUrls) continue;
    for (const u of e.localBlobUrls) {
      try {
        URL.revokeObjectURL(u);
      } catch {
        // Already revoked or never registered — ignore.
      }
    }
  }
}

interface HistoryState {
  entries: HistoryEntry[];
  add: (entry: HistoryEntry) => void;
  update: (id: string, patch: Partial<HistoryEntry>) => void;
  remove: (id: string) => void;
  clear: () => void;
  setStatus: (
    id: string,
    status: TaskStatus,
    outputUrl?: string,
    error?: string | null
  ) => void;
}

const MAX_ENTRIES = 100;

export const useHistoryStore = create<HistoryState>()(
  persist(
    (set, get) => ({
      entries: [],

      add: (entry) =>
        set((state) => {
          const next = [entry, ...state.entries];
          return { entries: next.slice(0, MAX_ENTRIES) };
        }),

      update: (id, patch) =>
        set((state) => ({
          entries: state.entries.map((e) =>
            e.id === id ? { ...e, ...patch } : e
          ),
        })),

      setStatus: (id, status, outputUrl, error) =>
        set((state) => ({
          entries: state.entries.map((e) =>
            e.id === id ? { ...e, status, outputUrl, error: error ?? null } : e
          ),
        })),

      remove: (id) => {
        const victim = get().entries.find((e) => e.id === id);
        set((state) => ({
          entries: state.entries.filter((e) => e.id !== id),
        }));
        if (victim) revokeLocalBlobUrls([victim]);
      },

      clear: () => {
        const victims = get().entries;
        set({ entries: [] });
        revokeLocalBlobUrls(victims);
      },
    }),
    {
      name: "wavespeed-history",
      storage: createJSONStorage(() => localStorage),
      version: 3,
      partialize: (state) => ({
        // Drop optimistic-only entries: their blob URLs won't survive
        // reload. Entries without `confirmed` (legacy v1–v3 rows) are
        // treated as confirmed for back-compat.
        entries: state.entries.filter((e) => e.confirmed !== false),
      }),
      merge: (persistedState, currentState) => {
        // Cross-tab rehydrate path: preserve any in-flight optimistic
        // entries (confirmed: false) that only exist in this tab's
        // memory and were deliberately excluded from localStorage by
        // partialize. Without this, tab A writing localStorage would
        // wipe tab B's in-progress uploads.
        const persisted = persistedState as Partial<HistoryState> | undefined;
        const persistedEntries = persisted?.entries ?? [];
        const unconfirmed = currentState.entries.filter(
          (e) => e.confirmed === false
        );
        if (unconfirmed.length === 0) {
          return {
            ...currentState,
            ...(persisted ?? {}),
            entries: persistedEntries,
          };
        }
        const unconfirmedIds = new Set(unconfirmed.map((e) => e.id));
        return {
          ...currentState,
          ...(persisted ?? {}),
          entries: [
            ...unconfirmed,
            ...persistedEntries.filter((e) => !unconfirmedIds.has(e.id)),
          ],
        };
      },
      // v1 entries didn't have a `provider` field. Backfill it as "wavespeed"
      // since WaveSpeed was the only provider in v1.
      // v2 -> v3: added optional `serverGenId`. No backfill needed — existing
      // entries stay undefined; only newly-created entries get linked to the
      // server history DB row id.
      migrate: (persistedState: unknown, fromVersion: number) => {
        if (fromVersion < 2) {
          const state = persistedState as { entries?: Partial<HistoryEntry>[] };
          return {
            entries: (state.entries ?? []).map((e) => ({
              ...e,
              provider: (e as { provider?: string }).provider ?? "wavespeed",
            })),
          };
        }
        return persistedState as HistoryState;
      },
    }
  )
);

// Cross-tab sync. The store is already persisted to localStorage under
// `wavespeed-history`, so when tab A writes (add/update/remove), localStorage
// gets the new value and tab B's window receives a `storage` event. Zustand's
// `persist` middleware doesn't auto-rehydrate on that event, so we wire it up
// explicitly. Result: history changes propagate to all open tabs without any
// network round-trip or BroadcastChannel.
//
// Guarded by `typeof window` for SSR safety. Runs once at module load —
// the listener is process-lifetime so we never need to remove it. The
// rehydrate() call is a no-op when storage didn't actually change for our key.
if (typeof window !== "undefined") {
  window.addEventListener("storage", (e) => {
    if (e.key === "wavespeed-history" && e.newValue !== e.oldValue) {
      void useHistoryStore.persist.rehydrate();
    }
  });
}
