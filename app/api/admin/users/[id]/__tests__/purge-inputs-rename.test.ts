import { describe, it, expect, vi } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";

describe("hard-delete renames the inputs root", () => {
  it("moves <email>/ under images, variants AND inputs to the same target", async () => {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "purge-"));
    process.env.HISTORY_DATA_DIR = dataDir;
    (process.env as Record<string, string>).NODE_ENV = "test";
    vi.doMock("@/lib/auth/current-user", () => ({ getCurrentUser: () => ({ id: 99, email: "admin@x.com", role: "admin" }) }));

    const db = await import("@/lib/history-db");
    db.getDb().prepare(`INSERT INTO users (id,email,role,status) VALUES (2,'bob@x.com','user','deleted')`).run();
    for (const root of [db.getHistoryImagesDir(), db.getHistoryVariantsDir(), db.getHistoryInputsDir()]) {
      await fs.mkdir(path.join(root, "bob@x.com", "2026", "06"), { recursive: true });
    }

    const { DELETE } = await import("@/app/api/admin/users/[id]/route");
    const res = await DELETE(
      { cookies: { get: () => ({ value: "sid" }) }, json: async () => ({ confirmation_email: "bob@x.com" }) } as never,
      { params: Promise.resolve({ id: "2" }) }
    );
    const body = await res.json();
    expect(body.purged.rename_outcome.inputs).toBe("renamed");
    const moved = await fs.access(path.join(db.getHistoryInputsDir(), body.purged.folder_renamed_to)).then(() => true).catch(() => false);
    expect(moved).toBe(true);
  });
});
