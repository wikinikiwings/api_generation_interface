import { softTrim } from "./inject";
import { partitionStyles } from "./classify";
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
  const { attachPrefix, wrap, attachSuffix } = partitionStyles(activeStyles);
  const indexOf = new Map(activeStyles.map((s, i) => [s.id, i]));
  const blocks: PreviewBlock[] = [];

  const push = (kind: "prefix" | "suffix", s: Style, raw: string) => {
    blocks.push({
      kind,
      styleId: s.id,
      styleName: s.name,
      colorIndex: (indexOf.get(s.id) ?? 0) % STYLE_COLORS.length,
      text: softTrim(raw),
    });
  };

  for (const s of attachPrefix) push("prefix", s, s.prefix);
  for (const s of wrap) push("prefix", s, s.prefix);
  blocks.push({ kind: "prompt", text: prompt });
  for (let i = wrap.length - 1; i >= 0; i--) push("suffix", wrap[i], wrap[i].suffix);
  for (const s of attachSuffix) push("suffix", s, s.suffix);

  return blocks;
}
