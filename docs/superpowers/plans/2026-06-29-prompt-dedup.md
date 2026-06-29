# Prompt De-duplication Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop persisting the wrapped `prompt` in `generations.prompt_data`; recompose it on demand from `userPrompt` + `styleIds` + the live style catalog, and reclaim existing space via a one-time operator-run migration.

**Architecture:** The wrapped prompt is only consumed by the copy button and image tooltips (display and restore are already `userPrompt`-first). We add a pure client-side helper `resolveWrappedPrompt(entry, styles)` that recomposes via the existing `composeFinalPrompt`. The write path stops persisting `prompt` and starts persisting a tiny `styleVersions` fingerprint (`styleId → updatedAt`) so restore can show a "style changed since generation" toast. A migration script strips `prompt` from existing rows.

**Tech Stack:** Next.js, TypeScript, better-sqlite3, Vitest, zustand.

## Global Constraints

- Test runner: `npm test` (= `vitest run`). The `@/` path alias resolves to repo root in tests.
- The prompt SENT to the generation API (`components/generate-form.tsx` submit call, `composeFinalPrompt(prompt.trim(), activeStyles)`) MUST remain unchanged — it is not the persistence concern.
- `prompt` field type stays `string` (required) on `HistoryEntry`/`NewPendingInput`/`CopiedEntry`; `serverGenToEntry` already defaults it to `""`. The only new field is `styleVersions?: Record<string, string>`.
- Do NOT backfill `styleVersions` in the migration (historical `updatedAt` is unknown; absence = edit detection unavailable for that row).
- Commit messages end with the trailer `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`.
- Work happens on branch `feat/prompt-dedup` (already created; the spec commit is its first commit).

---

### Task 1: `resolveWrappedPrompt` + `styleVersionsOf` helpers and types

**Files:**
- Create: `lib/styles/resolve-wrapped.ts`
- Modify: `lib/history/types.ts` (add `styleVersions?` to `HistoryEntry` and `NewPendingInput`)
- Test: `lib/styles/__tests__/resolve-wrapped.test.ts`

**Interfaces:**
- Consumes: `composeFinalPrompt(userPrompt: string, activeStyles: readonly Style[]): string` from `lib/styles/inject`; `Style` from `lib/styles/types`.
- Produces:
  - `resolveWrappedPrompt(e: WrappablePrompt, styles: readonly Style[]): string`
  - `styleVersionsOf(styles: readonly Style[]): Record<string, string>`
  - `interface WrappablePrompt { prompt?: string; userPrompt?: string; styleIds?: string[] }`

- [ ] **Step 1: Write the failing test**

Create `lib/styles/__tests__/resolve-wrapped.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { resolveWrappedPrompt, styleVersionsOf } from "@/lib/styles/resolve-wrapped";
import type { Style } from "@/lib/styles/types";

const mk = (id: string, prefix: string, suffix: string, updatedAt = "2026-01-01T00:00:00Z"): Style => ({
  id, name: id, prefix, suffix, createdAt: "2026-01-01T00:00:00Z", updatedAt,
});

describe("resolveWrappedPrompt", () => {
  it("returns userPrompt verbatim when no styles apply", () => {
    expect(resolveWrappedPrompt({ userPrompt: "hello", styleIds: [] }, [])).toBe("hello");
  });

  it("wraps userPrompt with a resolved attach-prefix style", () => {
    const styles = [mk("a", "TOP", "")];
    expect(resolveWrappedPrompt({ userPrompt: "hi", styleIds: ["a"] }, styles)).toBe("TOP\nhi");
  });

  it("drops missing style ids and wraps with the survivors", () => {
    const styles = [mk("a", "TOP", "")];
    expect(resolveWrappedPrompt({ userPrompt: "hi", styleIds: ["a", "gone"] }, styles)).toBe("TOP\nhi");
  });

  it("falls back to entry.prompt when userPrompt is absent (legacy)", () => {
    expect(resolveWrappedPrompt({ prompt: "legacy-wrapped" }, [])).toBe("legacy-wrapped");
  });
});

describe("styleVersionsOf", () => {
  it("maps id to updatedAt", () => {
    const styles = [mk("a", "", "", "2026-06-01T00:00:00Z"), mk("b", "", "", "2026-06-02T00:00:00Z")];
    expect(styleVersionsOf(styles)).toEqual({ a: "2026-06-01T00:00:00Z", b: "2026-06-02T00:00:00Z" });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- resolve-wrapped`
