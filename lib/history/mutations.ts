"use client";

import { toast } from "sonner";
import {
  useHistoryStore,
  setStateOf,
  markRemoved,
  rollbackDeletion,
} from "@/lib/history/store";
import { broadcast } from "@/lib/history/broadcast";
import {
  getPendingControls,
  setPendingControls,
  clearPendingControls,
} from "@/lib/history/pending";
import { debugHistory } from "@/lib/history/debug";
import type { HistoryEntry, NewPendingInput } from "@/lib/history/types";

const ANIMATION_HOLD_MS = 200;

let currentUsername: string | null = null;

/** Set by useGenerationEvents on mount. Read by deleteEntry. */
export function setCurrentUsername(username: string | null): void {
  currentUsername = username;
}

/** Test-only convenience to seed username without mounting hooks. */
export function setUsernameForTest(username: string | null): void {
  currentUsername = username;
}

function findEntry(idOrServerGenId: string | number): HistoryEntry | undefined {
  const entries = useHistoryStore.getState().entries;
  if (typeof idOrServerGenId === "number") {
    return entries.find((e) => e.serverGenId === idOrServerGenId);
  }
  return entries.find((e) => e.id === idOrServerGenId);
}

function revokeBlobs(urls: string[] | undefined): void {
  if (!urls) return;
  for (const u of urls) {
    if (!u || !u.startsWith("blob:")) continue;
    try {
      URL.revokeObjectURL(u);
    } catch {
      /* ignore */
    }
  }
}

const sleep = (ms: number) =>
  new Promise<void>((r) => setTimeout(r, ms));

/**
 * Single removal path for Output trash, Sidebar trash, SSE deleted,
 * BroadcastChannel deleted, future shortcuts. Idempotent on
 * DELETING/REMOVED/PENDING-without-server.
 *
 * skipServerDelete=true means the caller is reacting to a cross-device
 * event; the server already knows. Used by SSE handler and BroadcastChannel
 * receiver. Local user clicks omit it.
 */
export async function deleteEntry(
  idOrServerGenId: string | number,
  opts?: { skipServerDelete?: boolean }
): Promise<void> {
  const entry = findEntry(idOrServerGenId);
  if (!entry) return;

  if (entry.state === "deleting" || entry.state === "removed") {
    debugHistory("deleteEntry.noop", { id: entry.id, state: entry.state });
    return;
  }

  if (entry.state === "pending") {
    debugHistory("deleteEntry.pending", { id: entry.id });
    getPendingControls(entry.id)?.abort?.();
    clearPendingControls(entry.id);
    markRemoved(entry.id);
    revokeBlobs(entry.localBlobUrls);
    broadcast.post({ type: "delete", id: entry.id });
    return;
  }

  // LIVE — synchronous optimistic transition + async DELETE
  setStateOf(entry.id, "deleting");
  debugHistory("deleteEntry.start", {
    id: entry.id,
    serverGenId: entry.serverGenId,
  });
  broadcast.post({
    type: "delete",
    id: entry.id,
    serverGenId: entry.serverGenId,
  });

  if (typeof entry.serverGenId !== "number") {
    markRemoved(entry.id);
    debugHistory("deleteEntry.no-server-id", { id: entry.id });
    return;
  }

  if (opts?.skipServerDelete) {
    if (ANIMATION_HOLD_MS > 0) await sleep(ANIMATION_HOLD_MS);
    markRemoved(entry.id);
    revokeBlobs(entry.localBlobUrls);
    debugHistory("deleteEntry.commit.no-server", { id: entry.id });
    return;
  }

  if (!currentUsername) {
    rollbackDeletion(entry.id);
    debugHistory("deleteEntry.no-username", { id: entry.id });
    return;
  }

  const url = `/api/history?id=${entry.serverGenId}&username=${encodeURIComponent(currentUsername)}`;
  try {
    const [deleteRes] = await Promise.all([
      fetch(url, { method: "DELETE" }),
      ANIMATION_HOLD_MS > 0 ? sleep(ANIMATION_HOLD_MS) : Promise.resolve(),
    ]);
    if (!deleteRes.ok) throw new Error(`HTTP ${deleteRes.status}`);
    markRemoved(entry.id);
    revokeBlobs(entry.localBlobUrls);
    debugHistory("deleteEntry.commit", {
      id: entry.id,
      serverGenId: entry.serverGenId,
    });
  } catch (e) {
    rollbackDeletion(entry.id);
    debugHistory("deleteEntry.error", {
      id: entry.id,
      serverGenId: entry.serverGenId,
      message: String(e),
    });
    toast.error(e instanceof Error ? e.message : "Не удалось удалить");
  }
}

