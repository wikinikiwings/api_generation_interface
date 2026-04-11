// Server-only. ComfyUI API provider.
//
// ========================================================================
// What this provider does
// ========================================================================
// This is NOT a local ComfyUI integration. We do NOT run ComfyUI as a
// process. Instead, we call api.comfy.org directly — specifically the
// internal Gemini proxy endpoint that ComfyUI itself uses from inside the
// GeminiImage2Node (the "Nano Banana Pro" node).
//
// The behavior is reverse-engineered from the ComfyUI source code at
// E:\my_stable\viewcomfy\clean_comfy. Specifically:
//   - comfy_api_nodes/nodes_gemini.py       → GeminiImage2.execute()
//   - comfy_api_nodes/apis/gemini.py        → Pydantic request/response models
//   - comfy_api_nodes/util/client.py        → sync_op + _request_base
//   - comfy_api_nodes/util/_helpers.py      → get_auth_header, default_base_url
//   - comfy_api_nodes/util/upload_helpers.py → upload_images_to_comfyapi
//
// ========================================================================
// Architecture
// ========================================================================
// This is a SYNCHRONOUS provider (isAsync: false). Each generation is a
// single blocking HTTP request to the Gemini proxy that returns the final
// image inline in the response body. There is no task queue, no polling,
// no websockets.
//
// From the user's point of view, this looks identical to Fal: click
// Generate → spinner → image appears in 20-60 seconds.
//
// ========================================================================
// Image upload strategy — hybrid (mirrors ComfyUI exactly)
// ========================================================================
// ComfyUI's create_image_parts() uses a hybrid strategy and we replicate it:
//
//   • First 10 images are uploaded to api.comfy.org/customers/storage via
//     a two-step signed-URL dance (POST create-slot → PUT binary) and then
//     referenced in the Gemini request as `fileData.fileUri`.
//
//   • Images 11-14 (Gemini's max) are sent as inline base64 in
//     `inlineData.data` within the same request body.
//
// Why this matters: our Next.js backend will live on a remote PC. If we
// put all 14 images inline in the request, the body can reach 100+ MB,
// which is slow/unreliable to transfer from remote backend to api.comfy.org.
// The hybrid strategy keeps the main request body small (just JSON with
// URLs) and moves the bulk data transfer into the upload step, which
// mirrors exactly what ComfyUI does and is proven to work.
//
// ========================================================================
// Auth
// ========================================================================
// All api.comfy.org requests carry a single header:
//     X-API-KEY: comfyui-<rest of key>
// The key comes from COMFY_API_KEY in .env.local and is the same one you
// get from https://platform.comfy.org/profile/api-keys. This pays for
// API-node credits only — NO Comfy Cloud subscription needed.
//
// ========================================================================
// Known risks / unknowns (see CHECKPOINT-v2.md for more context)
// ========================================================================
// 1. api.comfy.org/proxy/vertexai/gemini/* is an internal endpoint, not
//    a documented public API. Comfy may change its shape without notice.
// 2. If our calls get rejected (401/403), it means comfy.org has tightened
//    auth to require something beyond just the API key.
// 3. HTTP 402 from Gemini endpoint = no API-node credits on your account.

import type { Provider, EditInput, SubmitResult, ModelId } from "./types";
import {
  saveBinary,
  downloadAndSave,
  extFromContentType,
  normalizeExt,
} from "@/lib/image-storage";

// ============================================================
// Constants
// ============================================================

