import { type NextRequest, NextResponse } from "next/server";
import { setAppSetting } from "@/lib/history-db";
import type { ProviderId } from "@/lib/providers/types";

const SETTING_KEY = "selectedProvider";
const VALID_PROVIDERS: ProviderId[] = ["wavespeed", "comfy", "fal"];

/**
 * PUT /api/admin/settings
 *
 * Updates global app settings. Protected by the auth middleware
 * (any non-public route requires a valid session cookie). The admin
 * role check belongs in the route handler — currently TODO; this
 * route still relies on the middleware-level gate plus reverse-proxy
 * IP filtering at deploy.
 *
 * Body: { selectedProvider: ProviderId }
 *
 * The corresponding READ is at /api/settings (public, no auth) so
 * regular users can hydrate their client store on mount without
 * needing admin access. The setting itself is not a secret — only
 * the ability to change it is gated.
 */
export async function PUT(request: NextRequest) {
  try {
    const body = await request.json().catch(() => ({}));
    const incoming = body?.selectedProvider;
    if (
      typeof incoming !== "string" ||
      !VALID_PROVIDERS.includes(incoming as ProviderId)
    ) {
      return NextResponse.json(
        {
          error: `selectedProvider must be one of: ${VALID_PROVIDERS.join(", ")}`,
        },
        { status: 400 }
      );
    }
    setAppSetting(SETTING_KEY, incoming);
    return NextResponse.json({ ok: true, selectedProvider: incoming });
  } catch (err) {
    console.error("[admin/settings PUT] failed:", err);
    return NextResponse.json(
      { error: "Failed to save settings" },
      { status: 500 }
    );
  }
}
