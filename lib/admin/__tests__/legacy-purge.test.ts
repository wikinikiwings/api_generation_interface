/** @vitest-environment node */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { scanLegacyVariants, purgeLegacyVariants } from "../legacy-purge";

let root: string;

async function seed(rel: string, bytes = "x") {
  const abs = path.join(root, rel);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, bytes);
}

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "legacy-purge-"));
});
afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe("scanLegacyVariants", () => {
  it("returns 0 on an empty root", async () => {
    const r = await scanLegacyVariants(root);
    expect(r.count).toBe(0);
    expect(r.dirs.length).toBe(0);
  });

  it("counts thumb_/mid_ files but not originals", async () => {
    const id = "11111111-1111-1111-1111-111111111111";
    await seed(`alice@x.com/2026/05/${id}.png`);
    await seed(`alice@x.com/2026/05/thumb_${id}.jpg`);
    await seed(`alice@x.com/2026/05/mid_${id}.jpg`);
    const r = await scanLegacyVariants(root);
    expect(r.count).toBe(2);
    expect(r.dirs).toContain(`alice@x.com/2026/05`);
  });
});

describe("purgeLegacyVariants", () => {
  it("deletes only thumb_/mid_ JPEGs matching the UUID pattern", async () => {
    const id = "22222222-2222-2222-2222-222222222222";
    await seed(`alice@x.com/2026/05/${id}.png`);
    await seed(`alice@x.com/2026/05/thumb_${id}.jpg`);
    await seed(`alice@x.com/2026/05/mid_${id}.jpg`);
    await seed(`alice@x.com/2026/05/notes.txt`);
    const r = await purgeLegacyVariants(root);
    expect(r.deleted).toBe(2);
    await expect(fs.access(path.join(root, `alice@x.com/2026/05/${id}.png`))).resolves.toBeUndefined();
    await expect(fs.access(path.join(root, `alice@x.com/2026/05/notes.txt`))).resolves.toBeUndefined();
    await expect(fs.access(path.join(root, `alice@x.com/2026/05/thumb_${id}.jpg`))).rejects.toThrow();
    await expect(fs.access(path.join(root, `alice@x.com/2026/05/mid_${id}.jpg`))).rejects.toThrow();
  });

  it("is idempotent — a second run finds nothing", async () => {
    const id = "33333333-3333-3333-3333-333333333333";
    await seed(`bob@y.com/2026/05/thumb_${id}.jpg`);
    const r1 = await purgeLegacyVariants(root);
    expect(r1.deleted).toBe(1);
    const r2 = await purgeLegacyVariants(root);
    expect(r2.deleted).toBe(0);
  });

  it("does not delete deleted_*/ archives (no email-shape on first segment)", async () => {
    const id = "44444444-4444-4444-4444-444444444444";
    await seed(`deleted_alice@x.com/2026/05/thumb_${id}.jpg`);
    const r = await purgeLegacyVariants(root);
    expect(r.deleted).toBe(0);
  });
});
