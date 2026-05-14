/**
 * Server-side variant (re)builder.
 *
 * Reads a generation's original from HISTORY_IMAGES_DIR, derives
 * thumb_/mid_ JPEGs using sharp, and writes them to HISTORY_VARIANTS_DIR
 * under the same <email>/<YYYY>/<MM>/ subpath. Idempotent.
 *
 * Used exclusively by the admin "Rebuild variants" tool — the normal
 * generation hot path lets the client produce variants (see lib/image-
 * variants.ts and app/api/history/route.ts).
 */

import type Database from "better-sqlite3";
import { promises as fs } from "node:fs";
import path from "node:path";
import sharp from "sharp";
import {
  THUMB_WIDTH,
  THUMB_QUALITY,
  MID_WIDTH,
  MID_QUALITY,
} from "@/lib/image-variants-spec";
import { renameWithRetry } from "@/lib/admin/folder-rename";

export interface BuildVariantsOpts {
  imagesDir: string;
  variantsDir: string;
}

export type BuildReason =
  | "no_original"        // no image-typed output row
  | "original_missing"   // DB pointed at a file that doesn't exist
  | "decode_failed"      // sharp couldn't open / decode the original
  | "write_failed";      // any write/rename failure

export type BuildResult =
  | { ok: true }
  | { ok: false; reason: BuildReason; error?: string };

interface OutputRow {
  filepath: string;
  content_type: string;
}

export async function buildVariantsForGeneration(
  db: Database.Database,
  generationId: number,
  opts: BuildVariantsOpts
): Promise<BuildResult> {
  const outputs = db.prepare(
    `SELECT filepath, content_type FROM generation_outputs WHERE generation_id = ?`
  ).all(generationId) as OutputRow[];
  const firstImage = outputs.find((o) => o.content_type.startsWith("image/"));
  if (!firstImage) return { ok: false, reason: "no_original" };

  const originalAbs = path.join(opts.imagesDir, firstImage.filepath);
  let originalBuf: Buffer;
  try {
    originalBuf = await fs.readFile(originalAbs);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      return { ok: false, reason: "original_missing", error: originalAbs };
    }
    return { ok: false, reason: "write_failed", error: (err as Error).message };
  }

  const lastSlash = firstImage.filepath.lastIndexOf("/");
  const dir = lastSlash >= 0 ? firstImage.filepath.slice(0, lastSlash) : "";
  const basename = lastSlash >= 0 ? firstImage.filepath.slice(lastSlash + 1) : firstImage.filepath;
  const stem = basename.replace(/\.[a-z0-9]+$/i, "");
  const variantsAbsDir = path.join(opts.variantsDir, dir);
  await fs.mkdir(variantsAbsDir, { recursive: true });

  try {
    await writeVariant(originalBuf, THUMB_WIDTH, THUMB_QUALITY,
      path.join(variantsAbsDir, `thumb_${stem}.jpg`));
    await writeVariant(originalBuf, MID_WIDTH, MID_QUALITY,
      path.join(variantsAbsDir, `mid_${stem}.jpg`));
  } catch (err) {
    const msg = (err as Error).message ?? String(err);
    // sharp throws Error with `.message` containing 'Input buffer contains unsupported image format'
    // or similar for decode failures.
    if (/unsupported image format|Input file/i.test(msg)) {
      return { ok: false, reason: "decode_failed", error: msg };
    }
    return { ok: false, reason: "write_failed", error: msg };
  }
  return { ok: true };
}

async function writeVariant(
  source: Buffer,
  width: number,
  qualityInt: number,
  finalPath: string
): Promise<void> {
  const tmpPath = `${finalPath}.tmp`;
  const buf = await sharp(source)
    .resize({ width, withoutEnlargement: true })
    .jpeg({ quality: qualityInt })
    .toBuffer();
  await fs.writeFile(tmpPath, buf);
  await renameWithRetry(tmpPath, finalPath);
}
