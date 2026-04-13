/**
 * In-flight upload control registry. Callbacks aren't serializable and
 * don't belong on the HistoryEntry data record. Module-private to lib/history.
 */

interface PendingControls {
  retry?: () => void;
  abort?: () => void;
}

const map = new Map<string, PendingControls>();

export function setPendingControls(uuid: string, controls: PendingControls): void {
  map.set(uuid, controls);
}

export function getPendingControls(uuid: string): PendingControls | undefined {
  return map.get(uuid);
}

export function clearPendingControls(uuid: string): void {
  map.delete(uuid);
}

/** Test-only: drop everything (e.g. test isolation). */
export function _resetPendingControls(): void {
  map.clear();
}
