# Service-Worker image cache — future reference

**Status:** Deferred (not implemented). Keep for when disk-persistent history-image cache becomes worth the infrastructure.

**Date:** 2026-04-12

## Context

The history-thumbnail-first work (`2026-04-12-history-thumbnail-first-design.md`) and follow-up in-memory blob cache (shipped in `lib/image-cache.ts`) addressed two perceived-latency issues:

1. Sidebar card appearing after Output → fixed via skeleton + optimistic pending.
2. First/subsequent clicks on history images loading slowly when DevTools "Disable cache" is on → fixed via in-memory blob cache in `lib/image-cache.ts` for the current session.

What the in-memory cache does NOT solve:

- **Persistence across reload.** On page refresh, the Map is gone; all images re-fetch from `/api/history/image/*`. Browser HTTP cache normally handles this, but only when DevTools is not actively disabling cache.
- **Persistence across browser restart.** Same as above.
- **Cross-origin resilience** (future-proofing if images ever move to a CDN with tighter CORS).

A Service Worker sitting in front of `/api/history/image/*` would solve all three. Disk-backed via CacheStorage API, survives reload, and — critically — **DevTools "Disable cache" does NOT bypass service-worker `fetch` interception** (documented Chrome behavior: SW hits count as network from the page's POV, but intra-SW Cache Storage lookups are not gated by the Disable cache toggle).

## Proposed architecture

### Scope

Intercept only `/api/history/image/*` requests. Everything else (API routes, page HTML, Next.js chunks) passes through unchanged.

### Cache strategy

**Cache-first with lazy revalidation** (stale-while-revalidate for image files):
1. SW receives fetch for `/api/history/image/mid_<uuid>.jpg`.
2. Looks up CacheStorage (named `history-images-v1`).
3. If hit → return cached response immediately.
4. In parallel, `fetch(request)` to network. On success, update cache.
5. If miss → `fetch(request)` normally. On success, add to cache. Return response.

For history-image files, the URLs are immutable by UUID: `mid_<uuid>.jpg` always refers to the same bytes. So cache-first is strictly correct — we never need to "bust" an existing entry. Revalidation is only for self-healing if the file changes on disk (which shouldn't happen in practice).

Alternative: pure **cache-first with no revalidation** for simplicity. If bytes change (they shouldn't), a hard reload clears the cache.

### Versioning

Cache name includes a version suffix (`history-images-v1`). When the SW script updates with a new version, the `activate` event enumerates all cache names and deletes old ones. This is standard SW hygiene.

### Installation

`public/sw.js` lives at the origin root. Registered at app startup from a client component:

```ts
if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("/sw.js").catch(console.error);
}
```

Next.js serves files from `public/` at the root — no build-step wiring needed.

### Dev-mode concerns

- **HMR interaction.** SW caches network responses; Next.js dev sends fresh JS/CSS chunks on every HMR update. If the SW cached an old chunk URL we'd be serving stale JS. Mitigation: scope SW to `/api/history/image/*` ONLY. Never intercept `/_next/` or anything under `/api/` that isn't image. The `fetch` handler's first line checks `url.pathname.startsWith("/api/history/image/")` — everything else passes through untouched.
- **Testing flows.** While developing, it can be useful to disable the SW entirely. Add a dev-only bypass: if `window.localStorage.getItem("SW_DISABLE") === "1"`, unregister existing SW on page load and skip registration. Document this in `README.md` or a dev-tips file.
- **Cache bloat while iterating on `mid_*.jpg` format changes** (e.g. switching from JPEG q85 to WebP). Since the URL is keyed by UUID, not by content, changing the encoding without bumping the filename would leave SW-cached old bytes. Mitigation: bump the `history-images-v<N>` cache name on any server-side format change. Simple — just change the version suffix in `sw.js`.

### Error handling

- SW installation failure: registration rejects, we log and continue. App works without SW, just slower when DevTools disables cache.
- CacheStorage quota exceeded: very unlikely with history sizes under ~100 MB. If it happens, SW falls back to network-only.
- Corrupt cache entry: response streaming error during cache.put → swallow the error, network path already returned successfully.

## Tradeoffs vs. current in-memory cache

|  | In-memory (shipped) | Service Worker |
|---|---|---|
| Setup complexity | ~150 LOC in one file | SW script + registration + versioning + bypass flag |
| Memory usage | Up to ~17 MB blob URLs in RAM | Uses disk (CacheStorage quota) |
| Persistence | Session-only (dies on reload) | Survives reload, browser restart |
| Dev-mode comfort | Simple, no HMR concerns | Requires careful scoping |
| DevTools "Disable cache" | Bypassed (blob: URLs) | Bypassed (SW intercept) |
| First-click latency | Network (unless seeded) | Network (unless seeded) |
| Repeat-click latency | Instant | Instant |

## When to revisit

Implement the Service Worker when any of these become true:

- History regularly exceeds 500 entries, making session-only cache inadequate (RAM footprint too large).
- Users complain about slow reloads (image re-fetch blocking interaction).
- We add offline mode as a feature.
- CDN migration introduces CORS or latency concerns that an SW could smooth.

Until then, the in-memory cache in `lib/image-cache.ts` is sufficient.

## Implementation sketch (for when the time comes)

1. Create `public/sw.js` with `install` / `activate` / `fetch` event handlers scoped to `/api/history/image/*`.
2. Register the SW in a client component (e.g. `app/layout.tsx` or a dedicated `<ServiceWorkerRegister />` component).
3. Add dev-mode bypass flag (`SW_DISABLE` localStorage key).
4. Ensure cache name versioning hygiene in `activate` event.
5. Add a `README.md` section documenting the dev bypass flag.
6. Test: generate images, reload page, verify network tab shows `(ServiceWorker)` in the Size column.

No changes needed to `lib/image-cache.ts` or any React components — SW is transparent to application code. The in-memory cache can coexist (both fire on the same `fetch`, SW wins for persistence, in-memory wins for seeded entries and React state wiring).

## References

- MDN: [Using Service Workers](https://developer.mozilla.org/en-US/docs/Web/API/Service_Worker_API/Using_Service_Workers)
- MDN: [Cache interface](https://developer.mozilla.org/en-US/docs/Web/API/Cache)
- Workbox (library that makes cache-first / stale-while-revalidate trivial): <https://developer.chrome.com/docs/workbox>

---

*Author: implemented as part of the history-thumbnail-first follow-up discussion on 2026-04-12. See conversation history for full context.*
