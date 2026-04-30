import { type NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/history-db";
import { deleteSession } from "@/lib/auth/session";
import { writeAuthEvent } from "@/lib/auth/audit";
import { getCurrentUser } from "@/lib/auth/current-user";
import { SESSION_COOKIE_NAME } from "@/lib/auth/cookie-name";

export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  const sid = req.cookies.get(SESSION_COOKIE_NAME)?.value;
  if (sid) {
    const db = getDb();
    const user = getCurrentUser(db, sid);
    deleteSession(db, sid);
    if (user) writeAuthEvent(db, { event_type: "logout", user_id: user.id, email: user.email });
  }
  const res = NextResponse.json({ ok: true });
  res.cookies.set({ name: SESSION_COOKIE_NAME, value: "", maxAge: 0, path: "/" });
  return res;
}
