# Admin User Hard-Delete Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add admin action "Стереть навсегда" that removes a soft-deleted user from the database (freeing the email slot) while preserving generated content on disk under a `deleted_{email}/` cold archive plus a `_SUMMARY.csv` of per-month per-model generation counts.

**Architecture:** Pure helper module `lib/admin/purge-user.ts` does the testable work (compute aggregate, write CSV, run DB transaction). The new `DELETE /api/admin/users/[id]` handler validates input, delegates to the helper, then renames the on-disk folder, writes an audit event, and fans out an SSE notification to other admin tabs. Frontend adds a confirmation modal that requires the admin to type the user's email.

**Tech Stack:** Next.js 15 (app router), React 19, better-sqlite3, vitest, @radix-ui/react-dialog, sonner toasts. All existing.

**Reference spec:** `docs/superpowers/specs/2026-05-07-admin-user-hard-delete-design.md`

---

## File Structure

| Path | Action | Purpose |
| --- | --- | --- |
| `lib/auth/audit.ts` | Modify | Add `'admin_user_purged'` to `AuthEventType` |
| `lib/sse-broadcast.ts` | Modify | Add `admin.user_purged` to `SseEvent` union |
| `lib/admin/purge-user.ts` | Create | Pure function `purgeUser(db, userId, imagesDir)` — summary CSV write + DB transaction |
| `lib/admin/folder-rename.ts` | Create | Pure helper `findFreeDeletedTarget(imagesDir, email)` + glue `renameUserFolderToDeleted(imagesDir, email)` |
| `lib/admin/__tests__/purge-user.test.ts` | Create | Vitest tests for purge-user |
| `lib/admin/__tests__/folder-rename.test.ts` | Create | Vitest tests for folder-rename |
| `app/api/admin/users/[id]/route.ts` | Modify | Add `DELETE` handler; wire helpers, audit, SSE |
| `components/admin/purge-user-dialog.tsx` | Create | Confirmation modal (email typing, disabled-until-match button) |
| `components/admin/users-tab.tsx` | Modify | Render new button on `status='deleted'` rows; open dialog; subscribe to `admin.user_purged` |

---

## Task 1: Add `admin_user_purged` to AuthEventType

**Files:**
- Modify: `lib/auth/audit.ts:21`

This task is a pure type addition; no behavior changes. We do it first so later tasks can use the new event_type without TypeScript complaints.

- [ ] **Step 1: Add the union member**

In `lib/auth/audit.ts`, replace the `AuthEventType` union to include `'admin_user_purged'`:

```ts
export type AuthEventType =
  | "login_ok"
  | "login_denied_invalid_state"
  | "login_denied_invalid_token"
  | "login_denied_email_unverified"
  | "login_denied_not_in_allowlist"
  | "login_denied_banned"
  | "login_denied_account_deleted"
  | "login_denied_sub_mismatch"
  | "login_denied_wrong_hd"
  | "logout"
  | "quota_exceeded"
  | "session_revoked_ban"
  | "session_revoked_role_change"
  | "admin_user_created"
  | "admin_user_role_changed"
  | "admin_user_status_changed"
  | "admin_user_purged"
  | "admin_quota_changed"
  | "admin_model_default_changed";
```

- [ ] **Step 2: Run existing audit test to confirm nothing broke**

Run: `npm test -- lib/auth/__tests__/audit.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 3: Commit**

```bash
git add lib/auth/audit.ts
git commit -m "chore(audit): add admin_user_purged event type"
```

---

## Task 2: Add `admin.user_purged` to SseEvent

**Files:**
- Modify: `lib/sse-broadcast.ts:20-35`

- [ ] **Step 1: Add the union member**

In `lib/sse-broadcast.ts`, append a new variant inside the `SseEvent` union (right after `admin.quota_changed`):

```ts
export type SseEvent =
  | { type: "generation.created"; data: any }
  | { type: "generation.deleted"; data: { id: number } }
  | { type: "quota_updated" }
  | { type: "user_banned" }
  | { type: "user_role_changed" }
  | { type: "admin.user_generated"; data: { user_id: number } }
  | { type: "admin.quota_changed"; data: { user_id: number; model_id: string } }
  // Admin-only fan-out: emitted after a user is hard-deleted (purged) by
  // an admin. Carries the purged user_id so other admin tabs can drop
  // the row from the table without a full refetch (though they typically
  // refetch anyway for simplicity).
  | { type: "admin.user_purged"; data: { user_id: number } };
```

- [ ] **Step 2: Run typecheck**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add lib/sse-broadcast.ts
git commit -m "chore(sse): add admin.user_purged event"
```

---

## Task 3: Folder-rename helper — pure name selector + glue

**Files:**
- Create: `lib/admin/folder-rename.ts`
- Test: `lib/admin/__tests__/folder-rename.test.ts`

This module owns two functions: `findFreeDeletedTarget` (sync, pure once filesystem snapshotted) chooses the next free `deleted_*` slot, and `renameUserFolderToDeleted` calls `fs.rename` to apply it.

We test against a real temp directory (no fs mocks) — the operations are simple enough.

- [ ] **Step 1: Write failing tests**

Create `lib/admin/__tests__/folder-rename.test.ts`:

```ts
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
    // deleted_alice taken, deleted_3_alice taken, deleted_2 missing
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
    // source gone, target exists with content
    await expect(fs.access(src)).rejects.toThrow();
    const moved = await fs.readFile(path.join(root, "deleted_alice@x.com", "marker.txt"), "utf8");
    expect(moved).toBe("hi");
  });

  it("returns no_source when {email}/ does not exist", async () => {
    const result = await renameUserFolderToDeleted(root, "ghost@x.com");
    expect(result).toEqual({ renamed: false, reason: "no_source" });
  });

  it("uses next free slot on second purge of same email", async () => {
    // Pretend a previous purge happened
    await fs.mkdir(path.join(root, "deleted_alice@x.com"));
    // Fresh user folder appears
    await fs.mkdir(path.join(root, "alice@x.com"));
    const result = await renameUserFolderToDeleted(root, "alice@x.com");
    expect(result).toEqual({ renamed: true, target: "deleted_2_alice@x.com" });
  });
});
```

