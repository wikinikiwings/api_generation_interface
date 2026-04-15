import { DEFAULT_STYLE_ID, type Style } from "./types";

export interface CopiedEntry {
  /** The wrapped prompt as stored. Always present. */
  prompt: string;
  /** Clean user-authored part if the entry was generated post-feature. */
  userPrompt?: string;
  /** Id of the style applied at generation, or undefined on pre-feature entries. */
  styleId?: string;
}

export interface ApplyCopiedSetters {
  setPrompt: (s: string) => void;
  setSelectedStyleId: (id: string) => void;
  toastInfo: (msg: string) => void;
  toastWarn: (msg: string) => void;
}

/**
 * Four branches:
 *   1. Pre-feature (no styleId) — paste entry.prompt, leave dropdown alone.
 *   2. Default style — paste clean userPrompt, reset dropdown to default.
 *   3. Existing style — paste clean userPrompt, set dropdown, toast style name.
 *   4. Deleted style — paste wrapped entry.prompt, reset dropdown, warn.
 */
export function applyCopiedPrompt(
  entry: CopiedEntry,
  styles: readonly Style[],
  setters: ApplyCopiedSetters
): void {
  if (entry.styleId === undefined) {
    setters.setPrompt(entry.prompt);
    setters.toastInfo("Промпт скопирован");
    return;
  }

  if (entry.styleId === DEFAULT_STYLE_ID) {
    setters.setPrompt(entry.userPrompt ?? entry.prompt);
    setters.setSelectedStyleId(DEFAULT_STYLE_ID);
    setters.toastInfo("Промпт скопирован");
    return;
  }

  const existing = styles.find((s) => s.id === entry.styleId);
  if (existing) {
    setters.setPrompt(entry.userPrompt ?? entry.prompt);
    setters.setSelectedStyleId(entry.styleId);
    setters.toastInfo(`Промпт скопирован, стиль «${existing.name}» применён`);
    return;
  }

  setters.setPrompt(entry.prompt);
  setters.setSelectedStyleId(DEFAULT_STYLE_ID);
  setters.toastWarn("Стиль больше не существует, промпт вставлен как есть");
}
