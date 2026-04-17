import { softTrim } from "./inject";
import type { Style } from "./types";

export interface PreviewBlock {
  kind: "prefix" | "suffix" | "prompt";
  styleId?: string;
  styleName?: string;
  colorIndex?: number;
  text: string;
}

export const STYLE_COLORS = [
  "bg-sky-500",
  "bg-violet-500",
  "bg-amber-500",
  "bg-emerald-500",
  "bg-rose-500",
  "bg-indigo-500",
] as const;

export function buildPreviewBlocks(
  prompt: string,
  activeStyles: readonly Style[]
): PreviewBlock[] {
  const blocks: PreviewBlock[] = [];

  for (let i = activeStyles.length - 1; i >= 0; i--) {
    const s = activeStyles[i];
    const trimmed = softTrim(s.prefix ?? "");
    if (/\S/.test(trimmed)) {
      blocks.push({
        kind: "prefix",
        styleId: s.id,
        styleName: s.name,
        colorIndex: i % STYLE_COLORS.length,
        text: trimmed,
      });
    }
  }

  blocks.push({ kind: "prompt", text: prompt });

  activeStyles.forEach((s, i) => {
    const trimmed = softTrim(s.suffix ?? "");
    if (/\S/.test(trimmed)) {
      blocks.push({
        kind: "suffix",
        styleId: s.id,
        styleName: s.name,
        colorIndex: i % STYLE_COLORS.length,
        text: trimmed,
      });
    }
  });

  return blocks;
}
