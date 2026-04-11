import { NextResponse } from "next/server";
import { listProviderMeta } from "@/lib/providers/registry";

/**
 * GET /api/providers
 *
 * Returns client-safe metadata about all providers: id, displayName,
 * modelLabel, isAsync, isConfigured, isImplemented.
 *
 * Does NOT leak any API keys or env var values — only the boolean flags
 * derived from them (isConfigured). Safe to call from the browser.
 *
 * Used by the admin panel to render the provider picker with status.
 * Could also be used by the main form in the future to gray out
 * providers that are unavailable.
 */
export async function GET() {
  return NextResponse.json({
    providers: listProviderMeta(),
  });
}
