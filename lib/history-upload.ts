/**
 * Upload a completed generation to /api/history as multipart form data.
 *
 * The server writes the provided original/thumb/mid bytes as-is under
 * names derived from `uuid`, then returns the public URLs. The uuid
 * MUST be a fresh crypto.randomUUID() generated on the client — it
 * doubles as the server-side base filename.
 */

export interface UploadHistoryParams {
  uuid: string;
  workflowName: string;
  promptData: Record<string, unknown>;
  executionTimeSeconds: number;
  original: Blob;
  originalFilename: string;
  originalContentType: string;
  thumb: Blob;
  mid: Blob;
  /** Full-res input images (index-aligned with inputThumbs). Server writes
   *  them to HISTORY_INPUTS_DIR and stores their URLs in promptData.inputImages. */
  inputImages?: Blob[];
  /** 240px input thumbnails (index-aligned). Stored as promptData.inputThumbnails URLs. */
  inputThumbs?: Blob[];
  signal?: AbortSignal;
}

export interface UploadHistoryResult {
  serverGenId: number;
  fullUrl: string;
  thumbUrl: string;
  midUrl: string;
}

/**
 * HTTP statuses we retry on. These are all upstream-proxy or transient
 * conditions where the request *might* never have reached Next.js, or
 * reached it but the response was dropped. The /api/history POST handler
 * is DB-idempotent (findGenerationByOutputPath), so re-sending the same
 * multipart is safe even if the first attempt actually succeeded.
 */
const RETRIABLE_UPLOAD_STATUSES = new Set([502, 503, 504]);

/** Total attempts = MAX_UPLOAD_RETRIES + 1 = 3. */
const MAX_UPLOAD_RETRIES = 2;
const INITIAL_UPLOAD_RETRY_MS = 5000;
const MAX_UPLOAD_RETRY_MS = 15000;

/**
 * Promise-based sleep that rejects with AbortError if the signal fires
 * mid-wait. Without this, an in-flight retry would ignore the user's
 * cancel until the next fetch attempt actually starts.
 */
function sleepWithSignal(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException("Aborted", "AbortError"));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    function onAbort() {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      reject(new DOMException("Aborted", "AbortError"));
    }
    signal?.addEventListener("abort", onAbort);
  });
}

export async function uploadHistoryEntry(
  p: UploadHistoryParams
): Promise<UploadHistoryResult> {
  const fd = new FormData();
  fd.append("uuid", p.uuid);
  fd.append("workflowName", p.workflowName);
  fd.append("promptData", JSON.stringify(p.promptData));
  fd.append("executionTimeSeconds", String(p.executionTimeSeconds));
  fd.append(
    "original",
    new File([p.original], p.originalFilename, {
      type: p.originalContentType || p.original.type || "application/octet-stream",
    })
  );
  fd.append("thumb", new File([p.thumb], `thumb_${p.uuid}.jpg`, { type: "image/jpeg" }));
  fd.append("mid", new File([p.mid], `mid_${p.uuid}.jpg`, { type: "image/jpeg" }));

  const thumbs = p.inputThumbs ?? [];
  const fulls = p.inputImages ?? [];
  fd.append("inputCount", String(thumbs.length));
  thumbs.forEach((thumb, i) => {
    fd.append(`inputthumb_${i}`, new File([thumb], `inputthumb_${i}.jpg`, { type: "image/jpeg" }));
    const full = fulls[i];
    if (full) {
      const ext = full.type === "image/png" ? "png" : full.type === "image/webp" ? "webp" : "jpg";
      fd.append(`inputfull_${i}`, new File([full], `inputfull_${i}.${ext}`, { type: full.type || "image/jpeg" }));
    }
  });

  // Retry on transient proxy 5xx / network errors. Mirrors the server-side
  // fetchWithRetry in lib/providers/comfy.ts in shape: 2 retries, 5s→15s
  // backoff, network errors and retriable statuses both retry, 4xx and
  // non-retriable 5xx surface immediately. Caddy in front of the Next.js
  // upstream has been seen to return 502 when the upstream socket closes
  // mid-request — that's invisible to /api/history and recovers on retry.
  let res: Response | null = null;
  let lastBody = "";
  let delay = INITIAL_UPLOAD_RETRY_MS;
  for (let attempt = 0; attempt <= MAX_UPLOAD_RETRIES; attempt++) {
    if (attempt > 0) await sleepWithSignal(delay, p.signal);
    try {
      res = await fetch("/api/history", {
        method: "POST",
        body: fd,
        signal: p.signal,
      });
    } catch (err) {
      // Surface user-initiated aborts immediately — never retry them.
      if (err instanceof DOMException && err.name === "AbortError") throw err;
      if (attempt === MAX_UPLOAD_RETRIES) throw err;
      delay = Math.min(delay * 2, MAX_UPLOAD_RETRY_MS);
      continue;
    }
    if (res.ok) break;
    if (!RETRIABLE_UPLOAD_STATUSES.has(res.status)) {
      lastBody = await res.text().catch(() => "");
      throw new UploadError(res.status, lastBody);
    }
    // Drain body so the connection can be released before the retry.
    lastBody = await res.text().catch(() => "");
    if (attempt === MAX_UPLOAD_RETRIES) {
      throw new UploadError(res.status, lastBody);
    }
    delay = Math.min(delay * 2, MAX_UPLOAD_RETRY_MS);
  }
  if (!res || !res.ok) {
    // Unreachable under normal control flow — every non-ok exit above
    // throws. Keep TS happy and defend against future edits.
    throw new UploadError(res?.status ?? -1, lastBody);
  }

  const json = (await res.json()) as {
    id?: number;
    success?: boolean;
    fullUrl?: string;
    thumbUrl?: string;
    midUrl?: string;
  };

  if (
    typeof json.id !== "number" ||
    !json.fullUrl ||
    !json.thumbUrl ||
    !json.midUrl
  ) {
    throw new UploadError(-1, `Malformed upload response: ${JSON.stringify(json)}`);
  }

  return {
    serverGenId: json.id,
    fullUrl: json.fullUrl,
    thumbUrl: json.thumbUrl,
    midUrl: json.midUrl,
  };
}

/**
 * Upload failure. `status` is the HTTP status code when the server
 * responded (e.g. 409, 500); `-1` when the server responded 200 but
 * the payload was malformed. Callers distinguish via `status` to
 * decide retry strategy — do NOT use `0`, which browsers reserve
 * for network-level aborts (CORS, offline).
 */
export class UploadError extends Error {
  constructor(public status: number, public body: string) {
    super(`Upload failed: HTTP ${status}${body ? ` — ${body.slice(0, 200)}` : ""}`);
    this.name = "UploadError";
  }
}
