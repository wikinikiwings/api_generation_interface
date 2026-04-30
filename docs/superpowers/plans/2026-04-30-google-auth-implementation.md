# Google OAuth + Per-Model Quotas Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Заменить ник-based identity (`viewcomfy_username` cookie + `UsernameModal`) на Google OAuth с email-allowlist, перевести admin на тот же Google flow с `role='admin'`, добавить месячные per-user-per-model лимиты генераций (admin-управляемые) и раскладку картинок по `<email>/YYYY/MM/`.

**Architecture:** Custom OAuth 2.0 Authorization Code + PKCE + OIDC; `jose` для верификации Google id_token через JWKS. Opaque random session-ids (256 bit) в SQLite таблице `sessions`, sliding renewal с 1h throttling. Two-tier auth: middleware (edge) только presence-check куки; `getCurrentUser()` (Node.js) делает реальную DB-проверку и продление. Квоты — `monthly count per (user, model)` за календарный месяц UTC, с per-model `default_monthly_limit` и per-(user,model) override. Real-time обновление UI через расширение существующего `/api/history/stream` SSE.

**Tech Stack:** Next.js 15.1 App Router · React 19 · better-sqlite3 (raw SQL) · vitest 4 · @testing-library/react · jsdom · zustand (существующий store). **Новая зависимость:** `jose@^5` (для верификации id_token).

**Spec:** `docs/superpowers/specs/2026-04-30-google-auth-design.md`

**Phases (10 total, ~35 tasks):**
1. Setup: deps, env example
2. Foundation: схема БД, low-level helpers (safeNext, oauth-tx HMAC, audit log)
3. Sessions + currentUser
4. Quota helpers (applicableLimit, usageThisMonth)
5. Google OAuth utils + endpoints (`/api/auth/*`)
6. Middleware + `/login` page + UserProvider rewrite
7. API integration: history POST/GET/DELETE, image catch-all, stream, preferences
8. Quota enforcement в submit + `/api/me/quotas`
9. Admin endpoints + Admin UI tabs (Users, Models)
10. Client UX (header menu, sidebar tabs, my-quotas карточки, дизейбл Generate, удаление UsernameModal) + cleanup legacy admin

---

## Pre-flight notes for the executing engineer

- **Все таски используют TDD**: сначала пишем падающий тест, видим что он падает с ожидаемой ошибкой, затем минимальная реализация, затем зелёный тест, затем коммит. Не объединять шаги.
- **Тестовый рантайм**: vitest.config.ts задаёт `environment: "jsdom"` по умолчанию. Для тестов с pure-Node API (jose RSA via WebCrypto, crypto.timingSafeEqual в специфических случаях) добавляй `// @vitest-environment node` в первой строке файла теста. Для UI-тестов pragma не нужен — jsdom уже дефолт.
- **БД в тестах**: используем in-memory SQLite (`new Database(':memory:')`) — никогда не трогаем `data/history.db`. Для этого все DB-функции должны принимать `db` как параметр или брать через DI-фабрику.
- **Команды запуска**: один тест `npx vitest run path/to/test.ts -t 'test name'`; полный — `npm test`.
- **Коммиты**: после каждой задачи отдельный коммит. Формат `feat:`, `test:`, `refactor:`, `chore:` следуя стилю репозитория (см. `git log --oneline -20`).
- **Если тест неожиданно проходит на этапе "verify it fails"**: остановись, разберись почему — это сигнал что либо тест не покрывает то что описывает, либо реализация уже есть.
- **Никаких `--no-verify`** на коммитах: если pre-commit hook падает, фиксим причину, не обходим.

---

## Phase 1: Setup

### Task 1.1: Install `jose` and add env example

**Files:**
- Modify: `package.json` (добавить `jose` в dependencies)
- Create: `.env.example`

- [ ] **Step 1: Install dependency**

```bash
npm install jose@^5
```

Expected: `jose` появляется в `package.json` dependencies, `package-lock.json` обновляется.

- [ ] **Step 2: Verify install**

```bash
node -e "console.log(require('jose/package.json').version)"
```

Expected: печатает `5.x.x`.

- [ ] **Step 3: Create `.env.example`**

Полная копия требуемых переменных (использовать как шаблон при копировании в `.env.local`):

```
# === Google OAuth ===
GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=
GOOGLE_REDIRECT_URI=http://localhost:3000/api/auth/callback

# === Sessions ===
# 32+ bytes hex (generate: node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")
SESSION_COOKIE_SECRET=

# === Initial admin allowlist (CSV emails). Idempotent: safe to leave on. ===
BOOTSTRAP_ADMIN_EMAILS=

# === Optional defense-in-depth: restrict to a single Google Workspace domain ===
# ALLOWED_HD=tapclap.com

# === Existing (unrelated) ===
# WAVESPEED_API_KEY=...
# FAL_KEY=...
# COMFY_BASE_URL=...
```

- [ ] **Step 4: Commit**

```bash
git add package.json package-lock.json .env.example
git commit -m "chore(auth): add jose dep and .env.example template"
```

---

## Phase 2: Foundation utilities (pure functions, easy TDD)

### Task 2.1: `safeNext` — open-redirect защита

**Files:**
- Create: `lib/auth/safe-next.ts`
- Test: `lib/auth/__tests__/safe-next.test.ts`

- [ ] **Step 1: Write failing tests**

Create `lib/auth/__tests__/safe-next.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { safeNext } from "../safe-next";

describe("safeNext", () => {
  it("returns '/' for null/empty", () => {
    expect(safeNext(null)).toBe("/");
    expect(safeNext("")).toBe("/");
  });

  it("accepts simple relative paths", () => {
    expect(safeNext("/")).toBe("/");
    expect(safeNext("/admin")).toBe("/admin");
    expect(safeNext("/path/to?x=1")).toBe("/path/to?x=1");
  });

  it("rejects absolute URLs", () => {
    expect(safeNext("https://evil.com")).toBe("/");
    expect(safeNext("http://evil.com/path")).toBe("/");
  });

  it("rejects protocol-relative URLs", () => {
    expect(safeNext("//evil.com")).toBe("/");
    expect(safeNext("//evil.com/path")).toBe("/");
  });

  it("rejects backslash injection (Windows parsers)", () => {
    expect(safeNext("/\\evil.com")).toBe("/");
    expect(safeNext("\\\\evil.com")).toBe("/");
  });

  it("rejects values that don't start with single slash", () => {
    expect(safeNext("admin")).toBe("/");
    expect(safeNext("javascript:alert(1)")).toBe("/");
  });
});
```

- [ ] **Step 2: Run, verify it fails**

```bash
npx vitest run lib/auth/__tests__/safe-next.test.ts
```

Expected: FAIL with "Cannot find module '../safe-next'".

- [ ] **Step 3: Implement**

Create `lib/auth/safe-next.ts`:

```ts
/**
 * Sanitize an untrusted `?next=` query param. Accepts only relative paths
 * (single leading slash). Anything else collapses to "/" — protects from
 * open-redirect attacks where the attacker links to /login?next=https://evil.com
 * and a careless callback redirects to evil.com after auth.
 */
export function safeNext(raw: string | null | undefined): string {
  if (!raw) return "/";
  if (!raw.startsWith("/")) return "/";
  if (raw.startsWith("//")) return "/";        // protocol-relative
  if (raw.includes("\\")) return "/";          // backslash tricks
  return raw;
}
```

- [ ] **Step 4: Run, verify it passes**

```bash
npx vitest run lib/auth/__tests__/safe-next.test.ts
```

Expected: 6 tests passed.

- [ ] **Step 5: Commit**

```bash
git add lib/auth/safe-next.ts lib/auth/__tests__/safe-next.test.ts
git commit -m "feat(auth): safeNext utility for open-redirect protection"
```

---

### Task 2.2: `oauth-tx` — HMAC-signed transactional cookie

**Files:**
- Create: `lib/auth/oauth-tx.ts`
- Test: `lib/auth/__tests__/oauth-tx.test.ts`

- [ ] **Step 1: Write failing tests**

Create `lib/auth/__tests__/oauth-tx.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { encodeOAuthTx, decodeOAuthTx, type OAuthTxPayload } from "../oauth-tx";

const SECRET = "0".repeat(64); // 32 bytes hex
const PAYLOAD: OAuthTxPayload = {
  state: "s1",
  nonce: "n1",
  code_verifier: "cv1",
  next: "/admin",
  ts: 1700000000000,
};

describe("oauth-tx encode/decode", () => {
  it("roundtrips a payload", () => {
    const encoded = encodeOAuthTx(PAYLOAD, SECRET);
    const decoded = decodeOAuthTx(encoded, SECRET, { now: PAYLOAD.ts + 1000 });
    expect(decoded).toEqual(PAYLOAD);
  });

  it("rejects tampered payload", () => {
    const encoded = encodeOAuthTx(PAYLOAD, SECRET);
    // flip one char in the payload portion (before the dot)
    const [b64, sig] = encoded.split(".");
    const tampered = b64.slice(0, -1) + (b64.slice(-1) === "A" ? "B" : "A") + "." + sig;
    expect(() => decodeOAuthTx(tampered, SECRET, { now: PAYLOAD.ts + 1000 })).toThrow(/signature/i);
  });

  it("rejects expired payload (>10 min old)", () => {
    const encoded = encodeOAuthTx(PAYLOAD, SECRET);
    const tooLate = PAYLOAD.ts + 11 * 60 * 1000;
    expect(() => decodeOAuthTx(encoded, SECRET, { now: tooLate })).toThrow(/expired/i);
  });

  it("rejects payload signed with a different secret", () => {
    const encoded = encodeOAuthTx(PAYLOAD, SECRET);
    expect(() =>
      decodeOAuthTx(encoded, "1".repeat(64), { now: PAYLOAD.ts + 1000 })
    ).toThrow(/signature/i);
  });

  it("rejects malformed input", () => {
    expect(() => decodeOAuthTx("not-a-valid-token", SECRET)).toThrow();
    expect(() => decodeOAuthTx("", SECRET)).toThrow();
    expect(() => decodeOAuthTx("only-one-part", SECRET)).toThrow();
  });
});
```

- [ ] **Step 2: Run, verify it fails**

```bash
npx vitest run lib/auth/__tests__/oauth-tx.test.ts
```

Expected: FAIL on import.

- [ ] **Step 3: Implement**

Create `lib/auth/oauth-tx.ts`:

```ts
import crypto from "node:crypto";

export interface OAuthTxPayload {
  state: string;
  nonce: string;
  code_verifier: string;
  next: string;
  ts: number;
}

const TTL_MS = 10 * 60 * 1000;

function b64urlEncode(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64urlDecode(str: string): Buffer {
  const pad = (4 - (str.length % 4)) % 4;
  return Buffer.from(str.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat(pad), "base64");
}

function hmac(secret: string, data: string): string {
  return b64urlEncode(crypto.createHmac("sha256", secret).update(data).digest());
}

/**
 * Encode `payload` as `<b64url(JSON)>.<HMAC>`. Cookie-safe.
 * The signature covers the b64-encoded JSON, not the raw object — that way
 * we don't have to care about JSON-key-order canonicalization.
 */
export function encodeOAuthTx(payload: OAuthTxPayload, secret: string): string {
  const body = b64urlEncode(Buffer.from(JSON.stringify(payload), "utf-8"));
  const sig = hmac(secret, body);
  return `${body}.${sig}`;
}

/**
 * Decode and validate. Throws on:
 *  - malformed input
 *  - signature mismatch (tampered or wrong secret)
 *  - payload older than TTL_MS (default 10 min)
 *
 * `opts.now` is for testability.
 */
export function decodeOAuthTx(
  token: string,
  secret: string,
  opts: { now?: number } = {}
): OAuthTxPayload {
  if (!token || typeof token !== "string") throw new Error("oauth_tx: malformed");
  const dot = token.indexOf(".");
  if (dot < 0) throw new Error("oauth_tx: malformed");
  const body = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  if (!body || !sig) throw new Error("oauth_tx: malformed");

  const expected = hmac(secret, body);
  // Constant-time compare
  if (expected.length !== sig.length || !crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(sig))) {
    throw new Error("oauth_tx: signature mismatch");
  }

  let payload: OAuthTxPayload;
  try {
    payload = JSON.parse(b64urlDecode(body).toString("utf-8"));
  } catch {
    throw new Error("oauth_tx: malformed payload");
  }

  const now = opts.now ?? Date.now();
  if (typeof payload.ts !== "number" || now - payload.ts > TTL_MS) {
    throw new Error("oauth_tx: expired");
  }

  return payload;
}
```

- [ ] **Step 4: Run, verify it passes**

```bash
npx vitest run lib/auth/__tests__/oauth-tx.test.ts
```

Expected: 5 tests passed.

- [ ] **Step 5: Commit**

```bash
git add lib/auth/oauth-tx.ts lib/auth/__tests__/oauth-tx.test.ts
git commit -m "feat(auth): HMAC-signed transactional cookie helpers (oauth-tx)"
```

---

### Task 2.3: DB schema rewrite — auth tables + generations changes

**Files:**
- Modify: `lib/history-db.ts` (полный rewrite секции `CREATE TABLE`)
- Test: `lib/__tests__/history-db-schema.test.ts`

- [ ] **Step 1: Write failing schema test**

Create `lib/__tests__/history-db-schema.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import Database from "better-sqlite3";
import { initSchema } from "@/lib/history-db";

function freshDb() {
  const db = new Database(":memory:");
  initSchema(db);
  return db;
}

describe("schema initialization", () => {
  it("creates all expected tables", () => {
    const db = freshDb();
    const rows = db.prepare(
      `SELECT name FROM sqlite_master WHERE type='table' ORDER BY name`
    ).all() as { name: string }[];
    const names = rows.map((r) => r.name);
    expect(names).toEqual(
      expect.arrayContaining([
        "users", "sessions", "models", "user_quotas", "auth_events",
        "generations", "generation_outputs", "user_preferences", "app_settings",
      ])
    );
  });

  it("users.email is unique and case-insensitive", () => {
    const db = freshDb();
    db.prepare(`INSERT INTO users (email) VALUES (?)`).run("alice@example.com");
    expect(() =>
      db.prepare(`INSERT INTO users (email) VALUES (?)`).run("ALICE@example.com")
    ).toThrow(/UNIQUE/);
  });

  it("users.role and users.status enforce CHECK constraints", () => {
    const db = freshDb();
    expect(() =>
      db.prepare(`INSERT INTO users (email, role) VALUES (?, ?)`).run("a@b.c", "superuser")
    ).toThrow(/CHECK/);
    expect(() =>
      db.prepare(`INSERT INTO users (email, status) VALUES (?, ?)`).run("a@b.c", "weird")
    ).toThrow(/CHECK/);
  });

  it("generations.user_id ON DELETE RESTRICT prevents user delete with generations", () => {
    const db = freshDb();
    db.exec(`PRAGMA foreign_keys = ON`);
    const uid = (db.prepare(`INSERT INTO users (email) VALUES (?)`).run("a@b.c").lastInsertRowid as number);
    db.prepare(`INSERT INTO generations (user_id, model_id, status) VALUES (?, ?, 'completed')`).run(uid, "m1");
    expect(() => db.prepare(`DELETE FROM users WHERE id=?`).run(uid)).toThrow(/FOREIGN KEY/);
  });

  it("sessions cascade-delete when user is deleted", () => {
    const db = freshDb();
    db.exec(`PRAGMA foreign_keys = ON`);
    const uid = db.prepare(`INSERT INTO users (email) VALUES (?)`).run("a@b.c").lastInsertRowid as number;
    db.prepare(`INSERT INTO sessions (id, user_id, expires_at) VALUES (?, ?, datetime('now','+1 day'))`).run("sid1", uid);
    db.prepare(`DELETE FROM users WHERE id=?`).run(uid);
    const rows = db.prepare(`SELECT * FROM sessions WHERE user_id=?`).all(uid);
    expect(rows).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run, verify it fails**

```bash
npx vitest run lib/__tests__/history-db-schema.test.ts
```

Expected: FAIL — `initSchema` либо не существует, либо не создаёт новые таблицы.

- [ ] **Step 3: Rewrite `lib/history-db.ts` schema portion**

Open `lib/history-db.ts`. Найти существующие `CREATE TABLE` блоки (строки ~37-78 в исходнике). **Заменить весь init-блок** на следующую функцию `initSchema`:

```ts
// === Place near the top of lib/history-db.ts, replacing the old initialization ===

import Database from "better-sqlite3";

/**
 * Initialize all tables and indexes. Idempotent (uses IF NOT EXISTS).
 * Exported for tests so they can run against an in-memory DB.
 */
