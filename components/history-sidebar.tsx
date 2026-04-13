"use client";

import * as React from "react";
import { History, ChevronRight, Copy, Trash2, SlidersHorizontal } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { ImageDialog } from "@/components/image-dialog";
import { useUser } from "@/app/providers/user-provider";
import { cn, copyToClipboard, formatFullDate } from "@/lib/utils";
import { preloadImages } from "@/lib/image-cache";
import {
  useHistoryEntries,
  deleteEntry,
  type HistoryEntry,
} from "@/lib/history";
import { usePromptStore } from "@/stores/prompt-store";
import { BlurUpImage } from "@/components/blur-up-image";

export interface HistorySidebarProps {
  open: boolean;
  setOpen: (open: boolean) => void;
  className?: string;
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

  const range = React.useMemo(
    () => ({ from: dateRange.from, to: dateRange.to }),
    [dateRange.from, dateRange.to]
  );

  const {
    entries,
    hasMore,
    isLoading,
    isLoadingMore,
    error,
    loadMore,
  } = useHistoryEntries({
    username,
    range,
  });

  // Warm browser cache for thumb + mid variants of server-backed entries.
  // Pending entries already carry blob URLs in memory.
  React.useEffect(() => {
    if (entries.length === 0) return;
    const urls: string[] = [];
    for (const e of entries) {
      if (e.state === "pending") continue;
      if (e.thumbUrl) urls.push(e.thumbUrl);
      if (e.outputUrl) urls.push(e.outputUrl);
    }
    preloadImages(urls);
  }, [entries]);

  // Single removal path. Idempotent — covers pending (abort + revoke),
  // live (optimistic transition + DELETE), and cross-device events
  // (broadcast / SSE go through the same function with skipServerDelete).
  async function handleDelete(entry: HistoryEntry) {
    if (!confirm("Удалить эту запись из истории?")) return;
    await deleteEntry(entry.id);
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
              <span className="font-medium text-foreground">{entries.length}</span>
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
        ) : isLoading && entries.length === 0 ? (
          <div className="flex flex-col items-center gap-6">
            {Array.from({ length: 3 }).map((_, i) => (
              <div
                key={i}
                className="h-[140px] w-[140px] animate-pulse rounded-md border border-border bg-muted/60"
              />
            ))}
          </div>
        ) : entries.length === 0 ? (
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
            {entries.map((entry, idx) => (
              <EntryCard
                key={entry.id}
                entry={entry}
                onDelete={() => handleDelete(entry)}
                siblings={entries}
                index={idx}
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

function EntryCard({
  entry,
  onDelete,
  siblings,
  index,
}: {
  entry: HistoryEntry;
  onDelete: () => void;
  siblings: HistoryEntry[];
  index: number;
}) {
  const isPending = entry.state === "pending";
  const uploadError = entry.uploadError;

  const thumbSrc = entry.thumbUrl ?? entry.outputUrl ?? null;
  const fullSrc = entry.originalUrl ?? entry.outputUrl ?? null;

  // Local fallback thumb → original if the pre-rendered thumb is missing
  // on disk (legacy rows, failed resize, etc.).
  const [cardSrc, setCardSrc] = React.useState<string | null>(thumbSrc);
  const triedFullRef = React.useRef(false);
  React.useEffect(() => {
    setCardSrc(thumbSrc);
    triedFullRef.current = false;
  }, [thumbSrc]);

  const sizeLabel =
    entry.outputSizeBytes && entry.outputSizeBytes > 0
      ? `${(entry.outputSizeBytes / (1024 * 1024)).toFixed(2)} MB`
      : null;

  async function handleCopy() {
    if (!entry.prompt) return;
    const ok = await copyToClipboard(entry.prompt);
    if (ok) {
      usePromptStore.getState().setPrompt(entry.prompt);
      toast.success("Промпт применён и скопирован", { duration: 1500 });
    }
  }

  const thumbJsx = cardSrc && fullSrc ? (
    <BlurUpImage
      sharpSrc={cardSrc}
      alt={entry.prompt || "generation"}
      draggable
      onDragStart={(e) => {
        const ext = entry.outputFormat === "jpeg" ? "jpeg" : "png";
        const payload = {
          url: fullSrc,
          filename: `wavespeed-${entry.taskId || entry.id}.${ext}`,
          contentType: `image/${ext}`,
        };
        e.dataTransfer.setData(
          "application/x-viewcomfy-media",
          JSON.stringify(payload)
        );
        e.dataTransfer.effectAllowed = "copy";
      }}
      fit="cover"
      revealMs={500}
      className="h-[140px] w-[140px] cursor-zoom-in rounded-md border border-border transition-all hover:scale-[1.03] hover:shadow-md"
      onError={() => {
        if (!triedFullRef.current && cardSrc !== fullSrc) {
          triedFullRef.current = true;
          setCardSrc(fullSrc);
        }
      }}
    />
  ) : null;

  return (
    <div className="flex w-full flex-col items-center">
      <div className="mb-2">
        {thumbJsx ? (
          <ImageDialog
            entry={entry}
            downloadUrl={fullSrc ?? undefined}
            siblings={siblings.length > 1 ? siblings : undefined}
            initialIndex={index}
          >
            {thumbJsx}
          </ImageDialog>
        ) : isPending ? (
          <div className="h-[140px] w-[140px] animate-pulse rounded-md border border-border bg-muted/80" />
        ) : (
          <div className="flex h-[140px] w-[140px] items-center justify-center rounded-md border border-border bg-muted">
            <History className="h-6 w-6 text-muted-foreground/40" />
          </div>
        )}
      </div>

      {uploadError && isPending && (
        <div className="mb-2 flex items-center gap-2 rounded border border-destructive/40 bg-destructive/5 px-2 py-1 text-xs text-destructive">
          <span title={uploadError}>Not saved</span>
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
            disabled={!entry.prompt}
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

      {entry.prompt && (
        <div className="mt-1 w-full">
          <p className="line-clamp-3 text-xs italic text-muted-foreground">
            {entry.prompt}
          </p>
        </div>
      )}

      <div className="mt-1 w-full text-xs text-muted-foreground">
        {entry.executionTimeMs && entry.executionTimeMs > 0 && (
          <>execution: {(entry.executionTimeMs / 1000).toFixed(1)}s - </>
        )}
        {entry.workflowName && (
          <span className="truncate">{entry.workflowName} - </span>
        )}
        <span>{formatFullDate(entry.createdAt)}</span>
      </div>
    </div>
  );
}
