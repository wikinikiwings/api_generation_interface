/**
 * Orchestrates a rebuild job: enumerates the target generations, runs
 * buildVariantsForGeneration with bounded concurrency, and updates the
 * job state + broadcasts SSE progress.
 *
 * Stays out of HTTP handler concerns - pure server-side function.
 */

import type Database from "better-sqlite3";
import { runPool } from "@/lib/image-optimize";
import { buildVariantsForGeneration } from "@/lib/variants-builder";
import {
  appendError,
  bumpDone,
  finishJob,
  getJob,
} from "@/lib/admin/variants-jobs";

interface Row {
  id: number;
  email: string;
}

export interface RebuildOpts {
  scope: "user" | "all";
  userId?: number;
  imagesDir: string;
  variantsDir: string;
  /** SSE fan-out; runner stays decoupled from broadcast plumbing. */
  broadcast: (event: {
    type: "admin.variants_rebuild_progress" | "admin.variants_rebuild_done";
    data: Record<string, unknown>;
  }) => void;
  /** Tunable; default 2 - sharp/libvips is already multi-threaded. */
  concurrency?: number;
}

const PROGRESS_TICK_MS = 1000;

export async function runRebuild(
  db: Database.Database,
  jobId: string,
  opts: RebuildOpts
): Promise<void> {
  const rows = listGenerations(db, opts);
  // Update total to the actual count in case the caller over- or
  // under-estimated when tryStartJob was called.
  const job = getJob(jobId);
  if (job) job.total = rows.length;

  let lastTick = 0;
  const tick = (currentEmail?: string) => {
    const now = Date.now();
    if (now - lastTick < PROGRESS_TICK_MS) return;
    lastTick = now;
    const s = getJob(jobId);
    if (!s) return;
    opts.broadcast({
      type: "admin.variants_rebuild_progress",
      data: {
        jobId,
        done: s.done,
        total: s.total,
        currentEmail,
        errors: s.errors.length,
      },
    });
  };

  await runPool(rows, opts.concurrency ?? 2, async (row) => {
    const res = await buildVariantsForGeneration(db, row.id, {
      imagesDir: opts.imagesDir,
      variantsDir: opts.variantsDir,
    });
    if (!res.ok) {
      appendError(jobId, { generationId: row.id, reason: res.reason, error: res.error });
    }
    bumpDone(jobId, row.email);
    tick(row.email);
    return null;
  });

  finishJob(jobId);
  const final = getJob(jobId);
  opts.broadcast({
    type: "admin.variants_rebuild_done",
    data: { jobId, total: final?.total ?? 0, errors: final?.errors.length ?? 0 },
  });
}

function listGenerations(db: Database.Database, opts: RebuildOpts): Row[] {
  const base = `
    SELECT DISTINCT g.id, u.email
    FROM generations g
    JOIN users u ON u.id = g.user_id
    JOIN generation_outputs o ON o.generation_id = g.id
    WHERE g.status IN ('completed','deleted')
      AND o.content_type LIKE 'image/%'
      AND u.status = 'active'
  `;
  if (opts.scope === "user") {
    return db.prepare(`${base} AND g.user_id = ? ORDER BY g.id ASC`)
      .all(opts.userId) as Row[];
  }
  return db.prepare(`${base} ORDER BY g.id ASC`).all() as Row[];
}
