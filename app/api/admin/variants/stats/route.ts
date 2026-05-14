import { type NextRequest, NextResponse } from "next/server";
import { promises as fs } from "node:fs";
import path from "node:path";
import {
  getDb,
  getHistoryImagesDir,
  getHistoryVariantsDir,
} from "@/lib/history-db";
import { getCurrentUser } from "@/lib/auth/current-user";
import { SESSION_COOKIE_NAME } from "@/lib/auth/cookie-name";

export const runtime = "nodejs";

function requireAdmin(req: NextRequest) {
  const user = getCurrentUser(getDb(), req.cookies.get(SESSION_COOKIE_NAME)?.value ?? null);
  if (!user) return { error: NextResponse.json({ error: "unauthorized" }, { status: 401 }) };
  if (user.role !== "admin") return { error: NextResponse.json({ error: "forbidden" }, { status: 403 }) };
  return { user };
}

export async function GET(req: NextRequest) {
  const a = requireAdmin(req); if (a.error) return a.error;

  const db = getDb();
  const originals = (db.prepare(
    `SELECT COUNT(*) AS n FROM generation_outputs WHERE content_type LIKE 'image/%'`
  ).get() as { n: number }).n;

  let thumbs = 0, mids = 0;
  await countByPrefix(getHistoryVariantsDir(), (basename) => {
    if (basename.startsWith("thumb_")) thumbs++;
    else if (basename.startsWith("mid_")) mids++;
  });

  return NextResponse.json({
    originals_in_db: originals,
    variants_on_disk_thumb: thumbs,
    variants_on_disk_mid: mids,
    variants_dir: getHistoryVariantsDir(),
    images_dir: getHistoryImagesDir(),
  });
}

async function countByPrefix(
  root: string,
  onMatch: (basename: string) => void
): Promise<void> {
  let owners: string[];
  try { owners = await fs.readdir(root); } catch { return; }
  for (const owner of owners) {
    if (owner.startsWith("deleted_")) continue;
    const ownerDir = path.join(root, owner);
    let years: string[]; try { years = await fs.readdir(ownerDir); } catch { continue; }
    for (const y of years) {
      const yd = path.join(ownerDir, y);
      let months: string[]; try { months = await fs.readdir(yd); } catch { continue; }
      for (const m of months) {
        const md = path.join(yd, m);
        let files: string[]; try { files = await fs.readdir(md); } catch { continue; }
        for (const f of files) onMatch(f);
      }
    }
  }
}
