# Variants Separation — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move `thumb_*.jpg` and `mid_*.jpg` derivative variants out of `HISTORY_IMAGES_DIR/<email>/<YYYY>/<MM>/` and into a separate top-level `HISTORY_VARIANTS_DIR/`, add an admin tab with legacy-purge and per-user / global rebuild powered by server-side `sharp`, and extend hard-delete to rename both roots consistently.

**Architecture:** Two top-level dirs with mirrored `<email>/<YYYY>/<MM>/` layout. The existing `/api/history/image/[...path]` route dispatches by basename prefix (`thumb_`/`mid_` → variants root, otherwise → images root) so client URL templates stay identical. The client continues to generate variants on the hot POST path; `sharp` is used only by the admin rebuild module. DB schema is untouched — variant paths are formula-derived from the original's `filepath`.

**Tech Stack:** Next.js 15 (App Router), better-sqlite3, sharp ^0.34.5 (already in deps), vitest, jsdom (default) and `@vitest-environment node` for filesystem/DB tests.

**Spec:** `docs/superpowers/specs/2026-05-14-variants-separation-design.md`

---

## File Plan

### New files

| File | Purpose |
|------|---------|
| `lib/image-variants-spec.ts` | Shared resize constants (widths, JPEG qualities) |
| `lib/__tests__/image-variants-spec.test.ts` | Asserts constants are sane integers |
| `lib/variants-builder.ts` | Server-side sharp pipeline + `buildVariantsForGeneration` |
| `lib/__tests__/variants-builder.test.ts` | Sharp behaviour, idempotency, error modes |
| `lib/admin/variants-jobs.ts` | In-memory Map<jobId, JobState> + start/append/finish helpers |
| `lib/admin/__tests__/variants-jobs.test.ts` | State transitions, single-job invariant |
| `lib/admin/legacy-purge.ts` | FS walker that removes `thumb_*.jpg`/`mid_*.jpg` from images-dir |
| `lib/admin/__tests__/legacy-purge.test.ts` | Walker behaviour, originals untouched |
| `app/api/admin/variants/rebuild/route.ts` | POST — per-user job start |
| `app/api/admin/variants/rebuild-all/route.ts` | POST — global job start |
| `app/api/admin/variants/job/[jobId]/route.ts` | GET — poll a job's state |
| `app/api/admin/variants/stats/route.ts` | GET — DB + disk counts |
| `app/api/admin/variants/users/route.ts` | GET — users with image generations, desc count |
| `app/api/admin/variants/legacy-scan/route.ts` | GET — count of legacy thumb_/mid_ files |
| `app/api/admin/variants/legacy-purge/route.ts` | POST — remove legacy thumb_/mid_ files |
| `components/admin/preview-state-tab.tsx` | The new admin tab UI |

### Modified files

| File | Change |
|------|--------|
| `lib/history-db.ts` | Add `HISTORY_VARIANTS_DIR` const + `getHistoryVariantsDir()` export |
| `lib/image-variants.ts` | Replace inline constants with imports from shared spec |
| `app/api/history/route.ts` (POST handler) | Write original to images dir, variants to variants dir |
| `app/api/history/image/[...path]/route.ts` | Dispatch root by basename prefix |
| `lib/sse-broadcast.ts` | Add `admin.variants_rebuild_progress` / `admin.variants_rebuild_done` events |
| `lib/admin/folder-rename.ts` | Add `findFreeDeletedTargetAcross` + `renameUserFolderToTarget` |
| `lib/admin/__tests__/folder-rename.test.ts` | Tests for new helpers |
| `app/api/admin/users/[id]/route.ts` (DELETE handler) | Two-step rename across both roots |
| `lib/admin/__tests__/purge-user.test.ts` | Extend tests for variants rename behaviour |
| `.env.example` | Document `HISTORY_VARIANTS_DIR` |
| Admin tab registration (existing parent layout) | Add "Превью / History state" tab |

---

## Task 1: Pre-flight — verify `sharp` works on the dev machine

Sharp is already listed in `package.json` at `^0.34.5`. This task confirms its prebuilt binary loads and resizes successfully before we depend on it in real code. If this fails, fix npm install before continuing (no later task can succeed without it).

**Files:**
- No code changes; this is a sanity check.

- [ ] **Step 1: Run a one-shot sharp smoke**

Run from the repo root:

```bash
node -e "require('sharp')(Buffer.from([137,80,78,71,13,10,26,10,0,0,0,13,73,72,68,82,0,0,0,1,0,0,0,1,8,2,0,0,0,144,119,83,222,0,0,0,12,73,68,65,84,8,153,99,248,207,192,0,0,0,3,0,1,109,242,9,233,0,0,0,0,73,69,78,68,174,66,96,130])).resize(1,1).jpeg({quality:70}).toBuffer().then(b => console.log('OK', b.length, 'bytes')).catch(e => { console.error('FAIL', e); process.exit(1); })"
```

Expected: `OK <some number> bytes` printed in under one second.
On failure: re-install with `npm rebuild sharp` or `npm install --force sharp`, then retry. Do NOT proceed past this task with a failing smoke.

- [ ] **Step 2: No commit**

This step has no code changes. Move on to Task 2.

---

## Task 2: Shared variant spec module

Create the single source of truth for resize parameters so client (Canvas) and server (sharp) cannot drift.

**Files:**
- Create: `lib/image-variants-spec.ts`
- Test: `lib/__tests__/image-variants-spec.test.ts`

- [ ] **Step 1: Write the failing test**

Create `lib/__tests__/image-variants-spec.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import {
  THUMB_WIDTH,
  THUMB_QUALITY,
  MID_WIDTH,
  MID_QUALITY,
} from "@/lib/image-variants-spec";

describe("image-variants-spec", () => {
  it("exports four positive integer constants", () => {
    expect(Number.isInteger(THUMB_WIDTH)).toBe(true);
    expect(Number.isInteger(MID_WIDTH)).toBe(true);
    expect(Number.isInteger(THUMB_QUALITY)).toBe(true);
    expect(Number.isInteger(MID_QUALITY)).toBe(true);
    expect(THUMB_WIDTH).toBeGreaterThan(0);
    expect(MID_WIDTH).toBeGreaterThan(THUMB_WIDTH);
    expect(THUMB_QUALITY).toBeGreaterThan(0);
    expect(THUMB_QUALITY).toBeLessThanOrEqual(100);
    expect(MID_QUALITY).toBeGreaterThan(0);
    expect(MID_QUALITY).toBeLessThanOrEqual(100);
  });

  it("matches the pre-existing client values", () => {
    expect(THUMB_WIDTH).toBe(240);
    expect(THUMB_QUALITY).toBe(70);
    expect(MID_WIDTH).toBe(1200);
    expect(MID_QUALITY).toBe(85);
  });
});
```

- [ ] **Step 2: Run the failing test**

Run: `npm test -- image-variants-spec`
Expected: FAIL — cannot resolve `@/lib/image-variants-spec`.

- [ ] **Step 3: Create the spec module**

Create `lib/image-variants-spec.ts`:

```ts
/**
 * Variant resize parameters shared by the client (Canvas/OffscreenCanvas
 * pipeline in lib/image-variants.ts) and the server (sharp pipeline in
 * lib/variants-builder.ts).
 *
 * Quality values are JPEG quality on a 1..100 integer scale (sharp's
 * native unit). The client API `canvas.toBlob(_, 'image/jpeg', q)` takes
 * a 0..1 float — call sites divide by 100 at the call site to keep this
 * module agnostic of the consumer's API.
 */

export const THUMB_WIDTH = 240;
export const THUMB_QUALITY = 70;
export const MID_WIDTH = 1200;
export const MID_QUALITY = 85;
```

- [ ] **Step 4: Run tests, confirm pass**

Run: `npm test -- image-variants-spec`
Expected: 2 tests pass.

- [ ] **Step 5: Commit**

```bash
git add lib/image-variants-spec.ts lib/__tests__/image-variants-spec.test.ts
git commit -m "feat(variants): shared resize spec module for client/server parity"
```

---

## Task 3: Switch client to shared spec

Replace inline constants in `lib/image-variants.ts` with imports. Quality divides by 100 at the `toBlob` / `convertToBlob` call sites. No behavioural change.

**Files:**
- Modify: `lib/image-variants.ts:15-18, 102-133`

- [ ] **Step 1: Apply the edit**

In `lib/image-variants.ts`, replace lines 15-18:

```ts
const THUMB_WIDTH = 240;
const THUMB_QUALITY = 0.7;
const MID_WIDTH = 1200;
const MID_QUALITY = 0.85;
```

with:

```ts
import {
  THUMB_WIDTH,
  THUMB_QUALITY as THUMB_QUALITY_INT,
  MID_WIDTH,
  MID_QUALITY as MID_QUALITY_INT,
} from "@/lib/image-variants-spec";

// Canvas APIs take a 0..1 float; the shared spec uses a 1..100 int.
const THUMB_QUALITY = THUMB_QUALITY_INT / 100;
const MID_QUALITY = MID_QUALITY_INT / 100;
```

The rest of the file is unchanged — the `encodeVariant` calls at lines 45 and 47 still receive `THUMB_QUALITY` / `MID_QUALITY` as 0..1 floats, exactly as before.

- [ ] **Step 2: Run the full test suite**

Run: `npm test`
Expected: all existing tests pass, no regressions.

- [ ] **Step 3: Type-check**

Run: `npx tsc --noEmit`
Expected: zero errors.

- [ ] **Step 4: Commit**

```bash
git add lib/image-variants.ts
git commit -m "refactor(variants): client reads resize spec from shared module"
```

---

## Task 4: `getHistoryVariantsDir()` + env documentation

Add the new module-level constant + exporter to `lib/history-db.ts`, mirroring the existing `HISTORY_IMAGES_DIR` pattern. Document `HISTORY_VARIANTS_DIR` in `.env.example`.

**Files:**
- Modify: `lib/history-db.ts:16-25`
- Modify: `.env.example`
- Test: `lib/__tests__/history-variants-dir.test.ts`

- [ ] **Step 1: Write the failing test**

Create `lib/__tests__/history-variants-dir.test.ts`:

