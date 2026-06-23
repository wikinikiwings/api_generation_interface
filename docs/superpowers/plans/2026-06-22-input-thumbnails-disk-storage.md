# Input Images → Disk Storage (with restore support) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop storing base64 input thumbnails inside `generations.prompt_data` (currently ~945 MB / 95% of the ~1 GB DB). For NEW generations store, per input image, BOTH a full-resolution copy (for faithful "restore inputs" — the analogue of the existing prompt-restore) AND a 240px JPEG thumbnail (for cheap list display), as files on disk; keep only URL references in `prompt_data`. Backfill existing rows (legacy: thumbnails only) to disk and `VACUUM` to reclaim space.

**Architecture:** Mirror the existing variants-separation pattern (see `docs/superpowers/specs/2026-05-14-variants-separation-design.md`): a new top-level root `HISTORY_INPUTS_DIR` with the same `<email>/<YYYY>/<MM>/` layout as originals/variants, served through the existing `/api/history/image/[...path]` route via filename-prefix dispatch (`input_` → inputs root). The client uploads, per input, a full-res blob + a thumbnail blob as extra multipart parts; the server writes both and injects two URL arrays into `prompt_data`: `inputThumbnails` (display) and `inputImages` (restore). A one-time migration converts legacy base64 thumbnails to files + URLs and `VACUUM`s. The restore UI itself is a documented follow-up; this plan lays the complete data foundation and surfaces both arrays on `HistoryEntry`.

**Tech Stack:** Next.js 15 (App Router, `runtime = "nodejs"`), TypeScript 5, `better-sqlite3` (WAL), Vitest, Node `fs/promises`, client `canvas.toDataURL` + `dataUrlToBlob` + existing dropzone-optimized `File`s.

## Global Constraints

- **Do NOT change the DB schema.** `prompt_data` stays a JSON TEXT blob. Two fields change/appear inside it: `inputThumbnails` (legacy base64 → 240px thumbnail URLs) and `inputImages` (NEW — full-res input URLs). No SQLite column adds/renames. The DB is shared with `viewcomfy-claude`.
- **Backward-compatible read.** `inputThumbnails` may contain EITHER legacy base64 `data:image/...` strings (old rows, pre-backfill) OR `/api/history/image/...` URL strings (new + backfilled rows). `inputImages` is present only on new rows (absent on legacy + t2i). Read code accepts both, treats missing/malformed as "none", never throws.
- **Two prompt_data fields, two purposes.** `inputThumbnails` = small, for showing what was input. `inputImages` = full-res, for re-attaching to the form (restore). New generations write both (1:1 by index). Legacy backfill writes only `inputThumbnails`.
- **Filename conventions** (both live under `HISTORY_INPUTS_DIR/<email>/<YYYY>/<MM>/`, both dispatched by the `input_` prefix):
  - Full input: `input_<uuid>_<index>.<ext>` — `<ext>` from the input's content-type (`png`/`jpg`/`webp`).
  - Thumbnail: `input_thumb_<uuid>_<index>.jpg` — always JPEG.
  - `<uuid>` = the generation's output uuid (same one used for `<uuid>.<ext>` original); `<index>` zero-based.
  - Full regex: `^input_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}_\d+\.[a-z0-9]+$` (i). Thumb regex: `^input_thumb_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}_\d+\.jpg$` (i). The full regex does NOT match a thumb name because `thumb` is not a valid hex uuid.
- **Soft-delete & billing semantics untouched.** No change to `generations.status` or `usageThisMonth`.
- **Windows fs.rename needs retry** — reuse `renameUserFolderToTarget` from `lib/admin/folder-rename.ts`; never raw `fs.rename` for the `<email>` folder move.
- **Idempotent POST preserved** — `findGenerationByOutputPath` short-circuit stays; re-writing input files on a retry is a deterministic overwrite.
- **Cap at 14 inputs** (`MAX_INPUT_IMAGES`) — matches `ImageDropzone maxImages={14}` (`generate-form.tsx:625`).
- **Path-traversal guards stay uniform** — the image serve route validates segments BEFORE root selection; do not weaken when adding the inputs root.
- **Run `npx vitest run` and `npx tsc --noEmit` green before every commit.** (Baseline: 302 tests pass, `tsc` clean.)

---

## File Structure

| File | Responsibility | Action |
|---|---|---|
| `lib/history-db.ts` | resolve `HISTORY_INPUTS_DIR`, sync-mkdir at import, export `getHistoryInputsDir()` | Modify |
| `lib/history-inputs.ts` | filename helpers + `writeInputAssets` (testable fs logic) + `extFromContentType` | **Create** |
| `app/api/history/image/[...path]/route.ts` | dispatch `input_` prefix → inputs root | Modify |
| `lib/utils.ts` | add `dataUrlToBlob` client helper | Modify |
| `lib/history-upload.ts` | accept `inputImages: Blob[]` + `inputThumbs: Blob[]`, append `inputCount` + `inputfull_<i>`/`inputthumb_<i>` parts | Modify |
| `app/api/history/route.ts` | read input parts, write full+thumb, inject `inputThumbnails` + `inputImages` URL arrays | Modify |
| `app/api/history/input-asset-urls.ts` | pure URL builders (testable) | **Create** |
| `lib/history/store.ts` | `serverGenToEntry` parses `inputThumbnails` + `inputImages` (URL or base64) onto the entry | Modify |
| `lib/history/types.ts` | add `inputImages?: string[]` to `HistoryEntry` | Modify |
| `components/generate-form.tsx` | upload full `File`s + thumbnail blobs; remove base64 `inputThumbnails` from the STORED payload | Modify |
| `app/api/admin/users/[id]/route.ts` | include inputs root in hard-delete folder rename | Modify |
| `scripts/migrate-input-thumbnails.mjs` | one-time backfill: base64 thumbs → files + URL rewrite, `--dry-run`, `VACUUM` | **Create** |
| `lib/__tests__/history-inputs.test.ts` | unit tests for helpers + `writeInputAssets` | **Create** |
| `lib/history/__tests__/server-row-input-assets.test.ts` | `serverGenToEntry` read compat | **Create** |
| `.env.example` | document `HISTORY_INPUTS_DIR` | Modify (if present) |

---

## Task 1: Inputs storage root + filename/write helpers

**Files:**
- Modify: `lib/history-db.ts` (alongside the `HISTORY_VARIANTS_DIR` block ~lines 22-30; export ~line 419)
- Create: `lib/history-inputs.ts`
- Create: `lib/__tests__/history-inputs.test.ts`

