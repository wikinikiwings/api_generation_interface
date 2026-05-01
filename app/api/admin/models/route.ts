import { type NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/history-db";
import { getCurrentUser } from "@/lib/auth/current-user";
import { SESSION_COOKIE_NAME } from "@/lib/auth/cookie-name";

export const runtime = "nodejs";

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export async function GET(req: NextRequest) {
  const user = getCurrentUser(getDb(), req.cookies.get(SESSION_COOKIE_NAME)?.value ?? null);
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (user.role !== "admin") return NextResponse.json({ error: "forbidden" }, { status: 403 });

  // Optional date range filter for the per-model count column.
  // `from` is inclusive at 00:00 UTC; `to` is treated as inclusive
  // end-of-day, so the upper bound binding is the start of the NEXT
  // day (exclusive). Invalid / missing params are ignored — falling
  // back to the original "all time" behaviour.
  const fromRaw = req.nextUrl.searchParams.get("from");
  const toRaw = req.nextUrl.searchParams.get("to");

  const dateClauses: string[] = [];
  const dateParams: string[] = [];
  if (fromRaw && DATE_RE.test(fromRaw)) {
    dateClauses.push(`g.created_at >= ?`);
    dateParams.push(`${fromRaw}T00:00:00.000Z`);
  }
  if (toRaw && DATE_RE.test(toRaw)) {
    const next = new Date(`${toRaw}T00:00:00.000Z`);
    next.setUTCDate(next.getUTCDate() + 1);
    dateClauses.push(`g.created_at < ?`);
    dateParams.push(next.toISOString());
  }
  const dateAnd = dateClauses.length > 0 ? ` AND ${dateClauses.join(' AND ')}` : '';

  const sql = `
    SELECT m.model_id, m.display_name, m.default_monthly_limit, m.is_active,
      (SELECT COUNT(*) FROM generations g
        WHERE g.model_id = m.model_id
          AND g.status IN ('completed', 'deleted')${dateAnd}) AS total_generations
    FROM models m ORDER BY m.model_id
  `;
  const rows = getDb().prepare(sql).all(...dateParams);
  return NextResponse.json(rows);
}
