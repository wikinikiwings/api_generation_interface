import { DEFAULT_STYLE_ID, type Style } from "./types";

/**
 * Compose the final prompt sent to the generation API by wrapping the
 * user's prompt with the selected style's prefix and suffix. Empty parts
 * contribute no separator.
 *
 * Rules:
 *   - `null` style or the synthetic default → return userPrompt unchanged.
 *   - prefix/suffix are trimmed only at compose time (so trailing newlines
 *     from the admin textarea don't break the ". " separator); interior
 *     newlines are preserved.
 *   - Separator is the literal two characters ". " (period + space).
 */
export function composeFinalPrompt(
  userPrompt: string,
  style: Style | null
): string {
  if (!style || style.id === DEFAULT_STYLE_ID) return userPrompt;
  const prefix = (style.prefix ?? "").trim();
  const suffix = (style.suffix ?? "").trim();
  if (!prefix && !suffix) return userPrompt;
  const parts: string[] = [];
  if (prefix) parts.push(prefix);
  parts.push(userPrompt);
  if (suffix) parts.push(suffix);
  return parts.join(". ");
}
