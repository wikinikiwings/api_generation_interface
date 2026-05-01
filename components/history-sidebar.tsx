"use client";

import * as React from "react";
import { History, ChevronRight, Copy, Trash2, SlidersHorizontal, Sparkles, Wrench } from "lucide-react";
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
import { useSettingsStore } from "@/stores/settings-store";
import { BlurUpImage } from "@/components/blur-up-image";
import { type Style } from "@/lib/styles/types";
import { applyCopiedPrompt, joinStyleNames } from "@/lib/styles/apply-copied";
import { MyQuotasTab } from "@/components/my-quotas-tab";

export interface HistorySidebarProps {
  open: boolean;
  setOpen: (open: boolean) => void;
  className?: string;
  styles: Style[];
}

function toDateInput(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

export function HistorySidebar({ open, setOpen, className, styles }: HistorySidebarProps) {
  const { user } = useUser(); const username = user?.email ?? null;
  const [tab, setTab] = React.useState<"history" | "quotas">("history");
  const [filtersOpen, setFiltersOpen] = React.useState(false);
  const [dateRange, setDateRange] = React.useState<{ from: Date; to: Date }>(() => ({
    from: new Date(Date.now() - 7 * 86400000),
    to: new Date(),
  }));

  // Normalize the range to whole-day boundaries: "from" as start-of-day,
  // "to" as end-of-day. Without this, `to: new Date()` is the moment of
  // sidebar mount and any entry generated AFTER mount (createdAt > to)
  // gets filtered out — a freshly generated image wouldn't appear in
  // Sidebar until manual reload.
  const range = React.useMemo(() => {
    const from = new Date(dateRange.from);
    from.setHours(0, 0, 0, 0);
    const to = new Date(dateRange.to);
    to.setHours(23, 59, 59, 999);
    return { from, to };
  }, [dateRange.from, dateRange.to]);

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
              aria-label="Закрыть"
            >
              <ChevronRight className="h-4 w-4" />
            </Button>
            <Wrench className="h-5 w-5" />
            <span className="font-semibold">Настройки</span>
          </div>
        </div>
        {/* Tab strip */}
        <div className="flex border-t border-border">
          <button
            onClick={() => setTab("history")}
            className={cn(
              "flex-1 py-1.5 text-xs font-medium transition-colors",
              tab === "history"
                ? "border-b-2 border-primary text-foreground"
                : "text-muted-foreground hover:text-foreground"
            )}
          >
            История
          </button>
          <button
            onClick={() => setTab("quotas")}
            className={cn(
              "flex-1 py-1.5 text-xs font-medium transition-colors",
              tab === "quotas"
                ? "border-b-2 border-primary text-foreground"
                : "text-muted-foreground hover:text-foreground"
            )}
          >
            Мои лимиты
          </button>
        </div>

        {tab === "history" && (
          <>
            {/* History-only toolbar: filter toggle (left) + record count
                (right). Lives inside the history tab so it disappears on
                the quotas tab where neither applies. */}
            <div className="flex items-center justify-between px-4 pt-2">
              <Button
                variant={filtersOpen ? "secondary" : "ghost"}
                size="sm"
                className="h-7 gap-1.5 px-2 text-xs"
                onClick={() => setFiltersOpen((v) => !v)}
                title="Фильтры"
              >
                <SlidersHorizontal className="h-3.5 w-3.5" />
                Фильтр
              </Button>
              <span className="text-xs text-muted-foreground">
                Записей:{" "}
                <span className="font-medium text-foreground">{entries.length}</span>
              </span>
            </div>
            {filtersOpen && (
              <div className="space-y-2 px-4 pb-3 pt-1">
                <div className="flex items-center gap-2">
                  <label className="w-8 text-xs text-muted-foreground">От</label>
                  <input
                    type="date"
                    value={toDateInput(dateRange.from)}
                    max={toDateInput(dateRange.to)}
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
                    min={toDateInput(dateRange.from)}
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
          </>
        )}
      </div>

      {/* Content area */}
      {tab === "quotas" ? (
        <div className="flex-1 overflow-y-auto">
          <MyQuotasTab />
        </div>
      ) : (
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
                styles={styles}
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
      )}
    </div>
  );
}

function EntryCard({
  entry,
  onDelete,
  siblings,
  index,
  styles,
}: {
  entry: HistoryEntry;
  onDelete: () => void;
  siblings: HistoryEntry[];
  index: number;
  styles: Style[];
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
    if (!ok) return;
    applyCopiedPrompt(
      {
        prompt: entry.prompt,
        userPrompt: entry.userPrompt,
        styleIds: entry.styleIds,
      },
      styles,
      {
        setPrompt: (s) => usePromptStore.getState().setPrompt(s),
        setSelectedStyleIds: (ids) =>
          useSettingsStore.getState().setSelectedStyleIds(ids),
        toastInfo: (msg) => toast.success(msg, { duration: 1500 }),
        toastWarn: (msg) => toast.warning(msg, { duration: 3000 }),
      }
    );
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
    <div
      data-history-card
      data-state={entry.state}
      className="flex w-full flex-col items-center"
    >
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

      {(entry.userPrompt ?? entry.prompt) && (
        <div className="mt-1 w-full">
          <p className="line-clamp-3 text-xs italic text-muted-foreground">
            {entry.userPrompt ?? entry.prompt}
          </p>
          {entry.styleIds && entry.styleIds.length > 0 && (
            <span className="mt-0.5 inline-flex items-center gap-1 text-[10px] text-muted-foreground">
              <Sparkles className="h-3 w-3" />
              {entry.styleIds.length === 1 ? "Стиль" : "Стили"}: {joinStyleNames(entry.styleIds, styles)}
            </span>
          )}
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
