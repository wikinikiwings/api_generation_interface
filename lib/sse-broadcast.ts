/**
 * In-memory SSE subscriber registry.
 *
 * Holds per-username sets of ReadableStreamDefaultController so that
 * `broadcastToUser` can enqueue events to every connected client for
 * that username.
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

const subscribers = new Map<string, Set<Subscriber>>();

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
  username: string,
  controller: Controller
): Subscriber {
  const entry: Subscriber = { controller, heartbeat: null };
  let set = subscribers.get(username);
  if (!set) {
    set = new Set();
    subscribers.set(username, set);
  }
  set.add(entry);

  // Initial comment so the client knows the stream is live.
  try {
    controller.enqueue(serializeComment("connected"));
  } catch {
    // If even the first enqueue fails the client has gone away mid-open.
    // Remove immediately.
    set.delete(entry);
    if (set.size === 0) subscribers.delete(username);
    return entry;
  }

  entry.heartbeat = setInterval(() => {
    try {
      controller.enqueue(serializeComment("heartbeat"));
    } catch {
      // Controller is closed. The cancel() path on the route handler
      // will also remove us; this is defensive.
      removeSubscriber(username, entry);
    }
  }, HEARTBEAT_MS);

  return entry;
}

export function removeSubscriber(
  username: string,
  entry: Subscriber
): void {
  const set = subscribers.get(username);
  if (!set) return;
  set.delete(entry);
  if (set.size === 0) subscribers.delete(username);
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
 * Fan out an event to every connected client for this username.
 * Dead controllers (enqueue throws) are removed from the registry.
 */
export function broadcastToUser(
  username: string,
  event: { type: string; data: unknown }
): void {
  const set = subscribers.get(username);
  if (!set || set.size === 0) return;
  const bytes = serialize(event.type, event.data);
  const dead: Subscriber[] = [];
  for (const sub of set) {
    try {
      sub.controller.enqueue(bytes);
    } catch {
      dead.push(sub);
    }
  }
  for (const d of dead) removeSubscriber(username, d);
}

/** Test / debug hook. */
export function _subscriberCount(username: string): number {
  return subscribers.get(username)?.size ?? 0;
}
