import { NextResponse } from "next/server";
import { listStyles } from "@/lib/styles/store";

export const dynamic = "force-dynamic";

/**
 * GET /api/styles
 *
 * Public endpoint — returns all custom styles. The synthetic "Стандартный"
 * default is NOT included; the client adds it as the first option in the
 * dropdown.
 */
export async function GET() {
  try {
    const styles = await listStyles();
    return NextResponse.json({ styles });
  } catch (err) {
    console.error("[/api/styles GET] failed:", err);
    return NextResponse.json(
      { error: "Failed to list styles" },
      { status: 500 }
    );
  }
}
