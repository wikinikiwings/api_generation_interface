import Database from "better-sqlite3";
import path from "node:path";
import fs from "node:fs";

/**
 * SQLite history layer — schema-compatible with viewcomfy-claude's lib/db.ts
 * so the same DB file can be shared between both apps.
 *
 * Storage location is controlled by HISTORY_DATA_DIR env var:
 *   - dev (unset)  → ./data relative to process.cwd()
 *   - container    → /data (set via docker-compose volume mount)
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
    _db.pragma("journal_mode = WAL");
    _db.pragma("foreign_keys = ON");
    initDb(_db);
  }
  return _db;
}

function initDb(db: Database.Database) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS generations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT NOT NULL,
      workflow_name TEXT DEFAULT '',
      prompt_data TEXT DEFAULT '{}',
      execution_time_seconds REAL DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now')),
      status TEXT DEFAULT 'completed'
    );
    CREATE TABLE IF NOT EXISTS generation_outputs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      generation_id INTEGER NOT NULL,
      filename TEXT NOT NULL,
      filepath TEXT NOT NULL,
      content_type TEXT NOT NULL,
      size INTEGER DEFAULT 0,
      FOREIGN KEY (generation_id) REFERENCES generations(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_generations_username ON generations(username);
    CREATE INDEX IF NOT EXISTS idx_generations_created_at ON generations(created_at);
    CREATE INDEX IF NOT EXISTS idx_generation_outputs_generation_id
      ON generation_outputs(generation_id);
    CREATE TABLE IF NOT EXISTS app_settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT DEFAULT (datetime('now'))
    );
    -- Per-user preferences (Phase 5b: sticky model picker per identity).
    -- Keyed by username because that's the only identity primitive we have
    -- (no auth, no user-id surrogate). Aditive table — schema-compatible
    -- with viewcomfy-claude since it just adds, never modifies.
    -- selected_model is nullable so a row can exist with NULL meaning
    -- "explicitly cleared, fall back to default". In practice we just
    -- delete the row when clearing, but the column allows future prefs.
    CREATE TABLE IF NOT EXISTS user_preferences (
      username TEXT PRIMARY KEY,
      selected_model TEXT,
      updated_at TEXT DEFAULT (datetime('now'))
    );
  `);
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
  if (params.startDate) {
    q += ` AND created_at >= ?`;
    p.push(params.startDate);
  }
  if (params.endDate) {
    q += ` AND created_at <= ?`;
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
