import Database from "better-sqlite3";
import path from "node:path";
import fs from "node:fs";
import type { ModelId } from "./providers/types";

/**
 * SQLite history layer — schema-compatible with viewcomfy-claude's lib/db.ts
 * so the same DB file can be shared between both apps.
 *
 * Storage location is controlled by HISTORY_DATA_DIR env var:
 *   - dev (unset)  → ./data relative to process.cwd()
 *   - container    → /data (set via docker-compose volume mount)
 */

/**
 * WARNING: MIGRATION IN PROGRESS (Google OAuth, branch `auth/google-oauth`)
 *
 * Tasks 7.1–7.6 will rewrite the per-user CRUD functions below
 * (saveGeneration, getGenerations, getGenerationById, deleteGeneration,
 * getUserSelectedModel, setUserSelectedModel) to use `user_id INTEGER`
 * instead of `username TEXT`. Until those tasks land, calling any of
 * those functions will throw `SqliteError: no such column: username` —
 * the schema was updated by Task 2.3 but the call sites have not yet
 * been ported.
 *
 * Plan: docs/superpowers/plans/2026-04-30-google-auth-implementation.md
 */

const DATA_DIR = process.env.HISTORY_DATA_DIR
  ? path.resolve(process.env.HISTORY_DATA_DIR)
  : path.join(process.cwd(), "data");

const DB_PATH = path.join(DATA_DIR, "history.db");
const HISTORY_IMAGES_DIR = path.join(DATA_DIR, "history_images");

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(HISTORY_IMAGES_DIR))
  fs.mkdirSync(HISTORY_IMAGES_DIR, { recursive: true });

let _db: Database.Database | null = null;

