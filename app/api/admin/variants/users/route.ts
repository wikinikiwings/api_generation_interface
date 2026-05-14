import { type NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/history-db";
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
  const rows = db.prepare(`
    SELECT u.id AS user_id, u.email, COUNT(DISTINCT g.id) AS image_generation_count
    FROM users u
    JOIN generations g ON g.user_id = u.id
    JOIN generation_outputs o ON o.generation_id = g.id
    WHERE u.status = 'active'
      AND g.status IN ('completed','deleted')
      AND o.content_type LIKE 'image/%'
    GROUP BY u.id, u.email
    HAVING image_generation_count > 0
    ORDER BY image_generation_count DESC, u.email ASC
  `).all() as Array<{ user_id: number; email: string; image_generation_count: number }>;

  return NextResponse.json(rows);
}
