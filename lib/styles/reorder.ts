import { arrayMove } from "@dnd-kit/sortable";

/**
 * Pure reorder helper for @dnd-kit's onDragEnd. Returns the new
 * ordered id list, or null when no change should happen (drop
 * outside, dropped on self, or either id missing from the list).
 */
export function reorderStyleIds(
  ids: readonly string[],
  activeId: string,
  overId: string | null
): string[] | null {
  if (!overId || activeId === overId) return null;
  const oldIdx = ids.indexOf(activeId);
  const newIdx = ids.indexOf(overId);
  if (oldIdx === -1 || newIdx === -1) return null;
  return arrayMove(ids.slice(), oldIdx, newIdx);
}
