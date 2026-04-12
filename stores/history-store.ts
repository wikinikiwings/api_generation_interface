"use client";

import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";
import type { HistoryEntry, TaskStatus } from "@/types/wavespeed";

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
    (set) => ({
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

      remove: (id) =>
        set((state) => {
          const victim = state.entries.find((e) => e.id === id);
          if (victim) revokeLocalBlobUrls([victim]);
          return {
            entries: state.entries.filter((e) => e.id !== id),
          };
        }),

      clear: () =>
        set((state) => {
          revokeLocalBlobUrls(state.entries);
          return { entries: [] };
        }),
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