```ts
/** @vitest-environment node */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";

let tmp: string;
let prevImagesDataDir: string | undefined;
let prevVariantsDir: string | undefined;

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "variants-dir-test-"));
  prevImagesDataDir = process.env.HISTORY_DATA_DIR;
  prevVariantsDir = process.env.HISTORY_VARIANTS_DIR;
  vi.resetModules();
});
afterEach(async () => {
  if (prevImagesDataDir === undefined) delete process.env.HISTORY_DATA_DIR;
  else process.env.HISTORY_DATA_DIR = prevImagesDataDir;
  if (prevVariantsDir === undefined) delete process.env.HISTORY_VARIANTS_DIR;
  else process.env.HISTORY_VARIANTS_DIR = prevVariantsDir;
  await fs.rm(tmp, { recursive: true, force: true });
});

describe("getHistoryVariantsDir", () => {
  it("defaults to <DATA_DIR>/history_variants/ and creates the dir", async () => {
    process.env.HISTORY_DATA_DIR = tmp;
    delete process.env.HISTORY_VARIANTS_DIR;
    const mod = await import("@/lib/history-db");
    const dir = mod.getHistoryVariantsDir();
    expect(dir).toBe(path.join(tmp, "history_variants"));
    await expect(fs.access(dir)).resolves.toBeUndefined();
  });

  it("honours HISTORY_VARIANTS_DIR override and creates that dir", async () => {
    process.env.HISTORY_DATA_DIR = tmp;
    const customDir = path.join(tmp, "custom_variants_root");
    process.env.HISTORY_VARIANTS_DIR = customDir;
    const mod = await import("@/lib/history-db");
    const dir = mod.getHistoryVariantsDir();
    expect(dir).toBe(customDir);
    await expect(fs.access(dir)).resolves.toBeUndefined();
  });
});
```

- [ ] **Step 2: Run failing test**

Run: `npm test -- history-variants-dir`
Expected: FAIL — `mod.getHistoryVariantsDir is not a function`.

- [ ] **Step 3: Modify `lib/history-db.ts`**

In `lib/history-db.ts`, find the existing block at lines 16-25:

```ts
const DATA_DIR = process.env.HISTORY_DATA_DIR
  ? path.resolve(process.env.HISTORY_DATA_DIR)
  : path.join(process.cwd(), "data");

const DB_PATH = path.join(DATA_DIR, "history.db");
const HISTORY_IMAGES_DIR = path.join(DATA_DIR, "history_images");

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(HISTORY_IMAGES_DIR))
  fs.mkdirSync(HISTORY_IMAGES_DIR, { recursive: true });
```

Add after `HISTORY_IMAGES_DIR` definition (before the `if (!fs.existsSync(DATA_DIR))` block):

```ts
const HISTORY_VARIANTS_DIR = process.env.HISTORY_VARIANTS_DIR
  ? path.resolve(process.env.HISTORY_VARIANTS_DIR)
  : path.join(DATA_DIR, "history_variants");
```

Add after the existing two `fs.mkdirSync` calls:

```ts
if (!fs.existsSync(HISTORY_VARIANTS_DIR))
  fs.mkdirSync(HISTORY_VARIANTS_DIR, { recursive: true });
```

Find the existing `getHistoryImagesDir` export (search the file for "export function getHistoryImagesDir") and add directly below it:

```ts
export function getHistoryVariantsDir(): string {
  return HISTORY_VARIANTS_DIR;
}
```

- [ ] **Step 4: Run the test**

Run: `npm test -- history-variants-dir`
Expected: 2 tests pass.

- [ ] **Step 5: Update `.env.example`**

In `.env.example`, find the block documenting `HISTORY_DATA_DIR` and add a new block right after it:

```
# Where derived thumb/mid JPEG variants are stored.
# Defaults to ${HISTORY_DATA_DIR}/history_variants/ (sibling of history_images/).
# Override to point variants at a different absolute path, e.g. a faster
# SSD that does not need to be backed up.
# HISTORY_VARIANTS_DIR=
```

- [ ] **Step 6: Commit**

```bash
git add lib/history-db.ts lib/__tests__/history-variants-dir.test.ts .env.example
git commit -m "feat(variants): add HISTORY_VARIANTS_DIR env + getHistoryVariantsDir()"
```

---

## Task 5: Server-side variants builder (sharp pipeline)

Pure module that resizes one generation's original into thumb + mid JPEGs and writes them via temp-then-rename. Idempotent; safe to re-run.

**Files:**
- Create: `lib/variants-builder.ts`
- Test: `lib/__tests__/variants-builder.test.ts`

- [ ] **Step 1: Write the failing test**

Create `lib/__tests__/variants-builder.test.ts`:

```ts
/** @vitest-environment node */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import sharp from "sharp";
import { initSchema, seedModels } from "@/lib/history-db";
import { buildVariantsForGeneration } from "@/lib/variants-builder";
import { THUMB_WIDTH, MID_WIDTH } from "@/lib/image-variants-spec";

let db: Database.Database;
let imagesDir: string;
let variantsDir: string;
let userId: number;
let genId: number;

async function makePng(width: number, height: number): Promise<Buffer> {
  return sharp({
    create: { width, height, channels: 3, background: { r: 0, g: 128, b: 255 } },
  }).png().toBuffer();
}

beforeEach(async () => {
  db = new Database(":memory:");
  initSchema(db);
  seedModels(db);
  imagesDir = await fs.mkdtemp(path.join(os.tmpdir(), "vb-img-"));
  variantsDir = await fs.mkdtemp(path.join(os.tmpdir(), "vb-var-"));
  userId = db.prepare(`INSERT INTO users (email, status) VALUES ('alice@x.com', 'active')`)
    .run().lastInsertRowid as number;
  genId = db.prepare(
    `INSERT INTO generations (user_id, model_id, status) VALUES (?, 'nano-banana-pro', 'completed')`
  ).run(userId).lastInsertRowid as number;
});
afterEach(async () => {
  await fs.rm(imagesDir, { recursive: true, force: true });
  await fs.rm(variantsDir, { recursive: true, force: true });
});

async function placeOriginal(relPath: string, buf: Buffer): Promise<void> {
  const abs = path.join(imagesDir, relPath);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, buf);
}

function insertOutput(filepath: string, contentType = "image/png"): void {
  db.prepare(
    `INSERT INTO generation_outputs (generation_id, filename, filepath, content_type)
     VALUES (?, 'a.png', ?, ?)`
  ).run(genId, filepath, contentType);
}

describe("buildVariantsForGeneration", () => {
  it("writes thumb + mid JPEGs at expected widths and qualities", async () => {
    const relPath = "alice@x.com/2026/05/abc-123.png";
    await placeOriginal(relPath, await makePng(2400, 1800));
    insertOutput(relPath);

    const result = await buildVariantsForGeneration(db, genId, { imagesDir, variantsDir });
    expect(result.ok).toBe(true);

    const thumbAbs = path.join(variantsDir, "alice@x.com/2026/05/thumb_abc-123.jpg");
    const midAbs   = path.join(variantsDir, "alice@x.com/2026/05/mid_abc-123.jpg");
    const thumbMeta = await sharp(thumbAbs).metadata();
    const midMeta = await sharp(midAbs).metadata();
    expect(thumbMeta.format).toBe("jpeg");
    expect(midMeta.format).toBe("jpeg");
    expect(thumbMeta.width).toBe(THUMB_WIDTH);
    expect(midMeta.width).toBe(MID_WIDTH);
  });

  it("does not enlarge a small original", async () => {
    const relPath = "alice@x.com/2026/05/small.png";
    await placeOriginal(relPath, await makePng(100, 80));
    insertOutput(relPath);

    const result = await buildVariantsForGeneration(db, genId, { imagesDir, variantsDir });
    expect(result.ok).toBe(true);

    const thumbMeta = await sharp(path.join(variantsDir, "alice@x.com/2026/05/thumb_small.jpg")).metadata();
    expect(thumbMeta.width).toBe(100);
  });

  it("is idempotent — running twice succeeds and overwrites", async () => {
    const relPath = "alice@x.com/2026/05/idem.png";
    await placeOriginal(relPath, await makePng(1000, 800));
    insertOutput(relPath);

    const a = await buildVariantsForGeneration(db, genId, { imagesDir, variantsDir });
    const b = await buildVariantsForGeneration(db, genId, { imagesDir, variantsDir });
    expect(a.ok && b.ok).toBe(true);
  });

  it("returns original_missing when the file is gone", async () => {
    insertOutput("alice@x.com/2026/05/ghost.png");
    const result = await buildVariantsForGeneration(db, genId, { imagesDir, variantsDir });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("original_missing");
  });

  it("returns no_original when generation has no image output", async () => {
    const result = await buildVariantsForGeneration(db, genId, { imagesDir, variantsDir });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("no_original");
  });

  it("ignores non-image outputs and returns no_original", async () => {
    insertOutput("alice@x.com/2026/05/v.mp4", "video/mp4");
    const result = await buildVariantsForGeneration(db, genId, { imagesDir, variantsDir });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("no_original");
  });
});
```

- [ ] **Step 2: Run the failing test**

Run: `npm test -- variants-builder`
Expected: FAIL — cannot resolve `@/lib/variants-builder`.

- [ ] **Step 3: Create `lib/variants-builder.ts`**

