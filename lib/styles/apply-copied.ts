import { type Style } from "./types";

export interface CopiedEntry {
  /** The wrapped prompt as stored. Always present. */
  prompt: string;
  /** Clean user-authored part if the entry was generated post-feature. */
  userPrompt?: string;
  /**
   * Ids of the styles applied at generation. Undefined on pre-feature
   * entries. Empty array means an explicit post-feature "Стандартный".
   */
  styleIds?: string[];
  /** styleId → updatedAt at generation time, for edit detection. */
  styleVersions?: Record<string, string>;
}

export interface ApplyCopiedSetters {
  setPrompt: (s: string) => void;
  setSelectedStyleIds: (ids: string[]) => void;
  toastInfo: (msg: string) => void;
  toastWarn: (msg: string) => void;
}

/**
 * Join style names for display ("Кино + 3D + Гроза"). Falls back to raw
 * id for any id that is no longer in the provided styles list.
 */
export function joinStyleNames(
  ids: readonly string[],
  styles: readonly Style[]
): string {
  return ids.map((id) => styles.find((s) => s.id === id)?.name ?? id).join(" + ");
}

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

/**
 * Four branches:
 *   1. Pre-feature (styleIds undefined) — paste entry.prompt, leave
 *      selection alone, "Промпт скопирован".
 *   2. Default (styleIds === []) — paste clean userPrompt, clear
 *      selection, "Промпт скопирован".
 *   3. All ids resolve — paste clean userPrompt, set selection to the
 *      stored ids, toast with joined names; append change note if any
 *      style's updatedAt differs from styleVersions.
 *   4. At least one id missing — paste clean userPrompt, select only
 *      the survivors, warn with name of the missing style (or generic plural).
 */
export function applyCopiedPrompt(
  entry: CopiedEntry,
  styles: readonly Style[],
  setters: ApplyCopiedSetters
): void {
  if (entry.styleIds === undefined) {
    setters.setPrompt(entry.prompt);
    setters.toastInfo("Промпт скопирован");
    return;
  }

  if (entry.styleIds.length === 0) {
    setters.setPrompt(entry.userPrompt ?? entry.prompt);
    setters.setSelectedStyleIds([]);
    setters.toastInfo("Промпт скопирован");
    return;
  }

  const knownIds = new Set(styles.map((s) => s.id));
  const missingIds = entry.styleIds.filter((id) => !knownIds.has(id));

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

  // At least one missing — degrade to clean userPrompt, keep survivors.
  const survivors = entry.styleIds.filter((id) => knownIds.has(id));
  setters.setPrompt(entry.userPrompt ?? entry.prompt);
  setters.setSelectedStyleIds(survivors);
  const warnMsg =
    missingIds.length === 1
      ? `Стиль «${missingIds[0]}» удалён, применены остальные`
      : "Некоторые стили удалены, применены остальные";
  setters.toastWarn(warnMsg);
}