- [ ] **Step 2: Run tests, verify failure**

Run: `npm test -- lib/admin/__tests__/folder-rename.test.ts`
Expected: FAIL — "Cannot find module '../folder-rename'".

- [ ] **Step 3: Create implementation**

Create `lib/admin/folder-rename.ts`:

```ts
import { promises as fs } from "node:fs";
import path from "node:path";

/**
 * Find the first free directory name in the sequence:
 *   deleted_{email}, deleted_2_{email}, deleted_3_{email}, ...
 * Picks the lowest unused index — gaps are filled (e.g. if `deleted_2_*`
 * was manually removed, it gets reused before going to 4).
 */
export async function findFreeDeletedTarget(
  imagesDir: string,
  email: string
): Promise<string> {
  let n = 1;
  while (true) {
    const candidate = n === 1
      ? `deleted_${email}`
      : `deleted_${n}_${email}`;
    const exists = await fs.access(path.join(imagesDir, candidate))
      .then(() => true)
      .catch(() => false);
    if (!exists) return candidate;
    n++;
  }
}

export type RenameResult =
  | { renamed: true; target: string }
  | { renamed: false; reason: "no_source" };

/**
 * Rename `{imagesDir}/{email}` to `{imagesDir}/{deleted_target}` if the
 * source exists. Returns the chosen target name on success, or
 * `no_source` if the user never generated anything (so no folder exists).
 *
 * Throws on rename failure — caller decides whether to surface a warning
 * or fail outright. (Spec §6 says: surface as warning, DB already clean.)
 */
export async function renameUserFolderToDeleted(
  imagesDir: string,
  email: string
): Promise<RenameResult> {
  const src = path.join(imagesDir, email);
  const srcExists = await fs.access(src).then(() => true).catch(() => false);
  if (!srcExists) return { renamed: false, reason: "no_source" };

  const target = await findFreeDeletedTarget(imagesDir, email);
  await fs.rename(src, path.join(imagesDir, target));
  return { renamed: true, target };
}
```

- [ ] **Step 4: Run tests, verify pass**

Run: `npm test -- lib/admin/__tests__/folder-rename.test.ts`
Expected: PASS (7 tests across both describes).

- [ ] **Step 5: Commit**

```bash
git add lib/admin/folder-rename.ts lib/admin/__tests__/folder-rename.test.ts
git commit -m "feat(admin/purge): folder rename helper with deleted_N suffix scheme"
```

---

## Task 4: Summary CSV builder

**Files:**
- Create: `lib/admin/summary-csv.ts`
- Test: `lib/admin/__tests__/summary-csv.test.ts`

Pure function: takes a `Database` handle + `userId` + `email` → returns the full CSV string content. The caller writes it to disk separately (so this is testable with in-memory DB only).

- [ ] **Step 1: Write failing tests**

Create `lib/admin/__tests__/summary-csv.test.ts`:

```ts
import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { initSchema, seedModels } from "@/lib/history-db";
import { buildUserSummaryCsv } from "../summary-csv";

let db: Database.Database;
let userId: number;

beforeEach(() => {
  db = new Database(":memory:");
  initSchema(db);
  seedModels(db);
  userId = db.prepare(`INSERT INTO users (email) VALUES ('alice@x.com')`).run().lastInsertRowid as number;
});

function insertGen(model: string | null, createdAt: string, status: string = "completed") {
  db.prepare(
    `INSERT INTO generations (user_id, model_id, status, created_at) VALUES (?, ?, ?, ?)`
  ).run(userId, model, status, createdAt);
}

describe("buildUserSummaryCsv", () => {
  it("renders empty body when user has no generations", () => {
    const csv = buildUserSummaryCsv(db, userId, "alice@x.com", "2026-05-07T13:45:00.000Z");
    expect(csv).toContain("# email: alice@x.com");
    expect(csv).toContain("# purged_at: 2026-05-07T13:45:00.000Z");
    expect(csv).toContain("# total_generations: 0");
    expect(csv).toContain("year,month,model_id,model_display_name,generations");
    // No data rows — last newline is right after the header.
    const lines = csv.trimEnd().split("\n");
    expect(lines[lines.length - 1]).toBe("year,month,model_id,model_display_name,generations");
  });

  it("groups by year+month+model with display name from models table", () => {
    insertGen("nano-banana-pro", "2026-05-12T10:00:00.000Z");
    insertGen("nano-banana-pro", "2026-05-13T10:00:00.000Z");
    insertGen("seedream-4-5",    "2026-05-14T10:00:00.000Z");
    insertGen("nano-banana-pro", "2026-04-01T10:00:00.000Z");
    const csv = buildUserSummaryCsv(db, userId, "alice@x.com", "2026-05-07T13:45:00.000Z");
    expect(csv).toContain("# total_generations: 4");
    // Year/month DESC; within month, count DESC.
    const dataRows = csv.trimEnd().split("\n").slice(4); // skip 3 # comments + header
    expect(dataRows).toEqual([
      "2026,05,nano-banana-pro,Nano Banana Pro,2",
      "2026,05,seedream-4-5,Seedream 4.5,1",
      "2026,04,nano-banana-pro,Nano Banana Pro,1",
    ]);
  });

  it("counts both completed and deleted generations (billing parity)", () => {
    insertGen("nano-banana-pro", "2026-05-12T10:00:00.000Z", "completed");
    insertGen("nano-banana-pro", "2026-05-13T10:00:00.000Z", "deleted");
    insertGen("nano-banana-pro", "2026-05-14T10:00:00.000Z", "failed"); // excluded
    const csv = buildUserSummaryCsv(db, userId, "alice@x.com", "2026-05-07T13:45:00.000Z");
    expect(csv).toContain("# total_generations: 2");
    expect(csv).toContain("2026,05,nano-banana-pro,Nano Banana Pro,2");
  });

  it("renders NULL model_id as empty model_id and (unknown) display name", () => {
    insertGen(null, "2026-05-12T10:00:00.000Z");
    const csv = buildUserSummaryCsv(db, userId, "alice@x.com", "2026-05-07T13:45:00.000Z");
    expect(csv).toContain("2026,05,,(unknown),1");
  });
});
```

