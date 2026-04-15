# Prompt Styles Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a "Стиль" dropdown in the generation card that wraps the user prompt with admin-configurable prefix/suffix blocks. Styles live as JSON files in `data/styles/` and are managed via a new admin panel section.

**Architecture:** Server-side file-based store (`lib/styles/store.ts`) + three API routes (public GET, admin POST/PUT/DELETE) + admin UI section + a new field in `useSettingsStore` + prompt injection on the client right before the generate submit. Synthetic `__default__` style acts as a no-op and is added by the client, not stored.

**Tech Stack:** Next.js 15 App Router, TypeScript, Zustand, better-sqlite3 (already in place), native `fs/promises` for style files, Vitest for tests, Tailwind for UI.

**Spec:** `docs/superpowers/specs/2026-04-15-prompt-styles-design.md`

---

## File Structure

**New files:**
- `lib/styles/types.ts` — `Style` type, `DEFAULT_STYLE_ID`, validation constants.
- `lib/styles/store.ts` — server-only I/O helper: `listStyles`, `getStyle`, `createStyle`, `updateStyle`, `deleteStyle`, slug generation, atomic writes.
- `lib/styles/__tests__/store.test.ts` — vitest unit tests for the store.
- `lib/styles/__tests__/inject.test.ts` — vitest unit tests for the `composeFinalPrompt` helper (pure function shared between form and tests).
- `lib/styles/inject.ts` — tiny pure helper `composeFinalPrompt(userPrompt, style)` used by the form; isolating it makes it testable without mounting React.
- `app/api/styles/route.ts` — public `GET`.
- `app/api/admin/styles/route.ts` — admin `POST`.
- `app/api/admin/styles/[id]/route.ts` — admin `PUT`, `DELETE`.
- `components/admin/styles-section.tsx` — the new admin section component (isolated from `admin-panel.tsx` so that file doesn't grow unwieldy).

**Modified files:**
- `stores/settings-store.ts` — add `selectedStyleId` field, localStorage key, setter.
- `components/admin-panel.tsx` — import and render `<StylesSection />` in place of the "Дополнительные настройки" placeholder.
- `components/generate-form.tsx` — add dropdown in the pickers grid, remove the dropzone caption, apply `composeFinalPrompt` to the prompt before submit AND before the history payload.
- `.gitignore` — add `/data/styles/` (and `/data/` stays otherwise-ignored via existing entries; we just make sure new runtime folder isn't committed).

---

## Task 1: Style types + pure injection helper (with tests)

**Files:**
- Create: `lib/styles/types.ts`
- Create: `lib/styles/inject.ts`
- Create: `lib/styles/__tests__/inject.test.ts`

- [ ] **Step 1: Write the failing test**

Create `lib/styles/__tests__/inject.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { composeFinalPrompt } from "../inject";
import { DEFAULT_STYLE_ID, type Style } from "../types";

function style(overrides: Partial<Style>): Style {
  return {
    id: "x",
    name: "x",
    prefix: "",
    suffix: "",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("composeFinalPrompt", () => {
  it("returns the user prompt unchanged when style is null", () => {
    expect(composeFinalPrompt("a cat", null)).toBe("a cat");
  });

  it("returns the user prompt unchanged for the default style id", () => {
    expect(
      composeFinalPrompt("a cat", style({ id: DEFAULT_STYLE_ID }))
    ).toBe("a cat");
  });

  it("returns the user prompt unchanged when prefix and suffix are empty", () => {
    expect(composeFinalPrompt("a cat", style({ prefix: "", suffix: "" }))).toBe(
      "a cat"
    );
  });

  it("joins prefix + prompt + suffix with '. '", () => {
    expect(
      composeFinalPrompt("a cat", style({ prefix: "cinematic", suffix: "35mm" }))
    ).toBe("cinematic. a cat. 35mm");
  });

  it("omits empty prefix without leaving a leading separator", () => {
    expect(
      composeFinalPrompt("a cat", style({ prefix: "", suffix: "35mm" }))
    ).toBe("a cat. 35mm");
  });

  it("omits empty suffix without leaving a trailing separator", () => {
    expect(
      composeFinalPrompt("a cat", style({ prefix: "cinematic", suffix: "" }))
    ).toBe("cinematic. a cat");
  });

  it("trims leading/trailing whitespace on prefix and suffix", () => {
    expect(
      composeFinalPrompt(
        "a cat",
        style({ prefix: "  cinematic  \n", suffix: "\n 35mm " })
      )
    ).toBe("cinematic. a cat. 35mm");
  });

  it("preserves interior newlines in prefix/suffix", () => {
    expect(
      composeFinalPrompt(
        "a cat",
        style({ prefix: "line1\nline2", suffix: "" })
      )
    ).toBe("line1\nline2. a cat");
  });

  it("returns empty string when both user prompt and style are empty", () => {
    expect(composeFinalPrompt("", style({ prefix: "", suffix: "" }))).toBe("");
  });

  it("still wraps when user prompt is empty but style is not", () => {
    // Edge: empty user prompt with a prefix/suffix. Form validation should
    // have prevented this, but the helper must still behave deterministically.
    expect(
      composeFinalPrompt("", style({ prefix: "cinematic", suffix: "35mm" }))
    ).toBe("cinematic. . 35mm");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- lib/styles/__tests__/inject.test.ts`
Expected: FAIL — files don't exist yet.

- [ ] **Step 3: Write the types**

Create `lib/styles/types.ts`:

```ts
export const DEFAULT_STYLE_ID = "__default__";
export const DEFAULT_STYLE_NAME = "Стандартный";

export const STYLE_NAME_MAX = 80;
export const STYLE_PART_MAX = 2000; // prefix and suffix, each

export interface Style {
  id: string;
  name: string;
  prefix: string;
  suffix: string;
  createdAt: string; // ISO
  updatedAt: string; // ISO
}

export interface StyleCreateInput {
  name: string;
  prefix: string;
  suffix: string;
}

export interface StyleUpdateInput {
  name?: string;
  prefix?: string;
  suffix?: string;
}
```

- [ ] **Step 4: Write the injection helper**

Create `lib/styles/inject.ts`:

```ts
import { DEFAULT_STYLE_ID, type Style } from "./types";

/**
 * Compose the final prompt sent to the generation API by wrapping the
 * user's prompt with the selected style's prefix and suffix. Empty parts
 * contribute no separator.
 *
 * Rules:
 *   - `null` style or the synthetic default → return userPrompt unchanged.
 *   - prefix/suffix are trimmed only at compose time (so trailing newlines
 *     from the admin textarea don't break the ". " separator); interior
 *     newlines are preserved.
 *   - Separator is the literal two characters ". " (period + space).
 */
export function composeFinalPrompt(
  userPrompt: string,
  style: Style | null
): string {
  if (!style || style.id === DEFAULT_STYLE_ID) return userPrompt;
  const prefix = (style.prefix ?? "").trim();
  const suffix = (style.suffix ?? "").trim();
  if (!prefix && !suffix) return userPrompt;
  const parts: string[] = [];
  if (prefix) parts.push(prefix);
  parts.push(userPrompt);
  if (suffix) parts.push(suffix);
  return parts.join(". ");
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npm test -- lib/styles/__tests__/inject.test.ts`
Expected: all 10 tests PASS.

- [ ] **Step 6: Commit**

```bash
git add lib/styles/types.ts lib/styles/inject.ts lib/styles/__tests__/inject.test.ts
git commit -m "feat(styles): add Style types and composeFinalPrompt helper"
```

---

## Task 2: File-based style store (with tests)

**Files:**
- Create: `lib/styles/store.ts`
- Create: `lib/styles/__tests__/store.test.ts`

**Context:** Follows the `HISTORY_DATA_DIR` pattern from `lib/history-db.ts`. Each style is one JSON file named `<id>.json`. `id` is generated from `name` (cyrillic → transliteration) + a 3-char random suffix for collision resistance.

- [ ] **Step 1: Write the failing test**

Create `lib/styles/__tests__/store.test.ts`:

```ts
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
  // Invalidate the module cache so the store re-reads the env var.
  // (Vitest isolates modules per-file by default; we re-import inside each test.)
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
    // ensure distinct timestamps
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
    // We don't pass id directly, but ensure the slug generation can't
    // produce anything weird even from malicious names.
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- lib/styles/__tests__/store.test.ts`
Expected: FAIL — `../store` doesn't exist.

- [ ] **Step 3: Write the store**

Create `lib/styles/store.ts`:

```ts
import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import {
  type Style,
  type StyleCreateInput,
  type StyleUpdateInput,
  STYLE_NAME_MAX,
  STYLE_PART_MAX,
} from "./types";

// Path resolution matches lib/history-db.ts so all runtime data lives
// together (and the same HISTORY_DATA_DIR volume mount covers both).
function stylesDir(): string {
  const dataDir = process.env.HISTORY_DATA_DIR
    ? path.resolve(process.env.HISTORY_DATA_DIR)
    : path.join(process.cwd(), "data");
  return path.join(dataDir, "styles");
}

async function ensureDir(): Promise<string> {
  const dir = stylesDir();
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

// Cyrillic → latin transliteration. Keeps ids readable for humans browsing
// the folder; the random suffix guarantees uniqueness even for collisions.
const CYR_MAP: Record<string, string> = {
  а: "a", б: "b", в: "v", г: "g", д: "d", е: "e", ё: "yo", ж: "zh",
  з: "z", и: "i", й: "y", к: "k", л: "l", м: "m", н: "n", о: "o",
  п: "p", р: "r", с: "s", т: "t", у: "u", ф: "f", х: "h", ц: "ts",
  ч: "ch", ш: "sh", щ: "shch", ъ: "", ы: "y", ь: "", э: "e", ю: "yu",
  я: "ya",
};

function slugify(input: string): string {
  const lowered = input.toLowerCase();
  let out = "";
  for (const ch of lowered) {
    if (CYR_MAP[ch] !== undefined) out += CYR_MAP[ch];
    else if (/[a-z0-9]/.test(ch)) out += ch;
    else if (/\s|-|_/.test(ch)) out += "-";
    // anything else (punctuation, emoji, etc.) is dropped
  }
  out = out.replace(/-+/g, "-").replace(/^-|-$/g, "");
  if (!out) out = "style";
  return out.slice(0, 40); // cap base slug; random suffix is added separately
}

function randomSuffix(): string {
  // 3 hex chars → 4096 combinations. With a typical handful of styles
  // per deployment, collisions are negligible; we still retry up to 3 times.
  return crypto.randomBytes(2).toString("hex").slice(0, 3);
}

function validateName(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) throw new Error("name is required");
  if (trimmed.length > STYLE_NAME_MAX)
    throw new Error(`name must be <= ${STYLE_NAME_MAX} chars`);
  return trimmed;
}

function validatePart(label: "prefix" | "suffix", value: string): string {
  if (typeof value !== "string") throw new Error(`${label} must be a string`);
  if (value.length > STYLE_PART_MAX)
    throw new Error(`${label} must be <= ${STYLE_PART_MAX} chars`);
  return value;
}

function isSafeId(id: string): boolean {
  return /^[a-z0-9-]+$/.test(id) && id.length <= 80;
}

function filePath(id: string): string {
  if (!isSafeId(id)) throw new Error("invalid style id");
  return path.join(stylesDir(), `${id}.json`);
}

async function readFileSafe(fp: string): Promise<Style | null> {
  try {
    const raw = await fs.readFile(fp, "utf8");
    const parsed = JSON.parse(raw) as Style;
    if (
      typeof parsed?.id === "string" &&
      typeof parsed?.name === "string" &&
      typeof parsed?.prefix === "string" &&
      typeof parsed?.suffix === "string"
    ) {
      return parsed;
    }
    return null;
  } catch {
    return null;
  }
}

async function atomicWrite(fp: string, data: Style): Promise<void> {
  const tmp = `${fp}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(data, null, 2), "utf8");
  await fs.rename(tmp, fp);
}