```ts
/**
 * Server-side variant (re)builder.
 *
 * Reads a generation's original from HISTORY_IMAGES_DIR, derives
 * thumb_/mid_ JPEGs using sharp, and writes them to HISTORY_VARIANTS_DIR
 * under the same <email>/<YYYY>/<MM>/ subpath. Idempotent.
 *
 * Used exclusively by the admin "Rebuild variants" tool — the normal
 * generation hot path lets the client produce variants (see lib/image-
 * variants.ts and app/api/history/route.ts).
 */

import type Database from "better-sqlite3";
import { promises as fs } from "node:fs";
import path from "node:path";
import sharp from "sharp";
import {
  THUMB_WIDTH,
  THUMB_QUALITY,
  MID_WIDTH,
  MID_QUALITY,
} from "@/lib/image-variants-spec";
import { renameWithRetry } from "@/lib/admin/folder-rename";

export interface BuildVariantsOpts {
  imagesDir: string;
  variantsDir: string;
}

export type BuildReason =
  | "no_original"        // no image-typed output row
  | "original_missing"   // DB pointed at a file that doesn't exist
  | "decode_failed"      // sharp couldn't open / decode the original
  | "write_failed";      // any write/rename failure

export type BuildResult =
  | { ok: true }
  | { ok: false; reason: BuildReason; error?: string };

interface OutputRow {
  filepath: string;
  content_type: string;
}

export async function buildVariantsForGeneration(
  db: Database.Database,
  generationId: number,
  opts: BuildVariantsOpts
): Promise<BuildResult> {
  const outputs = db.prepare(
    `SELECT filepath, content_type FROM generation_outputs WHERE generation_id = ?`
  ).all(generationId) as OutputRow[];
  const firstImage = outputs.find((o) => o.content_type.startsWith("image/"));
  if (!firstImage) return { ok: false, reason: "no_original" };

  const originalAbs = path.join(opts.imagesDir, firstImage.filepath);
  let originalBuf: Buffer;
  try {
    originalBuf = await fs.readFile(originalAbs);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      return { ok: false, reason: "original_missing", error: originalAbs };
    }
    return { ok: false, reason: "write_failed", error: (err as Error).message };
  }

  const lastSlash = firstImage.filepath.lastIndexOf("/");
  const dir = lastSlash >= 0 ? firstImage.filepath.slice(0, lastSlash) : "";
  const basename = lastSlash >= 0 ? firstImage.filepath.slice(lastSlash + 1) : firstImage.filepath;
  const stem = basename.replace(/\.[a-z0-9]+$/i, "");
  const variantsAbsDir = path.join(opts.variantsDir, dir);
  await fs.mkdir(variantsAbsDir, { recursive: true });

  try {
    await writeVariant(originalBuf, THUMB_WIDTH, THUMB_QUALITY,
      path.join(variantsAbsDir, `thumb_${stem}.jpg`));
    await writeVariant(originalBuf, MID_WIDTH, MID_QUALITY,
      path.join(variantsAbsDir, `mid_${stem}.jpg`));
  } catch (err) {
    const msg = (err as Error).message ?? String(err);
    // sharp throws Error with `.message` containing 'Input buffer contains unsupported image format'
    // or similar for decode failures.
    if (/unsupported image format|Input file/i.test(msg)) {
      return { ok: false, reason: "decode_failed", error: msg };
    }
    return { ok: false, reason: "write_failed", error: msg };
  }
  return { ok: true };
}

async function writeVariant(
  source: Buffer,
  width: number,
  qualityInt: number,
  finalPath: string
): Promise<void> {
  const tmpPath = `${finalPath}.tmp`;
  const buf = await sharp(source)
    .resize({ width, withoutEnlargement: true })
    .jpeg({ quality: qualityInt })
    .toBuffer();
  await fs.writeFile(tmpPath, buf);
  await renameWithRetry(tmpPath, finalPath);
}
```

- [ ] **Step 4: Run the test**

Run: `npm test -- variants-builder`
Expected: 6 tests pass.

- [ ] **Step 5: Commit**

```bash
git add lib/variants-builder.ts lib/__tests__/variants-builder.test.ts
git commit -m "feat(variants): server-side rebuild module using sharp"
```

---

## Task 6: Hard-delete extension — pair-aware rename helpers

Add `findFreeDeletedTargetAcross(dirs, email)` and `renameUserFolderToTarget(dir, email, target)` to `lib/admin/folder-rename.ts`. The existing single-dir `renameUserFolderToDeleted` stays as-is for any non-paired caller.

**Files:**
- Modify: `lib/admin/folder-rename.ts`
- Modify: `lib/admin/__tests__/folder-rename.test.ts`

- [ ] **Step 1: Write failing tests**

Append to `lib/admin/__tests__/folder-rename.test.ts`:

```ts
import { findFreeDeletedTargetAcross, renameUserFolderToTarget } from "../folder-rename";

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
```

- [ ] **Step 2: Run failing tests**

Run: `npm test -- folder-rename`
Expected: FAIL — exports missing.

- [ ] **Step 3: Implement the two helpers**

Append to `lib/admin/folder-rename.ts`:

```ts
/**
 * Like `findFreeDeletedTarget` but probes the same slot across all given
 * dirs and returns the lowest index that is free in EVERY dir. Used by
 * hard-delete so that the user's images and variants archives end up at
 * the same on-disk name even if prior purges left different slot patterns
 * in each dir.
 */
export async function findFreeDeletedTargetAcross(
  dirs: string[],
  email: string
): Promise<string> {
  let n = 1;
  while (true) {
    const candidate =
      n === 1 ? `deleted_${email}` : `deleted_${n}_${email}`;
    const occupied = await Promise.all(
      dirs.map((d) =>
        fs.access(path.join(d, candidate)).then(() => true).catch(() => false)
      )
    );
    if (!occupied.some((x) => x)) return candidate;
    n++;
  }
}

/**
 * Like `renameUserFolderToDeleted` but uses an externally chosen target
 * name. Paired with `findFreeDeletedTargetAcross` so both calls land at
 * the same slot.
 */
export async function renameUserFolderToTarget(
  dir: string,
  email: string,
  target: string
): Promise<RenameResult> {
  const src = path.join(dir, email);
  const srcExists = await fs
    .access(src)
    .then(() => true)
    .catch(() => false);
  if (!srcExists) return { renamed: false, reason: "no_source" };
  await renameWithRetry(src, path.join(dir, target));
  return { renamed: true, target };
}
```

- [ ] **Step 4: Run tests**

Run: `npm test -- folder-rename`
Expected: all pre-existing tests + 4 new tests pass.

- [ ] **Step 5: Commit**

```bash
git add lib/admin/folder-rename.ts lib/admin/__tests__/folder-rename.test.ts
git commit -m "feat(admin/purge): paired rename helpers for two-root archives"
```

---

## Task 7: Hard-delete route — rename both roots

Wire the new helpers into the DELETE handler so that variants get renamed to the same slot as images. The handler still returns `200 + warning` on any partial rename failure.

**Files:**
- Modify: `app/api/admin/users/[id]/route.ts`
- Modify: `lib/admin/__tests__/purge-user.test.ts` (no, this still tests purgeUser only — route-level test is via smoke)

- [ ] **Step 1: Read the current DELETE handler**

Open `app/api/admin/users/[id]/route.ts` and locate the section that calls `findFreeDeletedTarget` followed by `renameUserFolderToDeleted`. That is the block to replace.

- [ ] **Step 2: Apply the edit**

Replace the rename block (the section that ran `findFreeDeletedTarget(imagesDir, email)` and then `renameUserFolderToDeleted(imagesDir, email)`) with the two-step paired flow.

Inside that block, change the imports at the top of the file to include the new helpers:

```ts
import {
  findFreeDeletedTargetAcross,
  renameUserFolderToTarget,
} from "@/lib/admin/folder-rename";
```

And drop the `findFreeDeletedTarget` / `renameUserFolderToDeleted` imports IF they are not used elsewhere in this file. (Search the file — `findFreeDeletedTarget` is used in the audit-pre-probe; replace it with `findFreeDeletedTargetAcross`.)

Replace the body of the rename section with:

```ts
const variantsDir = getHistoryVariantsDir();
// Predicted target for the audit log — probed against BOTH roots so it
// matches the slot we'll actually try to use.
const predictedTarget = await findFreeDeletedTargetAcross(
  [imagesDir, variantsDir],
  user.email
);

// Audit-before-rename ordering preserved (see post-ship doc §5.4).
writeAuthEvent(db, {
  event_type: "admin_user_purged",
  user_id: me.id,
  email: user.email,
  details: {
    target_id: targetId,
    target_email: user.email,
    generations_purged: result.generations_deleted,
    folder_rename_target: predictedTarget,
  },
});

let renameOutcome: { images: string; variants: string };
let renameWarning: string | null = null;
try {
  const imagesRes = await renameUserFolderToTarget(imagesDir, user.email, predictedTarget);
  const variantsRes = await renameUserFolderToTarget(variantsDir, user.email, predictedTarget);
  renameOutcome = {
    images: imagesRes.renamed ? "renamed" : imagesRes.reason,
    variants: variantsRes.renamed ? "renamed" : variantsRes.reason,
  };
} catch (err) {
  console.error("[admin purge] rename failed:", err);
  renameWarning = "rename_failed";
  renameOutcome = { images: "failed", variants: "failed" };
}
```

Then where the response is built, include `renameOutcome` (and the warning if set). The exact response shape change:

```ts
return NextResponse.json({
  ok: true,
  purged: {
    email: result.email,
    generations_deleted: result.generations_deleted,
    summary_csv_written: result.csv_written,
    folder_renamed_to: predictedTarget,
    rename_outcome: renameOutcome,
  },
  ...(renameWarning ? { warning: renameWarning } : {}),
});
```

Also import `getHistoryVariantsDir` at the top:

```ts
import { getDb, getHistoryImagesDir, getHistoryVariantsDir } from "@/lib/history-db";
```

(if `getHistoryImagesDir` is already imported there, just add `getHistoryVariantsDir`.)

- [ ] **Step 3: Type-check**

Run: `npx tsc --noEmit`
Expected: zero errors.

- [ ] **Step 4: Run the full suite — confirm no regressions**

Run: `npm test`
Expected: all green. (No new tests; the existing purge-user tests still test the pure `purgeUser` function, which is unchanged.)

- [ ] **Step 5: Manual smoke (deferred — do this when the rest of the feature is in place)**

Mark a smoke item on your follow-up list: soft-delete a test user with at least one generation, hard-delete them, verify both `history_images/deleted_*` AND `history_variants/deleted_*` directories exist with the same slot name.

- [ ] **Step 6: Commit**

```bash
git add app/api/admin/users/[id]/route.ts
git commit -m "feat(admin/purge): rename variants root alongside images on hard-delete"
```

---

## Task 8: POST /api/history splits writes between roots

Originals go to `HISTORY_IMAGES_DIR/<email>/<YYYY>/<MM>/`, variants to `HISTORY_VARIANTS_DIR/<email>/<YYYY>/<MM>/`. The multipart contract and response shape do not change.

**Files:**
- Modify: `app/api/history/route.ts` (POST handler, lines roughly 70-234)

- [ ] **Step 1: Read the existing POST handler**

Open `app/api/history/route.ts` and locate:
- Line 119-124 (relDir/absDir construction)
- Line 127-133 (filename + path construction)
- Line 138-148 (collision check)
- Line 154-158 (parallel writes)

- [ ] **Step 2: Apply the edit**

At the top, add to the import from `@/lib/history-db`:

```ts
import {
  getDb,
  saveGeneration,
  getGenerations,
  deleteGeneration,
  getHistoryImagesDir,
  getHistoryVariantsDir,
  getGenerationById,
} from "@/lib/history-db";
```

Replace the path-construction + mkdir block (around lines 119-124):

