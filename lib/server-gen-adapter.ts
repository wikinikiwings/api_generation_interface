import type { ServerGeneration } from "@/hooks/use-history";
import { extractUuid } from "@/hooks/use-history";
import { isPending } from "@/lib/pending-history";
import type { HistoryEntry } from "@/types/wavespeed";

export interface ParsedPromptData {
  prompt?: string;
  resolution?: string;
  aspectRatio?: string;
  outputFormat?: string;
  provider?: string;
  model?: string;
}

export function parsePromptData(raw: string): ParsedPromptData {
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (typeof parsed.prompt === "string") {
      return parsed as ParsedPromptData;
    }
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

function parseCreatedAt(raw: string): number {
  const iso = raw.includes("T") ? raw : raw.replace(" ", "T") + "Z";
  const t = Date.parse(iso);
  return Number.isNaN(t) ? Date.now() : t;
}

function buildServerImageUrl(filepath: string, variant?: "thumb" | "mid"): string {
  const base = filepath.replace(/\.[^.]+$/, "");
  if (variant === "thumb") {
    return `/api/history/image/${encodeURIComponent(`thumb_${base}.jpg`)}`;
  }
  if (variant === "mid") {
    return `/api/history/image/${encodeURIComponent(`mid_${base}.jpg`)}`;
  }
  return `/api/history/image/${encodeURIComponent(filepath)}`;
}

/**
 * Stable, uuid-based key for a generation. Pending entries use their
 * own uuid; server rows extract it from the first image's filepath.
 * Legacy rows without a uuid-shaped filename fall back to the DB id.
 *
 * This id is used as `HistoryEntry.id` for sibling navigation so the
 * pending→confirmed transition doesn't appear to swap out the currently
 * viewed entry (both forms share the same uuid).
 */
export function stableGenerationId(gen: ServerGeneration): string {
  if (isPending(gen)) return gen.uuid.toLowerCase();
  const img = gen.outputs.find((o) => o.content_type.startsWith("image/"));
  const uuid = img ? extractUuid(img.filepath) : null;
  return uuid ?? `server-${gen.id}`;
}

/**
 * Universal adapter: any ServerGeneration (server or pending) → HistoryEntry.
 * Builds `/api/history/image/*` URLs for server rows and uses the pending
 * entry's blob URLs directly for pending rows. Returns `null` when the
 * generation has no usable image (pending with no blob yet, server row
 * with no image output).
 */
export function genToHistoryEntry(gen: ServerGeneration): HistoryEntry | null {
  const data = parsePromptData(gen.prompt_data);
  const firstImage = gen.outputs.find((o) => o.content_type.startsWith("image/"));

  let midUrl: string | undefined;
  let fullUrl: string | undefined;

  if (isPending(gen)) {
    // Require both mid and full blobs. A pending entry with only a mid
    // blob is renderable in the sidebar skeleton, but `originalUrl` must
    // point at the real full-resolution blob — otherwise ImageDialog's
    // Download button would save a mid-res image under a "full-res" name.
    // Entries without fullBlobUrl are simply not navigable via sibling
    // arrows until the full variant finishes encoding.
    if (!gen.midBlobUrl || !gen.fullBlobUrl) return null;
    midUrl = gen.midBlobUrl;
    fullUrl = gen.fullBlobUrl;
  } else {
    if (!firstImage) return null;
    midUrl = buildServerImageUrl(firstImage.filepath, "mid");
    fullUrl = buildServerImageUrl(firstImage.filepath);
  }

  return {
    id: stableGenerationId(gen),
    taskId: isPending(gen) ? `pending-${gen.uuid}` : `server-${gen.id}`,
    provider: (data.provider as HistoryEntry["provider"]) || "wavespeed",
    prompt: data.prompt || "",
    model: (data.model as HistoryEntry["model"]) || "nano-banana-pro",
    aspectRatio: data.aspectRatio as HistoryEntry["aspectRatio"] | undefined,
    resolution: (data.resolution as HistoryEntry["resolution"]) || "2k",
    outputFormat: (data.outputFormat as HistoryEntry["outputFormat"]) || "png",
    status: "completed",
    createdAt: parseCreatedAt(gen.created_at),
    outputUrl: midUrl,
    previewUrl: midUrl,
    originalUrl: fullUrl,
    inputThumbnails: [],
    serverGenId: isPending(gen) ? undefined : gen.id,
    confirmed: !isPending(gen),
  };
}

/**
 * Back-compat wrapper for existing call sites that already pass a
 * resolved `fullSrc`. Prefer `genToHistoryEntry` for new code.
 */
export function serverGenToHistoryEntry(
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
    createdAt: parseCreatedAt(gen.created_at),
    outputUrl: fullSrc,
    inputThumbnails: [],
    serverGenId: gen.id,
    confirmed: true,
  };
}
