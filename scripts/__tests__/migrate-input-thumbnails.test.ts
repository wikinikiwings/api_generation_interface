import { describe, it, expect } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import Database from "better-sqlite3";
import { initSchema } from "@/lib/history-db";
import { migrateInputThumbnails } from "@/scripts/migrate-input-thumbnails.mjs";

const UUID = "0123abcd-4567-89ab-cdef-0123456789ab";
const B64 = "data:image/jpeg;base64," + Buffer.from([0xff, 0xd8, 0xff, 0xe0]).toString("base64");

async function seed() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mig-"));
  const db = new Database(path.join(dir, "history.db"));
  initSchema(db);
  db.prepare(`INSERT INTO users (id,email,role,status) VALUES (1,'alice@x.com','user','active')`).run();
  db.prepare(`INSERT INTO generations (id,user_id,model_id,prompt_data,status) VALUES (1,1,'nano-banana-pro',?, 'completed')`)
    .run(JSON.stringify({ prompt: "p", inputThumbnails: [B64] }));
  db.prepare(`INSERT INTO generation_outputs (generation_id,filename,filepath,content_type,size) VALUES (1,'o.png',?, 'image/png', 4)`)
    .run(`alice@x.com/2026/06/${UUID}.png`);
  db.close();
  return dir;
}

describe("migrateInputThumbnails", () => {
  it("dry-run writes nothing, reports count", async () => {
    const dir = await seed();
    const res = await migrateInputThumbnails({ dbPath: path.join(dir, "history.db"), inputsDir: path.join(dir, "history_inputs"), dryRun: true });
    expect(res.rowsToMigrate).toBe(1);
    expect(await fs.access(path.join(dir, "history_inputs")).then(() => true).catch(() => false)).toBe(false);
  });

  it("converts base64 thumbs to files + URLs, idempotent, leaves inputImages absent", async () => {
    const dir = await seed();
    const dbPath = path.join(dir, "history.db");
    const inputsDir = path.join(dir, "history_inputs");
    const r1 = await migrateInputThumbnails({ dbPath, inputsDir, dryRun: false });
    expect(r1.rowsMigrated).toBe(1);

    const db = new Database(dbPath, { readonly: true });
    const parsed = JSON.parse((db.prepare(`SELECT prompt_data FROM generations WHERE id=1`).get() as { prompt_data: string }).prompt_data);
    db.close();
    expect(parsed.inputThumbnails).toEqual([`/api/history/image/alice%40x.com/2026/06/input_thumb_${UUID}_0.jpg`]);
    expect(parsed.inputImages).toBeUndefined();
    expect(Array.from(await fs.readFile(path.join(inputsDir, "alice@x.com", "2026", "06", `input_thumb_${UUID}_0.jpg`)))).toEqual([0xff,0xd8,0xff,0xe0]);

    const r2 = await migrateInputThumbnails({ dbPath, inputsDir, dryRun: false });
    expect(r2.rowsMigrated).toBe(0);
  });
});
