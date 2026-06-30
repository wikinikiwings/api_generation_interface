import { type NextRequest, NextResponse } from "next/server";
import { getDb, getAppSetting, setAppSetting } from "@/lib/history-db";
import { getCurrentUser } from "@/lib/auth/current-user";
import { SESSION_COOKIE_NAME } from "@/lib/auth/cookie-name";

export const runtime = "nodejs";

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

function guard(req: NextRequest): NextResponse | null {
  const user = getCurrentUser(getDb(), req.cookies.get(SESSION_COOKIE_NAME)?.value ?? null);
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (user.role !== "admin") return NextResponse.json({ error: "forbidden" }, { status: 403 });
  return null;
}

export async function GET(req: NextRequest) {
  const denied = guard(req);
  if (denied) return denied;

  const raw = getAppSetting("falBalanceThreshold");
  const n = raw == null || raw.trim() === "" ? null : Number(raw);
  const threshold = typeof n === "number" && Number.isFinite(n) ? n : null;

  let checkTimesUtc: string[] = [];
  try {
    const p = JSON.parse(getAppSetting("falBalanceCheckTimes") ?? "[]");
    if (Array.isArray(p)) checkTimesUtc = p.filter((x) => typeof x === "string");
  } catch {
    // malformed → empty
  }
  return NextResponse.json({ threshold, checkTimesUtc });
}

export async function PUT(req: NextRequest) {
  const denied = guard(req);
  if (denied) return denied;

  const body = (await req.json().catch(() => ({}))) as {
    threshold?: unknown;
    checkTimesUtc?: unknown;
  };
  const { threshold, checkTimesUtc } = body;

  if (
    threshold !== null &&
    (typeof threshold !== "number" || !Number.isFinite(threshold) || threshold < 0)
  ) {
    return NextResponse.json({ error: "threshold must be a number >= 0 or null" }, { status: 400 });
  }
  if (
    !Array.isArray(checkTimesUtc) ||
    !checkTimesUtc.every((t) => typeof t === "string" && HHMM.test(t))
  ) {
    return NextResponse.json({ error: "checkTimesUtc must be an array of HH:MM strings" }, { status: 400 });
  }

  setAppSetting("falBalanceThreshold", threshold === null ? "" : String(threshold));
  setAppSetting("falBalanceCheckTimes", JSON.stringify(checkTimesUtc));
  return NextResponse.json({ ok: true, threshold, checkTimesUtc });
}
