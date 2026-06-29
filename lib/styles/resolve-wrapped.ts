import { composeFinalPrompt } from "./inject";
import type { Style } from "./types";

/** Minimal structural shape needed to recompose a wrapped prompt. */
export interface WrappablePrompt {
  prompt?: string;
  userPrompt?: string;
  styleIds?: string[];
}

/**
 * Recompose the wrapped prompt on demand. Post-feature entries carry
 * userPrompt + styleIds and recompose from the CURRENT style catalog
 * (missing ids are dropped). Legacy entries with no userPrompt fall back
 * to the stored wrapped prompt.
 */
export function resolveWrappedPrompt(
  e: WrappablePrompt,
  styles: readonly Style[]
): string {
  if (typeof e.userPrompt === "string") {
    const byId = new Map(styles.map((s) => [s.id, s]));
    const resolved = (e.styleIds ?? [])
      .map((id) => byId.get(id))
      .filter((s): s is Style => s !== undefined);
    return composeFinalPrompt(e.userPrompt, resolved);
  }
  return e.prompt ?? "";
}

/** Fingerprint of applied styles at generation time, for edit detection. */
export function styleVersionsOf(styles: readonly Style[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const s of styles) out[s.id] = s.updatedAt;
  return out;
}
