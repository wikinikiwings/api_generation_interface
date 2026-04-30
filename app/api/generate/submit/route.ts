import { NextResponse, type NextRequest } from "next/server";
import { getProvider, listModelsForProvider } from "@/lib/providers/registry";
import { getAppSetting, getDb } from "@/lib/history-db";
import type {
  GenerateSubmitBody,
  GenerateSubmitResponse,
  ProviderId,
} from "@/lib/providers/types";
import { getCurrentUser } from "@/lib/auth/current-user";
import { SESSION_COOKIE_NAME } from "@/lib/auth/cookie-name";
import { applicableLimit, usageThisMonth } from "@/lib/quotas";
import { writeAuthEvent } from "@/lib/auth/audit";

function readSessionCookie(req: NextRequest): string | null {
  return req.cookies.get(SESSION_COOKIE_NAME)?.value ?? null;
}

const VALID_PROVIDERS: ProviderId[] = ["wavespeed", "comfy", "fal"];
const DEFAULT_PROVIDER: ProviderId = "wavespeed";

/**
 * Resolve the active provider from server-side state, NOT from client input.
 *
 * Why: the admin can change `selectedProvider` at any moment via the admin
 * panel. Client stores poll /api/settings every 30s and on visibilitychange,
 * but there's still a window where a user could click Generate with a
 * stale provider in their UI. If we trusted body.provider, that submit
 * would route to the wrong endpoint. Reading from app_settings here
 * closes the gap completely — the worst case is a 400 from the model
 * compatibility check below if their stale model doesn't fit the new
 * provider, which is the right failure mode (better than silently
 * generating on the wrong backend).
 *
 * body.provider is still accepted for backward compat and logging but is
 * effectively a hint, not a source of truth.
 */
function resolveProvider(): ProviderId {
  const stored = getAppSetting("selectedProvider");
  if (stored && VALID_PROVIDERS.includes(stored as ProviderId)) {
    return stored as ProviderId;
  }
  return DEFAULT_PROVIDER;
}

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// Sync providers (Fal, later) can hang up to 2 minutes on 4K. Give plenty of room.
export const maxDuration = 300;

/**
 * POST /api/generate/submit
 *
 * Body:
 *   { provider: "wavespeed" | "comfy" | "fal", prompt, images, resolution, ... }
 *
 * Response (discriminated by `kind`):
 *   - async: { kind: "async", provider, taskId }
 *   - sync:  { kind: "sync",  provider, outputUrls, executionTimeMs }
 *
 * The client then either starts polling /api/generate/status/:id?provider=...
 * (async) or uses the results directly (sync).
 */
export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as GenerateSubmitBody;

    // Server-authoritative provider resolution. We deliberately ignore
    // body.provider as a source of truth (see resolveProvider() above).
    // Overwriting body.provider also keeps downstream code paths — history
    // entries, error messages, the provider.submit() call — consistently
    // pointing at the actual provider being used.
    const activeProvider = resolveProvider();
    if (body.provider && body.provider !== activeProvider) {
      console.info(
        `[/api/generate/submit] client sent provider="${body.provider}" but server-side active is "${activeProvider}"; using server value`
      );
    }
    body.provider = activeProvider;

    // Backward-compat: clients pre-multimodel sent no modelId. Default to
    // nano-banana-2 — current product default (Phase 5). Older clients are
    // rare since the store bump (v3) forces a fresh persisted value, but
    // direct API callers / curl users still benefit from a sane fallback.
    if (!body.modelId) {
      body.modelId = "nano-banana-2";
    }

    const supported = listModelsForProvider(body.provider);
    if (!supported.includes(body.modelId)) {
      return NextResponse.json(
        { error: `Provider "${body.provider}" does not support model "${body.modelId}"` },
        { status: 400 }
      );
    }

    // Auth + quota gate. Must run after model validation so body.modelId is
    // normalised (default applied) before we look up the limit.
    const user = getCurrentUser(getDb(), readSessionCookie(req));
    if (!user) {
      return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    }

    if (user.role !== "admin") {
      // Best-effort gate: up to in-flight count over-budget is possible under
      // simultaneous bursts (count is read-then-incremented). Acceptable per spec.
      const limit = applicableLimit(getDb(), user.id, body.modelId);
      if (limit !== null) {
        const used = usageThisMonth(getDb(), user.id, body.modelId);
        if (used >= limit) {
          writeAuthEvent(getDb(), {
            event_type: "quota_exceeded",
            user_id: user.id,
            email: user.email,
            details: { model_id: body.modelId, used, limit },
          });
          return NextResponse.json(
            { error: "quota_exceeded", model_id: body.modelId, limit, used },
            { status: 429 }
          );
        }
      }
    }

    const provider = getProvider(body.provider);

    if (!provider.isConfigured()) {
      return NextResponse.json(
        {
          error: `Provider "${body.provider}" is not configured. Add the required API key to .env.local.`,
        },
        { status: 400 }
      );
    }

    const result = await provider.submit(body);

    const response: GenerateSubmitResponse =
      result.kind === "async"
        ? {
            kind: "async",
            provider: body.provider,
            taskId: result.taskId,
          }
        : {
            kind: "sync",
            provider: body.provider,
            outputUrls: result.outputUrls,
            executionTimeMs: result.executionTimeMs,
          };

    return NextResponse.json(response);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    console.error("[/api/generate/submit] error:", message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
