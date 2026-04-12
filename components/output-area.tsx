"use client";

import * as React from "react";
import { Loader2, AlertCircle, History, ImageIcon, Trash2, X, Download, Copy } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { ImageDialog } from "@/components/image-dialog";
import { useHistoryStore } from "@/stores/history-store";
import { usePromptStore } from "@/stores/prompt-store";
import { cancelGeneration } from "@/components/generate-form";
import { cn, copyToClipboard, startOfToday } from "@/lib/utils";
import type { HistoryEntry } from "@/types/wavespeed";
import { useUser } from "@/app/providers/user-provider";
import { useHistory, extractUuid, type ServerGeneration } from "@/hooks/use-history";
import { useGenerationEvents } from "@/hooks/use-generation-events";
import { parsePromptData, serverGenToHistoryEntry } from "@/lib/server-gen-adapter";
import {
  subscribe as subscribePending,
  getAll as getAllPending,
} from "@/lib/pending-history";

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

  const { username } = useUser();
  // Fetch today's server-backed generations for this username. This
  // picks up completed rows from other devices. The endpoint filters
  // by date using ISO strings; we pass start/end of the local "today".
  const todayDateRange = React.useMemo(() => {
    const now = new Date();
    const start = new Date(now);
    start.setHours(0, 0, 0, 0);
    const end = new Date(now);
    end.setHours(23, 59, 59, 999);
    return { startDate: start, endDate: end };
  }, []);
  const { items: serverToday } = useHistory({
    username,
    startDate: todayDateRange.startDate,
    endDate: todayDateRange.endDate,
  });
  // Subscribe to server-pushed history events for near-real-time
  // cross-device sync. No-op when username is null.
  useGenerationEvents(username);

  // Pending uploads on THIS device. Used below to suppress the race
  // window where the SSE `generation.created` event arrives before
  // the POST response has set `serverGenId` on the local Zustand
  // entry — without this, the same generation briefly renders twice
  // (local blob-URL card + server mid-URL card).
  const pending = React.useSyncExternalStore(
    subscribePending,
    getAllPending,
    getAllPending
  );

  // Show today's entries (newest first), capped at the last 10. The cap
  // keeps the Output strip short and predictable even after a long
  // generation session, while still respecting the "only today" boundary
  // — nothing from yesterday ever leaks in.
  const todayStart = React.useMemo(() => startOfToday(), []);

  const todayEntries = React.useMemo(() => {
    // Zustand entries for today (may include in-flight + optimistic).
    const local = entries.filter((e) => e.createdAt >= todayStart);
    // Keys already present locally — don't duplicate them from server.
    const localServerGenIds = new Set(
      local.map((e) => e.serverGenId).filter((x): x is number => typeof x === "number")
    );
    // Uuids of uploads still in flight from THIS device. Covers the
    // race window before `serverGenId` lands on the Zustand entry.
    const pendingUuids = new Set(pending.map((p) => p.uuid.toLowerCase()));

    // Server entries that are NOT represented by a local Zustand row.
    // These are cross-device completions (or rows from a reload where
    // the optimistic local entry was not persisted).
    const remote: HistoryEntry[] = [];
    for (const gen of serverToday as ServerGeneration[]) {
      if (localServerGenIds.has(gen.id)) continue;
      const firstImage = gen.outputs.find((o) =>
        o.content_type.startsWith("image/")
      );
      if (!firstImage) continue;
      const genUuid = extractUuid(firstImage.filepath);
      if (genUuid && pendingUuids.has(genUuid)) continue;
      const data = parsePromptData(gen.prompt_data);
      const base = firstImage.filepath.replace(/\.[^.]+$/, "");
      const thumbUrl = `/api/history/image/${encodeURIComponent(`thumb_${base}.jpg`)}`;
      const midUrl = `/api/history/image/${encodeURIComponent(`mid_${base}.jpg`)}`;
      const fullUrl = `/api/history/image/${encodeURIComponent(firstImage.filepath)}`;
      const adapted = serverGenToHistoryEntry(gen, data, midUrl);
      // The adapter uses `fullSrc` as `outputUrl`. Add preview/original
      // so Output-area's existing preview/originalUrl reads work the
      // same way they do for Zustand entries.
      remote.push({
        ...adapted,
        previewUrl: midUrl,
        originalUrl: fullUrl,
        outputUrl: midUrl,
        thumbUrl,
      });
    }

    // Merge and sort desc by createdAt. Cap at 10.
    const merged = [...local, ...remote].sort(
      (a, b) => b.createdAt - a.createdAt
    );
    return merged.slice(0, 10);
  }, [entries, todayStart, serverToday, pending]);

  // Trash handler for Output cards. Two categories:
  //   1) Local-only entry (no serverGenId — POST failed or legacy row):
  //      silent Zustand dismiss, no confirm, no network. Such a row
  //      is not in the server DB, so symmetry with History is trivial
  //      (History never rendered it either).
  //   2) Server-backed entry (has serverGenId — either a local entry
  //      that reached the server, or a remote serverToday row): confirm,
  //      DELETE /api/history, toast. Zustand cleanup happens via the
  //      SSE generation.deleted event landing in useGenerationEvents
  //      (single source of truth for cross-tab/device consistency).
  const handleRemove = React.useCallback(
    async (entry: HistoryEntry) => {
      if (typeof entry.serverGenId !== "number") {
        remove(entry.id);
        return;
      }
      if (!username) return;
      if (!confirm("Удалить эту запись из истории?")) return;
      try {
        const res = await fetch(
          `/api/history?id=${entry.serverGenId}&username=${encodeURIComponent(username)}`,
          { method: "DELETE" }
        );
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        toast.success("Удалено");
      } catch (e) {
        toast.error(e instanceof Error ? e.message : "Delete failed");
      }
    },
    [remove, username]
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
                onRemove={() => handleRemove(entry)}
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
              if (ok) {
                usePromptStore.getState().setPrompt(entry.prompt);
                toast.success("Промпт применён и скопирован", { duration: 1500 });
              }
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