Expected: FAIL — cannot resolve module `@/lib/styles/resolve-wrapped`.

- [ ] **Step 3: Write minimal implementation**

Create `lib/styles/resolve-wrapped.ts`:

```typescript
import { composeFinalPrompt } from "./inject";
import type { Style } from "./types";

/** Minimal structural shape needed to recompose a wrapped prompt. */
export interface WrappablePrompt {
  prompt?: string;
  userPrompt?: string;
  styleIds?: string[];
}

/**
 * Recompose the wrapped prompt on demand. Post-feature entries carry
 * userPrompt + styleIds and recompose from the CURRENT style catalog
 * (missing ids are dropped). Legacy entries with no userPrompt fall back
 * to the stored wrapped prompt.
 */
export function resolveWrappedPrompt(
  e: WrappablePrompt,
  styles: readonly Style[]
): string {
  if (typeof e.userPrompt === "string") {
    const byId = new Map(styles.map((s) => [s.id, s]));
    const resolved = (e.styleIds ?? [])
      .map((id) => byId.get(id))
      .filter((s): s is Style => s !== undefined);
    return composeFinalPrompt(e.userPrompt, resolved);
  }
  return e.prompt ?? "";
}

/** Fingerprint of applied styles at generation time, for edit detection. */
export function styleVersionsOf(styles: readonly Style[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const s of styles) out[s.id] = s.updatedAt;
  return out;
}
```

- [ ] **Step 4: Add `styleVersions` to the history types**

In `lib/history/types.ts`, add to the `HistoryEntry` interface, right after the `styleIds?` field (around line 52):

```typescript
  /** styleId → style.updatedAt captured at generation time. Enables the
   *  "style changed since generation" restore toast. Absent on migrated
   *  and pre-feature rows. */
  styleVersions?: Record<string, string>;
```

And add the same field to the `NewPendingInput` interface, right after its `styleIds?` field (around line 92):

```typescript
  styleVersions?: Record<string, string>;
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npm test -- resolve-wrapped`
Expected: PASS (6 assertions).

- [ ] **Step 6: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add lib/styles/resolve-wrapped.ts lib/styles/__tests__/resolve-wrapped.test.ts lib/history/types.ts
git commit -m "feat(styles): resolveWrappedPrompt + styleVersionsOf helpers

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 2: Write path — drop persisted `prompt`, capture `styleVersions`

**Files:**
- Modify: `components/generate-form.tsx` (`promptPayload` ~line 275; `NewPendingInput` ~line 496)

**Interfaces:**
- Consumes: `styleVersionsOf` from `lib/styles/resolve-wrapped` (Task 1); `activeStyles` (already in scope, an array of `Style`).
- Produces: persisted `prompt_data` JSON with no `prompt` key and a `styleVersions` map.

- [ ] **Step 1: Import the helper**

In `components/generate-form.tsx`, near the existing `import { composeFinalPrompt } from "@/lib/styles/inject";` (line 22), add:

```typescript
import { styleVersionsOf } from "@/lib/styles/resolve-wrapped";
```

- [ ] **Step 2: Update the persisted payload**

In `saveToServerHistory`, change `promptPayload` (currently ~lines 275-285) — remove the `prompt:` line and add `styleVersions`:

```typescript
      const promptPayload = {
        userPrompt: prompt.trim(),
        styleIds: activeStyles.map((s) => s.id),
        styleVersions: styleVersionsOf(activeStyles),
        resolution: hasResolutions ? resolution : undefined,
        aspectRatio: aspectRatio || undefined,
        outputFormat,
        provider: activeProvider,
        modelId: selectedModel,
        model: getModelString(activeProvider, selectedModel, hasImages),
      };
```

- [ ] **Step 3: Carry `styleVersions` on the optimistic pending entry**