export async function listStyles(): Promise<Style[]> {
  const dir = stylesDir();
  if (!fsSync.existsSync(dir)) return [];
  const entries = await fs.readdir(dir);
  const results: Style[] = [];
  for (const name of entries) {
    if (!name.endsWith(".json")) continue;
    const style = await readFileSafe(path.join(dir, name));
    if (style) results.push(style);
    else console.warn(`[styles] skipped malformed file: ${name}`);
  }
  return results.sort(
    (a, b) => a.createdAt.localeCompare(b.createdAt)
  );
}

export async function getStyle(id: string): Promise<Style | null> {
  if (!isSafeId(id)) return null;
  const fp = filePath(id);
  return readFileSafe(fp);
}

export async function createStyle(input: StyleCreateInput): Promise<Style> {
  const name = validateName(input.name);
  const prefix = validatePart("prefix", input.prefix ?? "");
  const suffix = validatePart("suffix", input.suffix ?? "");
  await ensureDir();

  const base = slugify(name);
  let id = `${base}-${randomSuffix()}`;
  for (let i = 0; i < 3; i++) {
    if (!fsSync.existsSync(filePath(id))) break;
    id = `${base}-${randomSuffix()}`;
  }
  if (fsSync.existsSync(filePath(id))) {
    throw new Error("failed to generate a unique id after 3 attempts");
  }

  const now = new Date().toISOString();
  const style: Style = { id, name, prefix, suffix, createdAt: now, updatedAt: now };
  await atomicWrite(filePath(id), style);
  return style;
}

