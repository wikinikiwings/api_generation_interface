import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { findFreeDeletedTarget, renameUserFolderToDeleted, renameWithRetry } from "../folder-rename";
import { findFreeDeletedTargetAcross, renameUserFolderToTarget } from "../folder-rename";

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

describe("renameWithRetry", () => {
  it("succeeds without retry when fs.rename succeeds first time", async () => {
    const src = path.join(root, "alice@x.com");
    await fs.mkdir(src);
    await renameWithRetry(src, path.join(root, "moved"));
    await expect(fs.access(path.join(root, "moved"))).resolves.toBeUndefined();
  });

  it("retries on EPERM and eventually succeeds", async () => {
    const src = path.join(root, "alice@x.com");
    const dst = path.join(root, "moved");
    await fs.mkdir(src);

    // Spy on fs.rename: throw EPERM twice, then call through.
    let calls = 0;
    const realRename = fs.rename;
    const spy = vi.spyOn(fs, "rename").mockImplementation(async (s, d) => {
      calls++;
      if (calls <= 2) {
        const err: NodeJS.ErrnoException = new Error("simulated EPERM") as NodeJS.ErrnoException;
        err.code = "EPERM";
        throw err;
      }
      return realRename.call(fs, s, d);
    });

    try {
      await renameWithRetry(src, dst);
      expect(calls).toBe(3); // 2 failures + 1 success
      await expect(fs.access(dst)).resolves.toBeUndefined();
    } finally {
      spy.mockRestore();
    }
  });

  it("throws non-transient errors immediately without retry", async () => {
    let calls = 0;
    const spy = vi.spyOn(fs, "rename").mockImplementation(async () => {
      calls++;
      const err: NodeJS.ErrnoException = new Error("simulated ENOENT") as NodeJS.ErrnoException;
      err.code = "ENOENT";
      throw err;
    });

    try {
      await expect(renameWithRetry("/nonexistent", "/also-nonexistent")).rejects.toThrow();
      expect(calls).toBe(1);
    } finally {
      spy.mockRestore();
    }
  });

  it("gives up after exhausting retries on persistent EPERM", async () => {
    let calls = 0;
    const spy = vi.spyOn(fs, "rename").mockImplementation(async () => {
      calls++;
      const err: NodeJS.ErrnoException = new Error("persistent EPERM") as NodeJS.ErrnoException;
      err.code = "EPERM";
      throw err;
    });

    try {
      await expect(renameWithRetry("/a", "/b")).rejects.toThrow(/persistent EPERM/);
      expect(calls).toBe(6); // 1 initial + 5 retries
    } finally {
      spy.mockRestore();
    }
  });
});

describe("findFreeDeletedTargetAcross", () => {
  it("returns deleted_{email} when both dirs are empty", async () => {
    const d1 = await fs.mkdtemp(path.join(os.tmpdir(), "two-a-"));
    const d2 = await fs.mkdtemp(path.join(os.tmpdir(), "two-b-"));
    try {
      const t = await findFreeDeletedTargetAcross([d1, d2], "alice@x.com");
      expect(t).toBe("deleted_alice@x.com");
    } finally {
      await fs.rm(d1, { recursive: true, force: true });
      await fs.rm(d2, { recursive: true, force: true });
    }
  });

  it("picks deleted_3 when first dir has 1, second has 2", async () => {
    const d1 = await fs.mkdtemp(path.join(os.tmpdir(), "two-a-"));
    const d2 = await fs.mkdtemp(path.join(os.tmpdir(), "two-b-"));
    try {
      await fs.mkdir(path.join(d1, "deleted_alice@x.com"));
      await fs.mkdir(path.join(d2, "deleted_2_alice@x.com"));
      const t = await findFreeDeletedTargetAcross([d1, d2], "alice@x.com");
      expect(t).toBe("deleted_3_alice@x.com");
    } finally {
      await fs.rm(d1, { recursive: true, force: true });
      await fs.rm(d2, { recursive: true, force: true });
    }
  });
});

describe("renameUserFolderToTarget", () => {
  it("renames {email}/ to the given target name", async () => {
    const d = await fs.mkdtemp(path.join(os.tmpdir(), "rt-"));
    try {
      await fs.mkdir(path.join(d, "alice@x.com"));
      const r = await renameUserFolderToTarget(d, "alice@x.com", "deleted_2_alice@x.com");
      expect(r).toEqual({ renamed: true, target: "deleted_2_alice@x.com" });
      await expect(fs.access(path.join(d, "deleted_2_alice@x.com"))).resolves.toBeUndefined();
    } finally {
      await fs.rm(d, { recursive: true, force: true });
    }
  });

  it("returns no_source when {email}/ does not exist", async () => {
    const d = await fs.mkdtemp(path.join(os.tmpdir(), "rt-"));
    try {
      const r = await renameUserFolderToTarget(d, "ghost@x.com", "deleted_ghost@x.com");
      expect(r).toEqual({ renamed: false, reason: "no_source" });
    } finally {
      await fs.rm(d, { recursive: true, force: true });
    }
  });
});
