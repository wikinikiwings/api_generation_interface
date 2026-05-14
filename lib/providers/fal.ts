// Server-only. Fal.ai provider.
//
// Uses the sync endpoint `https://fal.run/fal-ai/nano-banana-pro/edit`
// which blocks the HTTP request until the generation is done. This is
// simple but can hang 30+ seconds on 4K outputs.
//
// After Fal returns a result URL (pointing to their storage), we download
// the binary and save it locally via `image-storage` (under
// HISTORY_IMAGES_DIR/<email>/<YYYY>/<MM>/) so the history sidebar shows a
// stable local URL even if the Fal URL expires.

import type {
  Provider,
  EditInput,
  SubmitResult,
  ModelId,
} from "./types";
import { downloadAndSave } from "@/lib/image-storage";

// Per-model routing tables. Local to provider (no models.ts import).
const FAL_MODEL_SLUG_BY_ID: Partial<Record<ModelId, string>> = {
  "nano-banana-pro": "fal-ai/nano-banana-pro",
  "nano-banana-2":   "fal-ai/nano-banana-2",
  "nano-banana":     "fal-ai/nano-banana",
  "seedream-4-5":    "fal-ai/bytedance/seedream/v4.5",
  "seedream-5-0-lite": "fal-ai/bytedance/seedream/v5/lite",
};
const MODEL_MAX_IMAGES: Record<ModelId, number> = {
  "nano-banana-pro": 14,
  "nano-banana-2":   14,
  "nano-banana":     10,
  "seedream-4-5":    10,
  "seedream-5-0-lite": 14,
};
// v1 has no resolution param on Fal either — omit it.
const MODEL_SUPPORTS_RESOLUTION: Record<ModelId, boolean> = {
  "nano-banana-pro": true,
  "nano-banana-2":   true,
  "nano-banana":     false,
  "seedream-4-5":    false,   // uses image_size, see seedreamImageSize()
  "seedream-5-0-lite": false, // uses image_size, see seedreamImageSize()
};
// Fal's v1 schema rejects the magic string "auto" for aspect_ratio — the
// enum is strict. Pro/v2 still accept it. Seedream doesn't have aspect_ratio.
const MODEL_ACCEPTS_AUTO_ASPECT: Record<ModelId, boolean> = {
  "nano-banana-pro": true,
  "nano-banana-2":   true,
  "nano-banana":     false,
  "seedream-4-5":    false,
  "seedream-5-0-lite": false,
};

// Fal's seedream image_size enum, mapped from our (aspect, resolution) pair.
// Enum options: square_hd, square, portrait_4_3, portrait_16_9,
//               landscape_4_3, landscape_16_9, auto_2K, auto_4K
const SEEDREAM_FAL_ENUM: Record<string, string> = {
  "1:1":  "square_hd",
  "4:3":  "landscape_4_3",
  "3:4":  "portrait_4_3",
  "16:9": "landscape_16_9",
  "9:16": "portrait_16_9",
};

/**
 * Compute Fal seedream image_size from our (resolution, aspectRatio) pair.
 * Strategy: prefer named enums (closest to what user picked), fall back to
 * `auto_2K` / `auto_4K` for ratios with no enum, fall back to explicit
 * width/height object for unusual ratios so the request never 422s.
 */
