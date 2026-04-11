import { NextResponse } from "next/server";

// Deprecated. This endpoint was replaced by /api/generate/submit which
// dispatches to the right provider via the Provider abstraction layer
// (see lib/providers/). Kept only as a 410 Gone response so old clients
// get a clear error instead of a confusing 404.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST() {
  return NextResponse.json(
    {
      error:
        "This endpoint is deprecated. Use POST /api/generate/submit with `provider: \"wavespeed\"` in the body.",
    },
    { status: 410 }
  );
}
