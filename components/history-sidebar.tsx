"use client";

import * as React from "react";
import { History, ChevronRight, Copy, Trash2, RefreshCw, SlidersHorizontal } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { ImageDialog } from "@/components/image-dialog";
import { useUser } from "@/app/providers/user-provider";
import { cn, copyToClipboard, formatFullDate } from "@/lib/utils";
import { preloadImages } from "@/lib/image-cache";
import { useHistory, HISTORY_REFRESH_EVENT, broadcastHistoryRefresh, type ServerGeneration } from "@/hooks/use-history";
import { isPending, removePending, type PendingGeneration } from "@/lib/pending-history";
import { mark } from "@/lib/history-timings";
import { useHistoryStore } from "@/stores/history-store";
import type { HistoryEntry } from "@/types/wavespeed";

export interface HistorySidebarProps {
  open: boolean;
  setOpen: (open: boolean) => void;
  className?: string;
}

interface ParsedPromptData {
  prompt?: string;
  resolution?: string;
  aspectRatio?: string;
  outputFormat?: string;
  provider?: string;
  model?: string;
}

function parsePromptData(raw: string): ParsedPromptData {
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    // Wavespeed-claude format: flat object with a top-level `prompt` key
    // (alongside resolution, aspectRatio, outputFormat, provider, model).
    if (typeof parsed.prompt === "string") {
      return parsed as ParsedPromptData;
    }
    // Viewcomfy-claude format: flat object whose keys are prefixed with
    // ComfyUI node ids, e.g. "123-inputs-text" or "45-prompt". The actual
    // prompt text lives under the first key whose stripped name is
    // "text" or "prompt". This mirrors viewcomfy's own extractPromptText
    // logic verbatim so the same DB row decodes the same way in both apps.
    const textKey = Object.keys(parsed).find((k) => {
      const cleaned = k.replace(/^\d+-inputs-/, "").replace(/^\d+-/, "");
      return cleaned === "text" || cleaned === "prompt";
    });
    if (textKey && typeof parsed[textKey] === "string") {
      return { prompt: parsed[textKey] as string };
    }
    return {};
  } catch {
    return {};
  }
}

/**
 * Adapter: ServerGeneration (snake_case, SQLite-shape) → HistoryEntry
 * (zustand-shape expected by <ImageDialog>). Builds a minimal valid object
 * with only the fields ImageDialog actually reads: outputUrl, prompt,
 * taskId, id, outputFormat. Everything else is filler so TS stays happy.
 */
function serverGenToHistoryEntry(
  gen: ServerGeneration,
  data: ParsedPromptData,
  fullSrc: string
): HistoryEntry {
  return {
    id: String(gen.id),
    taskId: `server-${gen.id}`,
    provider: (data.provider as HistoryEntry["provider"]) || "wavespeed",
    prompt: data.prompt || "",
    model: (data.model as HistoryEntry["model"]) || "nano-banana-pro",
    aspectRatio: (data.aspectRatio as HistoryEntry["aspectRatio"]) || undefined,
    resolution: (data.resolution as HistoryEntry["resolution"]) || "2k",
    outputFormat: (data.outputFormat as HistoryEntry["outputFormat"]) || "png",
    status: "completed",
    createdAt: Date.now(),
    outputUrl: fullSrc,
    inputThumbnails: [],
  };
}

/** Build a URL for the local image-serving endpoint. */
function imgUrl(filepath: string, variant?: "thumb" | "mid"): string {
  const base = filepath.replace(/\.[^.]+$/, "");
  if (variant === "thumb") {
    return `/api/history/image/${encodeURIComponent(`thumb_${base}.jpg`)}`;
  }
  if (variant === "mid") {
    // New entries (client-generated variants) use .jpg. Legacy entries
    // (server sharp-generated) use .png. The resolver in
    // app/api/history/image/[filename]/route.ts has a narrow .jpg<->.png
    // fallback for mid_* lookups, so requesting .jpg for old entries
    // transparently serves the legacy .png bytes.
    return `/api/history/image/${encodeURIComponent(`mid_${base}.jpg`)}`;
  }
  return `/api/history/image/${encodeURIComponent(filepath)}`;
}

// Re-export for backwards compat (generate-form imports REFRESH_EVENT
// from here historically). Canonical source is hooks/use-history.ts.
const REFRESH_EVENT = HISTORY_REFRESH_EVENT;
export { HISTORY_REFRESH_EVENT as REFRESH_EVENT_NAME };

