/**
 * In-memory singleton of pending (not-yet-server-confirmed) history
 * generations. Read by useHistory and rendered in the history sidebar
 * alongside server rows, so a freshly-completed generation shows up
 * as a card within milliseconds — before the /api/history POST has
 * even finished.
 *
 * A pending entry is shaped to closely mirror ServerGeneration so the
 * sidebar card component can render either with minimal branching.
 * The key difference: pending entries carry blob: URLs (not server
 * /api/history/image/ URLs) and a `pending: true` marker.
 *
 * Lifecycle:
 *   addPending(uuid, gen)       → visible in sidebar
 *   markError(uuid, msg)        → error badge + retry UI
 *   confirmPending(uuid)        → removed (server refresh will show
 *                                 the real row), blob URLs revoked
 *                                 after a short grace window
 */

import type { ServerGeneration } from "@/hooks/use-history";

export interface PendingGeneration extends ServerGeneration {
  pending: true;
  uuid: string;
  thumbBlobUrl: string;
  midBlobUrl: string;
  fullBlobUrl: string;
  uploadError?: string;
  /**
   * Captures the inputs needed to retry the upload without the caller
   * having to re-run variant generation. The retry handler in
   * generate-form.tsx calls this function.
   */
  retry?: () => void;
}

type Listener = () => void;

const map = new Map<string, PendingGeneration>();
const listeners = new Set<Listener>();

const REVOKE_DELAY_MS = 2000;

function emit() {
  for (const l of listeners) l();
}

export function subscribe(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getAll(): PendingGeneration[] {
  // Newest first, matching server-history ordering.
  return Array.from(map.values()).sort(
    (a, b) => Date.parse(b.created_at) - Date.parse(a.created_at)
  );
}

export function addPending(entry: PendingGeneration): void {
  map.set(entry.uuid, entry);
  emit();
}

export function markError(uuid: string, message: string): void {
  const cur = map.get(uuid);
  if (!cur) return;
  map.set(uuid, { ...cur, uploadError: message });
  emit();
}

export function clearError(uuid: string): void {
  const cur = map.get(uuid);
  if (!cur || !cur.uploadError) return;
  const { uploadError: _removed, ...rest } = cur;
  void _removed;
  map.set(uuid, rest as PendingGeneration);
  emit();
}

/**
 * Mark an entry as server-confirmed. The entry is removed from the
 * pending map immediately (the sidebar will switch to showing the
 * server row on next refresh), and its blob URLs are revoked after
 * a short grace window so in-flight <img> elements aren't torn down
 * before the swap completes.
 */
export function confirmPending(uuid: string): void {
  const cur = map.get(uuid);
  if (!cur) return;
  map.delete(uuid);
  emit();
  scheduleRevoke([cur.thumbBlobUrl, cur.midBlobUrl, cur.fullBlobUrl]);
}

/** Remove a pending entry without grace-period revocation (user-deleted). */
export function removePending(uuid: string): void {
  const cur = map.get(uuid);
  if (!cur) return;
  map.delete(uuid);
  emit();
  revoke([cur.thumbBlobUrl, cur.midBlobUrl, cur.fullBlobUrl]);
}

function scheduleRevoke(urls: string[]): void {
  if (typeof window === "undefined") return;
  const run = () => revoke(urls);
  const ric = (window as unknown as { requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number })
    .requestIdleCallback;
  if (ric) {
    ric(run, { timeout: REVOKE_DELAY_MS + 1000 });
  } else {
    setTimeout(run, REVOKE_DELAY_MS);
  }
}

function revoke(urls: string[]): void {
  for (const u of urls) {
    if (!u || !u.startsWith("blob:")) continue;
    try {
      URL.revokeObjectURL(u);
    } catch {
      // Already revoked — ignore.
    }
  }
}

/** Test/debug: drop all pending without revocation (e.g. HMR reset). */
export function _resetForTest(): void {
  map.clear();
  listeners.clear();
}
