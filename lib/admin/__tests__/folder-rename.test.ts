import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { findFreeDeletedTarget, renameUserFolderToDeleted } from "../folder-rename";

let root: string;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "purge-test-"));
});
afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe("findFreeDeletedTarget", () => {
  it("returns deleted_{email} when nothing exists", async () => {
    const t = await findFreeDeletedTarget(root, "alice@x.com");
    expect(t).toBe("deleted_alice@x.com");
  });

  it("returns deleted_2_{email} when first slot taken", async () => {
    await fs.mkdir(path.join(root, "deleted_alice@x.com"));
    const t = await findFreeDeletedTarget(root, "alice@x.com");
    expect(t).toBe("deleted_2_alice@x.com");
  });

  it("returns deleted_3_{email} when 1 and 2 taken", async () => {
    await fs.mkdir(path.join(root, "deleted_alice@x.com"));
    await fs.mkdir(path.join(root, "deleted_2_alice@x.com"));
    const t = await findFreeDeletedTarget(root, "alice@x.com");
    expect(t).toBe("deleted_3_alice@x.com");
  });

  it("fills gaps — picks lowest free slot", async () => {
    await fs.mkdir(path.join(root, "deleted_alice@x.com"));
    await fs.mkdir(path.join(root, "deleted_3_alice@x.com"));
    const t = await findFreeDeletedTarget(root, "alice@x.com");
    expect(t).toBe("deleted_2_alice@x.com");
  });
});

describe("renameUserFolderToDeleted", () => {
  it("renames {email}/ to deleted_{email}/ and returns target", async () => {
    const src = path.join(root, "alice@x.com");
    await fs.mkdir(src);
    await fs.writeFile(path.join(src, "marker.txt"), "hi");
    const result = await renameUserFolderToDeleted(root, "alice@x.com");
    expect(result).toEqual({ renamed: true, target: "deleted_alice@x.com" });
    await expect(fs.access(src)).rejects.toThrow();
    const moved = await fs.readFile(path.join(root, "deleted_alice@x.com", "marker.txt"), "utf8");
    expect(moved).toBe("hi");
  });

  it("returns no_source when {email}/ does not exist", async () => {
    const result = await renameUserFolderToDeleted(root, "ghost@x.com");
    expect(result).toEqual({ renamed: false, reason: "no_source" });
  });

  it("uses next free slot on second purge of same email", async () => {
    await fs.mkdir(path.join(root, "deleted_alice@x.com"));
    await fs.mkdir(path.join(root, "alice@x.com"));
    const result = await renameUserFolderToDeleted(root, "alice@x.com");
    expect(result).toEqual({ renamed: true, target: "deleted_2_alice@x.com" });
  });
});
