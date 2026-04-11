import { type NextRequest, NextResponse } from "next/server";
import { getUserSelectedModel, setUserSelectedModel } from "@/lib/history-db";
import { listAllModels } from "@/lib/providers/models";
import type { ModelId } from "@/lib/providers/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Per-user preferences endpoint (Phase 5b: sticky model picker per identity).
 *
 * Identity model: same as /api/history — no auth, the client passes the
 * username explicitly. This is fine for an internal-deploy multi-user app
 * where ~20 known people pick their own nicknames; if we ever bolt on real
 * auth we'll switch to reading the username from a server-validated session
 * instead of trusting the query/body, and this route's contract stays the
 * same.
 *
 * GET  /api/user/preferences?username=X        → { selectedModel: ModelId | null }
 * PUT  /api/user/preferences  body: { username, selectedModel }
 *                                              → { ok: true }
 *
 * GET returns null when the user has never picked a model — the client
 * then falls back to its own default ("nano-banana-2"). We deliberately
 * don't 404 on missing rows: a fresh user is the common case, not an
 * error.
 */

// Build the allowed model set once per cold start. Not const-frozen because
// listAllModels() reads the registry which can theoretically change between
// HMR reloads in dev — recomputing on each request is microsecond-cheap and
// protects against stale-import issues.
function isValidModelId(id: string): id is ModelId {
  return listAllModels().some((m) => m.id === id);
}

export async function GET(request: NextRequest) {
  const username = request.nextUrl.searchParams.get("username");
  if (!username) {
    return NextResponse.json({ error: "username is required" }, { status: 400 });
  }
  try {
    const selectedModel = getUserSelectedModel(username);
    return NextResponse.json({ selectedModel });
  } catch (err) {
    console.error("[user/preferences GET] failed:", err);
    return NextResponse.json(
      { error: "Failed to read preferences" },
      { status: 500 }
    );
  }
}

export async function PUT(request: NextRequest) {
  try {
    const body = (await request.json()) as {
      username?: string;
      selectedModel?: string;
    };
    if (!body.username) {
      return NextResponse.json(
        { error: "username is required" },
        { status: 400 }
      );
    }
    if (!body.selectedModel) {
      return NextResponse.json(
        { error: "selectedModel is required" },
        { status: 400 }
      );
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
    setUserSelectedModel(body.username, body.selectedModel);
    return NextResponse.json({ ok: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    console.error("[user/preferences PUT] failed:", message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
