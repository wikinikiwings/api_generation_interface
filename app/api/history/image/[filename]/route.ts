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
    const buf = await fs.readFile(resolved);
    const contentType = mime.lookup(filename) || "application/octet-stream";
    return new NextResponse(new Uint8Array(buf), {
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
