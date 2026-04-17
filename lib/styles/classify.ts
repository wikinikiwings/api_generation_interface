import { softTrim } from "./inject";
import type { Style } from "./types";

export type StyleZone =
  | "wrap"
  | "attach-prefix"
  | "attach-suffix"
  | "empty";

export interface PartitionedStyles {
  attachPrefix: Style[];
  wrap: Style[];
  attachSuffix: Style[];
}

export function classifyStyle(style: Style): StyleZone {
  const hasP = /\S/.test(softTrim(style.prefix ?? ""));
  const hasS = /\S/.test(softTrim(style.suffix ?? ""));
  if (hasP && hasS) return "wrap";
  if (hasP) return "attach-prefix";
  if (hasS) return "attach-suffix";
  return "empty";
}

export function partitionStyles(
  styles: readonly Style[]
): PartitionedStyles {
  const out: PartitionedStyles = {
    attachPrefix: [],
    wrap: [],
    attachSuffix: [],
  };
  for (const s of styles) {
    const z = classifyStyle(s);
    if (z === "attach-prefix") out.attachPrefix.push(s);
    else if (z === "wrap") out.wrap.push(s);
    else if (z === "attach-suffix") out.attachSuffix.push(s);
    // "empty" is intentionally dropped.
  }
  return out;
}