- [ ] **Step 2: Run tests, verify failure**

Run: `npm test -- lib/admin/__tests__/summary-csv.test.ts`
Expected: FAIL — "Cannot find module '../summary-csv'".

- [ ] **Step 3: Create implementation**

Create `lib/admin/summary-csv.ts`:

```ts
import type Database from "better-sqlite3";

interface SummaryRow {
  yr: string;
  mo: string;
  model_id: string | null;
  display_name: string | null;
  cnt: number;
}

/**
 * Build the human-readable + CSV-shaped summary that gets written into
 * the user's image folder before purge. Three `#` comment lines at the
 * top capture metadata (email, purge timestamp, total count); the
 * remainder is a flat CSV grouped by year/month/model.
 *
 * `purged_at` is passed in (not derived from `Date.now()`) so the route
 * handler can record the same timestamp in both the CSV and the audit
 * event, and tests stay deterministic.
 *
 * Counts include both `completed` and `deleted` generations to mirror
 * the billing semantic (see lib/quotas usage logic).
 */
export function buildUserSummaryCsv(
  db: Database.Database,
  userId: number,
  email: string,
  purgedAtIso: string
): string {
  const rows = db
    .prepare(`
      SELECT
        strftime('%Y', g.created_at) AS yr,
        strftime('%m', g.created_at) AS mo,
        g.model_id,
        m.display_name,
        COUNT(*) AS cnt
      FROM generations g
      LEFT JOIN models m ON m.model_id = g.model_id
      WHERE g.user_id = ?
        AND g.status IN ('completed', 'deleted')
      GROUP BY yr, mo, g.model_id
      ORDER BY yr DESC, mo DESC, cnt DESC
    `)
    .all(userId) as SummaryRow[];

  const total = rows.reduce((s, r) => s + r.cnt, 0);

  const lines: string[] = [];
  lines.push(`# email: ${email}`);
  lines.push(`# purged_at: ${purgedAtIso}`);
  lines.push(`# total_generations: ${total}`);
  lines.push(`year,month,model_id,model_display_name,generations`);
  for (const r of rows) {
    const modelId = r.model_id ?? "";
    const display = r.display_name ?? (r.model_id ? r.model_id : "(unknown)");
    lines.push(`${r.yr},${r.mo},${modelId},${display},${r.cnt}`);
  }
  return lines.join("\n") + "\n";
}
```

- [ ] **Step 4: Run tests, verify pass**

Run: `npm test -- lib/admin/__tests__/summary-csv.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add lib/admin/summary-csv.ts lib/admin/__tests__/summary-csv.test.ts
git commit -m "feat(admin/purge): summary CSV builder with billing-parity counts"
```

---

## Task 5: Core `purgeUser` orchestration

**Files:**
- Create: `lib/admin/purge-user.ts`
- Test: `lib/admin/__tests__/purge-user.test.ts`

Pure orchestration: read user → compute summary → optionally write CSV → run DB transaction (delete outputs → delete generations → delete user). The DB transaction is atomic; if it fails, the CSV may exist on disk (acceptable; retry overwrites).

This function does NOT do the folder rename — that's the route handler's job, ordered after this returns successfully.

- [ ] **Step 1: Write failing tests**

Create `lib/admin/__tests__/purge-user.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { initSchema, seedModels } from "@/lib/history-db";
import { purgeUser } from "../purge-user";

let db: Database.Database;
let imagesDir: string;
let userId: number;

beforeEach(async () => {
  db = new Database(":memory:");
  initSchema(db);
  seedModels(db);
  imagesDir = await fs.mkdtemp(path.join(os.tmpdir(), "purge-fs-"));
  userId = db.prepare(`INSERT INTO users (email, status) VALUES ('alice@x.com', 'deleted')`)
    .run().lastInsertRowid as number;
});
afterEach(async () => {
  await fs.rm(imagesDir, { recursive: true, force: true });
});

function insertGen(model: string | null, createdAt: string, status = "completed"): number {
  return db.prepare(
    `INSERT INTO generations (user_id, model_id, status, created_at) VALUES (?, ?, ?, ?)`
  ).run(userId, model, status, createdAt).lastInsertRowid as number;
}

