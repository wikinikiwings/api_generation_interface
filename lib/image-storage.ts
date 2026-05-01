// Server-only. Writes generated images to the SAME directory used by
// the history subsystem (lib/history-db.ts → HISTORY_IMAGES_DIR) and
// returns a URL served by app/api/history/image/[...path]/route.ts.
//
// IMPORTANT: We do NOT write to public/generated/ anymore. Next.js 15
// standalone builds snapshot public/ at server start and ignore any
// files created at runtime — they return 404 through the built-in static
// handler. Instead, we write to HISTORY_DATA_DIR/history_images/ (which
// is already mounted as a Docker volume at /data in docker-compose.yml,
// and is already served by the existing history-image route handler).
//
// Layout: `<HISTORY_IMAGES_DIR>/<email>/<YYYY>/<MM>/<uuid>.<ext>`. The
// `<email>/<YYYY>/<MM>` prefix is required by the [...path] image route
// (introduced by the Google OAuth migration — Task 7.3) which gates reads
// to "owner email matches first segment, or admin". A flat layout would
// 400 on read.
//
// Why reuse history-db's directory instead of a new one:
//   1. Single persistent storage point — simpler backup/cleanup.
//   2. The route handler at /api/history/image/[...path] already exists,
//      already uses the same getHistoryImagesDir() helper, and already
//      has path-traversal defense and per-user auth.
//   3. Schema-compatible with viewcomfy-claude which shares the same DB.
//
// Used by sync providers (Fal, Comfy) and any provider that returns an
// external URL or base64 blob which we want to cache locally.

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { getHistoryImagesDir } from "@/lib/history-db";

// Resolved lazily so history-db's sync mkdir side effect at import time
// doesn't fire until this module is actually used.
function getGeneratedDir(): string {
  return getHistoryImagesDir();
}

/** Build the YYYY/MM segment pair under the user's email, in UTC.
 *  Mirrors the convention used by app/api/history/route.ts (POST). */
function buildOwnerDir(userEmail: string): { relDir: string; yyyy: string; mm: string } {
  const now = new Date();
  const yyyy = String(now.getUTCFullYear());
  const mm = String(now.getUTCMonth() + 1).padStart(2, "0");
  return { relDir: `${userEmail}/${yyyy}/${mm}`, yyyy, mm };
}

/** Build the public URL for a given owner/year/month/filename. Encodes
 *  per-segment so that `@` in emails and other URL-reserved chars are
 *  preserved without merging with separator slashes. The route's
 *  per-segment "no /" check then sees clean values. */
function buildPublicUrl(userEmail: string, yyyy: string, mm: string, filename: string): string {
  return `/api/history/image/${encodeURIComponent(userEmail)}/${yyyy}/${mm}/${encodeURIComponent(filename)}`;
}

export interface SavedImage {
  /** Path relative to HISTORY_IMAGES_DIR: `<email>/<YYYY>/<MM>/<uuid>.<ext>` */
  filename: string;
  /** URL served by /api/history/image/[...path] route handler */
  publicUrl: string;
  /** Absolute path on disk */
  absolutePath: string;
  /** Byte size of the written file */
  sizeBytes: number;
}

/**
 * Normalize an extension: strip leading dot, lowercase, map jpg → jpeg
 * for consistency. Defaults to "png" on unknown input.
 */
export function normalizeExt(raw: string | null | undefined): string {
  if (!raw) return "png";
  let ext = raw.trim().replace(/^\./, "").toLowerCase();
  if (ext === "jpg") ext = "jpeg";
  if (!/^[a-z0-9]+$/.test(ext)) return "png";
  return ext;
}

/** Infer an extension from a Content-Type header value. */
export function extFromContentType(contentType: string | null | undefined): string {
  if (!contentType) return "png";
  const lower = contentType.toLowerCase();
  if (lower.includes("png")) return "png";
  if (lower.includes("jpeg") || lower.includes("jpg")) return "jpeg";
  if (lower.includes("webp")) return "webp";
  if (lower.includes("gif")) return "gif";
  return "png";
}

/**
 * Write a binary buffer to `<HISTORY_IMAGES_DIR>/<email>/<YYYY>/<MM>/<uuid>.<ext>`
 * and return the relative path + served URL. Creates intermediate
 * directories on demand.
 *
 * `userEmail` is REQUIRED — the [...path] route serves only paths whose
 * first segment matches the requesting user's email (or admin). Writing
 * to a flat layout would mean the resulting URL 400s on read, which is
 * what the OAuth migration changed silently and broke this path.
 */
export async function saveBinary(
  data: ArrayBuffer | Uint8Array | Buffer,
  ext: string,
  userEmail: string
): Promise<SavedImage> {
  const { relDir, yyyy, mm } = buildOwnerDir(userEmail);
  const absDir = join(getGeneratedDir(), relDir);
  await mkdir(absDir, { recursive: true });

  const normalizedExt = normalizeExt(ext);
  const basename = `${randomUUID()}.${normalizedExt}`;
  const absolutePath = join(absDir, basename);

  // Normalize all supported input types to Buffer
  let buffer: Buffer;
  if (Buffer.isBuffer(data)) {
    buffer = data;
  } else if (data instanceof Uint8Array) {
    buffer = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  } else {
    // ArrayBuffer
    buffer = Buffer.from(new Uint8Array(data));
  }

  await writeFile(absolutePath, buffer);

  return {
    filename: `${relDir}/${basename}`,
    publicUrl: buildPublicUrl(userEmail, yyyy, mm, basename),
    absolutePath,
    sizeBytes: buffer.byteLength,
  };
}

/**
 * Download a remote image URL and save it locally under the user's
 * `<email>/<YYYY>/<MM>/` directory. Extension inferred from Content-Type
 * unless `preferredExt` is provided.
 */
export async function downloadAndSave(
  url: string,
  userEmail: string,
  preferredExt?: string
): Promise<SavedImage> {
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) {
    throw new Error(
      `Failed to download ${url}: HTTP ${res.status} ${res.statusText}`
    );
  }
  const contentType = res.headers.get("content-type");
  const ext = preferredExt || extFromContentType(contentType);
  const arrayBuffer = await res.arrayBuffer();
  return saveBinary(arrayBuffer, ext, userEmail);
}

/**
 * Save a base64 data URI (e.g. "data:image/png;base64,iVBOR...") or a plain
 * base64 string to the user's images directory.
 */
export async function saveBase64(
  base64OrDataUri: string,
  userEmail: string,
  fallbackExt: string = "png"
): Promise<SavedImage> {
  let base64 = base64OrDataUri;
  let ext = fallbackExt;

  const dataUriMatch = base64OrDataUri.match(
    /^data:([^;]+);base64,(.+)$/
  );
  if (dataUriMatch) {
    ext = extFromContentType(dataUriMatch[1]);
    base64 = dataUriMatch[2];
  }

  const buffer = Buffer.from(base64, "base64");
  return saveBinary(buffer, ext, userEmail);
}
