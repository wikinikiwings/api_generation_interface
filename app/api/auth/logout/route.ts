import { type NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/history-db";
import { deleteSession } from "@/lib/auth/session";
import { writeAuthEvent } from "@/lib/auth/audit";
import { getCurrentUser } from "@/lib/auth/current-user";

export const runtime = "nodejs";

const PROD = process.env.NODE_ENV === "production";
const SESSION_COOKIE = PROD ? "__Host-session" : "session";

export async function POST(req: NextRequest) {
  const sid = req.cookies.get(SESSION_COOKIE)?.value;
  if (sid) {
    const db = getDb();
    const user = getCurrentUser(db, sid);
    deleteSession(db, sid);
    if (user) writeAuthEvent(db, { event_type: "logout", user_id: user.id, email: user.email });
  }
  const res = NextResponse.json({ ok: true });
  res.cookies.set({ name: SESSION_COOKIE, value: "", maxAge: 0, path: "/" });
  return res;
}