describe("purgeUser", () => {
  it("user with no generations: no CSV written, user row deleted", async () => {
    const result = await purgeUser(db, userId, {
      imagesDir,
      purgedAtIso: "2026-05-07T13:45:00.000Z",
    });
    expect(result.generations_deleted).toBe(0);
    expect(result.csv_written).toBe(false);
    expect(result.email).toBe("alice@x.com");

    expect(db.prepare(`SELECT id FROM users WHERE id=?`).get(userId)).toBeUndefined();
  });

  it("user with generations: CSV written into {email}/, then DB rows deleted", async () => {
    const userDir = path.join(imagesDir, "alice@x.com");
    await fs.mkdir(userDir);
    const genId = insertGen("nano-banana-pro", "2026-05-12T10:00:00.000Z");
    db.prepare(
      `INSERT INTO generation_outputs (generation_id, filename, filepath, content_type)
       VALUES (?, 'a.jpg', 'alice@x.com/2026/05/uuid.jpg', 'image/jpeg')`
    ).run(genId);

    const result = await purgeUser(db, userId, {
      imagesDir,
      purgedAtIso: "2026-05-07T13:45:00.000Z",
    });
    expect(result.generations_deleted).toBe(1);
    expect(result.csv_written).toBe(true);

    const csv = await fs.readFile(path.join(userDir, "_SUMMARY.csv"), "utf8");
    expect(csv).toContain("# email: alice@x.com");
    expect(csv).toContain("2026,05,nano-banana-pro,Nano Banana Pro,1");

    expect(db.prepare(`SELECT id FROM users WHERE id=?`).get(userId)).toBeUndefined();
    expect(db.prepare(`SELECT id FROM generations WHERE user_id=?`).get(userId)).toBeUndefined();
    expect(db.prepare(`SELECT id FROM generation_outputs WHERE generation_id=?`).get(genId)).toBeUndefined();
  });

  it("user with generations but no folder on disk: skips CSV (gens still purged)", async () => {
    insertGen("nano-banana-pro", "2026-05-12T10:00:00.000Z");
    const result = await purgeUser(db, userId, {
      imagesDir,
      purgedAtIso: "2026-05-07T13:45:00.000Z",
    });
    expect(result.generations_deleted).toBe(1);
    expect(result.csv_written).toBe(false);
    expect(db.prepare(`SELECT id FROM generations WHERE user_id=?`).get(userId)).toBeUndefined();
  });

  it("CASCADE wipes sessions, user_quotas, user_preferences", async () => {
    const userDir = path.join(imagesDir, "alice@x.com");
    await fs.mkdir(userDir);
    db.prepare(`INSERT INTO sessions (id, user_id, expires_at) VALUES ('s1', ?, '2099-01-01')`).run(userId);
    db.prepare(`INSERT INTO user_quotas (user_id, model_id, monthly_limit) VALUES (?, 'nano-banana-pro', 100)`).run(userId);
    db.prepare(`INSERT INTO user_preferences (user_id, selected_model) VALUES (?, 'nano-banana-pro')`).run(userId);

    await purgeUser(db, userId, { imagesDir, purgedAtIso: "2026-05-07T13:45:00.000Z" });

    expect(db.prepare(`SELECT id FROM sessions WHERE user_id=?`).get(userId)).toBeUndefined();
    expect(db.prepare(`SELECT user_id FROM user_quotas WHERE user_id=?`).get(userId)).toBeUndefined();
    expect(db.prepare(`SELECT user_id FROM user_preferences WHERE user_id=?`).get(userId)).toBeUndefined();
  });

  it("auth_events for the user are preserved (no FK)", async () => {
    db.prepare(`INSERT INTO auth_events (event_type, user_id, email) VALUES ('login_ok', ?, 'alice@x.com')`).run(userId);
    await purgeUser(db, userId, { imagesDir, purgedAtIso: "2026-05-07T13:45:00.000Z" });
    const ev = db.prepare(`SELECT email FROM auth_events WHERE user_id=?`).get(userId) as { email: string } | undefined;
    expect(ev?.email).toBe("alice@x.com");
  });

  it("throws PurgeUserError(not_found) if user does not exist", async () => {
    const err = await purgeUser(db, 999_999, { imagesDir, purgedAtIso: "2026-05-07T13:45:00.000Z" })
      .then(() => null)
      .catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err.kind).toBe("not_found");
  });

  it("tags csv write failures as kind='summary_write_failed' (DB untouched)", async () => {
    insertGen("nano-banana-pro", "2026-05-12T10:00:00.000Z");
    const userDir = path.join(imagesDir, "alice@x.com");
    await fs.mkdir(userDir);
    // Make the dir read-only by replacing it with a file at the target path.
    // We can't easily make writeFile fail cross-platform on a real dir, so
    // we exploit a different angle: pass a non-existent imagesDir so the
    // dir-exists check returns false → CSV is skipped, no error. To force
    // a real failure we instead mock by passing a weird imagesDir path.
    //
    // Easiest deterministic path: pre-create _SUMMARY.csv as a directory,
    // so writeFile fails with EISDIR.
    await fs.mkdir(path.join(userDir, "_SUMMARY.csv"));

    const err = await purgeUser(db, userId, { imagesDir, purgedAtIso: "2026-05-07T13:45:00.000Z" })
      .then(() => null)
      .catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err.kind).toBe("summary_write_failed");
    // DB untouched
    expect(db.prepare(`SELECT id FROM users WHERE id=?`).get(userId)).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run tests, verify failure**

Run: `npm test -- lib/admin/__tests__/purge-user.test.ts`
Expected: FAIL — "Cannot find module '../purge-user'".

- [ ] **Step 3: Create implementation**

Create `lib/admin/purge-user.ts`:

```ts
import type Database from "better-sqlite3";
import { promises as fs } from "node:fs";
import path from "node:path";
import { buildUserSummaryCsv } from "./summary-csv";

export interface PurgeUserOpts {
  /** Absolute path to HISTORY_IMAGES_DIR (passed in for testability). */
  imagesDir: string;
  /** ISO timestamp recorded in the CSV header. Caller picks (typically `new Date().toISOString()`). */
  purgedAtIso: string;
}

export interface PurgeUserResult {
  email: string;
  generations_deleted: number;
  /** True if `_SUMMARY.csv` was written into `{imagesDir}/{email}/`. */
  csv_written: boolean;
}

export type PurgeUserErrorKind =
  | "not_found"
  | "summary_write_failed"
  | "db_delete_failed";

export class PurgeUserError extends Error {
  constructor(public kind: PurgeUserErrorKind, message: string) {
    super(message);
    this.name = "PurgeUserError";
  }
}

/**
 * Hard-delete a user from the database after writing a per-month/per-model
 * summary CSV into their content folder (if they had any generations and
 * the folder exists).
 *
 * Order:
 *   1. SELECT user (must exist; `status` not enforced here — caller validates).
 *   2. Build summary CSV in memory.
 *   3. If user has generations AND `{imagesDir}/{email}/` exists → write
 *      `_SUMMARY.csv` there. (Failure here propagates; caller treats as
 *      `summary_write_failed` and aborts.)
 *   4. Atomic DB transaction: DELETE outputs → DELETE generations →
 *      DELETE user. CASCADE wipes sessions, user_quotas, user_preferences.
 *      `auth_events` rows survive (no FK) — paper trail.
 *
 * Folder rename is NOT performed here; the route handler does it AFTER
 * this function returns successfully.
 */
export async function purgeUser(
  db: Database.Database,
  userId: number,
  opts: PurgeUserOpts
): Promise<PurgeUserResult> {
  const user = db.prepare(`SELECT email FROM users WHERE id=?`).get(userId) as
    | { email: string }
    | undefined;
  if (!user) throw new PurgeUserError("not_found", `user id=${userId} not found`);

  const csv = buildUserSummaryCsv(db, userId, user.email, opts.purgedAtIso);
  const totalRow = db.prepare(`
    SELECT COUNT(*) AS n FROM generations
    WHERE user_id=? AND status IN ('completed','deleted')
  `).get(userId) as { n: number };
  const total = totalRow.n;

  const userDir = path.join(opts.imagesDir, user.email);
  let csvWritten = false;
  if (total > 0) {
    const dirExists = await fs.access(userDir).then(() => true).catch(() => false);
    if (dirExists) {
      try {
        await fs.writeFile(path.join(userDir, "_SUMMARY.csv"), csv, "utf8");
        csvWritten = true;
      } catch (err) {
        throw new PurgeUserError(
          "summary_write_failed",
          `failed to write _SUMMARY.csv: ${(err as Error).message}`
        );
      }
    }
  }

  // Atomic — RESTRICT on generations.user_id requires we delete
  // child rows first, in this order. The transaction rolls back on any
  // throw; better-sqlite3's .transaction wraps in BEGIN/COMMIT/ROLLBACK.
  try {
    const tx = db.transaction(() => {
      db.prepare(`
        DELETE FROM generation_outputs
        WHERE generation_id IN (SELECT id FROM generations WHERE user_id=?)
      `).run(userId);
      db.prepare(`DELETE FROM generations WHERE user_id=?`).run(userId);
      db.prepare(`DELETE FROM users WHERE id=?`).run(userId);
    });
    tx();
  } catch (err) {
    throw new PurgeUserError(
      "db_delete_failed",
      `db transaction failed: ${(err as Error).message}`
    );
  }

  return {
    email: user.email,
    generations_deleted: total,
    csv_written: csvWritten,
  };
}
```

- [ ] **Step 4: Run tests, verify pass**

Run: `npm test -- lib/admin/__tests__/purge-user.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add lib/admin/purge-user.ts lib/admin/__tests__/purge-user.test.ts
git commit -m "feat(admin/purge): core purgeUser orchestration"
```

---

## Task 6: Wire `DELETE /api/admin/users/[id]` route handler

**Files:**
- Modify: `app/api/admin/users/[id]/route.ts`

The handler is the only piece that touches request/response/cookies/audit/SSE. We do NOT add a unit test for the handler — its delegated logic is already covered by Task 3-5 tests. Manual smoke (Task 9) verifies the wiring.

- [ ] **Step 1: Add imports and the new fan-out helper at top of file**

Open `app/api/admin/users/[id]/route.ts`. After the existing imports, add:

```ts
import { promises as fs } from "node:fs";
import path from "node:path";
import { getHistoryImagesDir } from "@/lib/history-db";
import { purgeUser, PurgeUserError } from "@/lib/admin/purge-user";
import { findFreeDeletedTarget, renameUserFolderToDeleted } from "@/lib/admin/folder-rename";
```

The existing imports (`getDb`, `getCurrentUser`, `writeAuthEvent`, `deleteSessionsForUser`, `broadcastToUserId`, `SESSION_COOKIE_NAME`) stay.

Right after the imports, add a fan-out helper that mirrors the pattern from `app/api/admin/models/[model_id]/route.ts:8-24`:

```ts
function fanOutUserPurged(targetUserId: number) {
  // Errors swallowed: the purge already succeeded; broadcast failure
  // must not 500 the response. Same pattern as app/api/history POST.
  try {
    const admins = getDb().prepare(
      `SELECT id FROM users WHERE role='admin' AND status='active'`
    ).all() as { id: number }[];
    for (const a of admins) {
      broadcastToUserId(a.id, {
        type: "admin.user_purged",
        data: { user_id: targetUserId },
      });
    }
  } catch (err) {
    console.error("[admin/users DELETE] admin broadcast failed:", err);
  }
}
```

- [ ] **Step 2: Append the DELETE handler**

At the end of the file, after the existing `PATCH` export, add:

```ts
export async function DELETE(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> }
) {
  const me = getCurrentUser(getDb(), req.cookies.get(SESSION_COOKIE_NAME)?.value ?? null);
  if (!me) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (me.role !== "admin") return NextResponse.json({ error: "forbidden" }, { status: 403 });

  const { id } = await ctx.params;
  const userId = parseInt(id);
  if (Number.isNaN(userId)) return NextResponse.json({ error: "invalid_id" }, { status: 400 });
  if (userId === me.id) return NextResponse.json({ error: "self_purge_forbidden" }, { status: 400 });

  const body = (await req.json()) as { confirmation_email?: string };
  const confirmation = (body.confirmation_email ?? "").trim().toLowerCase();
  if (!confirmation) {
    return NextResponse.json({ error: "confirmation_mismatch" }, { status: 400 });
  }

  const target = getDb()
    .prepare(`SELECT email, status FROM users WHERE id=?`)
    .get(userId) as { email: string; status: string } | undefined;
  if (!target) return NextResponse.json({ error: "not_found" }, { status: 404 });
  if (target.status !== "deleted") {
    return NextResponse.json({ error: "must_be_soft_deleted_first" }, { status: 409 });
  }
  if (confirmation !== target.email.toLowerCase()) {
    return NextResponse.json({ error: "confirmation_mismatch" }, { status: 400 });
  }

  const purgedAtIso = new Date().toISOString();
  const imagesDir = getHistoryImagesDir();

  let purgeResult;
  try {
    purgeResult = await purgeUser(getDb(), userId, { imagesDir, purgedAtIso });
  } catch (err) {
    console.error("[admin/users DELETE] purge failed:", err);
    if (err instanceof PurgeUserError) {
      // Tagged kind tells the client which side blew up. DB-side failures
      // imply the transaction rolled back; CSV-side failures imply DB
      // is untouched. Either way, retry is safe.
      return NextResponse.json(
        { error: err.kind, detail: err.message },
        { status: err.kind === "not_found" ? 404 : 500 }
      );
    }
    return NextResponse.json({ error: "db_delete_failed", detail: (err as Error).message }, { status: 500 });
  }

  // Audit BEFORE the rename so the intent is recorded even if rename fails.
  // Use details.target_email (no auth_events.email column populated) to mirror
  // the `admin_user_created` pattern at app/api/admin/users/route.ts:47.
  let renameTarget: string | null = null;
  // Pre-compute target so the audit can record it. If probe fails (e.g.,
  // imagesDir vanished), we'll find it again during rename — best effort.
  try {
    const probe = await fs.access(path.join(imagesDir, purgeResult.email))
      .then(() => true).catch(() => false);
    if (probe) {
      renameTarget = await findFreeDeletedTarget(imagesDir, purgeResult.email);
    }
  } catch {
    // Non-fatal: audit will record a null target, rename below still tries.
  }

  writeAuthEvent(getDb(), {
    event_type: "admin_user_purged",
    user_id: me.id,
    details: {
      target_id: userId,
      target_email: purgeResult.email,
      generations_purged: purgeResult.generations_deleted,
      folder_rename_target: renameTarget,
    },
  });

  let renameOutcome: { renamed: true; target: string } | { renamed: false; reason: "no_source" | "rename_failed"; error?: string };
  try {
    renameOutcome = await renameUserFolderToDeleted(imagesDir, purgeResult.email);
  } catch (err) {
    console.error("[admin/users DELETE] rename failed:", err);
    renameOutcome = { renamed: false, reason: "rename_failed", error: (err as Error).message };
  }

  fanOutUserPurged(userId);

  const responseBody: Record<string, unknown> = {
    ok: true,
    purged: {
      email: purgeResult.email,
      generations_deleted: purgeResult.generations_deleted,
      summary_csv_written: purgeResult.csv_written,
      folder_renamed_to: renameOutcome.renamed ? renameOutcome.target : null,
    },
  };
  if (!renameOutcome.renamed && renameOutcome.reason === "rename_failed") {
    responseBody.warning = "rename_failed";
    responseBody.intended_target = renameTarget;
  }
  return NextResponse.json(responseBody);
}
```

- [ ] **Step 3: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 4: Run the full test suite to confirm nothing regressed**

Run: `npm test`
Expected: all existing tests still pass; new tests from Tasks 3-5 still pass.

- [ ] **Step 5: Commit**

```bash
git add app/api/admin/users/[id]/route.ts
git commit -m "feat(admin/users): DELETE handler for hard-delete with confirmation"
```

---

## Task 7: Confirmation modal component

**Files:**
- Create: `components/admin/purge-user-dialog.tsx`

A controlled Radix-based modal. Parent supplies `user` (id + email + gens count) and `onPurged` callback. Modal owns the email-typing state and the API call.

- [ ] **Step 1: Create the component**

Create `components/admin/purge-user-dialog.tsx`:

```tsx
"use client";

import * as React from "react";
import { toast } from "sonner";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { AlertTriangle } from "lucide-react";

interface PurgeUserDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  user: { id: number; email: string; gens_this_month: number } | null;
  onPurged: () => void;
}

export function PurgeUserDialog({ open, onOpenChange, user, onPurged }: PurgeUserDialogProps) {
  const [typed, setTyped] = React.useState("");
  const [submitting, setSubmitting] = React.useState(false);

  // Reset on open/close.
  React.useEffect(() => {
    if (!open) { setTyped(""); setSubmitting(false); }
  }, [open]);

  if (!user) return null;

  const matches = typed.trim().toLowerCase() === user.email.toLowerCase();

  async function confirm() {
    if (!matches || submitting || !user) return;
    setSubmitting(true);
    try {
      const r = await fetch(`/api/admin/users/${user.id}`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ confirmation_email: typed.trim() }),
      });
      const json = await r.json().catch(() => ({}));
      if (r.ok) {
        if (json.warning === "rename_failed") {
          toast.warning(
            `Пользователь стёрт. Папка не переименована — переименуйте вручную: ${user.email}/ → ${json.intended_target ?? "deleted_*"}/`,
            { duration: 10_000 }
          );
        } else {
          toast.success("Пользователь стёрт навсегда");
        }
        onPurged();
        onOpenChange(false);
        return;
      }
      // Error mapping
      const errMap: Record<string, string> = {
        confirmation_mismatch: "Email не совпадает",
        must_be_soft_deleted_first: "Сначала переведите в статус «удалён»",
        self_purge_forbidden: "Нельзя стереть самого себя",
        not_found: "Пользователь не найден",
        summary_write_failed: "Не удалось записать сводку (диск/доступ); БД не тронута",
        db_delete_failed: "Сбой удаления из БД (rollback)",
      };
      toast.error(errMap[json.error] ?? `Ошибка: ${json.error ?? r.status}`);
    } catch (err) {
      console.error("[purge dialog]", err);
      toast.error("Сетевая ошибка");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="bg-background border border-border rounded-lg p-5 shadow-xl">
        <DialogTitle className="flex items-center gap-2 text-red-600">
          <AlertTriangle className="h-5 w-5" />
          Стереть пользователя навсегда
        </DialogTitle>

        <div className="space-y-3 text-sm">
          <p>
            Это действие <span className="font-semibold">необратимо</span>.
            Из базы будут удалены: пользователь <span className="font-mono">{user.email}</span>,
            все его генерации (за этот месяц: {user.gens_this_month}), оверрайды квот, сессии,
            настройки.
          </p>
          <p>
            Папка <span className="font-mono">{user.email}/</span> на диске будет переименована
            в <span className="font-mono">deleted_{user.email}/</span> (или
            <span className="font-mono"> deleted_2_{user.email}/</span>, если первая занята).
            Внутри останется CSV-сводка по моделям и месяцам.
          </p>
          <label className="block">
            <span className="block text-xs text-zinc-500 mb-1">
              Для подтверждения введите email пользователя:
            </span>
            <input
              type="text"
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              autoFocus
              className="w-full border rounded px-2 py-1 bg-background text-foreground"
              placeholder={user.email}
              disabled={submitting}
            />
          </label>
        </div>

        <div className="flex justify-end gap-2 pt-2">
          <button
            type="button"
            onClick={() => onOpenChange(false)}
            disabled={submitting}
            className="px-3 py-1.5 rounded border border-zinc-300 dark:border-zinc-700 hover:bg-zinc-100 dark:hover:bg-zinc-900"
          >
            Отмена
          </button>
          <button
            type="button"
            onClick={confirm}
            disabled={!matches || submitting}
            className="px-3 py-1.5 rounded bg-red-600 text-white hover:bg-red-700 disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {submitting ? "Стираем…" : "Стереть навсегда"}
          </button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
```

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add components/admin/purge-user-dialog.tsx
git commit -m "feat(admin/users): purge confirmation dialog with email-typed gate"
```

---

## Task 8: Wire button + dialog + SSE listener into users-tab.tsx

**Files:**
- Modify: `components/admin/users-tab.tsx`

Three concrete edits in this file:
1. Import `PurgeUserDialog`, add `useState` for the active purge target.
2. Render the new "Стереть навсегда" button — only on rows where `u.status === 'deleted'` AND the row is not the current admin (we don't have `me.id` in the component today; we'll use a small workaround documented inline).
3. Add an SSE listener for `admin.user_purged` that triggers `refetch()`.

For (2), to know "is this the current admin", the simplest approach is to compare against the admin's row via the existing list — but we don't actually need to: hard-delete is server-validated. However, hiding the button for one's own row is friendly. The current page (`app/admin/page.tsx` or similar) doesn't pass `me` to UsersTab. Rather than thread it, we omit the `u.id === me.id` UX guard on the client and rely on the server's `400 self_purge_forbidden`. This is acceptable because the precondition (`status='deleted'`) on the same row means the admin would already be locked out and unable to act in the admin panel.

- [ ] **Step 1: Add imports and dialog state**

In `components/admin/users-tab.tsx`, find the import block at top:

```tsx
"use client";
import * as React from "react";
import { toast } from "sonner";
import { ChevronRight, ChevronDown, Check, Loader2, Undo2 } from "lucide-react";
import { listAllModels, sortByPickerOrder } from "@/lib/providers/models";
import { formatRelativeTime } from "@/lib/format/relative-time";
```

Replace the last import line with:

```tsx
import { formatRelativeTime } from "@/lib/format/relative-time";
import { PurgeUserDialog } from "./purge-user-dialog";
```

Inside the `UsersTab` function body, after the existing `expandedIds` useState declaration around line 37, add:

```tsx
const [purgeTarget, setPurgeTarget] = React.useState<AdminUser | null>(null);
```

- [ ] **Step 2: Subscribe to `admin.user_purged` in the existing SSE useEffect**

Find the existing SSE useEffect (around lines 61-74). It currently registers two listeners:

```tsx
es.addEventListener("admin.user_generated", onEvent);
es.addEventListener("quota_updated", onEvent);
```

Add a third listener right below them, inside the same `useEffect`:

```tsx
es.addEventListener("admin.user_purged", onEvent);
```

The `onEvent` handler is already a no-arg `() => void refetch()`, so the new listener piggybacks on it.

- [ ] **Step 3: Add the "Стереть навсегда" button on deleted rows**

Find the existing block that renders the action buttons inside the `<td>` (around lines 169-211). The current "Восстановить" / "Удалить" toggle is at lines 195-209. Replace that block with:

```tsx
{u.status === "deleted" ? (
  <>
    <button
      onClick={() => patch(u.id, { status: "active" })}
      className="rounded px-2 py-0.5 text-green-600 hover:bg-zinc-100 dark:hover:bg-zinc-800"
    >
      Восстановить
    </button>
    <button
      onClick={() => setPurgeTarget(u)}
      className="rounded px-2 py-0.5 text-red-700 hover:bg-red-50 dark:hover:bg-red-950/30"
      title="Жёстко стереть — необратимо"
    >
      Стереть навсегда
    </button>
  </>
) : (
  <button
    onClick={() => confirm(`Удалить ${u.email}?`) && patch(u.id, { status: "deleted" })}
    className="rounded px-2 py-0.5 text-red-600 hover:bg-zinc-100 dark:hover:bg-zinc-800"
  >
    Удалить
  </button>
)}
```

- [ ] **Step 4: Render the dialog at the bottom of the component's JSX**

Find the closing `</div>` of the outermost `<div className="space-y-4">` in the `UsersTab` return (right before the function's closing brace). Just before that final `</div>`, add:

```tsx
<PurgeUserDialog
  open={purgeTarget !== null}
  onOpenChange={(o) => { if (!o) setPurgeTarget(null); }}
  user={purgeTarget ? { id: purgeTarget.id, email: purgeTarget.email, gens_this_month: purgeTarget.gens_this_month } : null}
  onPurged={() => { setPurgeTarget(null); void refetch(); }}
/>
```

- [ ] **Step 5: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add components/admin/users-tab.tsx
git commit -m "feat(admin/users): wire 'Стереть навсегда' button + dialog + SSE listener"
```

---

## Task 9: Manual smoke test

**Files:** none (read-only verification)

Tests can't easily cover the integrated browser flow + actual filesystem. Walk through each scenario in dev (`npm run dev`).

- [ ] **Step 1: Setup**

Make sure dev server is running: `npm run dev`. Open the admin panel as an admin user. Have a test email available (e.g. one of your own dev addresses).

- [ ] **Step 2: Happy path — purge a soft-deleted user with no generations**

1. Click "+ Добавить", enter `test1@example.com`, submit.
2. Click "Удалить" on the new row, confirm the browser dialog.
3. Tick "Показать удалённых". The row reappears with `status='deleted'` and the new "Стереть навсегда" button.
4. Click "Стереть навсегда". Modal opens.
5. Try clicking "Стереть навсегда" with empty input — button disabled.
6. Type wrong email — button stays disabled.
7. Type `test1@example.com` (exact match) — button enables.
8. Click. Toast "Пользователь стёрт навсегда". Modal closes. Row disappears.
9. Verify in DB shell (`sqlite3 $HISTORY_DATA_DIR/history.db`):
   `SELECT id FROM users WHERE email='test1@example.com';` → empty.
   `SELECT event_type, details FROM auth_events WHERE event_type='admin_user_purged' ORDER BY id DESC LIMIT 1;` → row with `target_email`.
10. On disk: `$HISTORY_DATA_DIR/history_images/test1@example.com/` does NOT exist (user never generated).

- [ ] **Step 3: Happy path — purge a user with generations**

1. Add `test2@example.com`, log in as them in another browser/profile, generate 3-5 images across 1-2 different models.
2. Log back in as admin, soft-delete `test2@example.com`.
3. Tick "Показать удалённых", click "Стереть навсегда" on the row.
4. Type the email, confirm. Toast "Пользователь стёрт навсегда".
5. On disk:
   - `$HISTORY_DATA_DIR/history_images/test2@example.com/` no longer exists.
   - `$HISTORY_DATA_DIR/history_images/deleted_test2@example.com/` exists.
   - `$HISTORY_DATA_DIR/history_images/deleted_test2@example.com/_SUMMARY.csv` exists; opens cleanly in a text editor with correct counts.
   - Original generated files (year/month subdirs) are inside the renamed folder.
6. In DB: user gone, generations rows for that user gone, generation_outputs for those gens gone, sessions/quotas/preferences gone.

- [ ] **Step 4: Re-add same email + repeat purge → `deleted_2_*`**

1. Click "+ Добавить", enter `test2@example.com` — should succeed (no 409).
2. Log in as them again, generate 1-2 images.
3. Soft-delete, then "Стереть навсегда".
4. On disk: `deleted_2_test2@example.com/` now exists alongside `deleted_test2@example.com/`. Each has its own `_SUMMARY.csv`.

- [ ] **Step 5: Validation paths**

Try purging your own admin row — but you can't actually reach this state because soft-deleting yourself logs you out. Instead, use a second admin browser session OR temporarily flip a co-admin's row, then verify:
- DELETE on a row with `status='active'` → 409 `must_be_soft_deleted_first` (toast: "Сначала переведите в статус «удалён»").
- DELETE with empty `confirmation_email` → 400 `confirmation_mismatch`.

(Optional API-level checks via `curl` are easier than gymnastic UI.)

- [ ] **Step 6: Real-time fan-out**

1. Open a second admin tab (or a second admin user in another browser).
2. Purge a user from tab A.
3. Tab B should refetch the users list and the row should disappear without a manual reload.

- [ ] **Step 7: Finalize**

If everything in Steps 2-6 passes, the feature is shipped. Update memory if you noticed anything non-obvious for future-you. Otherwise, no further commit; CI/lint should already be green from the unit-test commits.

---

## Out-of-scope reminders

The following intentional non-goals are flagged in the spec (§10) and **must not** be added during this implementation:

- One-step hard-delete (without prior soft-delete).
- Importing `_SUMMARY.csv` rows back into the DB.
- Bulk multi-user purge.
- Auto-pruning `deleted_*` folders by age.
- Sentinel "deleted_user" attribution.
