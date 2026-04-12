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
  username: string;
  workflowName: string;
  promptData: Record<string, unknown>;
  executionTimeSeconds: number;
  original: Blob;
  originalFilename: string;
  originalContentType: string;
  thumb: Blob;
  mid: Blob;
  signal?: AbortSignal;
}

export interface UploadHistoryResult {
  serverGenId: number;
  fullUrl: string;
  thumbUrl: string;
  midUrl: string;
}

export async function uploadHistoryEntry(
  p: UploadHistoryParams
): Promise<UploadHistoryResult> {
  const fd = new FormData();
  fd.append("uuid", p.uuid);
  fd.append("username", p.username);
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

  const res = await fetch("/api/history", {
    method: "POST",
    body: fd,
    signal: p.signal,
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new UploadError(res.status, body);
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
    throw new UploadError(0, `Malformed upload response: ${JSON.stringify(json)}`);
  }

  return {
    serverGenId: json.id,
    fullUrl: json.fullUrl,
    thumbUrl: json.thumbUrl,
    midUrl: json.midUrl,
  };
}

export class UploadError extends Error {
  constructor(public status: number, public body: string) {
    super(`Upload failed: HTTP ${status}${body ? ` — ${body.slice(0, 200)}` : ""}`);
    this.name = "UploadError";
  }
}
