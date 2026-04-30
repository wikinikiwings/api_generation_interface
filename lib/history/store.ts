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

/**
 * Pre-2026-04-15 rows stored raw ViewComfy workflow inputs keyed by
 * "<node>-inputs-<field>" rather than a top-level "prompt". Recover the
 * prompt text from the first non-empty "-inputs-text" value (excluding
 * "-inputs-text_negative"), so legacy rows still show prompt + Copy work.
 */
function extractLegacyPrompt(parsed: Record<string, unknown>): string {
  for (const [key, value] of Object.entries(parsed)) {
    if (!/-inputs-text$/.test(key)) continue;
    if (typeof value !== "string") continue;
    const trimmed = value.trim();
    if (trimmed.length > 0) return trimmed;
  }
  return "";
}

export function serverGenToEntry(row: ServerGeneration, uuid: string): HistoryEntry {
  let prompt = "";
  let workflowName: string | undefined = row.workflow_name;
  let userPrompt: string | undefined;
  let styleIds: string[] | undefined;
  try {
    const parsed = JSON.parse(row.prompt_data) as Record<string, unknown> & {
      prompt?: string;
      workflow?: string;
      userPrompt?: string;
      styleId?: string;
      styleIds?: string[];
    };
    prompt =
      typeof parsed.prompt === "string"
        ? parsed.prompt
        : extractLegacyPrompt(parsed);
    workflowName = parsed.workflow ?? row.workflow_name;
    if (typeof parsed.userPrompt === "string") userPrompt = parsed.userPrompt;
    if (
      Array.isArray(parsed.styleIds) &&
      parsed.styleIds.every((x) => typeof x === "string")
    ) {
      styleIds = parsed.styleIds;
    } else if (typeof parsed.styleId === "string") {
      // Legacy single-style record: coerce to array.
      styleIds = parsed.styleId === "__default__" ? [] : [parsed.styleId];
    }
  } catch {
    // Malformed prompt_data — keep prompt as "".
  }
  const firstImage = row.outputs.find((o) => o.content_type.startsWith("image/"));
  const filename = firstImage?.filepath ?? "";
  // Filepath format after Task 7.3: `<email>/<YYYY>/<MM>/<uuid>.<ext>`
  // (or legacy flat: `<uuid>.<ext>`). The thumb/mid siblings live in the
  // SAME directory with `thumb_`/`mid_` prefixed onto the basename, NOT
  // onto the full path. Split into dir + basename before composing.
  const lastSlash = filename.lastIndexOf("/");
  const dir = lastSlash >= 0 ? filename.slice(0, lastSlash) : "";
  const basename = lastSlash >= 0 ? filename.slice(lastSlash + 1) : filename;
  const baseStem = basename.replace(/\.(png|jpg|jpeg|webp)$/i, "");
  const dirPrefix = dir ? `${dir}/` : "";
  return {
    id: uuid,
    serverGenId: row.id,
    state: "live",
    confirmed: true,
    prompt,
    userPrompt,
    styleIds,
    provider: "wavespeed",
    workflowName,
    outputFormat: inferOutputFormat(firstImage?.content_type, filename),
    createdAt: parseServerDate(row.created_at),
    status: "completed",
    error: null,
    originalUrl: filename ? `/api/history/image/${filename}` : undefined,
    outputUrl: baseStem ? `/api/history/image/${dirPrefix}mid_${baseStem}.jpg` : undefined,
    thumbUrl: baseStem ? `/api/history/image/${dirPrefix}thumb_${baseStem}.jpg` : undefined,
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
  /** ms epoch — upper/lower bounds of the filter the caller queried with.
   *  When provided, entries outside [rangeFrom, rangeTo] are NOT candidates
   *  for cross-device-delete marking, because their absence from the
   *  response is explained by the filter, not by server-side deletion. */
  rangeFrom?: number;
  rangeTo?: number;
}

/**
 * Iterate rows through applyServerRow, then apply invariant 7:
 * a LIVE entry whose serverGenId is absent from the server response
 * is marked REMOVED — but only on the first page (offset=0), only
 * at or above the response's oldest timestamp (pagination guard), and
 * only within the caller's filter range when provided (filter guard).
 *
 * The filter guard is load-bearing: without it, a narrowed "До" returns
 * rows only up to that date, recent-but-out-of-filter entries get
 * marked REMOVED, and invariant 2 then blocks their resurrection on
 * the next hydrate — so the user sees nothing until a page reload.
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
    if (opts.rangeFrom != null && e.createdAt < opts.rangeFrom) continue;
    if (opts.rangeTo != null && e.createdAt > opts.rangeTo) continue;
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