function seedreamImageSize(
  modelId: ModelId,
  resolution: "2k" | "4k",
  aspect: string | undefined,
  sourceAspectRatio?: number
): string | { width: number; height: number } {
  // 5.0 Lite physically caps at ~3K and uses `auto_3K` instead of `auto_4K`.
  const isLite = modelId === "seedream-5-0-lite";
  const autoHigh = isLite ? "auto_3K" : "auto_4K";
  // No explicit aspect choice. If we have a source image aspect, use it.
  // Otherwise fall back to Fal's auto sizer (which produces a square).
  if (!aspect) {
    if (!sourceAspectRatio || sourceAspectRatio <= 0) {
      return resolution === "4k" ? autoHigh : "auto_2K";
    }
    // Source aspect known — fall through to explicit dims branch below by
    // synthesizing rw/rh from the source ratio.
  }
  // Named enum exists for this ratio AND user wants 2K — enum is exactly that.
  if (aspect && resolution === "2k" && SEEDREAM_FAL_ENUM[aspect]) {
    return SEEDREAM_FAL_ENUM[aspect];
  }
  // 4K or unusual ratio — explicit dims, clamped to model's accepted range.
  // 4.5 accepts [1920, 4096], 5.0 Lite accepts up to ~3072 per axis.
  const RATIOS: Record<string, [number, number]> = {
    "1:1":  [1, 1],  "16:9": [16, 9], "9:16": [9, 16],
    "4:3":  [4, 3],  "3:4":  [3, 4],  "3:2":  [3, 2], "2:3": [2, 3],
    "4:5":  [4, 5],  "5:4":  [5, 4],  "21:9": [21, 9],
  };
  // rw/rh: explicit pick > source aspect > 1:1.
  let rw: number, rh: number;
  if (aspect && RATIOS[aspect]) {
    [rw, rh] = RATIOS[aspect];
  } else if (sourceAspectRatio && sourceAspectRatio > 0) {
    rw = sourceAspectRatio;
    rh = 1;
  } else {
    rw = 1; rh = 1;
  }
  const target = isLite ? 3072 * 3072 : (resolution === "4k" ? 4096 * 4096 : 2048 * 2048);
  let w = Math.round(Math.sqrt(target * (rw / rh)) / 8) * 8;
  let h = Math.round((target / w) / 8) * 8;
  const maxDim = isLite ? 3072 : 4096;
  const minDim = isLite ? 1440 : 1920;
  w = Math.max(minDim, Math.min(maxDim, w));
  h = Math.max(minDim, Math.min(maxDim, h));
  return { width: w, height: h };
}

function getApiKey(): string | null {
  const k = process.env.FAL_KEY;
  if (!k || k === "your-fal-key-here") return null;
  return k;
}

function requireApiKey(): string {
  const k = getApiKey();
  if (!k) {
    throw new Error(
      "FAL_KEY is not set. Add it to .env.local to use the Fal provider."
    );
  }
  return k;
}

// Fal sync response shape for image-edit endpoints
interface FalImageResponse {
  images?: Array<{
    url: string;
    file_name?: string;
    content_type?: string;
  }>;
  description?: string;
}

/** Map our lowercase resolution to Fal's uppercase notation. */
function mapResolution(r: "1k" | "2k" | "4k"): "1K" | "2K" | "4K" {
  return r.toUpperCase() as "1K" | "2K" | "4K";
}

/** Best-effort extraction of a human message from Fal error bodies. */
function extractFalError(text: string, status: number): string {
  try {
    const body = JSON.parse(text) as {
      detail?: unknown;
      message?: unknown;
      error?: unknown;
    };
    // `detail` can be a string or an array of validation errors
    if (typeof body.detail === "string") return body.detail;
    if (Array.isArray(body.detail)) {
      return body.detail
        .map((d: unknown) =>
          d && typeof d === "object" && "msg" in d
            ? String((d as { msg: unknown }).msg)
            : JSON.stringify(d)
        )
        .join("; ");
    }
    if (typeof body.message === "string") return body.message;
    if (typeof body.error === "string") return body.error;
    return JSON.stringify(body);
  } catch {
    return text || `HTTP ${status}`;
  }
}

