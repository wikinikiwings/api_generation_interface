import { type NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/history-db";
import { getCurrentUser } from "@/lib/auth/current-user";
import { writeAuthEvent } from "@/lib/auth/audit";
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
  const showDeleted = req.nextUrl.searchParams.get("showDeleted") === "1";
  const sql = `
    SELECT u.id, u.email, u.name, u.picture_url, u.role, u.status, u.last_login_at, u.created_at,
      (SELECT COUNT(*) FROM generations g
        WHERE g.user_id = u.id
          AND g.status IN ('completed', 'deleted')
          AND g.created_at >= strftime('%Y-%m-01T00:00:00.000Z', 'now')
      ) AS gens_this_month
    FROM users u
    ${showDeleted ? "" : "WHERE u.status != 'deleted'"}
    ORDER BY u.created_at DESC
  `;
  return NextResponse.json(getDb().prepare(sql).all());
}

export async function POST(req: NextRequest) {
  const a = requireAdmin(req); if (a.error) return a.error;
  const body = (await req.json()) as { email: string; role?: "user" | "admin" };
  const email = body.email?.trim().toLowerCase();
  if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    return NextResponse.json({ error: "invalid_email" }, { status: 400 });
  }
  try {
    getDb()
      .prepare(`INSERT INTO users (email, role, status) VALUES (?, ?, 'active')`)
      .run(email, body.role ?? "user");
    writeAuthEvent(getDb(), {
      event_type: "admin_user_created",
      user_id: a.user.id,
      details: { target_email: email },
    });
    return NextResponse.json({ ok: true });
  } catch (err: unknown) {
    if (String((err as Error).message).includes("UNIQUE")) {
      return NextResponse.json({ error: "exists" }, { status: 409 });
    }
    throw err;
  }
}
