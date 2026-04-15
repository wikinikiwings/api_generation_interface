import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

// Point HISTORY_DATA_DIR at a tmpdir BEFORE importing the module under test,
// because the store resolves the path at module load.
let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "styles-test-"));
  process.env.HISTORY_DATA_DIR = tmpDir;
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
  delete process.env.HISTORY_DATA_DIR;
});

async function loadStore() {
  // Dynamic import so the env var is read on each test.
  const mod = await import("../store?t=" + Math.random());
  return mod;
}

describe("styles store", () => {
  it("listStyles returns [] when the folder does not exist yet", async () => {
    const { listStyles } = await loadStore();
    expect(await listStyles()).toEqual([]);
  });

  it("createStyle writes a file and returns the new style", async () => {
    const { createStyle, listStyles } = await loadStore();
    const created = await createStyle({
      name: "Кинематографичный",
      prefix: "cinematic shot",
      suffix: "film grain",
    });
    expect(created.id).toMatch(/^[a-z0-9-]+$/);
    expect(created.name).toBe("Кинематографичный");
    expect(created.prefix).toBe("cinematic shot");
    expect(created.suffix).toBe("film grain");
    expect(new Date(created.createdAt).getTime()).not.toBeNaN();
    expect(created.createdAt).toBe(created.updatedAt);

    const file = path.join(tmpDir, "styles", `${created.id}.json`);
    expect(fs.existsSync(file)).toBe(true);

    const list = await listStyles();
    expect(list).toHaveLength(1);
    expect(list[0].id).toBe(created.id);
  });

  it("createStyle trims name", async () => {
    const { createStyle } = await loadStore();
    const created = await createStyle({
      name: "  hello  ",
      prefix: "",
      suffix: "",
    });
    expect(created.name).toBe("hello");
  });

  it("createStyle rejects empty name", async () => {
    const { createStyle } = await loadStore();
    await expect(
      createStyle({ name: "   ", prefix: "", suffix: "" })
    ).rejects.toThrow(/name/i);
  });

  it("createStyle rejects name over 80 chars", async () => {
    const { createStyle } = await loadStore();
    await expect(
      createStyle({ name: "a".repeat(81), prefix: "", suffix: "" })
    ).rejects.toThrow(/80/);
  });

  it("createStyle rejects prefix/suffix over 2000 chars", async () => {
    const { createStyle } = await loadStore();
    await expect(
      createStyle({ name: "ok", prefix: "a".repeat(2001), suffix: "" })
    ).rejects.toThrow(/2000/);
    await expect(
      createStyle({ name: "ok", prefix: "", suffix: "a".repeat(2001) })
    ).rejects.toThrow(/2000/);
  });

  it("listStyles sorts by createdAt ascending", async () => {
    const { createStyle, listStyles } = await loadStore();
    const a = await createStyle({ name: "a", prefix: "", suffix: "" });
    await new Promise((r) => setTimeout(r, 5));
    const b = await createStyle({ name: "b", prefix: "", suffix: "" });
    const list = await listStyles();
    expect(list.map((s) => s.id)).toEqual([a.id, b.id]);
  });

  it("getStyle returns null for a missing id", async () => {
    const { getStyle } = await loadStore();
    expect(await getStyle("nope")).toBeNull();
  });

  it("updateStyle patches only supplied fields and bumps updatedAt", async () => {
    const { createStyle, updateStyle, getStyle } = await loadStore();
    const created = await createStyle({
      name: "a",
      prefix: "p",
      suffix: "s",
    });
    await new Promise((r) => setTimeout(r, 5));
    const updated = await updateStyle(created.id, { prefix: "p2" });
    expect(updated.name).toBe("a");
    expect(updated.prefix).toBe("p2");
    expect(updated.suffix).toBe("s");
    expect(updated.createdAt).toBe(created.createdAt);
    expect(updated.updatedAt).not.toBe(created.updatedAt);
    const reread = await getStyle(created.id);
    expect(reread?.prefix).toBe("p2");
  });

  it("updateStyle throws for missing id", async () => {
    const { updateStyle } = await loadStore();
    await expect(updateStyle("nope", { name: "x" })).rejects.toThrow(/not found/i);
  });

  it("deleteStyle removes the file", async () => {
    const { createStyle, deleteStyle, getStyle } = await loadStore();
    const created = await createStyle({ name: "a", prefix: "", suffix: "" });
    await deleteStyle(created.id);
    expect(await getStyle(created.id)).toBeNull();
  });

  it("deleteStyle throws for missing id", async () => {
    const { deleteStyle } = await loadStore();
    await expect(deleteStyle("nope")).rejects.toThrow(/not found/i);
  });

  it("createStyle rejects ids that look like path traversal", async () => {
    const { createStyle } = await loadStore();
    const created = await createStyle({
      name: "../../etc/passwd",
      prefix: "",
      suffix: "",
    });
    expect(created.id).toMatch(/^[a-z0-9-]+$/);
    expect(created.id).not.toContain("/");
    expect(created.id).not.toContain(".");
  });

  it("listStyles skips malformed JSON files and keeps going", async () => {
    const { createStyle, listStyles } = await loadStore();
    const good = await createStyle({ name: "good", prefix: "", suffix: "" });
    const badPath = path.join(tmpDir, "styles", "broken.json");
    fs.writeFileSync(badPath, "{not-json");
    const list = await listStyles();
    expect(list.map((s) => s.id)).toEqual([good.id]);
  });
});
