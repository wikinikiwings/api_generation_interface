import { type NextRequest, NextResponse } from "next/server";
import {
  getDb,
  saveGeneration,
  getGenerations,
  deleteGeneration,
  getHistoryImagesDir,
  getGenerationById,
} from "@/lib/history-db";
import { getCurrentUser } from "@/lib/auth/current-user";
import { SESSION_COOKIE_NAME } from "@/lib/auth/cookie-name";
import { broadcastToUserId } from "@/lib/sse-broadcast";
import fs from "node:fs/promises";
import path from "node:path";

function readSessionCookie(req: NextRequest): string | null {
  return req.cookies.get(SESSION_COOKIE_NAME)?.value ?? null;
}

// sharp is no longer imported — client pre-generates thumb/mid.

// Uploads are local + variants are pre-built client-side (no server-side
// resize), so 30s is ample for even multi-MB originals on LAN.
export const maxDuration = 30;

/**
 * GET /api/history?startDate=&endDate=&limit=&offset=
 * Returns generations for the session-authenticated user, newest first.
 */
export async function GET(request: NextRequest) {
  const user = getCurrentUser(getDb(), readSessionCookie(request));
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const sp = request.nextUrl.searchParams;
  try {
    const generations = getGenerations({
      user_id: user.id,
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
 *
 * NOTE: This handler still reads `username` from formData and calls the
 * legacy `saveGeneration` (which references the removed `username` column
 * and will throw at runtime). Task 7.3 rewrites this handler to use
 * session-cookie auth + the new `<email>/YYYY/MM/` filesystem layout +
 * `user_id`/`model_id`/`provider` columns.
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
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(uuid)) {
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

    // Fan out the new row to every connected client of this username.
    // Errors are caught so a broadcast failure never affects the HTTP
    // response — clients will catch up on next reconnect's refetch.
    try {
      const newRow = getGenerationById(id);
      if (newRow) {
        broadcastToUserId(/* TODO(plan-7.3): real user.id from getCurrentUser */ -1, {
          type: "generation.created",
          data: newRow,
        });
      }
    } catch (err) {
      console.error("[history POST] broadcast failed:", err);
    }

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
 * DELETE /api/history?id=X — delete a generation owned by the session user.
 * Removes the DB record. Files on disk intentionally stay (they may be
 * referenced elsewhere, and disk is cheap).
 */
export async function DELETE(request: NextRequest) {
  const user = getCurrentUser(getDb(), readSessionCookie(request));
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const id = request.nextUrl.searchParams.get("id");
  if (!id) return NextResponse.json({ error: "id is required" }, { status: 400 });

  try {
    const { deleted } = deleteGeneration(parseInt(id), user.id);
    if (deleted) {
      try {
        broadcastToUserId(user.id, {
          type: "generation.deleted",
          data: { id: parseInt(id) },
        });
      } catch (err) {
        console.error("[history DELETE] broadcast failed:", err);
      }
    }
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