const COMFY_API_BASE = "https://api.comfy.org";
// BytePlus / ByteDance ARK proxy endpoint for Seedream image generation.
// Mirrors clean_comfy/comfy_api_nodes/nodes_bytedance.py BYTEPLUS_IMAGE_ENDPOINT.
// Sync POST — returns the generated image inline in `data[].url`. No polling.
const BYTEPLUS_IMAGE_ENDPOINT = `${COMFY_API_BASE}/proxy/byteplus/api/v3/images/generations`;
// Seedream model id strings as known to BytePlus. From nodes_bytedance.py
// SEEDREAM_MODELS dict. We map our generic ModelId to the BytePlus one.
const BYTEPLUS_MODEL_BY_ID: Partial<Record<ModelId, string>> = {
  "seedream-4-5":      "seedream-4-5-251128",
  "seedream-5-0-lite": "seedream-5-0-260128",
};
// Per-model Gemini routing. v2 maps to gemini-3.1-flash-image-preview
// (NOT gemini-2.5-* — that's the old v1). Confirmed via nodes_gemini.py
// label "Nano Banana 2 (Gemini 3.1 Flash Image)". See MODEL_ADDITION.md Phase 0.
const GEMINI_MODEL_BY_ID: Partial<Record<ModelId, string>> = {
  "nano-banana-pro": "gemini-3-pro-image-preview",
  "nano-banana-2":   "gemini-3.1-flash-image-preview",
  "nano-banana":     "gemini-2.5-flash-image",
  // seedream-4-5 intentionally NOT here — it goes through BytePlus, not Vertex.
};
// v1 has no resolution concept. Pro/v2 take 1K/2K/4K via imageConfig.imageSize.
const MODEL_SUPPORTS_RESOLUTION: Record<ModelId, boolean> = {
  "nano-banana-pro": true,
  "nano-banana-2":   true,
  "nano-banana":     false,
  "seedream-4-5":    false,   // uses BytePlus `size: "WxH"`, see submitSeedream()
  "seedream-5-0-lite": false, // uses BytePlus `size: "WxH"`, see submitSeedream()
};
const STORAGE_CREATE_ENDPOINT = `${COMFY_API_BASE}/customers/storage`;

// Vertex AI limit: max 10 file URIs per request. Images beyond this must
// go inline as base64 (which is exactly what ComfyUI does).
const MAX_URL_IMAGES = 10;
// Overall max images (matches the hard limit in GeminiImage2.execute)
const MAX_TOTAL_IMAGES = 14;

// ============================================================
// Env / auth
// ============================================================

function getApiKey(): string | null {
  const k = process.env.COMFY_API_KEY;
  if (!k || k === "your-comfy-key-here") return null;
  return k;
}

function requireApiKey(): string {
  const k = getApiKey();
  if (!k) {
    throw new Error(
      "COMFY_API_KEY is not set. Get a key at https://platform.comfy.org/profile/api-keys and add it to .env.local. Your comfy.org account must have API-node credits."
    );
  }
  return k;
}

/** Build headers for a call to api.comfy.org with our API key. */
function authHeaders(extra?: Record<string, string>): Record<string, string> {
  return {
    "X-API-KEY": requireApiKey(),
    ...(extra || {}),
  };
}

// ============================================================
// Request/response types (mirrors Pydantic models in apis/gemini.py)
// ============================================================

interface GeminiInlineData {
  mimeType: string;
  data: string; // base64
}

interface GeminiFileData {
  mimeType: string;
  fileUri: string;
}

interface GeminiPart {
  text?: string;
  inlineData?: GeminiInlineData;
  fileData?: GeminiFileData;
  thought?: boolean;
}

interface GeminiContent {
  role: "user" | "model";
  parts: GeminiPart[];
}

interface GeminiImageOutputOptions {
  mimeType: string;
  compressionQuality?: number;
}

interface GeminiImageConfig {
  // Optional — v1 (gemini-2.5-flash-image) has no resolution concept,
  // so we omit this field entirely for that model.
  imageSize?: "1K" | "2K" | "4K";
  aspectRatio?: string;
  imageOutputOptions: GeminiImageOutputOptions;
}

interface GeminiImageGenerationConfig {
  responseModalities: string[]; // ["IMAGE"] or ["TEXT", "IMAGE"]
  imageConfig: GeminiImageConfig;
}

interface GeminiImageGenerateContentRequest {
  contents: GeminiContent[];
  generationConfig: GeminiImageGenerationConfig;
  uploadImagesToStorage: boolean;
  // systemInstruction intentionally omitted — see comment in buildRequestBody
}

interface GeminiCandidate {
  content?: GeminiContent;
  finishReason?: string;
}

interface GeminiPromptFeedback {
  blockReason?: string;
  blockReasonMessage?: string;
}

interface GeminiGenerateContentResponse {
  candidates?: GeminiCandidate[];
  promptFeedback?: GeminiPromptFeedback;
  modelVersion?: string;
}

// ============================================================
// Upload step: POST /customers/storage → PUT <signed_url>
// ============================================================

interface CreateUploadSlotResponse {
  download_url: string;
  upload_url: string;
}