function getDb(): Database.Database {
  if (!_db) {
    _db = new Database(DB_PATH);
    initSchema(_db);
    seedModels(_db);
    bootstrapAdmins(_db, process.env.BOOTSTRAP_ADMIN_EMAILS);
  }
  return _db;
}

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
      created_at      TEXT    DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      last_login_at   TEXT
    );

    CREATE TABLE IF NOT EXISTS sessions (
      id            TEXT    PRIMARY KEY,
      user_id       INTEGER NOT NULL,
      created_at    TEXT    DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
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
      created_at            TEXT    DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      updated_at            TEXT    DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    );

    CREATE TABLE IF NOT EXISTS user_quotas (
      user_id        INTEGER NOT NULL,
      model_id       TEXT    NOT NULL,
      monthly_limit  INTEGER,
      updated_at     TEXT    DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      PRIMARY KEY (user_id, model_id),
      FOREIGN KEY (user_id)  REFERENCES users(id)  ON DELETE CASCADE,
      FOREIGN KEY (model_id) REFERENCES models(model_id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS auth_events (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp   TEXT    DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
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
      created_at              TEXT    DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
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
      updated_at     TEXT    DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS app_settings (
      key        TEXT    PRIMARY KEY,
      value      TEXT    NOT NULL,
      updated_at TEXT    DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    );
  `);
}

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

/**
 * Read a user's persisted model choice. Returns null when:
 *   - the user has never picked anything (no row),
 *   - the row exists but selected_model is NULL.
 * Caller (the API route) translates null → client default "nano-banana-2".
 */
export function getUserSelectedModel(username: string): string | null {
  const db = getDb();
  const row = db
    .prepare(`SELECT selected_model FROM user_preferences WHERE username = ?`)
    .get(username) as { selected_model: string | null } | undefined;
  return row?.selected_model ?? null;
}

/**
 * Upsert a user's model choice. Atomic via SQLite ON CONFLICT — safe under
 * concurrent writes from the same user across multiple tabs / devices.
 * Last write wins, which is the right semantic for a UI picker.
 */
export function setUserSelectedModel(username: string, modelId: string): void {
  const db = getDb();
  db.prepare(
    `INSERT INTO user_preferences (username, selected_model, updated_at)
     VALUES (?, ?, datetime('now'))
     ON CONFLICT(username) DO UPDATE SET
       selected_model = excluded.selected_model,
       updated_at = datetime('now')`
  ).run(username, modelId);
}

export interface IGenerationOutput {
  id: number;
  generation_id: number;
  filename: string;
  filepath: string;
  content_type: string;
  size: number;
}

export interface IGenerationRecord {
  id: number;
  username: string;
  workflow_name: string;
  prompt_data: string;
  execution_time_seconds: number;
  created_at: string;
  status: string;
  outputs: IGenerationOutput[];
}

export interface ISaveGenerationParams {
  username: string;
  workflowName: string;
  promptData: Record<string, unknown>;
  executionTimeSeconds: number;
  outputs: {
    filename: string;
    filepath: string;
    contentType: string;
    size: number;
  }[];
}

export function saveGeneration(params: ISaveGenerationParams): number {
  const db = getDb();
  const insertGen = db.prepare(
    `INSERT INTO generations (username, workflow_name, prompt_data, execution_time_seconds)
     VALUES (?, ?, ?, ?)`
  );
  const insertOut = db.prepare(
    `INSERT INTO generation_outputs (generation_id, filename, filepath, content_type, size)
     VALUES (?, ?, ?, ?, ?)`
  );
  const tx = db.transaction(() => {
    const result = insertGen.run(
      params.username,
      params.workflowName,
      JSON.stringify(params.promptData),
      params.executionTimeSeconds
    );
    const genId = result.lastInsertRowid as number;
    for (const o of params.outputs) {
      insertOut.run(genId, o.filename, o.filepath, o.contentType, o.size);
    }
    return genId;
  });
  return tx();
}

export function getGenerations(params: {
  username: string;
  startDate?: string;
  endDate?: string;
  limit?: number;
  offset?: number;
}): IGenerationRecord[] {
  const db = getDb();
  let q = `SELECT * FROM generations WHERE username = ?`;
  const p: (string | number)[] = [params.username];
  // Wrap both sides in `datetime()` so SQLite normalizes the stored
  // "YYYY-MM-DD HH:MM:SS" format (from datetime('now')) and the client's
  // ISO "...T...Z" params to the same representation before comparing.
  // Without this, raw TEXT comparison diverges at the date/time separator
  // (space 0x20 vs 'T' 0x54) and excludes rows right at the boundary day.
  if (params.startDate) {
    q += ` AND datetime(created_at) >= datetime(?)`;
    p.push(params.startDate);
  }
  if (params.endDate) {
    q += ` AND datetime(created_at) <= datetime(?)`;
    p.push(params.endDate);
  }
  q += ` ORDER BY created_at DESC`;
  if (params.limit) {
    q += ` LIMIT ?`;
    p.push(params.limit);
  }
  if (params.offset) {
    q += ` OFFSET ?`;
    p.push(params.offset);
  }

  const gens = db.prepare(q).all(...p) as IGenerationRecord[];
  const getOuts = db.prepare(
    `SELECT * FROM generation_outputs WHERE generation_id = ?`
  );
  for (const g of gens) {
    g.outputs = getOuts.all(g.id) as IGenerationOutput[];
  }
  return gens;
}

export function getGenerationById(id: number): IGenerationRecord | null {
  const db = getDb();
  const gen = db
    .prepare(`SELECT * FROM generations WHERE id = ?`)
    .get(id) as IGenerationRecord | undefined;
  if (!gen) return null;
  const outs = db
    .prepare(`SELECT * FROM generation_outputs WHERE generation_id = ?`)
    .all(id) as IGenerationOutput[];
  gen.outputs = outs;
  return gen;
}

export function deleteGeneration(
  id: number,
  username: string
): { deleted: boolean; filepaths: string[] } {
  const db = getDb();
  const outs = db
    .prepare(`SELECT filepath FROM generation_outputs WHERE generation_id = ?`)
    .all(id) as { filepath: string }[];
  const filepaths = outs.map((o) => o.filepath);
  const result = db
    .prepare(`DELETE FROM generations WHERE id = ? AND username = ?`)
    .run(id, username);
  return { deleted: result.changes > 0, filepaths };
}

export function getHistoryImagesDir(): string {
  return HISTORY_IMAGES_DIR;
}

export function getDataDir(): string {
  return DATA_DIR;
}

// ============================================================
// app_settings: simple key/value store for global app preferences
// (e.g. selectedProvider). Persisted server-side so admin choices
// apply to ALL users of the deployment, not just the admin's browser.
// ============================================================

/**
 * Read a single app setting by key. Returns null if the key has never
 * been written. Caller is responsible for applying its own default.
 */
export function getAppSetting(key: string): string | null {
  const db = getDb();
  const row = db
    .prepare(`SELECT value FROM app_settings WHERE key = ?`)
    .get(key) as { value: string } | undefined;
  return row ? row.value : null;
}

/**
 * Upsert a single app setting. Atomic via SQLite's ON CONFLICT, no
 * race possible even with concurrent admin writes.
 */
export function setAppSetting(key: string, value: string): void {
  const db = getDb();
  db.prepare(
    `INSERT INTO app_settings (key, value, updated_at)
     VALUES (?, ?, datetime('now'))
     ON CONFLICT(key) DO UPDATE SET
       value = excluded.value,
       updated_at = datetime('now')`
  ).run(key, value);
}
