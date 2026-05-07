import type Database from "better-sqlite3";
import { promises as fs } from "node:fs";
import path from "node:path";
import { buildUserSummaryCsv } from "./summary-csv";

export interface PurgeUserOpts {
  /** Absolute path to HISTORY_IMAGES_DIR (passed in for testability). */
  imagesDir: string;
  /** ISO timestamp recorded in the CSV header. Caller picks (typically `new Date().toISOString()`). */
  purgedAtIso: string;
}

export interface PurgeUserResult {
  email: string;
  generations_deleted: number;
  /** True if `_SUMMARY.csv` was written into `{imagesDir}/{email}/`. */
  csv_written: boolean;
}

export type PurgeUserErrorKind =
  | "not_found"
  | "summary_write_failed"
  | "db_delete_failed";

export class PurgeUserError extends Error {
  constructor(public kind: PurgeUserErrorKind, message: string) {
    super(message);
    this.name = "PurgeUserError";
  }
}

/**
 * Hard-delete a user from the database after writing a per-month/per-model
 * summary CSV into their content folder (if they had any generations and
 * the folder exists).
 *
 * Order:
 *   1. SELECT user (must exist; `status` not enforced here — caller validates).
 *   2. Build summary CSV in memory.
 *   3. If user has generations AND `{imagesDir}/{email}/` exists → write
 *      `_SUMMARY.csv` there. (Failure here propagates; caller treats as
 *      `summary_write_failed` and aborts.)
 *   4. Atomic DB transaction: DELETE outputs → DELETE generations →
 *      DELETE user. CASCADE wipes sessions, user_quotas, user_preferences.
 *      `auth_events` rows survive (no FK) — paper trail.
 *
 * Folder rename is NOT performed here; the route handler does it AFTER
 * this function returns successfully.
 */
export async function purgeUser(
  db: Database.Database,
  userId: number,
  opts: PurgeUserOpts
): Promise<PurgeUserResult> {
  const user = db.prepare(`SELECT email FROM users WHERE id=?`).get(userId) as
    | { email: string }
    | undefined;
  if (!user) throw new PurgeUserError("not_found", `user id=${userId} not found`);

  const csv = buildUserSummaryCsv(db, userId, user.email, opts.purgedAtIso);
  const totalRow = db.prepare(`
    SELECT COUNT(*) AS n FROM generations
    WHERE user_id=? AND status IN ('completed','deleted')
  `).get(userId) as { n: number };
  const total = totalRow.n;

  const userDir = path.join(opts.imagesDir, user.email);
  let csvWritten = false;
  if (total > 0) {
    const dirExists = await fs.access(userDir).then(() => true).catch(() => false);
    if (dirExists) {
      try {
        await fs.writeFile(path.join(userDir, "_SUMMARY.csv"), csv, "utf8");
        csvWritten = true;
      } catch (err) {
        throw new PurgeUserError(
          "summary_write_failed",
          `failed to write _SUMMARY.csv: ${(err as Error).message}`
        );
      }
    }
  }

  // Atomic — RESTRICT on generations.user_id requires we delete
  // child rows first, in this order. The transaction rolls back on any
  // throw; better-sqlite3's .transaction wraps in BEGIN/COMMIT/ROLLBACK.
  try {
    const tx = db.transaction(() => {
      db.prepare(`
        DELETE FROM generation_outputs
        WHERE generation_id IN (SELECT id FROM generations WHERE user_id=?)
      `).run(userId);
      db.prepare(`DELETE FROM generations WHERE user_id=?`).run(userId);
      db.prepare(`DELETE FROM users WHERE id=?`).run(userId);
    });
    tx();
  } catch (err) {
    throw new PurgeUserError(
      "db_delete_failed",
      `db transaction failed: ${(err as Error).message}`
    );
  }

  return {
    email: user.email,
    generations_deleted: total,
    csv_written: csvWritten,
  };
}