**Interfaces:**
- Produces (from `lib/history-db.ts`): `getHistoryInputsDir(): string`.
- Produces (from `lib/history-inputs.ts`):
  - `MAX_INPUT_IMAGES: number` (14)
  - `inputImageFilename(uuid: string, index: number, ext: string): string` → `input_<uuid>_<index>.<ext>`
  - `inputThumbFilename(uuid: string, index: number): string` → `input_thumb_<uuid>_<index>.jpg`
  - `isInputAsset(name: string): boolean` (matches a full OR thumb input name)
  - `extFromContentType(ct: string): string` → `png|jpg|webp` (default `jpg`)
  - `writeInputAssets(inputsDir, relDir, uuid, items: InputAssetInput[]): Promise<{ thumbs: string[]; images: (string|null)[] }>` where `InputAssetInput = { thumb: Buffer; full?: { buffer: Buffer; ext: string } }`. Returns rel paths (relative to `inputsDir`) per index; `images[i]` is `null` when that item had no `full`.

- [ ] **Step 1: Write the failing test**

Create `lib/__tests__/history-inputs.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import {
  MAX_INPUT_IMAGES,
  inputImageFilename,
  inputThumbFilename,
  isInputAsset,
  extFromContentType,
  writeInputAssets,
} from "@/lib/history-inputs";

const UUID = "0123abcd-4567-89ab-cdef-0123456789ab";

describe("input filename helpers", () => {
  it("caps at 14", () => expect(MAX_INPUT_IMAGES).toBe(14));

  it("builds full and thumb names", () => {
    expect(inputImageFilename(UUID, 0, "png")).toBe(`input_${UUID}_0.png`);
    expect(inputThumbFilename(UUID, 2)).toBe(`input_thumb_${UUID}_2.jpg`);
  });

  it("recognizes full and thumb assets, rejects others", () => {
    expect(isInputAsset(`input_${UUID}_0.png`)).toBe(true);
    expect(isInputAsset(`input_thumb_${UUID}_0.jpg`)).toBe(true);
    expect(isInputAsset(`thumb_${UUID}.jpg`)).toBe(false);
    expect(isInputAsset(`${UUID}.png`)).toBe(false);
  });

  it("maps content types to extensions", () => {
    expect(extFromContentType("image/png")).toBe("png");
    expect(extFromContentType("image/jpeg")).toBe("jpg");
    expect(extFromContentType("image/webp")).toBe("webp");
    expect(extFromContentType("application/octet-stream")).toBe("jpg");
  });
});

describe("writeInputAssets", () => {
  it("writes full+thumb per item and returns rel paths in order", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "inputs-"));
    const relDir = "alice@x.com/2026/06";
    const res = await writeInputAssets(root, relDir, UUID, [
      { thumb: Buffer.from("t0"), full: { buffer: Buffer.from("f0"), ext: "png" } },
      { thumb: Buffer.from("t1"), full: { buffer: Buffer.from("f1"), ext: "webp" } },
    ]);
    expect(res.thumbs).toEqual([
      `${relDir}/input_thumb_${UUID}_0.jpg`,
      `${relDir}/input_thumb_${UUID}_1.jpg`,
    ]);
    expect(res.images).toEqual([
      `${relDir}/input_${UUID}_0.png`,
      `${relDir}/input_${UUID}_1.webp`,
    ]);
    expect((await fs.readFile(path.join(root, relDir, `input_${UUID}_1.webp`))).toString()).toBe("f1");
    expect((await fs.readFile(path.join(root, relDir, `input_thumb_${UUID}_0.jpg`))).toString()).toBe("t0");
  });

  it("supports thumb-only items (legacy backfill) → images[i] null", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "inputs-"));
    const res = await writeInputAssets(root, "alice@x.com/2026/06", UUID, [{ thumb: Buffer.from("t") }]);
    expect(res.thumbs).toEqual([`alice@x.com/2026/06/input_thumb_${UUID}_0.jpg`]);
    expect(res.images).toEqual([null]);
  });

  it("returns empty arrays for no items", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "inputs-"));
    const res = await writeInputAssets(root, "alice@x.com/2026/06", UUID, []);
    expect(res).toEqual({ thumbs: [], images: [] });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run lib/__tests__/history-inputs.test.ts`
Expected: FAIL — `Cannot find module '@/lib/history-inputs'`.

- [ ] **Step 3: Create `lib/history-inputs.ts`**

```ts
import path from "node:path";
import fs from "node:fs/promises";

/** Max input images kept per generation. Matches ImageDropzone maxImages. */
export const MAX_INPUT_IMAGES = 14;

const FULL_RE =
  /^input_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}_\d+\.[a-z0-9]+$/i;
const THUMB_RE =
  /^input_thumb_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}_\d+\.jpg$/i;

export function inputImageFilename(uuid: string, index: number, ext: string): string {
  return `input_${uuid}_${index}.${ext}`;
}

export function inputThumbFilename(uuid: string, index: number): string {
  return `input_thumb_${uuid}_${index}.jpg`;
}

/** True for a full OR thumb input asset basename (used by guards / legacy scan). */
export function isInputAsset(name: string): boolean {
  return THUMB_RE.test(name) || FULL_RE.test(name);
}

export function extFromContentType(ct: string): string {
  if (ct === "image/png") return "png";
  if (ct === "image/webp") return "webp";
  if (ct === "image/jpeg" || ct === "image/jpg") return "jpg";
  return "jpg";
}

export interface InputAssetInput {
  thumb: Buffer;
  full?: { buffer: Buffer; ext: string };
}

/**
 * Write input assets under `<inputsDir>/<relDir>/`. For each item writes a
 * thumbnail (`input_thumb_<uuid>_<i>.jpg`) and, if present, a full-res image
 * (`input_<uuid>_<i>.<ext>`). Returns rel paths per index; images[i] is null
 * when that item had no full. Empty input → both arrays empty, no I/O.
 */
export async function writeInputAssets(
  inputsDir: string,
  relDir: string,
  uuid: string,
  items: InputAssetInput[]
): Promise<{ thumbs: string[]; images: (string | null)[] }> {
  if (items.length === 0) return { thumbs: [], images: [] };
  const absDir = path.join(inputsDir, relDir);
  await fs.mkdir(absDir, { recursive: true });
  const thumbs: string[] = [];
  const images: (string | null)[] = [];
  await Promise.all(
    items.map(async (item, i) => {
      const thumbName = inputThumbFilename(uuid, i);
      await fs.writeFile(path.join(absDir, thumbName), item.thumb);
      thumbs[i] = `${relDir}/${thumbName}`;
      if (item.full) {
        const fullName = inputImageFilename(uuid, i, item.full.ext);
        await fs.writeFile(path.join(absDir, fullName), item.full.buffer);
        images[i] = `${relDir}/${fullName}`;
      } else {
        images[i] = null;
      }
    })
  );
  return { thumbs, images };
}
```