export const falProvider: Provider = {
  id: "fal",
  displayName: "Fal.ai",
  modelLabel: "Nano Banana family · Gemini Image",
  supportedModels: ["nano-banana-pro", "nano-banana-2", "nano-banana", "seedream-4-5", "seedream-5-0-lite"],
  isAsync: false,

  isConfigured() {
    return getApiKey() !== null;
  },

  async submit(input: EditInput): Promise<SubmitResult> {
    if (!input.prompt?.trim()) {
      throw new Error("Prompt is required");
    }

    const slug = FAL_MODEL_SLUG_BY_ID[input.modelId];
    if (!slug) {
      throw new Error(`Fal: model ${input.modelId} is not supported`);
    }

    const maxImages = MODEL_MAX_IMAGES[input.modelId];
    if (input.images && input.images.length > maxImages) {
      throw new Error(
        `Maximum ${maxImages} input images are allowed for ${input.modelId}`
      );
    }

    const startTime = Date.now();

    // Auto-switch endpoint based on whether input images are provided.
    // Edit endpoints use /edit suffix; t2i is the bare model path for
    // nano-banana, but seedream uses an explicit /text-to-image suffix
    // (different routing convention on Fal's side).
    const hasImages = !!input.images && input.images.length > 0;
    const t2iSuffix = (input.modelId === "seedream-4-5" || input.modelId === "seedream-5-0-lite") ? "/text-to-image" : "";
    const endpoint = hasImages
      ? `https://fal.run/${slug}/edit`
      : `https://fal.run/${slug}${t2iSuffix}`;

    // Aspect ratio handling: see MODEL_ACCEPTS_AUTO_ASPECT for the why.
    // For v1, if no explicit ratio was chosen we omit the field; Fal falls
    // back to its own default. For Pro/v2 we pass "auto" as a sentinel
    // that Fal interprets as "use source / match input".
    let aspectRatioField: string | undefined;
    if (input.aspectRatio) {
      aspectRatioField = input.aspectRatio;
    } else if (MODEL_ACCEPTS_AUTO_ASPECT[input.modelId]) {
      aspectRatioField = "auto";
    }

    // Fal's `image_urls` accepts both public URLs and base64 data URIs.
    const payload: Record<string, unknown> = {
      prompt: input.prompt,
      ...(aspectRatioField ? { aspect_ratio: aspectRatioField } : {}),
      output_format: input.outputFormat,
      num_images: 1,
      ...(MODEL_SUPPORTS_RESOLUTION[input.modelId]
        ? { resolution: mapResolution(input.resolution) }
        : {}),
    };
    if (hasImages) {
      payload.image_urls = input.images;
    }

    // Seedream uses image_size (enum or {w,h}) instead of aspect_ratio +
    // resolution, no output_format, and adds num_images / safety_checker.
    // Replace the payload shape after the generic build.
    if (input.modelId === "seedream-4-5" || input.modelId === "seedream-5-0-lite") {
      const seedreamRes = (input.resolution === "4k" ? "4k" : "2k") as "2k" | "4k";
      payload.image_size = seedreamImageSize(input.modelId, seedreamRes, input.aspectRatio, input.sourceAspectRatio);
      payload.num_images = 1;
      payload.enable_safety_checker = true;
      delete payload.aspect_ratio;
      delete payload.output_format;
      delete payload.resolution;
    }

    const res = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Key ${requireApiKey()}`, // Fal uses `Key`, not `Bearer`
      },
      body: JSON.stringify(payload),
      cache: "no-store",
    });

    if (!res.ok) {
      const text = await res.text();
      const message = extractFalError(text, res.status);
      throw new Error(`Fal.ai error (${res.status}): ${message}`);
    }

    const data = (await res.json()) as FalImageResponse;
    if (!data.images || data.images.length === 0) {
      throw new Error("Fal.ai returned no images");
    }

    // Download each output image from Fal's storage and save locally.
    // Sequential to keep disk I/O predictable and errors attributable.
    const savedUrls: string[] = [];
    for (const img of data.images) {
      try {
        const saved = await downloadAndSave(img.url, input.userEmail, input.outputFormat);
        savedUrls.push(saved.publicUrl);
      } catch (err) {
        console.error(
          "[fal provider] failed to cache image locally:",
          img.url,
          err
        );
        // Fallback: use the remote URL directly. Client will still render it
        // (Fal URLs are publicly accessible at least for a while).
        savedUrls.push(img.url);
      }
    }

    const executionTimeMs = Date.now() - startTime;
    return {
      kind: "sync",
      outputUrls: savedUrls,
      executionTimeMs,
    };
  },
};
