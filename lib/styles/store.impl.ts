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
  }
  out = out.replace(/-+/g, "-").replace(/^-|-$/g, "");
  if (!out) out = "style";
  return out.slice(0, 40);
}

function randomSuffix(): string {
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
