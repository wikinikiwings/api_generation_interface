import type { HistoryEntry } from "@/types/wavespeed";

/**
 * Extract the UUID from a local history-image URL of the shape
 *   `/api/history/image/<email>/<YYYY>/<MM>/<uuid>.<ext>`
 *
 * Returns `null` for any URL that doesn't fit this shape (external URLs,
 * legacy flat URLs without email/yyyy/mm, blob: URIs, data: URIs, etc).
 *
 * Used by the upload pipeline to detect the case where the provider has
 * already saved the original server-side: the client then reuses the
 * server-chosen UUID for its multipart upload, and the POST handler
 * notices the original file already exists and skips the duplicate write.
 */
export function extractServerUuid(url: string): string | null {
  const m = url.match(
    /\/api\/history\/image\/[^/]+\/\d{4}\/\d{2}\/([^/?#]+)\.[^./?#]+$/
  );
  if (!m) return null;
  return decodeURIComponent(m[1]);
}

/**
 * Returns a thumb (~240px) URL for a history entry, or `undefined` when
 * no such URL can be known without a server roundtrip.
 *
 * Resolution order:
 *   1. `entry.thumbUrl` if set (modern entries fill this in directly).
 *   2. Derive `thumb_<uuid>.jpg` from `originalUrl`/`outputUrl` when that
 *      URL points at our history-image endpoint (legacy rows from before
 *      the pretty-image-loading work).
 *   3. Otherwise `undefined` — caller should fall back to a blur-on-sharp
 *      backdrop (see `<BlurUpImage>`'s fallback mode).
 *
 * Blob URLs always return `undefined`: client-generated variants live
 * in separate blob URLs that the caller tracks independently (see
 * `components/generate-form.tsx`).
 */
export function thumbUrlForEntry(
  entry: Pick<HistoryEntry, "thumbUrl" | "originalUrl" | "outputUrl">
): string | undefined {
  if (entry.thumbUrl) return entry.thumbUrl;
  const src = entry.originalUrl ?? entry.outputUrl;
  if (!src) return undefined;
  if (src.startsWith("blob:")) return undefined;
  // Match /api/history/image/<basename>.<ext> — encodeURIComponent-safe
  // because server filenames are UUIDs + one extension, no slashes.
  const match = src.match(/\/api\/history\/image\/([^?/]+)\.[^./?]+$/);
  if (!match) return undefined;
  const base = decodeURIComponent(match[1]);
  return `/api/history/image/${encodeURIComponent(`thumb_${base}.jpg`)}`;
}
