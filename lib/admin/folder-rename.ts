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
    const candidate =
      n === 1 ? `deleted_${email}` : `deleted_${n}_${email}`;
    const exists = await fs
      .access(path.join(imagesDir, candidate))
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
  const srcExists = await fs
    .access(src)
    .then(() => true)
    .catch(() => false);
  if (!srcExists) return { renamed: false, reason: "no_source" };

  const target = await findFreeDeletedTarget(imagesDir, email);
  await fs.rename(src, path.join(imagesDir, target));
  return { renamed: true, target };
}
