import { type NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/history-db";
import { getCurrentUser } from "@/lib/auth/current-user";
import { applicableLimit, usageThisMonth } from "@/lib/quotas";
import { SESSION_COOKIE_NAME } from "@/lib/auth/cookie-name";

export const runtime = "nodejs";

export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const me = getCurrentUser(getDb(), req.cookies.get(SESSION_COOKIE_NAME)?.value ?? null);
  if (!me) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (me.role !== "admin") return NextResponse.json({ error: "forbidden" }, { status: 403 });

  const userId = parseInt((await ctx.params).id);
  const exists = getDb().prepare(`SELECT id FROM users WHERE id=?`).get(userId);
  if (!exists) return NextResponse.json({ error: "not_found" }, { status: 404 });

  const models = getDb().prepare(
    `SELECT model_id, display_name, default_monthly_limit FROM models ORDER BY model_id`
  ).all() as { model_id: string; display_name: string; default_monthly_limit: number | null }[];

  const overrides = new Map(
    (getDb().prepare(`SELECT model_id, monthly_limit FROM user_quotas WHERE user_id=?`).all(userId) as any[])
      .map((r) => [r.model_id, r.monthly_limit])
  );

  const result = models.map((m) => {
    const hasOverride = overrides.has(m.model_id);
    const overrideValue = hasOverride ? (overrides.get(m.model_id) ?? null) : null;
    return {
      model_id: m.model_id,
      display_name: m.display_name,
      applicable_limit: applicableLimit(getDb(), userId, m.model_id),
      source: hasOverride ? "override" : "default",
      default_limit: m.default_monthly_limit,
      override_limit: hasOverride ? overrideValue : null,
      has_override: hasOverride,
      usage_this_month: usageThisMonth(getDb(), userId, m.model_id),
    };
  });
  return NextResponse.json(result);
}
