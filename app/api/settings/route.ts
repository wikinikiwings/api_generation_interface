import { NextResponse } from "next/server";
import { getAppSetting } from "@/lib/history-db";
import type { ProviderId } from "@/lib/providers/types";

const SETTING_KEY = "selectedProvider";
const DEFAULT_PROVIDER: ProviderId = "wavespeed";
const VALID_PROVIDERS: ProviderId[] = ["wavespeed", "comfy", "fal"];

/**
 * GET /api/settings
 *
 * Returns the current global app settings. PUBLIC endpoint — no auth.
 * Regular (non-admin) users hydrate their client store from this on
 * mount so the generate form knows which provider to submit to.
 *
 * The setting itself is not a secret; only the ability to CHANGE it
 * is gated, via PUT /api/admin/settings (under the admin middleware).
 *
 * Falls back to DEFAULT_PROVIDER on first run when the row doesn't
 * exist yet, so a fresh install works without manual seeding.
 */
export async function GET() {
  try {
    const stored = getAppSetting(SETTING_KEY);
    const selectedProvider =
      stored && VALID_PROVIDERS.includes(stored as ProviderId)
        ? (stored as ProviderId)
        : DEFAULT_PROVIDER;
    return NextResponse.json({ selectedProvider });
  } catch (err) {
    console.error("[settings GET] failed:", err);
    return NextResponse.json({ selectedProvider: DEFAULT_PROVIDER });
  }
}
