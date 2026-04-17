import { type Style } from "./types";

/**
 * Strip horizontal whitespace (spaces, tabs) at string edges and around
 * every newline, but preserve the newlines themselves. This gives the
 * admin vertical-spacing control via Shift+Enter in the textarea while
 * still cleaning up stray spaces/tabs from copy-paste or accidental keys.
 */
export function softTrim(s: string): string {
  return s
    .replace(/^[ \t]+/, "")
    .replace(/[ \t]+$/, "")
    .replace(/[ \t]*\n[ \t]*/g, "\n");
}

/**
 * Compose the final prompt sent to the generation API by wrapping the
 * user's prompt with the selected styles' prefixes and suffixes.
 *
 * Matryoshka layout for activeStyles = [s1, s2, s3]:
 *
 *   p3             <— outermost (last clicked)
 *
 *   p2
 *
 *   p1             <— innermost (first clicked, closest to user prompt)
 *   userPrompt     <— single newline around user prompt
 *   s1             <— innermost (first clicked, closest to user prompt)
 *
 *   s2
 *
 *   s3             <— outermost (last clicked)
 *
 * activeStyles[0] is the innermost style (its prefix renders immediately
 * before userPrompt; its suffix immediately after). activeStyles[N-1]
 * is the outermost style. Click order on the form determines this:
 * first click = directly wraps the prompt, subsequent clicks add outer
 * layers. Interior newlines inside a single part are preserved, and
 * admin-authored leading/trailing newlines bleed through — they add
 * extra blank lines at the boundary with userPrompt or the next stacked
 * style, which is exactly the control knob Shift+Enter exposes in the
 * admin textarea.
 */
export function composeFinalPrompt(
  userPrompt: string,
  activeStyles: readonly Style[]
): string {
  if (activeStyles.length === 0) return userPrompt;

  const prefixes = [...activeStyles]
    .reverse()
    .map((s) => softTrim(s.prefix ?? ""))
    .filter((p) => /\S/.test(p));

  const suffixes = activeStyles
    .map((s) => softTrim(s.suffix ?? ""))
    .filter((s) => /\S/.test(s));

  if (prefixes.length === 0 && suffixes.length === 0) return userPrompt;

  const segments: string[] = [];
  if (prefixes.length > 0) segments.push(prefixes.join("\n\n"));
  segments.push(userPrompt);
  if (suffixes.length > 0) segments.push(suffixes.join("\n\n"));
  return segments.join("\n");
}