In the `NewPendingInput` object (currently ~lines 496-510), add `styleVersions` right after `styleIds`. Leave the existing `prompt: composeFinalPrompt(...)` line in place — the in-session pending entry may keep its wrapped prompt; only the *persisted* payload drops it:

```typescript
      styleIds: activeStyles.map((s) => s.id),
      styleVersions: styleVersionsOf(activeStyles),
```

- [ ] **Step 4: Verify the submit call is untouched**

Run: `grep -n "composeFinalPrompt(prompt.trim(), activeStyles)" components/generate-form.tsx`
Expected: the submit-call occurrence (~line 528) is still present. The `promptPayload` occurrence is gone.

- [ ] **Step 5: Confirm no `prompt:` in the persisted payload**

Run: `grep -n "prompt:" components/generate-form.tsx`
Expected: the `promptPayload` no longer contains a `prompt:` key (only `userPrompt:` and the NewPendingInput/submit composeFinalPrompt lines remain).

- [ ] **Step 6: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add components/generate-form.tsx
git commit -m "feat(generate-form): stop persisting wrapped prompt, capture styleVersions

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 3: Read path — parse `styleVersions` in `serverGenToEntry`

**Files:**
- Modify: `lib/history/store.ts` (`serverGenToEntry`, lines 140-212)
- Test: `lib/history/__tests__/store.test.ts` (add cases)

**Interfaces:**
- Consumes: `prompt_data` JSON shape `{ userPrompt?, styleIds?, styleVersions?, prompt? }`.
- Produces: `HistoryEntry.styleVersions?: Record<string,string>`; `HistoryEntry.prompt` is `""` when the JSON has no `prompt` key.

- [ ] **Step 1: Write the failing test**

In `lib/history/__tests__/store.test.ts`, add a test that builds a `ServerGeneration` row whose `prompt_data` has `userPrompt` + `styleIds` + `styleVersions` but NO `prompt`, passes it through `serverGenToEntry`, and asserts the parse. Match the existing test file's import style for `serverGenToEntry` and any row-builder helper already present; if none exists, construct the row inline:

```typescript
import { serverGenToEntry } from "@/lib/history/store";
import type { ServerGeneration } from "@/lib/history/types";

it("parses styleVersions and leaves prompt empty when absent", () => {
  const row: ServerGeneration = {
    id: 1,
    username: "a@x.com",
    workflow_name: "wavespeed:wavespeed/m/t2i",
    prompt_data: JSON.stringify({
      userPrompt: "hello",
      styleIds: ["s1"],
      styleVersions: { s1: "2026-06-01T00:00:00Z" },
    }),
    execution_time_seconds: 1,
    created_at: "2026-06-01T00:00:00.000Z",
    status: "completed",
    outputs: [
      { id: 1, generation_id: 1, filename: "o.png", filepath: "a@x.com/2026/06/uuid.png", content_type: "image/png", size: 4 },
    ],
  };
  const e = serverGenToEntry(row, "uuid");
  expect(e.userPrompt).toBe("hello");
  expect(e.styleIds).toEqual(["s1"]);
  expect(e.styleVersions).toEqual({ s1: "2026-06-01T00:00:00Z" });
  expect(e.prompt).toBe("");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- store`
Expected: FAIL — `e.styleVersions` is `undefined` (not yet parsed).

- [ ] **Step 3: Parse `styleVersions`**

In `lib/history/store.ts`, inside `serverGenToEntry`:

a) Add a local declaration next to the others (after `let styleIds: ... ;`, ~line 144):

```typescript
  let styleVersions: Record<string, string> | undefined;
```

b) Widen the `parsed` cast type (the inline type around lines 148-156) to include `styleVersions?: Record<string, unknown>`.

c) After the `styleIds` parsing block (~line 171), add:

```typescript
    if (
      parsed.styleVersions &&
      typeof parsed.styleVersions === "object" &&
      !Array.isArray(parsed.styleVersions)
    ) {
      const sv: Record<string, string> = {};
      for (const [k, v] of Object.entries(parsed.styleVersions)) {
        if (typeof v === "string") sv[k] = v;
      }
      styleVersions = Object.keys(sv).length > 0 ? sv : undefined;
    }
```

