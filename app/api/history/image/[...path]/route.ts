import { type NextRequest, NextResponse } from "next/server";
import { getDb, getHistoryImagesDir } from "@/lib/history-db";
import { getCurrentUser } from "@/lib/auth/current-user";
import path from "node:path";
import fs from "node:fs/promises";
import mime from "mime-types";

export const runtime = "nodejs";
const SESSION_COOKIE = process.env.NODE_ENV === "production" ? "__Host-session" : "session";

/**
 * GET /api/history/image/<email>/<YYYY>/<MM>/<filename>
 *
 * Auth: only the file's owner (path's first segment === user.email) or admin
 * can read. Path-traversal defended in depth via `..` rejection AND
 * `path.resolve(joined).startsWith(baseDir)`.
 */
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ path: string[] }> }
) {
  const user = getCurrentUser(getDb(), req.cookies.get(SESSION_COOKIE)?.value ?? null);
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const { path: segs } = await params;
  if (!segs || segs.length < 2) {
    return NextResponse.json({ error: "Invalid path" }, { status: 400 });
  }
  for (const s of segs) {
    if (!s || s.includes("..") || s.includes("/") || s.includes("\\")) {
      return NextResponse.json({ error: "Invalid path" }, { status: 400 });
    }
  }

  const ownerEmail = segs[0].toLowerCase();
  if (user.role !== "admin" && ownerEmail !== user.email.toLowerCase()) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const dir = getHistoryImagesDir();
  const filePath = path.join(dir, ...segs);
  const resolved = path.resolve(filePath);
  if (!resolved.startsWith(path.resolve(dir))) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  try {
    const bytes = await fs.readFile(resolved);
    const filename = segs[segs.length - 1];
    const contentType = mime.lookup(filename) || "application/octet-stream";
    return new NextResponse(new Uint8Array(bytes), {
      status: 200,
      headers: {
        "Content-Type": contentType,
        "Cache-Control": "public, max-age=31536000, immutable",
      },
    });
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return NextResponse.json({ error: "Not found" }, { status: 404 });
    console.error("[history image] read failed:", err);
    return NextResponse.json({ error: "Read failed" }, { status: 500 });
  }
}