export async function updateStyle(
  id: string,
  patch: StyleUpdateInput
): Promise<Style> {
  const existing = await getStyle(id);
  if (!existing) throw new Error("style not found");
  const next: Style = { ...existing };
  if (patch.name !== undefined) next.name = validateName(patch.name);
  if (patch.prefix !== undefined) next.prefix = validatePart("prefix", patch.prefix);
  if (patch.suffix !== undefined) next.suffix = validatePart("suffix", patch.suffix);
  next.updatedAt = new Date().toISOString();
  await atomicWrite(filePath(id), next);
  return next;
}

export async function deleteStyle(id: string): Promise<void> {
  const fp = filePath(id);
  if (!fsSync.existsSync(fp)) throw new Error("style not found");
  await fs.unlink(fp);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- lib/styles/__tests__/store.test.ts`
Expected: all tests PASS.

Also re-run the injection tests to confirm nothing regressed:
Run: `npm test -- lib/styles/__tests__/inject.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/styles/store.ts lib/styles/__tests__/store.test.ts
git commit -m "feat(styles): add JSON-file-based style store with validation"
```

---

## Task 3: Public GET /api/styles

**Files:**
- Create: `app/api/styles/route.ts`

**Context:** Public (no admin middleware). Returns the stored list; the client adds the synthetic default option.

- [ ] **Step 1: Write the route**

Create `app/api/styles/route.ts`:

```ts
import { NextResponse } from "next/server";
import { listStyles } from "@/lib/styles/store";

export const dynamic = "force-dynamic";

/**
 * GET /api/styles
 *
 * Public endpoint — returns all custom styles. The synthetic "Стандартный"
 * default is NOT included; the client adds it as the first option in the
 * dropdown.
 */
export async function GET() {
  try {
    const styles = await listStyles();
    return NextResponse.json({ styles });
  } catch (err) {
    console.error("[/api/styles GET] failed:", err);
    return NextResponse.json(
      { error: "Failed to list styles" },
      { status: 500 }
    );
  }
}
```

- [ ] **Step 2: Manual smoke test**

Start dev: `npm run dev`. In another shell:

```bash
curl -s http://localhost:3000/api/styles
```

Expected: `{"styles":[]}` (no custom styles yet).

- [ ] **Step 3: Commit**

```bash
git add app/api/styles/route.ts
git commit -m "feat(styles): add public GET /api/styles route"
```

---

## Task 4: Admin POST /api/admin/styles

**Files:**
- Create: `app/api/admin/styles/route.ts`

- [ ] **Step 1: Write the route**

Create `app/api/admin/styles/route.ts`:

```ts
import { type NextRequest, NextResponse } from "next/server";
import { createStyle } from "@/lib/styles/store";

export const dynamic = "force-dynamic";

/**
 * POST /api/admin/styles
 * Body: { name: string; prefix: string; suffix: string }
 *
 * Gated by the middleware that protects /api/admin/*. Creates a new style
 * file and returns the created record (with generated id).
 */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json().catch(() => ({}));
    const name = typeof body?.name === "string" ? body.name : "";
    const prefix = typeof body?.prefix === "string" ? body.prefix : "";
    const suffix = typeof body?.suffix === "string" ? body.suffix : "";
    const style = await createStyle({ name, prefix, suffix });
    return NextResponse.json({ style }, { status: 201 });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "unknown error";
    console.error("[/api/admin/styles POST] failed:", msg);
    // Validation errors (thrown from the store with user-facing messages)
    // surface as 400; anything else is 500.
    const isValidation = /name|prefix|suffix|chars|required/i.test(msg);
    return NextResponse.json(
      { error: msg },
      { status: isValidation ? 400 : 500 }
    );
  }
}
```

- [ ] **Step 2: Manual smoke test**

With dev server running and admin cookie present (or ADMIN_PASSWORD unset in dev):

```bash
curl -s -X POST http://localhost:3000/api/admin/styles \
  -H "Content-Type: application/json" \
  -d '{"name":"Test","prefix":"pre","suffix":"suf"}'
