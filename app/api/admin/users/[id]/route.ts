import { type NextRequest, NextResponse } from "next/server";
import { getDb, getHistoryImagesDir, getHistoryVariantsDir } from "@/lib/history-db";
import { getCurrentUser } from "@/lib/auth/current-user";
import { writeAuthEvent } from "@/lib/auth/audit";
import { deleteSessionsForUser } from "@/lib/auth/session";
import { broadcastToUserId } from "@/lib/sse-broadcast";
import { SESSION_COOKIE_NAME } from "@/lib/auth/cookie-name";
import { purgeUser, PurgeUserError } from "@/lib/admin/purge-user";
import { findFreeDeletedTargetAcross, renameUserFolderToTarget } from "@/lib/admin/folder-rename";

function fanOutUserPurged(targetUserId: number) {
  // Errors swallowed: the purge already succeeded; broadcast failure
  // must not 500 the response. Same pattern as app/api/history POST.
  try {
    const admins = getDb().prepare(
      `SELECT id FROM users WHERE role='admin' AND status='active'`
    ).all() as { id: number }[];
    for (const a of admins) {
      broadcastToUserId(a.id, {
        type: "admin.user_purged",
        data: { user_id: targetUserId },
      });
    }
  } catch (err) {
    console.error("[admin/users DELETE] admin broadcast failed:", err);
  }
}

export const runtime = "nodejs";

export async function PATCH(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> }
) {
  const me = getCurrentUser(getDb(), req.cookies.get(SESSION_COOKIE_NAME)?.value ?? null);
  if (!me) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (me.role !== "admin") return NextResponse.json({ error: "forbidden" }, { status: 403 });

  const { id } = await ctx.params;
  const userId = parseInt(id);
  const body = (await req.json()) as {
    role?: "user" | "admin";
    status?: "active" | "banned" | "deleted";
  };

  const before = getDb()
    .prepare(`SELECT role, status FROM users WHERE id=?`)
    .get(userId) as { role: string; status: string } | undefined;
  if (!before) return NextResponse.json({ error: "not_found" }, { status: 404 });

  const sets: string[] = [];
  const args: unknown[] = [];
  if (body.role && body.role !== before.role) {
    sets.push("role=?");
    args.push(body.role);
  }
  if (body.status && body.status !== before.status) {
    sets.push("status=?");
    args.push(body.status);
  }
  if (sets.length === 0) return NextResponse.json({ ok: true, changed: false });

  args.push(userId);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  getDb()
    .prepare(`UPDATE users SET ${sets.join(", ")} WHERE id=?`)
    .run(...(args as any[]));

  if (body.role && body.role !== before.role) {
    writeAuthEvent(getDb(), {
      event_type: "admin_user_role_changed",
      user_id: me.id,
      details: { target_id: userId, from: before.role, to: body.role },
    });
    broadcastToUserId(userId, { type: "user_role_changed" });
  }
  if (body.status && body.status !== before.status) {
    writeAuthEvent(getDb(), {
      event_type: "admin_user_status_changed",
      user_id: me.id,
      details: { target_id: userId, from: before.status, to: body.status },
    });
    if (body.status !== "active") {
      deleteSessionsForUser(getDb(), userId);
      broadcastToUserId(userId, { type: "user_banned" });
    }
  }
  return NextResponse.json({ ok: true, changed: true });
}

