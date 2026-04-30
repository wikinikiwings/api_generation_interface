import { type NextRequest, NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth/current-user";
import { getDb } from "@/lib/history-db";
import { applicableLimit, usageThisMonth } from "@/lib/quotas";
import { SESSION_COOKIE_NAME } from "@/lib/auth/cookie-name";

export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  const db = getDb();
  const user = getCurrentUser(db, req.cookies.get(SESSION_COOKIE_NAME)?.value ?? null);
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const models = db.prepare(
    `SELECT model_id, display_name FROM models WHERE is_active=1 ORDER BY model_id`
  ).all() as { model_id: string; display_name: string }[];

  const result = models.map((m) => {
    const limit = applicableLimit(db, user.id, m.model_id);
    const used = usageThisMonth(db, user.id, m.model_id);
    return {
      model_id: m.model_id,
      display_name: m.display_name,
      limit,
      used,
      unlimited: limit === null,
    };
  });

  return NextResponse.json(result);
}
