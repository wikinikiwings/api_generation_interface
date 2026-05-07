import { type NextRequest, NextResponse } from "next/server";
import { promises as fs } from "node:fs";
import path from "node:path";
import { getDb, getHistoryImagesDir } from "@/lib/history-db";
import { getCurrentUser } from "@/lib/auth/current-user";
import { writeAuthEvent } from "@/lib/auth/audit";
import { deleteSessionsForUser } from "@/lib/auth/session";
import { broadcastToUserId } from "@/lib/sse-broadcast";
import { SESSION_COOKIE_NAME } from "@/lib/auth/cookie-name";
import { purgeUser, PurgeUserError } from "@/lib/admin/purge-user";
import { findFreeDeletedTarget, renameUserFolderToDeleted } from "@/lib/admin/folder-rename";

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
  // `folder_rename_target` here is PREDICTED (probed via findFreeDeletedTarget
  // before the rename runs). Under concurrent admin activity targeting the
  // same `deleted_*` namespace, the actual target may differ — the response
  // body's `folder_renamed_to` is authoritative for what's on disk. Audit
  // records intent at the time of the purge.
  // Use details.target_email (no auth_events.email column populated) to mirror
  // the `admin_user_created` pattern at app/api/admin/users/route.ts:47.
  let renameTarget: string | null = null;
  // Pre-compute target so the audit can record it. If probe fails (e.g.,
  // imagesDir vanished), we'll find it again during rename — best effort.
  try {
    const probe = await fs.access(path.join(imagesDir, purgeResult.email))
      .then(() => true).catch(() => false);
    if (probe) {
      renameTarget = await findFreeDeletedTarget(imagesDir, purgeResult.email);
    }
  } catch {
    // Non-fatal: audit will record a null target, rename below still tries.
  }

  writeAuthEvent(getDb(), {
    event_type: "admin_user_purged",
    user_id: me.id,
    details: {
      target_id: userId,
      target_email: purgeResult.email,
      generations_purged: purgeResult.generations_deleted,
      folder_rename_target: renameTarget,
    },
  });

  let renameOutcome: { renamed: true; target: string } | { renamed: false; reason: "no_source" | "rename_failed"; error?: string };
  try {
    renameOutcome = await renameUserFolderToDeleted(imagesDir, purgeResult.email);
  } catch (err) {
    console.error("[admin/users DELETE] rename failed:", err);
    renameOutcome = { renamed: false, reason: "rename_failed", error: (err as Error).message };
  }

  fanOutUserPurged(userId);

  const responseBody: Record<string, unknown> = {
    ok: true,
    purged: {
      email: purgeResult.email,
      generations_deleted: purgeResult.generations_deleted,
      summary_csv_written: purgeResult.csv_written,
      folder_renamed_to: renameOutcome.renamed ? renameOutcome.target : null,
    },
  };
  if (!renameOutcome.renamed && renameOutcome.reason === "rename_failed") {
    responseBody.warning = "rename_failed";
    responseBody.intended_target = renameTarget;
  }
  return NextResponse.json(responseBody);
}
