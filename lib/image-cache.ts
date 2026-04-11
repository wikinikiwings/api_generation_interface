/**
 * Tiny in-memory image preload + dedup cache.
 *
 * Goals:
 *  - Avoid re-firing <img> network requests for URLs we've already warmed.
 *  - Dedup concurrent preload calls for the same URL (shared Promise).
 *  - Cap memory with a simple FIFO ring so long sessions don't leak.
 *
 * This is a pure browser-side helper; calling it during SSR is a no-op.
 */

const MAX_ENTRIES = 256;

const loaded = new Set<string>();
const inflight = new Map<string, Promise<void>>();
const order: string[] = [];

function remember(url: string) {
  if (loaded.has(url)) return;
  loaded.add(url);
  order.push(url);
  while (order.length > MAX_ENTRIES) {
    const evict = order.shift();
    if (evict) loaded.delete(evict);
  }
}

/**
 * Kick off a background load for a single image URL. Safe to call many
 * times with the same URL — subsequent calls reuse the in-flight Promise
 * or resolve instantly if already cached.
 */
export function preloadImage(url: string): Promise<void> {
  if (typeof window === "undefined" || !url) return Promise.resolve();
  if (loaded.has(url)) return Promise.resolve();
  const existing = inflight.get(url);
  if (existing) return existing;

  const p = new Promise<void>((resolve) => {
    const img = new Image();
    img.onload = () => {
      remember(url);
      inflight.delete(url);
      resolve();
    };
    img.onerror = () => {
      // Don't cache failures — let the real <img> element retry and show
      // whatever fallback the caller wires up via onError.
      inflight.delete(url);
      resolve();
    };
    img.src = url;
  });
  inflight.set(url, p);
  return p;
}

/** Batch variant — fire-and-forget preload for a list of URLs. */
export function preloadImages(urls: Array<string | null | undefined>): void {
  for (const u of urls) {
    if (u) void preloadImage(u);
  }
}

/** For tests / manual cache busts. */
export function clearImageCache(): void {
  loaded.clear();
  inflight.clear();
  order.length = 0;
}

export function isImageCached(url: string): boolean {
  return loaded.has(url);
}
