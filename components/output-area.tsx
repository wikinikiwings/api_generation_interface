"use client";

import * as React from "react";
import { Loader2, AlertCircle, History, ImageIcon, Trash2, X, Download, Copy } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { ImageDialog } from "@/components/image-dialog";
import { useHistoryStore } from "@/stores/history-store";
import { cancelGeneration } from "@/components/generate-form";
import { cn, copyToClipboard, startOfToday } from "@/lib/utils";
import type { HistoryEntry } from "@/types/wavespeed";

export interface OutputAreaProps {
  historyOpen: boolean;
  onToggleHistory: () => void;
}

export function OutputArea({ historyOpen, onToggleHistory }: OutputAreaProps) {
  const entries = useHistoryStore((s) => s.entries);
  const remove = useHistoryStore((s) => s.remove);
  const [mounted, setMounted] = React.useState(false);

  React.useEffect(() => {
    setMounted(true);
  }, []);

  // Show today's entries (newest first), capped at the last 10. The cap
  // keeps the Output strip short and predictable even after a long
  // generation session, while still respecting the "only today" boundary
  // — nothing from yesterday ever leaks in.
  const todayStart = React.useMemo(() => startOfToday(), []);
  const todayEntries = React.useMemo(
    () =>
      entries
        .filter((e) => e.createdAt >= todayStart)
        .slice(0, 10),
    [entries, todayStart]
  );

  const hasAny = todayEntries.length > 0;

  return (
    <div className="relative flex h-full w-full flex-col overflow-hidden rounded-lg border border-border bg-muted/30">
      {/* Top-right controls */}
      <div className="pointer-events-none absolute inset-x-0 top-0 z-20 flex items-start justify-between p-3">
        <div className="pointer-events-auto">
          {mounted && hasAny && (
            <span className="rounded-md border border-border bg-background/80 px-2 py-1 text-[10px] font-medium text-muted-foreground backdrop-blur-sm">
              Output · сегодня
            </span>
          )}
        </div>
        {!historyOpen && (
          <div className="pointer-events-auto">
            <Button
              variant="outline"
              size="sm"
              onClick={onToggleHistory}
              className="bg-background/80 backdrop-blur-sm"
            >
              <History />
              История
            </Button>
          </div>
        )}
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto p-4 pt-14">
        {!mounted ? null : !hasAny ? (
          <EmptyState />
        ) : (
          <div className="flex flex-wrap gap-4">
            {todayEntries.map((entry, idx) => (
              <OutputCard
                key={entry.id}
                entry={entry}
                siblings={todayEntries}
                index={idx}
                onRemove={() => remove(entry.id)}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

interface OutputCardProps {
  entry: HistoryEntry;
  /** Full visible list — enables prev/next navigation inside the dialog. */
  siblings: HistoryEntry[];
  /** This entry's index inside `siblings`. */
  index: number;
  onRemove: () => void;
}

function OutputCard({ entry, siblings, index, onRemove }: OutputCardProps) {
  const isDone = entry.status === "completed" && !!entry.outputUrl;
  const isError = entry.status === "failed";
  const isCancelled = entry.status === "cancelled";
  const isLoading = entry.status === "pending" || entry.status === "processing";
  const [isDownloading, setIsDownloading] = React.useState(false);

  // Direct download from the Output card. Always pulls the FULL-RESOLUTION
  // original (originalUrl) regardless of what previewUrl shows in the
  // tile. Mirrors ImageDialog.handleDownload but inlined here so we don't
  // have to open the dialog first — a one-click flow.
  async function handleDirectDownload(e: React.MouseEvent) {
    e.stopPropagation();
    e.preventDefault();
    if (isDownloading) return;
    const url = entry.originalUrl ?? entry.outputUrl;
    if (!url) return;
    setIsDownloading(true);
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const blob = await res.blob();
      const objectUrl = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = objectUrl;
      a.download = `wavespeed-${entry.taskId || entry.id}.${entry.outputFormat}`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(objectUrl);
    } catch (err) {
      console.error("Direct download failed:", err);
    } finally {
      setIsDownloading(false);
    }
  }

  const cardBase =
    "group relative flex h-64 w-64 items-center justify-center overflow-hidden rounded-md bg-background/50 transition-all animate-fade-in";

  const card = (
    <div className={cn(cardBase, isDone && "cursor-zoom-in hover:shadow-md")}>
      {isDone && (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={entry.previewUrl ?? entry.outputUrl}
          alt={entry.prompt}
          draggable
          onDragStart={(e) => {
            // Carry the FULL-RESOLUTION URL via the same custom MIME the
            // History sidebar uses, so dropping back into the dropzone
            // re-ingests the original (not the mid preview the tile
            // visually shows).
            const dragUrl = entry.originalUrl ?? entry.outputUrl;
            if (!dragUrl) return;
            const payload = {
              url: dragUrl,
              filename: `wavespeed-${entry.taskId || entry.id}.${entry.outputFormat}`,
              contentType: `image/${entry.outputFormat === "jpeg" ? "jpeg" : "png"}`,
            };
            e.dataTransfer.setData(
              "application/x-viewcomfy-media",
              JSON.stringify(payload)
            );
            e.dataTransfer.effectAllowed = "copy";
          }}
          className="h-full w-full object-contain transition-transform group-hover:scale-[1.02]"
        />
      )}

      {isLoading && (
        <div className="flex flex-col items-center gap-2 text-center">
          <Loader2 className="h-6 w-6 animate-spin text-primary" />
          <span className="text-xs text-muted-foreground">
            {entry.status === "pending" ? "Отправка..." : "Генерация..."}
          </span>
        </div>
      )}

      {isError && (
        <div className="flex max-w-[220px] flex-col items-center gap-2 p-3 text-center">
          <AlertCircle className="h-6 w-6 text-destructive" />
          <p className="line-clamp-3 text-xs text-muted-foreground">
            {entry.error || "Ошибка"}
          </p>
        </div>
      )}

      {/* Prompt tooltip on hover — REMOVED in favor of the always-visible
          caption below the tile (see wrapped JSX). The hover overlay was
          duplicating the same text and obscuring the image on hover. */}

      {isCancelled && (
        <div className="flex flex-col items-center gap-2 text-center">
          <X className="h-6 w-6 text-muted-foreground" />
          <span className="text-xs text-muted-foreground">Отменено</span>
        </div>
      )}

      {/* Cancel button — visible during loading. Stops the upload fetch
          (free cancel if pre-submit) and / or the polling loop. */}
      {isLoading && (
        <Button
          variant="destructive"
          size="icon"
          className="absolute right-2 top-2 h-7 w-7"
          onClick={(e) => {
            e.stopPropagation();
            e.preventDefault();
            cancelGeneration(entry.id);
          }}
          aria-label="Cancel generation"
          title="Отменить генерацию"
        >
          <X className="h-3.5 w-3.5" />
        </Button>
      )}

      {/* Download button — visible on hover for completed images.
          Sits in the top-LEFT corner, mirroring the Trash2 in the
          top-right. Pulls the full-resolution original via originalUrl,
          not the mid preview the tile is showing. */}
      {isDone && (
        <Button
          variant="secondary"
          size="icon"
          className="absolute left-2 top-2 h-7 w-7 opacity-0 transition-opacity group-hover:opacity-100"
          onClick={handleDirectDownload}
          disabled={isDownloading}
          aria-label="Download original"
          title="Скачать в полном разрешении"
        >
          {isDownloading ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <Download className="h-3.5 w-3.5" />
          )}
        </Button>
      )}

      {/* Remove button — visible when not loading. */}
      {!isLoading && (
        <Button
          variant="destructive"
          size="icon"
          className="absolute right-2 top-2 h-7 w-7 opacity-0 transition-opacity group-hover:opacity-100"
          onClick={(e) => {
            e.stopPropagation();
            e.preventDefault();
            onRemove();
          }}
          aria-label="Remove"
        >
          <Trash2 className="h-3.5 w-3.5" />
        </Button>
      )}
    </div>
  );

  // Wrap card + caption in a single visual "card" with shared border,
  // background, and shadow so they read as one element instead of two
  // disconnected blocks. The inner tile keeps a slightly smaller radius
  // (rounded-md inside rounded-lg) which gives a natural inset look.
  // ImageDialog still wraps ONLY the tile so clicking the caption /
  // Copy button doesn't open the zoom dialog.
  const wrapped = (
    <div className="flex w-[272px] flex-col gap-2 rounded-lg border border-border bg-card p-2 shadow-sm transition-shadow hover:shadow-md">
      {isDone ? (
        <ImageDialog
          entry={entry}
          downloadUrl={entry.originalUrl ?? entry.outputUrl}
          siblings={siblings}
          initialIndex={index}
        >
          {card}
        </ImageDialog>
      ) : (
        card
      )}
      {entry.prompt && (
        <div className="flex w-full items-start gap-1.5 px-1">
          <p
            className="flex-1 line-clamp-3 text-xs italic text-muted-foreground"
            title={entry.prompt}
          >
            {entry.prompt}
          </p>
          <Button
            variant="ghost"
            size="icon"
            className="h-5 w-5 shrink-0 text-muted-foreground/60 hover:text-foreground"
            onClick={async (e) => {
              e.stopPropagation();
              e.preventDefault();
              const ok = await copyToClipboard(entry.prompt);
              if (ok) toast.success("Промпт скопирован", { duration: 1500 });
            }}
            title="Скопировать промпт"
            aria-label="Copy prompt"
          >
            <Copy className="h-3 w-3" />
          </Button>
        </div>
      )}
    </div>
  );
  return wrapped;
}

function EmptyState() {
  return (
    <div className="flex h-full min-h-[400px] flex-col items-center justify-center gap-3 text-center text-muted-foreground">
      <ImageIcon className="h-10 w-10 opacity-40" />
      <div className="space-y-1">
        <p className="text-sm font-medium text-foreground">
          Здесь появятся сегодняшние генерации
        </p>
        <p className="text-xs">
          Заполни форму слева и жми «Сгенерировать»
        </p>
      </div>
    </div>
  );
}
