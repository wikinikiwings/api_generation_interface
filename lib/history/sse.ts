"use client";

import * as React from "react";
import { applyServerRow } from "@/lib/history/store";
import { deleteEntry, setCurrentUsername } from "@/lib/history/mutations";
import { hydrateFromServer } from "@/lib/history/hydrate";
import { debugHistory } from "@/lib/history/debug";
import type { ServerGeneration } from "@/lib/history/types";

let es: EventSource | null = null;
let currentUsername: string | null = null;

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
  es = new EventSource(
    `/api/history/stream?username=${encodeURIComponent(username)}`
  );

  es.addEventListener("generation.created", (ev) => {
    try {
      const row = JSON.parse((ev as MessageEvent).data) as ServerGeneration;
      debugHistory("sse.created", { id: row.id });
      applyServerRow(row);
    } catch (err) {
      debugHistory("sse.created.parse-error", { error: String(err) });
    }
  });

  es.addEventListener("generation.deleted", (ev) => {
    try {
      const { id } = JSON.parse((ev as MessageEvent).data) as { id: number };
      debugHistory("sse.deleted", { id });
      void deleteEntry(id, { skipServerDelete: true });
    } catch (err) {
      debugHistory("sse.deleted.parse-error", { error: String(err) });
    }
  });

  es.addEventListener("open", () => {
    debugHistory("sse.open");
    void hydrateFromServer({ username });
  });

  es.addEventListener("error", () => {
    debugHistory("sse.error", { readyState: es?.readyState });
  });
}

function close(): void {
  es?.close();
  es = null;
  currentUsername = null;
}

// === Test-only helpers ===
export function _openForTest(username: string): void {
  open(username);
}
export function _closeForTest(): void {
  close();
}
