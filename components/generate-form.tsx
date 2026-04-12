"use client";

import * as React from "react";
import { Sparkles, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Select, Label } from "@/components/ui/select";
import { ImageDropzone, type DroppedImage } from "@/components/image-dropzone";
import { useHistoryStore } from "@/stores/history-store";
import { useSettingsStore } from "@/stores/settings-store";
import { MODELS_META } from "@/lib/providers/models";
import type { ModelId } from "@/lib/providers/types";
import { useUser } from "@/app/providers/user-provider";
import { triggerHistoryRefresh } from "@/components/history-sidebar";
import { fileToThumbnail, uuid } from "@/lib/utils";
import { createImageVariants } from "@/lib/image-variants";
import { uploadHistoryEntry, UploadError } from "@/lib/history-upload";
import { cacheBlob } from "@/lib/image-cache";
import * as pendingHistory from "@/lib/pending-history";
import type {
  AspectRatio,
  OutputFormat,
  Resolution,
  HistoryEntry,
  ProviderId,
} from "@/types/wavespeed";
import type {
  GenerateSubmitResponse,
  GenerateStatusResponse,
} from "@/lib/providers/types";

// ============================================================
// Provider selection is now managed by the admin panel.
// The form reads the active provider from the settings store;
// users change it via /admin (password-gated in production).
// ============================================================

/**
 * Model string stored in HistoryEntry.model per provider.
 * The string is mode-aware — it reflects which endpoint was actually hit
 * so history entries stay truthful for later filtering / debugging.
 */
function getModelString(provider: ProviderId, modelId: ModelId, hasImages: boolean): string {
  if (provider === "wavespeed") {
    return hasImages
      ? `google/${modelId}/edit`
      : `google/${modelId}/text-to-image`;
  }
  if (provider === "fal") {
    return hasImages
      ? `fal-ai/${modelId}/edit`
      : `fal-ai/${modelId}`;
  }
  return `comfy:${modelId}`;
}

const RESOLUTION_OPTIONS: { value: Resolution; label: string }[] = [
  { value: "1k", label: "1K (fast)" },
  { value: "2k", label: "2K (default)" },
  { value: "4k", label: "4K (max)" },
];

const ASPECT_OPTIONS: { value: string; label: string }[] = [
  { value: "", label: "Auto (match input)" },
  { value: "1:1", label: "1:1 square" },
  { value: "16:9", label: "16:9 landscape" },
  { value: "9:16", label: "9:16 portrait" },
  { value: "4:3", label: "4:3" },
  { value: "3:4", label: "3:4" },
  { value: "3:2", label: "3:2" },
  { value: "2:3", label: "2:3" },
  { value: "4:5", label: "4:5" },
  { value: "5:4", label: "5:4" },
  { value: "21:9", label: "21:9 ultrawide" },
];

const FORMAT_OPTIONS: { value: OutputFormat; label: string }[] = [
  { value: "png", label: "PNG" },
  { value: "jpeg", label: "JPEG" },
];

const POLL_INTERVAL = 1500;
const POLL_TIMEOUT = 5 * 60 * 1000; // 5 min

/**
 * Module-level registry of in-flight generations keyed by client historyId.
 * Each entry holds an AbortController (for the upload-stage fetch) and a
 * `cancelled` flag (for the polling loop). Lives outside React state so
 * OutputCard can reach in via the exported cancelGeneration() helper
 * without prop-drilling or a dedicated zustand slice.
 */
const inflightGenerations = new Map<
  string,
  { controller: AbortController; cancelled: boolean }
>();

/**
 * Cancel an in-flight generation by historyId. Aborts the upload fetch if
 * it's still running and sets a flag the polling loop checks each tick.
 * Safe to call for unknown ids — simply no-ops.
 */
export function cancelGeneration(historyId: string): void {
  const handle = inflightGenerations.get(historyId);
  if (!handle) return;
  handle.cancelled = true;
  try {
    handle.controller.abort();
  } catch {
    // ignore
  }
}

