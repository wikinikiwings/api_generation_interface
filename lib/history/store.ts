"use client";

import { create } from "zustand";
import { extractUuid, parseServerDate } from "@/lib/history/util";
import { debugHistory } from "@/lib/history/debug";
import type { EntryState, HistoryEntry, ServerGeneration } from "@/lib/history/types";
import type { OutputFormat } from "@/lib/providers/types";

interface StoreState {
  entries: HistoryEntry[];
  error: string | null;
}

export const useHistoryStore = create<StoreState>(() => ({
  entries: [],
  error: null,
}));

// === STATE HELPERS (consumed within lib/history only) ===

export function setStateOf(id: string, next: EntryState): void {
  useHistoryStore.setState((s) => ({
    entries: s.entries.map((e) => (e.id === id ? { ...e, state: next } : e)),
  }));
}

export function markRemoved(id: string): void {
  setStateOf(id, "removed");
}

export function rollbackDeletion(id: string): void {
  setStateOf(id, "live");
}

// === SERVER → STORE INGESTION ===

/**
 * The single decision point for "accept a server row". Invariant 2:
 * never resurrects DELETING/REMOVED entries. This is the architectural
 * fix for the resurrection race.
 */
export function applyServerRow(row: ServerGeneration): void {
  const firstFile = row.outputs[0]?.filepath ?? "";
  const uuid = extractUuid(firstFile) ?? `server-${row.id}`;
  const existing = useHistoryStore
    .getState()
    .entries.find((e) => e.id === uuid || e.serverGenId === row.id);

  if (existing && (existing.state === "deleting" || existing.state === "removed")) {
    debugHistory("applyServerRow.ignored", {
      uuid,
      serverGenId: row.id,
      localState: existing.state,
    });
    return;
  }

  const fromServer = serverGenToEntry(row, uuid);

  if (!existing) {
    useHistoryStore.setState((s) => ({ entries: [fromServer, ...s.entries] }));
    debugHistory("applyServerRow.insert", { id: uuid, serverGenId: row.id });
    return;
  }

  if (existing.state === "pending") {
    // PENDING → LIVE on server confirmation. Keep this tab's blob URLs
    // (they're already in memory and render instantly without re-decode).
    useHistoryStore.setState((s) => ({
      entries: s.entries.map((e) =>
        e.id === existing.id
          ? {
              ...e,
              serverGenId: row.id,
              state: "live" as const,
              confirmed: true,
              createdAt: parseServerDate(row.created_at),
              workflowName: fromServer.workflowName,
              prompt: fromServer.prompt,
            }
          : e
      ),
    }));
    debugHistory("applyServerRow.confirm", { id: existing.id, serverGenId: row.id });
    return;
  }

  // existing.state === "live": merge metadata, keep blob URLs
  useHistoryStore.setState((s) => ({
    entries: s.entries.map((e) =>
      e.id === existing.id ? mergeKeepingBlobs(e, fromServer) : e
    ),
  }));
}

function isBlob(u?: string): boolean {
  return typeof u === "string" && u.startsWith("blob:");
}

function mergeKeepingBlobs(local: HistoryEntry, server: HistoryEntry): HistoryEntry {
  return {
    ...server,
    id: local.id,
    state: local.state,
    outputUrl: isBlob(local.outputUrl) ? local.outputUrl : server.outputUrl,
    originalUrl: isBlob(local.originalUrl) ? local.originalUrl : server.originalUrl,
    previewUrl: isBlob(local.previewUrl) ? local.previewUrl : server.previewUrl,
    thumbUrl: isBlob(local.thumbUrl) ? local.thumbUrl : server.thumbUrl,
    localBlobUrls: local.localBlobUrls,
  };
}

export function serverGenToEntry(row: ServerGeneration, uuid: string): HistoryEntry {
  let prompt = "";
  let workflowName: string | undefined = row.workflow_name;
  let userPrompt: string | undefined;
  let styleId: string | undefined;
  try {
    const parsed = JSON.parse(row.prompt_data) as {
      prompt?: string;
      workflow?: string;
      userPrompt?: string;
      styleId?: string;
    };
    prompt = parsed.prompt ?? "";
    workflowName = parsed.workflow ?? row.workflow_name;
    if (typeof parsed.userPrompt === "string") userPrompt = parsed.userPrompt;
    if (typeof parsed.styleId === "string") styleId = parsed.styleId;
  } catch {
    // Malformed prompt_data — keep prompt as "".
  }
  const firstImage = row.outputs.find((o) => o.content_type.startsWith("image/"));
  const filename = firstImage?.filepath ?? "";
  const stem = filename.replace(/\.(png|jpg|jpeg|webp)$/i, "");
  return {
    id: uuid,
    serverGenId: row.id,
    state: "live",
    confirmed: true,
    prompt,
    userPrompt,
    styleId,
    provider: "wavespeed",
    workflowName,
    outputFormat: inferOutputFormat(firstImage?.content_type, filename),
    createdAt: parseServerDate(row.created_at),
    status: "completed",
    error: null,
    originalUrl: filename ? `/api/history/image/${filename}` : undefined,
    outputUrl: stem ? `/api/history/image/mid_${stem}.jpg` : undefined,
    thumbUrl: stem ? `/api/history/image/thumb_${stem}.jpg` : undefined,
  };
}

function inferOutputFormat(
  contentType: string | undefined,
  filename: string
): OutputFormat | undefined {
  if (contentType === "image/jpeg" || contentType === "image/jpg") return "jpeg";
  if (contentType === "image/png") return "png";
  const m = /\.(png|jpe?g)$/i.exec(filename);
  if (!m) return undefined;
  return m[1].toLowerCase().startsWith("j") ? "jpeg" : "png";
}

// === SERVER LIST INGESTION ===

export interface ApplyListOpts {
  offset?: number;
}

/**
 * Iterate rows through applyServerRow, then apply invariant 7:
 * a LIVE entry whose serverGenId is absent from the server response
 * is marked REMOVED — but only on the first page (offset=0) and only
 * within the response time window.
 */
export function applyServerList(rows: ServerGeneration[], opts: ApplyListOpts): void {
  const incomingByGenId = new Map(rows.map((r) => [r.id, r]));
  for (const row of rows) applyServerRow(row);

  if (rows.length === 0) return;
  if (opts.offset && opts.offset > 0) return;

  const oldest = Math.min(...rows.map((r) => parseServerDate(r.created_at)));
  const state = useHistoryStore.getState();
  const toRemove: string[] = [];
  for (const e of state.entries) {
    if (e.state !== "live") continue;
    if (typeof e.serverGenId !== "number") continue;
    if (incomingByGenId.has(e.serverGenId)) continue;
    if (e.createdAt < oldest) continue;
    toRemove.push(e.id);
    debugHistory("hydrate.cross-device-delete", {
      id: e.id,
      serverGenId: e.serverGenId,
    });
  }
  for (const id of toRemove) markRemoved(id);
}

/** Test-only: clear store between tests. */
export function _resetForTest(): void {
  useHistoryStore.setState({ entries: [], error: null });
}

// One-time cleanup: the previous mechanism persisted under "wavespeed-history".
// New store doesn't persist (server is the source of truth; cross-device sync
// requires it). Remove the stale key so it doesn't sit in localStorage forever.
// No-op if already absent.
if (typeof window !== "undefined") {
  try {
    window.localStorage.removeItem("wavespeed-history");
  } catch {
    // ignore (private mode, quota, etc.)
  }
}
