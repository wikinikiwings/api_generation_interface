import { type NextRequest, NextResponse } from "next/server";
import { getDb, getUserSelectedModel, setUserSelectedModel } from "@/lib/history-db";
import { getCurrentUser } from "@/lib/auth/current-user";
import { SESSION_COOKIE_NAME } from "@/lib/auth/cookie-name";
import { listAllModels } from "@/lib/providers/models";
import type { ModelId } from "@/lib/providers/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Per-user preferences endpoint (Phase 7.6: session-cookie auth).
 *
 * Auth via session cookie. user_id is derived server-side.
 *
 * GET  /api/user/preferences                 → { selectedModel: ModelId | null }
 * PUT  /api/user/preferences  body: { selectedModel }
 *                                            → { ok: true }
 *
 * GET returns null when the user has never picked a model — the client
 * then falls back to its own default ("nano-banana-2"). We deliberately
 * don't 404 on missing rows: a fresh user is the common case, not an
 * error.
 */

function readSessionCookie(req: NextRequest): string | null {
  return req.cookies.get(SESSION_COOKIE_NAME)?.value ?? null;
}

// Build the allowed model set once per cold start. Not const-frozen because
// listAllModels() reads the registry which can theoretically change between
// HMR reloads in dev — recomputing on each request is microsecond-cheap and
// protects against stale-import issues.
function isValidModelId(id: string): id is ModelId {
  return listAllModels().some((m) => m.id === id);
}

export async function GET(request: NextRequest) {
  const user = getCurrentUser(getDb(), readSessionCookie(request));
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  try {
    const selectedModel = getUserSelectedModel(user.id);
    return NextResponse.json({ selectedModel });
  } catch (err) {
    console.error("[user/preferences GET] failed:", err);
    return NextResponse.json({ error: "Failed to read preferences" }, { status: 500 });
  }
}

export async function PUT(request: NextRequest) {
  const user = getCurrentUser(getDb(), readSessionCookie(request));
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  try {
    const body = (await request.json()) as { selectedModel?: string };
    if (!body.selectedModel) {
      return NextResponse.json({ error: "selectedModel is required" }, { status: 400 });
    }
    // Validate against the live model registry. This prevents the DB from
    // accumulating typos or values from old client builds that have since
    // been removed from the registry — important because the GET path
    // returns the value verbatim and the client trusts it as a ModelId.
    if (!isValidModelId(body.selectedModel)) {
      return NextResponse.json(
        { error: `Unknown modelId "${body.selectedModel}"` },
        { status: 400 }
      );
    }
    setUserSelectedModel(user.id, body.selectedModel);
    return NextResponse.json({ ok: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    console.error("[user/preferences PUT] failed:", message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
