import { type NextRequest, NextResponse } from "next/server";
import {
  saveGeneration,
  getGenerations,
  deleteGeneration,
  getHistoryImagesDir,
} from "@/lib/history-db";
import fs from "node:fs/promises";
import path from "node:path";
import { v4 as uuidv4 } from "uuid";
import sharp from "sharp";

const THUMB_WIDTH = 280;
const THUMB_QUALITY = 70;
const MID_WIDTH = 1200;
const MID_QUALITY = 85;

// Read more generously than /api/generate/submit since we write image files
export const maxDuration = 60;

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
 *   username, workflowName, promptData (JSON string), executionTimeSeconds,
 *   output_0, output_1, ... (File entries)
 *
 * For each image output generates thumb_{uuid}.jpg (280px) + mid_{uuid}.png (1200px)
 * via sharp, alongside the original. Returns { id, success }.
 */
export async function POST(request: NextRequest) {
  try {
    const formData = await request.formData();
    const username = formData.get("username") as string;
    const workflowName = (formData.get("workflowName") as string) || "";
    const promptData = JSON.parse(
      (formData.get("promptData") as string) || "{}"
    );
    const executionTimeSeconds = parseFloat(
      (formData.get("executionTimeSeconds") as string) || "0"
    );

    if (!username) {
      return NextResponse.json(
        { error: "username is required" },
        { status: 400 }
      );
    }

    const outputs: {
      filename: string;
      filepath: string;
      contentType: string;
      size: number;
    }[] = [];
    const dir = getHistoryImagesDir();

    for (const [key, value] of Array.from(formData.entries())) {
      if (!key.startsWith("output_") || !(value instanceof File)) continue;
      const file = value;
      const ext = path.extname(file.name) || getExtFromMime(file.type);
      const savedFilename = `${uuidv4()}${ext}`;
      const savedFilepath = path.join(dir, savedFilename);
      const buffer = Buffer.from(await file.arrayBuffer());
      await fs.writeFile(savedFilepath, buffer);

      if (
        file.type.startsWith("image/") &&
        file.type !== "image/vnd.adobe.photoshop"
      ) {
        const baseName = savedFilename.replace(/\.[^.]+$/, "");
        try {
          await sharp(buffer)
            .resize({ width: THUMB_WIDTH, withoutEnlargement: true })
            .jpeg({ quality: THUMB_QUALITY })
            .toFile(path.join(dir, `thumb_${baseName}.jpg`));
        } catch (e) {
          console.error("[history POST] thumb failed:", e);
        }
        try {
          await sharp(buffer)
            .resize({ width: MID_WIDTH, withoutEnlargement: true })
            .png({ quality: MID_QUALITY })
            .toFile(path.join(dir, `mid_${baseName}.png`));
        } catch (e) {
          console.error("[history POST] mid-res failed:", e);
        }
      }

      outputs.push({
        filename: file.name,
        filepath: savedFilename,
        contentType: file.type,
        size: file.size,
      });
    }

    const id = saveGeneration({
      username,
      workflowName,
      promptData,
      executionTimeSeconds,
      outputs,
    });
    // Return the filepath of the first image output too, so the client
    // can build /api/history/image/{filepath} URLs (mid + original) and
    // rewrite the in-memory entry to point at our cache instead of the
    // provider CDN.
    const firstImage = outputs.find((o) => o.contentType.startsWith("image/"));
    return NextResponse.json({
      id,
      success: true,
      filepath: firstImage?.filepath ?? null,
    });
  } catch (err) {
    console.error("[history POST] failed:", err);
    return NextResponse.json({ error: "Failed to save history" }, { status: 500 });
  }
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
