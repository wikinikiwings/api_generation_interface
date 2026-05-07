import type Database from "better-sqlite3";

interface SummaryRow {
  yr: string;
  mo: string;
  model_id: string | null;
  display_name: string | null;
  cnt: number;
}

/**
 * Build the human-readable + CSV-shaped summary that gets written into
 * the user's image folder before purge. Three `#` comment lines at the
 * top capture metadata (email, purge timestamp, total count); the
 * remainder is a flat CSV grouped by year/month/model.
 *
 * `purged_at` is passed in (not derived from `Date.now()`) so the route
 * handler can record the same timestamp in both the CSV and the audit
 * event, and tests stay deterministic.
 *
 * Counts include both `completed` and `deleted` generations to mirror
 * the billing semantic (see lib/quotas usage logic).
 */
export function buildUserSummaryCsv(
  db: Database.Database,
  userId: number,
  email: string,
  purgedAtIso: string
): string {
  const rows = db
    .prepare(`
      SELECT
        strftime('%Y', g.created_at) AS yr,
        strftime('%m', g.created_at) AS mo,
        g.model_id,
        m.display_name,
        COUNT(*) AS cnt
      FROM generations g
      LEFT JOIN models m ON m.model_id = g.model_id
      WHERE g.user_id = ?
        AND g.status IN ('completed', 'deleted')
      GROUP BY yr, mo, g.model_id
      ORDER BY yr DESC, mo DESC, cnt DESC
    `)
    .all(userId) as SummaryRow[];

  const total = rows.reduce((s, r) => s + r.cnt, 0);

  const lines: string[] = [];
  lines.push(`# email: ${email}`);
  lines.push(`# purged_at: ${purgedAtIso}`);
  lines.push(`# total_generations: ${total}`);
  lines.push(`year,month,model_id,model_display_name,generations`);
  for (const r of rows) {
    const modelId = r.model_id ?? "";
    const display = r.display_name ?? (r.model_id ? r.model_id : "(unknown)");
    lines.push(`${r.yr},${r.mo},${modelId},${display},${r.cnt}`);
  }
  return lines.join("\n") + "\n";
}
