import { NextResponse } from "next/server";
import { getProvider, listModelsForProvider } from "@/lib/providers/registry";
import type {
  GenerateSubmitBody,
  GenerateSubmitResponse,
} from "@/lib/providers/types";

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
export async function POST(req: Request) {
  try {
    const body = (await req.json()) as GenerateSubmitBody;

    if (!body.provider) {
      return NextResponse.json(
        { error: "`provider` field is required" },
        { status: 400 }
      );
    }

    // Backward-compat: clients pre-multimodel sent no modelId. Default to
    // nano-banana-pro (the only model that existed before this change).
    if (!body.modelId) {
      body.modelId = "nano-banana-pro";
    }

    const supported = listModelsForProvider(body.provider);
    if (!supported.includes(body.modelId)) {
      return NextResponse.json(
        { error: `Provider "${body.provider}" does not support model "${body.modelId}"` },
        { status: 400 }
      );
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