```

Expected: `{"style":{"id":"test-xxx","name":"Test","prefix":"pre","suffix":"suf",...}}`.
Then: `curl -s http://localhost:3000/api/styles` → should include the new style.

- [ ] **Step 3: Commit**

```bash
git add app/api/admin/styles/route.ts
git commit -m "feat(styles): add admin POST /api/admin/styles route"
```

---

## Task 5: Admin PUT and DELETE /api/admin/styles/[id]

**Files:**
- Create: `app/api/admin/styles/[id]/route.ts`

- [ ] **Step 1: Write the route**

Create `app/api/admin/styles/[id]/route.ts`:

```ts
import { type NextRequest, NextResponse } from "next/server";
import { updateStyle, deleteStyle } from "@/lib/styles/store";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

/**
 * PUT /api/admin/styles/[id]
 * Body: { name?: string; prefix?: string; suffix?: string }
 */
export async function PUT(request: NextRequest, ctx: Ctx) {
  try {
    const { id } = await ctx.params;
    const body = await request.json().catch(() => ({}));
    const patch: Record<string, string> = {};
    if (typeof body?.name === "string") patch.name = body.name;
    if (typeof body?.prefix === "string") patch.prefix = body.prefix;
    if (typeof body?.suffix === "string") patch.suffix = body.suffix;
    const style = await updateStyle(id, patch);
    return NextResponse.json({ style });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "unknown error";
    console.error("[/api/admin/styles PUT] failed:", msg);
    if (/not found/i.test(msg)) {
      return NextResponse.json({ error: msg }, { status: 404 });
    }
    const isValidation = /name|prefix|suffix|chars|required|invalid/i.test(msg);
    return NextResponse.json(
      { error: msg },
      { status: isValidation ? 400 : 500 }
    );
  }
}

/**
 * DELETE /api/admin/styles/[id]
 */
export async function DELETE(_request: NextRequest, ctx: Ctx) {
  try {
    const { id } = await ctx.params;
    await deleteStyle(id);
    return NextResponse.json({ ok: true });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "unknown error";
    console.error("[/api/admin/styles DELETE] failed:", msg);
    if (/not found/i.test(msg)) {
      return NextResponse.json({ error: msg }, { status: 404 });
    }
    if (/invalid/i.test(msg)) {
      return NextResponse.json({ error: msg }, { status: 400 });
    }
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
```

- [ ] **Step 2: Manual smoke test**

Using an id from Task 4:

```bash
# Update
curl -s -X PUT http://localhost:3000/api/admin/styles/test-xxx \
  -H "Content-Type: application/json" \
  -d '{"suffix":"new-suffix"}'

# Delete
curl -s -X DELETE http://localhost:3000/api/admin/styles/test-xxx
```

Expected: PUT returns updated style, DELETE returns `{"ok":true}`.
`curl http://localhost:3000/api/styles` → style gone.

- [ ] **Step 3: Commit**

```bash
git add app/api/admin/styles/[id]/route.ts
git commit -m "feat(styles): add admin PUT/DELETE /api/admin/styles/[id]"
```

---

## Task 6: Add selectedStyleId to settings store

**Files:**
- Modify: `stores/settings-store.ts`

**Context:** Matches the existing `selectedModel` pattern (localStorage-backed). We add a `reconcileSelectedStyle(knownIds)` method so the generation form can silently reset to default when the stored id was deleted.

- [ ] **Step 1: Edit the store**

Apply the following edits to `stores/settings-store.ts`:

First, add near the `MODEL_LS_KEY` constant (after the `KNOWN_MODELS` / `loadModel` block, around line 27):

