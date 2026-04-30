import { type NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/history-db";
import { getCurrentUser } from "@/lib/auth/current-user";
import { writeAuthEvent } from "@/lib/auth/audit";
import { deleteSessionsForUser } from "@/lib/auth/session";
import { broadcastToUserId } from "@/lib/sse-broadcast";
import { SESSION_COOKIE_NAME } from "@/lib/auth/cookie-name";

export const runtime = "nodejs";

export async function PATCH(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> }
) {
  const me = getCurrentUser(getDb(), req.cookies.get(SESSION_COOKIE_NAME)?.value ?? null);
  if (!me) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (me.role !== "admin") return NextResponse.json({ error: "forbidden" }, { status: 403 });

  const { id } = await ctx.params;
  const userId = parseInt(id);
  const body = (await req.json()) as {
    role?: "user" | "admin";
    status?: "active" | "banned" | "deleted";
  };

  const before = getDb()
    .prepare(`SELECT role, status FROM users WHERE id=?`)
    .get(userId) as { role: string; status: string } | undefined;
  if (!before) return NextResponse.json({ error: "not_found" }, { status: 404 });

  const sets: string[] = [];
  const args: unknown[] = [];
  if (body.role && body.role !== before.role) {
    sets.push("role=?");
    args.push(body.role);
  }
  if (body.status && body.status !== before.status) {
    sets.push("status=?");
    args.push(body.status);
  }
  if (sets.length === 0) return NextResponse.json({ ok: true, changed: false });

  args.push(userId);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  getDb()
    .prepare(`UPDATE users SET ${sets.join(", ")} WHERE id=?`)
    .run(...(args as any[]));

  if (body.role && body.role !== before.role) {
    writeAuthEvent(getDb(), {
      event_type: "admin_user_role_changed",
      user_id: me.id,
      details: { target_id: userId, from: before.role, to: body.role },
    });
    broadcastToUserId(userId, { type: "user_role_changed" });
  }
  if (body.status && body.status !== before.status) {
    writeAuthEvent(getDb(), {
      event_type: "admin_user_status_changed",
      user_id: me.id,
      details: { target_id: userId, from: before.status, to: body.status },
    });
    if (body.status !== "active") {
      deleteSessionsForUser(getDb(), userId);
      broadcastToUserId(userId, { type: "user_banned" });
    }
  }
  return NextResponse.json({ ok: true, changed: true });
}
