/**
 * Extract uuid from a server-history filepath. Files are stored as either:
 *   - legacy flat:   `<uuid>.<ext>`
 *   - new layout:    `<email>/<YYYY>/<MM>/<uuid>.<ext>` (Task 7.3)
 * Returns null for non-uuid filenames.
 */
export function extractUuid(filepath: string): string | null {
  const m =
    /(?:^|\/)([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\./i.exec(
      filepath
    );
  return m ? m[1].toLowerCase() : null;
}

/**
 * Parse a server-supplied timestamp string to ms since epoch as UTC.
 *
 * SQLite's `datetime('now')` returns "YYYY-MM-DD HH:MM:SS" in UTC but with
 * no timezone suffix. V8/Chrome interprets that non-ISO format as LOCAL
 * time, which silently shifts createdAt by the client's UTC offset and
 * can push "today" entries out of the Output strip's today-range filter
 * after the SSE merge overwrites the pending entry's Date.now() value.
 * ISO strings with Z or ±HH:MM already parse correctly; this helper is
 * a no-op for those.
 */
export function parseServerDate(s: string): number {
  if (!s) return NaN;
  if (/[zZ]|[+-]\d{2}:?\d{2}$/.test(s)) return Date.parse(s);
  return Date.parse(s.replace(" ", "T") + "Z");
}
