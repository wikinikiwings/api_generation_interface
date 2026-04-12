import { type NextRequest, NextResponse } from "next/server";
import {
  saveGeneration,
  getGenerations,
  deleteGeneration,
  getHistoryImagesDir,
} from "@/lib/history-db";
import fs from "node:fs/promises";
import path from "node:path";

// sharp is no longer imported — client pre-generates thumb/mid.

// Uploads are local + variants are pre-built client-side (no server-side
// resize), so 30s is ample for even multi-MB originals on LAN.
export const maxDuration = 30;

/**
 * GET /api/history?username=X&startDate=&endDate=&limit=&offset=
 * Returns generations for a given username, newest first.
 */
export async function GET(request: NextRequest) {
  const sp = request.nextUrl.searchParams;
  const username = sp.get("username");
  if (!username) {
    return NextResponse.json({ error: "username is required" }, { status: 400 });
  }
  try {
    const generations = getGenerations({
      username,
      startDate: sp.get("startDate") || undefined,
      endDate: sp.get("endDate") || undefined,
      limit: sp.get("limit") ? parseInt(sp.get("limit")!) : 100,
      offset: sp.get("offset") ? parseInt(sp.get("offset")!) : 0,
    });
    return NextResponse.json(generations);
  } catch (err) {
    console.error("[history GET] failed:", err);
    return NextResponse.json({ error: "Failed to fetch history" }, { status: 500 });
  }
}

/**
 * POST /api/history — multipart form:
 *   uuid          required, matches /^[0-9a-f-]{36}$/i (crypto.randomUUID format)
 *   username      required
 *   workflowName  string
 *   promptData    JSON string
 *   executionTimeSeconds  number string
 *   original      File, image/*
 *   thumb         File, image/jpeg
 *   mid           File, image/jpeg
 *
 * Writes three files in parallel:
 *   <uuid>.<ext>       — original bytes
 *   thumb_<uuid>.jpg   — client-generated 240px
 *   mid_<uuid>.jpg     — client-generated 1200px
 *
 * No sharp usage — the client is the sole generator of variants.
 * Returns { id, success, fullUrl, thumbUrl, midUrl }.
 */
export async function POST(request: NextRequest) {
  try {
    const formData = await request.formData();
    const uuid = (formData.get("uuid") as string | null)?.trim() ?? "";
    const username = formData.get("username") as string;
    const workflowName = (formData.get("workflowName") as string) || "";
    const promptData = JSON.parse(
      (formData.get("promptData") as string) || "{}"
    );
    const executionTimeSeconds = parseFloat(
      (formData.get("executionTimeSeconds") as string) || "0"
    );
    const original = formData.get("original");
    const thumb = formData.get("thumb");
    const mid = formData.get("mid");

    if (!username) {
      return NextResponse.json(
        { error: "username is required" },
        { status: 400 }
      );
    }
    if (!/^[0-9a-f-]{36}$/i.test(uuid)) {
      return NextResponse.json(
        { error: "valid uuid is required" },
        { status: 400 }
      );
    }
    if (
      !(original instanceof File) ||
      !(thumb instanceof File) ||
      !(mid instanceof File)
    ) {
      return NextResponse.json(
        { error: "original, thumb, mid files are required" },
        { status: 400 }
      );
    }
    if (!original.type.startsWith("image/")) {
      return NextResponse.json(
        { error: "original must be image/*" },
        { status: 400 }
      );
    }
    if (thumb.type !== "image/jpeg" || mid.type !== "image/jpeg") {
      return NextResponse.json(
        { error: "thumb and mid must be image/jpeg" },
        { status: 400 }
      );
    }

    const dir = getHistoryImagesDir();
    const ext = path.extname(original.name) || getExtFromMime(original.type);
    const originalFilename = `${uuid}${ext}`;
    const thumbFilename = `thumb_${uuid}.jpg`;
    const midFilename = `mid_${uuid}.jpg`;

    const originalPath = path.join(dir, originalFilename);
    const thumbPath = path.join(dir, thumbFilename);
    const midPath = path.join(dir, midFilename);

    // Uuid collision check — if any of the three files already exists,
    // refuse to overwrite. Client treats 409 as a bug and retries with
    // a fresh uuid.
    const [oExists, tExists, mExists] = await Promise.all([
      exists(originalPath),
      exists(thumbPath),
      exists(midPath),
    ]);
    if (oExists || tExists || mExists) {
      return NextResponse.json(
        { error: "uuid collision" },
        { status: 409 }
      );
    }

    // Write all three in parallel. If any write fails, roll back the
    // others so no partial state survives on disk.
    const written: string[] = [];
    try {
      await Promise.all([
        writeAndTrack(originalPath, original, written),
        writeAndTrack(thumbPath, thumb, written),
        writeAndTrack(midPath, mid, written),
      ]);
    } catch (err) {
      await Promise.all(
        written.map((p) => fs.unlink(p).catch(() => undefined))
      );
      throw err;
    }

    // Sanitize the display filename: strip any path separators a client
    // may have sent and cap length. `originalFilename` (actual on-disk
    // name) is uuid-derived and already safe.
    const displayFilename = path.basename(original.name).slice(0, 255);

    const id = saveGeneration({
      username,
      workflowName,
      promptData,
      executionTimeSeconds,
      outputs: [
        {
          filename: displayFilename,
          filepath: originalFilename,
          contentType: original.type,
          size: original.size,
        },
      ],
    });

    return NextResponse.json({
      id,
      success: true,
      fullUrl: `/api/history/image/${encodeURIComponent(originalFilename)}`,
      thumbUrl: `/api/history/image/${encodeURIComponent(thumbFilename)}`,
      midUrl: `/api/history/image/${encodeURIComponent(midFilename)}`,
    });
  } catch (err) {
    console.error("[history POST] failed:", err);
    return NextResponse.json({ error: "Failed to save history" }, { status: 500 });
  }
}

async function exists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

async function writeAndTrack(
  filepath: string,
  file: File,
  tracker: string[]
): Promise<void> {
  // Register BEFORE any I/O so the rollback sees this path even if
  // another parallel write rejects while this one is still in flight.
  // The rollback unlinks tolerate ENOENT via .catch(() => undefined).
  tracker.push(filepath);
  const buffer = Buffer.from(await file.arrayBuffer());
  await fs.writeFile(filepath, buffer);
}

/**
 * DELETE /api/history?id=X&username=Y — soft delete.
 * Removes the DB record. Files on disk intentionally stay (they may be
 * referenced elsewhere, and disk is cheap).
 */
export async function DELETE(request: NextRequest) {
  const sp = request.nextUrl.searchParams;
  const id = sp.get("id");
  const username = sp.get("username");
  if (!id || !username) {
    return NextResponse.json(
      { error: "id and username are required" },
      { status: 400 }
    );
  }
  try {
    const { deleted } = deleteGeneration(parseInt(id), username);
    return NextResponse.json({ success: deleted });
  } catch (err) {
    console.error("[history DELETE] failed:", err);
    return NextResponse.json(
      { error: "Failed to delete history" },
      { status: 500 }
    );
  }
}

function getExtFromMime(mimeType: string): string {
  const map: Record<string, string> = {
    "image/png": ".png",
    "image/jpeg": ".jpg",
    "image/gif": ".gif",
    "image/webp": ".webp",
    "video/mp4": ".mp4",
    "video/webm": ".webm",
    "audio/mpeg": ".mp3",
    "audio/wav": ".wav",
  };
  return map[mimeType] || ".bin";
}