// === Pending lifecycle ===

export function addPendingEntry(input: NewPendingInput): void {
  const entry: HistoryEntry = {
    id: input.uuid,
    taskId: input.taskId,
    state: "pending",
    confirmed: false,
    prompt: input.prompt,
    userPrompt: input.userPrompt,
    styleIds: input.styleIds,
    provider: input.provider,
    model: input.model,
    workflowName: input.workflowName,
    resolution: input.resolution,
    aspectRatio: input.aspectRatio,
    outputFormat: input.outputFormat,
    inputThumbnails: input.inputThumbnails,
    createdAt: input.createdAt,
    status: input.status ?? "pending",
    error: null,
    thumbUrl: input.thumbUrl,
    previewUrl: input.previewUrl,
    originalUrl: input.originalUrl,
    outputUrl: input.outputUrl,
    localBlobUrls: input.localBlobUrls,
  };
  useHistoryStore.setState((s) => ({ entries: [entry, ...s.entries] }));
  debugHistory("addPendingEntry", { id: input.uuid });
}

export function updatePendingEntry(
  uuid: string,
  patch: Partial<
    Pick<
      HistoryEntry,
      "thumbUrl" | "previewUrl" | "originalUrl" | "outputUrl" | "localBlobUrls"
    >
  >
): void {
  useHistoryStore.setState((s) => ({
    entries: s.entries.map((e) => (e.id === uuid ? { ...e, ...patch } : e)),
  }));
}

/**
 * General metadata patch — for fields that don't fit the pending lifecycle
 * (status, taskId, error, executionTimeMs, outputSizeBytes, etc.).
 *
 * Cannot change `id` or `state`. State transitions go through deleteEntry,
 * confirmPendingEntry, or rollback paths in store.ts.
 */
export function updateEntry(
  id: string,
  patch: Omit<Partial<HistoryEntry>, "id" | "state">
): void {
  useHistoryStore.setState((s) => ({
    entries: s.entries.map((e) => (e.id === id ? { ...e, ...patch } : e)),
  }));
}

export function confirmPendingEntry(
  uuid: string,
  payload: {
    serverGenId: number;
    serverUrls: { thumb?: string; mid?: string; full?: string };
  }
): void {
  useHistoryStore.setState((s) => ({
    entries: s.entries.map((e) =>
      e.id === uuid
        ? {
            ...e,
            serverGenId: payload.serverGenId,
            state: "live" as const,
            confirmed: true,
            status: "completed" as const,
            originalUrl: payload.serverUrls.full ?? e.originalUrl,
            outputUrl: payload.serverUrls.mid ?? e.outputUrl,
            thumbUrl: payload.serverUrls.thumb ?? e.thumbUrl,
          }
        : e
    ),
  }));
  clearPendingControls(uuid);
  debugHistory("confirmPendingEntry", {
    uuid,
    serverGenId: payload.serverGenId,
  });
}

export function markPendingError(uuid: string, message: string): void {
  useHistoryStore.setState((s) => ({
    entries: s.entries.map((e) =>
      e.id === uuid
        ? { ...e, error: message, status: "failed" as const }
        : e
    ),
  }));
  debugHistory("markPendingError", { uuid, message });
}

export { setPendingControls, getPendingControls };
