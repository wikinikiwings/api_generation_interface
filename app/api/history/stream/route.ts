import { type NextRequest, NextResponse } from "next/server";
import { addSubscriber, removeSubscriber } from "@/lib/sse-broadcast";

// SSE connections are long-lived. maxDuration at 5 minutes keeps them
// tidy under proxy timeouts and forces a periodic reconnect even in
// the absence of network issues — which is good hygiene.
export const maxDuration = 300;

// Disable Next.js response caching for this route. SSE responses must
// never be cached; setting dynamic = 'force-dynamic' tells Next.js to
// always render fresh.
export const dynamic = "force-dynamic";

/**
 * GET /api/history/stream?username=X
 *
 * Opens an SSE stream of history events scoped to the given username.
 * Emits:
 *   event: generation.created   data: { ...ServerGeneration }
 *   event: generation.deleted   data: { id: number }
 *
 * Plus periodic `: heartbeat` comments to keep proxy connections warm.
 */
export async function GET(request: NextRequest) {
  const username = request.nextUrl.searchParams.get("username");
  if (!username) {
    return NextResponse.json({ error: "username is required" }, { status: 400 });
  }

  let unsubscribe: (() => void) | null = null;

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      // TODO(plan-7.5): replace with user.id from getCurrentUser when this route is auth-gated
      const placeholder = -1;
      const entry = addSubscriber(placeholder, controller);
      unsubscribe = () => removeSubscriber(placeholder, entry);
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
