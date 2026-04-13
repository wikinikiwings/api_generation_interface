/**
 * Extract uuid from a server-history filepath. Files are stored as
 * <uuid>.<ext>. Returns null for legacy non-uuid filenames.
 */
export function extractUuid(filepath: string): string | null {
  const m = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\./i.exec(
    filepath
  );
  return m ? m[1].toLowerCase() : null;
}
