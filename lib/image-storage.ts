// Server-only. Writes generated images to `public/generated/` and returns
// a public URL that Next.js will serve from the static directory.
//
// Used by sync providers (Fal) and any provider that returns an external URL
// or base64 blob which we want to cache locally.

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

const GENERATED_DIR = join(process.cwd(), "public", "generated");

async function ensureDir() {
  await mkdir(GENERATED_DIR, { recursive: true });
}

export interface SavedImage {
  /** Just the filename, e.g. "abc123.png" */
  filename: string;
  /** Public URL served by Next.js static, e.g. "/generated/abc123.png" */
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
 * Write a binary buffer to `public/generated/<uuid>.<ext>` and return
 * the filename + public URL. Creates the directory on first call.
 */
export async function saveBinary(
  data: ArrayBuffer | Uint8Array | Buffer,
  ext: string
): Promise<SavedImage> {
  await ensureDir();

  const normalizedExt = normalizeExt(ext);
  const filename = `${randomUUID()}.${normalizedExt}`;
  const absolutePath = join(GENERATED_DIR, filename);

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
    publicUrl: `/generated/${filename}`,
    absolutePath,
    sizeBytes: buffer.byteLength,
  };
}

/**
 * Download a remote image URL and save it to `public/generated/`.
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
 * base64 string to `public/generated/`.
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
