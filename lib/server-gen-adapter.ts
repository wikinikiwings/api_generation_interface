import type { ServerGeneration } from "@/hooks/use-history";
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
    // viewcomfy node-prefixed prompt keys
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
 * (zustand-shape expected by <ImageDialog>, <OutputCard>).
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
    createdAt: (() => {
      const iso = gen.created_at.includes("T")
        ? gen.created_at
        : gen.created_at.replace(" ", "T") + "Z";
      const t = Date.parse(iso);
      return Number.isNaN(t) ? Date.now() : t;
    })(),
    outputUrl: fullSrc,
    inputThumbnails: [],
    serverGenId: gen.id,
    confirmed: true,
  };
}