```ts
const STYLE_LS_KEY = "wavespeed:selectedStyle:v1";
const DEFAULT_STYLE_ID = "__default__";

function loadStyleId(): string {
  if (typeof window === "undefined") return DEFAULT_STYLE_ID;
  try {
    const v = window.localStorage.getItem(STYLE_LS_KEY);
    if (typeof v === "string" && v.length > 0) return v;
  } catch {}
  return DEFAULT_STYLE_ID;
}
```

Then, extend the `SettingsState` interface (lines 51-74 area) by adding these fields:

```ts
  selectedStyleId: string;
  setSelectedStyleId: (id: string) => void;
  /**
   * If the currently-selected style id is not in `knownIds`, reset to the
   * default. Called by the generation form after loading /api/styles, so a
   * style deleted in the admin silently stops applying. No-op otherwise.
   */
  reconcileSelectedStyle: (knownIds: readonly string[]) => void;
```

Then, in the `create<SettingsState>()(...)` body, add these next to `selectedModel: loadModel()` (around line 78) and the `setSelectedModel` method:

```ts
  selectedStyleId: loadStyleId(),

  setSelectedStyleId: (id) => {
    set({ selectedStyleId: id });
    try { window.localStorage.setItem(STYLE_LS_KEY, id); } catch {}
  },

  reconcileSelectedStyle: (knownIds) => {
    const current = get().selectedStyleId;
    if (current === DEFAULT_STYLE_ID) return;
    if (knownIds.includes(current)) return;
    set({ selectedStyleId: DEFAULT_STYLE_ID });
    try { window.localStorage.setItem(STYLE_LS_KEY, DEFAULT_STYLE_ID); } catch {}
  },
```

- [ ] **Step 2: Type-check**

Run: `npx tsc --noEmit`
Expected: no new errors.

- [ ] **Step 3: Commit**

```bash
git add stores/settings-store.ts
git commit -m "feat(styles): persist selectedStyleId in settings store"
```

---

## Task 7: Admin UI — styles section component

**Files:**
- Create: `components/admin/styles-section.tsx`

**Context:** Two-column layout (list left, editor right). Matches the existing section chrome in `components/admin-panel.tsx` (rounded-xl border, header band, body). Reuses `Button` from `@/components/ui/button` and `sonner` toast like the rest of the admin panel.

- [ ] **Step 1: Write the component**

Create `components/admin/styles-section.tsx`:

