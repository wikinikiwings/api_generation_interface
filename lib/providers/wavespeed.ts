// Server-only. NEVER import this from client code — it reads the secret API key.
//
// WaveSpeed provider implementation. Wraps the WaveSpeed REST API
// (https://api.wavespeed.ai) and exposes it via the common Provider interface.

import type {
  Provider,
  EditInput,
  SubmitResult,
  StatusResult,
  TaskStatus,
  ModelId,
} from "./types";

const DEFAULT_BASE = "https://api.wavespeed.ai";

// Per-model routing tables. Keep these local to the provider so the provider
// stays self-contained (no import from UI-facing models.ts).
const MODEL_SLUG_BY_ID: Partial<Record<ModelId, string>> = {
  "nano-banana-pro": "google/nano-banana-pro",
  "nano-banana-2":   "google/nano-banana-2",
  "nano-banana":     "google/nano-banana",
  "seedream-4-5":    "bytedance/seedream-v4.5",
  "seedream-5-0-lite": "bytedance/seedream-v5.0-lite",
};
// v1 caps at 10, pro/v2 at 14. Seedream-4-5 caps at 10, 5.0 Lite at 14. WaveSpeed-confirmed.
const MODEL_MAX_IMAGES: Record<ModelId, number> = {
  "nano-banana-pro": 14,
  "nano-banana-2":   14,
  "nano-banana":     10,
  "seedream-4-5":    10,
  "seedream-5-0-lite": 14,
};
// v1 has no resolution parameter — payload field must be omitted entirely.
// Seedream uses `size: "W*H"` instead, also handled separately below.
const MODEL_SUPPORTS_RESOLUTION: Record<ModelId, boolean> = {
  "nano-banana-pro": true,
  "nano-banana-2":   true,
  "nano-banana":     false,
  "seedream-4-5":    false,
  "seedream-5-0-lite": false,
};

// Target megapixels for WaveSpeed seedream `size` field. Anything between
// 512x512 and 8192x8192 is accepted by their API per the model card UI,
// so these are just sensible defaults that match user-facing 2K/4K labels.
const SEEDREAM_TARGET_PIXELS: Record<"2k" | "4k", number> = {
  "2k": 2048 * 2048,   // ~4.2M
  "4k": 4096 * 4096,   // ~16.8M
};

// Aspect ratio numerators/denominators. Used to compute (W,H) given a
// target pixel budget. Covers every option in the form's ASPECT_OPTIONS.
const ASPECT_RATIO_NUMS: Record<string, [number, number]> = {
  "1:1": [1, 1], "16:9": [16, 9], "9:16": [9, 16],
  "4:3": [4, 3], "3:4": [3, 4], "3:2": [3, 2], "2:3": [2, 3],
  "4:5": [4, 5], "5:4": [5, 4], "21:9": [21, 9],
};

/**
 * Compute a `"W*H"` size string for WaveSpeed seedream from our generic
 * (resolution, aspectRatio) pair. When neither aspect nor a sourceAspect
 * is provided, falls back to square 1:1. Rounds dims to multiples of 8.
 */
function seedreamSize(
  resolution: "2k" | "4k",
  aspect: string | undefined,
  sourceAspectRatio?: number
): string {
  const target = SEEDREAM_TARGET_PIXELS[resolution];
  // Priority: explicit user choice > source image aspect > 1:1 fallback.
  let rw: number, rh: number;
  if (aspect && ASPECT_RATIO_NUMS[aspect]) {
    [rw, rh] = ASPECT_RATIO_NUMS[aspect];
  } else if (sourceAspectRatio && sourceAspectRatio > 0) {
    rw = sourceAspectRatio;
    rh = 1;
  } else {
    rw = 1; rh = 1;
  }
  const wRaw = Math.sqrt(target * (rw / rh));
  const hRaw = target / wRaw;
  const w = Math.round(wRaw / 8) * 8;
  const h = Math.round(hRaw / 8) * 8;
  return `${w}*${h}`;
}

function getBase(): string {
  return process.env.WAVESPEED_API_BASE || DEFAULT_BASE;
}

/** Returns the API key or null if not configured. Never throws. */
function getApiKey(): string | null {
  const k = process.env.WAVESPEED_API_KEY;
  if (!k || k === "your-api-key-here") return null;
  return k;
}

/** Returns the API key or throws a descriptive error. */
function requireApiKey(): string {
  const k = getApiKey();
  if (!k) {
    throw new Error(
      "WAVESPEED_API_KEY is not set. Add it to .env.local to use the WaveSpeed provider."
    );
  }
  return k;
}

function authHeaders(): HeadersInit {
  return {
    "Content-Type": "application/json",
    Authorization: `Bearer ${requireApiKey()}`,
  };
}

/**
 * WaveSpeed wraps some responses in `{ code, message, data: {...} }` and
 * returns others directly. This unwraps both shapes.
 */
function unwrap<T>(raw: unknown): T {
  if (raw && typeof raw === "object" && "data" in raw) {
    const envelope = raw as { data?: T };
    if (envelope.data !== undefined) return envelope.data;
  }
  return raw as T;
}

async function parseOrThrow<T>(res: Response): Promise<T> {
  const text = await res.text();
  let body: unknown = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    // not JSON, keep null
  }
  if (!res.ok) {
    const msg =
      (body &&
        typeof body === "object" &&
        "message" in body &&
        typeof (body as { message: unknown }).message === "string"
        ? (body as { message: string }).message
        : null) ||
      text ||
      `HTTP ${res.status}`;
    throw new Error(`WaveSpeed API error (${res.status}): ${msg}`);
  }
  return unwrap<T>(body);
}

