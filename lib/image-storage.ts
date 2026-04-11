// Server-only. Writes generated images to the SAME directory used by
// the history subsystem (lib/history-db.ts → HISTORY_IMAGES_DIR) and
// returns a URL served by app/api/history/image/[filename]/route.ts.
//
// IMPORTANT: We do NOT write to public/generated/ anymore. Next.js 15
// standalone builds snapshot public/ at server start and ignore any
// files created at runtime — they return 404 through the built-in static
// handler. Instead, we write to HISTORY_DATA_DIR/history_images/ (which
// is already mounted as a Docker volume at /data in docker-compose.yml,
// and is already served by the existing history-image route handler).
//
// Why reuse history-db's directory instead of a new one:
//   1. Single persistent storage point — simpler backup/cleanup.
//   2. The route handler at /api/history/image/[filename] already exists,
//      already uses the same getHistoryImagesDir() helper, and already
//      has path-traversal defense. No need to duplicate it.
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

async function ensureDir() {
  await mkdir(getGeneratedDir(), { recursive: true });
}

export interface SavedImage {
  /** Just the filename, e.g. "abc123.png" */
  filename: string;
  /** URL served by /api/history/image/[filename] route handler */
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
 * Write a binary buffer to HISTORY_IMAGES_DIR/<uuid>.<ext> and return
 * the filename + served URL. Creates the directory on first call.
 */
export async function saveBinary(
  data: ArrayBuffer | Uint8Array | Buffer,
  ext: string
): Promise<SavedImage> {
  await ensureDir();

  const normalizedExt = normalizeExt(ext);
  const filename = `${randomUUID()}.${normalizedExt}`;
  const absolutePath = join(getGeneratedDir(), filename);

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
    filename,
    // Served by app/api/history/image/[filename]/route.ts — the same
    // route that the history sidebar uses for thumbnails. NOT
    // /generated/<name> (public/ snapshot issue, see top-of-file).
    publicUrl: `/api/history/image/${filename}`,
    absolutePath,
    sizeBytes: buffer.byteLength,
  };
}

/**
 * Download a remote image URL and save it locally.
 * Extension is inferred from Content-Type unless `preferredExt` is provided.
 */
export async function downloadAndSave(
  url: string,
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
  return saveBinary(arrayBuffer, ext);
}

/**
 * Save a base64 data URI (e.g. "data:image/png;base64,iVBOR...") or a plain
 * base64 string to the generated images directory.
 */
export async function saveBase64(
  base64OrDataUri: string,
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
  return saveBinary(buffer, ext);
}