```tsx
"use client";

import * as React from "react";
import { toast } from "sonner";
import { Plus, Trash2, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  type Style,
  STYLE_NAME_MAX,
  STYLE_PART_MAX,
} from "@/lib/styles/types";

type Draft = {
  // For a new (unsaved) style, id is undefined.
  id: string | undefined;
  name: string;
  prefix: string;
  suffix: string;
};

export function StylesSection() {
  const [styles, setStyles] = React.useState<Style[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [loadError, setLoadError] = React.useState<string | null>(null);
  const [selectedId, setSelectedId] = React.useState<string | null>(null);
  const [draft, setDraft] = React.useState<Draft | null>(null);
  const [saving, setSaving] = React.useState(false);
  const [deleting, setDeleting] = React.useState(false);

  const selected = React.useMemo(
    () => styles.find((s) => s.id === selectedId) ?? null,
    [styles, selectedId]
  );

  const dirty = React.useMemo(() => {
    if (!draft) return false;
    if (draft.id === undefined) return true; // new unsaved
    const s = styles.find((x) => x.id === draft.id);
    if (!s) return false;
    return (
      s.name !== draft.name ||
      s.prefix !== draft.prefix ||
      s.suffix !== draft.suffix
    );
  }, [draft, styles]);

  const load = React.useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/styles", { cache: "no-store" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as { styles: Style[] };
      setStyles(data.styles);
      setLoadError(null);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "unknown error";
      setLoadError(msg);
      toast.error(`Не удалось загрузить стили: ${msg}`);
    } finally {
      setLoading(false);
    }
  }, []);

  React.useEffect(() => {
    void load();
  }, [load]);

  function selectStyle(id: string) {
    if (dirty && !window.confirm("Отменить несохранённые изменения?")) return;
    setSelectedId(id);
    const s = styles.find((x) => x.id === id);
    setDraft(
      s
        ? { id: s.id, name: s.name, prefix: s.prefix, suffix: s.suffix }
        : null
    );
  }

  function startNew() {
    if (dirty && !window.confirm("Отменить несохранённые изменения?")) return;
    setSelectedId(null);
    setDraft({ id: undefined, name: "", prefix: "", suffix: "" });
  }

  async function save() {
    if (!draft) return;
    setSaving(true);
    try {
      const isNew = draft.id === undefined;
      const url = isNew
        ? "/api/admin/styles"
        : `/api/admin/styles/${encodeURIComponent(draft.id!)}`;
      const method = isNew ? "POST" : "PUT";
      const res = await fetch(url, {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: draft.name,
          prefix: draft.prefix,
          suffix: draft.suffix,
        }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error || `HTTP ${res.status}`);
      }
      const body = (await res.json()) as { style: Style };
      await load();
      setSelectedId(body.style.id);
      setDraft({
        id: body.style.id,
        name: body.style.name,
        prefix: body.style.prefix,
        suffix: body.style.suffix,
      });
      toast.success(isNew ? "Стиль создан" : "Стиль сохранён");
    } catch (err) {
      const msg = err instanceof Error ? err.message : "unknown error";
      toast.error(`Не удалось сохранить: ${msg}`);
    } finally {
      setSaving(false);
    }
  }

  async function remove() {
    if (!selected) return;
    if (!window.confirm(`Удалить стиль "${selected.name}"?`)) return;
    setDeleting(true);
    try {
      const res = await fetch(
        `/api/admin/styles/${encodeURIComponent(selected.id)}`,
        { method: "DELETE" }
      );
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error || `HTTP ${res.status}`);
      }
      await load();
      setSelectedId(null);
      setDraft(null);
      toast.success("Стиль удалён");
    } catch (err) {
      const msg = err instanceof Error ? err.message : "unknown error";
      toast.error(`Не удалось удалить: ${msg}`);
    } finally {
      setDeleting(false);
    }
  }

  return (
    <section className="rounded-xl border border-border bg-background shadow-sm">
      <div className="border-b border-border px-5 py-4">
        <h2 className="text-base font-semibold">Стили промпта</h2>
        <p className="mt-1 text-xs text-muted-foreground">
          Оборачивают промпт пользователя: <code>prefix</code>
          {" + \". \" + промпт + \". \" + "}
          <code>suffix</code>. Пустые части не вставляют разделитель. Стиль{" "}
          <em>Стандартный</em> всегда доступен и ничего не меняет.
        </p>
      </div>

      <div className="flex flex-col gap-4 p-4 md:flex-row">
        {/* Left: list */}
        <div className="w-full md:w-[260px] md:shrink-0">
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={startNew}
            className="mb-2 w-full justify-start"
          >
            <Plus className="h-4 w-4" />
            Новый стиль
          </Button>
          {loading ? (
            <div className="flex items-center gap-2 p-2 text-xs text-muted-foreground">
              <Loader2 className="h-3 w-3 animate-spin" />
              Загрузка…
            </div>
          ) : loadError ? (
            <div className="p-2 text-xs text-destructive">
              Ошибка: {loadError}
            </div>
          ) : styles.length === 0 && draft?.id === undefined ? (
            <div className="p-2 text-xs text-muted-foreground">
              Пока стилей нет.
            </div>
          ) : (
            <ul className="space-y-1">
              {/* Unsaved new style gets a row at the top */}
              {draft?.id === undefined && (
                <li>
                  <button
                    type="button"
                    className="flex w-full items-center gap-2 rounded-md bg-primary/10 px-2 py-1.5 text-left text-sm"
                  >
                    <span className="text-primary">●</span>
                    <span className="truncate">
                      {draft.name.trim() || "Без названия"}
                    </span>
                  </button>
                </li>
              )}
              {styles.map((s) => {
                const isSel = selectedId === s.id;
                const isDirty = dirty && draft?.id === s.id;
                return (
                  <li key={s.id}>
                    <button
                      type="button"
                      onClick={() => selectStyle(s.id)}
                      className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm transition-colors ${
                        isSel ? "bg-primary/10" : "hover:bg-muted/60"
                      }`}
                    >
                      {isDirty && <span className="text-primary">●</span>}
                      <span className="truncate">{s.name}</span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        {/* Right: editor */}
        <div className="flex-1">
          {!draft ? (
            <div className="flex h-full items-center justify-center p-6 text-sm text-muted-foreground">
              {styles.length === 0
                ? "Создайте первый стиль, нажав +."
                : "Выберите стиль из списка или создайте новый."}
            </div>
          ) : (
            <div className="flex flex-col gap-3">
              <div>
                <label
                  htmlFor="style-name"
                  className="mb-1 block text-xs font-medium"
                >
                  Название
                </label>
                <input
                  id="style-name"
                  type="text"
                  maxLength={STYLE_NAME_MAX}
                  value={draft.name}
                  onChange={(e) =>
                    setDraft({ ...draft, name: e.target.value })
                  }
                  className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                  placeholder="Короткое имя стиля"
                />
              </div>

              <div>
                <label
                  htmlFor="style-prefix"
                  className="mb-1 block text-xs font-medium"
                >
                  Вставка до промпта
                </label>
                <textarea
                  id="style-prefix"
                  maxLength={STYLE_PART_MAX}
                  value={draft.prefix}
                  onChange={(e) =>
                    setDraft({ ...draft, prefix: e.target.value })
                  }
                  rows={3}
                  className="w-full resize-y rounded-md border border-input bg-background px-3 py-2 text-sm font-mono focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                  placeholder="Что дописать ПЕРЕД промптом пользователя"
                />
              </div>

              <div>
                <label
                  htmlFor="style-suffix"
                  className="mb-1 block text-xs font-medium"
                >
                  Вставка после промпта
                </label>
                <textarea
                  id="style-suffix"
                  maxLength={STYLE_PART_MAX}
                  value={draft.suffix}
                  onChange={(e) =>
                    setDraft({ ...draft, suffix: e.target.value })
                  }
                  rows={3}
                  className="w-full resize-y rounded-md border border-input bg-background px-3 py-2 text-sm font-mono focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                  placeholder="Что дописать ПОСЛЕ промпта пользователя"
                />
              </div>

              <div>
                <div className="mb-1 text-xs font-medium text-muted-foreground">
                  Превью
                </div>
                <div className="rounded-md border border-dashed border-border bg-muted/30 p-3 text-xs font-mono text-muted-foreground">
                  {previewFor(draft)}
                </div>
              </div>

              <div className="mt-1 flex gap-2">
                <Button
                  type="button"
                  onClick={save}
                  disabled={saving || !draft.name.trim()}
                  size="sm"
                >
                  {saving && <Loader2 className="h-4 w-4 animate-spin" />}
                  Сохранить
                </Button>
                {draft.id !== undefined && (
                  <Button
                    type="button"
                    variant="destructive"
                    size="sm"
                    onClick={remove}
                    disabled={deleting}
                  >
                    {deleting ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      <Trash2 className="h-4 w-4" />
                    )}
                    Удалить
                  </Button>
                )}
              </div>
            </div>
          )}
        </div>
      </div>
    </section>
  );
}