export async function DELETE(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> }
) {
  const me = getCurrentUser(getDb(), req.cookies.get(SESSION_COOKIE_NAME)?.value ?? null);
  if (!me) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (me.role !== "admin") return NextResponse.json({ error: "forbidden" }, { status: 403 });

  const { id } = await ctx.params;
  const userId = parseInt(id);
  if (Number.isNaN(userId)) return NextResponse.json({ error: "invalid_id" }, { status: 400 });
  if (userId === me.id) return NextResponse.json({ error: "self_purge_forbidden" }, { status: 400 });

  let body: { confirmation_email?: string };
  try {
    body = (await req.json()) as { confirmation_email?: string };
  } catch {
    return NextResponse.json({ error: "invalid_body" }, { status: 400 });
  }
  const confirmation = (body.confirmation_email ?? "").trim().toLowerCase();
  if (!confirmation) {
    return NextResponse.json({ error: "confirmation_mismatch" }, { status: 400 });
  }

  const target = getDb()
    .prepare(`SELECT email, status FROM users WHERE id=?`)
    .get(userId) as { email: string; status: string } | undefined;
  if (!target) return NextResponse.json({ error: "not_found" }, { status: 404 });
  if (target.status !== "deleted") {
    return NextResponse.json({ error: "must_be_soft_deleted_first" }, { status: 409 });
  }
  if (confirmation !== target.email.toLowerCase()) {
    return NextResponse.json({ error: "confirmation_mismatch" }, { status: 400 });
  }

  const purgedAtIso = new Date().toISOString();
  const imagesDir = getHistoryImagesDir();

  let purgeResult;
  try {
    purgeResult = await purgeUser(getDb(), userId, { imagesDir, purgedAtIso });
  } catch (err) {
    console.error("[admin/users DELETE] purge failed:", err);
    if (err instanceof PurgeUserError) {
      return NextResponse.json(
        { error: err.kind, detail: err.message },
        { status: err.kind === "not_found" ? 404 : 500 }
      );
    }
    return NextResponse.json({ error: "db_delete_failed", detail: (err as Error).message }, { status: 500 });
  }

  // Audit BEFORE the rename so the intent is recorded even if rename fails.
  // `folder_rename_target` here is PREDICTED (probed via findFreeDeletedTargetAcross
  // before the rename runs). Under concurrent admin activity targeting the
  // same `deleted_*` namespace, the actual target may differ — the response
  // body's `folder_renamed_to` is authoritative for what's on disk. Audit
  // records intent at the time of the purge.
  // Use details.target_email (no auth_events.email column populated) to mirror
  // the `admin_user_created` pattern at app/api/admin/users/route.ts:47.
  const variantsDir = getHistoryVariantsDir();
  // Predicted target for the audit log — probed across BOTH roots so the
  // slot we record matches the slot we'll actually try to occupy.
  const predictedTarget = await findFreeDeletedTargetAcross(
    [imagesDir, variantsDir],
    purgeResult.email
  );

  // Audit-before-rename ordering preserved (see post-ship doc §"Audit-before-rename
  // ordering rationale"): we want a permanent record of intent even if the
  // disk side-effect fails. The actual outcome lives in the response body.
  writeAuthEvent(getDb(), {
    event_type: "admin_user_purged",
    user_id: me.id,
    email: purgeResult.email,
    details: {
      target_id: userId,
      target_email: purgeResult.email,
      generations_purged: purgeResult.generations_deleted,
      folder_rename_target: predictedTarget,
    },
  });

  type SideOutcome = "renamed" | "no_source" | "failed";
  let imagesOutcome: SideOutcome;
  let variantsOutcome: SideOutcome;
  let renameError: string | null = null;
  try {
    const imgRes = await renameUserFolderToTarget(imagesDir, purgeResult.email, predictedTarget);
    imagesOutcome = imgRes.renamed ? "renamed" : imgRes.reason;
  } catch (err) {
    console.error("[admin/users DELETE] images rename failed:", err);
    imagesOutcome = "failed";
    renameError = (err as Error).message;
  }
  try {
    const varRes = await renameUserFolderToTarget(variantsDir, purgeResult.email, predictedTarget);
    variantsOutcome = varRes.renamed ? "renamed" : varRes.reason;
  } catch (err) {
    console.error("[admin/users DELETE] variants rename failed:", err);
    variantsOutcome = "failed";
    renameError = renameError ?? (err as Error).message;
  }

  fanOutUserPurged(userId);

  const anyRenamed = imagesOutcome === "renamed" || variantsOutcome === "renamed";
  const responseBody: Record<string, unknown> = {
    ok: true,
    purged: {
      email: purgeResult.email,
      generations_deleted: purgeResult.generations_deleted,
      summary_csv_written: purgeResult.csv_written,
      folder_renamed_to: anyRenamed ? predictedTarget : null,
      rename_outcome: { images: imagesOutcome, variants: variantsOutcome },
    },
  };
  if (imagesOutcome === "failed" || variantsOutcome === "failed") {
    responseBody.warning = "rename_failed";
    responseBody.intended_target = predictedTarget;
    if (renameError) responseBody.rename_error = renameError;
  }
  return NextResponse.json(responseBody);
}
