import { type NextRequest, NextResponse } from "next/server";
import { updateStyle, deleteStyle } from "@/lib/styles/store";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

/**
 * PUT /api/admin/styles/[id]
 * Body: { name?: string; prefix?: string; suffix?: string }
 */
export async function PUT(request: NextRequest, ctx: Ctx) {
  try {
    const { id } = await ctx.params;
    const body = await request.json().catch(() => ({}));
    const patch: Record<string, string> = {};
    if (typeof body?.name === "string") patch.name = body.name;
    if (typeof body?.prefix === "string") patch.prefix = body.prefix;
    if (typeof body?.suffix === "string") patch.suffix = body.suffix;
    const style = await updateStyle(id, patch);
    return NextResponse.json({ style });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "unknown error";
    console.error("[/api/admin/styles PUT] failed:", msg);
    if (/not found/i.test(msg)) {
      return NextResponse.json({ error: msg }, { status: 404 });
    }
    const isValidation = /name|prefix|suffix|chars|required|invalid/i.test(msg);
    return NextResponse.json(
      { error: msg },
      { status: isValidation ? 400 : 500 }
    );
  }
}

/**
 * DELETE /api/admin/styles/[id]
 */
export async function DELETE(_request: NextRequest, ctx: Ctx) {
  try {
    const { id } = await ctx.params;
    await deleteStyle(id);
    return NextResponse.json({ ok: true });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "unknown error";
    console.error("[/api/admin/styles DELETE] failed:", msg);
    if (/not found/i.test(msg)) {
      return NextResponse.json({ error: msg }, { status: 404 });
    }
    if (/invalid/i.test(msg)) {
      return NextResponse.json({ error: msg }, { status: 400 });
    }
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
