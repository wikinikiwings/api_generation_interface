/**
 * Image preload + in-memory blob-URL cache.
 *
 * Two tiers:
 *   1. `loaded` set (legacy) — tracks URLs already fetched via <Image>,
 *      just for dedup on subsequent preload calls. Carries no bytes.
 *   2. `blobCache` Map — url → blob: URL. The bytes live here. Any
 *      caller that uses a blob URL from this cache renders from memory
 *      (no network), which bypasses DevTools "Disable cache" and gives
 *      instant display for previously-viewed images.
 *
 * Memory: blob URLs never auto-evict. History rarely exceeds 100 entries,
 * and thumb+mid are ~15KB+150KB each → worst case ~17 MB total. Acceptable.
 * On full reload the map resets.
 */

import * as React from "react";

const MAX_ENTRIES = 256;

const loaded = new Set<string>();
const inflight = new Map<string, Promise<void>>();
const order: string[] = [];

const blobCache = new Map<string, string>(); // url → blob: URL
const inflightBlob = new Map<string, Promise<string>>();
const listeners = new Set<(url: string, blobUrl: string) => void>();

function remember(url: string) {
  if (loaded.has(url)) return;
  loaded.add(url);
  order.push(url);
  while (order.length > MAX_ENTRIES) {
    const evict = order.shift();
    if (evict) loaded.delete(evict);
  }
}

function notify(url: string, blobUrl: string) {
  for (const l of listeners) l(url, blobUrl);
}

/**
 * Subscribe to cache-populated events. Fires when a URL transitions
 * from "not cached" to "cached". Used by `useCachedImage` to re-render
 * components waiting on a specific URL.
 */
function subscribe(listener: (url: string, blobUrl: string) => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Synchronous lookup. Returns the blob URL if cached, else null. */
export function getCachedBlobUrl(url: string): string | null {
  return blobCache.get(url) ?? null;
}

/**
 * Seed the cache with a known Blob under the given URL key. Used after
 * successful POST /api/history — we already have the exact bytes on the
 * client, so we pre-populate the cache and skip the first-click round-
 * trip entirely for freshly-generated images.
 *
 * No-op if `url` is already cached.
 */
export function cacheBlob(url: string, blob: Blob): string {
  const existing = blobCache.get(url);
  if (existing) return existing;
  const obj = URL.createObjectURL(blob);
  blobCache.set(url, obj);
  remember(url);
  notify(url, obj);
  return obj;
}

/**
 * Fetch the URL (if not yet) and cache the resulting bytes as a blob
 * URL. Returns the blob URL. Safe to call many times with the same URL
 * — subsequent calls reuse the cached blob or the in-flight fetch.
 */
export async function fetchAndCache(url: string): Promise<string> {
  if (typeof window === "undefined" || !url) {
    throw new Error("fetchAndCache called in non-browser context");
  }
  const cached = blobCache.get(url);
  if (cached) return cached;
  const existing = inflightBlob.get(url);
  if (existing) return existing;

  const p = (async () => {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`fetch ${url}: HTTP ${res.status}`);
    const blob = await res.blob();
    const obj = URL.createObjectURL(blob);
    blobCache.set(url, obj);
    remember(url);
    notify(url, obj);
    return obj;
  })();
  inflightBlob.set(url, p);
  try {
    return await p;
  } finally {
    inflightBlob.delete(url);
  }
}

/**
 * Kick off a background load for a single image URL. Safe to call many
 * times with the same URL.
 */
export function preloadImage(url: string): Promise<void> {
  if (typeof window === "undefined" || !url) return Promise.resolve();
  if (loaded.has(url) || blobCache.has(url)) return Promise.resolve();
  const existing = inflight.get(url);
  if (existing) return existing;
  // Preloading now populates the blob cache too, so later <img> renders
  // resolve from memory even under DevTools "Disable cache".
  const p = fetchAndCache(url).then(
    () => undefined,
    () => {
      // Don't cache failures — let the real <img> element retry and
      // show whatever fallback the caller wires up via onError.
      inflight.delete(url);
    }
  );
  inflight.set(url, p);
  return p;
}

/** Batch variant — fire-and-forget preload for a list of URLs. */
export function preloadImages(urls: Array<string | null | undefined>): void {
  for (const u of urls) {
    if (u) void preloadImage(u);
  }
}

/** For tests / manual cache busts. Revokes blob URLs too. */
export function clearImageCache(): void {
  for (const obj of blobCache.values()) {
    try {
      URL.revokeObjectURL(obj);
    } catch {
      // ignore
    }
  }
  blobCache.clear();
  inflightBlob.clear();
  loaded.clear();
  inflight.clear();
  order.length = 0;
}

export function isImageCached(url: string): boolean {
  return loaded.has(url) || blobCache.has(url);
}

/**
 * Hook: returns the cached blob URL for `url`, or null if not yet
 * cached. If `url` is not cached, kicks off an async fetch and re-
 * renders the caller once the blob URL is ready.
 *
 * Typical usage: `<img src={useCachedImage(serverUrl) ?? serverUrl}>`
 * — falls back to the direct URL while cache warms, swaps to blob URL
 * the moment cache populates.
 */
export function useCachedImage(url: string | null | undefined): string | null {
  const [blobUrl, setBlobUrl] = React.useState<string | null>(() =>
    url ? getCachedBlobUrl(url) : null
  );

  React.useEffect(() => {
    if (!url) {
      setBlobUrl(null);
      return;
    }
    const cached = getCachedBlobUrl(url);
    if (cached) {
      setBlobUrl(cached);
      return;
    }
    setBlobUrl(null);

    // Subscribe FIRST so we don't miss the cache-populate event that
    // might fire between our initial getCachedBlobUrl check and the
    // fetchAndCache call below. The listener filter checks the url so
    // only our URL's populate event updates our state.
    let cancelled = false;
    const unsub = subscribe((cachedUrl, cachedBlobUrl) => {
      if (cancelled) return;
      if (cachedUrl === url) setBlobUrl(cachedBlobUrl);
    });

    void fetchAndCache(url).catch(() => {
      // Fetch failed — blobUrl stays null, caller's fallback handles it.
    });

    return () => {
      cancelled = true;
      unsub();
    };
  }, [url]);

  return blobUrl;
}
