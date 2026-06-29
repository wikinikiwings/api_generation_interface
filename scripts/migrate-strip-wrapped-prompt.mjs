import Database from "better-sqlite3";
import { pathToFileURL } from "node:url";

/**
 * Strip the redundant wrapped `prompt` from prompt_data. Post-feature rows
 * (those with a `userPrompt`) recompose the wrapped prompt on demand from
 * userPrompt + styleIds + the style catalog, so the stored copy is dead
 * weight. Legacy rows without `userPrompt` keep their `prompt`.
 * styleVersions is NOT backfilled (historical updatedAt is unknown).
 * @param {{dbPath:string, dryRun:boolean}} opts
 */
export function migrateStripWrappedPrompt(opts) {
  const { dbPath, dryRun } = opts;
  const db = new Database(dbPath);
  let rowsToMigrate = 0, rowsMigrated = 0, skipped = 0;

  try {
    const rows = db.prepare(`
      SELECT id, prompt_data FROM generations
      WHERE prompt_data LIKE '%"userPrompt"%' AND prompt_data LIKE '%"prompt"%'
    `).all();
    const update = db.prepare(`UPDATE generations SET prompt_data=? WHERE id=?`);

    for (const r of rows) {
      let parsed;
      try { parsed = JSON.parse(r.prompt_data); } catch { skipped++; continue; }
      if (typeof parsed.userPrompt !== "string") continue; // legacy: keep prompt
      if (!("prompt" in parsed)) continue;                 // already stripped
      rowsToMigrate++;
      if (dryRun) continue;
      delete parsed.prompt;
      update.run(JSON.stringify(parsed), r.id);
      rowsMigrated++;
    }

    if (!dryRun && rowsMigrated > 0) db.exec("VACUUM");
  } finally {
    db.close();
  }

  return { rowsToMigrate, rowsMigrated, skipped };
}

// CLI: node scripts/migrate-strip-wrapped-prompt.mjs --db <path> [--dry-run]
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const a = process.argv.slice(2);
  const get = (f) => { const i = a.indexOf(f); return i >= 0 ? a[i + 1] : undefined; };
  const dbPath = get("--db"), dryRun = a.includes("--dry-run");
  if (!dbPath) {
    console.error("usage: --db <history.db> [--dry-run]");
    process.exit(2);
  }
  try {
    const r = migrateStripWrappedPrompt({ dbPath, dryRun });
    console.log(JSON.stringify({ dryRun, ...r }, null, 2));
  } catch (e) {
    console.error(e);
    process.exit(1);
  }
}