```ts
const now = new Date();
const yyyy = String(now.getUTCFullYear());
const mm = String(now.getUTCMonth() + 1).padStart(2, "0");
const relDir = `${user.email}/${yyyy}/${mm}`;
const imagesAbsDir = path.join(getHistoryImagesDir(), relDir);
const variantsAbsDir = path.join(getHistoryVariantsDir(), relDir);
await Promise.all([
  fs.mkdir(imagesAbsDir, { recursive: true }),
  fs.mkdir(variantsAbsDir, { recursive: true }),
]);
```

Replace the per-file path construction (around lines 127-133):

```ts
const ext = path.extname(original.name) || getExtFromMime(original.type);
const originalFilename = `${uuid}${ext}`;
const thumbFilename = `thumb_${uuid}.jpg`;
const midFilename = `mid_${uuid}.jpg`;

const originalPath = path.join(imagesAbsDir, originalFilename);
const thumbPath = path.join(variantsAbsDir, thumbFilename);
const midPath = path.join(variantsAbsDir, midFilename);
```

The collision check (138-148), parallel write (154-158), and rollback (160-163) are unchanged — they iterate over the three full paths regardless of which root each is in.

The DB write (171-186) is unchanged: `filepath` is `${relDir}/${originalFilename}` (still relative to `HISTORY_IMAGES_DIR`).

The response (228-234) is unchanged: URLs still use `/api/history/image/<email>/<yyyy>/<mm>/...`.

- [ ] **Step 3: Type-check**

Run: `npx tsc --noEmit`
Expected: zero errors.

- [ ] **Step 4: Run the full suite — no regressions**

Run: `npm test`
Expected: all green.

- [ ] **Step 5: Manual smoke**

Start the dev server, log in, generate one image. Verify:
- `HISTORY_DATA_DIR/history_images/<your-email>/<yyyy>/<mm>/<uuid>.<ext>` exists.
- `HISTORY_DATA_DIR/history_variants/<your-email>/<yyyy>/<mm>/thumb_<uuid>.jpg` exists.
- `HISTORY_DATA_DIR/history_variants/<your-email>/<yyyy>/<mm>/mid_<uuid>.jpg` exists.
- The original folder contains ONLY the original — no thumb_ / mid_.

If thumb/mid still appear in the original folder, the route did not pick up the new branch — re-check the path-construction edit.

- [ ] **Step 6: Commit**

```bash
git add app/api/history/route.ts
git commit -m "feat(history): write thumb_/mid_ to HISTORY_VARIANTS_DIR on POST"
```

---

## Task 9: GET /api/history/image — dispatch root by basename prefix

The history-image route reads from a single root. After this task it reads from the variants root when the basename starts with `thumb_` or `mid_`, otherwise from the images root.

**Files:**
- Modify: `app/api/history/image/[...path]/route.ts`

- [ ] **Step 1: Apply the edit**

Replace the import line:

```ts
import { getDb, getHistoryImagesDir } from "@/lib/history-db";
```

with:

```ts
import { getDb, getHistoryImagesDir, getHistoryVariantsDir } from "@/lib/history-db";
```

Inside the handler, after the existing path-segment validation (`for (const s of segs)`) and after the email-vs-user check, **before** computing `filePath`, add:

```ts
const filename = segs[segs.length - 1];
const isVariant = filename.startsWith("thumb_") || filename.startsWith("mid_");
const dir = isVariant ? getHistoryVariantsDir() : getHistoryImagesDir();
```

Replace the line:

```ts
const dir = getHistoryImagesDir();
```

with the above (i.e. delete the old single-root assignment — the new block computes `dir`). The rest of the file (path-traversal `startsWith` check, fs.readFile, content-type lookup) stays the same since they operate on the now-correct `dir`.

- [ ] **Step 2: Type-check**

Run: `npx tsc --noEmit`
Expected: zero errors.

- [ ] **Step 3: Manual smoke**

With Task 8 already applied and a fresh generation made:

In the browser, open DevTools → Network. Reload the history. You should see three image requests for the new entry: one to `/api/history/image/<email>/<yyyy>/<mm>/<uuid>.<ext>` (200 from images dir) and two to the `thumb_*` / `mid_*` URLs (200 from variants dir). Check both responses are 200 with image content-types.

Bonus check: try a traversal — `curl http://localhost:3000/api/history/image/..%2F..%2Fetc%2Fpasswd` should return 400 or 401. The basename-prefix dispatch did not weaken the path-traversal guard.

- [ ] **Step 4: Commit**

```bash
git add app/api/history/image/[...path]/route.ts
git commit -m "feat(history/image): dispatch route by thumb_/mid_ prefix"
```

---

## Task 10: SSE event types for rebuild progress

Two new event variants. Server consumers will be added in later tasks.

**Files:**
- Modify: `lib/sse-broadcast.ts`

- [ ] **Step 1: Apply the edit**

In `lib/sse-broadcast.ts`, locate the `SseEvent` discriminated union (around line 20-40). Append two variants right before the final `;`:

```ts
  // Admin-only: progress ticks during a variants rebuild job. Throttled
  // server-side (~1/sec) so receivers don't drown in tiny updates.
  | { type: "admin.variants_rebuild_progress";
      data: { jobId: string; done: number; total: number; currentEmail?: string; errors: number } }
  // Admin-only: emitted once when a job transitions to finished=true.
  | { type: "admin.variants_rebuild_done";
      data: { jobId: string; total: number; errors: number } }
```

- [ ] **Step 2: Type-check**

Run: `npx tsc --noEmit`
Expected: zero errors. (No callers yet; this is just adding new union members.)

- [ ] **Step 3: Commit**

```bash
git add lib/sse-broadcast.ts
git commit -m "feat(sse): add admin.variants_rebuild_progress and ..._done events"
```

---

## Task 11: In-memory job registry

Single-active-job invariant; helpers to start/append-progress/finish; getter by jobId.

**Files:**
- Create: `lib/admin/variants-jobs.ts`
- Test: `lib/admin/__tests__/variants-jobs.test.ts`

- [ ] **Step 1: Write the failing test**

Create `lib/admin/__tests__/variants-jobs.test.ts`:

```ts
/** @vitest-environment node */
import { describe, it, expect, beforeEach } from "vitest";
import {
  tryStartJob,
  appendError,
  bumpDone,
  finishJob,
  getJob,
  getActiveJob,
  _resetForTests,
} from "../variants-jobs";

beforeEach(() => {
  _resetForTests();
});

describe("variants-jobs", () => {
  it("tryStartJob returns a fresh jobId when nothing is running", () => {
    const r = tryStartJob({ scope: "user", userId: 5, total: 10 });
    expect(r.started).toBe(true);
    if (r.started) {
      expect(typeof r.jobId).toBe("string");
      expect(r.jobId.length).toBeGreaterThan(8);
    }
  });

  it("tryStartJob folds — returns existing job when one is running", () => {
    const r1 = tryStartJob({ scope: "user", userId: 5, total: 10 });
    expect(r1.started).toBe(true);
    const r2 = tryStartJob({ scope: "all", total: 100 });
    expect(r2.started).toBe(false);
    if (r1.started && !r2.started) {
      expect(r2.existingJobId).toBe(r1.jobId);
    }
  });

  it("after finishJob, a new start succeeds", () => {
    const r1 = tryStartJob({ scope: "user", userId: 5, total: 10 });
    if (!r1.started) throw new Error("expected started");
    finishJob(r1.jobId);
    const r2 = tryStartJob({ scope: "all", total: 100 });
    expect(r2.started).toBe(true);
  });

  it("bumpDone increments and getJob reflects state", () => {
    const r = tryStartJob({ scope: "user", userId: 5, total: 3 });
    if (!r.started) throw new Error("expected started");
    bumpDone(r.jobId);
    bumpDone(r.jobId);
    const job = getJob(r.jobId);
    expect(job?.done).toBe(2);
    expect(job?.total).toBe(3);
    expect(job?.finished).toBe(false);
  });

  it("appendError caps at 100 entries", () => {
    const r = tryStartJob({ scope: "all", total: 200 });
    if (!r.started) throw new Error("expected started");
    for (let i = 0; i < 150; i++) {
      appendError(r.jobId, { generationId: i, reason: "decode_failed" });
    }
    expect(getJob(r.jobId)?.errors.length).toBe(100);
  });

  it("getActiveJob returns the running job or null", () => {
    expect(getActiveJob()).toBeNull();
    const r = tryStartJob({ scope: "user", userId: 5, total: 1 });
    if (!r.started) throw new Error("expected started");
    expect(getActiveJob()?.jobId).toBe(r.jobId);
    finishJob(r.jobId);
    expect(getActiveJob()).toBeNull();
  });
});
```

- [ ] **Step 2: Run failing test**

Run: `npm test -- variants-jobs`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the module**

Create `lib/admin/variants-jobs.ts`:

```ts
/**
 * In-memory registry for variant-rebuild jobs.
 *
 * Single-active-job invariant: while one job is running, additional
 * tryStartJob calls fold and return the existing jobId. The operator
 * waits for it to finish, then starts the next one.
 *
 * State is process-local and ephemeral. On process restart, in-flight
 * jobs are forgotten (admin re-clicks). The trade-off: simpler than
 * persisted job state, acceptable because rebuild is idempotent and rare.
 *
 * Stashed on globalThis for Next.js HMR / hot-reload survival (same
 * pattern as lib/sse-broadcast.ts).
 */

import { randomUUID } from "node:crypto";

export type JobScope = "user" | "all";

export interface JobError {
  generationId: number;
  reason: string;
  error?: string;
}

export interface JobState {
  jobId: string;
  scope: JobScope;
  userId?: number;
  startedAt: string;
  total: number;
  done: number;
  currentEmail?: string;
  errors: JobError[];
  finished: boolean;
  finishedAt?: string;
}

interface Registry {
  byId: Map<string, JobState>;
  activeId: string | null;
}

const ERROR_CAP = 100;

const g = globalThis as unknown as { __variantsJobs?: Registry };
const registry: Registry =
  g.__variantsJobs ?? { byId: new Map(), activeId: null };
g.__variantsJobs = registry;

export type StartResult =
  | { started: true; jobId: string }
  | { started: false; existingJobId: string };

export function tryStartJob(input: {
  scope: JobScope;
  userId?: number;
  total: number;
}): StartResult {
  if (registry.activeId) {
    return { started: false, existingJobId: registry.activeId };
  }
  const jobId = randomUUID();
  const state: JobState = {
    jobId,
    scope: input.scope,
    userId: input.userId,
    startedAt: new Date().toISOString(),
    total: input.total,
    done: 0,
    errors: [],
    finished: false,
  };
  registry.byId.set(jobId, state);
  registry.activeId = jobId;
  return { started: true, jobId };
}

export function bumpDone(jobId: string, currentEmail?: string): void {
  const s = registry.byId.get(jobId);
  if (!s) return;
  s.done += 1;
  if (currentEmail !== undefined) s.currentEmail = currentEmail;
}

export function appendError(jobId: string, err: JobError): void {
  const s = registry.byId.get(jobId);
  if (!s) return;
  if (s.errors.length >= ERROR_CAP) return;
  s.errors.push(err);
}

export function finishJob(jobId: string): void {
  const s = registry.byId.get(jobId);
  if (!s) return;
  s.finished = true;
  s.finishedAt = new Date().toISOString();
  if (registry.activeId === jobId) registry.activeId = null;
}

export function getJob(jobId: string): JobState | null {
  return registry.byId.get(jobId) ?? null;
}

export function getActiveJob(): JobState | null {
  if (!registry.activeId) return null;
  return registry.byId.get(registry.activeId) ?? null;
}

/** Test-only — resets the registry between tests. */
export function _resetForTests(): void {
  registry.byId.clear();
  registry.activeId = null;
}
```