export function initSchema(db: Database.Database): void {
  db.exec(`PRAGMA journal_mode = WAL;`);
  db.exec(`PRAGMA foreign_keys = ON;`);

  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      email           TEXT    NOT NULL UNIQUE COLLATE NOCASE,
      google_sub      TEXT    UNIQUE,
      name            TEXT,
      picture_url     TEXT,
      role            TEXT    NOT NULL DEFAULT 'user'
                              CHECK (role IN ('user','admin')),
      status          TEXT    NOT NULL DEFAULT 'active'
                              CHECK (status IN ('active','banned','deleted')),
      created_at      TEXT    DEFAULT (datetime('now')),
      last_login_at   TEXT
    );

    CREATE TABLE IF NOT EXISTS sessions (
      id            TEXT    PRIMARY KEY,
      user_id       INTEGER NOT NULL,
      created_at    TEXT    DEFAULT (datetime('now')),
      expires_at    TEXT    NOT NULL,
      last_seen_at  TEXT,
      user_agent    TEXT,
      ip            TEXT,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_sessions_user_id ON sessions(user_id);
    CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);

    CREATE TABLE IF NOT EXISTS models (
      model_id              TEXT    PRIMARY KEY,
      display_name          TEXT    NOT NULL,
      default_monthly_limit INTEGER,
      is_active             INTEGER NOT NULL DEFAULT 1,
      created_at            TEXT    DEFAULT (datetime('now')),
      updated_at            TEXT    DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS user_quotas (
      user_id        INTEGER NOT NULL,
      model_id       TEXT    NOT NULL,
      monthly_limit  INTEGER,
      updated_at     TEXT    DEFAULT (datetime('now')),
      PRIMARY KEY (user_id, model_id),
      FOREIGN KEY (user_id)  REFERENCES users(id)  ON DELETE CASCADE,
      FOREIGN KEY (model_id) REFERENCES models(model_id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS auth_events (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp   TEXT    DEFAULT (datetime('now')),
      event_type  TEXT    NOT NULL,
      email       TEXT,
      user_id     INTEGER,
      ip          TEXT,
      user_agent  TEXT,
      details     TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_auth_events_ts ON auth_events(timestamp DESC);

    CREATE TABLE IF NOT EXISTS generations (
      id                      INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id                 INTEGER NOT NULL,
      model_id                TEXT,
      provider                TEXT,
      workflow_name           TEXT    DEFAULT '',
      prompt_data             TEXT    DEFAULT '{}',
      execution_time_seconds  REAL    DEFAULT 0,
      created_at              TEXT    DEFAULT (datetime('now')),
      status                  TEXT    DEFAULT 'completed',
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE RESTRICT
    );
    CREATE INDEX IF NOT EXISTS idx_generations_user_id            ON generations(user_id);
    CREATE INDEX IF NOT EXISTS idx_generations_created_at         ON generations(created_at);
    CREATE INDEX IF NOT EXISTS idx_generations_user_model_created ON generations(user_id, model_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_generations_provider           ON generations(provider);

    CREATE TABLE IF NOT EXISTS generation_outputs (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      generation_id   INTEGER NOT NULL,
      filename        TEXT    NOT NULL,
      filepath        TEXT    NOT NULL,
      content_type    TEXT    NOT NULL,
      size            INTEGER DEFAULT 0,
      FOREIGN KEY (generation_id) REFERENCES generations(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_generation_outputs_generation_id ON generation_outputs(generation_id);

    CREATE TABLE IF NOT EXISTS user_preferences (
      user_id        INTEGER PRIMARY KEY,
      selected_model TEXT,
      updated_at     TEXT    DEFAULT (datetime('now')),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS app_settings (
      key        TEXT    PRIMARY KEY,
      value      TEXT    NOT NULL,
      updated_at TEXT    DEFAULT (datetime('now'))
    );
  `);
}
```

Заменить старый `initDb()` (или как он там называется) — теперь он вызывает `initSchema(db)`. Любые функции в этом файле, которые писали по `username TEXT`, теперь обращаются к `user_id INTEGER` — но эти функции мы будем переписывать в Task 7.x; здесь только схема.

**Важно**: оставить экспорт `getHistoryImagesDir()` без изменений — он используется в нескольких местах. Если есть функции типа `saveGeneration({username, ...})` — они на этом этапе будут компилироваться, но семантически сломаны (напишут username=NULL в user_id, что упадёт). Это OK: исправим в Phase 7.

- [ ] **Step 4: Run schema test**

```bash
npx vitest run lib/__tests__/history-db-schema.test.ts
```

Expected: 5 tests passed.

- [ ] **Step 5: Verify existing tests still pass (or red-list explicitly broken ones)**

```bash
npm test
```

Существующие тесты в `lib/history/__tests__/` могут падать (они опираются на старую схему с `username`). На этом этапе ожидаемо. **Если они падают — записать список упавших файлов в коммит-сообщение,** будем чинить в Phase 7.

- [ ] **Step 6: Commit**

```bash
git add lib/history-db.ts lib/__tests__/history-db-schema.test.ts
git commit -m "feat(db): rewrite schema for users/sessions/quotas/auth_events"
```

---

### Task 2.4: `audit` — auth_events writer

**Files:**
- Create: `lib/auth/audit.ts`
- Test: `lib/auth/__tests__/audit.test.ts`

- [ ] **Step 1: Write failing tests**

Create `lib/auth/__tests__/audit.test.ts`:

```ts
import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { initSchema } from "@/lib/history-db";
import { writeAuthEvent, type AuthEventType } from "../audit";

let db: Database.Database;

beforeEach(() => {
  db = new Database(":memory:");
  initSchema(db);
});

describe("writeAuthEvent", () => {
  it("inserts a row with the given fields", () => {
    writeAuthEvent(db, {
      event_type: "login_ok",
      email: "alice@x.com",
      user_id: 1,
      ip: "1.2.3.4",
      user_agent: "ua",
      details: { foo: "bar" },
    });
    const row = db.prepare(`SELECT * FROM auth_events ORDER BY id DESC LIMIT 1`).get() as any;
    expect(row.event_type).toBe("login_ok");
    expect(row.email).toBe("alice@x.com");
    expect(row.user_id).toBe(1);
    expect(row.ip).toBe("1.2.3.4");
    expect(row.user_agent).toBe("ua");
    expect(JSON.parse(row.details)).toEqual({ foo: "bar" });
    expect(row.timestamp).toBeTruthy();
  });

  it("accepts minimal payload", () => {
    writeAuthEvent(db, { event_type: "logout" });
    const row = db.prepare(`SELECT * FROM auth_events`).get() as any;
    expect(row.event_type).toBe("logout");
    expect(row.email).toBeNull();
  });

  it("typescript: rejects invalid event_type at compile time", () => {
    // @ts-expect-error — bad event_type
    writeAuthEvent(db, { event_type: "not_a_real_event" });
    // The line above must produce a compile error; we don't need a runtime assertion.
    expect(true).toBe(true);
  });
});
```

- [ ] **Step 2: Run, verify it fails**

```bash
npx vitest run lib/auth/__tests__/audit.test.ts
```

Expected: import error.

- [ ] **Step 3: Implement**

Create `lib/auth/audit.ts`:

```ts
import type Database from "better-sqlite3";

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
  | "admin_quota_changed"
  | "admin_model_default_changed";

export interface AuthEventInput {
  event_type: AuthEventType;
  email?: string | null;
  user_id?: number | null;
  ip?: string | null;
  user_agent?: string | null;
  details?: Record<string, unknown> | null;
}

/**
 * Append-only audit log writer. Never throws — failures are logged and swallowed
 * because audit failure must not break the user-visible flow.
 */
export function writeAuthEvent(db: Database.Database, ev: AuthEventInput): void {
  try {
    db.prepare(
      `INSERT INTO auth_events (event_type, email, user_id, ip, user_agent, details)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).run(
      ev.event_type,
      ev.email ?? null,
      ev.user_id ?? null,
      ev.ip ?? null,
      ev.user_agent ?? null,
      ev.details ? JSON.stringify(ev.details) : null
    );
  } catch (err) {
    console.error("[audit] writeAuthEvent failed:", err);
  }
}
```

- [ ] **Step 4: Run, verify it passes**

```bash
npx vitest run lib/auth/__tests__/audit.test.ts
```

Expected: 3 tests passed (the `@ts-expect-error` line counts as a positive at compile time).

- [ ] **Step 5: Commit**

```bash
git add lib/auth/audit.ts lib/auth/__tests__/audit.test.ts
git commit -m "feat(auth): typed auth_events audit log writer"
```

---

### Task 2.5: Models seeding + admin bootstrap from env

**Files:**
- Modify: `lib/history-db.ts` (добавить `seedModels` и `bootstrapAdmins`)
- Test: `lib/__tests__/history-db-bootstrap.test.ts`

- [ ] **Step 1: Write failing tests**

Create `lib/__tests__/history-db-bootstrap.test.ts`:

```ts
import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { initSchema, seedModels, bootstrapAdmins } from "@/lib/history-db";

let db: Database.Database;

beforeEach(() => {
  db = new Database(":memory:");
  initSchema(db);
});

describe("seedModels", () => {
  it("inserts a row per known model", () => {
    seedModels(db);
    const rows = db.prepare(`SELECT model_id, display_name, default_monthly_limit FROM models`).all();
    const ids = (rows as any[]).map((r) => r.model_id);
    expect(ids).toEqual(
      expect.arrayContaining([
        "nano-banana-pro", "nano-banana-2", "nano-banana",
        "seedream-4-5", "seedream-5-0-lite",
      ])
    );
    // Defaults are NULL (unlimited) until admin sets them
    expect((rows as any[])[0].default_monthly_limit).toBeNull();
  });

  it("is idempotent (running twice doesn't duplicate)", () => {
    seedModels(db);
    seedModels(db);
    const count = (db.prepare(`SELECT COUNT(*) AS n FROM models`).get() as any).n;
    expect(count).toBe(5);
  });

  it("does not reset default_monthly_limit if already set by admin", () => {
    seedModels(db);
    db.prepare(`UPDATE models SET default_monthly_limit=100 WHERE model_id='nano-banana-pro'`).run();
    seedModels(db);
    const r = db.prepare(`SELECT default_monthly_limit FROM models WHERE model_id='nano-banana-pro'`).get() as any;
    expect(r.default_monthly_limit).toBe(100);
  });
});

describe("bootstrapAdmins", () => {
  it("creates admin users from CSV env", () => {
    bootstrapAdmins(db, "alice@x.com,bob@y.com");
    const rows = db.prepare(`SELECT email, role, status FROM users ORDER BY email`).all() as any[];
    expect(rows).toEqual([
      { email: "alice@x.com", role: "admin", status: "active" },
      { email: "bob@y.com",   role: "admin", status: "active" },
    ]);
  });

  it("lowercases and trims", () => {
    bootstrapAdmins(db, "  ALICE@x.com  , Bob@Y.com ");
    const rows = db.prepare(`SELECT email FROM users ORDER BY email`).all() as any[];
    expect(rows.map((r) => r.email)).toEqual(["alice@x.com", "bob@y.com"]);
  });

  it("is idempotent and promotes existing user to admin", () => {
    db.prepare(`INSERT INTO users (email, role) VALUES (?, 'user')`).run("alice@x.com");
    bootstrapAdmins(db, "alice@x.com");
    const r = db.prepare(`SELECT role, status FROM users WHERE email='alice@x.com'`).get() as any;
    expect(r.role).toBe("admin");
    expect(r.status).toBe("active");
  });

  it("does NOT resurrect a soft-deleted user", () => {
    db.prepare(`INSERT INTO users (email, role, status) VALUES (?, 'user', 'deleted')`).run("alice@x.com");
    bootstrapAdmins(db, "alice@x.com");
    const r = db.prepare(`SELECT role, status FROM users WHERE email='alice@x.com'`).get() as any;
    // Status remains 'deleted' — explicit policy: rest of session won't auto-resurrect
    expect(r.status).toBe("deleted");
  });

  it("handles empty/missing env gracefully", () => {
    bootstrapAdmins(db, "");
    bootstrapAdmins(db, undefined);
    const count = (db.prepare(`SELECT COUNT(*) AS n FROM users`).get() as any).n;
    expect(count).toBe(0);
  });
});
```

- [ ] **Step 2: Run, verify it fails**

```bash
npx vitest run lib/__tests__/history-db-bootstrap.test.ts
```

Expected: import error or function-not-defined.

- [ ] **Step 3: Implement**

Add to `lib/history-db.ts` (anywhere after `initSchema`):

```ts
import type { ModelId } from "./providers/types";

const KNOWN_MODELS: Array<{ id: ModelId; name: string }> = [
  { id: "nano-banana-pro",   name: "Nano Banana Pro" },
  { id: "nano-banana-2",     name: "Nano Banana 2" },
  { id: "nano-banana",       name: "Nano Banana" },
  { id: "seedream-4-5",      name: "Seedream 4.5" },
  { id: "seedream-5-0-lite", name: "Seedream 5.0 Lite" },
];

/**
 * Insert a row in `models` for each known ModelId. Idempotent. Does NOT
 * overwrite admin-set `default_monthly_limit` or `display_name` on subsequent
 * runs (uses INSERT OR IGNORE).
 */
export function seedModels(db: Database.Database): void {
  const stmt = db.prepare(
    `INSERT OR IGNORE INTO models (model_id, display_name) VALUES (?, ?)`
  );
  const tx = db.transaction((items: Array<{ id: string; name: string }>) => {
    for (const m of items) stmt.run(m.id, m.name);
  });
  tx(KNOWN_MODELS);
}

/**
 * Promote the given CSV emails to admin. Idempotent. Does NOT resurrect
 * soft-deleted users (status='deleted' stays — explicit op required to undo).
 *
 * Pass `process.env.BOOTSTRAP_ADMIN_EMAILS` directly. Empty/undefined is a no-op.
 */
export function bootstrapAdmins(db: Database.Database, csv: string | undefined): void {
  if (!csv) return;
  const emails = csv
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  if (emails.length === 0) return;

  const stmt = db.prepare(`
    INSERT INTO users (email, role, status) VALUES (?, 'admin', 'active')
    ON CONFLICT (email) DO UPDATE
      SET role='admin', status='active'
      WHERE status != 'deleted'
  `);
  const tx = db.transaction((list: string[]) => {
    for (const e of list) stmt.run(e);
  });
  tx(emails);
}
```

In the existing `getDb()`/init function (where `initSchema` is now called at startup), also call `seedModels(db)` and `bootstrapAdmins(db, process.env.BOOTSTRAP_ADMIN_EMAILS)` after `initSchema`.

- [ ] **Step 4: Run tests**

```bash
npx vitest run lib/__tests__/history-db-bootstrap.test.ts
```

Expected: 7 tests passed.

- [ ] **Step 5: Commit**

```bash
git add lib/history-db.ts lib/__tests__/history-db-bootstrap.test.ts
git commit -m "feat(db): seedModels + bootstrapAdmins (idempotent, soft-delete safe)"
```

---

## Phase 3: Sessions and currentUser

### Task 3.1: Session helpers (create/get/extend/destroy)

**Files:**
- Create: `lib/auth/session.ts`
- Test: `lib/auth/__tests__/session.test.ts`

- [ ] **Step 1: Write failing tests**

Create `lib/auth/__tests__/session.test.ts`:

```ts
import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { initSchema } from "@/lib/history-db";
import { createSession, getSessionRow, deleteSession, deleteSessionsForUser, SESSION_TTL_MS } from "../session";

let db: Database.Database;
let userId: number;

beforeEach(() => {
  db = new Database(":memory:");
  initSchema(db);
  userId = db.prepare(`INSERT INTO users (email) VALUES ('alice@x.com')`).run().lastInsertRowid as number;
});

describe("createSession", () => {
  it("returns a session_id and inserts a row", () => {
    const sid = createSession(db, { user_id: userId, ip: "1.2.3.4", user_agent: "ua", now: 1700000000000 });
    expect(sid).toMatch(/^[A-Za-z0-9_-]{43}$/); // base64url of 32 bytes (no padding) is 43 chars
    const row = db.prepare(`SELECT * FROM sessions WHERE id=?`).get(sid) as any;
    expect(row.user_id).toBe(userId);
    expect(row.ip).toBe("1.2.3.4");
    expect(new Date(row.expires_at).getTime()).toBe(1700000000000 + SESSION_TTL_MS);
  });

  it("each call generates a unique id", () => {
    const a = createSession(db, { user_id: userId });
    const b = createSession(db, { user_id: userId });
    expect(a).not.toBe(b);
  });
});

describe("getSessionRow", () => {
  it("returns row for an active session", () => {
    const sid = createSession(db, { user_id: userId });
    const row = getSessionRow(db, sid);
    expect(row).toBeTruthy();
    expect(row!.user_id).toBe(userId);
  });

  it("returns null for unknown sid", () => {
    expect(getSessionRow(db, "nonexistent")).toBeNull();
  });
});

describe("deleteSession", () => {
  it("removes a session by id", () => {
    const sid = createSession(db, { user_id: userId });
    deleteSession(db, sid);
    expect(getSessionRow(db, sid)).toBeNull();
  });
});

describe("deleteSessionsForUser", () => {
  it("removes all sessions for a user", () => {
    createSession(db, { user_id: userId });
    createSession(db, { user_id: userId });
    deleteSessionsForUser(db, userId);
    const rows = db.prepare(`SELECT * FROM sessions WHERE user_id=?`).all(userId);
    expect(rows).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run, verify it fails**

```bash
npx vitest run lib/auth/__tests__/session.test.ts
```

Expected: import error.

- [ ] **Step 3: Implement**

Create `lib/auth/session.ts`:

```ts
import crypto from "node:crypto";
import type Database from "better-sqlite3";

export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
export const SLIDING_THROTTLE_MS = 60 * 60 * 1000;      // 1 hour

export interface SessionRow {
  id: string;
  user_id: number;
  created_at: string;
  expires_at: string;
  last_seen_at: string | null;
  user_agent: string | null;
  ip: string | null;
}

function newSessionId(): string {
  return crypto.randomBytes(32).toString("base64url");
}

export function createSession(
  db: Database.Database,
  args: { user_id: number; ip?: string | null; user_agent?: string | null; now?: number }
): string {
  const sid = newSessionId();
  const now = args.now ?? Date.now();
  const expires = new Date(now + SESSION_TTL_MS).toISOString();
  const lastSeen = new Date(now).toISOString();
  db.prepare(
    `INSERT INTO sessions (id, user_id, expires_at, last_seen_at, ip, user_agent)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(sid, args.user_id, expires, lastSeen, args.ip ?? null, args.user_agent ?? null);
  return sid;
}

export function getSessionRow(db: Database.Database, sid: string): SessionRow | null {
  const row = db.prepare(`SELECT * FROM sessions WHERE id=?`).get(sid) as SessionRow | undefined;
  return row ?? null;
}

export function deleteSession(db: Database.Database, sid: string): void {
  db.prepare(`DELETE FROM sessions WHERE id=?`).run(sid);
}

export function deleteSessionsForUser(db: Database.Database, user_id: number): void {
  db.prepare(`DELETE FROM sessions WHERE user_id=?`).run(user_id);
}

/**
 * Sliding renewal: bump expires_at and last_seen_at, but only if `last_seen_at`
 * is older than SLIDING_THROTTLE_MS. Avoids writing to the DB on every request.
 *
 * Returns true if the renewal happened, false if it was skipped (still fresh).
 */
export function maybeRenewSession(
  db: Database.Database,
  sid: string,
  lastSeenIso: string,
  now = Date.now()
): boolean {
  const ageMs = now - new Date(lastSeenIso).getTime();
  if (ageMs <= SLIDING_THROTTLE_MS) return false;
  const newExpires = new Date(now + SESSION_TTL_MS).toISOString();
  const newLastSeen = new Date(now).toISOString();
  db.prepare(`UPDATE sessions SET expires_at=?, last_seen_at=? WHERE id=?`).run(
    newExpires, newLastSeen, sid
  );
  return true;
}
```

- [ ] **Step 4: Run tests**

```bash
npx vitest run lib/auth/__tests__/session.test.ts
```

Expected: 6 tests passed.

- [ ] **Step 5: Commit**

```bash
git add lib/auth/session.ts lib/auth/__tests__/session.test.ts
git commit -m "feat(auth): session create/get/delete + sliding renewal helpers"
```

---

### Task 3.2: `getCurrentUser` — central auth resolver

**Files:**
- Create: `lib/auth/current-user.ts`
- Test: `lib/auth/__tests__/current-user.test.ts`

- [ ] **Step 1: Write failing tests**

Create `lib/auth/__tests__/current-user.test.ts`:

```ts
import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { initSchema } from "@/lib/history-db";
import { createSession, SLIDING_THROTTLE_MS, SESSION_TTL_MS } from "../session";
import { getCurrentUser } from "../current-user";

let db: Database.Database;
let userId: number;
let sid: string;

beforeEach(() => {
  db = new Database(":memory:");
  initSchema(db);
  userId = db.prepare(
    `INSERT INTO users (email, name, role, status) VALUES ('alice@x.com', 'Alice', 'user', 'active')`
  ).run().lastInsertRowid as number;
  sid = createSession(db, { user_id: userId, now: 1700000000000 });
});

describe("getCurrentUser", () => {
  it("returns user object for valid sid", () => {
    const u = getCurrentUser(db, sid, { now: 1700000000000 });
    expect(u).toEqual(expect.objectContaining({
      id: userId, email: "alice@x.com", name: "Alice", role: "user",
    }));
  });

  it("returns null for unknown sid", () => {
    expect(getCurrentUser(db, "no-such-sid")).toBeNull();
  });

  it("returns null and deletes session if expired", () => {
    const farFuture = 1700000000000 + SESSION_TTL_MS + 1000;
    expect(getCurrentUser(db, sid, { now: farFuture })).toBeNull();
    expect(db.prepare(`SELECT * FROM sessions WHERE id=?`).get(sid)).toBeUndefined();
  });

  it("returns null and deletes ALL user sessions if user is banned", () => {
    const sid2 = createSession(db, { user_id: userId, now: 1700000000000 });
    db.prepare(`UPDATE users SET status='banned' WHERE id=?`).run(userId);
    expect(getCurrentUser(db, sid, { now: 1700000000000 })).toBeNull();
    expect(db.prepare(`SELECT * FROM sessions WHERE user_id=?`).all(userId)).toHaveLength(0);
    // sid2 also gone
    void sid2;
  });

  it("returns null and deletes sessions if user is soft-deleted", () => {
    db.prepare(`UPDATE users SET status='deleted' WHERE id=?`).run(userId);
    expect(getCurrentUser(db, sid, { now: 1700000000000 })).toBeNull();
    expect(db.prepare(`SELECT * FROM sessions WHERE user_id=?`).all(userId)).toHaveLength(0);
  });

  it("renews session if last_seen older than throttle", () => {
    const now = 1700000000000 + SLIDING_THROTTLE_MS + 1000;
    const before = (db.prepare(`SELECT expires_at FROM sessions WHERE id=?`).get(sid) as any).expires_at;
    getCurrentUser(db, sid, { now });
    const after = (db.prepare(`SELECT expires_at FROM sessions WHERE id=?`).get(sid) as any).expires_at;
    expect(after).not.toBe(before);
  });

  it("does NOT renew if recently seen", () => {
    const now = 1700000000000 + 100; // very fresh
    const before = (db.prepare(`SELECT expires_at FROM sessions WHERE id=?`).get(sid) as any).expires_at;
    getCurrentUser(db, sid, { now });
    const after = (db.prepare(`SELECT expires_at FROM sessions WHERE id=?`).get(sid) as any).expires_at;
    expect(after).toBe(before);
  });
});
```

- [ ] **Step 2: Run, verify it fails**

```bash
npx vitest run lib/auth/__tests__/current-user.test.ts
```

Expected: import error.

- [ ] **Step 3: Implement**

Create `lib/auth/current-user.ts`:

```ts
import type Database from "better-sqlite3";
import { deleteSession, deleteSessionsForUser, maybeRenewSession } from "./session";

export interface CurrentUser {
  id: number;
  email: string;
  name: string | null;
  picture_url: string | null;
  role: "user" | "admin";
}

interface JoinedRow {
  sid: string;
  expires_at: string;
  last_seen_at: string | null;
  created_at_session: string;
  user_id: number;
  email: string;
  name: string | null;
  picture_url: string | null;
  role: "user" | "admin";
  status: "active" | "banned" | "deleted";
}

export function getCurrentUser(
  db: Database.Database,
  sid: string | null | undefined,
  opts: { now?: number } = {}
): CurrentUser | null {
  if (!sid) return null;
  const row = db.prepare(`
    SELECT s.id AS sid, s.expires_at, s.last_seen_at, s.created_at AS created_at_session,
           u.id AS user_id, u.email, u.name, u.picture_url, u.role, u.status
    FROM sessions s JOIN users u ON u.id = s.user_id
    WHERE s.id = ?
  `).get(sid) as JoinedRow | undefined;
  if (!row) return null;

  const now = opts.now ?? Date.now();

  if (new Date(row.expires_at).getTime() < now) {
    deleteSession(db, sid);
    return null;
  }
  if (row.status !== "active") {
    deleteSessionsForUser(db, row.user_id);
    return null;
  }

  const lastSeen = row.last_seen_at ?? row.created_at_session;
  maybeRenewSession(db, sid, lastSeen, now);

  return {
    id: row.user_id,
    email: row.email,
    name: row.name,
    picture_url: row.picture_url,
    role: row.role,
  };
}
```

- [ ] **Step 4: Run tests**

```bash
npx vitest run lib/auth/__tests__/current-user.test.ts
```

Expected: 7 tests passed.

- [ ] **Step 5: Commit**

```bash
git add lib/auth/current-user.ts lib/auth/__tests__/current-user.test.ts
git commit -m "feat(auth): getCurrentUser with auto-revoke on banned/deleted/expired"
```

---

## Phase 4: Quota helpers

### Task 4.1: `currentMonthBoundsUTC` + `applicableLimit` + `usageThisMonth`

**Files:**
- Create: `lib/quotas.ts`
- Test: `lib/__tests__/quotas.test.ts`

- [ ] **Step 1: Write failing tests**

Create `lib/__tests__/quotas.test.ts`:

```ts
import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { initSchema, seedModels } from "@/lib/history-db";
import { applicableLimit, usageThisMonth, currentMonthBoundsUTC } from "../quotas";

let db: Database.Database;
let userId: number;

beforeEach(() => {
  db = new Database(":memory:");
  initSchema(db);
  seedModels(db);
  userId = db.prepare(`INSERT INTO users (email) VALUES ('alice@x.com')`).run().lastInsertRowid as number;
});

describe("currentMonthBoundsUTC", () => {
  it("returns ISO start and end-of-current-month for a given date", () => {
    const [start, end] = currentMonthBoundsUTC(new Date(Date.UTC(2026, 3, 15, 12, 0, 0))); // April 15 noon UTC
    expect(start).toBe("2026-04-01T00:00:00.000Z");
    expect(end).toBe("2026-05-01T00:00:00.000Z");
  });

  it("handles December → January correctly", () => {
    const [start, end] = currentMonthBoundsUTC(new Date(Date.UTC(2026, 11, 31, 23, 59, 59)));
    expect(start).toBe("2026-12-01T00:00:00.000Z");
    expect(end).toBe("2027-01-01T00:00:00.000Z");
  });
});

describe("applicableLimit", () => {
  it("returns NULL (unlimited) when no override and default is NULL", () => {
    expect(applicableLimit(db, userId, "nano-banana-pro")).toBeNull();
  });

  it("returns default when set on models and no override", () => {
    db.prepare(`UPDATE models SET default_monthly_limit=100 WHERE model_id='nano-banana-pro'`).run();
    expect(applicableLimit(db, userId, "nano-banana-pro")).toBe(100);
  });

  it("override wins over default (number)", () => {
    db.prepare(`UPDATE models SET default_monthly_limit=100 WHERE model_id='nano-banana-pro'`).run();
    db.prepare(`INSERT INTO user_quotas (user_id, model_id, monthly_limit) VALUES (?, ?, ?)`).run(userId, "nano-banana-pro", 50);
    expect(applicableLimit(db, userId, "nano-banana-pro")).toBe(50);
  });

  it("override NULL means unlimited even if default is set", () => {
    db.prepare(`UPDATE models SET default_monthly_limit=100 WHERE model_id='nano-banana-pro'`).run();
    db.prepare(`INSERT INTO user_quotas (user_id, model_id, monthly_limit) VALUES (?, ?, NULL)`).run(userId, "nano-banana-pro");
    expect(applicableLimit(db, userId, "nano-banana-pro")).toBeNull();
  });

  it("returns 0 (block) for unknown model_id (closed by default)", () => {
    expect(applicableLimit(db, userId, "no-such-model")).toBe(0);
  });
});

describe("usageThisMonth", () => {
  it("returns 0 when no generations", () => {
    expect(usageThisMonth(db, userId, "nano-banana-pro", new Date(Date.UTC(2026, 3, 15)))).toBe(0);
  });

  it("counts only completed generations in current month", () => {
    const ins = db.prepare(`INSERT INTO generations (user_id, model_id, status, created_at) VALUES (?, ?, ?, ?)`);
    ins.run(userId, "nano-banana-pro", "completed", "2026-04-10T12:00:00Z");
    ins.run(userId, "nano-banana-pro", "completed", "2026-04-25T12:00:00Z");
    ins.run(userId, "nano-banana-pro", "failed",    "2026-04-15T12:00:00Z");   // not counted
    ins.run(userId, "nano-banana-pro", "completed", "2026-03-30T12:00:00Z");   // previous month
    ins.run(userId, "nano-banana-pro", "completed", "2026-05-01T00:00:00Z");   // next month boundary
    ins.run(userId, "seedream-4-5",    "completed", "2026-04-15T12:00:00Z");   // different model

    const now = new Date(Date.UTC(2026, 3, 30));
    expect(usageThisMonth(db, userId, "nano-banana-pro", now)).toBe(2);
    expect(usageThisMonth(db, userId, "seedream-4-5", now)).toBe(1);
  });
});
```

- [ ] **Step 2: Run, verify it fails**

```bash
npx vitest run lib/__tests__/quotas.test.ts
```

Expected: import error.

- [ ] **Step 3: Implement**

Create `lib/quotas.ts`:

```ts
import type Database from "better-sqlite3";

/**
 * UTC bounds of the calendar month containing `now`.
 * Returns [startInclusive, endExclusive] as ISO 8601 strings.
 */
export function currentMonthBoundsUTC(now: Date = new Date()): [string, string] {
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth();
  const start = new Date(Date.UTC(y, m,     1, 0, 0, 0, 0)).toISOString();
  const end   = new Date(Date.UTC(y, m + 1, 1, 0, 0, 0, 0)).toISOString();
  return [start, end];
}

/**
 * Resolve the applicable monthly_limit for (user, model). Logic:
 *   1. user_quotas override (NULL = explicit unlimited override)
 *   2. otherwise models.default_monthly_limit (NULL = unlimited)
 *   3. otherwise (model not in `models` table at all) — return 0 (closed by default
 *      for unknown ids, defense against trying to bypass quota with a fake model_id)
 *
 * Returns: null = unlimited, number = max generations per calendar month UTC.
 */
export function applicableLimit(
  db: Database.Database,
  user_id: number,
  model_id: string
): number | null {
  // Sentinel: rowid presence vs NULL value. Use a row-existence check first.
  const override = db.prepare(
    `SELECT monthly_limit FROM user_quotas WHERE user_id=? AND model_id=?`
  ).get(user_id, model_id) as { monthly_limit: number | null } | undefined;
  if (override) return override.monthly_limit; // may be NULL (unlimited)

  const def = db.prepare(
    `SELECT default_monthly_limit FROM models WHERE model_id=?`
  ).get(model_id) as { default_monthly_limit: number | null } | undefined;
  if (!def) return 0; // unknown model → closed by default
  return def.default_monthly_limit;
}

/**
 * Count of `completed` generations for (user, model) within the current
 * calendar month UTC. `now` defaults to `new Date()` for testability.
 */
export function usageThisMonth(
  db: Database.Database,
  user_id: number,
  model_id: string,
  now: Date = new Date()
): number {
  const [start, end] = currentMonthBoundsUTC(now);
  const r = db.prepare(`
    SELECT COUNT(*) AS n FROM generations
    WHERE user_id=? AND model_id=?
      AND created_at >= ? AND created_at < ?
      AND status = 'completed'
  `).get(user_id, model_id, start, end) as { n: number };
  return r.n;
}
```

- [ ] **Step 4: Run tests**

```bash
npx vitest run lib/__tests__/quotas.test.ts
```

Expected: 9 tests passed.

- [ ] **Step 5: Commit**

```bash
git add lib/quotas.ts lib/__tests__/quotas.test.ts
git commit -m "feat(quotas): applicableLimit, usageThisMonth, currentMonthBoundsUTC"
```

---

## Phase 5: Google OAuth utils + endpoints

### Task 5.1: `verifyIdToken` (jose + JWKS)

**Files:**
- Create: `lib/auth/google.ts`
- Test: `lib/auth/__tests__/google-verify.test.ts`

- [ ] **Step 1: Write failing tests**

Create `lib/auth/__tests__/google-verify.test.ts`:

```ts
import { describe, it, expect, beforeEach } from "vitest";
import { generateKeyPair, SignJWT, exportJWK, type JWK } from "jose";
import { verifyIdToken } from "../google";

const ISSUER = "https://accounts.google.com";
const AUD = "test-client-id.apps.googleusercontent.com";

let signedToken: string;
let publicJwk: JWK;
let kid: string;

beforeEach(async () => {
  const { publicKey, privateKey } = await generateKeyPair("RS256");
  publicJwk = await exportJWK(publicKey);
  publicJwk.alg = "RS256";
  publicJwk.use = "sig";
  publicJwk.kid = "test-kid-1";
  kid = "test-kid-1";

  signedToken = await new SignJWT({
    email: "alice@x.com",
    email_verified: true,
    sub: "google-sub-123",
    name: "Alice",
    picture: "https://lh.example/p.jpg",
    nonce: "n1",
    hd: "tapclap.com",
  })
    .setProtectedHeader({ alg: "RS256", kid })
    .setIssuer(ISSUER)
    .setAudience(AUD)
    .setExpirationTime("1h")
    .setIssuedAt()
    .sign(privateKey);
});

function fakeJwks() {
  return { keys: [publicJwk] };
}

describe("verifyIdToken", () => {
  it("accepts a valid token", async () => {
    const payload = await verifyIdToken(signedToken, {
      audience: AUD,
      jwks: fakeJwks(),
    });
    expect(payload.email).toBe("alice@x.com");
    expect(payload.sub).toBe("google-sub-123");
    expect(payload.email_verified).toBe(true);
    expect(payload.nonce).toBe("n1");
  });

  it("rejects token signed with another key", async () => {
    const { privateKey: other } = await generateKeyPair("RS256");
    const tampered = await new SignJWT({ email: "a@b.c", sub: "x", email_verified: true })
      .setProtectedHeader({ alg: "RS256", kid })
      .setIssuer(ISSUER).setAudience(AUD).setExpirationTime("1h").sign(other);
    await expect(verifyIdToken(tampered, { audience: AUD, jwks: fakeJwks() })).rejects.toThrow();
  });

  it("rejects token with wrong issuer", async () => {
    const { privateKey } = await generateKeyPair("RS256");
    const pub = await exportJWK((await generateKeyPair("RS256")).publicKey);
    void pub;
    const t = await new SignJWT({ email: "a@b.c", sub: "x", email_verified: true })
      .setProtectedHeader({ alg: "RS256", kid })
      .setIssuer("https://evil.com").setAudience(AUD).setExpirationTime("1h").sign(privateKey);
    await expect(verifyIdToken(t, { audience: AUD, jwks: fakeJwks() })).rejects.toThrow();
  });

  it("rejects token with wrong audience", async () => {
    const { privateKey } = await generateKeyPair("RS256");
    const t = await new SignJWT({ email: "a@b.c", sub: "x", email_verified: true })
      .setProtectedHeader({ alg: "RS256", kid })
      .setIssuer(ISSUER).setAudience("OTHER").setExpirationTime("1h").sign(privateKey);
    await expect(verifyIdToken(t, { audience: AUD, jwks: fakeJwks() })).rejects.toThrow();
  });
});
```

- [ ] **Step 2: Run, verify it fails**

```bash
npx vitest run lib/auth/__tests__/google-verify.test.ts
```

Expected: import error.

- [ ] **Step 3: Implement (verify only — full module fleshed out in 5.2)**

Create `lib/auth/google.ts`:

```ts
import { jwtVerify, createLocalJWKSet, type JSONWebKeySet } from "jose";

const GOOGLE_ISSUER = "https://accounts.google.com";

export interface GoogleIdTokenPayload {
  email: string;
  email_verified: boolean;
  sub: string;
  name?: string;
  picture?: string;
  nonce?: string;
  hd?: string;
  iss: string;
  aud: string | string[];
  exp: number;
}

/**
 * Verify a Google id_token. Throws on any failure (signature, iss, aud, exp).
 * Caller is responsible for checking nonce/email_verified/hd/allowlist after this.
 *
 * `jwks` is the parsed JSON Web Key Set. In production this comes from
 * fetching https://www.googleapis.com/oauth2/v3/certs (with caching). In tests
 * we pass it directly.
 */
export async function verifyIdToken(
  token: string,
  opts: { audience: string; jwks: JSONWebKeySet }
): Promise<GoogleIdTokenPayload> {
  const localJwks = createLocalJWKSet(opts.jwks);
  const { payload } = await jwtVerify(token, localJwks, {
    issuer: GOOGLE_ISSUER,
    audience: opts.audience,
  });
  return payload as unknown as GoogleIdTokenPayload;
}
```

- [ ] **Step 4: Run tests**

```bash
npx vitest run lib/auth/__tests__/google-verify.test.ts
```

Expected: 4 tests passed.

- [ ] **Step 5: Commit**

```bash
git add lib/auth/google.ts lib/auth/__tests__/google-verify.test.ts
git commit -m "feat(auth): verifyIdToken via jose + injectable JWKS"
```

---

### Task 5.2: Google OAuth flow utils — buildAuthorizeUrl, exchangeCode, JWKS cache

**Files:**
- Modify: `lib/auth/google.ts`
- Test: `lib/auth/__tests__/google-flow.test.ts`

- [ ] **Step 1: Write failing tests**

Create `lib/auth/__tests__/google-flow.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { buildAuthorizeUrl, generatePkcePair } from "../google";

describe("buildAuthorizeUrl", () => {
  it("produces a Google OAuth URL with all required params", () => {
    const url = buildAuthorizeUrl({
      client_id: "cid",
      redirect_uri: "http://localhost:3000/api/auth/callback",
      state: "s1",
      nonce: "n1",
      code_challenge: "cc1",
    });
    const u = new URL(url);
    expect(u.origin + u.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    expect(u.searchParams.get("client_id")).toBe("cid");
    expect(u.searchParams.get("redirect_uri")).toBe("http://localhost:3000/api/auth/callback");
    expect(u.searchParams.get("response_type")).toBe("code");
    expect(u.searchParams.get("scope")).toBe("openid email profile");
    expect(u.searchParams.get("state")).toBe("s1");
    expect(u.searchParams.get("nonce")).toBe("n1");
    expect(u.searchParams.get("code_challenge")).toBe("cc1");
    expect(u.searchParams.get("code_challenge_method")).toBe("S256");
    expect(u.searchParams.get("prompt")).toBe("select_account");
    expect(u.searchParams.get("access_type")).toBe("online");
  });
});

describe("generatePkcePair", () => {
  it("produces verifier and challenge that match S256", async () => {
    const { code_verifier, code_challenge } = await generatePkcePair();
    // Verifier is 43+ chars b64url
    expect(code_verifier).toMatch(/^[A-Za-z0-9_-]{43,}$/);
    // Recompute the expected challenge ourselves
    const crypto = await import("node:crypto");
    const expected = crypto
      .createHash("sha256").update(code_verifier).digest()
      .toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    expect(code_challenge).toBe(expected);
  });
});
```

- [ ] **Step 2: Run, verify it fails**

```bash
npx vitest run lib/auth/__tests__/google-flow.test.ts
```

Expected: import error for `buildAuthorizeUrl` / `generatePkcePair`.

- [ ] **Step 3: Implement (extend `lib/auth/google.ts`)**

Append to `lib/auth/google.ts`:

```ts
import crypto from "node:crypto";

const GOOGLE_AUTHORIZE_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const GOOGLE_JWKS_URL = "https://www.googleapis.com/oauth2/v3/certs";

export function buildAuthorizeUrl(args: {
  client_id: string;
  redirect_uri: string;
  state: string;
  nonce: string;
  code_challenge: string;
}): string {
  const u = new URL(GOOGLE_AUTHORIZE_URL);
  u.searchParams.set("client_id", args.client_id);
  u.searchParams.set("redirect_uri", args.redirect_uri);
  u.searchParams.set("response_type", "code");
  u.searchParams.set("scope", "openid email profile");
  u.searchParams.set("state", args.state);
  u.searchParams.set("nonce", args.nonce);
  u.searchParams.set("code_challenge", args.code_challenge);
  u.searchParams.set("code_challenge_method", "S256");
  u.searchParams.set("prompt", "select_account");
  u.searchParams.set("access_type", "online");
  return u.toString();
}

export async function generatePkcePair(): Promise<{ code_verifier: string; code_challenge: string }> {
  const code_verifier = crypto.randomBytes(32).toString("base64url");
  const code_challenge = crypto
    .createHash("sha256").update(code_verifier).digest("base64url");
  return { code_verifier, code_challenge };
}

export async function exchangeCodeForTokens(args: {
  code: string;
  code_verifier: string;
  client_id: string;
  client_secret: string;
  redirect_uri: string;
  fetchImpl?: typeof fetch;
}): Promise<{ id_token: string; access_token: string; expires_in: number }> {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code: args.code,
    code_verifier: args.code_verifier,
    client_id: args.client_id,
    client_secret: args.client_secret,
    redirect_uri: args.redirect_uri,
  });
  const f = args.fetchImpl ?? fetch;
  const res = await f(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Google token endpoint ${res.status}: ${text}`);
  }
  return await res.json();
}

// === JWKS cache (in-memory, refreshed on miss/expire) ===
let jwksCache: { fetched_at: number; data: any } | null = null;
const JWKS_TTL_MS = 60 * 60 * 1000;

export async function fetchGoogleJwks(opts: { fetchImpl?: typeof fetch; now?: number } = {}) {
  const now = opts.now ?? Date.now();
  if (jwksCache && now - jwksCache.fetched_at < JWKS_TTL_MS) return jwksCache.data;
  const f = opts.fetchImpl ?? fetch;
  const res = await f(GOOGLE_JWKS_URL);
  if (!res.ok) throw new Error(`Google JWKS fetch failed: ${res.status}`);
  const data = await res.json();
  jwksCache = { fetched_at: now, data };
  return data;
}

/** For tests only — flush the cache between unit tests if needed. */
export function _resetJwksCacheForTests() {
  jwksCache = null;
}
```

- [ ] **Step 4: Run tests**

```bash
npx vitest run lib/auth/__tests__/google-flow.test.ts lib/auth/__tests__/google-verify.test.ts
```

Expected: all green.

- [ ] **Step 5: Commit**

```bash
git add lib/auth/google.ts lib/auth/__tests__/google-flow.test.ts
git commit -m "feat(auth): Google OAuth flow utils (authorize URL, PKCE, code exchange, JWKS cache)"
```

---

### Task 5.3: `GET /api/auth/google` — start of OAuth flow

**Files:**
- Create: `app/api/auth/google/route.ts`

This route is hard to unit-test (it sets cookies and 302s). Verify via manual smoke + the integration test in Task 5.6.

- [ ] **Step 1: Implement**

Create `app/api/auth/google/route.ts`:

```ts
import { NextResponse, type NextRequest } from "next/server";
import crypto from "node:crypto";
import { buildAuthorizeUrl, generatePkcePair } from "@/lib/auth/google";
import { encodeOAuthTx } from "@/lib/auth/oauth-tx";
import { safeNext } from "@/lib/auth/safe-next";

export const runtime = "nodejs";

const PROD = process.env.NODE_ENV === "production";
const COOKIE_NAME = PROD ? "__Host-oauth_tx" : "oauth_tx";

export async function GET(req: NextRequest) {
  const client_id = process.env.GOOGLE_CLIENT_ID;
  const redirect_uri = process.env.GOOGLE_REDIRECT_URI;
  const secret = process.env.SESSION_COOKIE_SECRET;
  if (!client_id || !redirect_uri || !secret) {
    return NextResponse.json({ error: "OAuth not configured" }, { status: 500 });
  }

  const next = safeNext(req.nextUrl.searchParams.get("next"));
  const state = crypto.randomBytes(32).toString("base64url");
  const nonce = crypto.randomBytes(32).toString("base64url");
  const { code_verifier, code_challenge } = await generatePkcePair();

  const cookieValue = encodeOAuthTx(
    { state, nonce, code_verifier, next, ts: Date.now() },
    secret
  );
  const authorize = buildAuthorizeUrl({ client_id, redirect_uri, state, nonce, code_challenge });

  const res = NextResponse.redirect(authorize, 302);
  res.cookies.set({
    name: COOKIE_NAME,
    value: cookieValue,
    httpOnly: true,
    sameSite: "lax",
    secure: PROD,
    path: "/",
    maxAge: 600,
  });
  return res;
}
```

- [ ] **Step 2: Manual smoke (defer until env is configured in Task 12)**

Add a comment noting that this route is exercised by the manual smoke test list in Phase 12. No automated test at this step.

- [ ] **Step 3: Commit**

```bash
git add app/api/auth/google/route.ts
git commit -m "feat(auth): GET /api/auth/google — initiate OAuth flow"
```

---

### Task 5.4: `GET /api/auth/callback` — exchange code, verify, allowlist, create session

**Files:**
- Create: `app/api/auth/callback/route.ts`
- Test: `app/api/auth/__tests__/callback.test.ts`

The callback contains the most policy logic, so we extract a pure handler that takes injectable deps and test it heavily.

- [ ] **Step 1: Refactor — extract pure logic to `lib/auth/handle-callback.ts`**

Create `lib/auth/handle-callback.ts`:

```ts
import type Database from "better-sqlite3";
import type { JSONWebKeySet } from "jose";
import { decodeOAuthTx } from "./oauth-tx";
import { verifyIdToken, exchangeCodeForTokens, type GoogleIdTokenPayload } from "./google";
import { writeAuthEvent } from "./audit";
import { createSession } from "./session";

export type CallbackResult =
  | { kind: "ok"; session_id: string; user_id: number; redirect_to: string }
  | { kind: "error"; status: number; reason: string };

export interface CallbackInputs {
  code: string | null;
  state_in_query: string | null;
  oauth_tx_cookie: string | null;
  ip: string | null;
  user_agent: string | null;
  // Injection
  env: {
    client_id: string;
    client_secret: string;
    redirect_uri: string;
    cookie_secret: string;
    allowed_hd?: string;
  };
  jwks: JSONWebKeySet;
  fetchImpl?: typeof fetch;
  now?: number;
}

export async function handleCallback(
  db: Database.Database,
  inp: CallbackInputs
): Promise<CallbackResult> {
  if (!inp.code || !inp.state_in_query) {
    writeAuthEvent(db, { event_type: "login_denied_invalid_state", ip: inp.ip, user_agent: inp.user_agent });
    return { kind: "error", status: 400, reason: "missing_params" };
  }
  if (!inp.oauth_tx_cookie) {
    writeAuthEvent(db, { event_type: "login_denied_invalid_state", ip: inp.ip, user_agent: inp.user_agent });
    return { kind: "error", status: 400, reason: "missing_oauth_tx" };
  }
  let tx;
  try {
    tx = decodeOAuthTx(inp.oauth_tx_cookie, inp.env.cookie_secret, { now: inp.now });
  } catch {
    writeAuthEvent(db, { event_type: "login_denied_invalid_state", ip: inp.ip, user_agent: inp.user_agent });
    return { kind: "error", status: 400, reason: "bad_oauth_tx" };
  }
  if (tx.state !== inp.state_in_query) {
    writeAuthEvent(db, { event_type: "login_denied_invalid_state", ip: inp.ip, user_agent: inp.user_agent });
    return { kind: "error", status: 400, reason: "state_mismatch" };
  }

  let tokens;
  try {
    tokens = await exchangeCodeForTokens({
      code: inp.code,
      code_verifier: tx.code_verifier,
      client_id: inp.env.client_id,
      client_secret: inp.env.client_secret,
      redirect_uri: inp.env.redirect_uri,
      fetchImpl: inp.fetchImpl,
    });
  } catch (err) {
    writeAuthEvent(db, {
      event_type: "login_denied_invalid_token",
      ip: inp.ip, user_agent: inp.user_agent,
      details: { stage: "code_exchange", message: (err as Error).message },
    });
    return { kind: "error", status: 400, reason: "code_exchange_failed" };
  }

  let payload: GoogleIdTokenPayload;
  try {
    payload = await verifyIdToken(tokens.id_token, { audience: inp.env.client_id, jwks: inp.jwks });
  } catch (err) {
    writeAuthEvent(db, {
      event_type: "login_denied_invalid_token",
      ip: inp.ip, user_agent: inp.user_agent,
      details: { stage: "verify", message: (err as Error).message },
    });
    return { kind: "error", status: 400, reason: "id_token_invalid" };
  }
  if (payload.nonce !== tx.nonce) {
    writeAuthEvent(db, { event_type: "login_denied_invalid_token", ip: inp.ip, user_agent: inp.user_agent, email: payload.email, details: { stage: "nonce_mismatch" } });
    return { kind: "error", status: 400, reason: "nonce_mismatch" };
  }
  if (!payload.email_verified) {
    writeAuthEvent(db, { event_type: "login_denied_email_unverified", ip: inp.ip, user_agent: inp.user_agent, email: payload.email });
    return { kind: "error", status: 403, reason: "email_unverified" };
  }
  if (inp.env.allowed_hd && payload.hd !== inp.env.allowed_hd) {
    writeAuthEvent(db, { event_type: "login_denied_wrong_hd", ip: inp.ip, user_agent: inp.user_agent, email: payload.email, details: { hd: payload.hd ?? null } });
    return { kind: "error", status: 403, reason: "wrong_hd" };
  }

  const email = payload.email.toLowerCase();
  const row = db.prepare(
    `SELECT id, role, status, google_sub FROM users WHERE email=?`
  ).get(email) as { id: number; role: string; status: string; google_sub: string | null } | undefined;
  if (!row) {
    writeAuthEvent(db, { event_type: "login_denied_not_in_allowlist", ip: inp.ip, user_agent: inp.user_agent, email });
    return { kind: "error", status: 403, reason: "not_in_allowlist" };
  }
  if (row.status === "banned") {
    writeAuthEvent(db, { event_type: "login_denied_banned", ip: inp.ip, user_agent: inp.user_agent, email, user_id: row.id });
    return { kind: "error", status: 403, reason: "banned" };
  }
  if (row.status === "deleted") {
    writeAuthEvent(db, { event_type: "login_denied_account_deleted", ip: inp.ip, user_agent: inp.user_agent, email, user_id: row.id });
    return { kind: "error", status: 403, reason: "deleted" };
  }
  if (row.google_sub && row.google_sub !== payload.sub) {
    writeAuthEvent(db, { event_type: "login_denied_sub_mismatch", ip: inp.ip, user_agent: inp.user_agent, email, user_id: row.id, details: { old_sub: row.google_sub, new_sub: payload.sub } });
    return { kind: "error", status: 403, reason: "sub_mismatch" };
  }

  db.prepare(
    `UPDATE users SET google_sub=?, name=?, picture_url=?, last_login_at=datetime('now') WHERE id=?`
  ).run(payload.sub, payload.name ?? null, payload.picture ?? null, row.id);

  const sid = createSession(db, { user_id: row.id, ip: inp.ip, user_agent: inp.user_agent, now: inp.now });
  writeAuthEvent(db, { event_type: "login_ok", email, user_id: row.id, ip: inp.ip, user_agent: inp.user_agent });
  return { kind: "ok", session_id: sid, user_id: row.id, redirect_to: tx.next };
}
```

- [ ] **Step 2: Write tests for `handleCallback`**

Create `app/api/auth/__tests__/callback.test.ts`:

```ts
import { describe, it, expect, beforeEach } from "vitest";
import { generateKeyPair, SignJWT, exportJWK, type JWK } from "jose";
import Database from "better-sqlite3";
import { initSchema } from "@/lib/history-db";
import { encodeOAuthTx } from "@/lib/auth/oauth-tx";
import { handleCallback } from "@/lib/auth/handle-callback";

const COOKIE_SECRET = "0".repeat(64);
const CLIENT_ID = "cid";
const CLIENT_SECRET = "csec";
const REDIRECT = "http://localhost:3000/api/auth/callback";
const NOW = 1700000000000;

let db: Database.Database;
let publicJwk: JWK;
let signedToken: string;

async function buildToken(claims: Record<string, unknown>) {
  const { publicKey, privateKey } = await generateKeyPair("RS256");
  const pj = await exportJWK(publicKey); pj.alg = "RS256"; pj.use = "sig"; pj.kid = "k1";
  publicJwk = pj;
  return await new SignJWT(claims)
    .setProtectedHeader({ alg: "RS256", kid: "k1" })
    .setIssuer("https://accounts.google.com")
    .setAudience(CLIENT_ID)
    .setExpirationTime("1h").setIssuedAt().sign(privateKey);
}

function makeFetch(idToken: string, status = 200) {
  return async () => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => ({ id_token: idToken, access_token: "at", expires_in: 3600 }),
    text: async () => JSON.stringify({ id_token: idToken }),
  } as any);
}

beforeEach(async () => {
  db = new Database(":memory:");
  initSchema(db);
  signedToken = await buildToken({
    email: "alice@x.com", email_verified: true, sub: "sub1", nonce: "n1", name: "A", picture: "p",
  });
});

const txCookie = (overrides: Partial<{ state: string; nonce: string; cv: string; next: string; ts: number }> = {}) =>
  encodeOAuthTx({
    state: overrides.state ?? "s1",
    nonce: overrides.nonce ?? "n1",
    code_verifier: overrides.cv ?? "cv",
    next: overrides.next ?? "/dashboard",
    ts: overrides.ts ?? NOW,
  }, COOKIE_SECRET);

const baseInputs = (extra: Partial<Parameters<typeof handleCallback>[1]> = {}) => ({
  code: "abc",
  state_in_query: "s1",
  oauth_tx_cookie: txCookie(),
  ip: "1.1.1.1",
  user_agent: "ua",
  env: { client_id: CLIENT_ID, client_secret: CLIENT_SECRET, redirect_uri: REDIRECT, cookie_secret: COOKIE_SECRET },
  jwks: { keys: [publicJwk] },
  fetchImpl: makeFetch(signedToken),
  now: NOW + 1000,
  ...extra,
});

describe("handleCallback", () => {
  it("rejects when email not in allowlist", async () => {
    const r = await handleCallback(db, baseInputs());
    expect(r).toEqual({ kind: "error", status: 403, reason: "not_in_allowlist" });
    const ev = db.prepare(`SELECT event_type FROM auth_events ORDER BY id DESC`).all() as any[];
    expect(ev[0].event_type).toBe("login_denied_not_in_allowlist");
  });

  it("creates a session for an active allowlisted user", async () => {
    db.prepare(`INSERT INTO users (email, status) VALUES ('alice@x.com', 'active')`).run();
    const r = await handleCallback(db, baseInputs());
    expect(r.kind).toBe("ok");
    if (r.kind === "ok") {
      expect(r.redirect_to).toBe("/dashboard");
      const sess = db.prepare(`SELECT * FROM sessions WHERE id=?`).get(r.session_id) as any;
      expect(sess.user_id).toBe(r.user_id);
    }
  });

  it("rejects banned user", async () => {
    db.prepare(`INSERT INTO users (email, status) VALUES ('alice@x.com', 'banned')`).run();
    const r = await handleCallback(db, baseInputs());
    expect(r).toEqual({ kind: "error", status: 403, reason: "banned" });
  });

  it("rejects deleted user", async () => {
    db.prepare(`INSERT INTO users (email, status) VALUES ('alice@x.com', 'deleted')`).run();
    const r = await handleCallback(db, baseInputs());
    expect(r).toEqual({ kind: "error", status: 403, reason: "deleted" });
  });

  it("rejects state mismatch", async () => {
    const r = await handleCallback(db, baseInputs({ state_in_query: "different" }));
    expect(r).toEqual(expect.objectContaining({ kind: "error", reason: "state_mismatch" }));
  });

  it("rejects nonce mismatch (token nonce ≠ tx nonce)", async () => {
    db.prepare(`INSERT INTO users (email) VALUES ('alice@x.com')`).run();
    const tokenWithBadNonce = await buildToken({
      email: "alice@x.com", email_verified: true, sub: "sub1", nonce: "WRONG",
    });
    const r = await handleCallback(db, {
      ...baseInputs(),
      jwks: { keys: [publicJwk] },
      fetchImpl: makeFetch(tokenWithBadNonce),
    });
    expect(r).toEqual(expect.objectContaining({ kind: "error", reason: "nonce_mismatch" }));
  });

  it("rejects email_verified=false", async () => {
    db.prepare(`INSERT INTO users (email) VALUES ('alice@x.com')`).run();
    const tok = await buildToken({ email: "alice@x.com", email_verified: false, sub: "sub1", nonce: "n1" });
    const r = await handleCallback(db, {
      ...baseInputs(), jwks: { keys: [publicJwk] }, fetchImpl: makeFetch(tok),
    });
    expect(r).toEqual(expect.objectContaining({ kind: "error", reason: "email_unverified" }));
  });

  it("rejects wrong hd when ALLOWED_HD set", async () => {
    db.prepare(`INSERT INTO users (email) VALUES ('alice@x.com')`).run();
    const tok = await buildToken({ email: "alice@x.com", email_verified: true, sub: "sub1", nonce: "n1", hd: "other.com" });
    const r = await handleCallback(db, {
      ...baseInputs(),
      env: { client_id: CLIENT_ID, client_secret: CLIENT_SECRET, redirect_uri: REDIRECT, cookie_secret: COOKIE_SECRET, allowed_hd: "tapclap.com" },
      jwks: { keys: [publicJwk] },
      fetchImpl: makeFetch(tok),
    });
    expect(r).toEqual(expect.objectContaining({ kind: "error", reason: "wrong_hd" }));
  });

  it("rejects sub mismatch", async () => {
    db.prepare(`INSERT INTO users (email, google_sub) VALUES ('alice@x.com', 'OLD_SUB')`).run();
    const r = await handleCallback(db, baseInputs());
    expect(r).toEqual(expect.objectContaining({ kind: "error", reason: "sub_mismatch" }));
  });

  it("updates name/picture/sub on first login", async () => {
    db.prepare(`INSERT INTO users (email) VALUES ('alice@x.com')`).run();
    await handleCallback(db, baseInputs());
    const u = db.prepare(`SELECT name, picture_url, google_sub FROM users WHERE email='alice@x.com'`).get() as any;
    expect(u.name).toBe("A");
    expect(u.picture_url).toBe("p");
    expect(u.google_sub).toBe("sub1");
  });
});
```

- [ ] **Step 3: Run tests**

```bash
npx vitest run app/api/auth/__tests__/callback.test.ts
```

Expected: 10 tests passed.

- [ ] **Step 4: Wrap pure handler in route**

Create `app/api/auth/callback/route.ts`:

```ts
import { type NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/history-db";
import { handleCallback } from "@/lib/auth/handle-callback";
import { fetchGoogleJwks } from "@/lib/auth/google";

export const runtime = "nodejs";

const PROD = process.env.NODE_ENV === "production";
const TX_COOKIE = PROD ? "__Host-oauth_tx" : "oauth_tx";
const SESSION_COOKIE = PROD ? "__Host-session" : "session";

export async function GET(req: NextRequest) {
  const cookieSecret = process.env.SESSION_COOKIE_SECRET;
  const client_id = process.env.GOOGLE_CLIENT_ID;
  const client_secret = process.env.GOOGLE_CLIENT_SECRET;
  const redirect_uri = process.env.GOOGLE_REDIRECT_URI;
  if (!cookieSecret || !client_id || !client_secret || !redirect_uri) {
    return NextResponse.json({ error: "OAuth not configured" }, { status: 500 });
  }

  const db = getDb();
  const jwks = await fetchGoogleJwks();

  const result = await handleCallback(db, {
    code: req.nextUrl.searchParams.get("code"),
    state_in_query: req.nextUrl.searchParams.get("state"),
    oauth_tx_cookie: req.cookies.get(TX_COOKIE)?.value ?? null,
    ip: req.headers.get("x-forwarded-for")?.split(",")[0].trim() ?? null,
    user_agent: req.headers.get("user-agent") ?? null,
    env: { client_id, client_secret, redirect_uri, cookie_secret: cookieSecret, allowed_hd: process.env.ALLOWED_HD },
    jwks,
  });

  if (result.kind === "error") {
    const res = NextResponse.json({ error: result.reason }, { status: result.status });
    res.cookies.set({ name: TX_COOKIE, value: "", maxAge: 0, path: "/" });
    return res;
  }

  const res = NextResponse.redirect(new URL(result.redirect_to, req.url), 303);
  res.cookies.set({
    name: SESSION_COOKIE,
    value: result.session_id,
    httpOnly: true,
    sameSite: "lax",
    secure: PROD,
    path: "/",
    maxAge: 30 * 24 * 60 * 60,
  });
  res.cookies.set({ name: TX_COOKIE, value: "", maxAge: 0, path: "/" });
  return res;
}
```

If `getDb()` doesn't exist yet — add a small accessor in `lib/history-db.ts`:

```ts
let _db: Database.Database | null = null;
export function getDb(): Database.Database {
  if (_db) return _db;
  const fs = require("node:fs");
  fs.mkdirSync(getHistoryImagesDir(), { recursive: true });
  _db = new Database(/* path from existing logic */);
  initSchema(_db);
  seedModels(_db);
  bootstrapAdmins(_db, process.env.BOOTSTRAP_ADMIN_EMAILS);
  return _db;
}
```

(Reuse whatever path-resolution logic the file already has — don't duplicate it.)

- [ ] **Step 5: Commit**

```bash
git add lib/auth/handle-callback.ts app/api/auth/callback/route.ts app/api/auth/__tests__/callback.test.ts lib/history-db.ts
git commit -m "feat(auth): /api/auth/callback with full validation chain"
```

---

### Task 5.5: `POST /api/auth/logout` and `GET /api/auth/me`

**Files:**
- Create: `app/api/auth/logout/route.ts`
- Create: `app/api/auth/me/route.ts`

- [ ] **Step 1: Implement logout**

Create `app/api/auth/logout/route.ts`:

```ts
import { type NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/history-db";
import { deleteSession } from "@/lib/auth/session";
import { writeAuthEvent } from "@/lib/auth/audit";
import { getCurrentUser } from "@/lib/auth/current-user";

export const runtime = "nodejs";

const PROD = process.env.NODE_ENV === "production";
const SESSION_COOKIE = PROD ? "__Host-session" : "session";

export async function POST(req: NextRequest) {
  const sid = req.cookies.get(SESSION_COOKIE)?.value;
  if (sid) {
    const db = getDb();
    const user = getCurrentUser(db, sid);
    deleteSession(db, sid);
    if (user) writeAuthEvent(db, { event_type: "logout", user_id: user.id, email: user.email });
  }
  const res = NextResponse.json({ ok: true });
  res.cookies.set({ name: SESSION_COOKIE, value: "", maxAge: 0, path: "/" });
  return res;
}
```

- [ ] **Step 2: Implement me**

Create `app/api/auth/me/route.ts`:

```ts
import { type NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/history-db";
import { getCurrentUser } from "@/lib/auth/current-user";

export const runtime = "nodejs";

const PROD = process.env.NODE_ENV === "production";
const SESSION_COOKIE = PROD ? "__Host-session" : "session";

export async function GET(req: NextRequest) {
  const sid = req.cookies.get(SESSION_COOKIE)?.value;
  const user = getCurrentUser(getDb(), sid);
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  return NextResponse.json(user);
}
```

- [ ] **Step 3: Commit**

```bash
git add app/api/auth/logout/route.ts app/api/auth/me/route.ts
git commit -m "feat(auth): /api/auth/logout and /api/auth/me"
```

---

## Phase 6: Middleware, /login page, UserProvider rewrite

### Task 6.1: Rewrite `middleware.ts`

**Files:**
- Modify: `middleware.ts` (full rewrite)

This file is hard to unit-test (depends on Next.js runtime). Test via the integration smoke at the end of phase.

- [ ] **Step 1: Rewrite**

Replace contents of `middleware.ts`:

```ts
import { NextResponse, type NextRequest } from "next/server";

const PROD = process.env.NODE_ENV === "production";
const SESSION_COOKIE = PROD ? "__Host-session" : "session";

const PUBLIC_PATH_PREFIXES = ["/api/auth/", "/_next/", "/favicon"];
const PUBLIC_EXACT = new Set(["/login"]);

function isPublic(pathname: string): boolean {
  if (PUBLIC_EXACT.has(pathname)) return true;
  return PUBLIC_PATH_PREFIXES.some((p) => pathname.startsWith(p));
}

export function middleware(req: NextRequest) {
  const { pathname, search } = req.nextUrl;
  if (isPublic(pathname)) return NextResponse.next();

  const sid = req.cookies.get(SESSION_COOKIE)?.value;
  if (sid) return NextResponse.next();

  if (pathname.startsWith("/api/")) {
    return new NextResponse(JSON.stringify({ error: "unauthorized" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
  }

  const url = req.nextUrl.clone();
  url.pathname = "/login";
  url.searchParams.set("next", pathname + search);
  return NextResponse.redirect(url, 307);
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
```

- [ ] **Step 2: Manual smoke**

Add the manual test "open `/` with no cookie → redirects to /login?next=/" to the smoke list.

- [ ] **Step 3: Commit**

```bash
git add middleware.ts
git commit -m "feat(middleware): replace admin_auth check with session-presence gate"
```

---

### Task 6.2: `/login` page

**Files:**
- Create: `app/login/page.tsx`

- [ ] **Step 1: Implement**

Create `app/login/page.tsx`:

```tsx
"use client";
import { useSearchParams } from "next/navigation";
import { Suspense } from "react";

function LoginContent() {
  const sp = useSearchParams();
  const next = sp.get("next") ?? "/";
  const href = `/api/auth/google?next=${encodeURIComponent(next)}`;
  return (
    <main className="min-h-screen flex items-center justify-center p-6">
      <div className="w-full max-w-sm rounded-2xl border bg-white dark:bg-zinc-900 p-8 shadow-sm">
        <h1 className="text-2xl font-semibold mb-2">LGen</h1>
        <p className="text-sm text-zinc-600 dark:text-zinc-400 mb-6">
          Доступ выдаётся администратором по приглашению. Если у вас должен быть доступ, но его нет — напишите админу.
        </p>
        <a
          href={href}
          className="flex items-center justify-center gap-3 w-full rounded-lg border bg-white text-zinc-900 hover:bg-zinc-50 px-4 py-3 font-medium transition-colors"
        >
          {/* Inline G icon — keep simple, no external SVG asset */}
          <svg width="18" height="18" viewBox="0 0 18 18">
            <path fill="#4285F4" d="M17.64 9.2c0-.64-.06-1.25-.16-1.84H9v3.48h4.84a4.14 4.14 0 0 1-1.8 2.71v2.26h2.92a8.79 8.79 0 0 0 2.68-6.61z"/>
            <path fill="#34A853" d="M9 18c2.43 0 4.47-.8 5.96-2.18l-2.92-2.26c-.8.54-1.83.85-3.04.85-2.34 0-4.32-1.58-5.03-3.7H.96v2.34A9 9 0 0 0 9 18z"/>
            <path fill="#FBBC05" d="M3.97 10.71a5.41 5.41 0 0 1 0-3.42V4.96H.96a9 9 0 0 0 0 8.08l3.01-2.33z"/>
            <path fill="#EA4335" d="M9 3.58c1.32 0 2.5.45 3.44 1.35l2.58-2.58A8.97 8.97 0 0 0 9 0a9 9 0 0 0-8.04 4.96l3.01 2.33C4.68 5.16 6.66 3.58 9 3.58z"/>
          </svg>
          Войти через Google
        </a>
      </div>
    </main>
  );
}

export default function LoginPage() {
  return (
    <Suspense fallback={null}>
      <LoginContent />
    </Suspense>
  );
}
```

- [ ] **Step 2: Manual smoke**

Open `http://localhost:3000/login` — должна показаться карточка с одной кнопкой.

- [ ] **Step 3: Commit**

```bash
git add app/login/page.tsx
git commit -m "feat(login): /login page with Google sign-in CTA"
```

---

### Task 6.3: Rewrite `app/providers/user-provider.tsx`

**Files:**
- Modify: `app/providers/user-provider.tsx`

- [ ] **Step 1: Replace contents**

Open and replace `app/providers/user-provider.tsx`:

```tsx
"use client";
import * as React from "react";
import { useRouter } from "next/navigation";

export interface CurrentUser {
  id: number;
  email: string;
  name: string | null;
  picture_url: string | null;
  role: "user" | "admin";
}

interface Ctx {
  user: CurrentUser | null;
  loading: boolean;
  refetch: () => Promise<void>;
}

const Context = React.createContext<Ctx | null>(null);

export function UserProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = React.useState<CurrentUser | null>(null);
  const [loading, setLoading] = React.useState(true);
  const router = useRouter();

  const fetchMe = React.useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/auth/me", { cache: "no-store" });
      if (res.status === 401) {
        setUser(null);
        // We're somewhere protected — middleware will redirect on next nav,
        // but pre-empt to avoid a flash of stale UI:
        if (window.location.pathname !== "/login") router.replace("/login");
        return;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setUser(await res.json());
    } catch (err) {
      console.warn("[user-provider] fetchMe failed:", err);
      setUser(null);
    } finally {
      setLoading(false);
    }
  }, [router]);

  React.useEffect(() => {
    void fetchMe();
  }, [fetchMe]);

  return (
    <Context.Provider value={{ user, loading, refetch: fetchMe }}>{children}</Context.Provider>
  );
}

export function useUser(): Ctx {
  const v = React.useContext(Context);
  if (!v) throw new Error("useUser must be used inside UserProvider");
  return v;
}
```

- [ ] **Step 2: Update consumers (compile-only, no behavior change yet)**

Существующие компоненты делают `const { username } = useUser()` (см. `components/playground.tsx:72`, `components/generate-form.tsx`). На этом этапе:

- В каждом таком файле заменить `const { username } = useUser()` на `const { user } = useUser(); const username = user?.email ?? null;`
- Это временный shim: даёт plain string `username` который уже использует существующий код. Полная миграция этих компонентов на `user.id` — Phase 10.

Affected files (ищи через `grep -rn "useUser()" app components`):
- `components/playground.tsx`
- `components/generate-form.tsx`
- ещё файлы из grep

Для каждого — добавить `const username = user?.email ?? null;` сразу после `useUser()`.

- [ ] **Step 3: Run typecheck**

```bash
npx tsc --noEmit
```

Expected: green (или те же ошибки что были до этого таска — диагностируй каждое расхождение).

- [ ] **Step 4: Commit**

```bash
git add app/providers/user-provider.tsx components/playground.tsx components/generate-form.tsx
# add other touched files
git commit -m "refactor(user-provider): fetch /api/auth/me, expose CurrentUser; shim username=email"
```

---

## Phase 7: API integration (history, image, stream, preferences)

### Task 7.1: SSE broadcast — rename `broadcastToUser` to `broadcastToUserId`

**Files:**
- Modify: `lib/sse-broadcast.ts`
- Modify: every consumer (search `broadcastToUser`)

- [ ] **Step 1: Find consumers**

```bash
grep -rn "broadcastToUser" lib app
```

Expected ~3-5 matches.

- [ ] **Step 2: Update signature in `lib/sse-broadcast.ts`**

Open the file, change the in-memory map key from `username: string` to `user_id: number`, rename function to `broadcastToUserId(user_id, payload)`. The implementation otherwise stays the same.

Add an event-type union:

```ts
export type SseEvent =
  | { type: "generation.created"; data: any }
  | { type: "generation.deleted"; data: { id: number } }
  | { type: "quota_updated" }
  | { type: "user_banned" }
  | { type: "user_role_changed" };

export function broadcastToUserId(user_id: number, ev: SseEvent): void { /* ... */ }
```

- [ ] **Step 3: Update consumers**

In each consumer, replace `broadcastToUser(username, ...)` with `broadcastToUserId(user.id, ...)`. The `user_id` comes from the same flow that already authenticates the request — at this stage of the plan most handlers still don't have `getCurrentUser` wired, so leave a `TODO(plan-7.x)` comment where the value is needed but not yet available. Phase 7.2-7.3 wire it up.

- [ ] **Step 4: Update existing SSE tests**

Update tests in `lib/history/__tests__/sse.test.ts` to call `broadcastToUserId` with a numeric id.

- [ ] **Step 5: Run tests**

```bash
npx vitest run lib/history/__tests__/sse.test.ts
```

Expected: green.

- [ ] **Step 6: Commit**

```bash
git add lib/sse-broadcast.ts lib/history app
git commit -m "refactor(sse): broadcastToUserId(numeric) + typed events"
```

---

### Task 7.2: `/api/history` GET/DELETE — auth-gate from session

**Files:**
- Modify: `app/api/history/route.ts` (GET and DELETE handlers; POST is in 7.3)

- [ ] **Step 1: Replace GET handler**

In `app/api/history/route.ts`:

```ts
export async function GET(request: NextRequest) {
  const user = getCurrentUser(getDb(), readSessionCookie(request));
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const sp = request.nextUrl.searchParams;
  try {
    const generations = getGenerations({
      user_id: user.id,
      startDate: sp.get("startDate") || undefined,
      endDate: sp.get("endDate") || undefined,
      limit: sp.get("limit") ? parseInt(sp.get("limit")!) : 100,
      offset: sp.get("offset") ? parseInt(sp.get("offset")!) : 0,
    });
    return NextResponse.json(generations);
  } catch (err) {
    console.error("[history GET] failed:", err);
    return NextResponse.json({ error: "Failed to fetch history" }, { status: 500 });
  }
}
```

`getGenerations` and friends in `lib/history-db.ts` previously took `username: string`. Update their signatures to take `user_id: number` and update SQL accordingly (`WHERE user_id=?` instead of `WHERE username=?`).

`readSessionCookie` is a tiny helper:

```ts
const SESSION_COOKIE = process.env.NODE_ENV === "production" ? "__Host-session" : "session";
function readSessionCookie(req: NextRequest): string | null {
  return req.cookies.get(SESSION_COOKIE)?.value ?? null;
}
```

(Lift to `lib/auth/cookie-name.ts` if used in 3+ places.)

- [ ] **Step 2: Replace DELETE handler**

```ts
export async function DELETE(request: NextRequest) {
  const user = getCurrentUser(getDb(), readSessionCookie(request));
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const id = request.nextUrl.searchParams.get("id");
  if (!id) return NextResponse.json({ error: "id is required" }, { status: 400 });

  try {
    const { deleted } = deleteGeneration(parseInt(id), user.id);  // updated to take user_id
    if (deleted) {
      try {
        broadcastToUserId(user.id, { type: "generation.deleted", data: { id: parseInt(id) } });
      } catch (err) {
        console.error("[history DELETE] broadcast failed:", err);
      }
    }
    return NextResponse.json({ success: deleted });
  } catch (err) {
    console.error("[history DELETE] failed:", err);
    return NextResponse.json({ error: "Failed to delete history" }, { status: 500 });
  }
}
```

- [ ] **Step 3: Update `getGenerations` and `deleteGeneration` in `lib/history-db.ts`**

Change parameter from `username` to `user_id`, change SQL accordingly. Also for `getGenerations` join `users` if you need the email for the response — but check what fields the existing UI consumes; if not needed, skip the join.

- [ ] **Step 4: Update existing tests**

In `lib/history/__tests__/*.test.ts`, anywhere `username` was passed in mocks/params — switch to `user_id`. Some tests will need a setup step that inserts a user into a fresh in-memory DB.

- [ ] **Step 5: Run tests + manual smoke**

```bash
npm test
```

Manual: log in, verify history sidebar still loads and DELETE works.

- [ ] **Step 6: Commit**

```bash
git add app/api/history/route.ts lib/history-db.ts lib/history/
git commit -m "refactor(history): GET/DELETE use session user_id, drop ?username= param"
```

---

### Task 7.3: `/api/history` POST — write file under `<email>/YYYY/MM/`, write user_id + model_id + provider

**Files:**
- Modify: `app/api/history/route.ts` (POST handler)

- [ ] **Step 1: Update POST handler — replace path computation and DB write**

Key changes:
- Auth via session (no more body `username`)
- Compute `relPath = `${user.email}/${YYYY}/${MM}/`` using **UTC** date (same `currentMonthBoundsUTC` logic; we want UTC year/month)
- `mkdir(absDir, { recursive: true })` before writes
- `originalFilename` etc. live in subdir; full path `path.join(dir, relPath, originalFilename)`
- `filepath` written to DB is **relative**: `relPath + originalFilename`
- Write `model_id` and `provider` to `generations` columns — extract from `promptData`
- Use `broadcastToUserId(user.id, ...)`

Sketch of changes (apply over current `app/api/history/route.ts:63-201`):

```ts
const user = getCurrentUser(getDb(), readSessionCookie(request));
if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

// ... existing form parsing, but drop `formData.get("username")` ...

const promptData = JSON.parse((formData.get("promptData") as string) || "{}");
const modelId = typeof promptData.modelId === "string" ? promptData.modelId : null;
const provider = typeof promptData.provider === "string" ? promptData.provider : null;

const now = new Date();
const yyyy = String(now.getUTCFullYear());
const mm = String(now.getUTCMonth() + 1).padStart(2, "0");
const relDir = `${user.email}/${yyyy}/${mm}`;
const absDir = path.join(getHistoryImagesDir(), relDir);
await fs.mkdir(absDir, { recursive: true });

const originalPath = path.join(absDir, originalFilename);
// ... same uuid-collision check ...
// ... same Promise.all writeAndTrack ...

const id = saveGeneration({
  user_id: user.id,
  model_id: modelId,
  provider,
  workflowName,
  promptData,
  executionTimeSeconds,
  outputs: [
    {
      filename: displayFilename,
      filepath: `${relDir}/${originalFilename}`,
      contentType: original.type,
      size: original.size,
    },
  ],
});

// thumb/mid follow the same pattern — they also need `${relDir}/...` filepaths if you store them as outputs.
// Existing code stored them implicitly via filename convention; since /api/history/image/[...path] is
// now relative-path-aware, we don't need to store thumb/mid as separate outputs. URLs are constructed:
const fullUrl  = `/api/history/image/${encodeURIComponent(relDir)}/${encodeURIComponent(originalFilename)}`;
const thumbUrl = `/api/history/image/${encodeURIComponent(relDir)}/${encodeURIComponent(thumbFilename)}`;
const midUrl   = `/api/history/image/${encodeURIComponent(relDir)}/${encodeURIComponent(midFilename)}`;
```

`saveGeneration` in `lib/history-db.ts` — update signature to `{ user_id, model_id, provider, ... }`, drop `username`. Update SQL `INSERT` accordingly.

- [ ] **Step 2: Update existing tests in `lib/history/__tests__/`**

If they exist for save/upload — update to new signature. Use `<userId>/YYYY/MM/...` in path assertions.

- [ ] **Step 3: Manual smoke**

After implementing 7.4 (image catch-all), do a full generation → upload → verify file lands in `data/history_images/<email>/YYYY/MM/`.

- [ ] **Step 4: Commit**

```bash
git add app/api/history/route.ts lib/history-db.ts lib/history
git commit -m "feat(history): POST writes under <email>/YYYY/MM, persists model_id+provider"
```

---

### Task 7.4: `/api/history/image/[filename]/route.ts` → `[...path]/route.ts`

**Files:**
- Delete: `app/api/history/image/[filename]/route.ts`
- Create: `app/api/history/image/[...path]/route.ts`

- [ ] **Step 1: Implement catch-all**

Create `app/api/history/image/[...path]/route.ts`:

```ts
import { type NextRequest, NextResponse } from "next/server";
import { getDb, getHistoryImagesDir } from "@/lib/history-db";
import { getCurrentUser } from "@/lib/auth/current-user";
import path from "node:path";
import fs from "node:fs/promises";
import mime from "mime-types";

export const runtime = "nodejs";
const SESSION_COOKIE = process.env.NODE_ENV === "production" ? "__Host-session" : "session";

/**
 * GET /api/history/image/<email>/<YYYY>/<MM>/<filename>
 *
 * Auth: only the file's owner (path's first segment === user.email) or admin
 * can read. Path-traversal defended in depth via `..` rejection AND
 * `path.resolve(joined).startsWith(baseDir)`.
 */
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ path: string[] }> }
) {
  const user = getCurrentUser(getDb(), req.cookies.get(SESSION_COOKIE)?.value ?? null);
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const { path: segs } = await params;
  if (!segs || segs.length < 2) {
    return NextResponse.json({ error: "Invalid path" }, { status: 400 });
  }
  for (const s of segs) {
    if (!s || s.includes("..") || s.includes("/") || s.includes("\\")) {
      return NextResponse.json({ error: "Invalid path" }, { status: 400 });
    }
  }

  const ownerEmail = segs[0].toLowerCase();
  if (user.role !== "admin" && ownerEmail !== user.email.toLowerCase()) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const dir = getHistoryImagesDir();
  const filePath = path.join(dir, ...segs);
  const resolved = path.resolve(filePath);
  if (!resolved.startsWith(path.resolve(dir))) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  try {
    const bytes = await fs.readFile(resolved);
    const filename = segs[segs.length - 1];
    const contentType = mime.lookup(filename) || "application/octet-stream";
    return new NextResponse(new Uint8Array(bytes), {
      status: 200,
      headers: {
        "Content-Type": contentType,
        "Cache-Control": "public, max-age=31536000, immutable",
      },
    });
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return NextResponse.json({ error: "Not found" }, { status: 404 });
    console.error("[history image] read failed:", err);
    return NextResponse.json({ error: "Read failed" }, { status: 500 });
  }
}
```

- [ ] **Step 2: Delete old route**

```bash
rm app/api/history/image/\[filename\]/route.ts
```

(On Windows `rm` works in the bash shell for this repo. If it errors, use the Bash tool.)

- [ ] **Step 3: Manual smoke**

After full deploy, hit `/api/history/image/alice@x.com/2026/04/<uuid>.png` while logged in as alice → 200 with image bytes. As another user → 403. Anonymous → 401.

- [ ] **Step 4: Commit**

```bash
git add app/api/history/image
git commit -m "feat(history-image): catch-all route with per-owner auth"
```

---

### Task 7.5: `/api/history/stream` — auth + broadcast by user_id

**Files:**
- Modify: `app/api/history/stream/route.ts`

- [ ] **Step 1: Update**

The existing route reads `?username=` and registers the connection in the in-memory map. Replace:

```ts
import { getCurrentUser } from "@/lib/auth/current-user";
import { getDb } from "@/lib/history-db";
const SESSION_COOKIE = process.env.NODE_ENV === "production" ? "__Host-session" : "session";

export async function GET(req: NextRequest) {
  const user = getCurrentUser(getDb(), req.cookies.get(SESSION_COOKIE)?.value ?? null);
  if (!user) return new Response(null, { status: 401 });
  // ... register connection by user.id, not by username
}
```

Update the in-memory map key (likely in `lib/sse-broadcast.ts`) to `Map<number, Set<...>>`.

- [ ] **Step 2: Manual smoke**

Open the app, observe Network panel → SSE stream connects with 200 and stays open. Trigger a generation in another tab → first tab receives `generation.created` event.

- [ ] **Step 3: Commit**

```bash
git add app/api/history/stream/route.ts lib/sse-broadcast.ts
git commit -m "feat(history-stream): authenticate by session, key by user_id"
```

---

### Task 7.6: `/api/user/preferences` — auth from session

**Files:**
- Modify: `app/api/user/preferences/route.ts`

- [ ] **Step 1: Replace handlers**

GET: drop `?username=`, take user from session. PUT: drop body `username`. Use `user_id` PK.

```ts
const user = getCurrentUser(getDb(), readSessionCookie(req));
if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
// SQL: SELECT selected_model FROM user_preferences WHERE user_id = ?
// SQL: INSERT/REPLACE WHERE user_id = ?
```

Adjust `lib/history-db.ts` helpers `getUserPreferences(user_id)` / `setUserPreferences(user_id, model)`.

- [ ] **Step 2: Update consumers**

`stores/settings-store.ts`'s `hydrateUserModel(username)` and `setSelectedModel(model, username)` — these now don't need `username` at all (the API knows from session). Drop the parameter, simplify.

- [ ] **Step 3: Run tests + smoke**

```bash
npm test
```

- [ ] **Step 4: Commit**

```bash
git add app/api/user/preferences app/providers stores components
git commit -m "refactor(user-prefs): authenticate via session, drop username param"
```

---

## Phase 8: Quota enforcement + `/api/me/quotas`

### Task 8.1: Quota gate in `/api/generate/submit`

**Files:**
- Modify: `app/api/generate/submit/route.ts`

- [ ] **Step 1: Add gate before `provider.submit`**

After the existing provider/model resolution, before `provider.submit(body)`:

```ts
import { getCurrentUser } from "@/lib/auth/current-user";
import { getDb } from "@/lib/history-db";
import { applicableLimit, usageThisMonth } from "@/lib/quotas";
import { writeAuthEvent } from "@/lib/auth/audit";

const user = getCurrentUser(getDb(), readSessionCookie(req));
if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

if (user.role !== "admin") {
  const limit = applicableLimit(getDb(), user.id, body.modelId);
  if (limit !== null) {
    const used = usageThisMonth(getDb(), user.id, body.modelId);
    if (used >= limit) {
      writeAuthEvent(getDb(), {
        event_type: "quota_exceeded",
        user_id: user.id,
        email: user.email,
        details: { model_id: body.modelId, used, limit },
      });
      return NextResponse.json(
        { error: "quota_exceeded", model_id: body.modelId, limit, used },
        { status: 429 }
      );
    }
  }
}

// ...continue with provider.submit
```

- [ ] **Step 2: Test (integration)**

Create `app/api/generate/__tests__/submit-quota.test.ts`:

```ts
import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { initSchema, seedModels } from "@/lib/history-db";
import { applicableLimit, usageThisMonth } from "@/lib/quotas";

let db: Database.Database;
let userId: number;

beforeEach(() => {
  db = new Database(":memory:");
  initSchema(db);
  seedModels(db);
  userId = db.prepare(`INSERT INTO users (email) VALUES ('a@x.com')`).run().lastInsertRowid as number;
});

it("blocks when usage equals limit", () => {
  db.prepare(`UPDATE models SET default_monthly_limit=2 WHERE model_id='nano-banana-pro'`).run();
  const ins = db.prepare(`INSERT INTO generations (user_id, model_id, status, created_at) VALUES (?, 'nano-banana-pro', 'completed', datetime('now'))`);
  ins.run(userId);
  ins.run(userId);
  expect(usageThisMonth(db, userId, "nano-banana-pro")).toBe(2);
  expect(applicableLimit(db, userId, "nano-banana-pro")).toBe(2);
  // Caller's `used >= limit` → block. Documented in submit/route.ts.
});

it("allows when override is unlimited (NULL) even with low default", () => {
  db.prepare(`UPDATE models SET default_monthly_limit=1 WHERE model_id='nano-banana-pro'`).run();
  db.prepare(`INSERT INTO user_quotas (user_id, model_id, monthly_limit) VALUES (?, ?, NULL)`).run(userId, "nano-banana-pro");
  expect(applicableLimit(db, userId, "nano-banana-pro")).toBeNull();
});
```

- [ ] **Step 3: Run + smoke**

```bash
npx vitest run app/api/generate/__tests__/submit-quota.test.ts
```

Manual: with default_monthly_limit=2, generate 3 times → 3rd attempt 429 with `{error:"quota_exceeded"}`.

- [ ] **Step 4: Commit**

```bash
git add app/api/generate/submit/route.ts app/api/generate/__tests__
git commit -m "feat(submit): pre-provider quota gate (admin-exempt)"
```

---

### Task 8.2: `GET /api/me/quotas`

**Files:**
- Create: `app/api/me/quotas/route.ts`

- [ ] **Step 1: Implement**

```ts
import { type NextRequest, NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth/current-user";
import { getDb } from "@/lib/history-db";
import { applicableLimit, usageThisMonth } from "@/lib/quotas";

export const runtime = "nodejs";
const SESSION_COOKIE = process.env.NODE_ENV === "production" ? "__Host-session" : "session";

export async function GET(req: NextRequest) {
  const db = getDb();
  const user = getCurrentUser(db, req.cookies.get(SESSION_COOKIE)?.value ?? null);
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const models = db.prepare(
    `SELECT model_id, display_name FROM models WHERE is_active=1 ORDER BY model_id`
  ).all() as { model_id: string; display_name: string }[];

  const result = models.map((m) => {
    const limit = applicableLimit(db, user.id, m.model_id);
    const used = usageThisMonth(db, user.id, m.model_id);
    return {
      model_id: m.model_id,
      display_name: m.display_name,
      limit,
      used,
      unlimited: limit === null,
    };
  });

  return NextResponse.json(result);
}
```

- [ ] **Step 2: Manual smoke**

Open browser DevTools → `fetch("/api/me/quotas").then(r=>r.json()).then(console.log)`. Expect array of 5 (seeded models) with `used:0, unlimited:true` initially.

- [ ] **Step 3: Commit**

```bash
git add app/api/me/quotas/route.ts
git commit -m "feat(quotas): GET /api/me/quotas — per-user current state"
```

---

## Phase 9: Admin endpoints + Admin UI

### Task 9.1: `/api/admin/users` (list, create) and `/api/admin/users/[id]` (PATCH)

**Files:**
- Create: `app/api/admin/users/route.ts`
- Create: `app/api/admin/users/[id]/route.ts`

- [ ] **Step 1: Implement list/create**

`app/api/admin/users/route.ts`:

```ts
import { type NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/history-db";
import { getCurrentUser } from "@/lib/auth/current-user";
import { writeAuthEvent } from "@/lib/auth/audit";

export const runtime = "nodejs";
const SESSION_COOKIE = process.env.NODE_ENV === "production" ? "__Host-session" : "session";

function requireAdmin(req: NextRequest) {
  const user = getCurrentUser(getDb(), req.cookies.get(SESSION_COOKIE)?.value ?? null);
  if (!user) return { error: NextResponse.json({ error: "unauthorized" }, { status: 401 }) };
  if (user.role !== "admin") return { error: NextResponse.json({ error: "forbidden" }, { status: 403 }) };
  return { user };
}

export async function GET(req: NextRequest) {
  const a = requireAdmin(req); if (a.error) return a.error;
  const showDeleted = req.nextUrl.searchParams.get("showDeleted") === "1";
  const sql = `
    SELECT u.id, u.email, u.name, u.role, u.status, u.last_login_at, u.created_at,
      (SELECT COUNT(*) FROM generations g
        WHERE g.user_id = u.id
          AND g.status='completed'
          AND g.created_at >= strftime('%Y-%m-01T00:00:00.000Z', 'now')
      ) AS gens_this_month
    FROM users u
    ${showDeleted ? "" : "WHERE u.status != 'deleted'"}
    ORDER BY u.created_at DESC
  `;
  return NextResponse.json(getDb().prepare(sql).all());
}

export async function POST(req: NextRequest) {
  const a = requireAdmin(req); if (a.error) return a.error;
  const body = await req.json() as { email: string; role?: "user"|"admin" };
  const email = body.email?.trim().toLowerCase();
  if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    return NextResponse.json({ error: "invalid_email" }, { status: 400 });
  }
  try {
    getDb().prepare(
      `INSERT INTO users (email, role, status) VALUES (?, ?, 'active')`
    ).run(email, body.role ?? "user");
    writeAuthEvent(getDb(), { event_type: "admin_user_created", user_id: a.user.id, details: { target_email: email } });
    return NextResponse.json({ ok: true });
  } catch (err: any) {
    if (String(err.message).includes("UNIQUE")) {
      return NextResponse.json({ error: "exists" }, { status: 409 });
    }
    throw err;
  }
}
```

- [ ] **Step 2: Implement PATCH**

`app/api/admin/users/[id]/route.ts`:

```ts
import { type NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/history-db";
import { getCurrentUser } from "@/lib/auth/current-user";
import { writeAuthEvent } from "@/lib/auth/audit";
import { deleteSessionsForUser } from "@/lib/auth/session";
import { broadcastToUserId } from "@/lib/sse-broadcast";

export const runtime = "nodejs";
const SESSION_COOKIE = process.env.NODE_ENV === "production" ? "__Host-session" : "session";

export async function PATCH(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const me = getCurrentUser(getDb(), req.cookies.get(SESSION_COOKIE)?.value ?? null);
  if (!me) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (me.role !== "admin") return NextResponse.json({ error: "forbidden" }, { status: 403 });

  const { id } = await ctx.params;
  const userId = parseInt(id);
  const body = await req.json() as { role?: "user"|"admin"; status?: "active"|"banned"|"deleted" };

  const before = getDb().prepare(`SELECT role, status FROM users WHERE id=?`).get(userId) as any;
  if (!before) return NextResponse.json({ error: "not_found" }, { status: 404 });

  const sets: string[] = [];
  const args: any[] = [];
  if (body.role && body.role !== before.role)     { sets.push("role=?");   args.push(body.role); }
  if (body.status && body.status !== before.status) { sets.push("status=?"); args.push(body.status); }
  if (sets.length === 0) return NextResponse.json({ ok: true, changed: false });

  args.push(userId);
  getDb().prepare(`UPDATE users SET ${sets.join(", ")} WHERE id=?`).run(...args);

  if (body.role && body.role !== before.role) {
    writeAuthEvent(getDb(), { event_type: "admin_user_role_changed", user_id: me.id,
      details: { target_id: userId, from: before.role, to: body.role } });
    broadcastToUserId(userId, { type: "user_role_changed" });
  }
  if (body.status && body.status !== before.status) {
    writeAuthEvent(getDb(), { event_type: "admin_user_status_changed", user_id: me.id,
      details: { target_id: userId, from: before.status, to: body.status } });
    if (body.status !== "active") {
      deleteSessionsForUser(getDb(), userId);
      broadcastToUserId(userId, { type: "user_banned" });
    }
  }
  return NextResponse.json({ ok: true, changed: true });
}
```

- [ ] **Step 3: Manual smoke + commit**

```bash
git add app/api/admin/users
git commit -m "feat(admin): /api/admin/users CRUD + role/status PATCH with SSE"
```

---

### Task 9.2: `/api/admin/models/[model_id]` PATCH and quotas endpoints

**Files:**
- Create: `app/api/admin/models/route.ts`
- Create: `app/api/admin/models/[model_id]/route.ts`
- Create: `app/api/admin/users/[id]/quotas/route.ts`
- Create: `app/api/admin/users/[id]/quotas/[model]/route.ts`

- [ ] **Step 1: Implement `app/api/admin/models/route.ts`**

```ts
import { type NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/history-db";
import { getCurrentUser } from "@/lib/auth/current-user";

export const runtime = "nodejs";
const SESSION_COOKIE = process.env.NODE_ENV === "production" ? "__Host-session" : "session";

export async function GET(req: NextRequest) {
  const user = getCurrentUser(getDb(), req.cookies.get(SESSION_COOKIE)?.value ?? null);
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (user.role !== "admin") return NextResponse.json({ error: "forbidden" }, { status: 403 });

  const rows = getDb().prepare(`
    SELECT m.model_id, m.display_name, m.default_monthly_limit, m.is_active,
      (SELECT COUNT(*) FROM generations g
        WHERE g.model_id = m.model_id AND g.status='completed') AS total_generations
    FROM models m ORDER BY m.model_id
  `).all();
  return NextResponse.json(rows);
}
```

- [ ] **Step 2: Implement `app/api/admin/models/[model_id]/route.ts`**

```ts
import { type NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/history-db";
import { getCurrentUser } from "@/lib/auth/current-user";
import { writeAuthEvent } from "@/lib/auth/audit";
import { broadcastToUserId } from "@/lib/sse-broadcast";

export const runtime = "nodejs";
const SESSION_COOKIE = process.env.NODE_ENV === "production" ? "__Host-session" : "session";

export async function PATCH(req: NextRequest, ctx: { params: Promise<{ model_id: string }> }) {
  const me = getCurrentUser(getDb(), req.cookies.get(SESSION_COOKIE)?.value ?? null);
  if (!me) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (me.role !== "admin") return NextResponse.json({ error: "forbidden" }, { status: 403 });

  const { model_id } = await ctx.params;
  const body = await req.json() as { default_monthly_limit?: number | null; is_active?: 0 | 1 };

  const before = getDb().prepare(
    `SELECT default_monthly_limit, is_active FROM models WHERE model_id=?`
  ).get(model_id) as { default_monthly_limit: number | null; is_active: number } | undefined;
  if (!before) return NextResponse.json({ error: "not_found" }, { status: 404 });

  const sets: string[] = [];
  const args: unknown[] = [];
  let defaultChanged = false;
  if ("default_monthly_limit" in body && body.default_monthly_limit !== before.default_monthly_limit) {
    sets.push("default_monthly_limit=?");
    args.push(body.default_monthly_limit ?? null);
    defaultChanged = true;
  }
  if ("is_active" in body && body.is_active !== before.is_active) {
    sets.push("is_active=?");
    args.push(body.is_active ? 1 : 0);
  }
  if (sets.length === 0) return NextResponse.json({ ok: true, changed: false });

  sets.push("updated_at=datetime('now')");
  args.push(model_id);
  getDb().prepare(`UPDATE models SET ${sets.join(", ")} WHERE model_id=?`).run(...args);

  if (defaultChanged) {
    writeAuthEvent(getDb(), {
      event_type: "admin_model_default_changed", user_id: me.id,
      details: { model_id, from: before.default_monthly_limit, to: body.default_monthly_limit ?? null },
    });
    // Broadcast to active users without an override on this model
    const affected = getDb().prepare(`
      SELECT u.id FROM users u
      WHERE u.status='active'
        AND u.id NOT IN (SELECT user_id FROM user_quotas WHERE model_id=?)
    `).all(model_id) as { id: number }[];
    for (const { id } of affected) broadcastToUserId(id, { type: "quota_updated" });
  }
  return NextResponse.json({ ok: true, changed: true });
}
```

- [ ] **Step 3: Implement `app/api/admin/users/[id]/quotas/route.ts`**

```ts
import { type NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/history-db";
import { getCurrentUser } from "@/lib/auth/current-user";
import { applicableLimit, usageThisMonth } from "@/lib/quotas";

export const runtime = "nodejs";
const SESSION_COOKIE = process.env.NODE_ENV === "production" ? "__Host-session" : "session";

export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const me = getCurrentUser(getDb(), req.cookies.get(SESSION_COOKIE)?.value ?? null);
  if (!me) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (me.role !== "admin") return NextResponse.json({ error: "forbidden" }, { status: 403 });

  const userId = parseInt((await ctx.params).id);
  const exists = getDb().prepare(`SELECT id FROM users WHERE id=?`).get(userId);
  if (!exists) return NextResponse.json({ error: "not_found" }, { status: 404 });

  const models = getDb().prepare(
    `SELECT model_id, display_name, default_monthly_limit FROM models ORDER BY model_id`
  ).all() as { model_id: string; display_name: string; default_monthly_limit: number | null }[];

  const overrides = new Map(
    (getDb().prepare(`SELECT model_id, monthly_limit FROM user_quotas WHERE user_id=?`).all(userId) as any[])
      .map((r) => [r.model_id, r.monthly_limit])
  );

  const result = models.map((m) => {
    const hasOverride = overrides.has(m.model_id);
    const overrideValue = hasOverride ? (overrides.get(m.model_id) ?? null) : null;
    return {
      model_id: m.model_id,
      display_name: m.display_name,
      applicable_limit: applicableLimit(getDb(), userId, m.model_id),
      source: hasOverride ? "override" : "default",
      default_limit: m.default_monthly_limit,
      override_limit: hasOverride ? overrideValue : null,
      has_override: hasOverride,
      usage_this_month: usageThisMonth(getDb(), userId, m.model_id),
    };
  });
  return NextResponse.json(result);
}
```

- [ ] **Step 4: Implement `app/api/admin/users/[id]/quotas/[model]/route.ts`**

```ts
import { type NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/history-db";
import { getCurrentUser } from "@/lib/auth/current-user";
import { writeAuthEvent } from "@/lib/auth/audit";
import { broadcastToUserId } from "@/lib/sse-broadcast";

export const runtime = "nodejs";
const SESSION_COOKIE = process.env.NODE_ENV === "production" ? "__Host-session" : "session";

export async function PUT(req: NextRequest, ctx: { params: Promise<{ id: string; model: string }> }) {
  const me = getCurrentUser(getDb(), req.cookies.get(SESSION_COOKIE)?.value ?? null);
  if (!me) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (me.role !== "admin") return NextResponse.json({ error: "forbidden" }, { status: 403 });

  const { id, model } = await ctx.params;
  const userId = parseInt(id);
  const body = await req.json() as { monthly_limit: number | null };

  if (!getDb().prepare(`SELECT id FROM users WHERE id=?`).get(userId))
    return NextResponse.json({ error: "user_not_found" }, { status: 404 });
  if (!getDb().prepare(`SELECT model_id FROM models WHERE model_id=?`).get(model))
    return NextResponse.json({ error: "model_not_found" }, { status: 404 });

  getDb().prepare(`
    INSERT INTO user_quotas (user_id, model_id, monthly_limit, updated_at)
    VALUES (?, ?, ?, datetime('now'))
    ON CONFLICT (user_id, model_id) DO UPDATE
      SET monthly_limit = excluded.monthly_limit,
          updated_at = excluded.updated_at
  `).run(userId, model, body.monthly_limit);

  writeAuthEvent(getDb(), {
    event_type: "admin_quota_changed", user_id: me.id,
    details: { target_user_id: userId, model_id: model, monthly_limit: body.monthly_limit },
  });
  broadcastToUserId(userId, { type: "quota_updated" });
  return NextResponse.json({ ok: true });
}

export async function DELETE(req: NextRequest, ctx: { params: Promise<{ id: string; model: string }> }) {
  const me = getCurrentUser(getDb(), req.cookies.get(SESSION_COOKIE)?.value ?? null);
  if (!me) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (me.role !== "admin") return NextResponse.json({ error: "forbidden" }, { status: 403 });

  const { id, model } = await ctx.params;
  const userId = parseInt(id);
  const result = getDb().prepare(
    `DELETE FROM user_quotas WHERE user_id=? AND model_id=?`
  ).run(userId, model);

  if (result.changes > 0) {
    writeAuthEvent(getDb(), {
      event_type: "admin_quota_changed", user_id: me.id,
      details: { target_user_id: userId, model_id: model, action: "removed_override" },
    });
    broadcastToUserId(userId, { type: "quota_updated" });
  }
  return NextResponse.json({ ok: true, removed: result.changes > 0 });
}
```

- [ ] **Step 5: Manual smoke**

Authenticated as admin, exercise each endpoint via DevTools fetch:
- `fetch('/api/admin/models').then(r=>r.json())` → 5 models
- `fetch('/api/admin/models/nano-banana-pro', {method:'PATCH', headers:{'Content-Type':'application/json'}, body: JSON.stringify({default_monthly_limit: 100})})` → `{ok:true, changed:true}`
- `fetch('/api/admin/users/<id>/quotas')` → array
- `fetch('/api/admin/users/<id>/quotas/nano-banana-pro', {method:'PUT', body: JSON.stringify({monthly_limit: null})})` → `{ok:true}`

- [ ] **Step 6: Commit**

```bash
git add app/api/admin
git commit -m "feat(admin): models PATCH + per-user quota override endpoints"
```

---

### Task 9.3: Admin UI — Users tab

**Files:**
- Create: `components/admin/users-tab.tsx`
- Modify: `app/admin/page.tsx` (host the new tab)

- [ ] **Step 1: Implement `components/admin/users-tab.tsx`**

```tsx
"use client";
import * as React from "react";
import { toast } from "sonner";

interface AdminUser {
  id: number;
  email: string;
  name: string | null;
  role: "user" | "admin";
  status: "active" | "banned" | "deleted";
  last_login_at: string | null;
  created_at: string;
  gens_this_month: number;
}

interface QuotaRow {
  model_id: string;
  display_name: string;
  applicable_limit: number | null;
  source: "default" | "override";
  default_limit: number | null;
  override_limit: number | null;
  has_override: boolean;
  usage_this_month: number;
}

export function UsersTab() {
  const [users, setUsers] = React.useState<AdminUser[]>([]);
  const [showDeleted, setShowDeleted] = React.useState(false);
  const [newEmail, setNewEmail] = React.useState("");
  const [expandedId, setExpandedId] = React.useState<number | null>(null);

  const refetch = React.useCallback(async () => {
    const r = await fetch(`/api/admin/users${showDeleted ? "?showDeleted=1" : ""}`, { cache: "no-store" });
    if (r.ok) setUsers(await r.json());
  }, [showDeleted]);

  React.useEffect(() => { void refetch(); }, [refetch]);

  async function addUser() {
    const email = newEmail.trim().toLowerCase();
    if (!email) return;
    const r = await fetch("/api/admin/users", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email }),
    });
    if (r.ok) { setNewEmail(""); toast.success("Добавлен"); void refetch(); }
    else if (r.status === 409) toast.error("Уже существует");
    else toast.error("Ошибка");
  }

  async function patch(id: number, body: Partial<{ role: AdminUser["role"]; status: AdminUser["status"] }>) {
    const r = await fetch(`/api/admin/users/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (r.ok) { toast.success("Обновлено"); void refetch(); }
    else toast.error("Ошибка");
  }

  return (
    <div className="space-y-4">
      <div className="flex gap-2 items-center">
        <input
          type="email" value={newEmail} onChange={(e) => setNewEmail(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && addUser()}
          placeholder="alice@tapclap.com"
          className="border rounded px-3 py-1.5 flex-1 max-w-sm"
        />
        <button onClick={addUser} className="px-3 py-1.5 rounded bg-blue-600 text-white">+ Добавить</button>
        <label className="ml-auto text-sm flex items-center gap-2">
          <input type="checkbox" checked={showDeleted} onChange={(e) => setShowDeleted(e.target.checked)} />
          Показать удалённых
        </label>
      </div>

      <table className="w-full text-sm">
        <thead className="text-left text-zinc-500">
          <tr>
            <th className="py-2">Email</th>
            <th>Имя</th>
            <th>Роль</th>
            <th>Статус</th>
            <th>Последний вход</th>
            <th>Генераций (мес.)</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {users.map((u) => (
            <React.Fragment key={u.id}>
              <tr
                className={`border-t cursor-pointer hover:bg-zinc-50 dark:hover:bg-zinc-900/40 ${u.status === "deleted" ? "opacity-50" : ""}`}
                onClick={() => setExpandedId(expandedId === u.id ? null : u.id)}
              >
                <td className="py-2">{u.email}</td>
                <td>{u.name ?? "—"}</td>
                <td>{u.role}</td>
                <td>{u.status}</td>
                <td>{u.last_login_at ?? "—"}</td>
                <td>{u.gens_this_month}</td>
                <td className="text-right space-x-2" onClick={(e) => e.stopPropagation()}>
                  <button onClick={() => patch(u.id, { role: u.role === "admin" ? "user" : "admin" })} className="text-blue-600">
                    {u.role === "admin" ? "→ user" : "→ admin"}
                  </button>
                  {u.status === "active" && (
                    <button onClick={() => patch(u.id, { status: "banned" })} className="text-orange-600">Бан</button>
                  )}
                  {u.status === "banned" && (
                    <button onClick={() => patch(u.id, { status: "active" })} className="text-green-600">Разбан</button>
                  )}
                  {u.status === "deleted" ? (
                    <button onClick={() => patch(u.id, { status: "active" })} className="text-green-600">Восстановить</button>
                  ) : (
                    <button onClick={() => confirm(`Удалить ${u.email}?`) && patch(u.id, { status: "deleted" })} className="text-red-600">
                      Удалить
                    </button>
                  )}
                </td>
              </tr>
              {expandedId === u.id && (
                <tr className="bg-zinc-50 dark:bg-zinc-900/40">
                  <td colSpan={7} className="p-3">
                    <UserQuotas userId={u.id} />
                  </td>
                </tr>
              )}
            </React.Fragment>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function UserQuotas({ userId }: { userId: number }) {
  const [rows, setRows] = React.useState<QuotaRow[] | null>(null);
  const refetch = React.useCallback(async () => {
    const r = await fetch(`/api/admin/users/${userId}/quotas`, { cache: "no-store" });
    if (r.ok) setRows(await r.json());
  }, [userId]);
  React.useEffect(() => { void refetch(); }, [refetch]);

  async function setOverride(model_id: string, monthly_limit: number | null) {
    const r = await fetch(`/api/admin/users/${userId}/quotas/${model_id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ monthly_limit }),
    });
    if (r.ok) { toast.success("Сохранено"); void refetch(); } else toast.error("Ошибка");
  }
  async function clearOverride(model_id: string) {
    const r = await fetch(`/api/admin/users/${userId}/quotas/${model_id}`, { method: "DELETE" });
    if (r.ok) { toast.success("Сброшено"); void refetch(); } else toast.error("Ошибка");
  }

  if (!rows) return <div className="text-xs">Загрузка…</div>;
  return (
    <table className="w-full text-xs">
      <thead className="text-zinc-500"><tr>
        <th className="text-left">Модель</th>
        <th>Лимит</th><th>Источник</th><th>Использовано</th><th></th>
      </tr></thead>
      <tbody>
        {rows.map((r) => <QuotaRowEditor key={r.model_id} row={r} onSave={setOverride} onClear={clearOverride} />)}
      </tbody>
    </table>
  );
}

function QuotaRowEditor({ row, onSave, onClear }: {
  row: QuotaRow;
  onSave: (model_id: string, monthly_limit: number | null) => void;
  onClear: (model_id: string) => void;
}) {
  const [editing, setEditing] = React.useState(false);
  const [val, setVal] = React.useState<string>(row.applicable_limit?.toString() ?? "");
  const [unlimited, setUnlimited] = React.useState(row.applicable_limit === null);

  return (
    <tr className="border-t">
      <td className="py-1">{row.display_name}</td>
      <td>{editing
        ? <span className="space-x-1">
            <input type="number" value={val} disabled={unlimited} onChange={(e) => setVal(e.target.value)}
              className="border rounded px-2 py-0.5 w-20" />
            <label className="text-xs"><input type="checkbox" checked={unlimited} onChange={(e) => setUnlimited(e.target.checked)} /> ∞</label>
          </span>
        : row.applicable_limit === null ? "∞" : row.applicable_limit}
      </td>
      <td>{row.source}</td>
      <td>{row.usage_this_month}</td>
      <td className="text-right space-x-1">
        {editing ? (
          <>
            <button onClick={() => { onSave(row.model_id, unlimited ? null : Number(val)); setEditing(false); }} className="text-blue-600">Сохранить</button>
            <button onClick={() => setEditing(false)} className="text-zinc-500">Отмена</button>
          </>
        ) : (
          <>
            <button onClick={() => setEditing(true)} className="text-blue-600">[edit]</button>
            {row.has_override && (
              <button onClick={() => onClear(row.model_id)} className="text-orange-600">сброс default</button>
            )}
          </>
        )}
      </td>
    </tr>
  );
}
```

- [ ] **Step 2: Wire into `app/admin/page.tsx`**

Convert the existing admin page to a tabbed UI: Settings | Styles | Users | Models. Use a simple state `activeTab` + render switch. Don't pull in a tab library.

- [ ] **Step 3: Manual smoke + commit**

Open `/admin` (after login as admin), click `Users` tab, add an email, see it appear, change role, see a `quota_updated`/`user_role_changed` not coming back (that user isn't connected) — acceptable.

```bash
git add components/admin/users-tab.tsx app/admin/page.tsx
git commit -m "feat(admin-ui): Users tab — list, add, role/status, expand quotas"
```

---

### Task 9.4: Admin UI — Models tab

**Files:**
- Create: `components/admin/models-tab.tsx`
- Modify: `app/admin/page.tsx`

- [ ] **Step 1: Implement `components/admin/models-tab.tsx`**

```tsx
"use client";
import * as React from "react";
import { toast } from "sonner";

interface AdminModel {
  model_id: string;
  display_name: string;
  default_monthly_limit: number | null;
  is_active: 0 | 1;
  total_generations: number;
}

export function ModelsTab() {
  const [models, setModels] = React.useState<AdminModel[]>([]);
  const [editing, setEditing] = React.useState<string | null>(null);
  const [val, setVal] = React.useState<string>("");
  const [unlimited, setUnlimited] = React.useState(false);

  const refetch = React.useCallback(async () => {
    const r = await fetch("/api/admin/models", { cache: "no-store" });
    if (r.ok) setModels(await r.json());
  }, []);
  React.useEffect(() => { void refetch(); }, [refetch]);

  async function patch(model_id: string, body: Partial<{ default_monthly_limit: number | null; is_active: 0 | 1 }>) {
    const r = await fetch(`/api/admin/models/${model_id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (r.ok) { toast.success("Сохранено"); void refetch(); } else toast.error("Ошибка");
  }

  function startEdit(m: AdminModel) {
    setEditing(m.model_id);
    setVal(m.default_monthly_limit?.toString() ?? "");
    setUnlimited(m.default_monthly_limit === null);
  }

  return (
    <table className="w-full text-sm">
      <thead className="text-left text-zinc-500"><tr>
        <th className="py-2">Модель</th>
        <th>Default monthly limit</th>
        <th>Активна</th>
        <th>Всего генераций</th>
        <th></th>
      </tr></thead>
      <tbody>
        {models.map((m) => (
          <tr key={m.model_id} className="border-t">
            <td className="py-2">
              <div>{m.display_name}</div>
              <div className="text-xs text-zinc-500">{m.model_id}</div>
            </td>
            <td>
              {editing === m.model_id ? (
                <span className="space-x-1">
                  <input type="number" value={val} disabled={unlimited} onChange={(e) => setVal(e.target.value)}
                    className="border rounded px-2 py-0.5 w-24" />
                  <label className="text-xs"><input type="checkbox" checked={unlimited} onChange={(e) => setUnlimited(e.target.checked)} /> ∞</label>
                </span>
              ) : m.default_monthly_limit === null ? "∞ (unlimited)" : m.default_monthly_limit}
            </td>
            <td>
              <input type="checkbox" checked={m.is_active === 1}
                onChange={(e) => patch(m.model_id, { is_active: e.target.checked ? 1 : 0 })} />
            </td>
            <td>{m.total_generations}</td>
            <td className="text-right space-x-1">
              {editing === m.model_id ? (
                <>
                  <button onClick={() => { patch(m.model_id, { default_monthly_limit: unlimited ? null : Number(val) }); setEditing(null); }} className="text-blue-600">Сохранить</button>
                  <button onClick={() => setEditing(null)} className="text-zinc-500">Отмена</button>
                </>
              ) : (
                <button onClick={() => startEdit(m)} className="text-blue-600">[edit]</button>
              )}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
```

- [ ] **Step 2: Wire into `app/admin/page.tsx`**

Add `ModelsTab` import; in the tab switcher add `{ id: "models", label: "Модели" }` with `<ModelsTab />` rendered when active.

- [ ] **Step 3: Commit**

```bash
git add components/admin/models-tab.tsx app/admin/page.tsx
git commit -m "feat(admin-ui): Models tab — edit defaults and activation"
```

---

## Phase 10: Client UX — header, sidebar tabs, my-quotas, generate-form gating, cleanup

### Task 10.1: Header user menu

**Files:**
- Create: `components/header-user-menu.tsx`
- Modify: place it in the existing playground header (`components/playground.tsx` or wherever the top bar lives — use grep to find)

- [ ] **Step 1: Implement `components/header-user-menu.tsx`**

```tsx
"use client";
import * as React from "react";
import Link from "next/link";
import { useUser } from "@/app/providers/user-provider";

export function HeaderUserMenu() {
  const { user } = useUser();
  const [open, setOpen] = React.useState(false);
  const ref = React.useRef<HTMLDivElement>(null);

  React.useEffect(() => {
    function onClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    if (open) document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, [open]);

  if (!user) return null;

  async function logout() {
    await fetch("/api/auth/logout", { method: "POST" });
    window.location.href = "/login";
  }

  const initial = (user.name ?? user.email)[0]?.toUpperCase() ?? "?";

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-2 rounded-full hover:bg-zinc-100 dark:hover:bg-zinc-900 px-2 py-1"
      >
        {user.picture_url ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={user.picture_url} alt="" className="w-7 h-7 rounded-full" />
        ) : (
          <span className="w-7 h-7 rounded-full bg-zinc-200 dark:bg-zinc-700 grid place-items-center text-xs font-medium">
            {initial}
          </span>
        )}
        <span className="text-sm hidden sm:inline">{user.name ?? user.email}</span>
        {user.role === "admin" && (
          <span className="text-[10px] uppercase font-semibold tracking-wide bg-violet-100 dark:bg-violet-900/40 text-violet-700 dark:text-violet-300 px-1.5 py-0.5 rounded">
            admin
          </span>
        )}
      </button>
      {open && (
        <div className="absolute right-0 mt-2 w-56 rounded-lg border bg-white dark:bg-zinc-900 shadow-lg p-1 z-50">
          <div className="px-3 py-2 text-xs text-zinc-500 truncate">{user.email}</div>
          {user.role === "admin" && (
            <Link href="/admin" className="block px-3 py-2 text-sm hover:bg-zinc-100 dark:hover:bg-zinc-800 rounded">
              Админка
            </Link>
          )}
          <button onClick={logout} className="block w-full text-left px-3 py-2 text-sm hover:bg-zinc-100 dark:hover:bg-zinc-800 rounded">
            Выйти
          </button>
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Wire into the top bar**

Replace whatever currently shows the username (likely a small `<span>` near the theme toggle) with `<HeaderUserMenu />`.

- [ ] **Step 3: Commit**

```bash
git add components/header-user-menu.tsx components/playground.tsx
git commit -m "feat(ui): header user menu with logout and admin shortcut"
```

---

### Task 10.2: Sidebar tabs — История | Мои лимиты

**Files:**
- Modify: `components/history-sidebar.tsx`
- Create: `components/my-quotas-tab.tsx`

- [ ] **Step 1: Implement quotas tab**

`components/my-quotas-tab.tsx`:

```tsx
"use client";
import * as React from "react";
import { useUser } from "@/app/providers/user-provider";

interface Quota {
  model_id: string; display_name: string;
  limit: number | null; used: number; unlimited: boolean;
}

export function MyQuotasTab() {
  const [data, setData] = React.useState<Quota[] | null>(null);

  const refetch = React.useCallback(async () => {
    const r = await fetch("/api/me/quotas", { cache: "no-store" });
    if (r.ok) setData(await r.json());
  }, []);

  React.useEffect(() => { void refetch(); }, [refetch]);

  // Subscribe to SSE quota_updated; reuse existing connection from history-sidebar via a shared event
  // For MVP: window 'storage' or BroadcastChannel; simplest is a custom event the SSE
  // dispatcher fires. See existing patterns in lib/history.

  if (!data) return <div className="p-4 text-sm text-muted">Loading...</div>;

  const sorted = [...data].sort((a, b) => {
    const aExhausted = !a.unlimited && a.used >= (a.limit ?? 0);
    const bExhausted = !b.unlimited && b.used >= (b.limit ?? 0);
    if (aExhausted !== bExhausted) return aExhausted ? 1 : -1;
    return a.display_name.localeCompare(b.display_name);
  });

  return (
    <div className="flex flex-col gap-2 p-3">
      {sorted.map((q) => <QuotaCard key={q.model_id} q={q} />)}
    </div>
  );
}

function QuotaCard({ q }: { q: Quota }) {
  if (q.unlimited) {
    return (
      <div className="rounded-lg border p-3">
        <div className="text-sm font-medium">{q.display_name}</div>
        <div className="text-xs text-muted-foreground">∞ Без ограничений · использовано в этом месяце: {q.used}</div>
      </div>
    );
  }
  const limit = q.limit ?? 0;
  const pct = limit === 0 ? 100 : Math.min(100, (q.used / limit) * 100);
  const color =
    pct >= 100 ? "bg-red-500" :
    pct >= 80  ? "bg-orange-500" : "bg-green-500";
  return (
    <div className="rounded-lg border p-3">
      <div className="text-sm font-medium">{q.display_name}</div>
      <div className="h-2 bg-zinc-200 dark:bg-zinc-800 rounded-full mt-2 overflow-hidden">
        <div className={`h-full ${color}`} style={{ width: `${pct}%` }} />
      </div>
      <div className="text-xs text-muted-foreground mt-1">
        {q.used} / {limit}
        {q.used >= limit ? " · Лимит исчерпан" : " · В этом месяце"}
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Add tab switcher to history-sidebar**

In `components/history-sidebar.tsx`:
- Add header showing email/role bezel/logout (or import HeaderUserMenu if already in playground header — choose one place).
- Below that, two-button tab switcher.
- Conditionally render `<HistoryListView ... />` (existing content) or `<MyQuotasTab />`.
- Clicking on email at top → `setActiveTab('quotas')` (the shortcut user requested).

- [ ] **Step 3: Subscribe to `quota_updated` via SSE**

Reuse the existing SSE listener (`lib/history/store.ts` or wherever it lives). Add handling for `quota_updated` event → call MyQuotasTab's refetch (via a shared event bus or zustand action).

If existing SSE plumbing is too coupled — use a `BroadcastChannel('quotas')` in the store: when SSE receives `quota_updated`, post to channel; MyQuotasTab listens.

- [ ] **Step 4: Commit**

```bash
git add components/history-sidebar.tsx components/my-quotas-tab.tsx lib/history
git commit -m "feat(sidebar): tabs (История | Мои лимиты) + live quotas via SSE"
```

---

### Task 10.3: Generate-form — disable button + status string

**Files:**
- Modify: `components/generate-form.tsx`
- Modify: `components/playground.tsx` (model selector — disable exhausted)

- [ ] **Step 1: Implement `app/providers/quotas-provider.tsx`**

```tsx
"use client";
import * as React from "react";

export interface Quota {
  model_id: string;
  display_name: string;
  limit: number | null;
  used: number;
  unlimited: boolean;
}

interface Ctx {
  quotas: Quota[];
  loading: boolean;
  refetch: () => Promise<void>;
  bumpUsage: (model_id: string) => void;
  getForModel: (model_id: string) => Quota | undefined;
}

const QuotasContext = React.createContext<Ctx | null>(null);

export function QuotasProvider({ children }: { children: React.ReactNode }) {
  const [quotas, setQuotas] = React.useState<Quota[]>([]);
  const [loading, setLoading] = React.useState(true);

  const refetch = React.useCallback(async () => {
    try {
      const r = await fetch("/api/me/quotas", { cache: "no-store" });
      if (r.ok) setQuotas(await r.json());
    } catch (err) {
      console.warn("[quotas] refetch failed:", err);
    } finally {
      setLoading(false);
    }
  }, []);

  React.useEffect(() => {
    void refetch();
    function onVisibility() {
      if (document.visibilityState === "visible") void refetch();
    }
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, [refetch]);

  // Listen for SSE-driven updates broadcast on a BroadcastChannel.
  // The history SSE handler in lib/history/* posts to this channel
  // when it receives `quota_updated` / `user_role_changed` events.
  React.useEffect(() => {
    if (typeof BroadcastChannel === "undefined") return;
    const bc = new BroadcastChannel("quotas");
    bc.onmessage = () => { void refetch(); };
    return () => bc.close();
  }, [refetch]);

  const bumpUsage = React.useCallback((model_id: string) => {
    setQuotas((qs) => qs.map((q) => q.model_id === model_id ? { ...q, used: q.used + 1 } : q));
  }, []);

  const getForModel = React.useCallback(
    (model_id: string) => quotas.find((q) => q.model_id === model_id),
    [quotas]
  );

  return (
    <QuotasContext.Provider value={{ quotas, loading, refetch, bumpUsage, getForModel }}>
      {children}
    </QuotasContext.Provider>
  );
}

export function useQuotas(): Ctx {
  const v = React.useContext(QuotasContext);
  if (!v) throw new Error("useQuotas must be used inside QuotasProvider");
  return v;
}
```

Wire in `app/providers.tsx`: wrap `<QuotasProvider>` inside `<UserProvider>` (so quotas only fetch after we know there's a user).

In `lib/history/store.ts` (or wherever the SSE event router lives), when receiving event type `quota_updated`, `user_role_changed`, or `user_banned`:
- For `quota_updated` and `user_role_changed`: `new BroadcastChannel("quotas").postMessage({type: "refetch"})` then close.
- For `user_banned`: show toast "Сессия закрыта администратором" and `window.location.replace("/login")`.

- [ ] **Step 2: Modify `components/generate-form.tsx` — disable Generate when exhausted**

Find the existing Generate button in `generate-form.tsx`. Add at top of component:

```tsx
import { useQuotas } from "@/app/providers/quotas-provider";

const { getForModel, refetch: refetchQuotas, bumpUsage } = useQuotas();
const quota = getForModel(selectedModel);
const exhausted = quota && !quota.unlimited && quota.used >= (quota.limit ?? 0);
```

Modify the Generate button:

```tsx
<button
  disabled={isGenerating || exhausted /* + existing disable conditions */}
  title={exhausted ? "Лимит исчерпан в этом месяце" : undefined}
  className={/* existing classes; add `disabled:opacity-50 disabled:cursor-not-allowed` if not present */}
  onClick={onGenerateClick}
>
  Generate
</button>

{/* Status line right under the button */}
{quota && (
  <div className={`text-xs mt-1 ${
    quota.unlimited ? "text-zinc-500"
      : quota.used >= (quota.limit ?? 0) ? "text-red-600"
      : quota.used / (quota.limit ?? 1) >= 0.8 ? "text-orange-600"
      : "text-zinc-500"
  }`}>
    {quota.unlimited
      ? "Без ограничений"
      : quota.used >= (quota.limit ?? 0)
        ? `Лимит исчерпан · сбросится 1 числа следующего месяца`
        : `${quota.used} / ${quota.limit} в этом месяце`}
  </div>
)}
```

- [ ] **Step 3: Bump usage after successful upload**

In `generate-form.tsx`'s `saveToServerHistory` flow, after `uploadHistoryEntry` resolves with success (the existing `res.success === true` branch), add:

```ts
bumpUsage(selectedModel);
```

This optimistically increments local `used` so UI updates immediately without round-trip.

- [ ] **Step 4: Handle 429 from submit**

In the submit error handler (where `/api/generate/submit` errors are caught), add:

```ts
if (err && typeof err === "object" && (err as any).error === "quota_exceeded") {
  const e = err as { model_id: string; limit: number; used: number };
  toast.error(
    `Лимит модели ${e.model_id} исчерпан в этом месяце (${e.used}/${e.limit}). ` +
    `Сбросится 1 числа следующего месяца. Можно попросить админа увеличить лимит.`
  );
  void refetchQuotas();
  return;
}
```

You'll need to make the submit fetch parse the JSON error body when status is 429 — look for the existing fetch wrapper and ensure it surfaces `{error, model_id, limit, used}` to the catch site.

- [ ] **Step 5: Disable exhausted models in the selector**

Find the model selector in `components/playground.tsx` (or wherever it lives — `grep -rn "selectedModel\b" components | head`). It iterates over a list of models. Inject quota lookup:

```tsx
const { getForModel } = useQuotas();
// ... in the .map((m) => …):
const q = getForModel(m.id);
const isExhausted = q && !q.unlimited && q.used >= (q.limit ?? 0);
return (
  <Option
    key={m.id}
    value={m.id}
    disabled={isExhausted}
    title={isExhausted ? "Лимит исчерпан в этом месяце" : undefined}
  >
    {m.displayName}{isExhausted ? " ⛔" : ""}
  </Option>
);
```

(Adjust to match the actual selector primitive — Radix `Select.Item`, custom `<button>`, etc.)

- [ ] **Step 6: Manual smoke**

Configure a low limit on `nano-banana-pro` (e.g., `default_monthly_limit=2`). Generate twice → 3rd attempt: button greys out, click 429 → toast → SSE updates UI on admin raise (manual test).

- [ ] **Step 7: Commit**

```bash
git add components app/providers
git commit -m "feat(generate): quota-aware Generate button + selector + toast"
```

---

### Task 10.4: Cleanup — remove legacy admin login and UsernameModal

**Files:**
- Delete: `app/admin/login/page.tsx`
- Delete: `app/api/admin/login/route.ts`
- Delete: `app/api/admin/logout/route.ts`
- Delete: `components/username-modal.tsx`
- Modify: `components/playground.tsx` (remove `<UsernameModal />` mount)

- [ ] **Step 1: Delete files**

```bash
rm -rf app/admin/login
rm -rf app/api/admin/login app/api/admin/logout
rm components/username-modal.tsx
```

- [ ] **Step 2: Remove imports/mounts**

```bash
grep -rn "UsernameModal\|username-modal" app components
```

For each match — remove the import and JSX usage. Likely just `components/playground.tsx`.

- [ ] **Step 3: Remove `ADMIN_PASSWORD` references**

```bash
grep -rn "ADMIN_PASSWORD\|admin_auth\|wavespeed-admin-v1" middleware.ts app lib
```

The middleware was already rewritten in 6.1. Search for any leftover constant or comment in deleted-file related code.

- [ ] **Step 4: Run full test suite**

```bash
npm test
```

Expected: all green. Triage and fix any failures.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "chore(auth): remove admin password login and UsernameModal"
```

---

## Phase 11: SSE event extensions for admin actions

### Task 11.1: Wire `quota_updated` on default change

**Files:**
- Modify: `app/api/admin/models/[model_id]/route.ts` (already partially done in 9.2 — verify)

- [ ] **Step 1: Verify broadcast on real change only**

In the PATCH handler, compare `before.default_monthly_limit` vs `after`. Only if changed:

```ts
const affected = db.prepare(`
  SELECT u.id FROM users u
  WHERE u.status='active'
    AND u.id NOT IN (SELECT user_id FROM user_quotas WHERE model_id=?)
`).all(model_id) as { id: number }[];
for (const { id } of affected) {
  broadcastToUserId(id, { type: "quota_updated" });
}
```

Same for is_active changes (they affect the model selector, so `quota_updated` to everyone is correct).

- [ ] **Step 2: Manual smoke**

Two browsers logged in (one as admin, one as Alice). Admin changes Nano Banana Pro default limit → Alice's "Мои лимиты" tab updates без F5.

- [ ] **Step 3: Commit (if any code changed)**

```bash
git add app/api/admin/models
git commit -m "feat(sse): quota_updated only fires on real default change"
```

---

### Task 11.2: Verify ban + role flows with SSE

(Already wired in 9.1 — this task is integration verification.)

- [ ] **Step 1: Manual: ban**

Admin bans Alice. Alice's tab — within ~1s — toast "Сессия закрыта" + redirect to `/login`.

- [ ] **Step 2: Manual: role change**

Admin promotes Alice to admin. Alice's header shows the `admin` badge + Админка link (no F5).

- [ ] **Step 3: If any bug — fix and commit**

```bash
git add ...
git commit -m "fix(sse): ..."
```

---

## Phase 12: Final smoke + rollout prep

### Task 12.1: Run the full smoke list from spec §11.3

For each of the 13 manual smoke items in `docs/superpowers/specs/2026-04-30-google-auth-design.md` §11.3:

- [ ] 1. non-allowlist email → 403
- [ ] 2. unverified email → 403
- [ ] 3. valid email → redirect to `?next`
- [ ] 4. `?next=https://evil.com` is sanitized
- [ ] 5. logout → cookie cleared, redirect to /login
- [ ] 6. ban during active session → 401 + redirect via SSE
- [ ] 7. quota=2, generate 3rd time → 429
- [ ] 8. admin generates without limit
- [ ] 9. admin raises limit → button unblocks via SSE
- [ ] 10. delete user → files remain, generations remain in DB, login → 403
- [ ] 11. two tabs same user → quotas synced
- [ ] 12. non-tapclap email + ALLOWED_HD=tapclap.com → 403
- [ ] 13. crafted oauth_tx with absolute next → safeNext sanitizes

Document any deviations as bugs to fix.

### Task 12.2: Rollout checklist for prod

- [ ] User moves `data/history.db` and `data/history_images/*` (legacy flat layout) to archive location
- [ ] Google Cloud Console:
  - User Type: `Internal` (recommended)
  - Authorized redirect URIs: prod + dev URLs
- [ ] Set env vars on prod server (`.env.production` or container env): `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REDIRECT_URI`, `SESSION_COOKIE_SECRET`, `BOOTSTRAP_ADMIN_EMAILS`, optionally `ALLOWED_HD`
- [ ] Remove `ADMIN_PASSWORD` from prod env (no longer used)
- [ ] Deploy
- [ ] First login by admin → verify `/admin` works, add allowlist for the rest

### Task 12.3: Final commit with version bump (optional)

```bash
git tag -a auth-v1 -m "Google OAuth + per-model quotas v1"
```

---

## Self-review checklist (run before declaring plan complete)

- [ ] Every spec section §1-§16 has a concrete implementing task
- [ ] No "TODO/TBD/implement later" placeholders in plan body
- [ ] Function names consistent across tasks (e.g., `getCurrentUser` everywhere, not `getUser` in some places)
- [ ] Cookie names consistent (`__Host-session`/`session`, `__Host-oauth_tx`/`oauth_tx`)
- [ ] All test files have a clear "verify it fails" step before implementation
- [ ] All code blocks compile-able (right imports, right types)
- [ ] `getDb()` — used consistently, defined once in `lib/history-db.ts`
- [ ] FK directions match schema (`user_id REFERENCES users(id) ON DELETE RESTRICT` for generations; `ON DELETE CASCADE` for sessions/user_quotas/user_preferences)
- [ ] Every task ends with a commit

---

**Plan ready for execution.**
