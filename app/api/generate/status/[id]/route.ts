import { NextResponse } from "next/server";
import { getProvider } from "@/lib/providers/registry";
import type {
  ProviderId,
  GenerateStatusResponse,
} from "@/lib/providers/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const VALID_PROVIDER_IDS: ProviderId[] = ["wavespeed", "comfy", "fal"];

/**
 * GET /api/generate/status/:id?provider=wavespeed
 *
 * Polls the task status for an async provider. Returns:
 *   { id, status: "pending"|"processing"|"completed"|"failed",
 *     outputUrls: string[], error: string|null }
 *
 * For sync providers this endpoint is not applicable — the client should never
 * call it after receiving a `kind: "sync"` submit response.
 */
export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const { searchParams } = new URL(req.url);
    const providerIdRaw = searchParams.get("provider");

    if (!providerIdRaw) {
      return NextResponse.json(
        { error: "`provider` query parameter is required" },
        { status: 400 }
      );
    }
    if (!VALID_PROVIDER_IDS.includes(providerIdRaw as ProviderId)) {
      return NextResponse.json(
        { error: `Unknown provider "${providerIdRaw}"` },
        { status: 400 }
      );
    }
    const providerId = providerIdRaw as ProviderId;

    const provider = getProvider(providerId);
    if (!provider.getStatus) {
      return NextResponse.json(
        {
          error: `Provider "${providerId}" is synchronous and has no status endpoint`,
        },
        { status: 400 }
      );
    }

    const result = await provider.getStatus(id);
    const response: GenerateStatusResponse = {
      id,
      status: result.status,
      outputUrls: result.outputUrls,
      error: result.error ?? null,
    };
    return NextResponse.json(response);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    console.error("[/api/generate/status] error:", message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
