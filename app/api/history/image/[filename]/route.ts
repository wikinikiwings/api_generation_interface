import { type NextRequest, NextResponse } from "next/server";
import { getHistoryImagesDir } from "@/lib/history-db";
import path from "node:path";
import fs from "node:fs/promises";
import mime from "mime-types";

/**
 * GET /api/history/image/[filename]
 *
 * Streams a file from HISTORY_IMAGES_DIR. Used by history-sidebar to render
 * thumbnails (`thumb_<uuid>.jpg`), mid-res previews (`mid_<uuid>.png`), and
 * originals. Schema-compatible with viewcomfy-claude — same filename format,
 * same directory layout.
 *
 * Security: filename is hard-validated against `..`, path separators, and
 * absolute paths so no directory traversal escape from HISTORY_IMAGES_DIR.
 */
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ filename: string }> }
) {
  const { filename } = await params;

  // Reject traversal attempts and any path-like input outright.
  if (
    !filename ||
    filename.includes("..") ||
    filename.includes("/") ||
    filename.includes("\\") ||
    path.isAbsolute(filename)
  ) {
    return NextResponse.json({ error: "Invalid filename" }, { status: 400 });
  }

  const dir = getHistoryImagesDir();
  const filePath = path.join(dir, filename);

  // Defense-in-depth: even after the checks above, ensure the resolved path
  // still lives inside the images dir.
  const resolved = path.resolve(filePath);
  if (!resolved.startsWith(path.resolve(dir))) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  try {
    const result = await readWithMidFallback(resolved, filename, dir);
    const contentType = mime.lookup(result.filename) || "application/octet-stream";
    return new NextResponse(new Uint8Array(result.bytes), {
      status: 200,
      headers: {
        "Content-Type": contentType,
        // Files are immutable (UUID names) → cache aggressively.
        "Cache-Control": "public, max-age=31536000, immutable",
      },
    });
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }
    console.error("[history image] read failed:", err);
    return NextResponse.json({ error: "Read failed" }, { status: 500 });
  }
}

/**
 * Read the requested file, or — for `mid_*` variants only — fall back
 * to the sibling extension. Legacy entries wrote `mid_<uuid>.png`; new
 * entries write `mid_<uuid>.jpg`. Clients always request `.jpg` after
 * the thumbnail-first change, so we transparently serve the legacy
 * `.png` when the `.jpg` is missing.
 *
 * Returns the bytes AND the effective filename (so Content-Type reflects
 * what was actually served, not what was requested).
 */
async function readWithMidFallback(
  primaryPath: string,
  requestedFilename: string,
  dir: string
): Promise<{ bytes: Buffer; filename: string }> {
  try {
    const bytes = await fs.readFile(primaryPath);
    return { bytes, filename: requestedFilename };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    if (!requestedFilename.startsWith("mid_")) throw err;
    const lower = requestedFilename.toLowerCase();
    const altName =
      lower.endsWith(".jpg")
        ? lower.slice(0, -4) + ".png"
        : lower.endsWith(".png")
          ? lower.slice(0, -4) + ".jpg"
          : null;
    if (!altName) throw err;
    const altPath = path.join(dir, altName);
    // Defense-in-depth: even though altName is derived from an already-
    // validated filename by a fixed 4-char extension swap, re-run the
    // "resolved path must live inside dir" check here so the helper is
    // safe to reuse without relying on caller validation.
    if (!path.resolve(altPath).startsWith(path.resolve(dir))) {
      throw err;
    }
    const bytes = await fs.readFile(altPath);
    return { bytes, filename: altName };
  }
}
