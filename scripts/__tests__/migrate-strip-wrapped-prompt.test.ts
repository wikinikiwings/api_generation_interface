import { describe, it, expect } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import Database from "better-sqlite3";
import { initSchema } from "@/lib/history-db";
import { migrateStripWrappedPrompt } from "@/scripts/migrate-strip-wrapped-prompt.mjs";

async function seed() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mig-strip-"));
  const db = new Database(path.join(dir, "history.db"));
  initSchema(db);
  db.prepare(`INSERT INTO users (id,email,role,status) VALUES (1,'a@x.com','user','active')`).run();
  // row 1: post-feature (has userPrompt + prompt) — strippable
  db.prepare(`INSERT INTO generations (id,user_id,model_id,prompt_data,status) VALUES (1,1,'m',?, 'completed')`)
    .run(JSON.stringify({ prompt: "TOP\nhi", userPrompt: "hi", styleIds: ["a"] }));
  // row 2: legacy (no userPrompt) — must keep prompt
  db.prepare(`INSERT INTO generations (id,user_id,model_id,prompt_data,status) VALUES (2,1,'m',?, 'completed')`)
    .run(JSON.stringify({ prompt: "legacy" }));
  db.close();
  return dir;
}

describe("migrateStripWrappedPrompt", () => {
  it("dry-run reports count, writes nothing", async () => {
    const dir = await seed();
    const res = await migrateStripWrappedPrompt({ dbPath: path.join(dir, "history.db"), dryRun: true });
    expect(res.rowsToMigrate).toBe(1);
    const db = new Database(path.join(dir, "history.db"), { readonly: true });
    const r1 = JSON.parse((db.prepare(`SELECT prompt_data FROM generations WHERE id=1`).get() as any).prompt_data);
    db.close();
    expect(r1.prompt).toBe("TOP\nhi");
  });

  it("strips prompt from post-feature rows, keeps legacy, idempotent", async () => {
    const dir = await seed();
    const dbPath = path.join(dir, "history.db");
    const r1 = await migrateStripWrappedPrompt({ dbPath, dryRun: false });
    expect(r1.rowsMigrated).toBe(1);

    const db = new Database(dbPath, { readonly: true });
    const row1 = JSON.parse((db.prepare(`SELECT prompt_data FROM generations WHERE id=1`).get() as any).prompt_data);
    const row2 = JSON.parse((db.prepare(`SELECT prompt_data FROM generations WHERE id=2`).get() as any).prompt_data);
    db.close();
    expect("prompt" in row1).toBe(false);
    expect(row1.userPrompt).toBe("hi");
    expect(row1.styleIds).toEqual(["a"]);
    expect(row2.prompt).toBe("legacy");

    const r2 = await migrateStripWrappedPrompt({ dbPath, dryRun: false });
    expect(r2.rowsMigrated).toBe(0);
  });
});
