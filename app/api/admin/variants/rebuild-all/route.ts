import { type NextRequest, NextResponse } from "next/server";
import {
  getDb,
  getHistoryImagesDir,
  getHistoryVariantsDir,
} from "@/lib/history-db";
import { getCurrentUser } from "@/lib/auth/current-user";
import { SESSION_COOKIE_NAME } from "@/lib/auth/cookie-name";
import { tryStartJob, getActiveJob } from "@/lib/admin/variants-jobs";
import { runRebuild } from "@/lib/admin/variants-runner";
import { broadcastToUserId, type SseEvent } from "@/lib/sse-broadcast";

export const runtime = "nodejs";

function requireAdmin(req: NextRequest) {
  const user = getCurrentUser(getDb(), req.cookies.get(SESSION_COOKIE_NAME)?.value ?? null);
  if (!user) return { error: NextResponse.json({ error: "unauthorized" }, { status: 401 }) };
  if (user.role !== "admin") return { error: NextResponse.json({ error: "forbidden" }, { status: 403 }) };
  return { user };
}

export async function POST(req: NextRequest) {
  const a = requireAdmin(req); if (a.error) return a.error;
  const db = getDb();
  const total = (db.prepare(`
    SELECT COUNT(DISTINCT g.id) AS n
    FROM generations g
    JOIN users u ON u.id = g.user_id
    JOIN generation_outputs o ON o.generation_id = g.id
    WHERE g.status IN ('completed','deleted')
      AND o.content_type LIKE 'image/%'
      AND u.status = 'active'
  `).get() as { n: number }).n;

  const start = tryStartJob({ scope: "all", total });
  if (!start.started) {
    const active = getActiveJob();
    return NextResponse.json({
      jobId: start.existingJobId,
      folded: true,
      activeScope: active?.scope,
    });
  }

  const adminIds = (db.prepare(
    `SELECT id FROM users WHERE role='admin' AND status='active'`
  ).all() as { id: number }[]).map((r) => r.id);
  const broadcast = (ev: { type: string; data: Record<string, unknown> }) => {
    for (const id of adminIds) {
      try { broadcastToUserId(id, ev as SseEvent); } catch { /* ignored */ }
    }
  };

  setImmediate(() => {
    runRebuild(db, start.jobId, {
      scope: "all",
      imagesDir: getHistoryImagesDir(),
      variantsDir: getHistoryVariantsDir(),
      broadcast,
    }).catch((err) => {
      console.error("[variants rebuild-all] runner crashed:", err);
    });
  });
  return NextResponse.json({ jobId: start.jobId, folded: false });
}