/**
 * Step 1 of the upload dance: ask api.comfy.org for a signed upload URL
 * and a download URL to reference later.
 */
async function createUploadSlot(
  filename: string,
  contentType: string
): Promise<CreateUploadSlotResponse> {
  const res = await fetch(STORAGE_CREATE_ENDPOINT, {
    method: "POST",
    headers: authHeaders({
      "Content-Type": "application/json",
      Accept: "application/json",
    }),
    body: JSON.stringify({
      file_name: filename,
      content_type: contentType,
    }),
    cache: "no-store",
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(
      `Comfy /customers/storage error (${res.status}): ${
        friendlyBodyMessage(text) || res.statusText
      }`
    );
  }

  const data = (await res.json()) as CreateUploadSlotResponse;
  if (!data.upload_url || !data.download_url) {
    throw new Error(
      "Comfy /customers/storage response missing upload_url/download_url"
    );
  }
  return data;
}

/**
 * Step 2 of the upload dance: PUT the raw binary to the signed URL.
 * NO auth header here — the signed URL already carries its own auth
 * in query parameters. Sending X-API-KEY would not break anything but
 * might confuse some S3-compatible signing schemes.
 */
async function uploadBinaryToSignedUrl(
  signedUrl: string,
  buffer: Buffer,
  contentType: string
): Promise<void> {
  // Type-level workaround for Next.js 15 + TS 5.7 + @types/node combo:
  //   - DOM BodyInit doesn't include Buffer / Uint8Array
  //   - BlobPart requires ArrayBuffer, but Buffer is typed as ArrayBufferLike
  //     (which theoretically includes SharedArrayBuffer)
  // In practice Node's Buffer.from(base64) ALWAYS backs onto a plain
  // ArrayBuffer, never SharedArrayBuffer — the broader type is just defensive.
  // Cast through `unknown` to tell TS we know what we're doing. Runtime is
  // unchanged: fetch accepts Buffer natively in Node 20.
  const res = await fetch(signedUrl, {
    method: "PUT",
    headers: { "Content-Type": contentType },
    body: buffer as unknown as BodyInit,
    cache: "no-store",
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(
      `Signed PUT upload failed (${res.status}): ${text.slice(0, 200) || res.statusText}`
    );
  }
}

/**
 * Upload a single base64 data URI image to Comfy's storage.
 * Returns the download URL and mimeType so we can build a fileData part.
 */
async function uploadSingleImage(
  dataUri: string,
  index: number
): Promise<{ fileUri: string; mimeType: string }> {
  const match = dataUri.match(/^data:([^;]+);base64,(.+)$/);
  if (!match) {
    throw new Error(
      `Image ${index + 1} is not a base64 data URI (Comfy provider expects browser-uploaded images)`
    );
  }
  const mimeType = match[1];
  const base64 = match[2];
  const buffer = Buffer.from(base64, "base64");

  const ext = normalizeExt(extFromContentType(mimeType));
  const filename = `wsc_${Date.now()}_${index}.${ext}`;

  const slot = await createUploadSlot(filename, mimeType);
  await uploadBinaryToSignedUrl(slot.upload_url, buffer, mimeType);
  return { fileUri: slot.download_url, mimeType };
}

// ============================================================
// Build GeminiPart[] for input images (hybrid strategy)
// ============================================================

/**
 * Convert an array of base64 data URIs into Gemini parts, mirroring
 * ComfyUI's create_image_parts() exactly:
 *
 *   • First min(N, 10) images: upload to /customers/storage, use as fileData
 *   • Remaining images (up to 14 total): pass as inline base64
 *
 * Uploads are sequential for predictable error attribution. If upload N
 * fails, we know which image broke and report it cleanly.
 */
async function buildImageParts(images: string[]): Promise<GeminiPart[]> {
  const parts: GeminiPart[] = [];
  const urlCount = Math.min(images.length, MAX_URL_IMAGES);

  // First 10 → upload and reference as fileData
  for (let i = 0; i < urlCount; i++) {
    try {
      const uploaded = await uploadSingleImage(images[i], i);
      parts.push({
        fileData: {
          mimeType: uploaded.mimeType,
          fileUri: uploaded.fileUri,
        },
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : "unknown error";
      throw new Error(
        `Failed to upload image ${i + 1}/${urlCount} to Comfy storage: ${msg}`
      );
    }
  }

  // Images 11-14 → inline base64
  for (let i = urlCount; i < images.length; i++) {
    const match = images[i].match(/^data:([^;]+);base64,(.+)$/);
    if (!match) {
      throw new Error(`Image ${i + 1} is not a base64 data URI`);
    }
    parts.push({
      inlineData: {
        mimeType: match[1],
        data: match[2],
      },
    });
  }

  return parts;
}

// ============================================================
// Build the full Gemini request body
// ============================================================

function mapResolution(r: "1k" | "2k" | "4k"): "1K" | "2K" | "4K" {
  return r.toUpperCase() as "1K" | "2K" | "4K";
}

function buildRequestBody(params: {
  modelId: ModelId;
  prompt: string;
  imageParts: GeminiPart[];
  resolution: "1k" | "2k" | "4k";
  aspectRatio?: string;
}): GeminiImageGenerateContentRequest {
  // Order matters — text first, then images. Matches ComfyUI's
  // create_image_parts order (text is prepended before extending parts).
  const parts: GeminiPart[] = [
    { text: params.prompt },
    ...params.imageParts,
  ];

  const imageConfig: GeminiImageConfig = {
    // Comfy's GeminiImageOutputOptions always has mimeType=image/png as
    // default. The node UI doesn't expose a way to change it, and since
    // we want to match exactly, we hardcode it too.
    imageOutputOptions: {
      mimeType: "image/png",
    },
  };

  // Only set imageSize for models that understand it. v1 ignores it.
  if (MODEL_SUPPORTS_RESOLUTION[params.modelId]) {
    imageConfig.imageSize = mapResolution(params.resolution);
  }

  // ComfyUI convention (from GeminiImage2.execute):
  //   if aspect_ratio != "auto": image_config.aspectRatio = aspect_ratio
  // So we only set the field when user picked a specific ratio.
  if (params.aspectRatio && params.aspectRatio !== "auto") {
    imageConfig.aspectRatio = params.aspectRatio;
  }

  return {
    contents: [{ role: "user", parts }],
    generationConfig: {
      // "IMAGE" only — avoid the model "thinking out loud" in text, which
      // can subtly shift image output. Matches what WaveSpeed/Fal do.
      responseModalities: ["IMAGE"],
      imageConfig,
    },
    // Always true, matches ComfyUI's Pydantic default. What the proxy does
    // with this flag isn't fully documented, but ComfyUI always sends it,
    // so we do too.
    uploadImagesToStorage: true,
    // systemInstruction intentionally NOT included. ComfyUI's node defaults
    // systemInstruction to GEMINI_IMAGE_SYS_PROMPT (aggressive "you MUST
    // ALWAYS produce an image..."), which can swing the model away from
    // the baseline behavior Fal/WaveSpeed produce. By omitting the field
    // entirely, we get the model's own neutral default. See CHECKPOINT-v2.md
    // → "Знания: модель vs продукт" for the full analysis.
  };
}

// ============================================================
// Parse response → extract output image bytes
// ============================================================

/**
 * One image extracted from the Gemini response. Either inline base64 or a
 * URL to download from comfy.org storage — depending on how the proxy
 * decided to return it (the `uploadImagesToStorage` flag in the request
 * influences this).
 */
interface ExtractedImagePart {
  mimeType: string;
  source:
    | { type: "inline"; base64: string }
    | { type: "url"; fileUri: string };
}

function extractOutputImages(
  response: GeminiGenerateContentResponse
): ExtractedImagePart[] {
  // Top-level block (policy/safety) — no candidates at all
  if (!response.candidates || response.candidates.length === 0) {
    if (response.promptFeedback?.blockReason) {
      const reason = response.promptFeedback.blockReason;
      const msg = response.promptFeedback.blockReasonMessage;
      throw new Error(
        `Gemini blocked the prompt: ${reason}${msg ? ` — ${msg}` : ""}`
      );
    }
    throw new Error("Gemini returned no candidates");
  }

  const images: ExtractedImagePart[] = [];
  const blockedReasons: string[] = [];
  const textResponses: string[] = [];

  for (const candidate of response.candidates) {
    // Per-candidate block (image-level policy violation)
    if (candidate.finishReason === "IMAGE_PROHIBITED_CONTENT") {
      blockedReasons.push(candidate.finishReason);
      continue;
    }
    if (!candidate.content?.parts) continue;

    for (const part of candidate.content.parts) {
      // Skip "thought" parts (they're not the final image)
      if (part.thought === true) continue;

      // Output image can come back either as inlineData (base64 inline) OR
      // as fileData (URL to comfy.org storage). ComfyUI's own
      // get_image_from_response handles both cases — we must too. The
      // `uploadImagesToStorage` flag in the request influences which path
      // the proxy takes.
      if (
        part.inlineData?.mimeType?.startsWith("image/") &&
        part.inlineData.data
      ) {
        images.push({
          mimeType: part.inlineData.mimeType,
          source: { type: "inline", base64: part.inlineData.data },
        });
      } else if (
        part.fileData?.mimeType?.startsWith("image/") &&
        part.fileData.fileUri
      ) {
        images.push({
          mimeType: part.fileData.mimeType,
          source: { type: "url", fileUri: part.fileData.fileUri },
        });
      } else if (part.text) {
        textResponses.push(part.text);
      }
    }
  }

  if (images.length === 0) {
    if (blockedReasons.length > 0) {
      throw new Error(
        `Gemini blocked the image: ${blockedReasons.join(", ")}`
      );
    }
    const modelMessage = textResponses.join(" ").trim();
    if (modelMessage) {
      throw new Error(
        `Gemini did not generate an image. Model response: ${modelMessage.slice(0, 500)}`
      );
    }
    // No image, no block, no text — log the response shape so we can
    // diagnose what actually came back. This helps if the API response
    // format has drifted or if there's an unexpected part type.
    console.error(
      "[comfy provider] Could not extract image from response. Shape:",
      JSON.stringify(
        {
          modelVersion: response.modelVersion,
          candidateCount: response.candidates?.length ?? 0,
          finishReasons:
            response.candidates?.map((c) => c.finishReason) ?? [],
          partShapes:
            response.candidates?.map(
              (c) =>
                c.content?.parts?.map((p) => {
                  if (p.inlineData)
                    return `inline:${p.inlineData.mimeType}(${
                      p.inlineData.data?.length ?? 0
                    }ch)`;
                  if (p.fileData)
                    return `file:${p.fileData.mimeType}:${
                      p.fileData.fileUri ?? "no-uri"
                    }`;
                  if (p.text) return `text(${p.text.length}ch)`;
                  if (p.thought) return "thought";
                  return "empty";
                }) ?? []
            ) ?? [],
        },
        null,
        2
      )
    );
    throw new Error("Gemini did not generate an image");
  }

  return images;
}

// ============================================================
// Error helpers
// ============================================================

/**
 * Convert a comfy.org error body (JSON or text) into a short human message.
 * Pulls `error.message` / `error.type` from JSON if present, otherwise
 * returns the raw text (truncated).
 */
function friendlyBodyMessage(rawText: string): string {
  if (!rawText) return "";
  try {
    const parsed = JSON.parse(rawText) as {
      error?: { message?: string; type?: string };
      message?: string;
    };
    if (parsed.error?.message) {
      const typ = parsed.error.type ? ` (${parsed.error.type})` : "";
      return `${parsed.error.message}${typ}`;
    }
    if (parsed.message) return parsed.message;
    return JSON.stringify(parsed).slice(0, 200);
  } catch {
    return rawText.slice(0, 200);
  }
}

/** Map HTTP status from comfy.org to a friendly message. */
function friendlyHttpError(status: number, bodyText: string): string {
  // These match the `_friendly_http_message()` in ComfyUI's client.py
  if (status === 401) {
    return "Unauthorized — COMFY_API_KEY is invalid or has been revoked";
  }
  if (status === 402) {
    return "Payment Required — you have no API-node credits on your comfy.org account. Add credits at https://platform.comfy.org";
  }
  if (status === 409) {
    return "There's a problem with your comfy.org account. Contact support@comfy.org";
  }
  if (status === 429) {
    return "Rate limited by comfy.org. Wait a bit and try again";
  }
  // 5xx — upstream (Google Vertex AI) or proxy infrastructure issue.
  // These are transient and get auto-retried by postGeminiWithRetry,
  // so if the user sees these messages, all retries have failed.
  if (status === 503) {
    return "Comfy proxy upstream temporarily unavailable (503). All retries failed — this usually resolves within a few minutes, try again shortly.";
  }
  if (status === 502 || status === 504) {
    return `Comfy proxy gateway error (${status}) — upstream timed out. All retries failed — try again in a moment.`;
  }
  if (status === 500) {
    return "Comfy proxy internal error (500). All retries failed — try again shortly.";
  }
  const body = friendlyBodyMessage(bodyText);
  return `${body || `HTTP ${status}`}`;
}

// ============================================================
// POST to Gemini proxy with retry on transient 5xx errors
// ============================================================

/**
 * Statuses that get auto-retried. Mirrors ComfyUI's `_RETRY_STATUS`
 * in client.py. 429 is NOT in this set because rate limits need
 * longer backoff than transient 5xx and different handling.
 */
const RETRIABLE_STATUSES = new Set([408, 500, 502, 503, 504]);

/**
 * Maximum number of retry attempts (in addition to the initial attempt).
 * So total attempts = MAX_RETRIES + 1 = 3.
 */
const MAX_RETRIES = 2;

/**
 * Initial delay before the first retry. Doubles on each subsequent retry.
 * So delays are: 5s, 15s (capped). Total wall-clock for 3 attempts with
 * 30s per failed call + 5s + 15s backoff = ~120s worst case.
 */
const INITIAL_RETRY_DELAY_MS = 5000;
const MAX_RETRY_DELAY_MS = 15000;

/**
 * POST the Gemini request body, auto-retrying on transient upstream errors.
 *
 * Why we retry:
 *   comfy.org's Gemini proxy is a thin layer over Google Vertex AI. Any
 *   hiccup between the proxy and Google (DNS blip, rate limit on Google's
 *   side, transient VPC issue) surfaces as 5xx to us. ComfyUI itself
 *   retries these automatically via `_RETRY_STATUS` in client.py — we do
 *   the same so our users don't have to manually re-click Generate.
 *
 * What we don't retry:
 *   - 4xx errors (auth, bad request, policy) — these won't improve
 *   - Network errors from our side — fetch() throws those, handled above
 */
async function postGeminiWithRetry(
  endpoint: string,
  body: GeminiImageGenerateContentRequest
): Promise<GeminiGenerateContentResponse> {
  const serializedBody = JSON.stringify(body);
  const headers = authHeaders({
    "Content-Type": "application/json",
    Accept: "application/json",
  });

  let delay = INITIAL_RETRY_DELAY_MS;
  let lastStatus = 0;
  let lastBodyText = "";

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    if (attempt > 0) {
      console.warn(
        `[comfy provider] retry ${attempt}/${MAX_RETRIES} after ${delay}ms (previous status ${lastStatus})`
      );
      await new Promise((resolve) => setTimeout(resolve, delay));
      delay = Math.min(delay * 2, MAX_RETRY_DELAY_MS);
    }

    const res = await fetch(endpoint, {
      method: "POST",
      headers,
      body: serializedBody,
      cache: "no-store",
    });

    if (res.ok) {
      return (await res.json()) as GeminiGenerateContentResponse;
    }

    // Read body text once so we can either throw with it or log it on retry
    lastStatus = res.status;
    lastBodyText = await res.text().catch(() => "");

    // Non-retriable status — throw immediately with friendly message
    if (!RETRIABLE_STATUSES.has(res.status)) {
      throw new Error(
        `Comfy Gemini proxy error (${res.status}): ${friendlyHttpError(res.status, lastBodyText)}`
      );
    }

    // Retriable but we're out of attempts — throw
    if (attempt === MAX_RETRIES) {
      throw new Error(
        `Comfy Gemini proxy error (${res.status}): ${friendlyHttpError(res.status, lastBodyText)}`
      );
    }

    // Otherwise loop continues, backing off first
  }

  // Unreachable (loop always returns or throws) — keep TS happy
  throw new Error(
    `Comfy Gemini proxy error (${lastStatus}): ${friendlyHttpError(lastStatus, lastBodyText)}`
  );
}

// ============================================================
// Seedream / BytePlus path — parallel implementation, isolated from Gemini
// ============================================================

// Aspect ratio numerators for the size formula. Same table as wavespeed.ts
// and fal.ts — keep in sync if you add ratios.
const SEEDREAM_RATIOS: Record<string, [number, number]> = {
  "1:1": [1, 1], "16:9": [16, 9], "9:16": [9, 16],
  "4:3": [4, 3], "3:4": [3, 4], "3:2": [3, 2], "2:3": [2, 3],
  "4:5": [4, 5], "5:4": [5, 4], "21:9": [21, 9],
};

/**
 * Compute Seedream `size: "WxH"` for the BytePlus endpoint. NOTE: BytePlus
 * uses a lowercase 'x' separator, NOT '*' like WaveSpeed. Width range from
 * nodes_bytedance.py: [1024, 6240], height [1024, 4992]. We clamp into
 * those bounds and round to multiples of 8.
 */
function seedreamSizeForByteplus(
  resolution: "2k" | "4k",
  aspect: string | undefined,
  sourceAspectRatio?: number
): string {
  const target = resolution === "4k" ? 4096 * 4096 : 2048 * 2048;
  // Priority: explicit user choice > source image aspect > 1:1 fallback.
  let rw: number, rh: number;
  if (aspect && SEEDREAM_RATIOS[aspect]) {
    [rw, rh] = SEEDREAM_RATIOS[aspect];
  } else if (sourceAspectRatio && sourceAspectRatio > 0) {
    rw = sourceAspectRatio;
    rh = 1;
  } else {
    rw = 1; rh = 1;
  }
  let w = Math.round(Math.sqrt(target * (rw / rh)) / 8) * 8;
  let h = Math.round((target / w) / 8) * 8;
  w = Math.max(1024, Math.min(6240, w));
  h = Math.max(1024, Math.min(4992, h));
  return `${w}x${h}`;
}

// BytePlus images API response shape (OpenAI-compatible).
// Confirmed by ByteDance ARK docs and clean_comfy's process_image_response usage.
interface ByteplusImageResponse {
  model?: string;
  created?: number;
  data?: Array<{ url?: string; b64_json?: string }>;
  error?: { message?: string; code?: string | number };
}

/**
 * Submit a Seedream generation through the BytePlus proxy. Sync HTTP call,
 * no polling, no upload dance — BytePlus accepts base64 data URIs in the
 * `image` array directly. Returns saved local URLs in SubmitResult.
 */
async function submitSeedream(input: EditInput): Promise<SubmitResult> {
  const byteplusModel = BYTEPLUS_MODEL_BY_ID[input.modelId];
  if (!byteplusModel) {
    throw new Error(`Comfy/BytePlus: model ${input.modelId} not mapped`);
  }
  // Seedream-4-5 caps at 10 images, 5.0 Lite at 14 (per nodes_bytedance.py).
  const maxImgs = input.modelId === "seedream-5-0-lite" ? 14 : 10;
  if (input.images && input.images.length > maxImgs) {
    throw new Error(`Maximum ${maxImgs} input images are allowed for ${input.modelId}`);
  }

  const startTime = Date.now();
  const seedreamRes = (input.resolution === "4k" ? "4k" : "2k") as "2k" | "4k";
  const size = seedreamSizeForByteplus(seedreamRes, input.aspectRatio, input.sourceAspectRatio);

  // Build payload. BytePlus accepts base64 data URIs directly in `image[]`,
  // so no separate upload step needed (unlike Gemini's upload dance above).
  const payload: Record<string, unknown> = {
    model: byteplusModel,
    prompt: input.prompt,
    size,
    response_format: "url",
    watermark: false,
    sequential_image_generation: "disabled",
    max_images: 1,
  };
  if (input.images && input.images.length > 0) {
    payload.image = input.images;
  }

  const res = await fetch(BYTEPLUS_IMAGE_ENDPOINT, {
    method: "POST",
    headers: authHeaders({
      "Content-Type": "application/json",
      Accept: "application/json",
    }),
    body: JSON.stringify(payload),
    cache: "no-store",
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(
      `Comfy/BytePlus error (${res.status}): ${friendlyHttpError(res.status, text)}`
    );
  }

  const data = (await res.json()) as ByteplusImageResponse;
  if (data.error?.message) {
    throw new Error(`BytePlus API error: ${data.error.message}`);
  }
  if (!data.data || data.data.length === 0) {
    throw new Error("BytePlus returned no images");
  }

  // Download each output (URL or b64) and save locally under public/generated/.
  const savedUrls: string[] = [];
  for (const item of data.data) {
    try {
      let saved;
      if (item.url) {
        saved = await downloadAndSave(item.url, "png");
      } else if (item.b64_json) {
        const buffer = Buffer.from(item.b64_json, "base64");
        saved = await saveBinary(buffer, "png");
      } else {
        continue;
      }
      savedUrls.push(saved.publicUrl);
    } catch (err) {
      console.error("[comfy/byteplus] failed to save output image:", err);
    }
  }
  if (savedUrls.length === 0) {
    throw new Error("Comfy/BytePlus returned images but all local saves failed");
  }

  return {
    kind: "sync",
    outputUrls: savedUrls,
    executionTimeMs: Date.now() - startTime,
  };
}

// ============================================================
// Provider export
// ============================================================

export const comfyProvider: Provider = {
  id: "comfy",
  displayName: "Comfy API",
  modelLabel: "Nano Banana family · Gemini Image",
  supportedModels: ["nano-banana-pro", "nano-banana-2", "nano-banana", "seedream-4-5", "seedream-5-0-lite"],
  // Single blocking HTTP call — no polling needed.
  isAsync: false,

  isConfigured() {
    return getApiKey() !== null;
  },

  async submit(input: EditInput): Promise<SubmitResult> {
    // Validation — images is optional: empty array means text-to-image
    // mode. ComfyUI's GeminiImage2.execute() does exactly the same thing
    // (`if images is not None: parts.extend(create_image_parts(...))`),
    // so text-only is a valid input for the Gemini proxy.
    if (!input.prompt?.trim()) {
      throw new Error("Prompt is required");
    }
    if (input.images && input.images.length > MAX_TOTAL_IMAGES) {
      throw new Error(
        `Maximum ${MAX_TOTAL_IMAGES} input images are allowed (got ${input.images.length})`
      );
    }
    // Fail fast if the key isn't set…
    requireApiKey();

    // Seedream goes through a completely different proxy path (BytePlus,
    // not Vertex AI) and has its own request/response shape. Branch early
    // and keep the Gemini code below 100% untouched.
    if (input.modelId === "seedream-4-5" || input.modelId === "seedream-5-0-lite") {
      return submitSeedream(input);
    }

    const geminiModel = GEMINI_MODEL_BY_ID[input.modelId];
    if (!geminiModel) {
      throw new Error(`Comfy: model ${input.modelId} is not supported`);
    }
    const endpoint = `${COMFY_API_BASE}/proxy/vertexai/gemini/${geminiModel}`;

    const startTime = Date.now();

    // Step 1: upload first 10 images, keep rest as inline → get GeminiPart[].
    // If no images were provided, this returns [] and we skip straight to
    // building a text-only request body (Gemini handles t2i natively on the
    // same endpoint).
    const imageParts = input.images?.length
      ? await buildImageParts(input.images)
      : [];

    // Step 2: build the request body
    const body = buildRequestBody({
      modelId: input.modelId,
      prompt: input.prompt,
      imageParts,
      resolution: input.resolution,
      aspectRatio: input.aspectRatio,
    });

    // Step 3: POST to Gemini proxy (with auto-retry on transient 5xx)
    const data = await postGeminiWithRetry(endpoint, body);

    // Step 4: extract images from response
    const outputImages = extractOutputImages(data);

    // Step 5: save each output locally under public/generated/
    // Gemini returns PNG by default (matches our imageOutputOptions.mimeType).
    const savedUrls: string[] = [];
    for (const img of outputImages) {
      try {
        const ext = normalizeExt(extFromContentType(img.mimeType));
        let saved;
        if (img.source.type === "inline") {
          // Response inlined the image as base64 — decode and save
          const buffer = Buffer.from(img.source.base64, "base64");
          saved = await saveBinary(buffer, ext);
        } else {
          // Response pointed to comfy.org storage URL — download and save
          saved = await downloadAndSave(img.source.fileUri, ext);
        }
        savedUrls.push(saved.publicUrl);
      } catch (err) {
        console.error(
          "[comfy provider] failed to save output image locally:",
          err
        );
      }
    }

    if (savedUrls.length === 0) {
      throw new Error("Comfy returned images but all local saves failed");
    }

    const executionTimeMs = Date.now() - startTime;
    return {
      kind: "sync",
      outputUrls: savedUrls,
      executionTimeMs,
    };
  },

  // No getStatus — this provider is sync, the client never polls.
};
