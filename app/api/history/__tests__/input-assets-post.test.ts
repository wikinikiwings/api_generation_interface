import { describe, it, expect } from "vitest";
import { buildInputAssetUrls } from "@/app/api/history/input-asset-urls";

const uuid = "0123abcd-4567-89ab-cdef-0123456789ab";
const P = "/api/history/image/alice%40x.com/2026/06";

describe("buildInputAssetUrls", () => {
  it("builds thumbnail + full URLs per index", () => {
    const r = buildInputAssetUrls(P, uuid, [{ ext: "png" }, { ext: "webp" }]);
    expect(r.thumbnails).toEqual([
      `${P}/input_thumb_${uuid}_0.jpg`,
      `${P}/input_thumb_${uuid}_1.jpg`,
    ]);
    expect(r.images).toEqual([
      `${P}/input_${uuid}_0.png`,
      `${P}/input_${uuid}_1.webp`,
    ]);
  });
  it("omits images when no fulls present (legacy/thumb-only)", () => {
    const r = buildInputAssetUrls(P, uuid, [{ ext: null }]);
    expect(r.thumbnails).toEqual([`${P}/input_thumb_${uuid}_0.jpg`]);
    expect(r.images).toEqual([]);
  });
  it("returns empty for zero items", () => {
    expect(buildInputAssetUrls(P, uuid, [])).toEqual({ thumbnails: [], images: [] });
  });
});

import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import { vi } from "vitest";

vi.mock("@/lib/auth/current-user", () => ({ getCurrentUser: () => ({ id: 1, email: "alice@x.com", role: "user" }) }));

describe("POST /api/history writes full+thumb and URL-only prompt_data", () => {
  it("stores inputThumbnails + inputImages URLs, no base64, files on disk", async () => {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "histpost-"));
    process.env.HISTORY_DATA_DIR = dataDir;
    (process.env as Record<string, string>).NODE_ENV = "test";

    const db = await import("@/lib/history-db");
    db.getDb().prepare(`INSERT INTO users (id,email,role,status) VALUES (1,'alice@x.com','user','active')`).run();
    const { POST } = await import("@/app/api/history/route");

    const uuid = "0123abcd-4567-89ab-cdef-0123456789ab";
    const fd = new FormData();
    fd.append("uuid", uuid);
    fd.append("workflowName", "wf");
    fd.append("promptData", JSON.stringify({ prompt: "p", modelId: "nano-banana-pro", provider: "wavespeed" }));
    fd.append("executionTimeSeconds", "1");
    fd.append("original", new File([new Uint8Array([1,2,3])], "o.png", { type: "image/png" }));
    fd.append("thumb", new File([new Uint8Array([1])], "t.jpg", { type: "image/jpeg" }));
    fd.append("mid", new File([new Uint8Array([1])], "m.jpg", { type: "image/jpeg" }));
    fd.append("inputCount", "1");
    fd.append("inputthumb_0", new File([new Uint8Array([7])], "inputthumb_0.jpg", { type: "image/jpeg" }));
    fd.append("inputfull_0", new File([new Uint8Array([8,8])], "inputfull_0.png", { type: "image/png" }));

    const res = await POST({ cookies: { get: () => ({ value: "sid" }) }, formData: async () => fd } as never);
    expect(res.status).toBe(200);

    const row = db.getDb().prepare(`SELECT prompt_data FROM generations WHERE user_id=1`).get() as { prompt_data: string };
    const parsed = JSON.parse(row.prompt_data);
    const yyyy = String(new Date().getUTCFullYear());
    const mm = String(new Date().getUTCMonth() + 1).padStart(2, "0");
    expect(parsed.inputThumbnails).toEqual([`/api/history/image/alice%40x.com/${yyyy}/${mm}/input_thumb_${uuid}_0.jpg`]);
    expect(parsed.inputImages).toEqual([`/api/history/image/alice%40x.com/${yyyy}/${mm}/input_${uuid}_0.png`]);
    expect(JSON.stringify(parsed)).not.toContain("data:image");

    const inputsDir = db.getHistoryInputsDir();
    expect(Array.from(await fs.readFile(path.join(inputsDir, "alice@x.com", yyyy, mm, `input_${uuid}_0.png`)))).toEqual([8,8]);
    expect(Array.from(await fs.readFile(path.join(inputsDir, "alice@x.com", yyyy, mm, `input_thumb_${uuid}_0.jpg`)))).toEqual([7]);
  });
});