d) Add `styleVersions,` to the returned object literal (next to `styleIds,`, ~line 199):

```typescript
    styleIds,
    styleVersions,
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- store`
Expected: PASS.

- [ ] **Step 5: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add lib/history/store.ts lib/history/__tests__/store.test.ts
git commit -m "feat(history): parse styleVersions in serverGenToEntry

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 4: Consumers — recompose wrapped prompt for copy + tooltips

**Files:**
- Modify: `components/history-sidebar.tsx` (copy handler ~line 309-316; `alt` ~line 332; copy `disabled` ~line 399; display ~line 416-419)
- Modify: `components/output-area.tsx` (`alt` ~line 190; `title` ~line 335; copy handler ~line 353)

**Interfaces:**
- Consumes: `resolveWrappedPrompt` from `lib/styles/resolve-wrapped` (Task 1); the styles list already available in each component (the `styles` variable used by `joinStyleNames`).
- Produces: copy/tooltip now reflect the recomposed wrapped prompt.

- [ ] **Step 1: Import the helper in both components**

In `components/history-sidebar.tsx` and `components/output-area.tsx`, add to the existing styles imports:

```typescript
import { resolveWrappedPrompt } from "@/lib/styles/resolve-wrapped";
```

- [ ] **Step 2: Update `history-sidebar.tsx` copy handler**

Replace the copy body (~lines 309-316) so it computes the wrapped prompt once:

```typescript
    const wrapped = resolveWrappedPrompt(entry, styles);
    if (!wrapped) return;
    const ok = await copyToClipboard(wrapped);
```

Leave the `applyCopiedPrompt({ prompt: entry.prompt, userPrompt: entry.userPrompt, styleIds: entry.styleIds, ... })` call as-is in this task (it is updated in Task 5).

- [ ] **Step 3: Update `history-sidebar.tsx` tooltip + disabled guard**

- Change `alt={entry.prompt || "generation"}` (~line 332) to `alt={(entry.userPrompt || entry.prompt) || "generation"}`.
- Change `disabled={!entry.prompt}` (~line 399) to `disabled={!entry.userPrompt && !entry.prompt}`.
- The display block `{(entry.userPrompt ?? entry.prompt) && (...)}` (~line 416) is already `userPrompt`-first — leave unchanged.

- [ ] **Step 4: Update `output-area.tsx` copy handler + tooltips**

- In the copy handler (~line 353), replace `const ok = await copyToClipboard(entry.prompt);` with:

```typescript
              const wrapped = resolveWrappedPrompt(entry, styles);
              const ok = await copyToClipboard(wrapped);
```

- Change `alt={entry.prompt}` (~line 190) to `alt={entry.userPrompt || entry.prompt}`.
- Change `title={entry.prompt}` (~line 335) to `title={resolveWrappedPrompt(entry, styles)}`.

- [ ] **Step 5: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors. (If `styles` is not in scope in a handler, source it the same way `joinStyleNames(entry.styleIds, styles)` already does in that file.)

- [ ] **Step 6: Run the full suite (no regressions)**

Run: `npm test`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add components/history-sidebar.tsx components/output-area.tsx
git commit -m "feat(history-ui): recompose wrapped prompt for copy and tooltips

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 5: Restore — edit-detection toast + deleted-style degrade

**Files:**
- Modify: `lib/styles/apply-copied.ts` (`CopiedEntry`, `applyCopiedPrompt`)
- Modify: `components/history-sidebar.tsx` + `components/output-area.tsx` (pass `styleVersions` into the `applyCopiedPrompt` call)
- Test: `lib/styles/__tests__/apply-copied.test.ts` (add cases)

**Interfaces:**
- Consumes: `Style.updatedAt`; `CopiedEntry.styleVersions?: Record<string,string>`.
- Produces: updated `applyCopiedPrompt` behavior (branches 3 and 4) and `CopiedEntry` shape.

- [ ] **Step 1: Write the failing tests**

