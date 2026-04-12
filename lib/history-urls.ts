import type { HistoryEntry } from "@/types/wavespeed";

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
