import { type NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/history-db";
import { getCurrentUser } from "@/lib/auth/current-user";
import { SESSION_COOKIE_NAME } from "@/lib/auth/cookie-name";

export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  const user = getCurrentUser(getDb(), req.cookies.get(SESSION_COOKIE_NAME)?.value ?? null);
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (user.role !== "admin") return NextResponse.json({ error: "forbidden" }, { status: 403 });

  const rows = getDb().prepare(`
    SELECT m.model_id, m.display_name, m.default_monthly_limit, m.is_active,
      (SELECT COUNT(*) FROM generations g
        WHERE g.model_id = m.model_id AND g.status='completed') AS total_generations
    FROM models m ORDER BY m.model_id
  `).all();
  return NextResponse.json(rows);
}
