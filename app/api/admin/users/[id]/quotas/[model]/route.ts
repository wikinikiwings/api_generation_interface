import { type NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/history-db";
import { getCurrentUser } from "@/lib/auth/current-user";
import { writeAuthEvent } from "@/lib/auth/audit";
import { broadcastToUserId } from "@/lib/sse-broadcast";
import { SESSION_COOKIE_NAME } from "@/lib/auth/cookie-name";

export const runtime = "nodejs";

function fanOutQuotaChanged(targetUserId: number, modelId: string) {
  const admins = getDb().prepare(
    `SELECT id FROM users WHERE role='admin' AND status='active'`
  ).all() as { id: number }[];
  for (const a of admins) {
    broadcastToUserId(a.id, {
      type: "admin.quota_changed",
      data: { user_id: targetUserId, model_id: modelId },
    });
  }
}

export async function PUT(req: NextRequest, ctx: { params: Promise<{ id: string; model: string }> }) {
  const me = getCurrentUser(getDb(), req.cookies.get(SESSION_COOKIE_NAME)?.value ?? null);
  if (!me) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (me.role !== "admin") return NextResponse.json({ error: "forbidden" }, { status: 403 });

  const { id, model } = await ctx.params;
  const userId = parseInt(id);
  const body = await req.json() as { monthly_limit: number | null };

  if (!getDb().prepare(`SELECT id FROM users WHERE id=?`).get(userId))
    return NextResponse.json({ error: "user_not_found" }, { status: 404 });
  if (!getDb().prepare(`SELECT model_id FROM models WHERE model_id=?`).get(model))
    return NextResponse.json({ error: "model_not_found" }, { status: 404 });

  getDb().prepare(`
    INSERT INTO user_quotas (user_id, model_id, monthly_limit, updated_at)
    VALUES (?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    ON CONFLICT (user_id, model_id) DO UPDATE
      SET monthly_limit = excluded.monthly_limit,
          updated_at = excluded.updated_at
  `).run(userId, model, body.monthly_limit);

  writeAuthEvent(getDb(), {
    event_type: "admin_quota_changed", user_id: me.id,
    details: { target_user_id: userId, model_id: model, monthly_limit: body.monthly_limit },
  });
  broadcastToUserId(userId, { type: "quota_updated" });
  fanOutQuotaChanged(userId, model);
  return NextResponse.json({ ok: true });
}

export async function DELETE(req: NextRequest, ctx: { params: Promise<{ id: string; model: string }> }) {
  const me = getCurrentUser(getDb(), req.cookies.get(SESSION_COOKIE_NAME)?.value ?? null);
  if (!me) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (me.role !== "admin") return NextResponse.json({ error: "forbidden" }, { status: 403 });

  const { id, model } = await ctx.params;
  const userId = parseInt(id);
  const result = getDb().prepare(
    `DELETE FROM user_quotas WHERE user_id=? AND model_id=?`
  ).run(userId, model);

  if (result.changes > 0) {
    writeAuthEvent(getDb(), {
      event_type: "admin_quota_changed", user_id: me.id,
      details: { target_user_id: userId, model_id: model, action: "removed_override" },
    });
    broadcastToUserId(userId, { type: "quota_updated" });
    fanOutQuotaChanged(userId, model);
  }
  return NextResponse.json({ ok: true, removed: result.changes > 0 });
}
