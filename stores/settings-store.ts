"use client";

import { create } from "zustand";
import type { ProviderId, ModelId } from "@/lib/providers/types";

const MODEL_LS_KEY = "wavespeed:selectedModel:v2";
function loadModel(): ModelId {
  if (typeof window === "undefined") return "nano-banana-pro";
  try {
    const v = window.localStorage.getItem(MODEL_LS_KEY);
    if (v === "nano-banana-pro" || v === "nano-banana-2" || v === "nano-banana") return v;
  } catch {}
  return "nano-banana-pro";
}

/**
 * App settings store — server-hydrated.
 *
 * Unlike a localStorage-persisted store, this one keeps no client-side
 * memory between sessions. On every page load, hydrate() is called once
 * (from the playground mount) to fetch the current global setting from
 * /api/settings, and updateSelectedProvider() writes back via PUT
 * /api/admin/settings (which is protected by the admin middleware).
 *
 * This means the admin's chosen provider applies to ALL users of the
 * deployment automatically, regardless of which browser / profile /
 * device they're on. The previous localStorage approach was per-browser
 * and led to confusing UX where the choice wouldn't carry over.
 *
 * Defaulting strategy: until hydrate() resolves, selectedProvider stays
 * "wavespeed" (the same default as the server route uses on first run).
 * The hydration call typically completes in <100ms on a local server,
 * so there's effectively no visible flash; if the user manages to click
 * Generate in that window, the form just submits to the default — which
 * is the same behavior they'd see on a fresh install anyway.
 */

interface SettingsState {
  selectedProvider: ProviderId;
  selectedModel: ModelId;
  isHydrated: boolean;
  hydrate: () => Promise<void>;
  updateSelectedProvider: (id: ProviderId) => Promise<void>;
  setSelectedModel: (id: ModelId) => void;
}

export const useSettingsStore = create<SettingsState>()((set) => ({
  selectedProvider: "wavespeed",
  selectedModel: loadModel(),
  isHydrated: false,

  setSelectedModel: (id) => {
    set({ selectedModel: id });
    try { window.localStorage.setItem(MODEL_LS_KEY, id); } catch {}
  },


  hydrate: async () => {
    try {
      const res = await fetch("/api/settings", { cache: "no-store" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as { selectedProvider: ProviderId };
      set({ selectedProvider: data.selectedProvider, isHydrated: true });
    } catch (err) {
      // On error, keep the default and mark as hydrated anyway so the
      // app doesn't get stuck in a loading state.
      console.error("[settings] hydrate failed:", err);
      set({ isHydrated: true });
    }
  },

  updateSelectedProvider: async (id) => {
    // Optimistic update: change the local state immediately so the UI
    // feels responsive, then PUT. Roll back on error.
    const previous = useSettingsStore.getState().selectedProvider;
    set({ selectedProvider: id });
    try {
      const res = await fetch("/api/admin/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ selectedProvider: id }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body?.error || `HTTP ${res.status}`);
      }
    } catch (err) {
      console.error("[settings] update failed:", err);
      set({ selectedProvider: previous });
      throw err;
    }
  },
}));
