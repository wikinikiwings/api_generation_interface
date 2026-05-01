/**
 * In-memory SSE subscriber registry.
 *
 * Holds per-user_id sets of ReadableStreamDefaultController so that
 * `broadcastToUserId` can enqueue events to every connected client for
 * that user_id.
 *
 * Single-process only. For multi-instance deployment this would need
 * to be backed by Redis pub/sub (see spec Future Work).
 */

type Controller = ReadableStreamDefaultController<Uint8Array>;

interface Subscriber {
  controller: Controller;
  /** Per-connection heartbeat timer, cleared on unsubscribe. */
  heartbeat: ReturnType<typeof setInterval> | null;
}

export type SseEvent =
  | { type: "generation.created"; data: any }
  | { type: "generation.deleted"; data: { id: number } }
  | { type: "quota_updated" }
  | { type: "user_banned" }
  | { type: "user_role_changed" }
  // Admin-only fan-out: emitted whenever ANY user successfully creates
  // a generation. Admins listen to refresh aggregate views (Users tab
  // counts, Models tab counts) in real time. Carries the originating
  // user_id so future admin views can target updates if needed.
  | { type: "admin.user_generated"; data: { user_id: number } };

// Stashed on globalThis so Next.js HMR (dev) and any future module
// hot-reload path in prod don't wipe the registration table while
// clients still have open EventSource connections. Without this, edits
// to server files during `npm run dev` silently break cross-tab sync:
// the new module sees an empty Map and `broadcastToUserId` enqueues
// nothing, but the old TCP connections stay half-open until the client
// watchdog (see lib/history/sse.ts) force-reconnects.
const globalForSubscribers = globalThis as unknown as {
  __sseSubscribers?: Map<number, Set<Subscriber>>;
};
const subscribers: Map<number, Set<Subscriber>> =
  globalForSubscribers.__sseSubscribers ?? new Map<number, Set<Subscriber>>();
globalForSubscribers.__sseSubscribers = subscribers;

const encoder = new TextEncoder();

const HEARTBEAT_MS = 25_000;

/**
 * Serialize a named SSE event. The `id:` line is advisory (we do not
 * implement ring-buffer catch-up; on reconnect the client refetches).
 */
function serialize(event: string, data: unknown): Uint8Array {
  const payload =
    `event: ${event}\n` +
    `data: ${JSON.stringify(data)}\n` +
    `\n`;
  return encoder.encode(payload);
}

function serializeComment(text: string): Uint8Array {
  return encoder.encode(`: ${text}\n\n`);
}

export function addSubscriber(
  user_id: number,
  controller: Controller
): Subscriber {
  const entry: Subscriber = { controller, heartbeat: null };
  let set = subscribers.get(user_id);
  if (!set) {
    set = new Set();
    subscribers.set(user_id, set);
  }
  set.add(entry);

  // Initial comment so the client knows the stream is live.
  try {
    controller.enqueue(serializeComment("connected"));
  } catch {
    // If even the first enqueue fails the client has gone away mid-open.
    // Remove immediately.
    set.delete(entry);
    if (set.size === 0) subscribers.delete(user_id);
    return entry;
  }

  entry.heartbeat = setInterval(() => {
    try {
      // Named event (not a `:` comment) so the client's EventSource
      // fires a JS listener and the watchdog can observe liveness.
      // Comments keep the TCP connection warm but never reach the JS
      // layer, so a silent half-open (HMR-wiped registry, proxy idle,
      // laptop sleep) would otherwise look identical to a live stream.
      controller.enqueue(serialize("heartbeat", { t: Date.now() }));
    } catch {
      // Controller is closed. The cancel() path on the route handler
      // will also remove us; this is defensive.
      removeSubscriber(user_id, entry);
    }
  }, HEARTBEAT_MS);

  return entry;
}

export function removeSubscriber(
  user_id: number,
  entry: Subscriber
): void {
  const set = subscribers.get(user_id);
  if (!set) return;
  set.delete(entry);
  if (set.size === 0) subscribers.delete(user_id);
  if (entry.heartbeat) {
    clearInterval(entry.heartbeat);
    entry.heartbeat = null;
  }
  try {
    entry.controller.close();
  } catch {
    // Already closed.
  }
}

/**
 * Fan out an event to every connected client for this user_id.
 * Dead controllers (enqueue throws) are removed from the registry.
 */
export function broadcastToUserId(
  user_id: number,
  ev: SseEvent
): void {
  const set = subscribers.get(user_id);
  if (!set || set.size === 0) return;
  const bytes = serialize(ev.type, "data" in ev ? ev.data : undefined);
  const dead: Subscriber[] = [];
  for (const sub of set) {
    try {
      sub.controller.enqueue(bytes);
    } catch {
      dead.push(sub);
    }
  }
  for (const d of dead) removeSubscriber(user_id, d);
}

/** Test / debug hook. */
export function _subscriberCount(user_id: number): number {
  return subscribers.get(user_id)?.size ?? 0;
}