In `lib/styles/__tests__/apply-copied.test.ts`, add cases (reuse the file's existing `setters` mock pattern — `setPrompt`, `setSelectedStyleIds`, `toastInfo`, `toastWarn` as `vi.fn()`):

```typescript
it("appends a 'style changed' note when updatedAt differs from styleVersions", () => {
  const styles = [{ id: "a", name: "Кино", prefix: "P", suffix: "", createdAt: "x", updatedAt: "2026-06-02T00:00:00Z" }];
  const setters = { setPrompt: vi.fn(), setSelectedStyleIds: vi.fn(), toastInfo: vi.fn(), toastWarn: vi.fn() };
  applyCopiedPrompt(
    { prompt: "ignored", userPrompt: "hi", styleIds: ["a"], styleVersions: { a: "2026-06-01T00:00:00Z" } },
    styles,
    setters
  );
  expect(setters.setPrompt).toHaveBeenCalledWith("hi");
  expect(setters.setSelectedStyleIds).toHaveBeenCalledWith(["a"]);
  expect(setters.toastInfo).toHaveBeenCalledWith(expect.stringContaining("изменён"));
});

it("does NOT append the note when styleVersions matches", () => {
  const styles = [{ id: "a", name: "Кино", prefix: "P", suffix: "", createdAt: "x", updatedAt: "2026-06-01T00:00:00Z" }];
  const setters = { setPrompt: vi.fn(), setSelectedStyleIds: vi.fn(), toastInfo: vi.fn(), toastWarn: vi.fn() };
  applyCopiedPrompt(
    { prompt: "ignored", userPrompt: "hi", styleIds: ["a"], styleVersions: { a: "2026-06-01T00:00:00Z" } },
    styles,
    setters
  );
  expect(setters.toastInfo).toHaveBeenCalledWith(expect.not.stringContaining("изменён"));
});

it("on a deleted style: pastes userPrompt and selects only the survivors", () => {
  const styles = [{ id: "a", name: "Кино", prefix: "P", suffix: "", createdAt: "x", updatedAt: "y" }];
  const setters = { setPrompt: vi.fn(), setSelectedStyleIds: vi.fn(), toastInfo: vi.fn(), toastWarn: vi.fn() };
  applyCopiedPrompt(
    { prompt: "wrapped-old", userPrompt: "hi", styleIds: ["a", "gone"] },
    styles,
    setters
  );
  expect(setters.setPrompt).toHaveBeenCalledWith("hi");
  expect(setters.setSelectedStyleIds).toHaveBeenCalledWith(["a"]);
  expect(setters.toastWarn).toHaveBeenCalled();
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- apply-copied`
Expected: FAIL — `styleVersions` not on `CopiedEntry`; branch 4 currently pastes `entry.prompt` and clears selection.

- [ ] **Step 3: Add `styleVersions` to `CopiedEntry`**

In `lib/styles/apply-copied.ts`, add to the `CopiedEntry` interface:

```typescript
  /** styleId → updatedAt at generation time, for edit detection. */
  styleVersions?: Record<string, string>;
```

- [ ] **Step 4: Add an edit-detection helper**

In `lib/styles/apply-copied.ts`, add (above `applyCopiedPrompt`):

```typescript
/** Names of applied styles whose updatedAt differs from the gen-time fingerprint. */
function changedStyleNames(
  styleIds: readonly string[],
  styleVersions: Record<string, string> | undefined,
  styles: readonly Style[]
): string[] {
  if (!styleVersions) return [];
  return styleIds
    .map((id) => styles.find((s) => s.id === id))
    .filter((s): s is Style => s !== undefined)
    .filter((s) => styleVersions[s.id] !== undefined && styleVersions[s.id] !== s.updatedAt)
    .map((s) => s.name);
}
```

- [ ] **Step 5: Update branch 3 (all ids resolve)**

Replace the `missingIds.length === 0` block so it appends the change note:

```typescript
  if (missingIds.length === 0) {
    setters.setPrompt(entry.userPrompt ?? entry.prompt);
    setters.setSelectedStyleIds(entry.styleIds);
    const names = joinStyleNames(entry.styleIds, styles);
    const base =
      entry.styleIds.length === 1
        ? `Промпт скопирован, стиль «${names}» применён`
        : `Промпт скопирован, стили «${names}» применены`;
    const changed = changedStyleNames(entry.styleIds, entry.styleVersions, styles);
    const note =
      changed.length === 0
        ? ""
        : changed.length === 1
        ? `; стиль «${changed[0]}» изменён с момента генерации`
        : `; стили изменены с момента генерации`;
    setters.toastInfo(base + note);
    return;
  }
```

- [ ] **Step 6: Update branch 4 (some id missing)**

Replace the final fallback block so it pastes `userPrompt` and selects survivors instead of pasting the wrapped prompt:

```typescript
  // At least one missing — degrade to clean userPrompt, keep survivors.
  const survivors = entry.styleIds.filter((id) => knownIds.has(id));
  setters.setPrompt(entry.userPrompt ?? entry.prompt);
  setters.setSelectedStyleIds(survivors);
  const warnMsg =
    missingIds.length === 1
      ? `Стиль «${missingIds[0]}» удалён, применены остальные`
      : "Некоторые стили удалены, применены остальные";
  setters.toastWarn(warnMsg);
```

- [ ] **Step 7: Pass `styleVersions` from the callers**

In `components/history-sidebar.tsx` (~line 314) and `components/output-area.tsx` (~line 357), add `styleVersions: entry.styleVersions,` to the object passed to `applyCopiedPrompt`:

```typescript
        {
          prompt: entry.prompt,
          userPrompt: entry.userPrompt,
          styleIds: entry.styleIds,
          styleVersions: entry.styleVersions,
        },
```

- [ ] **Step 8: Run tests to verify they pass**

Run: `npm test -- apply-copied`
Expected: PASS. Then run the existing apply-copied cases too — they should still pass (branches 1, 2, 3 happy-path unchanged in shape).

- [ ] **Step 9: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 10: Commit**

```bash
git add lib/styles/apply-copied.ts lib/styles/__tests__/apply-copied.test.ts components/history-sidebar.tsx components/output-area.tsx
git commit -m "feat(restore): style-changed toast + deleted-style degrade to userPrompt

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 6: Migration script — strip persisted `prompt`

**Files:**
- Create: `scripts/migrate-strip-wrapped-prompt.mjs`
- Test: `scripts/__tests__/migrate-strip-wrapped-prompt.test.ts`

**Interfaces:**
- Consumes: better-sqlite3 `Database`; `initSchema` from `@/lib/history-db` (test only).
- Produces: `migrateStripWrappedPrompt({ dbPath: string, dryRun: boolean }): { rowsToMigrate: number, rowsMigrated: number, skipped: number }`.

- [ ] **Step 1: Write the failing test**

Create `scripts/__tests__/migrate-strip-wrapped-prompt.test.ts` (mirrors `migrate-input-thumbnails.test.ts`):

```typescript
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- migrate-strip-wrapped-prompt`
Expected: FAIL — cannot resolve module `@/scripts/migrate-strip-wrapped-prompt.mjs`.

- [ ] **Step 3: Write the migration script**

Create `scripts/migrate-strip-wrapped-prompt.mjs`:

```javascript
import Database from "better-sqlite3";
import { pathToFileURL } from "node:url";

/**
 * Strip the redundant wrapped `prompt` from prompt_data. Post-feature rows
 * (those with a `userPrompt`) recompose the wrapped prompt on demand from
 * userPrompt + styleIds + the style catalog, so the stored copy is dead
 * weight. Legacy rows without `userPrompt` keep their `prompt`.
 * styleVersions is NOT backfilled (historical updatedAt is unknown).
 * @param {{dbPath:string, dryRun:boolean}} opts
 */
export function migrateStripWrappedPrompt(opts) {
  const { dbPath, dryRun } = opts;
  const db = new Database(dbPath);
  let rowsToMigrate = 0, rowsMigrated = 0, skipped = 0;

  try {
    const rows = db.prepare(`
      SELECT id, prompt_data FROM generations
      WHERE prompt_data LIKE '%"userPrompt"%' AND prompt_data LIKE '%"prompt"%'
    `).all();
    const update = db.prepare(`UPDATE generations SET prompt_data=? WHERE id=?`);

    for (const r of rows) {
      let parsed;
      try { parsed = JSON.parse(r.prompt_data); } catch { skipped++; continue; }
      if (typeof parsed.userPrompt !== "string") continue; // legacy: keep prompt
      if (!("prompt" in parsed)) continue;                 // already stripped
      rowsToMigrate++;
      if (dryRun) continue;
      delete parsed.prompt;
      update.run(JSON.stringify(parsed), r.id);
      rowsMigrated++;
    }

    if (!dryRun && rowsMigrated > 0) db.exec("VACUUM");
  } finally {
    db.close();
  }

  return { rowsToMigrate, rowsMigrated, skipped };
}

// CLI: node scripts/migrate-strip-wrapped-prompt.mjs --db <path> [--dry-run]
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const a = process.argv.slice(2);
  const get = (f) => { const i = a.indexOf(f); return i >= 0 ? a[i + 1] : undefined; };
  const dbPath = get("--db"), dryRun = a.includes("--dry-run");
  if (!dbPath) {
    console.error("usage: --db <history.db> [--dry-run]");
    process.exit(2);
  }
  try {
    const r = migrateStripWrappedPrompt({ dbPath, dryRun });
    console.log(JSON.stringify({ dryRun, ...r }, null, 2));
  } catch (e) {
    console.error(e);
    process.exit(1);
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- migrate-strip-wrapped-prompt`
Expected: PASS.

- [ ] **Step 5: Run the full suite**

Run: `npm test`
Expected: PASS (all suites).

- [ ] **Step 6: Commit**

```bash
git add scripts/migrate-strip-wrapped-prompt.mjs scripts/__tests__/migrate-strip-wrapped-prompt.test.ts
git commit -m "feat(scripts): migration to strip redundant wrapped prompt + VACUUM

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Operator runbook (manual, post-merge)

Not a code task — run by the operator against production, mirroring the input-images migration:

1. Dry-run on a COPY of the DB: `node scripts/migrate-strip-wrapped-prompt.mjs --db "C:\path\to\copy_history.db" --dry-run` → confirm `rowsToMigrate` ≈ 24,753.
2. `docker compose stop wavespeed-claude`
3. Back up: copy `C:\viewcomfy_data\database\history.db` → `history.db.bak`.
4. Real run: `node scripts/migrate-strip-wrapped-prompt.mjs --db "C:\viewcomfy_data\database\history.db"`.
5. Verify: `sqlite3 -readonly "...\history.db" "SELECT COUNT(*) FROM generations WHERE prompt_data LIKE '%\"userPrompt\"%' AND prompt_data LIKE '%\"prompt\"%';"` → expect `0`; confirm file-size drop to ~50–55 MB.
6. `docker compose start wavespeed-claude`; smoke-test copy button + restore in the UI.

---

## Self-Review

**Spec coverage:**
- Schema change (drop `prompt`, add `styleVersions`) → Tasks 2, 3.
- Hybrid recomposition from current styles → Task 1 (`resolveWrappedPrompt`), Task 4 (consumers).
- Edit-detection toast → Task 5 (branch 3 + `changedStyleNames`), fed by Tasks 1-3 (`styleVersions`).
- Deleted-style degrade to userPrompt → Task 5 (branch 4).
- Recomposition placement = lazy client consumer → Task 4.
- Migration (idempotent, dry-run, VACUUM, no styleVersions backfill) → Task 6.
- Submit prompt unchanged → Task 2 Step 4 guard.
- Testing matrix → Tasks 1, 3, 5, 6 (unit) + operator runbook (manual/E2E).

**Placeholder scan:** none — every code step carries full code.

**Type consistency:** `resolveWrappedPrompt` / `styleVersionsOf` / `WrappablePrompt` (Task 1) used verbatim in Tasks 4, 6 context. `styleVersions?: Record<string,string>` identical across `HistoryEntry`, `NewPendingInput` (Task 1), `CopiedEntry` (Task 5), and the parse in Task 3. `migrateStripWrappedPrompt` return shape matches its test.
