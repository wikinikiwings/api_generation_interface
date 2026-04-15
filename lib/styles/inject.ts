import { type Style } from "./types";

/**
 * Compose the final prompt sent to the generation API by wrapping the
 * user's prompt with the selected styles' prefixes and suffixes.
 *
 * Matryoshka order for activeStyles = [s1, s2, s3]:
 *   p1. p2. p3. userPrompt. s3. s2. s1.
 *
 * s1 is the outermost style — its prefix comes first, its suffix comes
 * last. s(last) is the innermost — prefix closest to the user prompt on
 * the left, suffix closest on the right. Empty parts contribute no
 * separator. prefix/suffix are trimmed at compose time so trailing
 * newlines in the admin textarea don't break the ". " separator.
 */
export function composeFinalPrompt(
  userPrompt: string,
  activeStyles: readonly Style[]
): string {
  if (activeStyles.length === 0) return userPrompt;

  const prefixes = activeStyles
    .map((s) => (s.prefix ?? "").trim())
    .filter((p) => p.length > 0);

  const suffixes = [...activeStyles]
    .reverse()
    .map((s) => (s.suffix ?? "").trim())
    .filter((s) => s.length > 0);

  if (prefixes.length === 0 && suffixes.length === 0) return userPrompt;

  return [...prefixes, userPrompt, ...suffixes].join(". ");
}
