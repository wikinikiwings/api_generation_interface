import { dataUrlToBlob } from "@/lib/utils";

/**
 * Build index-aligned { full, thumb } upload blobs for input images from
 * their IN-MEMORY data URLs — never from the original `File` objects.
 *
 * Why not the File: a File dropped from disk (or picked via <input>) is a
 * live reference the browser re-validates against the filesystem at
 * network-send time. The history upload (`POST /api/history`) runs AFTER
 * the — possibly minutes-long — generation, so if the OS/sync/preview
 * touched the source file in the meantime, Chromium rejects the whole
 * multipart with `net::ERR_UPLOAD_FILE_CHANGED`. The request never
 * completes, the server never writes the row, and the generation silently
 * vanishes from history/stats (see 2026-07-01 incident). A data URL is a
 * snapshot captured at drop time and is immune to on-disk changes.
 *
 * `img.dataUrl` already holds the full bytes of the final (optimized or
 * pass-through) file — it's what we also send to the provider — so
 * reconstructing the full input from it costs no fidelity.
 *
 * A pair is dropped (both arrays skip that index together) when either the
 * thumbnail or the full data URL is missing / not a base64 data URL, so the
 * returned arrays stay aligned for the multipart writer.
 */
export function buildInputUploadBlobs(
  images: { dataUrl: string }[],
  thumbnails: string[]
): { fulls: Blob[]; thumbs: Blob[] } {
  const fulls: Blob[] = [];
  const thumbs: Blob[] = [];
  images.forEach((img, i) => {
    const t = thumbnails[i];
    if (typeof t !== "string" || !t.startsWith("data:")) return;
    if (typeof img.dataUrl !== "string" || !img.dataUrl.startsWith("data:")) return;
    let thumbBlob: Blob;
    let fullBlob: Blob;
    try {
      thumbBlob = dataUrlToBlob(t);
      fullBlob = dataUrlToBlob(img.dataUrl);
    } catch {
      // Malformed pair — skip both so the arrays stay index-aligned.
      return;
    }
    thumbs.push(thumbBlob);
    fulls.push(fullBlob);
  });
  return { fulls, thumbs };
}