- [ ] **Step 4: Add the inputs root to `lib/history-db.ts`**

After the `HISTORY_VARIANTS_DIR` const block (~`lib/history-db.ts:22-24`):

```ts
const HISTORY_INPUTS_DIR = process.env.HISTORY_INPUTS_DIR
  ? path.resolve(process.env.HISTORY_INPUTS_DIR)
  : path.join(DATA_DIR, "history_inputs");
```

After the variants `mkdirSync` block (~`lib/history-db.ts:29-30`):

```ts
if (!fs.existsSync(HISTORY_INPUTS_DIR))
  fs.mkdirSync(HISTORY_INPUTS_DIR, { recursive: true });
```

After `getHistoryVariantsDir` (~`lib/history-db.ts:419-421`):

```ts
export function getHistoryInputsDir(): string {
  return HISTORY_INPUTS_DIR;
}
```

- [ ] **Step 5: Run tests + typecheck**

Run: `npx vitest run lib/__tests__/history-inputs.test.ts && npx tsc --noEmit`
Expected: all helper tests PASS; `tsc` exit 0.

- [ ] **Step 6: Commit**

```bash
git add lib/history-inputs.ts lib/history-db.ts lib/__tests__/history-inputs.test.ts
git commit -m "feat(history-inputs): add HISTORY_INPUTS_DIR root and full+thumb write helpers

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 2: Serve `input_` prefix from the inputs root

**Files:**
- Modify: `app/api/history/image/[...path]/route.ts:2, 43-46`
- Create: `app/api/history/image/__tests__/input-dispatch.test.ts`

**Interfaces:**
- Consumes: `getHistoryInputsDir` (Task 1).
- Produces: any basename starting `input_` (both `input_<uuid>_<n>.<ext>` full and `input_thumb_<uuid>_<n>.jpg`) resolves from `HISTORY_INPUTS_DIR`.

- [ ] **Step 1: Write the failing test**

Create `app/api/history/image/__tests__/input-dispatch.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/history-db", () => ({
  getDb: () => ({}),
  getHistoryImagesDir: () => "/roots/images",
  getHistoryVariantsDir: () => "/roots/variants",
  getHistoryInputsDir: () => "/roots/inputs",
}));
vi.mock("@/lib/auth/current-user", () => ({
  getCurrentUser: () => ({ id: 1, email: "admin@x.com", role: "admin" }),
}));
const readFile = vi.fn(async () => Buffer.from("BYTES"));
vi.mock("node:fs/promises", () => ({ default: { readFile: (...a: unknown[]) => readFile(...a) } }));

import { GET } from "@/app/api/history/image/[...path]/route";
const UUID = "0123abcd-4567-89ab-cdef-0123456789ab";
const req = () => ({ cookies: { get: () => ({ value: "sid" }) } } as never);

describe("image serve dispatch", () => {
  beforeEach(() => readFile.mockClear());

  it("routes full input_ to the inputs root", async () => {
    await GET(req(), { params: Promise.resolve({ path: ["alice@x.com", "2026", "06", `input_${UUID}_0.png`] }) });
    expect(String(readFile.mock.calls[0][0])).toContain("/roots/inputs");
  });
  it("routes input_thumb_ to the inputs root", async () => {
    await GET(req(), { params: Promise.resolve({ path: ["alice@x.com", "2026", "06", `input_thumb_${UUID}_0.jpg`] }) });
    expect(String(readFile.mock.calls[0][0])).toContain("/roots/inputs");
  });
  it("still routes thumb_ to variants", async () => {
    await GET(req(), { params: Promise.resolve({ path: ["alice@x.com", "2026", "06", `thumb_${UUID}.jpg`] }) });
    expect(String(readFile.mock.calls[0][0])).toContain("/roots/variants");
  });
});
```

> NOTE: confirm the `node:fs/promises` mock shape matches the route's import (`import fs from "node:fs/promises"`). Run Step 2 first to surface mismatches.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run app/api/history/image/__tests__/input-dispatch.test.ts`
Expected: FAIL — input basenames resolve under `/roots/images`.

- [ ] **Step 3: Add the dispatch**

`app/api/history/image/[...path]/route.ts` line 2:

```ts
import { getDb, getHistoryImagesDir, getHistoryVariantsDir, getHistoryInputsDir } from "@/lib/history-db";
```

Replace the root-selection block (lines 43-46) with:

```ts
  const filename = segs[segs.length - 1];
  // Dispatch root by basename prefix: thumb_/mid_ → variants cache,
  // input_ (full + input_thumb_) → input store, else → originals.
  const dir = filename.startsWith("thumb_") || filename.startsWith("mid_")
    ? getHistoryVariantsDir()
    : filename.startsWith("input_")
      ? getHistoryInputsDir()
      : getHistoryImagesDir();
```

- [ ] **Step 4: Run test + typecheck**

Run: `npx vitest run app/api/history/image/__tests__/input-dispatch.test.ts && npx tsc --noEmit`
Expected: PASS (3 tests); `tsc` exit 0.

- [ ] **Step 5: Commit**

```bash
git add "app/api/history/image/[...path]/route.ts" app/api/history/image/__tests__/input-dispatch.test.ts
git commit -m "feat(history-image): serve input_ basenames from HISTORY_INPUTS_DIR

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 3: `dataUrlToBlob` client helper

**Files:**
- Modify: `lib/utils.ts` (after `fileToDataURL`, ~line 65)
- Create: `lib/__tests__/data-url-to-blob.test.ts`

**Interfaces:**
- Produces: `dataUrlToBlob(dataUrl: string): Blob` — decode `data:<mime>;base64,<payload>` → `Blob` with correct `type`. Throws on non-data-URL.

- [ ] **Step 1: Write the failing test**

Create `lib/__tests__/data-url-to-blob.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { dataUrlToBlob } from "@/lib/utils";

