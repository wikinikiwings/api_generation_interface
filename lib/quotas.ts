import type Database from "better-sqlite3";

/**
 * UTC bounds of the calendar month containing `now`.
 * Returns [startInclusive, endExclusive] as ISO 8601 strings.
 */
export function currentMonthBoundsUTC(now: Date = new Date()): [string, string] {
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth();
  const start = new Date(Date.UTC(y, m,     1, 0, 0, 0, 0)).toISOString();
  const end   = new Date(Date.UTC(y, m + 1, 1, 0, 0, 0, 0)).toISOString();
  return [start, end];
}

/**
 * Resolve the applicable monthly_limit for (user, model). Logic:
 *   1. user_quotas override (NULL = explicit unlimited override)
 *   2. otherwise models.default_monthly_limit (NULL = unlimited)
 *   3. otherwise (model not in `models` table at all) — return 0 (closed by default
 *      for unknown ids, defense against trying to bypass quota with a fake model_id)
 *
 * Returns: null = unlimited, number = max generations per calendar month UTC.
 */
export function applicableLimit(
  db: Database.Database,
  user_id: number,
  model_id: string
): number | null {
  // Sentinel: rowid presence vs NULL value. Use a row-existence check first.
  const override = db.prepare(
    `SELECT monthly_limit FROM user_quotas WHERE user_id=? AND model_id=?`
  ).get(user_id, model_id) as { monthly_limit: number | null } | undefined;
  if (override) return override.monthly_limit; // may be NULL (unlimited)

  const def = db.prepare(
    `SELECT default_monthly_limit FROM models WHERE model_id=?`
  ).get(model_id) as { default_monthly_limit: number | null } | undefined;
  if (!def) return 0; // unknown model → closed by default
  return def.default_monthly_limit;
}

/**
 * Count of billable generations for (user, model) within the current
 * calendar month UTC. `now` defaults to `new Date()` for testability.
 *
 * Includes both 'completed' and 'deleted' rows: once a generation
 * succeeded, the compute cost was paid, so the user later soft-deleting
 * the output doesn't refund the quota. This is the "count once" billing
 * model (see deleteGeneration in history-db.ts).
 */
export function usageThisMonth(
  db: Database.Database,
  user_id: number,
  model_id: string,
  now: Date = new Date()
): number {
  const [start, end] = currentMonthBoundsUTC(now);
  const r = db.prepare(`
    SELECT COUNT(*) AS n FROM generations
    WHERE user_id=? AND model_id=?
      AND created_at >= ? AND created_at < ?
      AND status IN ('completed', 'deleted')
  `).get(user_id, model_id, start, end) as { n: number };
  return r.n;
}
