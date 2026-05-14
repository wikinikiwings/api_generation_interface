import { type NextRequest, NextResponse } from "next/server";
import { getDb, getHistoryImagesDir } from "@/lib/history-db";
import { getCurrentUser } from "@/lib/auth/current-user";
import { SESSION_COOKIE_NAME } from "@/lib/auth/cookie-name";
import { purgeOrphans } from "@/lib/admin/orphan-purge";

export const runtime = "nodejs";

function requireAdmin(req: NextRequest) {
  const user = getCurrentUser(getDb(), req.cookies.get(SESSION_COOKIE_NAME)?.value ?? null);
  if (!user) return { error: NextResponse.json({ error: "unauthorized" }, { status: 401 }) };
  if (user.role !== "admin") return { error: NextResponse.json({ error: "forbidden" }, { status: 403 }) };
  return { user };
}

export async function POST(req: NextRequest) {
  const a = requireAdmin(req); if (a.error) return a.error;
  const res = await purgeOrphans(getDb(), getHistoryImagesDir());
  return NextResponse.json(res);
}
