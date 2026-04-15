import { type NextRequest, NextResponse } from "next/server";
import { createStyle } from "@/lib/styles/store";

export const dynamic = "force-dynamic";

/**
 * POST /api/admin/styles
 * Body: { name: string; prefix: string; suffix: string }
 *
 * Gated by the middleware that protects /api/admin/*. Creates a new style
 * file and returns the created record (with generated id).
 */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json().catch(() => ({}));
    const name = typeof body?.name === "string" ? body.name : "";
    const prefix = typeof body?.prefix === "string" ? body.prefix : "";
    const suffix = typeof body?.suffix === "string" ? body.suffix : "";
    const style = await createStyle({ name, prefix, suffix });
    return NextResponse.json({ style }, { status: 201 });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "unknown error";
    console.error("[/api/admin/styles POST] failed:", msg);
    const isValidation = /name|prefix|suffix|chars|required/i.test(msg);
    return NextResponse.json(
      { error: msg },
      { status: isValidation ? 400 : 500 }
    );
  }
}
