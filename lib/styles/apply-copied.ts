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

/**
 * Four branches:
 *   1. Pre-feature (styleIds undefined) — paste entry.prompt, leave
 *      selection alone, "Промпт скопирован".
 *   2. Default (styleIds === []) — paste clean userPrompt, clear
 *      selection, "Промпт скопирован".
 *   3. All ids resolve — paste clean userPrompt, set selection to the
 *      stored ids, toast with joined names.
 *   4. At least one id missing — paste wrapped entry.prompt, clear
 *      selection, warn with name of the missing style (or generic plural).
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
    const msg =
      entry.styleIds.length === 1
        ? `Промпт скопирован, стиль «${names}» применён`
        : `Промпт скопирован, стили «${names}» применены`;
    setters.toastInfo(msg);
    return;
  }

  // At least one missing — full fallback (variant A).
  setters.setPrompt(entry.prompt);
  setters.setSelectedStyleIds([]);
  const warnMsg =
    missingIds.length === 1
      ? `Стиль «${missingIds[0]}» удалён, промпт вставлен как есть`
      : "Некоторые стили удалены, промпт вставлен как есть";
  setters.toastWarn(warnMsg);
}
