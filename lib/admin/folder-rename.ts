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

type ErrnoCode = "EPERM" | "EBUSY" | "ENOTEMPTY" | string | undefined;

const TRANSIENT_RENAME_CODES = new Set<string>(["EPERM", "EBUSY", "ENOTEMPTY"]);

const RENAME_BACKOFF_MS = [50, 100, 200, 400, 800];

/**
 * Wrap fs.rename with retry-on-transient-error. Windows occasionally
 * holds a directory handle briefly after writes inside the source folder
 * (file system caches, antivirus, Explorer focus, indexers), causing
 * EPERM/EBUSY on a rename that would succeed milliseconds later.
 *
 * Total retry budget: ~1.55s across 5 retries with exponential backoff.
 * Non-transient codes (e.g. ENOENT, EACCES) throw immediately.
 *
 * Exposed so tests can drive it; production callers go through
 * `renameUserFolderToDeleted` below.
 */
export async function renameWithRetry(src: string, dst: string): Promise<void> {
  let lastErr: unknown;
  for (let attempt = 0; attempt <= RENAME_BACKOFF_MS.length; attempt++) {
    try {
      await fs.rename(src, dst);
      return;
    } catch (err) {
      lastErr = err;
      const code: ErrnoCode = (err as NodeJS.ErrnoException).code;
      if (!code || !TRANSIENT_RENAME_CODES.has(code)) {
        throw err;
      }
      const wait = RENAME_BACKOFF_MS[attempt];
      if (wait === undefined) break; // exhausted retries
      await new Promise((r) => setTimeout(r, wait));
    }
  }
  throw lastErr;
}

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
  await renameWithRetry(src, path.join(imagesDir, target));
  return { renamed: true, target };
}

/**
 * Like `findFreeDeletedTarget` but probes the same slot across all given
 * dirs and returns the lowest index that is free in EVERY dir. Used by
 * hard-delete so that the user's images and variants archives end up at
 * the same on-disk name even if prior purges left different slot patterns
 * in each dir.
 */
export async function findFreeDeletedTargetAcross(
  dirs: string[],
  email: string
): Promise<string> {
  let n = 1;
  while (true) {
    const candidate =
      n === 1 ? `deleted_${email}` : `deleted_${n}_${email}`;
    const occupied = await Promise.all(
      dirs.map((d) =>
        fs.access(path.join(d, candidate)).then(() => true).catch(() => false)
      )
    );
    if (!occupied.some((x) => x)) return candidate;
    n++;
  }
}

/**
 * Like `renameUserFolderToDeleted` but uses an externally chosen target
 * name. Paired with `findFreeDeletedTargetAcross` so both calls land at
 * the same slot.
 */
export async function renameUserFolderToTarget(
  dir: string,
  email: string,
  target: string
): Promise<RenameResult> {
  const src = path.join(dir, email);
  const srcExists = await fs
    .access(src)
    .then(() => true)
    .catch(() => false);
  if (!srcExists) return { renamed: false, reason: "no_source" };
  await renameWithRetry(src, path.join(dir, target));
  return { renamed: true, target };
}
