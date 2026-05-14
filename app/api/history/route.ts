import { type NextRequest, NextResponse } from "next/server";
import {
  getDb,
  saveGeneration,
  getGenerations,
  deleteGeneration,
  getHistoryImagesDir,
  getHistoryVariantsDir,
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
 *   workflowName  string
 *   promptData    JSON string (may include modelId and provider)
 *   executionTimeSeconds  number string
 *   original      File, image/*
 *   thumb         File, image/jpeg
 *   mid           File, image/jpeg
 *
 * Auth: session cookie. Returns 401 if not logged in.
 *
 * Writes three files in parallel under <email>/YYYY/MM/:
 *   <uuid>.<ext>       — original bytes
 *   thumb_<uuid>.jpg   — client-generated 240px
 *   mid_<uuid>.jpg     — client-generated 1200px
 *
 * No sharp usage — the client is the sole generator of variants.
 * Returns { id, success, fullUrl, thumbUrl, midUrl }.
 */
export async function POST(request: NextRequest) {
  const user = getCurrentUser(getDb(), readSessionCookie(request));
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  try {
    const formData = await request.formData();
    const uuid = (formData.get("uuid") as string | null)?.trim() ?? "";
    const workflowName = (formData.get("workflowName") as string) || "";
    const promptData = JSON.parse(
      (formData.get("promptData") as string) || "{}"
    );
    const modelId = typeof promptData.modelId === "string" ? promptData.modelId : null;
    const provider = typeof promptData.provider === "string" ? promptData.provider : null;
    const executionTimeSeconds = parseFloat(
      (formData.get("executionTimeSeconds") as string) || "0"
    );
    const original = formData.get("original");
    const thumb = formData.get("thumb");
    const mid = formData.get("mid");

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

    const now = new Date();
    const yyyy = String(now.getUTCFullYear());
    const mm = String(now.getUTCMonth() + 1).padStart(2, "0");
    const relDir = `${user.email}/${yyyy}/${mm}`;
    const imagesAbsDir = path.join(getHistoryImagesDir(), relDir);
    const variantsAbsDir = path.join(getHistoryVariantsDir(), relDir);
    await Promise.all([
      fs.mkdir(imagesAbsDir, { recursive: true }),
      fs.mkdir(variantsAbsDir, { recursive: true }),
    ]);

    const ext = path.extname(original.name) || getExtFromMime(original.type);
    const originalFilename = `${uuid}${ext}`;
    const thumbFilename = `thumb_${uuid}.jpg`;
    const midFilename = `mid_${uuid}.jpg`;

    const originalPath = path.join(imagesAbsDir, originalFilename);
    const thumbPath = path.join(variantsAbsDir, thumbFilename);
    const midPath = path.join(variantsAbsDir, midFilename);

    // Idempotent original write: the sync provider flow (Fal/Comfy via
    // downloadAndSave) has already saved the original under this same
    // uuid before the client triggered the upload — the client extracts
    // that uuid from outputUrl and reuses it here, so finding the file
    // on disk means the bytes are already canonical. Skip the redundant
    // write; the multipart `original` part is accepted but ignored on
    // disk in that case. thumb/mid land in HISTORY_VARIANTS_DIR and are
    // always written (overwrite on the rare second-run case is fine —
    // they're deterministically derived from the original).
    const oExists = await exists(originalPath);

    const written: string[] = [];
    try {
      const tasks: Promise<void>[] = [
        writeAndTrack(thumbPath, thumb, written),
        writeAndTrack(midPath, mid, written),
      ];
      if (!oExists) {
        tasks.push(writeAndTrack(originalPath, original, written));
      }
      await Promise.all(tasks);
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
      user_id: user.id,
      model_id: modelId,
      provider,
      workflowName,
      promptData,
      executionTimeSeconds,
      outputs: [
        {
          filename: displayFilename,
          filepath: `${relDir}/${originalFilename}`,
          contentType: original.type,
          size: original.size,
        },
      ],
    });

    // Fan out the new row to every connected client of this user.
    // Errors are caught so a broadcast failure never affects the HTTP
    // response — clients will catch up on next reconnect's refetch.
    try {
      const newRow = getGenerationById(id);
      if (newRow) {
        broadcastToUserId(user.id, {
          type: "generation.created",
          data: newRow,
        });
      }
    } catch (err) {
      console.error("[history POST] broadcast failed:", err);
    }

    // Admin-only fan-out: notify every active admin so admin views
    // (Users tab counts, etc.) can refresh aggregates in real time
    // without the admin needing to re-focus the page or re-expand a
    // row. Errors swallowed for the same reason as above.
    try {
      const admins = getDb().prepare(
        `SELECT id FROM users WHERE role='admin' AND status='active'`
      ).all() as { id: number }[];
      for (const a of admins) {
        broadcastToUserId(a.id, {
          type: "admin.user_generated",
          data: { user_id: user.id },
        });
      }
    } catch (err) {
      console.error("[history POST] admin broadcast failed:", err);
    }

    // Per-segment encoding. Encoding the whole `relDir` (which contains
    // slashes) escapes them to %2F, which Next.js's catch-all route sees
    // as one segment containing literal "/" after decoding — and the
    // route's `s.includes("/")` traversal check then rejects it as 400.
    // Encode email and filename separately, leave the path separators raw
    // so the [...path] handler splits into 4 clean segments.
    const urlPrefix = `/api/history/image/${encodeURIComponent(user.email)}/${yyyy}/${mm}`;
    return NextResponse.json({
      id,
      success: true,
      fullUrl: `${urlPrefix}/${encodeURIComponent(originalFilename)}`,
      thumbUrl: `${urlPrefix}/${encodeURIComponent(thumbFilename)}`,
      midUrl: `${urlPrefix}/${encodeURIComponent(midFilename)}`,
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
