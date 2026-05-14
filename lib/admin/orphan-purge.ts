/**
 * Scan + purge tool for orphan originals.
 *
 * An orphan is a UUID-shaped file in HISTORY_IMAGES_DIR/<email>/<YYYY>/<MM>/
 * that is not referenced by any generation_outputs.filepath row. Created
 * historically by sync providers (Fal/Comfy) that saved server-side AND
 * let the client re-upload — those server saves were never linked to a
 * DB row.
 *
 * Conservative filters:
 *   - top-level dirs starting with `deleted_` are skipped (cold archives)
 *   - basenames starting with `thumb_` / `mid_` are skipped (legacy-purge's job)
 *   - non-UUID-shaped basenames are skipped (treat as user data)
 */

import type Database from "better-sqlite3";
import { promises as fs } from "node:fs";
import path from "node:path";

const ORIGINAL_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.[a-z0-9]+$/i;
const VARIANT_RE = /^(thumb|mid)_/i;
const YYYY_RE = /^\d{4}$/;
const MM_RE = /^\d{2}$/;

function looksLikeEmail(name: string): boolean {
  // Cheap, conservative: must contain "@" and a dot, no leading "deleted_".
  return name.includes("@") && name.includes(".") && !name.startsWith("deleted_");
}

function loadKnownPaths(db: Database.Database): Set<string> {
  const rows = db
    .prepare(`SELECT filepath FROM generation_outputs`)
    .all() as Array<{ filepath: string }>;
  return new Set(rows.map((r) => r.filepath));
}

export interface ScanResult {
  count: number;
  files: string[];
}

export async function scanOrphans(
  db: Database.Database,
  imagesDir: string
): Promise<ScanResult> {
  const known = loadKnownPaths(db);
  const files: string[] = [];
  await walk(imagesDir, known, (rel) => {
    files.push(rel);
  });
  files.sort();
  return { count: files.length, files };
}

export interface PurgeResult {
  deleted: number;
}

export async function purgeOrphans(
  db: Database.Database,
  imagesDir: string
): Promise<PurgeResult> {
  const known = loadKnownPaths(db);
  let deleted = 0;
  await walk(imagesDir, known, async (rel) => {
    const abs = path.join(imagesDir, rel);
    try {
      await fs.unlink(abs);
      deleted++;
    } catch {
      // ignore — vanished between walk and unlink
    }
  });
  return { deleted };
}

async function walk(
  imagesDir: string,
  known: Set<string>,
  onOrphan: (rel: string) => void | Promise<void>
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
    const ownerDir = path.join(imagesDir, owner);
    let years: string[];
    try {
      years = await fs.readdir(ownerDir);
    } catch {
      continue;
    }
    for (const yyyy of years) {
      if (!YYYY_RE.test(yyyy)) continue;
      const yearDir = path.join(ownerDir, yyyy);
      let months: string[];
      try {
        months = await fs.readdir(yearDir);
      } catch {
        continue;
      }
      for (const mm of months) {
        if (!MM_RE.test(mm)) continue;
        const leafDir = path.join(yearDir, mm);
        let files: string[];
        try {
          files = await fs.readdir(leafDir);
        } catch {
          continue;
        }
        for (const f of files) {
          if (VARIANT_RE.test(f)) continue;
          if (!ORIGINAL_RE.test(f)) continue;
          const rel = `${owner}/${yyyy}/${mm}/${f}`;
          if (known.has(rel)) continue;
          await onOrphan(rel);
        }
      }
    }
  }
}