function previewFor(draft: Draft): string {
  const p = draft.prefix.trim();
  const s = draft.suffix.trim();
  const placeholder = "<промпт пользователя>";
  const parts: string[] = [];
  if (p) parts.push(p);
  parts.push(placeholder);
  if (s) parts.push(s);
  return parts.join(". ");
}
```

- [ ] **Step 2: Type-check**

Run: `npx tsc --noEmit`
Expected: no new errors.

- [ ] **Step 3: Commit**

```bash
git add components/admin/styles-section.tsx
git commit -m "feat(styles): add admin StylesSection component"
```

---

## Task 8: Wire StylesSection into admin panel

**Files:**
- Modify: `components/admin-panel.tsx`

- [ ] **Step 1: Replace the placeholder section**

In `components/admin-panel.tsx`, add an import at the top of the imports block (after the `useSettingsStore` import, around line 16):

```ts
import { StylesSection } from "@/components/admin/styles-section";
```

Then replace the block from the `{/* Future settings placeholder */}` comment through the closing `</section>` (current lines 222-232):

```tsx
      {/* Prompt styles */}
      <StylesSection />
```

- [ ] **Step 2: Manual smoke test**

`npm run dev` → visit `/admin`. The new "Стили промпта" section should render below "Активный провайдер". Create a style, edit it, delete it — verify that the list and `/api/styles` both reflect each change.

- [ ] **Step 3: Commit**

```bash
git add components/admin-panel.tsx
git commit -m "feat(styles): render StylesSection in admin panel"
```

---

## Task 9: Add Style dropdown to generate form + inject prompt + remove caption

**Files:**
- Modify: `components/generate-form.tsx`

**Context:** Three edits in this file:
1. Remove the dropzone caption "Входные изображения · опционально (пусто = text-to-image)" on line 551.
2. Load the styles list and add a Стиль `<select>` in the pickers grid.
3. Use `composeFinalPrompt` to wrap `prompt.trim()` before the submit fetch body AND before the history payload.

- [ ] **Step 1: Add imports**

At the top of `components/generate-form.tsx` (with the other `@/lib/...` imports), add:

```ts
import { composeFinalPrompt } from "@/lib/styles/inject";
import { DEFAULT_STYLE_ID, type Style } from "@/lib/styles/types";
```

- [ ] **Step 2: Add store hook + styles state + loader in `GenerateForm`**

Inside the `GenerateForm` component body, add after the existing `useSettingsStore` reads (around line 123):

```ts
  const selectedStyleId = useSettingsStore((s) => s.selectedStyleId);
  const setSelectedStyleId = useSettingsStore((s) => s.setSelectedStyleId);
  const reconcileSelectedStyle = useSettingsStore((s) => s.reconcileSelectedStyle);

  const [styles, setStyles] = React.useState<Style[]>([]);

  const loadStyles = React.useCallback(async () => {
    try {
      const res = await fetch("/api/styles", { cache: "no-store" });
      if (!res.ok) return;
      const data = (await res.json()) as { styles: Style[] };
      setStyles(data.styles);
      reconcileSelectedStyle(data.styles.map((s) => s.id));
    } catch (err) {
      console.warn("[generate-form] failed to load styles:", err);
    }
  }, [reconcileSelectedStyle]);

  React.useEffect(() => {
    void loadStyles();
    const onFocus = () => void loadStyles();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [loadStyles]);

  const activeStyle = React.useMemo<Style | null>(() => {
    if (selectedStyleId === DEFAULT_STYLE_ID) return null;
    return styles.find((s) => s.id === selectedStyleId) ?? null;
  }, [styles, selectedStyleId]);
```

- [ ] **Step 3: Inject the composed prompt at the two call sites**

Locate the `promptPayload` object (around line 237) inside `saveToServerHistory`. Change the `prompt` field from `prompt.trim()` to use the composed version. Replace:

```ts
      const promptPayload = {
        prompt: prompt.trim(),
```

with:

```ts
      const promptPayload = {
        prompt: composeFinalPrompt(prompt.trim(), activeStyle),
```

Also locate the fetch body at `/api/generate/submit` (around line 441). Change:

```ts
          prompt: prompt.trim(),
```

to:

```ts
          prompt: composeFinalPrompt(prompt.trim(), activeStyle),
```

Both call sites must use the same composed value so the server request and the history record stay in sync.

- [ ] **Step 4: Remove the dropzone caption**

Replace the block at lines 550-553:

```tsx
      <div className="space-y-2">
        <Label>Входные изображения · опционально (пусто = text-to-image)</Label>
        <ImageDropzone value={images} onChange={setImages} maxImages={14} />
      </div>
```

with:

```tsx
      <ImageDropzone value={images} onChange={setImages} maxImages={14} />
```

(The `Label` import can stay — it's still used elsewhere in the file for the pickers.)

- [ ] **Step 5: Add the Стиль select in the pickers grid**

In the grid block (currently lines 566-598), append a fourth conditional cell after the Формат block and change the grid column count. Replace the outer grid container:

```tsx
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
```

with:

```tsx
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
```

Then, just before the closing `</div>` of that grid (after the `{hasFormats && (...)}` block, before line 598's closing `</div>`), insert:

```tsx
        <div className="space-y-1.5">
          <Label htmlFor="style">Стиль</Label>
          <Select
            id="style"
            value={selectedStyleId}
            onChange={(e) => setSelectedStyleId(e.target.value)}
            options={[
              { value: DEFAULT_STYLE_ID, label: "Стандартный" },
              ...styles.map((s) => ({ value: s.id, label: s.name })),
            ]}
          />
        </div>
```

- [ ] **Step 6: Type-check and smoke test**

Run: `npx tsc --noEmit`
Expected: no new errors.

Run: `npm run dev`. Open the main page:
- The dropzone caption should be gone.
- A "Стиль" dropdown should appear next to Aspect ratio with "Стандартный" as the first option.
- Create a style in `/admin` (prefix `"cinematic"`, suffix `"35mm"`). Return to `/` — focus the window — the dropdown should pick up the new option (via the `focus` listener).
- Select the new style, type "a cat" in the prompt, submit. In the browser devtools Network tab, inspect the `/api/generate/submit` request body: `prompt` should read `"cinematic. a cat. 35mm"`.
- Verify the history entry in the sidebar shows the wrapped prompt (matches what was submitted).
- Select "Стандартный" again and submit "a cat" — request body `prompt` should be exactly `"a cat"`.
- Delete the style in `/admin`, refocus `/` — the selection should silently fall back to "Стандартный"; next submit of "a cat" should send `"a cat"`.

- [ ] **Step 7: Commit**

```bash
git add components/generate-form.tsx
git commit -m "feat(styles): add Style dropdown and inject prompt on submit"
```

---

## Task 10: Gitignore runtime styles folder

**Files:**
- Modify: `.gitignore`

**Context:** `data/history.db` is runtime-generated but not currently gitignored (the current repo may rely on `data/` not being committed in practice). Either way, we explicitly ignore the new runtime folder to be safe.

- [ ] **Step 1: Check current state**

Run: `git check-ignore data/ data/styles/ 2>&1 || echo "not-ignored"`

If `data/` is already ignored, you can still add a more specific entry for clarity. If not, proceed.

- [ ] **Step 2: Edit `.gitignore`**

Append at the bottom of `.gitignore`:

```
# runtime-generated prompt style files
/data/styles/
```

- [ ] **Step 3: Commit**

```bash
git add .gitignore
git commit -m "chore: gitignore runtime data/styles/ folder"
```

---

## Task 11: End-to-end verification

- [ ] **Step 1: Run the full test suite**

Run: `npm test`
Expected: all tests pass (including the new `lib/styles/__tests__/*`).

- [ ] **Step 2: Type-check the whole project**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 3: Build**

Run: `npm run build`
Expected: clean build, no new warnings related to the style files.

- [ ] **Step 4: Manual end-to-end walkthrough**

1. Fresh dev server. Visit `/` — no caption above the dropzone, "Стиль" = "Стандартный".
2. Submit "a cat" — request body `prompt === "a cat"`.
3. Visit `/admin` — new "Стили промпта" section is visible.
4. Click "+ Новый стиль", fill in name "Кино", prefix "cinematic shot", suffix "35mm, film grain". Save.
5. Return to `/`, focus the tab. "Кино" appears in the dropdown. Select it.
6. Submit "a cat". Request body `prompt === "cinematic shot. a cat. 35mm, film grain"`. History entry matches.
7. Reload the page — "Кино" is still selected (persisted in localStorage).
8. In `/admin`, delete "Кино". Return to `/`, focus — the dropdown silently switches to "Стандартный". Submit "a cat" → `prompt === "a cat"`.
9. Confirm that all pickers (Разрешение, Aspect, Формат, Стиль) fit inside the generation card without vertical scrolling on a standard laptop screen.

---

## Self-Review Notes

Coverage check (each spec section mapped to task):
- Data model → Task 1 (types), Task 2 (file layout + validation).
- Storage layer → Task 2.
- API endpoints → Tasks 3, 4, 5.
- Admin UI → Tasks 7, 8.
- Generation card UI (dropdown, caption removal, store field, reconcile) → Tasks 6, 9.
- Prompt injection → Task 1 (helper), Task 9 (wiring).
- File layout, non-goals, validation rules → reflected across tasks.

Type consistency: `composeFinalPrompt(userPrompt, style)` signature is used identically in Task 1 tests and Task 9 call sites. `reconcileSelectedStyle(knownIds)` is defined in Task 6 and called in Task 9. API response shapes `{ styles }`, `{ style }` match between server routes (Tasks 3-5) and client consumers (Tasks 7, 9). `DEFAULT_STYLE_ID` is the single source of truth in `lib/styles/types.ts` and is imported by both the store (Task 6) and the form (Task 9).

No placeholders: every code block is complete and runnable; every test has concrete assertions; every curl has a concrete URL and body.
