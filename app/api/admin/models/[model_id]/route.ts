import { type NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/history-db";
import { getCurrentUser } from "@/lib/auth/current-user";
import { writeAuthEvent } from "@/lib/auth/audit";
import { broadcastToUserId } from "@/lib/sse-broadcast";
import { SESSION_COOKIE_NAME } from "@/lib/auth/cookie-name";

export const runtime = "nodejs";

export async function PATCH(req: NextRequest, ctx: { params: Promise<{ model_id: string }> }) {
  const me = getCurrentUser(getDb(), req.cookies.get(SESSION_COOKIE_NAME)?.value ?? null);
  if (!me) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (me.role !== "admin") return NextResponse.json({ error: "forbidden" }, { status: 403 });

  const { model_id } = await ctx.params;
  const body = await req.json() as { default_monthly_limit?: number | null; is_active?: 0 | 1 };

  const before = getDb().prepare(
    `SELECT default_monthly_limit, is_active FROM models WHERE model_id=?`
  ).get(model_id) as { default_monthly_limit: number | null; is_active: number } | undefined;
  if (!before) return NextResponse.json({ error: "not_found" }, { status: 404 });

  const sets: string[] = [];
  const args: unknown[] = [];
  let defaultChanged = false;
  if ("default_monthly_limit" in body && body.default_monthly_limit !== before.default_monthly_limit) {
    sets.push("default_monthly_limit=?");
    args.push(body.default_monthly_limit ?? null);
    defaultChanged = true;
  }
  if ("is_active" in body && body.is_active !== before.is_active) {
    sets.push("is_active=?");
    args.push(body.is_active ? 1 : 0);
  }
  if (sets.length === 0) return NextResponse.json({ ok: true, changed: false });

  sets.push("updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')");
  args.push(model_id);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  getDb().prepare(`UPDATE models SET ${sets.join(", ")} WHERE model_id=?`).run(...(args as any[]));

  if (defaultChanged) {
    writeAuthEvent(getDb(), {
      event_type: "admin_model_default_changed", user_id: me.id,
      details: { model_id, from: before.default_monthly_limit, to: body.default_monthly_limit ?? null },
    });
    // Broadcast to active users without an override on this model
    const affected = getDb().prepare(`
      SELECT u.id FROM users u
      WHERE u.status='active'
        AND u.id NOT IN (SELECT user_id FROM user_quotas WHERE model_id=?)
    `).all(model_id) as { id: number }[];
    for (const { id } of affected) broadcastToUserId(id, { type: "quota_updated" });
  }
  return NextResponse.json({ ok: true, changed: true });
}