- [ ] **Step 4: Run tests**

Run: `npm test -- variants-jobs`
Expected: 6 tests pass.

- [ ] **Step 5: Commit**

```bash
git add lib/admin/variants-jobs.ts lib/admin/__tests__/variants-jobs.test.ts
git commit -m "feat(admin/variants): in-memory job registry with single-active invariant"
```

---

## Task 12: Legacy-purge module (filesystem walker)

Removes `thumb_*.jpg` / `mid_*.jpg` from `HISTORY_IMAGES_DIR/<email>/<YYYY>/<MM>/` only. Originals and any other file type are untouched.

**Files:**
- Create: `lib/admin/legacy-purge.ts`
- Test: `lib/admin/__tests__/legacy-purge.test.ts`

- [ ] **Step 1: Write failing tests**

Create `lib/admin/__tests__/legacy-purge.test.ts`:

```ts
/** @vitest-environment node */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { scanLegacyVariants, purgeLegacyVariants } from "../legacy-purge";

let root: string;

const VARIANT_RE = /^(thumb|mid)_[0-9a-f-]{36}\.jpg$/;

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
```

- [ ] **Step 2: Run failing test**

Run: `npm test -- legacy-purge`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement the walker**

Create `lib/admin/legacy-purge.ts`:

```ts
/**
 * One-time tool: remove thumb_<uuid>.jpg / mid_<uuid>.jpg files that
 * predate the variants-separation work, leaving originals untouched.
 *
 * Walks HISTORY_IMAGES_DIR/<email>/<YYYY>/<MM>/* and matches basenames
 * against ^(thumb|mid)_<UUID>.jpg$. Anything that is not an email-shaped
 * top-level entry is skipped — this protects deleted_*/ cold archives.
 */

import { promises as fs } from "node:fs";
import path from "node:path";

const VARIANT_RE = /^(thumb|mid)_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.jpg$/i;
const YYYY_RE = /^\d{4}$/;
const MM_RE = /^\d{2}$/;

function looksLikeEmail(name: string): boolean {
  // Cheap, conservative: must contain "@" and a dot, no slashes.
  return name.includes("@") && name.includes(".") && !name.startsWith("deleted_");
}

export interface ScanResult {
  count: number;
  dirs: string[];
}

export async function scanLegacyVariants(imagesDir: string): Promise<ScanResult> {
  const dirsSet = new Set<string>();
  let count = 0;
  await walk(imagesDir, async (absPath, relPath) => {
    count++;
    dirsSet.add(path.dirname(relPath));
  });
  return { count, dirs: Array.from(dirsSet).sort() };
}

export interface PurgeResult {
  deleted: number;
}

export async function purgeLegacyVariants(imagesDir: string): Promise<PurgeResult> {
  let deleted = 0;
  await walk(imagesDir, async (absPath) => {
    try {
      await fs.unlink(absPath);
      deleted++;
    } catch {
      // ignore — file vanished between walk and unlink
    }
  });
  return { deleted };
}

async function walk(
  imagesDir: string,
  onMatch: (absPath: string, relPath: string) => Promise<void>
): Promise<void> {
  let owners: string[];
  try {
    owners = await fs.readdir(imagesDir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
    throw err;
  }
  for (const owner of owners) {
    if (!looksLikeEmail(owner)) continue;
    const yearDir = path.join(imagesDir, owner);
    let years: string[];
    try { years = await fs.readdir(yearDir); } catch { continue; }
    for (const yyyy of years) {
      if (!YYYY_RE.test(yyyy)) continue;
      const monthDir = path.join(yearDir, yyyy);
      let months: string[];
      try { months = await fs.readdir(monthDir); } catch { continue; }
      for (const mm of months) {
        if (!MM_RE.test(mm)) continue;
        const leafDir = path.join(monthDir, mm);
        let files: string[];
        try { files = await fs.readdir(leafDir); } catch { continue; }
        for (const f of files) {
          if (!VARIANT_RE.test(f)) continue;
          const abs = path.join(leafDir, f);
          const rel = path.join(owner, yyyy, mm, f).replace(/\\/g, "/");
          await onMatch(abs, rel);
        }
      }
    }
  }
}
```

- [ ] **Step 4: Run tests**

Run: `npm test -- legacy-purge`
Expected: 5 tests pass.

- [ ] **Step 5: Commit**

```bash
git add lib/admin/legacy-purge.ts lib/admin/__tests__/legacy-purge.test.ts
git commit -m "feat(admin/variants): scan + purge legacy thumb_/mid_ from images dir"
```

---

## Task 13: Admin endpoints — stats, users, legacy-scan, legacy-purge

Four GET / POST endpoints, all admin-gated. Thin wrappers over the modules built so far.

**Files:**
- Create: `app/api/admin/variants/stats/route.ts`
- Create: `app/api/admin/variants/users/route.ts`
- Create: `app/api/admin/variants/legacy-scan/route.ts`
- Create: `app/api/admin/variants/legacy-purge/route.ts`

- [ ] **Step 1: Locate an existing admin route to copy the auth pattern from**

Run: `npm test --silent -- --reporter=verbose 2>&1 | head -1; ls app/api/admin/`

The existing `app/api/admin/users/[id]/route.ts` is your template for "validate admin, run logic, respond". Copy its `requireAdmin` (or `getCurrentUser(...).role === 'admin'`) check verbatim.

- [ ] **Step 2: Create `stats/route.ts`**

Create `app/api/admin/variants/stats/route.ts`:

```ts
import { type NextRequest, NextResponse } from "next/server";
import { promises as fs } from "node:fs";
import path from "node:path";
import {
  getDb,
  getHistoryImagesDir,
  getHistoryVariantsDir,
} from "@/lib/history-db";
import { getCurrentUser } from "@/lib/auth/current-user";
import { SESSION_COOKIE_NAME } from "@/lib/auth/cookie-name";

export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  const sess = req.cookies.get(SESSION_COOKIE_NAME)?.value ?? null;
  const me = getCurrentUser(getDb(), sess);
  if (!me || me.role !== "admin") {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const db = getDb();
  const originals = (db.prepare(
    `SELECT COUNT(*) AS n FROM generation_outputs WHERE content_type LIKE 'image/%'`
  ).get() as { n: number }).n;

  let thumbs = 0, mids = 0;
  await countByPrefix(getHistoryVariantsDir(), (basename) => {
    if (basename.startsWith("thumb_")) thumbs++;
    else if (basename.startsWith("mid_")) mids++;
  });

  return NextResponse.json({
    originals_in_db: originals,
    variants_on_disk_thumb: thumbs,
    variants_on_disk_mid: mids,
    variants_dir: getHistoryVariantsDir(),
    images_dir: getHistoryImagesDir(),
  });
}

async function countByPrefix(
  root: string,
  onMatch: (basename: string) => void
): Promise<void> {
  let owners: string[];
  try { owners = await fs.readdir(root); } catch { return; }
  for (const owner of owners) {
    if (owner.startsWith("deleted_")) continue;
    const ownerDir = path.join(root, owner);
    let years: string[]; try { years = await fs.readdir(ownerDir); } catch { continue; }
    for (const y of years) {
      const yd = path.join(ownerDir, y);
      let months: string[]; try { months = await fs.readdir(yd); } catch { continue; }
      for (const m of months) {
        const md = path.join(yd, m);
        let files: string[]; try { files = await fs.readdir(md); } catch { continue; }
        for (const f of files) onMatch(f);
      }
    }
  }
}
```

- [ ] **Step 3: Create `users/route.ts`**

Create `app/api/admin/variants/users/route.ts`:

```ts
import { type NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/history-db";
import { getCurrentUser } from "@/lib/auth/current-user";
import { SESSION_COOKIE_NAME } from "@/lib/auth/cookie-name";

export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  const sess = req.cookies.get(SESSION_COOKIE_NAME)?.value ?? null;
  const me = getCurrentUser(getDb(), sess);
  if (!me || me.role !== "admin") {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const db = getDb();
  const rows = db.prepare(`
    SELECT u.id AS user_id, u.email, COUNT(DISTINCT g.id) AS image_generation_count
    FROM users u
    JOIN generations g ON g.user_id = u.id
    JOIN generation_outputs o ON o.generation_id = g.id
    WHERE u.status = 'active'
      AND g.status IN ('completed','deleted')
      AND o.content_type LIKE 'image/%'
    GROUP BY u.id, u.email
    HAVING image_generation_count > 0
    ORDER BY image_generation_count DESC, u.email ASC
  `).all() as Array<{ user_id: number; email: string; image_generation_count: number }>;

  return NextResponse.json(rows);
}
```

- [ ] **Step 4: Create `legacy-scan/route.ts`**

Create `app/api/admin/variants/legacy-scan/route.ts`:

```ts
import { type NextRequest, NextResponse } from "next/server";
import { getDb, getHistoryImagesDir } from "@/lib/history-db";
import { getCurrentUser } from "@/lib/auth/current-user";
import { SESSION_COOKIE_NAME } from "@/lib/auth/cookie-name";
import { scanLegacyVariants } from "@/lib/admin/legacy-purge";

export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  const sess = req.cookies.get(SESSION_COOKIE_NAME)?.value ?? null;
  const me = getCurrentUser(getDb(), sess);
  if (!me || me.role !== "admin") {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const res = await scanLegacyVariants(getHistoryImagesDir());
  return NextResponse.json(res);
}
```

