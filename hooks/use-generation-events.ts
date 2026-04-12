"use client";

import * as React from "react";
import { broadcastHistoryRefresh } from "@/hooks/use-history";
import { useHistoryStore } from "@/stores/history-store";
import { markGenerationDeleted } from "@/lib/history-deletions";
import { debugHistory } from "@/lib/history-debug";

/**
 * Open an EventSource to /api/history/stream for the given username
 * and translate incoming events into the existing
 * `HISTORY_REFRESH_EVENT` bus (via `broadcastHistoryRefresh`). Every
 * mounted `useHistory` instance will refetch and rerender.
 *
 * Browsers' built-in EventSource auto-reconnects on network dropouts.
 * We additionally refetch on connection open, so any events missed
 * during a disconnect window are reconciled via the next server pull.
 *
 * No-op when `username` is null (not signed in).
 */
export function useGenerationEvents(username: string | null): void {
  React.useEffect(() => {
    if (!username) return;
    if (typeof window === "undefined") return;
    if (typeof EventSource === "undefined") return;

    const url = `/api/history/stream?username=${encodeURIComponent(username)}`;
    const es = new EventSource(url);

    const refresh = () => broadcastHistoryRefresh();

    // `generation.created` triggers a full refetch via the local refresh
    // bus. The event payload is intentionally unused — the fetch is cheap
    // and idempotent.
    es.addEventListener("generation.created", (ev) => {
      debugHistory("sse.generation.created", (ev as MessageEvent).data);
      refresh();
    });

    // `generation.deleted` carries `{ id: number }`. Drop any Zustand
    // entries that reference this server row so the Output panel
    // (which merges Zustand + serverToday) stops showing them. This is
    // the single source of truth for cross-tab / cross-device delete
    // cleanup — the UI trash handlers in Output and History intentionally
    // do NOT mutate Zustand themselves.
    es.addEventListener("generation.deleted", (ev) => {
      let id: number | null = null;
      try {
        const parsed = JSON.parse((ev as MessageEvent).data) as { id?: unknown };
        if (typeof parsed.id === "number") id = parsed.id;
      } catch {
        // Malformed payload — fall through to refresh-only.
      }
      debugHistory("sse.generation.deleted", { id });
      if (id !== null) {
        // Register in the cross-surface deleted-ids set BEFORE the
        // broadcastHistoryRefresh below. Otherwise the refetch that
        // fires right after could race a concurrent generation's
        // confirmPending → triggerHistoryRefresh → refetch sequence
        // and briefly re-surface the just-deleted row via serverToday.
        markGenerationDeleted(id);
        const store = useHistoryStore.getState();
        const toRemove = store.entries
          .filter((e) => e.serverGenId === id)
          .map((e) => e.id);
        for (const localId of toRemove) store.remove(localId);
      }
      broadcastHistoryRefresh();
    });

    // Refetch on (re)connect so any missed events are reconciled.
    es.addEventListener("open", refresh);

    // Don't toast on error — EventSource auto-reconnects; an error
    // during reconnection attempts would be visible spam. Log once.
    es.addEventListener("error", () => {
      // EventSource.readyState === 0 means CONNECTING (reconnecting);
      // === 2 means CLOSED (gave up). We don't currently re-open on
      // CLOSED because modern browsers handle this themselves.
      console.debug("[use-generation-events] connection error", es.readyState);
    });

    return () => {
      es.close();
    };
  }, [username]);
}
