import { type NextRequest } from "next/server";
import { addSubscriber, removeSubscriber } from "@/lib/sse-broadcast";
import { getCurrentUser } from "@/lib/auth/current-user";
import { getDb } from "@/lib/history-db";
import { SESSION_COOKIE_NAME } from "@/lib/auth/cookie-name";

// SSE connections are long-lived. maxDuration at 5 minutes keeps them
// tidy under proxy timeouts and forces a periodic reconnect even in
// the absence of network issues — which is good hygiene.
export const maxDuration = 300;

// Disable Next.js response caching for this route. SSE responses must
// never be cached; setting dynamic = 'force-dynamic' tells Next.js to
// always render fresh.
export const dynamic = "force-dynamic";

/**
 * GET /api/history/stream
 *
 * Opens an SSE stream of history events scoped to the authenticated user.
 * Auth via session cookie. Subscribes by user.id.
 * Emits:
 *   event: generation.created   data: { ...ServerGeneration }
 *   event: generation.deleted   data: { id: number }
 *
 * Plus periodic `: heartbeat` comments to keep proxy connections warm.
 */
export async function GET(request: NextRequest) {
  const user = getCurrentUser(getDb(), request.cookies.get(SESSION_COOKIE_NAME)?.value ?? null);
  if (!user) {
    return new Response(null, { status: 401 });
  }

  let unsubscribe: (() => void) | null = null;

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const entry = addSubscriber(user.id, controller);
      unsubscribe = () => removeSubscriber(user.id, entry);
      // If the request is aborted before cancel() fires (some runtimes
      // deliver only one of these), clean up here as a fallback.
      request.signal.addEventListener("abort", () => {
        unsubscribe?.();
        unsubscribe = null;
      });
    },
    cancel() {
      unsubscribe?.();
      unsubscribe = null;
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      // Nginx default buffers proxied responses — this header disables
      // that behavior per-response, keeping latency low.
      "X-Accel-Buffering": "no",
    },
  });
}