describe("dataUrlToBlob", () => {
  it("decodes a base64 jpeg data URL to a typed Blob", async () => {
    const bytes = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0]);
    const b64 = Buffer.from(bytes).toString("base64");
    const blob = dataUrlToBlob(`data:image/jpeg;base64,${b64}`);
    expect(blob.type).toBe("image/jpeg");
    expect(Array.from(new Uint8Array(await blob.arrayBuffer()))).toEqual([0xff, 0xd8, 0xff, 0xe0]);
  });
  it("throws on a non-data URL", () => {
    expect(() => dataUrlToBlob("https://example.com/x.jpg")).toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run lib/__tests__/data-url-to-blob.test.ts`
Expected: FAIL — `dataUrlToBlob` not exported.

- [ ] **Step 3: Implement**

Add to `lib/utils.ts` after `fileToDataURL` (~line 65):

```ts
/**
 * Decode a `data:<mime>;base64,<payload>` URL into a Blob. Used to turn
 * client-generated thumbnail data URLs into multipart upload parts.
 * Throws on anything that is not a base64 data URL.
 */
export function dataUrlToBlob(dataUrl: string): Blob {
  const m = /^data:([^;,]+)?(;base64)?,(.*)$/s.exec(dataUrl);
  if (!m || !m[2]) throw new Error("not a base64 data URL");
  const mime = m[1] || "application/octet-stream";
  const binary = atob(m[3]);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new Blob([bytes], { type: mime });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run lib/__tests__/data-url-to-blob.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add lib/utils.ts lib/__tests__/data-url-to-blob.test.ts
git commit -m "feat(utils): add dataUrlToBlob for multipart thumbnail upload

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 4: Upload contract carries full inputs + thumbnails

**Files:**
- Modify: `lib/history-upload.ts:10-21` (params), `68-84` (FormData build)
- Create: `lib/__tests__/history-upload-inputs.test.ts`

**Interfaces:**
- Produces: `UploadHistoryParams` gains `inputImages?: Blob[]` (full-res, index-aligned) and `inputThumbs?: Blob[]` (240px). The two arrays MUST be the same length when both present (1:1 by index). Body gains `inputCount` (= `inputThumbs.length`) and, per `i`, parts `inputfull_<i>` (named `inputfull_<i>.<ext-from-blob>`, type = the full blob's type) and `inputthumb_<i>` (type `image/jpeg`). Absent → `inputCount=0`, no parts.

- [ ] **Step 1: Write the failing test**

Create `lib/__tests__/history-upload-inputs.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { uploadHistoryEntry } from "@/lib/history-upload";

const captured: { fd?: FormData } = {};
beforeEach(() => {
  captured.fd = undefined;
  vi.stubGlobal("fetch", vi.fn(async (_u: string, init: RequestInit) => {
    captured.fd = init.body as FormData;
    return new Response(JSON.stringify({ id: 1, fullUrl: "/f", thumbUrl: "/t", midUrl: "/m" }),
      { status: 200, headers: { "Content-Type": "application/json" } });
  }));
});
function base() {
  return {
    uuid: "0123abcd-4567-89ab-cdef-0123456789ab", workflowName: "wf",
    promptData: { prompt: "p" }, executionTimeSeconds: 1,
    original: new Blob(["o"], { type: "image/png" }), originalFilename: "o.png", originalContentType: "image/png",
    thumb: new Blob(["t"], { type: "image/jpeg" }), mid: new Blob(["m"], { type: "image/jpeg" }),
  };
}

describe("uploadHistoryEntry input assets", () => {
  it("appends inputCount + inputfull_/inputthumb_ parts", async () => {
    await uploadHistoryEntry({
      ...base(),
      inputImages: [new Blob(["F0"], { type: "image/png" }), new Blob(["F1"], { type: "image/webp" })],
      inputThumbs: [new Blob(["T0"], { type: "image/jpeg" }), new Blob(["T1"], { type: "image/jpeg" })],
    });
    const fd = captured.fd!;
    expect(fd.get("inputCount")).toBe("2");
    expect(fd.get("inputfull_0")).toBeInstanceOf(File);
    expect((fd.get("inputfull_1") as File).type).toBe("image/webp");
    expect(fd.get("inputthumb_0")).toBeInstanceOf(File);
    expect(fd.get("inputfull_2")).toBeNull();
  });
  it("sets inputCount=0 when no inputs", async () => {
    await uploadHistoryEntry(base());
    expect(captured.fd!.get("inputCount")).toBe("0");
    expect(captured.fd!.get("inputfull_0")).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run lib/__tests__/history-upload-inputs.test.ts`
Expected: FAIL — `inputCount` null + TS error on unknown props.

- [ ] **Step 3: Extend the params interface**

In `lib/history-upload.ts`, after `mid: Blob;` (line 19):

```ts
  /** Full-res input images (index-aligned with inputThumbs). Server writes
   *  them to HISTORY_INPUTS_DIR and stores their URLs in promptData.inputImages. */
  inputImages?: Blob[];
  /** 240px input thumbnails (index-aligned). Stored as promptData.inputThumbnails URLs. */
  inputThumbs?: Blob[];
```

- [ ] **Step 4: Append the parts**

After the `mid` append (line 83):

```ts
  const thumbs = p.inputThumbs ?? [];
  const fulls = p.inputImages ?? [];
  fd.append("inputCount", String(thumbs.length));
  thumbs.forEach((thumb, i) => {
    fd.append(`inputthumb_${i}`, new File([thumb], `inputthumb_${i}.jpg`, { type: "image/jpeg" }));
    const full = fulls[i];
    if (full) {
      const ext = full.type === "image/png" ? "png" : full.type === "image/webp" ? "webp" : "jpg";
      fd.append(`inputfull_${i}`, new File([full], `inputfull_${i}.${ext}`, { type: full.type || "image/jpeg" }));
    }
  });
```

- [ ] **Step 5: Run test + typecheck**

Run: `npx vitest run lib/__tests__/history-upload-inputs.test.ts && npx tsc --noEmit`
Expected: PASS (2 tests); `tsc` exit 0.

- [ ] **Step 6: Commit**

```bash
git add lib/history-upload.ts lib/__tests__/history-upload-inputs.test.ts
git commit -m "feat(history-upload): carry full input images + thumbnails as multipart parts

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 5: POST `/api/history` writes inputs + injects URL arrays

**Files:**
- Create: `app/api/history/input-asset-urls.ts`
- Modify: `app/api/history/route.ts` — imports (2-16), POST body (~90, ~121-202)
- Create: `app/api/history/__tests__/input-assets-post.test.ts`

**Interfaces:**
- Consumes: `getHistoryInputsDir`, `writeInputAssets`, `MAX_INPUT_IMAGES`, `extFromContentType` (Task 1); multipart `inputCount`/`inputfull_<i>`/`inputthumb_<i>` (Task 4).
- Produces (pure helper): `buildInputAssetUrls(urlPrefix, uuid, items): { thumbnails: string[]; images: string[] }` where `items: { ext: string | null }[]` — `thumbnails[i]` always built; `images[i]` built only when `ext` non-null; entries with null ext are omitted from `images` only if ALL are null (see Step 3 contract). For new generations every item has a full, so `images` has the same length as `thumbnails`.
- Produces (route): stored `prompt_data.inputThumbnails` = thumbnail URL array; `prompt_data.inputImages` = full URL array (only set when at least one full was written).

- [ ] **Step 1: Write the failing test (pure URL builder)**

Create `app/api/history/__tests__/input-assets-post.test.ts`:

```ts
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run app/api/history/__tests__/input-assets-post.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Create the pure helper**

Create `app/api/history/input-asset-urls.ts`:

```ts
import { inputImageFilename, inputThumbFilename } from "@/lib/history-inputs";

/**
 * Build public URLs for a generation's input assets. `urlPrefix` is the
 * already-encoded `/api/history/image/<email>/<YYYY>/<MM>` segment. Thumbnails
 * are always produced; a full image URL is produced for each item whose `ext`
 * is non-null. If NO item has a full, `images` is [] (legacy/thumb-only rows).
 */
export function buildInputAssetUrls(
  urlPrefix: string,
  uuid: string,
  items: { ext: string | null }[]
): { thumbnails: string[]; images: string[] } {
  const thumbnails: string[] = [];
  const images: string[] = [];
  items.forEach((item, i) => {
    thumbnails.push(`${urlPrefix}/${inputThumbFilename(uuid, i)}`);
    if (item.ext) images.push(`${urlPrefix}/${inputImageFilename(uuid, i, item.ext)}`);
  });
  return { thumbnails, images };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run app/api/history/__tests__/input-assets-post.test.ts`
Expected: PASS (3 cases).

- [ ] **Step 5: Wire input writing into the POST handler**

In `app/api/history/route.ts`, add to the `@/lib/history-db` import: `getHistoryInputsDir`. Add below:

```ts
import { writeInputAssets, MAX_INPUT_IMAGES, extFromContentType } from "@/lib/history-inputs";
import { buildInputAssetUrls } from "@/app/api/history/input-asset-urls";
```

After `const mid = formData.get("mid");` (line 90), read input parts:

```ts
    // Optional input assets: inputCount + inputthumb_<i> (+ optional inputfull_<i>).
    const inputCount = Math.min(
      Math.max(parseInt((formData.get("inputCount") as string) || "0", 10) || 0, 0),
      MAX_INPUT_IMAGES
    );
    const inputItems: { thumb: Buffer; full?: { buffer: Buffer; ext: string } }[] = [];
    for (let i = 0; i < inputCount; i++) {
      const t = formData.get(`inputthumb_${i}`);
      if (!(t instanceof File)) continue;
      const item: { thumb: Buffer; full?: { buffer: Buffer; ext: string } } = {
        thumb: Buffer.from(await t.arrayBuffer()),
      };
      const f = formData.get(`inputfull_${i}`);
      if (f instanceof File) {
        item.full = { buffer: Buffer.from(await f.arrayBuffer()), ext: extFromContentType(f.type) };
      }
      inputItems.push(item);
    }
```

Immediately BEFORE the `findGenerationByOutputPath` lookup (line 181), write assets + inject URLs:

```ts
    if (inputItems.length > 0) {
      await writeInputAssets(getHistoryInputsDir(), relDir, uuid, inputItems);
      const inputPrefix = `/api/history/image/${encodeURIComponent(user.email)}/${yyyy}/${mm}`;
      const { thumbnails, images } = buildInputAssetUrls(
        inputPrefix,
        uuid,
        inputItems.map((it) => ({ ext: it.full ? it.full.ext : null }))
      );
      promptData.inputThumbnails = thumbnails;
      if (images.length > 0) promptData.inputImages = images;
    }
```

- [ ] **Step 6: Add a route-level integration test (tmpdir + in-memory DB)**

Append to `app/api/history/__tests__/input-assets-post.test.ts`:

```ts
import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import { vi } from "vitest";

describe("POST /api/history writes full+thumb and URL-only prompt_data", () => {
  it("stores inputThumbnails + inputImages URLs, no base64, files on disk", async () => {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "histpost-"));
    process.env.HISTORY_DATA_DIR = dataDir;
    process.env.NODE_ENV = "test";
    vi.doMock("@/lib/auth/current-user", () => ({ getCurrentUser: () => ({ id: 1, email: "alice@x.com", role: "user" }) }));

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
```

> NOTE: auth-mock ordering is sensitive. If `vi.doMock` post-import doesn't apply, hoist to a top-of-file `vi.mock("@/lib/auth/current-user", ...)` as in Task 2. Verify by running Step 7; never weaken assertions.

- [ ] **Step 7: Run the full test file + suite + typecheck**

Run: `npx vitest run app/api/history/__tests__/input-assets-post.test.ts && npx tsc --noEmit && npx vitest run`
Expected: PASS; `tsc` exit 0; no regressions.

- [ ] **Step 8: Commit**

```bash
git add app/api/history/route.ts app/api/history/input-asset-urls.ts app/api/history/__tests__/input-assets-post.test.ts
git commit -m "feat(history POST): write full+thumb input assets, store inputThumbnails/inputImages URLs

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 6: Read side — `serverGenToEntry` surfaces both arrays

**Files:**
- Modify: `lib/history/types.ts` (add `inputImages?: string[]` to `HistoryEntry`, after line 59)
- Modify: `lib/history/store.ts:140-200` (`serverGenToEntry`)
- Create: `lib/history/__tests__/server-row-input-assets.test.ts`

**Interfaces:**
- Consumes: `prompt_data.inputThumbnails` (URL or legacy base64) + `prompt_data.inputImages` (URL, new only).
- Produces: `HistoryEntry.inputThumbnails?: string[]` AND `HistoryEntry.inputImages?: string[]` populated on server-sourced entries. Both default undefined when absent/malformed. (`inputImages` is the restore source for the future feature.)

- [ ] **Step 1: Write the failing test**

Create `lib/history/__tests__/server-row-input-assets.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { serverGenToEntry } from "@/lib/history/store";
import type { ServerGeneration } from "@/lib/history/types";

function row(pd: object): ServerGeneration {
  return {
    id: 1, username: "alice@x.com", workflow_name: "wavespeed:wavespeed/nano-banana-pro/edit",
    prompt_data: JSON.stringify(pd), execution_time_seconds: 1, created_at: "2026-06-22T10:00:00.000Z",
    status: "completed",
    outputs: [{ id: 1, generation_id: 1, filename: "o.png",
      filepath: "alice@x.com/2026/06/0123abcd-4567-89ab-cdef-0123456789ab.png", content_type: "image/png", size: 3 }],
  };
}

describe("serverGenToEntry input assets", () => {
  it("reads URL thumbnails + full images", () => {
    const t = ["/api/history/image/alice%40x.com/2026/06/input_thumb_0123abcd-4567-89ab-cdef-0123456789ab_0.jpg"];
    const f = ["/api/history/image/alice%40x.com/2026/06/input_0123abcd-4567-89ab-cdef-0123456789ab_0.png"];
    const e = serverGenToEntry(row({ prompt: "p", inputThumbnails: t, inputImages: f }), "u");
    expect(e.inputThumbnails).toEqual(t);
    expect(e.inputImages).toEqual(f);
  });
  it("accepts legacy base64 thumbnails with no inputImages", () => {
    const b = ["data:image/jpeg;base64,/9j/4AAQ"];
    const e = serverGenToEntry(row({ prompt: "p", inputThumbnails: b }), "u");
    expect(e.inputThumbnails).toEqual(b);
    expect(e.inputImages).toBeUndefined();
  });
  it("undefined on absent/malformed", () => {
    expect(serverGenToEntry(row({ prompt: "p" }), "u").inputThumbnails).toBeUndefined();
    expect(serverGenToEntry(row({ prompt: "p", inputImages: [1] }), "u").inputImages).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run lib/history/__tests__/server-row-input-assets.test.ts`
Expected: FAIL — fields not parsed (and `inputImages` not on the type yet → TS error).

- [ ] **Step 3: Add `inputImages` to the entry type**

In `lib/history/types.ts`, after line 59 (`inputThumbnails?: string[];`):

```ts
  inputImages?: string[];                             // full-res input URLs (restore source)
```

- [ ] **Step 4: Parse both arrays in `serverGenToEntry`**

In `lib/history/store.ts`, add locals after `let styleIds: ...;` (line 144):

```ts
  let inputThumbnails: string[] | undefined;
  let inputImages: string[] | undefined;
```

Extend the destructured type (lines 146-152) with:

```ts
      inputThumbnails?: unknown[];
      inputImages?: unknown[];
```

Inside the `try`, before its closing `}` (line 167), add:

```ts
    const strArray = (v: unknown): string[] | undefined =>
      Array.isArray(v) && v.every((x) => typeof x === "string") ? (v as string[]) : undefined;
    // Strings may be /api/history/image/... URLs or legacy data:image base64;
    // both are valid <img src> values.
    inputThumbnails = strArray(parsed.inputThumbnails);
    inputImages = strArray(parsed.inputImages);
```

Add to the returned object (after `styleIds,`, ~line 189):

```ts
    inputThumbnails,
    inputImages,
```

- [ ] **Step 5: Run test + history suite + typecheck**

Run: `npx vitest run lib/history/__tests__/server-row-input-assets.test.ts && npx vitest run lib/history && npx tsc --noEmit`
Expected: PASS; no regression; `tsc` exit 0.

- [ ] **Step 6: Commit**

```bash
git add lib/history/store.ts lib/history/types.ts lib/history/__tests__/server-row-input-assets.test.ts
git commit -m "feat(history store): surface inputThumbnails + inputImages on server rows

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 7: Wire `generate-form.tsx` — upload full Files + thumb blobs

**Files:**
- Modify: `components/generate-form.tsx` — import; `promptPayload` (275-286); `saveToServerHistory` body; both upload calls (346-359, 405-417)

**Interfaces:**
- Consumes: `dataUrlToBlob` (Task 3), `uploadHistoryEntry({ inputImages, inputThumbs })` (Task 4).
- Produces: new generations upload the full optimized `File` (`images[i].file`) + the 240px thumbnail blob per input; STORED `promptData` no longer contains `inputThumbnails` (server sets both arrays). In-memory pending entry (line 486) unchanged.

No unit test (React glue); verified by suite + `tsc` + `next build` + Task 9 E2E.

- [ ] **Step 1: Add the import**

Add `dataUrlToBlob` to the existing `@/lib/utils` import in `components/generate-form.tsx` (the line already importing `fileToThumbnail`/`uuid`).

- [ ] **Step 2: Remove base64 inputThumbnails from the STORED payload**

Delete `inputThumbnails: thumbnails,` from `promptPayload` (line 285). The object ends at `model: getModelString(...)`.

- [ ] **Step 3: Build input blobs, pass to both upload calls**

`saveToServerHistory(outputUrl, executionTimeMs, thumbnails)` closes over the component's `images` state (same array `thumbnails` is index-aligned with). Before `const doUpload = () => ...` (line 346), add:

```ts
      // Per input image: full optimized File (the bytes sent to the provider →
      // faithful restore source) + the 240px thumbnail we already produced
      // (cheap list display). Index-aligned. Thumbnail decode failures drop
      // that one entry rather than blocking the save.
      const inputFullBlobs: Blob[] = [];
      const inputThumbBlobs: Blob[] = [];
      images.forEach((img, i) => {
        const t = thumbnails[i];
        if (typeof t !== "string" || !t.startsWith("data:")) return;
        try {
          const thumbBlob = dataUrlToBlob(t);
          inputThumbBlobs.push(thumbBlob);
          inputFullBlobs.push(img.file);
        } catch {
          /* skip a malformed thumbnail; keep the rest aligned */
        }
      });
```

In the `doUpload` object (347-359) add after `mid: variants.mid,`:

```ts
          inputImages: inputFullBlobs,
          inputThumbs: inputThumbBlobs,
```

In the 409-retry `uploadHistoryEntry({ ... })` (405-417) add the same two lines after `mid: variants.mid,`.

- [ ] **Step 4: Typecheck + suite + build**

Run: `npx tsc --noEmit && npx vitest run && npx next build`
Expected: `tsc` exit 0; all tests pass; build succeeds.

- [ ] **Step 5: Commit**

```bash
git add components/generate-form.tsx
git commit -m "feat(generate-form): upload full inputs + thumbnails, drop base64 from prompt_data

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 8: Hard-delete renames the inputs root too

**Files:**
- Modify: `app/api/admin/users/[id]/route.ts` — import (2), DELETE handler (151-213)
- Create: `app/api/admin/users/[id]/__tests__/purge-inputs-rename.test.ts`

**Interfaces:**
- Consumes: `getHistoryInputsDir` (Task 1), existing `findFreeDeletedTargetAcross` / `renameUserFolderToTarget`.
- Produces: hard-delete moves `<email>/` under all THREE roots to the same `deleted_*` target; response `rename_outcome` gains `inputs`.

- [ ] **Step 1: Write the failing test**

Create `app/api/admin/users/[id]/__tests__/purge-inputs-rename.test.ts` (model setup on `lib/admin/__tests__/purge-user.test.ts`; stub `getCurrentUser` to an admin with `id !== 2`):

```ts
import { describe, it, expect, vi } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";

describe("hard-delete renames the inputs root", () => {
  it("moves <email>/ under images, variants AND inputs to the same target", async () => {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "purge-"));
    process.env.HISTORY_DATA_DIR = dataDir;
    process.env.NODE_ENV = "test";
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run "app/api/admin/users/[id]/__tests__/purge-inputs-rename.test.ts"`
Expected: FAIL — `rename_outcome.inputs` undefined.

- [ ] **Step 3: Add inputs to import + target probe + rename**

`app/api/admin/users/[id]/route.ts` line 2:

```ts
import { getDb, getHistoryImagesDir, getHistoryVariantsDir, getHistoryInputsDir } from "@/lib/history-db";
```

Replace the predicted-target block (151-157):

```ts
  const variantsDir = getHistoryVariantsDir();
  const inputsDir = getHistoryInputsDir();
  const predictedTarget = await findFreeDeletedTargetAcross(
    [imagesDir, variantsDir, inputsDir],
    purgeResult.email
  );
```

After the variants rename try/catch (ends ~193) add:

```ts
  let inputsOutcome: SideOutcome;
  try {
    const inpRes = await renameUserFolderToTarget(inputsDir, purgeResult.email, predictedTarget);
    inputsOutcome = inpRes.renamed ? "renamed" : inpRes.reason;
  } catch (err) {
    console.error("[admin/users DELETE] inputs rename failed:", err);
    inputsOutcome = "failed";
    renameError = renameError ?? (err as Error).message;
  }
```

Update `anyRenamed` (197):

```ts
  const anyRenamed =
    imagesOutcome === "renamed" || variantsOutcome === "renamed" || inputsOutcome === "renamed";
```

`rename_outcome` (205):

```ts
      rename_outcome: { images: imagesOutcome, variants: variantsOutcome, inputs: inputsOutcome },
```

Failure guard (208):

```ts
  if (imagesOutcome === "failed" || variantsOutcome === "failed" || inputsOutcome === "failed") {
```

- [ ] **Step 4: Run test + suite + typecheck**

Run: `npx vitest run "app/api/admin/users/[id]/__tests__/purge-inputs-rename.test.ts" && npx vitest run && npx tsc --noEmit`
Expected: PASS; existing `purge-user.test.ts` still green; `tsc` exit 0.

- [ ] **Step 5: Commit**

```bash
git add "app/api/admin/users/[id]/route.ts" "app/api/admin/users/[id]/__tests__/purge-inputs-rename.test.ts"
git commit -m "feat(admin purge): rename inputs root alongside images/variants on hard-delete

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 9: Compatibility gate + end-to-end smoke (pre-backfill)

Verification gate, not code. The backfill (Task 10) is the only irreversible step; do not run it until this passes.

- [ ] **Step 1: viewcomfy-claude compat check**

Ask the operator for the `viewcomfy-claude` checkout path, then:

```bash
grep -rn "inputThumbnails\|inputImages" <viewcomfy-path> --include="*.ts" --include="*.tsx" || echo "no input-field references"
grep -rn "prompt_data" <viewcomfy-path> --include="*.ts" --include="*.tsx" | head -40
```

Decision:
- **No references** → format change safe. Record it.
- **References found** → confirm viewcomfy serves the same files from the same mount / can resolve `/api/history/image/...` URLs. If not, STOP and escalate before Task 10.

- [ ] **Step 2: Forward-path E2E (full input round-trip)**

```bash
HISTORY_DATA_DIR=./data-e2e npx next dev
```

Manually: log in, drop 2 input images, generate. Then verify:

```bash
ls ./data-e2e/history_inputs/*/*/*/        # expect input_<uuid>_0.<ext>, input_thumb_<uuid>_0.jpg, _1...
sqlite3 -readonly ./data-e2e/history.db \
  "SELECT prompt_data FROM generations ORDER BY id DESC LIMIT 1;" | grep -o "data:image" || echo "OK: no base64"
sqlite3 -readonly ./data-e2e/history.db \
  "SELECT json_extract(prompt_data,'\$.inputImages') FROM generations ORDER BY id DESC LIMIT 1;"
```

Expected: full + thumb files exist; newest `prompt_data` has `inputThumbnails` AND `inputImages` URL arrays, NO `data:image`.

- [ ] **Step 3: Reload-read + URL resolution check**

Hard refresh history. In DevTools confirm `GET .../input_<uuid>_0.<ext>` and `.../input_thumb_<uuid>_0.jpg` both return 200. (Restore UI is a follow-up; here we only confirm data + URLs resolve.)

- [ ] **Step 4: Record gate result**

No commit. Write the viewcomfy decision + E2E result into the PR/handoff. Proceed only if Step 1 cleared.

---

## Task 10: Backfill migration (legacy thumbnails) + `VACUUM`

Legacy rows only ever held 240px base64 thumbnails (full inputs never existed). The migration writes those thumbnails to disk as `input_thumb_*`, sets `inputThumbnails` URLs, and `VACUUM`s. It does NOT fabricate `inputImages` for legacy rows.

**Files:**
- Create: `scripts/migrate-input-thumbnails.mjs`
- Create: `scripts/__tests__/migrate-input-thumbnails.test.ts`

**Interfaces:**
- `migrateInputThumbnails({ dbPath, inputsDir, dryRun, stripOrphans? }): Promise<{ rowsToMigrate, rowsMigrated, filesWritten, skipped }>`.

Derivation per row: `email` via JOIN; `uuid`+`YYYY`+`MM` from the first image output `filepath` (`<email>/<YYYY>/<MM>/<uuid>.<ext>`). Rows with no image output → strip base64 to `[]` (default). Only `data:image` entries migrated; already-URL rows skipped (idempotent).

- [ ] **Step 1: Write the failing test**

Create `scripts/__tests__/migrate-input-thumbnails.test.ts`:

```ts
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run scripts/__tests__/migrate-input-thumbnails.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the script**

Create `scripts/migrate-input-thumbnails.mjs`:

```js
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run scripts/__tests__/migrate-input-thumbnails.test.ts`
Expected: PASS (2 tests). If `@/scripts/*.mjs` does not resolve under vitest, import via relative path (`../migrate-input-thumbnails.mjs`) and re-run.

- [ ] **Step 5: Dry-run against a COPY of production**

```bash
TMPDB="C:/Users/$USER/AppData/Local/Temp/history-copy.db"
sqlite3 -readonly "C:/viewcomfy_data/database/history.db" ".backup '$TMPDB'"
node scripts/migrate-input-thumbnails.mjs --db "$TMPDB" --inputs "C:/Users/$USER/AppData/Local/Temp/inputs-copy" --dry-run
```

Expected: `rowsToMigrate` ≈ the ~1,456 bloated rows (sanity-check magnitude).

- [ ] **Step 6: Real run against the COPY + verify reclaim**

```bash
ls -la "$TMPDB"   # ~1GB before
node scripts/migrate-input-thumbnails.mjs --db "$TMPDB" --inputs "C:/Users/$USER/AppData/Local/Temp/inputs-copy"
ls -la "$TMPDB"   # expect large drop after VACUUM
sqlite3 -readonly "$TMPDB" "SELECT COUNT(*) FROM generations WHERE prompt_data LIKE '%data:image%';"  # 0
```

Expected: DB shrinks toward ~60-80 MB; no remaining `data:image`; `input_thumb_*` files present under inputs-copy.

- [ ] **Step 7: Commit the script + tests (NOT a prod run)**

```bash
git add scripts/migrate-input-thumbnails.mjs scripts/__tests__/migrate-input-thumbnails.test.ts
git commit -m "feat(scripts): backfill legacy base64 input thumbnails to disk + VACUUM

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

- [ ] **Step 8: Production run runbook (operator-gated, after deploy)**

After Tasks 1-8 are deployed (inputs root + serve route live) and Task 9 cleared, operator runs during low traffic:

1. Backup: `sqlite3 -readonly /data/history.db ".backup '/data/backups/history-pre-inputmig.db'"`.
2. Stop the container (cleanest — no concurrent writers during VACUUM): `docker stop wavespeed-claude`.
3. Run against the volume (path must match the container's `HISTORY_INPUTS_DIR`, default `/data/history_inputs`): `node scripts/migrate-input-thumbnails.mjs --db /data/history.db --inputs /data/history_inputs`.
4. Verify: `sqlite3 -readonly /data/history.db "SELECT COUNT(*) FROM generations WHERE prompt_data LIKE '%data:image%';"` → 0; confirm size dropped.
5. Restart: `docker start wavespeed-claude` (or `start.ps1`). Spot-check history loads and input URLs resolve.
6. Keep the backup ≥1 week.

---

## Future / out of scope (explicit YAGNI)

- **Restore-inputs UI** — the data foundation is complete: `HistoryEntry.inputImages` (full-res URLs) is populated by Task 6, the direct analogue of `entry.prompt` used by prompt-restore. A follow-up adds an "apply inputs" action mirroring `usePromptStore.setPrompt(entry.prompt)`: fetch each `entry.inputImages` URL → `Blob` → `File` → reconstruct `DroppedImage[]` → `setImages(...)` in `generate-form.tsx`. (Legacy rows have only `inputThumbnails`; the UI can disable restore — or restore the thumbnail with a "low-res" note — when `inputImages` is absent.)
- **Showing input thumbnails inline in history cards / ImageDialog** — `inputThumbnails` is on the entry; rendering is a small follow-up.
- **Admin "rebuild inputs" tool** — inputs are source images, not derivable from the output; no rebuild analogue exists. N/A.
- **DB schema columns for input paths** — formula-derivable; no columns, no migration surface (mirrors variants-separation).
- **Re-thumbnailing legacy inputs at higher res** — impossible; legacy rows never stored anything but the 240px thumbnail.

---

## Self-Review

**1. Spec coverage:**
- Stop base64 bloat / store on disk same scheme as outputs → Tasks 1 (root), 5 (POST write); `<email>/<YYYY>/<MM>/input_*`.
- **Full input for faithful restore + thumbnail for display** → Tasks 1 (`writeInputAssets` full+thumb), 4 (`inputImages`+`inputThumbs`), 5 (`inputImages`+`inputThumbnails` fields), 6 (both surfaced on entry), 7 (upload `images[i].file` + thumb blob).
- Identification "which images belong to this prompt" → per-entry `HistoryEntry.inputImages`/`inputThumbnails` + filename `input_<uuid>_*` bound to the generation uuid (Tasks 5/6).
- Backfill legacy (thumbnails only) + VACUUM → Task 10; legacy gets `inputThumbnails` only, no fabricated `inputImages`.
- Backward-compatible read + viewcomfy unknown → Global Constraints, Task 6 dual-format, Task 9 gate before backfill.
- Hard-delete covers the new root → Task 8.
- Read path previously ignored input fields → fixed in Task 6.

**2. Placeholder scan:** No TBD/"handle errors"/"similar to". Every code step shows full code. The glue task (7), gate (9), and runbook (10.8) state explicit verification (suite + tsc + build + manual E2E), not hand-waves.

**3. Type consistency:** `getHistoryInputsDir`, `writeInputAssets(inputsDir, relDir, uuid, items)` with `InputAssetInput = { thumb; full?: { buffer; ext } }`, `inputImageFilename(uuid,index,ext)`, `inputThumbFilename(uuid,index)`, `extFromContentType`, `buildInputAssetUrls(urlPrefix, uuid, items:{ext})` → `{thumbnails, images}`, `UploadHistoryParams.inputImages`/`.inputThumbs`, multipart `inputCount`/`inputfull_<i>`/`inputthumb_<i>`, `prompt_data.inputThumbnails`/`.inputImages`, `HistoryEntry.inputImages`, `rename_outcome.inputs` — all defined and consumed with identical names/shapes across tasks. The full-name regex deliberately excludes thumb names (thumb has non-hex `thumb` where a uuid is required).