export function GenerateForm() {
  const activeProvider = useSettingsStore((s) => s.selectedProvider);
  const selectedModel = useSettingsStore((s) => s.selectedModel);
  const modelMeta = MODELS_META[selectedModel];
  const hasResolutions = modelMeta.capabilities.resolutions.length > 0;
  const hasFormats = modelMeta.capabilities.outputFormats.length > 0;
  // Filter the global option lists down to what this specific model supports.
  const visibleResolutionOptions = React.useMemo(
    () => RESOLUTION_OPTIONS.filter((o) => modelMeta.capabilities.resolutions.includes(o.value)),
    [modelMeta]
  );
  const visibleFormatOptions = React.useMemo(
    () => FORMAT_OPTIONS.filter((o) => modelMeta.capabilities.outputFormats.includes(o.value)),
    [modelMeta]
  );
  const { username } = useUser();
  const [prompt, setPrompt] = React.useState(
    "Make the hamburger made of glass."
  );
  const [images, setImages] = React.useState<DroppedImage[]>([]);
  const [resolution, setResolution] = React.useState<Resolution>("2k");
  const [aspectRatio, setAspectRatio] = React.useState<string>("");
  const [outputFormat, setOutputFormat] = React.useState<OutputFormat>("png");

  // When the user switches model, the previously-selected resolution may not
  // be supported by the new model (e.g. switching from nano-banana-pro at "1k"
  // to seedream-4-5 which only supports 2k/4k). Snap to the first supported
  // option in that case so the form never submits an invalid combo.
  React.useEffect(() => {
    if (hasResolutions && !modelMeta.capabilities.resolutions.includes(resolution)) {
      setResolution(modelMeta.capabilities.resolutions[0]);
    }
    if (hasFormats && !modelMeta.capabilities.outputFormats.includes(outputFormat)) {
      setOutputFormat(modelMeta.capabilities.outputFormats[0]);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedModel]);
  // Counter of in-flight generations. We allow concurrent generations —
  // each click starts an independent pipeline keyed by its own historyId,
  // so the form is never disabled. The counter is kept only for an
  // optional UI indicator (e.g. spinner badge) and to know whether ANY
  // generation is currently running.
  const [activeCount, setActiveCount] = React.useState(0);

  const addHistory = useHistoryStore((s) => s.add);
  const updateHistory = useHistoryStore((s) => s.update);

  /**
   * Poll /api/generate/status/:id?provider=... every POLL_INTERVAL until
   * the status is "completed" or "failed". Throws on timeout, HTTP error,
   * or user cancellation.
   */
  async function pollUntilDone(
    taskId: string,
    provider: ProviderId,
    handle: { cancelled: boolean; controller: AbortController }
  ): Promise<GenerateStatusResponse> {
    const start = Date.now();
    while (Date.now() - start < POLL_TIMEOUT) {
      if (handle.cancelled) throw new Error("cancelled");
      const res = await fetch(
        `/api/generate/status/${encodeURIComponent(taskId)}?provider=${encodeURIComponent(provider)}`,
        { cache: "no-store", signal: handle.controller.signal }
      );
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || `Status ${res.status}`);
      }
      const data = (await res.json()) as GenerateStatusResponse;
      if (data.status === "completed" || data.status === "failed") {
        return data;
      }
      await new Promise((r) => setTimeout(r, POLL_INTERVAL));
    }
    throw new Error("Polling timed out");
  }

  /**
   * HEAD-probe an output URL to get its byte size for the history sidebar.
   * Silent best-effort — returns undefined if CORS or network blocks it.
   * For local `/generated/*` URLs this always works (same origin).
   */
  async function fetchOutputSize(url: string): Promise<number | undefined> {
    try {
      const res = await fetch(url, { method: "HEAD" });
      const len = res.headers.get("content-length");
      if (len) return parseInt(len, 10);
    } catch {
      // ignore
    }
    return undefined;
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    // Concurrent generations are allowed: each click runs an independent
    // pipeline with its own historyId, AbortController, and closure over
    // current form values. No early-return on activeCount.

    // Inner helper: POST the finished generation to the server-backed
    // history DB. Runs in parallel with local zustand updateHistory, never
    // blocks the main flow. Captures closure over prompt/images/settings.
    async function saveToServerHistory(
      outputUrl: string,
      executionTimeMs: number,
      thumbnails: string[]
    ) {
      if (!username) {
        console.warn("[history] skip POST: no username");
        return;
      }
      const uploadUuid = uuid();

      const hasImages = images.length > 0;
      const workflowName = `wavespeed:${activeProvider}/${selectedModel}/${
        hasImages ? "edit" : "t2i"
      }`;
      const promptPayload = {
        prompt: prompt.trim(),
        resolution: hasResolutions ? resolution : undefined,
        aspectRatio: aspectRatio || undefined,
        outputFormat,
        provider: activeProvider,
        modelId: selectedModel,
        model: getModelString(activeProvider, selectedModel, hasImages),
        inputThumbnails: thumbnails,
      };

      const originalFilename =
        outputUrl.split("/").pop() || `output.${outputFormat}`;

      const uploadAbort = new AbortController();

      // Push a SKELETON pending entry immediately — no blob URLs yet,
      // but the sidebar card renders a placeholder so the user sees
      // progress instantly, before any fetch or encode runs.
      pendingHistory.addPending({
        pending: true,
        uuid: uploadUuid,
        // Blob URLs omitted — fill in progressively below.
        id: -1,
        username,
        workflow_name: workflowName,
        prompt_data: JSON.stringify(promptPayload),
        execution_time_seconds: executionTimeMs / 1000,
        created_at: new Date().toISOString(),
        status: "completed",
        outputs: [
          {
            id: -1,
            generation_id: -1,
            filename: originalFilename,
            filepath: `${uploadUuid}.${originalFilename.split(".").pop() || "png"}`,
            content_type: `image/${outputFormat}`,
            size: 0,
          },
        ],
        abort: () => uploadAbort.abort(),
      });

      // Track blob URLs so we can register them with the zustand entry
      // once generated (for Output panel cleanup on dismissal).
      let thumbBlobUrl: string | undefined;
      let midBlobUrl: string | undefined;
      let fullBlobUrl: string | undefined;
      let variants: Awaited<ReturnType<typeof createImageVariants>>;
      try {
        variants = await createImageVariants(outputUrl, {
          onFullReady: (blob) => {
            fullBlobUrl = URL.createObjectURL(blob);
            pendingHistory.updatePending(uploadUuid, { fullBlobUrl });
          },
          onThumbReady: (blob) => {
            thumbBlobUrl = URL.createObjectURL(blob);
            pendingHistory.updatePending(uploadUuid, { thumbBlobUrl });
          },
          onMidReady: (blob) => {
            midBlobUrl = URL.createObjectURL(blob);
            pendingHistory.updatePending(uploadUuid, { midBlobUrl });
          },
        });
      } catch (e) {
        console.error("[history] variant generation failed:", e);
        toast.error("Could not prepare thumbnail");
        pendingHistory.removePending(uploadUuid);
        return;
      }

      // All variants ready — update the zustand entry with blob URLs
      // so the Output panel also uses the lightweight variants and so
      // the blob URLs get revoked when the Output card is dismissed.
      updateHistory(historyId, {
        previewUrl: midBlobUrl,
        originalUrl: fullBlobUrl,
        outputUrl: midBlobUrl,
        confirmed: false,
        localBlobUrls: [thumbBlobUrl, midBlobUrl, fullBlobUrl].filter(
          (u): u is string => Boolean(u)
        ),
      });

      const doUpload = () =>
        uploadHistoryEntry({
          uuid: uploadUuid,
          username,
          workflowName,
          promptData: promptPayload,
          executionTimeSeconds: executionTimeMs / 1000,
          original: variants.full,
          originalFilename,
          originalContentType:
            variants.full.type || `image/${outputFormat}`,
          thumb: variants.thumb,
          mid: variants.mid,
          signal: uploadAbort.signal,
        });

      const retry = () => {
        pendingHistory.clearError(uploadUuid);
        doUpload().then(
          (res) => {
            // Pre-populate the image-cache with the exact bytes we already
            // have on the client. Later clicks on this entry render from
            // memory — no round-trip, works even with DevTools "Disable
            // cache" on.
            cacheBlob(res.thumbUrl, variants.thumb);
            cacheBlob(res.midUrl, variants.mid);
            cacheBlob(res.fullUrl, variants.full);
            pendingHistory.confirmPending(uploadUuid);
            updateHistory(historyId, {
              serverGenId: res.serverGenId,
              previewUrl: res.midUrl,
              originalUrl: res.fullUrl,
              outputUrl: res.midUrl,
              confirmed: true,
              localBlobUrls: undefined,
            });
            triggerHistoryRefresh();
          },
          (e: Error) => {
            if (e instanceof DOMException && e.name === "AbortError") {
              useHistoryStore.getState().remove(historyId);
              return;
            }
            pendingHistory.markError(uploadUuid, e.message);
          }
        );
      };

      // Now that retry closure exists, wire it into the pending entry.
      pendingHistory.updatePending(uploadUuid, { retry });

      try {
        let res;
        try {
          res = await doUpload();
        } catch (innerErr) {
          if (innerErr instanceof UploadError && innerErr.status === 409) {
            console.error(
              "[history] UUID collision on",
              uploadUuid,
              "— retrying with fresh uuid"
            );
            const freshUuid = uuid();
            res = await uploadHistoryEntry({
              uuid: freshUuid,
              username,
              workflowName,
              promptData: promptPayload,
              executionTimeSeconds: executionTimeMs / 1000,
              original: variants.full,
              originalFilename,
              originalContentType:
                variants.full.type || `image/${outputFormat}`,
              thumb: variants.thumb,
              mid: variants.mid,
              signal: uploadAbort.signal,
            });
          } else {
            throw innerErr;
          }
        }
        // Pre-populate the image-cache with the exact bytes we already
        // have on the client. Later clicks on this entry render from
        // memory — no round-trip, works even with DevTools "Disable
        // cache" on.
        cacheBlob(res.thumbUrl, variants.thumb);
        cacheBlob(res.midUrl, variants.mid);
        cacheBlob(res.fullUrl, variants.full);
        pendingHistory.confirmPending(uploadUuid);
        updateHistory(historyId, {
          serverGenId: res.serverGenId,
          previewUrl: res.midUrl,
          originalUrl: res.fullUrl,
          outputUrl: res.midUrl,
          confirmed: true,
          localBlobUrls: undefined,
        });
        triggerHistoryRefresh();
      } catch (e) {
        if (e instanceof DOMException && e.name === "AbortError") {
          useHistoryStore.getState().remove(historyId);
          return;
        }
        const msg = e instanceof Error ? e.message : "Upload failed";
        pendingHistory.markError(uploadUuid, msg);
      }
    }

    if (!prompt.trim()) {
      toast.error("Введи промпт");
      return;
    }
    // images is now optional — empty means text-to-image mode, all three
    // providers auto-switch endpoints based on whether images are present.

    setActiveCount((c) => c + 1);
    const startTime = Date.now();

    // Build the history entry upfront so the OutputArea shows a spinner card
    // while the request is in flight.
    const historyId = uuid();
    let thumbnails: string[];
    try {
      thumbnails = await Promise.all(
        images.map((img) => fileToThumbnail(img.file).catch(() => img.dataUrl))
      );
    } catch {
      thumbnails = images.map((i) => i.dataUrl);
    }

    const entry: HistoryEntry = {
      id: historyId,
      taskId: "",
      provider: activeProvider,
      model: getModelString(activeProvider, selectedModel, images.length > 0),
      prompt: prompt.trim(),
      resolution,
      aspectRatio: (aspectRatio || undefined) as AspectRatio | undefined,
      outputFormat,
      inputThumbnails: thumbnails,
      status: "pending",
      createdAt: Date.now(),
    };
    addHistory(entry);

    // Register this generation in the cancel registry. Both the upload
    // fetch and the polling loop read from `handle`, so a single
    // cancelGeneration(historyId) call can interrupt either stage.
    const handle = { controller: new AbortController(), cancelled: false };
    inflightGenerations.set(historyId, handle);

    try {
      // Step 1: submit
      const submitRes = await fetch("/api/generate/submit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: handle.controller.signal,
        body: JSON.stringify({
          provider: activeProvider,
          modelId: selectedModel,
          prompt: prompt.trim(),
          images: images.map((i) => i.dataUrl),
          // Compute source aspect from the FIRST image, if any. Seedream
          // providers use this when the user picked "Auto (match input)".
          // Skip if width/height weren't read (e.g. legacy DroppedImage).
          ...(images[0] && images[0].width > 0 && images[0].height > 0
            ? { sourceAspectRatio: images[0].width / images[0].height }
            : {}),
          ...(hasResolutions ? { resolution } : {}),
          ...(aspectRatio ? { aspectRatio: aspectRatio as AspectRatio } : {}),
          outputFormat,
        }),
      });
      if (!submitRes.ok) {
        const body = await submitRes.json().catch(() => ({}));
        throw new Error(body.error || `HTTP ${submitRes.status}`);
      }

      const submitData = (await submitRes.json()) as GenerateSubmitResponse;

      // Branch on sync vs async providers
      if (submitData.kind === "sync") {
        // Sync provider (Fal): result already here
        const executionTimeMs =
          submitData.executionTimeMs ?? Date.now() - startTime;
        const outputUrl = submitData.outputUrls[0];
        if (!outputUrl) throw new Error("Provider returned no output URLs");

        updateHistory(historyId, {
          taskId: "",
          status: "completed",
          outputUrl,
          executionTimeMs,
          error: null,
        });
        void fetchOutputSize(outputUrl).then((size) => {
          if (size) updateHistory(historyId, { outputSizeBytes: size });
        });
        toast.success("Готово!");
        void saveToServerHistory(outputUrl, executionTimeMs, thumbnails);
      } else {
        // Async provider (WaveSpeed, Comfy): poll until done
        updateHistory(historyId, {
          taskId: submitData.taskId,
          status: "processing",
        });

        const result = await pollUntilDone(submitData.taskId, activeProvider, handle);
        const executionTimeMs = Date.now() - startTime;

        if (result.status === "completed" && result.outputUrls[0]) {
          const outputUrl = result.outputUrls[0];
          updateHistory(historyId, {
            status: "completed",
            outputUrl,
            executionTimeMs,
            error: null,
          });
          void fetchOutputSize(outputUrl).then((size) => {
            if (size) updateHistory(historyId, { outputSizeBytes: size });
          });
          toast.success("Готово!");
          void saveToServerHistory(outputUrl, executionTimeMs, thumbnails);
        } else {
          const errMsg = result.error || "Generation failed";
          updateHistory(historyId, {
            status: "failed",
            executionTimeMs,
            error: errMsg,
          });
          toast.error(errMsg);
        }
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown error";
      // Distinguish user-initiated cancellation from real failures.
      // AbortError comes from controller.abort() during the upload fetch;
      // "cancelled" string is thrown by pollUntilDone when handle.cancelled
      // is set. Both paths converge here.
      const isCancel =
        (err instanceof DOMException && err.name === "AbortError") ||
        message === "cancelled" ||
        handle.cancelled;
      if (isCancel) {
        updateHistory(historyId, {
          status: "cancelled",
          executionTimeMs: Date.now() - startTime,
          error: null,
        });
        // Brief delay so the user sees the status flicker, then drop the
        // card entirely. Cancelled generations don't go to server history.
        const removeFn = useHistoryStore.getState().remove;
        setTimeout(() => removeFn(historyId), 250);
        toast("Отменено");
      } else {
        updateHistory(historyId, {
          status: "failed",
          executionTimeMs: Date.now() - startTime,
          error: message,
        });
        toast.error(message);
      }
    } finally {
      inflightGenerations.delete(historyId);
      setActiveCount((c) => Math.max(0, c - 1));
    }
  }

  return (
    <form onSubmit={handleSubmit} className="flex h-full flex-col gap-5">
      <div className="space-y-2">
        <Label>Входные изображения · опционально (пусто = text-to-image)</Label>
        <ImageDropzone value={images} onChange={setImages} maxImages={14} />
      </div>

      <div className="space-y-2">
        <Label htmlFor="prompt">Промпт</Label>
        <Textarea
          id="prompt"
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          placeholder="Опиши, что изменить на изображении..."
          className="min-h-[120px]"
        />
      </div>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        {hasResolutions && (
        <div className="space-y-1.5">
          <Label htmlFor="resolution">Разрешение</Label>
          <Select
            id="resolution"
            value={resolution}
            onChange={(e) => setResolution(e.target.value as Resolution)}
            options={visibleResolutionOptions}
          />
        </div>
        )}
        <div className="space-y-1.5">
          <Label htmlFor="aspect">Aspect ratio</Label>
          <Select
            id="aspect"
            value={aspectRatio}
            onChange={(e) => setAspectRatio(e.target.value)}
            options={ASPECT_OPTIONS}
          />
        </div>
        {hasFormats && (
        <div className="space-y-1.5">
          <Label htmlFor="format">Формат</Label>
          <Select
            id="format"
            value={outputFormat}
            onChange={(e) => setOutputFormat(e.target.value as OutputFormat)}
            options={visibleFormatOptions}
          />
        </div>
        )}
      </div>

      {/* Sticky Generate button — pinned to the bottom of the scrollable
          form area so it's always reachable regardless of form length. The
          negative margins bleed the background color to the card edges,
          counteracting the scroll-container's p-5 padding. */}
      <div className="sticky bottom-0 -mx-5 -mb-5 mt-auto border-t border-border bg-background px-5 py-3">
        <Button
          type="submit"
          size="lg"
          className="w-full"
        >
          <Sparkles />
          {activeCount > 0
            ? `Сгенерировать (в работе: ${activeCount})`
            : "Сгенерировать"}
        </Button>
      </div>
    </form>
  );
}
