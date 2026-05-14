/**
 * One-time tool: remove thumb_<uuid>.jpg / mid_<uuid>.jpg files that
 * predate the variants-separation work, leaving originals untouched.
 *
 * Walks HISTORY_IMAGES_DIR/<email>/<YYYY>/<MM>/* and matches basenames
 * against ^(thumb|mid)_<UUID>.jpg$. Anything that is not an email-shaped
 * top-level entry is skipped - this protects deleted_{email}/ cold archives.
 */

import { promises as fs } from "node:fs";
import path from "node:path";

const VARIANT_RE = /^(thumb|mid)_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.jpg$/i;
const YYYY_RE = /^\d{4}$/;
const MM_RE = /^\d{2}$/;

function looksLikeEmail(name: string): boolean {
  // Cheap, conservative: must contain "@" and a dot, no leading "deleted_".
  return name.includes("@") && name.includes(".") && !name.startsWith("deleted_");
}

export interface ScanResult {
  count: number;
  dirs: string[];
}

export async function scanLegacyVariants(imagesDir: string): Promise<ScanResult> {
  const dirsSet = new Set<string>();
  let count = 0;
  await walk(imagesDir, async (_absPath, relPath) => {
    count++;
    dirsSet.add(path.dirname(relPath));
  });
  return { count, dirs: Array.from(dirsSet).sort() };
}

export interface PurgeResult {
  deleted: number;
}

export async function purgeLegacyVariants(imagesDir: string): Promise<PurgeResult> {
  let deleted = 0;
  await walk(imagesDir, async (absPath) => {
    try {
      await fs.unlink(absPath);
      deleted++;
    } catch {
      // ignore - file vanished between walk and unlink
    }
  });
  return { deleted };
}

async function walk(
  imagesDir: string,
  onMatch: (absPath: string, relPath: string) => Promise<void>
): Promise<void> {
  let owners: string[];
  try {
    owners = await fs.readdir(imagesDir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
    throw err;
  }
  for (const owner of owners) {
    if (!looksLikeEmail(owner)) continue;
    const yearDir = path.join(imagesDir, owner);
    let years: string[];
    try { years = await fs.readdir(yearDir); } catch { continue; }
    for (const yyyy of years) {
      if (!YYYY_RE.test(yyyy)) continue;
      const monthDir = path.join(yearDir, yyyy);
      let months: string[];
      try { months = await fs.readdir(monthDir); } catch { continue; }
      for (const mm of months) {
        if (!MM_RE.test(mm)) continue;
        const leafDir = path.join(monthDir, mm);
        let files: string[];
        try { files = await fs.readdir(leafDir); } catch { continue; }
        for (const f of files) {
          if (!VARIANT_RE.test(f)) continue;
          const abs = path.join(leafDir, f);
          const rel = path.join(owner, yyyy, mm, f).replace(/\\/g, "/");
          await onMatch(abs, rel);
        }
      }
    }
  }
}
