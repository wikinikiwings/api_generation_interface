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
