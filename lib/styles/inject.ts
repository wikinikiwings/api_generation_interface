import { type Style } from "./types";
import { partitionStyles } from "./classify";

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
 * Compose the final prompt sent to the generation API.
 *
 * Styles are classified by content:
 *   - wrap (both prefix and suffix non-empty) → matryoshka in the middle,
 *     slot-1 outermost, slot-N closest to userPrompt.
 *   - attach-prefix (only prefix non-empty) → stacked above the wrap
 *     prefixes, in click order (first-clicked reads first).
 *   - attach-suffix (only suffix non-empty) → stacked below the wrap
 *     suffixes, in click order (first-clicked reads first).
 *   - empty → dropped.
 *
 * Separator policy is unchanged: "\n\n" between stacked blocks on the
 * same side, "\n" around userPrompt.
 */
export function composeFinalPrompt(
  userPrompt: string,
  activeStyles: readonly Style[]
): string {
  if (activeStyles.length === 0) return userPrompt;

  const { attachPrefix, wrap, attachSuffix } = partitionStyles(activeStyles);

  const topBlocks: string[] = [
    ...attachPrefix.map((s) => softTrim(s.prefix)),
    ...wrap.map((s) => softTrim(s.prefix)),
  ];

  const bottomBlocks: string[] = [
    ...[...wrap].reverse().map((s) => softTrim(s.suffix)),
    ...attachSuffix.map((s) => softTrim(s.suffix)),
  ];

  if (topBlocks.length === 0 && bottomBlocks.length === 0) return userPrompt;

  const segments: string[] = [];
  if (topBlocks.length > 0) segments.push(topBlocks.join("\n\n"));
  segments.push(userPrompt);
  if (bottomBlocks.length > 0) segments.push(bottomBlocks.join("\n\n"));
  return segments.join("\n");
}