- [ ] **Step 5: Create `legacy-purge/route.ts`**

Create `app/api/admin/variants/legacy-purge/route.ts`:

```ts
import { type NextRequest, NextResponse } from "next/server";
import { getDb, getHistoryImagesDir } from "@/lib/history-db";
import { getCurrentUser } from "@/lib/auth/current-user";
import { SESSION_COOKIE_NAME } from "@/lib/auth/cookie-name";
import { purgeLegacyVariants } from "@/lib/admin/legacy-purge";
import { writeAuthEvent } from "@/lib/auth/audit";

export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  const sess = req.cookies.get(SESSION_COOKIE_NAME)?.value ?? null;
  const me = getCurrentUser(getDb(), sess);
  if (!me || me.role !== "admin") {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const res = await purgeLegacyVariants(getHistoryImagesDir());
  // Audit so the operation appears in the same paper trail as purges.
  writeAuthEvent(getDb(), {
    event_type: "admin_user_purged",  // reuse generic admin op type; see follow-up below
    user_id: me.id,
    email: me.email,
    details: { op: "variants_legacy_purge", deleted: res.deleted },
  });
  return NextResponse.json(res);
}
```

NOTE: If `writeAuthEvent`'s union of `event_type` does not currently accept a free-form op tag, leave the audit call out for v1 and add a follow-up. Do NOT add a new `event_type` enum value in this task — that is a cross-cutting auth-events change and belongs to its own task. (Plan reviewer should confirm whether `writeAuthEvent` accepts an opaque `details.op` discriminator in addition to its typed `event_type` — if so, the call above is OK; if not, comment the audit line out and add it to follow-ups.)

- [ ] **Step 6: Type-check**

Run: `npx tsc --noEmit`
Expected: zero errors.

- [ ] **Step 7: Manual smoke**

Start the dev server. As an admin user:
```
curl -b "session=..." http://localhost:3000/api/admin/variants/stats
curl -b "session=..." http://localhost:3000/api/admin/variants/users
curl -b "session=..." http://localhost:3000/api/admin/variants/legacy-scan
```
Expect 200 with shape matching the route definitions. As a non-admin, expect 403.

- [ ] **Step 8: Commit**

```bash
git add app/api/admin/variants/
git commit -m "feat(admin/variants): stats/users/legacy-scan/legacy-purge endpoints"
```

---

## Task 14: Rebuild endpoints + job runner

The rebuild orchestrator that ties together `variants-builder`, `variants-jobs`, and the SSE broadcast.

**Files:**
- Create: `lib/admin/variants-runner.ts` (orchestration so the route handlers stay thin)
- Create: `lib/admin/__tests__/variants-runner.test.ts`
- Create: `app/api/admin/variants/rebuild/route.ts`
- Create: `app/api/admin/variants/rebuild-all/route.ts`
- Create: `app/api/admin/variants/job/[jobId]/route.ts`

- [ ] **Step 1: Write failing tests for the runner**

Create `lib/admin/__tests__/variants-runner.test.ts`:

```ts
/** @vitest-environment node */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import sharp from "sharp";
import { initSchema, seedModels } from "@/lib/history-db";
import { runRebuild } from "../variants-runner";
import {
  tryStartJob,
  getJob,
  _resetForTests,
} from "../variants-jobs";

let db: Database.Database;
let imagesDir: string;
let variantsDir: string;
let userId: number;

async function makePng(w: number, h: number) {
  return sharp({ create: { width: w, height: h, channels: 3, background: { r: 0, g: 0, b: 0 } } })
    .png().toBuffer();
}

async function placeOriginal(rel: string, buf: Buffer) {
  const abs = path.join(imagesDir, rel);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, buf);
}

function insertGen(filepath: string): number {
  const genId = db.prepare(
    `INSERT INTO generations (user_id, status) VALUES (?, 'completed')`
  ).run(userId).lastInsertRowid as number;
  db.prepare(
    `INSERT INTO generation_outputs (generation_id, filename, filepath, content_type)
     VALUES (?, 'a.png', ?, 'image/png')`
  ).run(genId, filepath);
  return genId;
}

beforeEach(async () => {
  _resetForTests();
  db = new Database(":memory:");
  initSchema(db);
  seedModels(db);
  imagesDir = await fs.mkdtemp(path.join(os.tmpdir(), "vr-img-"));
  variantsDir = await fs.mkdtemp(path.join(os.tmpdir(), "vr-var-"));
  userId = db.prepare(`INSERT INTO users (email, status) VALUES ('alice@x.com', 'active')`)
    .run().lastInsertRowid as number;
});
afterEach(async () => {
  await fs.rm(imagesDir, { recursive: true, force: true });
  await fs.rm(variantsDir, { recursive: true, force: true });
});

describe("runRebuild", () => {
  it("processes all selected generations and finishes the job", async () => {
    const buf = await makePng(800, 600);
    await placeOriginal("alice@x.com/2026/05/a.png", buf);
    await placeOriginal("alice@x.com/2026/05/b.png", buf);
    insertGen("alice@x.com/2026/05/a.png");
    insertGen("alice@x.com/2026/05/b.png");

    const start = tryStartJob({ scope: "user", userId, total: 2 });
    if (!start.started) throw new Error("expected started");

    await runRebuild(db, start.jobId, {
      scope: "user",
      userId,
      imagesDir,
      variantsDir,
      broadcast: () => {},
    });

    const job = getJob(start.jobId);
    expect(job?.finished).toBe(true);
    expect(job?.done).toBe(2);
    expect(job?.errors.length).toBe(0);

    await expect(fs.access(path.join(variantsDir, "alice@x.com/2026/05/thumb_a.jpg"))).resolves.toBeUndefined();
    await expect(fs.access(path.join(variantsDir, "alice@x.com/2026/05/thumb_b.jpg"))).resolves.toBeUndefined();
  });

  it("records per-row errors but continues", async () => {
    insertGen("alice@x.com/2026/05/missing.png");  // no file on disk
    const start = tryStartJob({ scope: "user", userId, total: 1 });
    if (!start.started) throw new Error("expected started");

    await runRebuild(db, start.jobId, {
      scope: "user",
      userId,
      imagesDir,
      variantsDir,
      broadcast: () => {},
    });
    const job = getJob(start.jobId);
    expect(job?.finished).toBe(true);
    expect(job?.errors.length).toBe(1);
    expect(job?.errors[0].reason).toBe("original_missing");
  });

  it("scope=all processes every active user with image generations", async () => {
    const bobId = db.prepare(`INSERT INTO users (email, status) VALUES ('bob@y.com', 'active')`)
      .run().lastInsertRowid as number;
    const buf = await makePng(200, 200);
    await placeOriginal("alice@x.com/2026/05/a.png", buf);
    await placeOriginal("bob@y.com/2026/05/b.png", buf);
    insertGen("alice@x.com/2026/05/a.png");
    db.prepare(
      `INSERT INTO generations (user_id, status) VALUES (?, 'completed')`
    ).run(bobId);
    const bobGen = db.prepare(`SELECT last_insert_rowid() AS id`).get() as { id: number };
    db.prepare(
      `INSERT INTO generation_outputs (generation_id, filename, filepath, content_type)
       VALUES (?, 'b.png', 'bob@y.com/2026/05/b.png', 'image/png')`
    ).run(bobGen.id);

    const start = tryStartJob({ scope: "all", total: 2 });
    if (!start.started) throw new Error("expected started");

    await runRebuild(db, start.jobId, {
      scope: "all",
      imagesDir,
      variantsDir,
      broadcast: () => {},
    });
    expect(getJob(start.jobId)?.finished).toBe(true);
    expect(getJob(start.jobId)?.done).toBe(2);
  });
});
```

- [ ] **Step 2: Run failing test**

Run: `npm test -- variants-runner`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement the runner**

Create `lib/admin/variants-runner.ts`:

```ts
/**
 * Orchestrates a rebuild job: enumerates the target generations, runs
 * buildVariantsForGeneration with bounded concurrency, and updates the
 * job state + broadcasts SSE progress.
 *
 * Stays out of HTTP handler concerns — pure server-side function.
 */

import type Database from "better-sqlite3";
import { runPool } from "@/lib/image-optimize";
import { buildVariantsForGeneration } from "@/lib/variants-builder";
import {
  appendError,
  bumpDone,
  finishJob,
  getJob,
} from "@/lib/admin/variants-jobs";

interface Row {
  id: number;
  email: string;
}

export interface RebuildOpts {
  scope: "user" | "all";
  userId?: number;
  imagesDir: string;
  variantsDir: string;
  /** SSE fan-out; runner stays decoupled from broadcast plumbing. */
  broadcast: (event: {
    type: "admin.variants_rebuild_progress" | "admin.variants_rebuild_done";
    data: any;
  }) => void;
  /** Tunable; default 2 — sharp/libvips is already multi-threaded. */
  concurrency?: number;
}

const PROGRESS_TICK_MS = 1000;

export async function runRebuild(
  db: Database.Database,
  jobId: string,
  opts: RebuildOpts
): Promise<void> {
  const rows = listGenerations(db, opts);
  // Update total to the actual count in case the caller over- or
  // under-estimated when tryStartJob was called.
  const job = getJob(jobId);
  if (job) job.total = rows.length;

  let lastTick = 0;
  const tick = (currentEmail?: string) => {
    const now = Date.now();
    if (now - lastTick < PROGRESS_TICK_MS) return;
    lastTick = now;
    const s = getJob(jobId);
    if (!s) return;
    opts.broadcast({
      type: "admin.variants_rebuild_progress",
      data: {
        jobId,
        done: s.done,
        total: s.total,
        currentEmail,
        errors: s.errors.length,
      },
    });
  };

  await runPool(rows, opts.concurrency ?? 2, async (row) => {
    const res = await buildVariantsForGeneration(db, row.id, {
      imagesDir: opts.imagesDir,
      variantsDir: opts.variantsDir,
    });
    if (!res.ok) {
      appendError(jobId, { generationId: row.id, reason: res.reason, error: res.error });
    }
    bumpDone(jobId, row.email);
    tick(row.email);
    return null;
  });

  finishJob(jobId);
  const final = getJob(jobId);
  opts.broadcast({
    type: "admin.variants_rebuild_done",
    data: { jobId, total: final?.total ?? 0, errors: final?.errors.length ?? 0 },
  });
}

function listGenerations(db: Database.Database, opts: RebuildOpts): Row[] {
  const base = `
    SELECT DISTINCT g.id, u.email
    FROM generations g
    JOIN users u ON u.id = g.user_id
    JOIN generation_outputs o ON o.generation_id = g.id
    WHERE g.status IN ('completed','deleted')
      AND o.content_type LIKE 'image/%'
      AND u.status = 'active'
  `;
  if (opts.scope === "user") {
    return db.prepare(`${base} AND g.user_id = ? ORDER BY g.id ASC`)
      .all(opts.userId) as Row[];
  }
  return db.prepare(`${base} ORDER BY g.id ASC`).all() as Row[];
}
```