// Debounce rapid triggerHistoryRefresh() calls (e.g. several generations
// finishing back-to-back) into a single refetch. 1500ms is long enough to
// coalesce a burst but short enough to feel responsive.
//
// The trigger uses broadcastHistoryRefresh() so the signal also reaches
// other open tabs of the same app via BroadcastChannel — not just the
// local CustomEvent. See hooks/use-history.ts for the cross-tab plumbing.
const REFRESH_DEBOUNCE_MS = 1500;
let refreshTimer: ReturnType<typeof setTimeout> | null = null;

export function triggerHistoryRefresh() {
  if (typeof window === "undefined") return;
  if (refreshTimer) clearTimeout(refreshTimer);
  refreshTimer = setTimeout(() => {
    refreshTimer = null;
    broadcastHistoryRefresh();
  }, REFRESH_DEBOUNCE_MS);
}

function toDateInput(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

export function HistorySidebar({ open, setOpen, className }: HistorySidebarProps) {
  const { username } = useUser();
  const [filtersOpen, setFiltersOpen] = React.useState(false);
  const [dateRange, setDateRange] = React.useState<{ from: Date; to: Date }>(() => ({
    from: new Date(Date.now() - 7 * 86400000),
    to: new Date(),
  }));

  const {
    items,
    hasMore,
    isLoading,
    isLoadingMore,
    error,
    loadMore,
    refetch,
  } = useHistory({
    username,
    startDate: dateRange.from,
    endDate: dateRange.to,
  });
  const loading = isLoading;

  // Optimistic local removal after DELETE. Since useHistory owns items, we
  // just refetch — the DELETE endpoint is fast enough.
  const [deletingIds, setDeletingIds] = React.useState<Set<number>>(new Set());
  const visibleItems = React.useMemo(
    () => items.filter((g) => !deletingIds.has(g.id)),
    [items, deletingIds]
  );

  // Warm browser cache for thumb + mid variants (see lib/image-cache.ts).
  React.useEffect(() => {
    if (visibleItems.length === 0) return;
    const urls: string[] = [];
    for (const g of visibleItems) {
      // Blob URLs are already in memory — preloading does nothing useful.
      if (isPending(g)) continue;
      const img = g.outputs.find((o) => o.content_type.startsWith("image/"));
      if (!img) continue;
      urls.push(imgUrl(img.filepath, "thumb"));
      urls.push(imgUrl(img.filepath, "mid"));
    }
    preloadImages(urls);
  }, [visibleItems]);

  async function handleDelete(gen: ServerGeneration) {
    if (!username) return;
    if (!confirm("Удалить эту запись из истории?")) return;

    // Pending (not-yet-confirmed) entry: drop it from the client-side
    // singleton. Blob URLs revoked. No server call.
    if (isPending(gen)) {
      removePending(gen.uuid);
      toast.success("Удалено");
      return;
    }

    try {
      const res = await fetch(
        `/api/history?id=${gen.id}&username=${encodeURIComponent(username)}`,
        { method: "DELETE" }
      );
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setDeletingIds((prev) => new Set(prev).add(gen.id));

      // Also drop the matching entry from the client-side zustand store
      // that feeds the Output panel. Exact match via serverGenId, which
      // generate-form writes after POST /api/history succeeds. Legacy
      // entries (pre-v3 store) and entries from generations whose POST
      // failed simply won't match — safe fallback: Output keeps showing
      // them and the user can dismiss via the × on the Output card.
      const store = useHistoryStore.getState();
      const toRemove = store.entries
        .filter((e) => e.serverGenId === gen.id)
        .map((e) => e.id);
      for (const id of toRemove) store.remove(id);

      toast.success("Удалено");
      void refetch();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Delete failed");
    }
  }

  function resetDateRange() {
    setDateRange({
      from: new Date(Date.now() - 7 * 86400000),
      to: new Date(),
    });
  }

  if (!open) return null;

  return (
    <div
      className={cn(
        "flex h-full w-[340px] shrink-0 flex-col overflow-hidden rounded-lg border border-border bg-background shadow-md animate-fade-in",
        className
      )}
    >
      {/* Header */}
      <div className="border-b border-border">
        <div className="flex items-center justify-between p-4">
          <div className="flex items-center gap-2">
            <Button
              variant="ghost"
              size="icon"
              className="h-8 w-8"
              onClick={() => setOpen(false)}
              aria-label="Close history"
            >
              <ChevronRight className="h-4 w-4" />
            </Button>
            <History className="h-5 w-5" />
            <span className="font-semibold">История генераций</span>
          </div>
          <div className="flex items-center gap-1">
            <Button
              variant={filtersOpen ? "secondary" : "ghost"}
              size="icon"
              className="h-7 w-7"
              onClick={() => setFiltersOpen((v) => !v)}
              title="Фильтры"
            >
              <SlidersHorizontal className="h-3.5 w-3.5" />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7"
              onClick={() => void refetch()}
              disabled={loading}
              title="Обновить"
            >
              <RefreshCw className={cn("h-3.5 w-3.5", loading && "animate-spin")} />
            </Button>
          </div>
        </div>
        {filtersOpen && (
          <div className="space-y-2 px-4 pb-3">
            <div className="flex items-center gap-2">
              <label className="w-8 text-xs text-muted-foreground">От</label>
              <input
                type="date"
                value={toDateInput(dateRange.from)}
                onChange={(e) =>
                  setDateRange((r) => ({ ...r, from: new Date(e.target.value) }))
                }
                className="flex-1 rounded border border-border bg-background px-2 py-1 text-xs"
              />
            </div>
            <div className="flex items-center gap-2">
              <label className="w-8 text-xs text-muted-foreground">До</label>
              <input
                type="date"
                value={toDateInput(dateRange.to)}
                onChange={(e) =>
                  setDateRange((r) => ({ ...r, to: new Date(e.target.value) }))
                }
                className="flex-1 rounded border border-border bg-background px-2 py-1 text-xs"
              />
            </div>
            <Button
              variant="outline"
              size="sm"
              className="h-7 w-full text-xs"
              onClick={resetDateRange}
            >
              Сбросить (7 дней)
            </Button>
          </div>
        )}
        <div className="px-4 pb-2 text-xs text-muted-foreground">
          {username ? (
            <>
              <span className="font-medium text-foreground">{username}</span>
              {" · "}Записей:{" "}
              <span className="font-medium text-foreground">{visibleItems.length}</span>
            </>
          ) : (
            <span>Никнейм не задан</span>
          )}
        </div>
      </div>

      {/* Scrollable list */}
      <div className="flex-1 overflow-y-auto p-4">
        {error ? (
          <div className="rounded border border-destructive/30 bg-destructive/5 p-3 text-xs text-destructive">
            {error}
          </div>
        ) : loading && visibleItems.length === 0 ? (
          <div className="flex h-full items-center justify-center py-8 text-xs text-muted-foreground">
            Загрузка...
          </div>
        ) : visibleItems.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center gap-3 py-8 text-center">
            <History className="h-12 w-12 text-muted-foreground/40" />
            <div className="space-y-1">
              <h3 className="text-sm font-medium">Пока пусто</h3>
              <p className="text-xs text-muted-foreground">
                Здесь появятся все прошлые генерации
              </p>
            </div>
          </div>
        ) : (
          <div className="flex flex-col items-center gap-6">
            {visibleItems.map((g) => (
              <ServerEntryCard
                key={g.id}
                gen={g}
                onDelete={() => handleDelete(g)}
              />
            ))}
            {hasMore && (
              <Button
                variant="outline"
                size="sm"
                className="w-full text-xs"
                onClick={() => void loadMore()}
                disabled={isLoadingMore}
              >
                {isLoadingMore ? "Загрузка..." : "Load more"}
              </Button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function ServerEntryCard({
  gen,
  onDelete,
}: {
  gen: ServerGeneration;
  onDelete: () => void;
}) {
  const data = React.useMemo(() => parsePromptData(gen.prompt_data), [gen.prompt_data]);
  const firstImage = gen.outputs.find((o) => o.content_type.startsWith("image/"));
  const pendingEntry = isPending(gen) ? gen : null;
  const uploadError = pendingEntry?.uploadError;

  const thumbSrc = pendingEntry
    ? pendingEntry.thumbBlobUrl
    : firstImage
      ? imgUrl(firstImage.filepath, "thumb")
      : null;
  const midSrc = pendingEntry
    ? pendingEntry.midBlobUrl
    : firstImage
      ? imgUrl(firstImage.filepath, "mid")
      : null;
  const fullSrc = pendingEntry
    ? pendingEntry.fullBlobUrl
    : firstImage
      ? imgUrl(firstImage.filepath)
      : null;

  React.useEffect(() => {
    if (pendingEntry) mark(pendingEntry.uuid, "card-painted");
    // Only care about the first paint for this uuid. If the pending entry
    // updates (e.g. uploadError set), we don't re-mark — React runs this
    // effect again but the mark() call on "card-painted" triggers the
    // report which also GC-schedules. Subsequent re-marks just update the
    // timestamp and silently re-report; harmless.
  }, [pendingEntry]);

  // Local state so we can fall back thumb → original if the pre-rendered
  // thumbnail is missing on disk (legacy rows, failed resize, etc.).
  const [cardSrc, setCardSrc] = React.useState<string | null>(thumbSrc);
  const triedFullRef = React.useRef(false);
  React.useEffect(() => {
    setCardSrc(thumbSrc);
    triedFullRef.current = false;
  }, [thumbSrc]);

  const totalBytes = gen.outputs.reduce((sum, o) => sum + (o.size || 0), 0);
  const sizeLabel =
    totalBytes > 0 ? `${(totalBytes / (1024 * 1024)).toFixed(2)} MB` : null;

  // SQLite stores datetime as 'YYYY-MM-DD HH:MM:SS' in UTC. Append Z for parsing.
  const createdAtMs = React.useMemo(() => {
    const iso = gen.created_at.includes("T")
      ? gen.created_at
      : gen.created_at.replace(" ", "T") + "Z";
    const t = Date.parse(iso);
    return Number.isNaN(t) ? Date.now() : t;
  }, [gen.created_at]);

  async function handleCopy() {
    if (!data.prompt) return;
    const ok = await copyToClipboard(data.prompt);
    if (ok) toast.success("Промпт скопирован", { duration: 1500 });
  }

  return (
    <div className="flex w-full flex-col items-center">
      <div className="mb-2">
        {cardSrc && fullSrc && midSrc ? (
          <ImageDialog
            entry={serverGenToHistoryEntry(gen, data, midSrc)}
            downloadUrl={fullSrc}
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={cardSrc}
              alt={data.prompt || "generation"}
              width={140}
              height={140}
              loading="lazy"
              draggable
              onDragStart={(e) => {
                // Drop carries the FULL-RESOLUTION URL, not the thumb /
                // mid preview. The dropzone fetches this URL on drop and
                // ingests the original file. MIME matches viewcomfy's so
                // the same payload works in both apps.
                const payload = {
                  url: fullSrc!,
                  filename: firstImage!.filename,
                  contentType: firstImage!.content_type,
                };
                e.dataTransfer.setData(
                  "application/x-viewcomfy-media",
                  JSON.stringify(payload)
                );
                e.dataTransfer.effectAllowed = "copy";
              }}
              className="h-[140px] w-[140px] cursor-zoom-in rounded-md border border-border object-cover transition-all hover:scale-[1.03] hover:shadow-md"
              onError={() => {
                if (!triedFullRef.current && fullSrc && cardSrc !== fullSrc) {
                  triedFullRef.current = true;
                  setCardSrc(fullSrc);
                }
              }}
            />
          </ImageDialog>
        ) : (
          <div className="flex h-[140px] w-[140px] items-center justify-center rounded-md border border-border bg-muted">
            <History className="h-6 w-6 text-muted-foreground/40" />
          </div>
        )}
      </div>

      {uploadError && pendingEntry?.retry && (
        <div className="mb-2 flex items-center gap-2 rounded border border-destructive/40 bg-destructive/5 px-2 py-1 text-xs text-destructive">
          <span title={uploadError}>Not saved</span>
          <Button
            variant="outline"
            size="sm"
            className="h-5 px-2 py-0 text-xs"
            onClick={() => pendingEntry.retry?.()}
          >
            Retry
          </Button>
        </div>
      )}

      <div className="flex w-full items-center justify-between gap-2 text-xs text-muted-foreground">
        <div className="flex min-w-0 items-center gap-1.5">
          {sizeLabel && <span className="truncate">{sizeLabel} - </span>}
          <span>Prompt:</span>
          <Button
            variant="outline"
            size="icon"
            className="h-5 w-5"
            onClick={handleCopy}
            disabled={!data.prompt}
            title="Copy prompt"
          >
            <Copy className="h-3 w-3" />
          </Button>
        </div>
        <Button
          variant="ghost"
          size="icon"
          className="h-6 w-6 text-muted-foreground/50 hover:text-destructive"
          onClick={onDelete}
          title="Remove"
        >
          <Trash2 className="h-3.5 w-3.5" />
        </Button>
      </div>

      {data.prompt && (
        <div className="mt-1 w-full">
          <p className="line-clamp-3 text-xs italic text-muted-foreground">
            {data.prompt}
          </p>
        </div>
      )}

      <div className="mt-1 w-full text-xs text-muted-foreground">
        {gen.execution_time_seconds > 0 && (
          <>execution: {gen.execution_time_seconds.toFixed(1)}s - </>
        )}
        {gen.workflow_name && (
          <span className="truncate">{gen.workflow_name} - </span>
        )}
        <span>{formatFullDate(createdAtMs)}</span>
      </div>
    </div>
  );
}
