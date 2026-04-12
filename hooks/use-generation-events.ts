"use client";

import * as React from "react";
import { broadcastHistoryRefresh } from "@/hooks/use-history";

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

    // Both event types trigger the same local refresh bus — useHistory
    // listeners refetch. The event payload is intentionally unused
    // here: we rely on the fetch being cheap and idempotent.
    es.addEventListener("generation.created", refresh);
    es.addEventListener("generation.deleted", refresh);

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
