import { NextResponse } from "next/server";

// Deprecated. Replaced by GET /api/generate/status/:id?provider=wavespeed.
// See the notes in app/api/wavespeed/submit/route.ts.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json(
    {
      error:
        "This endpoint is deprecated. Use GET /api/generate/status/:id?provider=wavespeed.",
    },
    { status: 410 }
  );
}
