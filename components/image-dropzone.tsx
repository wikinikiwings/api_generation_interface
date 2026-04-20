"use client";

import * as React from "react";
import { Loader2, Plus, X } from "lucide-react";
import { toast } from "sonner";
import { cn, fileToDataURL } from "@/lib/utils";
import {
  optimizeForUpload,
  buildSuccessMessage,
  plural,
} from "@/lib/image-optimize";
import { Button } from "@/components/ui/button";

export interface DroppedImage {
  id: string;
  file: File;
  dataUrl: string;
  /** Natural pixel dimensions of the source image. Used by seedream
   *  providers to honor "Auto (match input)" aspect ratio — nano-banana
   *  models infer this server-side, but seedream needs an explicit size. */
  width: number;
  height: number;
  /** Absent = "ready". While "processing", `dataUrl` is a blob URL of
   *  the pre-optimization original and the tile shows a spinner
   *  overlay. The `×` and drag handlers are skipped for processing
   *  entries to avoid racing with the worker pool. */
  status?: "processing" | "ready";
}

/** Read natural width/height from a base64 data URL. Returns 0,0 on failure. */
function readImageDimensions(dataUrl: string): Promise<{ width: number; height: number }> {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve({ width: img.naturalWidth, height: img.naturalHeight });
    img.onerror = () => resolve({ width: 0, height: 0 });
    img.src = dataUrl;
  });
}

export interface ImageDropzoneProps {
  value: DroppedImage[];
  onChange: (images: DroppedImage[]) => void;
  maxImages?: number;
}

const ACCEPTED = "image/png,image/jpeg,image/webp,image/gif";

