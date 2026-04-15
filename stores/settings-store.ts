"use client";

import { create } from "zustand";
import type { ProviderId, ModelId } from "@/lib/providers/types";

// v3: default flipped from nano-banana-pro → nano-banana-2 (Phase 5).
// Bumping the key version invalidates old persisted choices so users who
// never explicitly picked a model land on the new default; users who DID
// pick something will simply re-pick once. Cheaper than a real migration
// for a single-field store. Also widened to recognize seedream models
// since they're supported across all three providers now.
const MODEL_LS_KEY = "wavespeed:selectedModel:v3";
const KNOWN_MODELS: ReadonlyArray<ModelId> = [
  "nano-banana-2",
  "nano-banana-pro",
  "nano-banana",
  "seedream-4-5",
  "seedream-5-0-lite",
];
function loadModel(): ModelId {
  if (typeof window === "undefined") return "nano-banana-2";
  try {
    const v = window.localStorage.getItem(MODEL_LS_KEY);
    if (v && (KNOWN_MODELS as ReadonlyArray<string>).includes(v)) return v as ModelId;
  } catch {}
  return "nano-banana-2";
}

const STYLE_LS_KEY = "wavespeed:selectedStyle:v1";
const DEFAULT_STYLE_ID = "__default__";

function loadStyleId(): string {
  if (typeof window === "undefined") return DEFAULT_STYLE_ID;
  try {
    const v = window.localStorage.getItem(STYLE_LS_KEY);
    if (typeof v === "string" && v.length > 0) return v;
  } catch {}
  return DEFAULT_STYLE_ID;
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
  hydrateUserModel: (username: string) => Promise<void>;
  updateSelectedProvider: (id: ProviderId) => Promise<void>;
  setSelectedModel: (id: ModelId, username?: string | null) => void;
  selectedStyleId: string;
  setSelectedStyleId: (id: string) => void;
  /**
   * If the currently-selected style id is not in `knownIds`, reset to the
   * default. Called by the generation form after loading /api/styles, so a
   * style deleted in the admin silently stops applying. No-op otherwise.
   */
  reconcileSelectedStyle: (knownIds: readonly string[]) => void;
  /**
   * Start polling /api/settings every 30s + on visibilitychange. Returns
   * a cleanup function. Idempotent within a single component lifecycle:
   * if startProviderPolling() is called twice, the second call returns
   * the same cleanup as the first (poll only runs once).
   *
   * The optional `onProviderChanged` callback fires whenever the polled
   * value differs from the local store value — used by playground.tsx to
   * surface a toast "Админ переключил endpoint на X". The callback fires
   * AFTER the store has been updated, so consumers can read the new
   * value from `get().selectedProvider` if needed.
   */
  startProviderPolling: (
    onProviderChanged?: (next: ProviderId, prev: ProviderId) => void
  ) => () => void;
}

