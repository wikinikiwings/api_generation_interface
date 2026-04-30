import { type NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/history-db";
import { getCurrentUser } from "@/lib/auth/current-user";

export const runtime = "nodejs";

const PROD = process.env.NODE_ENV === "production";
const SESSION_COOKIE = PROD ? "__Host-session" : "session";

export async function GET(req: NextRequest) {
  const sid = req.cookies.get(SESSION_COOKIE)?.value;
  const user = getCurrentUser(getDb(), sid);
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  return NextResponse.json(user);
}
