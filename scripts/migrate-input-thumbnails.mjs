import Database from "better-sqlite3";
import path from "node:path";
import fs from "node:fs/promises";

const OUTPUT_RE = /^(.*)\/(\d{4})\/(\d{2})\/([0-9a-f-]{36})\.[^.]+$/i;

/**
 * Backfill legacy base64 prompt_data.inputThumbnails to on-disk thumbnails + URLs.
 * Legacy rows never had full inputs, so inputImages is NOT set here.
 * @param {{dbPath:string, inputsDir:string, dryRun:boolean, stripOrphans?:boolean}} opts
 */
export async function migrateInputThumbnails(opts) {
  const { dbPath, inputsDir, dryRun, stripOrphans = true } = opts;
  const db = new Database(dbPath);
  const rows = db.prepare(`
    SELECT g.id AS id, g.prompt_data AS prompt_data,
      (SELECT o.filepath FROM generation_outputs o
        WHERE o.generation_id = g.id AND o.content_type LIKE 'image/%'
        ORDER BY o.id LIMIT 1) AS filepath
    FROM generations g
    WHERE g.prompt_data LIKE '%data:image%'
  `).all();

  let rowsToMigrate = 0, rowsMigrated = 0, filesWritten = 0, skipped = 0;
  const update = db.prepare(`UPDATE generations SET prompt_data=? WHERE id=?`);

  for (const r of rows) {
    let parsed;
    try { parsed = JSON.parse(r.prompt_data); } catch { skipped++; continue; }
    const arr = parsed.inputThumbnails;
    if (!Array.isArray(arr) || !arr.some((x) => typeof x === "string" && x.startsWith("data:image"))) continue;
    rowsToMigrate++;
    if (dryRun) continue;

    const m = r.filepath ? OUTPUT_RE.exec(r.filepath) : null;
    if (!m) {
      if (stripOrphans) { parsed.inputThumbnails = []; update.run(JSON.stringify(parsed), r.id); rowsMigrated++; }
      else skipped++;
      continue;
    }
    const [, emailDir, yyyy, mm, uuid] = m;
    const relDir = `${emailDir}/${yyyy}/${mm}`;
    const absDir = path.join(inputsDir, relDir);
    await fs.mkdir(absDir, { recursive: true });

    const urls = [];
    for (let i = 0; i < arr.length; i++) {
      const s = arr[i];
      if (typeof s === "string" && s.startsWith("data:image")) {
        const b64 = s.slice(s.indexOf(",") + 1);
        await fs.writeFile(path.join(absDir, `input_thumb_${uuid}_${i}.jpg`), Buffer.from(b64, "base64"));
        filesWritten++;
      }
      urls.push(`/api/history/image/${encodeURIComponent(emailDir)}/${yyyy}/${mm}/input_thumb_${uuid}_${i}.jpg`);
    }
    parsed.inputThumbnails = urls;
    update.run(JSON.stringify(parsed), r.id);
    rowsMigrated++;
  }

  if (!dryRun && rowsMigrated > 0) db.exec("VACUUM");
  db.close();
  return { rowsToMigrate, rowsMigrated, filesWritten, skipped };
}

// CLI: node scripts/migrate-input-thumbnails.mjs --db <path> --inputs <dir> [--dry-run]
if (import.meta.url === `file://${process.argv[1]}`) {
  const a = process.argv.slice(2);
  const get = (f) => { const i = a.indexOf(f); return i >= 0 ? a[i + 1] : undefined; };
  const dbPath = get("--db"), inputsDir = get("--inputs"), dryRun = a.includes("--dry-run");
  if (!dbPath || !inputsDir) {
    console.error("usage: --db <history.db> --inputs <history_inputs dir> [--dry-run]");
    process.exit(2);
  }
  migrateInputThumbnails({ dbPath, inputsDir, dryRun })
    .then((r) => console.log(JSON.stringify({ dryRun, ...r }, null, 2)))
    .catch((e) => { console.error(e); process.exit(1); });
}