export const useSettingsStore = create<SettingsState>()((set, get) => ({
  selectedProvider: "wavespeed",
  selectedModel: loadModel(),
  selectedStyleId: loadStyleId(),
  isHydrated: false,

  setSelectedModel: (id, username) => {
    set({ selectedModel: id });
    // Warm cache: keep LS in sync so the next page load renders the right
    // model instantly, before the server hydration round-trip completes.
    try { window.localStorage.setItem(MODEL_LS_KEY, id); } catch {}
    // Source of truth: persist to the per-user table on the server. Fire-
    // and-forget — a network failure here just means the choice doesn't
    // follow the user to other devices, which is a soft degradation, not
    // a reason to block the UI or surface an error toast. We DO log so it
    // shows up in devtools when debugging "why didn't my pick stick".
    if (username) {
      void fetch("/api/user/preferences", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, selectedModel: id }),
      }).catch((err) => {
        console.warn("[settings] failed to persist selectedModel:", err);
      });
    }
  },

  setSelectedStyleId: (id) => {
    set({ selectedStyleId: id });
    try { window.localStorage.setItem(STYLE_LS_KEY, id); } catch {}
  },

  reconcileSelectedStyle: (knownIds) => {
    const current = get().selectedStyleId;
    if (current === DEFAULT_STYLE_ID) return;
    if (knownIds.includes(current)) return;
    set({ selectedStyleId: DEFAULT_STYLE_ID });
    try { window.localStorage.setItem(STYLE_LS_KEY, DEFAULT_STYLE_ID); } catch {}
  },

  /**
   * Per-user hydration. Called from the playground mount once the username
   * cookie is known (i.e. after UsernameModal closes). Pulls the user's
   * sticky pick from the server and overwrites the LS-seeded default.
   *
   * Race semantics: if the user clicks the picker between LS-seed and
   * server response, their click wins — we only overwrite when the server
   * actually returns a value AND the local state still matches the LS
   * seed. This avoids the classic "hydration stomps user input" bug.
   */
  hydrateUserModel: async (username) => {
    if (!username) return;
    const before = get().selectedModel;
    try {
      const res = await fetch(
        `/api/user/preferences?username=${encodeURIComponent(username)}`,
        { cache: "no-store" }
      );
      if (!res.ok) return;
      const data = (await res.json()) as { selectedModel: ModelId | null };
      if (!data.selectedModel) return; // first-time user, keep default
      // Stomp-guard: only apply if the user hasn't picked something else
      // during the in-flight request. Compare to `before`, not to the
      // current state directly, because between the snapshot and now the
      // user might have clicked.
      if (get().selectedModel !== before) return;
      set({ selectedModel: data.selectedModel });
      try { window.localStorage.setItem(MODEL_LS_KEY, data.selectedModel); } catch {}
    } catch (err) {
      console.warn("[settings] hydrateUserModel failed:", err);
    }
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

  /**
   * Polling implementation — see interface comment for contract.
   *
   * Why polling vs SSE: GET /api/settings is a single SQLite primary-key
   * lookup (~microseconds), and at 20 users/30s = 40 req/min the load is
   * negligible. SSE would give real-time push but adds connection-mgmt
   * complexity (broadcast registry, reconnection, proxy buffering) for
   * no meaningful UX gain over a 30s tick + visibilitychange flush.
   *
   * Stale-detection: each tick GETs the value, compares to current store
   * state, and if it changed, calls set() + invokes the callback. We
   * compare via the freshly-read state inside tick() to avoid stale
   * closures from the outer scope.
   *
   * SSR safety: this method only runs from useEffect on the client, so
   * window/setInterval are guaranteed to exist. We still guard for
   * paranoia in case someone calls it from somewhere weird.
   */
  startProviderPolling: (onProviderChanged) => {
    if (typeof window === "undefined") return () => {};

    const POLL_INTERVAL_MS = 30_000;
    let cancelled = false;

    async function tick() {
      if (cancelled) return;
      try {
        const res = await fetch("/api/settings", { cache: "no-store" });
        if (!res.ok) return;
        const data = (await res.json()) as { selectedProvider: ProviderId };
        if (cancelled) return;
        const prev = get().selectedProvider;
        if (data.selectedProvider && data.selectedProvider !== prev) {
          set({ selectedProvider: data.selectedProvider });
          // Mark hydrated in case the very first /api/settings was the
          // poll itself (e.g. if hydrate() failed or was skipped).
          if (!get().isHydrated) set({ isHydrated: true });
          onProviderChanged?.(data.selectedProvider, prev);
        }
      } catch (err) {
        // Network blip — stay on current state, retry next tick. We
        // intentionally don't surface this to the user; provider sync
        // is best-effort, the submit endpoint is the source of truth.
        console.warn("[settings] poll tick failed:", err);
      }
    }

    const intervalId = window.setInterval(tick, POLL_INTERVAL_MS);

    // Visibility-based fast path: when the user comes back to the tab
    // (e.g. after lunch), force an immediate fetch instead of waiting up
    // to 30s for the next interval. This is the moment they're most
    // likely to click Generate, so getting fresh state here matters most.
    const onVisibility = () => {
      if (document.visibilityState === "visible") void tick();
    };
    document.addEventListener("visibilitychange", onVisibility);

    return () => {
      cancelled = true;
      window.clearInterval(intervalId);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  },
}));