export function ImageDropzone({
  value,
  onChange,
  maxImages = 14,
}: ImageDropzoneProps) {
  const inputRef = React.useRef<HTMLInputElement>(null);
  const [isDragging, setIsDragging] = React.useState(false);
  const [draggedId, setDraggedId] = React.useState<string | null>(null);
  const [dragOverId, setDragOverId] = React.useState<string | null>(null);

  const remaining = maxImages - value.length;

  // Mirror the latest `value` in a ref so async ingestion paths
  // (drag-from-history fetch, paste handler, multi-file desktop drops)
  // see fresh state and don't accidentally overwrite each other when
  // their async work resolves out of order. Without this, two
  // simultaneous drag-from-history operations would race on the parent
  // setImages call and the second would clobber the first.
  const valueRef = React.useRef(value);
  React.useEffect(() => {
    valueRef.current = value;
  }, [value]);

  // On unmount, revoke any leftover blob URLs created for placeholders.
  // Individual `onFileComplete` callbacks revoke on replacement, and the
  // error path revokes on removal — this catches the edge case where the
  // user navigates away mid-optimization.
  React.useEffect(() => {
    return () => {
      for (const img of valueRef.current) {
        if (img.dataUrl.startsWith("blob:")) {
          URL.revokeObjectURL(img.dataUrl);
        }
      }
    };
  }, []);

  const buildId = React.useCallback(
    (file: File) =>
      `${file.name}-${file.size}-${file.lastModified}-${Math.random()
        .toString(36)
        .slice(2, 6)}`,
    []
  );

  const handleFiles = React.useCallback(
    async (filesArg: FileList | File[]) => {
      const arr = Array.from(filesArg).filter((f) => f.type.startsWith("image/"));
      if (arr.length === 0) return;

      const current = valueRef.current;
      const room = maxImages - current.length;
      const toProcess = arr.slice(0, room);
      if (toProcess.length === 0) {
        toast.error(`Лимит ${maxImages} изображений достигнут`);
        return;
      }

      // 1. Insert blob-URL placeholders into value immediately.
      const placeholders: DroppedImage[] = toProcess.map((f) => ({
        id: buildId(f),
        file: f,
        dataUrl: URL.createObjectURL(f),
        width: 0,
        height: 0,
        status: "processing" as const,
      }));
      const placeholderIds = placeholders.map((p) => p.id);
      const nextValuePlaceholders = [...valueRef.current, ...placeholders];
      valueRef.current = nextValuePlaceholders;
      onChange(nextValuePlaceholders);

      // Yield one frame. The inline valueRef update below closes the race
      // against fast onFileComplete callbacks, but this rAF still lets the
      // browser paint the placeholder spinners before heavy optimize work
      // starts.
      await new Promise<void>((resolve) =>
        requestAnimationFrame(() => resolve())
      );

      // 2. Kick off optimization with per-file replacement callback.
      const promise = optimizeForUpload(toProcess, {
        onFileComplete: async (index, result) => {
          const id = placeholderIds[index];
          const previous = valueRef.current.find((e) => e.id === id);
          // Previous entry's dataUrl is a blob URL OR the pass-1 data URL
          // (if pass 2 fires for the same slot). Revoke only blob URLs.
          if (previous && previous.dataUrl.startsWith("blob:")) {
            URL.revokeObjectURL(previous.dataUrl);
          }

          let dataUrl = "";
          let dims = { width: 0, height: 0 };
          try {
            dataUrl = await fileToDataURL(result.file);
            dims = await readImageDimensions(dataUrl);
          } catch (err) {
            console.error("Failed to finalize optimized file", result.file.name, err);
            // Fall through with empty dataUrl — tile will break but other
            // files proceed. The top-level catch below still reports.
          }

          const ready: DroppedImage = {
            id,
            file: result.file,
            dataUrl,
            width: dims.width,
            height: dims.height,
            status: "ready",
          };
          // Replace by id; if the placeholder was removed, map is a no-op.
          const nextValueReady = valueRef.current.map((e) => (e.id === id ? ready : e));
          valueRef.current = nextValueReady;
          onChange(nextValueReady);
        },
      });

      // 3. Single summary toast for the whole batch.
      await toast.promise(promise, {
        loading: `Обрабатываю ${toProcess.length} ${plural(toProcess.length)}...`,
        success: (r) => buildSuccessMessage(r, toProcess.length),
        error: "Не удалось обработать изображения",
      });

      const result = await promise;

      // 4. Side-effect toasts + cleanup of errored placeholders.
      if (result.aggregatePass2Triggered) {
        toast.warning(
          "Суммарный размер превысил лимит — сжатие усилено"
        );
      }
      if (result.errors.length > 0) {
        toast.error(
          result.errors.length === 1
            ? "1 файл не удалось прочитать"
            : `${result.errors.length} файл(ов) не удалось прочитать`
        );
        const erroredIds = new Set<string>();
        result.errors.forEach((e) => {
          const idx = toProcess.findIndex((f) => f.name === e.fileName);
          if (idx >= 0) erroredIds.add(placeholderIds[idx]);
        });
        // Revoke blob URLs of errored placeholders before removing.
        valueRef.current
          .filter((e) => erroredIds.has(e.id) && e.dataUrl.startsWith("blob:"))
          .forEach((e) => URL.revokeObjectURL(e.dataUrl));
        const nextValueFiltered = valueRef.current.filter((e) => !erroredIds.has(e.id));
        valueRef.current = nextValueFiltered;
        onChange(nextValueFiltered);
      }
    },
    [onChange, maxImages, buildId]
  );

  // Keep the latest handleFiles + remaining in a ref so the global paste
  // listener (registered once on mount) always sees current values without
  // re-subscribing on every render.
  const handleFilesRef = React.useRef(handleFiles);
  const remainingRef = React.useRef(remaining);
  React.useEffect(() => {
    handleFilesRef.current = handleFiles;
    remainingRef.current = remaining;
  }, [handleFiles, remaining]);

  // Global Ctrl+V handler. We listen on the window so the user can paste
  // from anywhere on the page without first focusing the dropzone. We
  // only intercept the event when the clipboard actually contains an
  // image — plain-text paste keeps its default behavior, so pasting text
  // into the prompt textarea is unaffected.
  React.useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      if (!e.clipboardData) return;
      const items = e.clipboardData.items;
      if (!items || items.length === 0) return;

      const imageFiles: File[] = [];
      for (let i = 0; i < items.length; i++) {
        const item = items[i];
        if (item.kind !== "file") continue;
        if (!item.type.startsWith("image/")) continue;
        const file = item.getAsFile();
        if (!file) continue;
        // Clipboard files often arrive with empty or generic names. Give
        // them a unique synthetic name so the id-builder in handleFiles
        // doesn't collide across multiple pastes.
        const ext = file.type.split("/")[1] || "png";
        const name =
          file.name && file.name !== "image.png"
            ? file.name
            : `pasted-${Date.now()}-${i}.${ext}`;
        imageFiles.push(
          new File([file], name, {
            type: file.type,
            lastModified: file.lastModified || Date.now(),
          })
        );
      }

      if (imageFiles.length === 0) return; // No images — leave default paste alone.

      // We have at least one image. Block default paste (otherwise
      // browsers may also insert the image into a focused contenteditable
      // or textarea as base64) and route to the dropzone.
      e.preventDefault();

      if (remainingRef.current <= 0) {
        toast.error(`Лимит ${maxImages} изображений достигнут`);
        return;
      }

      void handleFilesRef.current(imageFiles);
      const added = Math.min(imageFiles.length, remainingRef.current);
      toast.success(
        added === 1
          ? "Изображение вставлено из буфера"
          : `Вставлено из буфера: ${added}`,
        { duration: 1500 }
      );
    };

    window.addEventListener("paste", onPaste);
    return () => window.removeEventListener("paste", onPaste);
  }, [maxImages]);

  const handleRemove = (id: string) => {
    onChange(value.filter((img) => img.id !== id));
  };

  // Reorder: move `fromId` to the position of `toId`. If `toId` is null,
  // append to the end. No-op when source and target are the same.
  const reorder = (fromId: string, toId: string | null) => {
    if (fromId === toId) return;
    const fromIdx = value.findIndex((img) => img.id === fromId);
    if (fromIdx === -1) return;
    // Resolve target index in the ORIGINAL array before removal. Using the
    // post-splice index shifts forward moves one slot too early (drag #1 → #4
    // would land at #3).
    const toIdx = toId === null ? -1 : value.findIndex((img) => img.id === toId);
    const next = value.slice();
    const [moved] = next.splice(fromIdx, 1);
    if (toId === null || toIdx === -1) {
      next.push(moved);
    } else {
      next.splice(toIdx, 0, moved);
    }
    onChange(next);
  };

  const onDrop = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setIsDragging(false);

    // Priority 1: custom MIME from history sidebar (or viewcomfy-claude
    // — same payload format). Carries a server URL pointing at the
    // FULL-RESOLUTION original, which we fetch + ingest as a real File
    // so the dropzone gets the best-quality version, not the thumbnail
    // the user was dragging visually.
    const mediaJson = e.dataTransfer.getData("application/x-viewcomfy-media");
    if (mediaJson) {
      void ingestMediaPayload(mediaJson);
      return;
    }

    // Priority 2: native files dragged from OS / desktop.
    if (e.dataTransfer.files?.length) {
      void handleFiles(e.dataTransfer.files);
    }
  };

  /**
   * Fetch a full-resolution image from a server URL (carried via the
   * custom drag MIME) and ingest it as a File through the same
   * handleFiles pipeline that desktop drops use. Shows a sonner
   * loading toast that resolves on success or rejects on failure.
   */
  async function ingestMediaPayload(json: string) {
    let payload: { url?: string; filename?: string; contentType?: string };
    try {
      payload = JSON.parse(json);
    } catch {
      toast.error("Не удалось прочитать данные перетаскивания");
      return;
    }
    if (!payload.url) {
      toast.error("Отсутствует URL изображения");
      return;
    }
    if (remaining <= 0) {
      toast.error(`Лимит ${maxImages} изображений достигнут`);
      return;
    }

    await toast.promise(
      (async () => {
        const res = await fetch(payload.url!, { cache: "no-store" });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const blob = await res.blob();
        const filename = payload.filename || `image-${Date.now()}.png`;
        const file = new File([blob], filename, {
          type: payload.contentType || blob.type || "image/png",
        });
        await handleFiles([file]);
      })(),
      {
        loading: "Загружаю оригинал...",
        success: "Добавлено в исходном качестве",
        error: (e) => `Ошибка: ${e instanceof Error ? e.message : String(e)}`,
      }
    );
  }

  return (
    <div
      onDragOver={(e) => {
        // Internal tile reorder fires outer dragOver when the dragged
        // tile moves over empty grid space inside the box. Early-return
        // so the outer highlight doesn't flicker during a reorder.
        if (draggedId) return;
        e.preventDefault();
        setIsDragging(true);
      }}
      onDragLeave={() => setIsDragging(false)}
      onDrop={onDrop}
      onClick={() => inputRef.current?.click()}
      className={cn(
        "relative cursor-pointer space-y-3 rounded-lg border-2 border-dashed border-border bg-muted/30 p-3 transition-colors",
        "hover:border-primary/50 hover:bg-muted/50",
        isDragging && "border-primary bg-primary/5",
        remaining === 0 && "pointer-events-none opacity-50"
      )}
    >
      <div className="grid grid-cols-3 gap-2 sm:grid-cols-4 md:grid-cols-5">
        {value.map((img, idx) => {
          const isProcessing = img.status === "processing";
          return (
            <div
              key={img.id}
              draggable={!isProcessing}
              onDragStart={(e) => {
                if (isProcessing) return;
                setDraggedId(img.id);
                e.dataTransfer.effectAllowed = "move";
                e.dataTransfer.setData("text/plain", img.id);
              }}
              onDragEnd={() => {
                setDraggedId(null);
                setDragOverId(null);
              }}
              onDragOver={(e) => {
                if (!draggedId || isProcessing) return;
                e.preventDefault();
                e.stopPropagation();
                e.dataTransfer.dropEffect = "move";
                if (dragOverId !== img.id) setDragOverId(img.id);
              }}
              onDragLeave={(e) => {
                if (!draggedId) return;
                e.stopPropagation();
                if (dragOverId === img.id) setDragOverId(null);
              }}
              onDrop={(e) => {
                if (!draggedId || isProcessing) return;
                e.preventDefault();
                e.stopPropagation();
                reorder(draggedId, img.id);
                setDraggedId(null);
                setDragOverId(null);
              }}
              className={cn(
                "group relative aspect-square overflow-hidden rounded-md border border-border bg-background p-1 transition-all",
                !isProcessing && "cursor-grab active:cursor-grabbing",
                draggedId === img.id && "opacity-40",
                dragOverId === img.id &&
                  draggedId !== img.id &&
                  "ring-2 ring-primary ring-offset-1 ring-offset-background"
              )}
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={img.dataUrl}
                alt={img.file.name}
                draggable={false}
                className="h-full w-full select-none object-contain"
              />
              {isProcessing && (
                <div className="absolute inset-0 flex items-center justify-center bg-background/60 backdrop-blur-sm">
                  <Loader2 className="h-6 w-6 animate-spin text-primary" />
                </div>
              )}
              <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/70 to-transparent p-1.5">
                <span className="text-[10px] text-white">#{idx + 1}</span>
              </div>
              {!isProcessing && (
                <Button
                  type="button"
                  variant="destructive"
                  size="icon"
                  className="absolute right-1 top-1 h-6 w-6 opacity-0 transition-opacity group-hover:opacity-100"
                  onClick={(e) => {
                    e.stopPropagation();
                    handleRemove(img.id);
                  }}
                  aria-label="Remove image"
                >
                  <X className="h-3 w-3" />
                </Button>
              )}
            </div>
          );
        })}
        {remaining > 0 && (
          <div
            className={cn(
              "flex aspect-square cursor-pointer flex-col items-center justify-center gap-1 rounded-md border border-dashed border-border/70 bg-background/50 text-xs text-muted-foreground transition-colors",
              "hover:border-primary/50 hover:bg-muted/60"
            )}
            aria-label="Добавить изображение"
          >
            <Plus className="h-5 w-5" />
            <span>Добавить</span>
          </div>
        )}
      </div>
      <div className="text-xs text-muted-foreground">
        {remaining === 0
          ? `Лимит ${maxImages} изображений достигнут`
          : `PNG, JPEG, WebP · ${value.length}/${maxImages}`}
      </div>

      <input
        ref={inputRef}
        type="file"
        accept={ACCEPTED}
        multiple
        className="hidden"
        onChange={(e) => {
          if (e.target.files) void handleFiles(e.target.files);
          e.target.value = "";
        }}
      />
    </div>
  );
}