- [ ] **Step 4: Run tests**

Run: `npm test -- variants-runner`
Expected: 3 tests pass.

- [ ] **Step 5: Create `rebuild/route.ts`**

Create `app/api/admin/variants/rebuild/route.ts`:

```ts
import { type NextRequest, NextResponse } from "next/server";
import {
  getDb,
  getHistoryImagesDir,
  getHistoryVariantsDir,
} from "@/lib/history-db";
import { getCurrentUser } from "@/lib/auth/current-user";
import { SESSION_COOKIE_NAME } from "@/lib/auth/cookie-name";
import { tryStartJob, getActiveJob } from "@/lib/admin/variants-jobs";
import { runRebuild } from "@/lib/admin/variants-runner";
import { broadcastToUserId } from "@/lib/sse-broadcast";

export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  const sess = req.cookies.get(SESSION_COOKIE_NAME)?.value ?? null;
  const me = getCurrentUser(getDb(), sess);
  if (!me || me.role !== "admin") {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const body = await req.json().catch(() => ({}));
  const userId = typeof body.userId === "number" ? body.userId : NaN;
  if (!Number.isFinite(userId)) {
    return NextResponse.json({ error: "userId required" }, { status: 400 });
  }
  const db = getDb();
  const total = (db.prepare(`
    SELECT COUNT(DISTINCT g.id) AS n
    FROM generations g
    JOIN generation_outputs o ON o.generation_id = g.id
    WHERE g.user_id = ? AND g.status IN ('completed','deleted')
      AND o.content_type LIKE 'image/%'
  `).get(userId) as { n: number }).n;

  const start = tryStartJob({ scope: "user", userId, total });
  if (!start.started) {
    const active = getActiveJob();
    return NextResponse.json({
      jobId: start.existingJobId,
      folded: true,
      activeScope: active?.scope,
    });
  }

  const adminIds = (db.prepare(
    `SELECT id FROM users WHERE role='admin' AND status='active'`
  ).all() as { id: number }[]).map((a) => a.id);
  const broadcast = (ev: any) => {
    for (const id of adminIds) {
      try { broadcastToUserId(id, ev); } catch { /* ignored */ }
    }
  };

  // Fire and forget — runRebuild updates the in-memory job; clients poll
  // via /job/:jobId or subscribe to SSE.
  setImmediate(() => {
    runRebuild(db, start.jobId, {
      scope: "user",
      userId,
      imagesDir: getHistoryImagesDir(),
      variantsDir: getHistoryVariantsDir(),
      broadcast,
    }).catch((err) => {
      console.error("[variants rebuild] runner crashed:", err);
    });
  });
  return NextResponse.json({ jobId: start.jobId, folded: false });
}
```

- [ ] **Step 6: Create `rebuild-all/route.ts`**

Create `app/api/admin/variants/rebuild-all/route.ts`:

```ts
import { type NextRequest, NextResponse } from "next/server";
import {
  getDb,
  getHistoryImagesDir,
  getHistoryVariantsDir,
} from "@/lib/history-db";
import { getCurrentUser } from "@/lib/auth/current-user";
import { SESSION_COOKIE_NAME } from "@/lib/auth/cookie-name";
import { tryStartJob, getActiveJob } from "@/lib/admin/variants-jobs";
import { runRebuild } from "@/lib/admin/variants-runner";
import { broadcastToUserId } from "@/lib/sse-broadcast";

export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  const sess = req.cookies.get(SESSION_COOKIE_NAME)?.value ?? null;
  const me = getCurrentUser(getDb(), sess);
  if (!me || me.role !== "admin") {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const db = getDb();
  const total = (db.prepare(`
    SELECT COUNT(DISTINCT g.id) AS n
    FROM generations g
    JOIN users u ON u.id = g.user_id
    JOIN generation_outputs o ON o.generation_id = g.id
    WHERE g.status IN ('completed','deleted')
      AND o.content_type LIKE 'image/%'
      AND u.status = 'active'
  `).get() as { n: number }).n;

  const start = tryStartJob({ scope: "all", total });
  if (!start.started) {
    const active = getActiveJob();
    return NextResponse.json({
      jobId: start.existingJobId,
      folded: true,
      activeScope: active?.scope,
    });
  }

  const adminIds = (db.prepare(
    `SELECT id FROM users WHERE role='admin' AND status='active'`
  ).all() as { id: number }[]).map((a) => a.id);
  const broadcast = (ev: any) => {
    for (const id of adminIds) {
      try { broadcastToUserId(id, ev); } catch { /* ignored */ }
    }
  };

  setImmediate(() => {
    runRebuild(db, start.jobId, {
      scope: "all",
      imagesDir: getHistoryImagesDir(),
      variantsDir: getHistoryVariantsDir(),
      broadcast,
    }).catch((err) => {
      console.error("[variants rebuild-all] runner crashed:", err);
    });
  });
  return NextResponse.json({ jobId: start.jobId, folded: false });
}
```

- [ ] **Step 7: Create `job/[jobId]/route.ts`**

Create `app/api/admin/variants/job/[jobId]/route.ts`:

```ts
import { type NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/history-db";
import { getCurrentUser } from "@/lib/auth/current-user";
import { SESSION_COOKIE_NAME } from "@/lib/auth/cookie-name";
import { getJob } from "@/lib/admin/variants-jobs";

export const runtime = "nodejs";

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ jobId: string }> }
) {
  const sess = req.cookies.get(SESSION_COOKIE_NAME)?.value ?? null;
  const me = getCurrentUser(getDb(), sess);
  if (!me || me.role !== "admin") {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const { jobId } = await params;
  const job = getJob(jobId);
  if (!job) return NextResponse.json({ error: "not_found" }, { status: 404 });
  return NextResponse.json(job);
}
```

- [ ] **Step 8: Type-check and run tests**

```bash
npx tsc --noEmit
npm test
```

Expected: zero TS errors, all tests pass.

- [ ] **Step 9: Manual smoke**

In admin session via curl (replace cookie):
```
curl -X POST -b "session=..." -H "Content-Type: application/json" \
  -d '{"userId":1}' http://localhost:3000/api/admin/variants/rebuild
curl -b "session=..." http://localhost:3000/api/admin/variants/job/<jobId>
```
Expect first call returns `{ jobId, folded: false }`. Second-call polling shows `done` rising, eventually `finished: true`. Verify thumb_/mid_ files appear under `HISTORY_VARIANTS_DIR/<email>/<yyyy>/<mm>/`.

- [ ] **Step 10: Commit**

```bash
git add lib/admin/variants-runner.ts lib/admin/__tests__/variants-runner.test.ts app/api/admin/variants/
git commit -m "feat(admin/variants): rebuild + rebuild-all + job-poll endpoints"
```

---

## Task 15: Admin "Превью / History state" tab UI

A single client component that surfaces stats, legacy-purge, and rebuild controls. Per project convention, UI components carry no unit tests; manual smoke covers them.

**Files:**
- Create: `components/admin/preview-state-tab.tsx`
- Modify: the admin tab registration component (the file that switches between Users/Models/etc tabs — locate it in `components/admin/`)

- [ ] **Step 1: Locate the admin tab registration**

Run: `grep -rln "users-tab\|UsersTab" components/admin/ --include="*.tsx"` to find which parent file imports and renders the Users tab. Open it and note the pattern: a `<Tabs>` (Radix or shadcn) with `<TabsList>` triggers and `<TabsContent>` panels.

- [ ] **Step 2: Create the tab component**

Create `components/admin/preview-state-tab.tsx`:

```tsx
"use client";

import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";

interface Stats {
  originals_in_db: number;
  variants_on_disk_thumb: number;
  variants_on_disk_mid: number;
  variants_dir: string;
  images_dir: string;
}

interface UserRow {
  user_id: number;
  email: string;
  image_generation_count: number;
}

interface JobState {
  jobId: string;
  scope: "user" | "all";
  total: number;
  done: number;
  errors: Array<{ generationId: number; reason: string; error?: string }>;
  finished: boolean;
  currentEmail?: string;
}

export function PreviewStateTab() {
  const [stats, setStats] = useState<Stats | null>(null);
  const [users, setUsers] = useState<UserRow[]>([]);
  const [scan, setScan] = useState<{ count: number; dirs: string[] } | null>(null);
  const [scanning, setScanning] = useState(false);
  const [purgeConfirm, setPurgeConfirm] = useState("");
  const [purging, setPurging] = useState(false);
  const [activeJob, setActiveJob] = useState<JobState | null>(null);
  const [filter, setFilter] = useState("");

  const reloadStats = useCallback(async () => {
    try {
      const r = await fetch("/api/admin/variants/stats");
      if (r.ok) setStats(await r.json());
    } catch { /* ignore */ }
  }, []);

  const reloadUsers = useCallback(async () => {
    try {
      const r = await fetch("/api/admin/variants/users");
      if (r.ok) setUsers(await r.json());
    } catch { /* ignore */ }
  }, []);

  useEffect(() => {
    reloadStats();
    reloadUsers();
  }, [reloadStats, reloadUsers]);

  // SSE — receive progress and completion events.
  useEffect(() => {
    const es = new EventSource("/api/history/stream");
    const onProgress = (e: MessageEvent) => {
      try {
        const data = JSON.parse(e.data);
        setActiveJob((prev) => prev && prev.jobId === data.jobId
          ? { ...prev, done: data.done, total: data.total, currentEmail: data.currentEmail, errors: prev.errors }
          : prev);
      } catch { /* ignore */ }
    };
    const onDone = (e: MessageEvent) => {
      try {
        const data = JSON.parse(e.data);
        setActiveJob((prev) => prev && prev.jobId === data.jobId ? { ...prev, finished: true } : prev);
        reloadStats();
      } catch { /* ignore */ }
    };
    es.addEventListener("admin.variants_rebuild_progress", onProgress as EventListener);
    es.addEventListener("admin.variants_rebuild_done", onDone as EventListener);
    return () => { es.close(); };
  }, [reloadStats]);

  const doScan = async () => {
    setScanning(true);
    try {
      const r = await fetch("/api/admin/variants/legacy-scan");
      if (r.ok) setScan(await r.json());
    } finally { setScanning(false); }
  };

  const doPurge = async () => {
    if (purgeConfirm !== "УДАЛИТЬ") {
      toast.error("Введите УДАЛИТЬ для подтверждения");
      return;
    }
    setPurging(true);
    try {
      const r = await fetch("/api/admin/variants/legacy-purge", { method: "POST" });
      if (r.ok) {
        const data = await r.json();
        toast.success(`Удалено: ${data.deleted}`);
        setScan(null);
        setPurgeConfirm("");
        reloadStats();
      } else {
        toast.error("Ошибка очистки");
      }
    } finally { setPurging(false); }
  };

  const startRebuildUser = async (userId: number, email: string) => {
    const r = await fetch("/api/admin/variants/rebuild", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userId }),
    });
    if (!r.ok) { toast.error("Не удалось запустить"); return; }
    const data = await r.json();
    if (data.folded) {
      toast.message("Job уже выполняется", { description: "Дождитесь окончания и запустите снова" });
      return;
    }
    setActiveJob({
      jobId: data.jobId, scope: "user", total: 0, done: 0, errors: [], finished: false,
      currentEmail: email,
    });
  };

  const startRebuildAll = async () => {
    const r = await fetch("/api/admin/variants/rebuild-all", { method: "POST" });
    if (!r.ok) { toast.error("Не удалось запустить"); return; }
    const data = await r.json();
    if (data.folded) {
      toast.message("Job уже выполняется", { description: "Дождитесь окончания и запустите снова" });
      return;
    }
    setActiveJob({
      jobId: data.jobId, scope: "all", total: 0, done: 0, errors: [], finished: false,
    });
  };

  const filteredUsers = users.filter((u) =>
    !filter || u.email.toLowerCase().includes(filter.toLowerCase())
  );

  const jobRunning = activeJob !== null && !activeJob.finished;
  const pct = activeJob && activeJob.total > 0
    ? Math.round((activeJob.done / activeJob.total) * 100)
    : 0;

  return (
    <div className="max-w-6xl space-y-6">
      <section className="rounded-md border p-4">
        <h2 className="text-base font-semibold mb-2">Состояние превью</h2>
        {stats ? (
          <dl className="grid grid-cols-2 gap-2 text-sm">
            <dt>Оригиналов в БД:</dt><dd>{stats.originals_in_db}</dd>
            <dt>Thumb на диске:</dt><dd>{stats.variants_on_disk_thumb}</dd>
            <dt>Mid на диске:</dt><dd>{stats.variants_on_disk_mid}</dd>
            <dt>Каталог вариантов:</dt><dd className="font-mono text-xs">{stats.variants_dir}</dd>
          </dl>
        ) : <p className="text-sm text-muted-foreground">Загрузка...</p>}
      </section>

      <section className="rounded-md border p-4">
        <h2 className="text-base font-semibold mb-1">Очистка старых вариантов</h2>
        <p className="text-sm text-muted-foreground mb-3">
          Удалит файлы <code>thumb_*.jpg</code> и <code>mid_*.jpg</code> из папок пользователей.
          Используйте один раз перед первой пересборкой.
        </p>
        <div className="flex items-center gap-2 mb-2">
          <button onClick={doScan} disabled={scanning || jobRunning}
            className="px-3 py-1.5 rounded border text-sm">
            {scanning ? "Сканирование..." : "Сканировать"}
          </button>
          {scan && (
            <span className="text-sm">найдено {scan.count} файлов в {scan.dirs.length} папках</span>
          )}
        </div>
        {scan && scan.count > 0 && (
          <div className="flex items-center gap-2">
            <input type="text" value={purgeConfirm} onChange={(e) => setPurgeConfirm(e.target.value)}
              placeholder='Введите "УДАЛИТЬ"'
              className="px-2 py-1 rounded border text-sm bg-background text-foreground" />
            <button onClick={doPurge} disabled={purging || purgeConfirm !== "УДАЛИТЬ" || jobRunning}
              className="px-3 py-1.5 rounded border border-destructive text-destructive text-sm disabled:opacity-50">
              Удалить старые
            </button>
          </div>
        )}
      </section>

      <section className="rounded-md border p-4">
        <h2 className="text-base font-semibold mb-2">Пересборка вариантов</h2>
        <div className="flex items-center gap-2 mb-3">
          <button onClick={startRebuildAll} disabled={jobRunning}
            className="px-3 py-1.5 rounded border text-sm">
            Пересобрать всё
          </button>
          {activeJob && (
            <span className="text-sm">
              {activeJob.finished ? "Готово" : `Job ${activeJob.jobId.slice(0, 8)}...`}: {activeJob.done} / {activeJob.total}
              {activeJob.errors.length > 0 && ` (${activeJob.errors.length} ошибок)`}
              {activeJob.currentEmail && !activeJob.finished && ` — ${activeJob.currentEmail}`}
            </span>
          )}
        </div>
        {jobRunning && (
          <div className="h-2 w-full bg-muted rounded overflow-hidden mb-3">
            <div className="h-full bg-primary transition-all" style={{ width: `${pct}%` }} />
          </div>
        )}
        <input type="text" placeholder="Поиск..."
          value={filter} onChange={(e) => setFilter(e.target.value)}
          className="px-2 py-1 rounded border text-sm bg-background text-foreground w-64 mb-2" />
        <ul className="text-sm divide-y border rounded">
          {filteredUsers.map((u) => (
            <li key={u.user_id} className="flex items-center justify-between px-3 py-2">
              <span>{u.email}</span>
              <span className="flex items-center gap-3">
                <span className="text-muted-foreground">{u.image_generation_count} ген.</span>
                <button onClick={() => startRebuildUser(u.user_id, u.email)} disabled={jobRunning}
                  className="px-2 py-1 rounded border text-xs">
                  Пересобрать
                </button>
              </span>
            </li>
          ))}
          {filteredUsers.length === 0 && (
            <li className="px-3 py-2 text-muted-foreground">Нет пользователей с изображениями</li>
          )}
        </ul>
      </section>

      {activeJob && activeJob.errors.length > 0 && (
        <section className="rounded-md border p-4">
          <details>
            <summary className="cursor-pointer text-sm font-semibold">
              Ошибки последней пересборки ({activeJob.errors.length})
            </summary>
            <ul className="mt-2 space-y-1 text-xs font-mono">
              {activeJob.errors.map((e, i) => (
                <li key={i}>generation {e.generationId}: {e.reason} {e.error}</li>
              ))}
            </ul>
          </details>
        </section>
      )}
    </div>
  );
}
```

- [ ] **Step 3: Register the new tab**

Open the admin parent file located in Step 1 and add a tab trigger + content for "preview-state":

- Add an import: `import { PreviewStateTab } from "./preview-state-tab";`
- Add a `<TabsTrigger value="preview-state">Превью / History state</TabsTrigger>` next to the existing triggers.
- Add a `<TabsContent value="preview-state"><PreviewStateTab /></TabsContent>` next to the existing contents.

(The exact JSX wrapping depends on the existing structure — match the surrounding pattern verbatim.)

- [ ] **Step 4: Type-check**

Run: `npx tsc --noEmit`
Expected: zero errors.

- [ ] **Step 5: Manual smoke**

Start the dev server, log in as admin, navigate to the admin panel, switch to the new "Превью / History state" tab. Confirm:
- Stats numbers render.
- User list renders with at least your own row.
- Clicking "Сканировать" returns a count.
- Clicking "Пересобрать" for a single user starts a job and the progress bar updates via SSE.
- After completion, stats refresh.

If SSE events don't arrive: check that `/api/history/stream` is the correct EventSource URL and that admin events from `broadcastToUserId` route through it. (They do — same pattern as `admin.user_purged`.)

- [ ] **Step 6: Commit**

```bash
git add components/admin/preview-state-tab.tsx components/admin/<parent-file>.tsx
git commit -m "feat(admin/ui): Превью / History state tab with rebuild + legacy-purge"
```

---

## Task 16: Final pass — full suite, type-check, lint

Sanity check before declaring done.

- [ ] **Step 1: Full test suite**

Run: `npm test`
Expected: all green, no skipped tests added by this work.

- [ ] **Step 2: Type-check**

Run: `npx tsc --noEmit`
Expected: zero errors.

- [ ] **Step 3: Lint**

Run: `npm run lint`
Expected: no new errors.

- [ ] **Step 4: End-to-end manual smoke**

Sequence:
1. Generate one image as a regular user → confirm original in `history_images/<email>/...`, thumb/mid in `history_variants/<email>/...`.
2. Open history → thumb + mid load (200, correct content-types).
3. As admin: open Превью / History state tab → stats render → click "Сканировать" → if pre-existing legacy thumb_/mid_ exist, they're counted.
4. Optionally: type УДАЛИТЬ → click "Удалить старые" → confirm count drops; UI shows blur fallback for legacy rows.
5. Click "Пересобрать всё" → progress bar advances → stats refresh on completion → reload history → thumb/mid load again.
6. Soft-delete a throwaway test user → hard-delete → confirm both `history_images/deleted_*` and `history_variants/deleted_*` exist with the same slot name.

- [ ] **Step 5: Final commit if anything moved**

If the smoke surfaced any tiny fix, commit it. Otherwise this task has no commit.

---

## Self-Review Checklist (for the plan author)

- [x] Spec coverage: every section/requirement in `2026-05-14-variants-separation-design.md` has a corresponding task.
  - §1 file layout / env → Task 4
  - §2 routing + dispatch → Task 9
  - §3 POST split writes → Task 8
  - §4 sharp builder + jobs + endpoints → Tasks 5, 11, 13, 14
  - §5 admin tab → Task 15
  - §6 hard-delete extension → Tasks 6, 7
  - Tests called out in §6 → distributed across the per-module test tasks
- [x] No placeholders / TBDs in the task bodies.
- [x] Type and method-name consistency: `findFreeDeletedTargetAcross`, `renameUserFolderToTarget`, `buildVariantsForGeneration`, `runRebuild`, `tryStartJob`/`bumpDone`/`appendError`/`finishJob`/`getJob`/`getActiveJob`, `scanLegacyVariants`/`purgeLegacyVariants`, `getHistoryVariantsDir` — all consistent across tasks.
- [x] All file paths exact.
- [x] Each TDD task: failing test → run → implement → run → commit.
