"use client";

import * as React from "react";
import { applyServerRow } from "@/lib/history/store";
import { deleteEntry, setCurrentUsername } from "@/lib/history/mutations";
import { hydrateFromServer } from "@/lib/history/hydrate";
import { debugHistory } from "@/lib/history/debug";
import type { ServerGeneration } from "@/lib/history/types";

let es: EventSource | null = null;
let currentUsername: string | null = null;
let lastActivityTs = 0;
let watchdog: ReturnType<typeof setInterval> | null = null;

// Server sends a heartbeat event every 25s (see lib/sse-broadcast.ts).
// If the client sees no events or heartbeats for this many ms, the
// stream is considered dead (HMR wiped server registry, proxy idle
// timeout, laptop sleep, silent half-open TCP) and we force-reconnect.
// Set to ~2.5× HEARTBEAT_MS so a single dropped heartbeat doesn't trip
// reconnect; two missed heartbeats does.
const STALE_MS = 60_000;
const WATCHDOG_INTERVAL_MS = 15_000;

export function useGenerationEvents(username: string | null): void {
  React.useEffect(() => {
    if (!username) {
      setCurrentUsername(null);
      return;
    }
    if (typeof window === "undefined" || typeof EventSource === "undefined") return;
    setCurrentUsername(username);
    open(username);
    return () => {
      close();
      setCurrentUsername(null);
    };
  }, [username]);
}

function open(username: string): void {
  if (es && currentUsername === username) return;
  close();
  currentUsername = username;
  lastActivityTs = Date.now();
  es = new EventSource(`/api/history/stream`);

  es.addEventListener("generation.created", (ev) => {
    lastActivityTs = Date.now();
    try {
      const row = JSON.parse((ev as MessageEvent).data) as ServerGeneration;
      debugHistory("sse.created", { id: row.id });
      applyServerRow(row);
    } catch (err) {
      debugHistory("sse.created.parse-error", { error: String(err) });
    }
  });

  es.addEventListener("generation.deleted", (ev) => {
    lastActivityTs = Date.now();
    try {
      const { id } = JSON.parse((ev as MessageEvent).data) as { id: number };
      debugHistory("sse.deleted", { id });
      void deleteEntry(id, { skipServerDelete: true });
    } catch (err) {
      debugHistory("sse.deleted.parse-error", { error: String(err) });
    }
  });

  // Heartbeat is a real named event (not a `:` comment) so this listener
  // actually fires — that's how the watchdog knows the stream is alive.
  es.addEventListener("heartbeat", () => {
    lastActivityTs = Date.now();
  });

  es.addEventListener("open", () => {
    lastActivityTs = Date.now();
    debugHistory("sse.open");
    void hydrateFromServer({ username });
  });

  es.addEventListener("error", () => {
    debugHistory("sse.error", { readyState: es?.readyState });
  });

  // Watchdog: if nothing has arrived (including heartbeats) for STALE_MS,
  // the stream is dead-but-not-closed. Force-reconnect, which re-registers
  // us with the server's subscribers Map and triggers a hydrate via the
  // `open` handler above — so any events we missed while stale get picked
  // up through that refetch.
  if (watchdog) clearInterval(watchdog);
  watchdog = setInterval(() => {
    if (!es) return;
    const silent = Date.now() - lastActivityTs;
    if (silent < STALE_MS) return;
    const uname = currentUsername;
    if (!uname) return;
    debugHistory("sse.watchdog.reconnect", { silentMs: silent });
    es.close();
    es = null;
    currentUsername = null;
    open(uname);
  }, WATCHDOG_INTERVAL_MS);
}

function close(): void {
  if (watchdog) {
    clearInterval(watchdog);
    watchdog = null;
  }
  es?.close();
  es = null;
  currentUsername = null;
  lastActivityTs = 0;
}

// === Test-only helpers ===
export function _openForTest(username: string): void {
  open(username);
}
export function _closeForTest(): void {
  close();
}