// Raw WaveSpeed response shapes
interface WSSubmitResponse {
  id: string;
  status: string;
}
interface WSPredictionResult {
  id: string;
  status: TaskStatus;
  outputs?: string[];
  error?: string | null;
}

export const wavespeedProvider: Provider = {
  id: "wavespeed",
  displayName: "WaveSpeed",
  modelLabel: "Nano Banana family · Gemini Image",
  supportedModels: ["nano-banana-pro", "nano-banana-2", "nano-banana", "seedream-4-5", "seedream-5-0-lite"],
  isAsync: true,

  isConfigured() {
    return getApiKey() !== null;
  },

  async submit(input: EditInput): Promise<SubmitResult> {
    if (!input.prompt?.trim()) {
      throw new Error("Prompt is required");
    }

    const slug = MODEL_SLUG_BY_ID[input.modelId];
    if (!slug) {
      throw new Error(`WaveSpeed: model ${input.modelId} is not supported`);
    }

    const maxImages = MODEL_MAX_IMAGES[input.modelId];
    if (input.images && input.images.length > maxImages) {
      throw new Error(
        `Maximum ${maxImages} input images are allowed for ${input.modelId}`
      );
    }

    // Auto-switch endpoint based on whether input images are provided.
    // Both endpoints use the same async submit + poll pattern and the
    // same body shape minus the `images` field.
    //
    // T2i routing convention varies per model on WaveSpeed:
    //   - nano-banana family: bare slug for edit, `/text-to-image` for t2i
    //   - seedream family:    `/edit` for edit, BARE slug for t2i (no suffix)
    // Yes, that's the opposite of Fal where seedream needs the explicit
    // `/text-to-image` suffix and nano-banana doesn't. Each provider has
    // their own convention; this table makes it explicit.
    const hasImages = !!input.images && input.images.length > 0;
    const t2iSuffix = (input.modelId === "seedream-4-5" || input.modelId === "seedream-5-0-lite") ? "" : "/text-to-image";
    const url = hasImages
      ? `${getBase()}/api/v3/${slug}/edit`
      : `${getBase()}/api/v3/${slug}${t2iSuffix}`;

    const payload: Record<string, unknown> = {
      enable_base64_output: false,
      enable_sync_mode: false,
      output_format: input.outputFormat,
      prompt: input.prompt,
      // v1 has no resolution param — omit entirely (don't send empty/null).
      ...(MODEL_SUPPORTS_RESOLUTION[input.modelId]
        ? { resolution: input.resolution }
        : {}),
      ...(input.aspectRatio ? { aspect_ratio: input.aspectRatio } : {}),
    };
    if (hasImages) {
      payload.images = input.images;
    }

    // Seedream uses a completely different size schema: a single `size: "W*H"`
    // string and no separate resolution/aspect_ratio fields. Output format is
    // documented for 5.0 Lite (png/jpeg) but undocumented for 4.5 — we keep
    // it for 5.0 Lite and strip for 4.5 to avoid risk.
    if (input.modelId === "seedream-4-5" || input.modelId === "seedream-5-0-lite") {
      const seedreamRes = (input.resolution === "4k" ? "4k" : "2k") as "2k" | "4k";
      payload.size = seedreamSize(seedreamRes, input.aspectRatio, input.sourceAspectRatio);
      delete payload.aspect_ratio;
      delete payload.resolution;
      // 4.5 schema doesn't list output_format — strip to be safe.
      // 5.0 Lite has it documented — leave it.
      if (input.modelId === "seedream-4-5") {
        delete payload.output_format;
      }
    }

    let res: Response;
    const startedAt = Date.now();
    try {
      res = await fetch(url, {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify(payload),
        cache: "no-store",
      });
    } catch (err) {
      const elapsed = Date.now() - startedAt;
      const cause = (err as { cause?: unknown })?.cause;
      console.error(
        `[wavespeed] submit fetch failed after ${elapsed}ms: url=${url} model=${input.modelId} mode=${hasImages ? "edit" : "t2i"} cause=`,
        cause ?? err
      );
      throw err;
    }

    const data = await parseOrThrow<WSSubmitResponse>(res);
    return { kind: "async", taskId: data.id };
  },

  async getStatus(taskId: string): Promise<StatusResult> {
    if (!taskId) throw new Error("taskId is required");

    const url = `${getBase()}/api/v3/predictions/${encodeURIComponent(
      taskId
    )}/result`;
    const res = await fetch(url, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${requireApiKey()}`,
      },
      cache: "no-store",
    });

    const data = await parseOrThrow<WSPredictionResult>(res);
    // Defensive: WSPredictionResult.status is type-asserted as TaskStatus
    // but never validated at runtime. If WaveSpeed ever returns a status
    // string outside our enum (e.g. they add "succeeded" or "queued"),
    // pollUntilDone would loop forever waiting for "completed"/"failed"
    // that never come. Warn here so the next occurrence is diagnosable
    // without re-deriving the bug from polling-timeout symptoms.
    const KNOWN: TaskStatus[] = ["pending", "processing", "completed", "failed", "cancelled"];
    if (!KNOWN.includes(data.status)) {
      console.warn(
        `[wavespeed] unknown status "${data.status}" for taskId=${taskId} — pollUntilDone will not converge until this is mapped to a known TaskStatus`
      );
    }
    return {
      status: data.status,
      outputUrls: data.outputs ?? [],
      error: data.error ?? null,
    };
  },
};
