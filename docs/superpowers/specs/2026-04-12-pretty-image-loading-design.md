# Pretty Image Loading — Design

**Date:** 2026-04-12
**Status:** Approved for implementation planning
**Related:** `2026-04-12-history-thumbnail-first-design.md` (established `thumb`/`mid`/`full` variant pipeline this design builds on)

## Problem

Image `<img>` rendering in the app currently shows baseline-JPEG "modem decoding" — a sharp line sweeping top-to-bottom as bytes arrive. Visible in:

- **Output strip** right after generation completes (while the provider CDN URL is being fetched+decoded, before blob-URL swap)
- **History sidebar cards** on cold load / scroll-back
- **ImageDialog** on first open and when arrow-navigating between siblings
- **Output strip cross-device** entries (server URLs, not blob URLs)

The variants pipeline (`thumb` 240px / `mid` 1200px / `full`) already produces everything we need — nothing new on the server or network. What we lack is a render component that uses them to stage a smooth reveal instead of letting the browser paint line-by-line.

## Goals

- Replace the line-by-line JPEG paint with a staged reveal: **blurred color backdrop → sharp image "curtain" sweeping top-to-bottom with a feathered edge**
- One reusable component, used consistently in OutputCard, History sidebar card, and ImageDialog
- Respect `prefers-reduced-motion`
- Preserve existing behavior: drag-drop full-res, download full-res, keyboard navigation in dialog, image-cache integration
- Zero server-side changes, zero pipeline changes

## Non-goals

- LQIP / averaged-color pre-paint — future work (detailed below)
- Progressive JPEG encoding — future work (detailed below)
- Service Worker cache — deferred, see `2026-04-12-sw-image-cache-future.md`
- Any change to `lib/image-variants.ts`, `lib/history-upload.ts`, history store, or `/api/history/*`
- Any change to card layout, sizing, or copy

## Key Design Decisions

1. **One new component: `<BlurUpImage />`** in `components/blur-up-image.tsx`. Replaces `<img>` in three call-sites. Knows only how to render a two-layer "backdrop + curtain" reveal.
2. **Animation style: D′ — "curtain with breathing backdrop"** (selected from brainstormed options A/B/C/D/D′ on 2026-04-12).
   - Lower layer: blurred thumb (or `blur(32px)` on sharp URL as fallback) with scale(1.15) and a subtle brightness/saturation "breathing" pulse (2.5s cycle)
   - Upper layer: sharp image with `mask-image: linear-gradient(to bottom, black → transparent)`; the mask's feathered edge (22% of height) sweeps from above the frame to below over ~700ms when sharp's `onLoad` fires
3. **Integrate with existing cache.** `BlurUpImage` internally uses `useCachedImage` on non-blob URLs so call-sites pass logical URLs as-is. This subsumes and removes the per-site `useCachedImage` calls in `components/image-dialog.tsx`.
4. **Thumb URL derivation.** Add `thumbUrl?: string` to `HistoryEntry` (filled in from `generate-form.tsx` and from the `serverToday` mapping in `output-area.tsx`). Fallback helper `thumbUrlForEntry(entry)` derives from `originalUrl`/`outputUrl` for legacy rows. Helper file: `lib/history-urls.ts` (new, small).
5. **Dialog gets a shorter reveal (400ms).** Output/Sidebar use 700ms. Arrow-navigation in Dialog fires reveal per slide — 400ms keeps it from feeling heavy.
6. **Play-once-per-mount semantics.** BlurUpImage plays its reveal exactly once per mount. A ref tracks whether reveal already fired; subsequent `sharpSrc` changes (e.g. the provider-URL → blob-URL swap mid-generation in OutputCard) do NOT replay. Callers that want a fresh reveal on src change (Dialog's arrow-nav) pass a `key` prop so React re-mounts the component.

## Architecture

### Component boundaries

- **`components/blur-up-image.tsx`** (new) — "How to render an image with a staged reveal." Does not know about history, entries, stores.
  - Public API:
    ```ts
    interface BlurUpImageProps {
      sharpSrc: string;
      backdropSrc?: string;
      alt: string;
      className?: string;
      fit?: "contain" | "cover";          // default "contain"
      revealMs?: number;                  // default 700
      draggable?: boolean;
      onDragStart?: React.DragEventHandler<HTMLImageElement>;
      onLoad?: React.ReactEventHandler<HTMLImageElement>;  // forwarded from sharp
      onError?: React.ReactEventHandler<HTMLImageElement>; // forwarded from sharp
    }
    // Declared via React.forwardRef<HTMLImageElement, BlurUpImageProps>
    // so callers (ImageDialog zoom/pan) can ref the sharp <img> directly.
    ```
  - Internal: two `<img>` elements layered absolutely, `useCachedImage` on non-blob URLs, a `sharpLoaded` boolean, a `hasPlayedRef` for play-once-per-mount, and a `reducedMotion` read once at mount.
  - Emits a `data-reveal-state="idle|playing|done"` attribute on the root for test observability.
- **`lib/history-urls.ts`** (new, ~25 LOC) — "How to derive a thumb URL from an entry."
  - Public API: `thumbUrlForEntry(entry: HistoryEntry): string | undefined`
  - Returns `entry.thumbUrl` if present; else derives `thumb_<base>.jpg` from `originalUrl`/`outputUrl`; returns `undefined` for blob-URL-only entries.
- **`components/output-area.tsx`** (modified) — OutputCard's `<img>` → `<BlurUpImage>`. Also fills `thumbUrl` in the `serverToday` mapping (already derived locally, just write it onto the entry).
- **`components/history-sidebar.tsx`** (modified, minimal) — Card `<img>` → `<BlurUpImage sharpSrc={thumbUrl} revealMs={500}>` (no explicit backdrop, component uses fallback).
- **`components/image-dialog.tsx`** (modified) — `ZoomableImage`'s `<img>` → `<BlurUpImage revealMs={400}>`. External `useCachedImage(currentEntry.outputUrl)` call is removed (component does it internally). BlurUpImage `forwardRef`s onto the sharp `<img>` so existing zoom/pan refs keep working. Dialog passes `key={currentEntry.id}` so arrow-nav re-mounts the component and plays a fresh reveal per slide.
- **`components/generate-form.tsx`** (modified, small additions at three insert sites) — when calling `updateHistory` with blob URLs (lines ~306, ~345, ~406), also set `thumbUrl: thumbBlobUrl` / `thumbUrl: res.thumbUrl`.
- **`types/wavespeed.ts`** (modified, 1 field) — add `thumbUrl?: string` to `HistoryEntry`. Legacy entries lack it → helper derives from existing fields.

### Data flow (Output, freshly-generated)

```
t=0     generation status → completed
        outputUrl = provider CDN URL (temporary; swapped to blob later)
        <OutputCard> renders <BlurUpImage
          sharpSrc={outputUrl}
          backdropSrc={undefined}   /* thumb not yet generated */
        />
        Component: backdrop falls back to sharpSrc + blur(32px).
        Both <img> tags begin loading (same URL, cached decode after first).
t=~80   backdrop <img> onLoad → backdrop visible (blurred, breathing)
        sharp <img> onLoad → curtain animation starts (--reveal -25% → 125%)
t=~780  curtain complete → backdrop opacity 0 over 300ms
t=~1080 backdrop removed from paint; only sharp visible
---
[In parallel, createImageVariants is running.]
t=~400  variants done. generate-form calls updateHistory({
          previewUrl: midBlobUrl, originalUrl: fullBlobUrl,
          outputUrl: midBlobUrl, thumbUrl: thumbBlobUrl,
        })
        OutputCard re-renders. BlurUpImage gets new sharpSrc (blob mid).
        Play-once-per-mount: since reveal already completed, new src simply
        takes over as the visible sharp layer with no animation replay.
```

**Why no re-run:** same visual content (provider URL and blob mid are the same bytes), no reason to re-animate. Play-once-per-mount is the simplest rule — no per-src tracking needed. Callers that want per-src reveal pass a `key`.

### Data flow (cross-device / cold history)

```
t=0     Card mounts. sharpSrc=midUrl, backdropSrc=thumbUrl (server URLs).
        useCachedImage warms cache in background; UI falls back to direct URLs.
t=~50   thumb <img> onLoad (small, ~15KB) → backdrop visible with breathing
t=~200  sharp <img> onLoad → curtain animates
t=~900  complete
```

### CSS / animation (conceptual, final file structure decided at implementation)

```css
/* app/globals.css or scoped module */
@property --reveal {
  syntax: '<percentage>';
  inherits: false;
  initial-value: -25%;
}
@keyframes blur-up-breathe {
  0%, 100% { filter: blur(32px) saturate(1.2) brightness(0.95); }
  50%      { filter: blur(30px) saturate(1.4) brightness(1.05); }
}
@keyframes blur-up-curtain {
  from { --reveal: -25%; }
  to   { --reveal: 125%; }
}
.blur-up-root { position: relative; overflow: hidden; }
.blur-up-backdrop {
  position: absolute; inset: 0; width: 100%; height: 100%;
  filter: blur(32px) saturate(1.2) brightness(0.95);
  transform: scale(1.15);
  animation: blur-up-breathe 2.5s ease-in-out infinite;
  transition: opacity 300ms linear;
}
.blur-up-sharp {
  position: absolute; inset: 0; width: 100%; height: 100%;
  mask-image: linear-gradient(to bottom,
    black 0%,
    black calc(var(--reveal, -25%)),
    transparent calc(var(--reveal, -25%) + 22%),
    transparent 100%);
  -webkit-mask-image: linear-gradient(to bottom,
    black 0%,
    black calc(var(--reveal, -25%)),
    transparent calc(var(--reveal, -25%) + 22%),
    transparent 100%);
}
.blur-up-sharp[data-playing="true"] {
  animation: blur-up-curtain var(--reveal-ms, 700ms) cubic-bezier(0.4, 0, 0.2, 1) forwards;
}
.blur-up-sharp[data-playing="done"] { --reveal: 125%; animation: none; }
.blur-up-root[data-reveal-state="done"] .blur-up-backdrop {
  opacity: 0; animation-play-state: paused;
}
@media (prefers-reduced-motion: reduce) {
  .blur-up-backdrop { animation: none; transition: opacity 150ms linear; }
  .blur-up-sharp { mask-image: none; -webkit-mask-image: none; }
}
```

### Timing constants (centralize in `components/blur-up-image.tsx`)

```ts
const REVEAL_MS_DEFAULT = 700;
const REVEAL_MS_DIALOG = 400;
const MASK_FEATHER_PCT = 22;
const BACKDROP_FADE_MS = 300;
const BREATHING_MS = 2500;
const REDUCED_MOTION_CROSSFADE_MS = 150;
```

## Error Handling

| Condition | Behavior |
|---|---|
| `sharpSrc` 404 / network error | `onError` forwarded to call-site. Backdrop stays visible (better than empty). Dialog's existing fallback (`effectiveDownloadUrl`) still works via forwarded error. |
| `backdropSrc` 404 | Silent: component detects via its internal `onError` on the backdrop `<img>`, transitions to fallback mode (`blur(32px)` on `sharpSrc`). No toast. |
| Both fail | Container's existing `bg-muted/30` shows through. Call-site decides UX (Output keeps card with trash button; Dialog shows fallback URL). |
| `@property --reveal` unsupported | `CSS.supports("(--reveal: 0%)")` check; fallback: skip curtain, straight 300ms opacity crossfade backdrop → sharp. |
| `mask-image` unsupported | `CSS.supports("mask-image: linear-gradient(black, black)")`; fallback: same 300ms opacity crossfade. |
| `matchMedia` unavailable (SSR/Node) | Treat as `reducedMotion=false` on first render; re-read after mount. |
| Component unmounts mid-animation | React cleanup handles it; no explicit cancellation needed. |
| Slow sharp load (>5s) | Backdrop + breathing remains indefinitely. No extra spinner, no timeout. |

## Edge Cases

- **Same sharpSrc re-rendered** (e.g. parent re-renders): play-once-per-mount ref prevents re-animation.
- **Provider-URL → blob-URL swap** (local generation): different `sharpSrc`, same mounted component, reveal already played → new src takes over silently.
- **Dialog arrow nav**: `key={currentEntry.id}` forces remount per slide → fresh 400ms reveal each time. Expected.
- **Reload of dialog with same entry**: component mounts fresh; reveal plays once. Fine.
- **Drag-drop from OutputCard**: `draggable`/`onDragStart` forwarded to the sharp `<img>`. Payload carries full-res URL as today.
- **Very small images (<= 240px)**: thumb equals original per `image-variants.ts` `withoutEnlargement` semantics. Backdrop becomes a blurred version of the same bitmap — fine visually.

## Testing

### Unit

- `lib/history-urls.ts::thumbUrlForEntry`
  - Entry with `thumbUrl` set → returns it
  - Entry with blob `outputUrl` only → `undefined`
  - Entry with server `originalUrl` → derives `thumb_<uuid>.jpg`
  - Entry with neither → `undefined`
- `components/blur-up-image.tsx` (RTL)
  - Mount with both URLs → two `<img>` elements rendered
  - Mount without `backdropSrc` → backdrop uses `sharpSrc` + blur class
  - `sharp.onLoad` fires → root `data-reveal-state` transitions `idle` → `playing`
  - After `revealMs` → `data-reveal-state="done"` (use `act` + fake timers)
  - `reducedMotion=true` → no `blur-up-breathe` animation class; 150ms crossfade only
  - Same-mount `sharpSrc` change after first play → remains in `done` state (no re-animation)
  - Remount (new `key`) after first play → reveal plays again
  - `onError` on sharp is forwarded to the caller's handler
  - Mock `useCachedImage` to verify: blob: URLs bypass; server URLs pass through

### Integration (manual checklist for PR)

- [ ] Generate a new image → curtain visible in Output, no modem
- [ ] Open a fresh window → reload → cross-device entries render with curtain
- [ ] Open ImageDialog → arrow through 5+ siblings → each reveal ~400ms, not cumulative
- [ ] Enable `prefers-reduced-motion` (DevTools → Rendering) → straight crossfade, no curtain
- [ ] Throttle to "Slow 4G" → backdrop visible during wait; curtain fires when sharp loads
- [ ] Drag a card from Output onto the dropzone → full-res URL transferred (regression guard)
- [ ] Download button on Output card → full-res file (regression guard)
- [ ] DevTools "Disable cache" → image-cache still bypasses (regression guard)
- [ ] Light + dark themes → no color artifacts in backdrop fallback

### Success criteria

- No line-by-line paint visible in any of the three call-sites on cold or warm load
- Under `prefers-reduced-motion: reduce`, animation total ≤ 150ms
- Bundle size increase ≤ 2 KB gzipped
- No visible flash when `outputUrl` swaps from provider URL to blob mid URL
- Dialog arrow-nav: no stutter on rapid presses

## Out of scope (explicit)

- No changes to `lib/image-variants.ts`
- No changes to `lib/history-upload.ts`
- No changes to `stores/history-store.ts` (other than the new optional `thumbUrl` field via `HistoryEntry` type)
- No changes to `app/api/history/*`
- No LQIP / averaged-color pre-paint (see Future Work)
- No progressive JPEG encoding (see Future Work)
- No Service Worker (covered by separate deferred spec)

## Future Work — Detailed Instructions for a Future Agent

This section is written for an agent picking up follow-ups later. Each item is self-contained: context, files to touch, approach, and pitfalls. Don't start these until the current spec has shipped and been used in prod for at least a week (so real telemetry informs whether they're needed).

### FW-1. LQIP (averaged-color) for zero-RTT first paint

**When to do this:** If users report "empty card flash" on cold reload before thumb arrives (currently we show `bg-muted/30`). Measure first: add a `performance.mark` for `blur-up:backdrop-visible` and compare against `blur-up:mount`. If median gap > 80ms on a typical cold reload, LQIP is worth it.

**Goal:** Paint the average color of the image instantly (before any HTTP request) by embedding a 4-byte color hint in the HistoryEntry.

**Files to touch:**
- `lib/image-variants.ts` — compute `avgColor` alongside `thumb`. On the same `ImageBitmap`, after drawing the thumb at 240px, read a 1×1 mipmap via `ctx.drawImage(bitmap, 0, 0, 1, 1)` + `ctx.getImageData(0, 0, 1, 1)`. ~5 extra lines. Return `{ thumb, mid, full, avgColor: "#rrggbb" }`.
- `types/wavespeed.ts` — add `bgColor?: string` to `HistoryEntry`.
- `components/generate-form.tsx` — pass `variants.avgColor` into `updateHistory`.
- `lib/history-upload.ts` — add `bgColor` to the FormData; server stores it in the DB row.
- `app/api/history/route.ts` + `app/api/history/route.ts` GET — persist and return the field. **Server-side: add a column `bg_color VARCHAR(7)` to the generations table.** Migration needed.
- `app/api/history/route.ts` mapping in `serverToday` — populate `bgColor` on adapted entries (`components/output-area.tsx`, `lib/server-gen-adapter.ts`).
- `components/blur-up-image.tsx` — accept a new `bgColor?: string` prop. Render as `style={{ backgroundColor: bgColor }}` on `.blur-up-root`. The `bg-muted/30` from call-sites becomes a fallback when `bgColor` is absent.

**Gotchas:**
- DB migration — do NOT skip. Existing rows will have NULL `bg_color`; this is fine, fallback to `bg-muted/30`.
- Don't read `getImageData` until after thumb encode — it shares the canvas. Order: thumb encode → read 1×1 → mid encode.
- Colorspace: sRGB only. If any image pipeline ever adds P3, adjust.
- Do NOT try to "auto-tint" dark mode — let the actual color show through. If users find it jarring on some images, add `opacity: 0.7` to the bgColor layer and call it a day.

**Test:** Mock an entry with `bgColor="#ff0000"`, mount BlurUpImage, assert `getComputedStyle(root).backgroundColor === "rgb(255, 0, 0)"` before either `<img>` loads.

### FW-2. Progressive JPEG for mid variant

**When to do this:** If users on slow mobile report a "too long blank → pop" feel. The current curtain covers this with the blurred backdrop, but progressive JPEG would let the sharp layer itself transition from blurry to clear natively (Chrome / Safari both render progressive JPEGs this way). Would feel even smoother. Check telemetry: if median mid-load time > 1.5s on mobile and users complain about perceived quality, act.

**Goal:** Encode `mid` variant as progressive JPEG (native browser blur-up). `BlurUpImage`'s curtain becomes redundant for the mid layer; simplify to a pure opacity crossfade backdrop → sharp.

**Approach:** Canvas's `toBlob("image/jpeg")` produces baseline, not progressive, JPEGs. Options in priority order:
1. **`mozjpeg-wasm`** — pull in via npm (~200 KB wasm). After canvas encode, re-encode the blob bytes through mozjpeg with `{ progressive: true }`. Keeps server unchanged. Cost: +200 KB wasm. Lazy-load so it only hits users who've generated ≥ 1 image this session.
2. **Server-side re-encode** — new endpoint `/api/history/reencode-mid` that takes the mid JPEG and returns a progressive version. Re-introduces `sharp` on the request path, which the thumbnail-first spec removed. Rejected unless option 1 proves unworkable.
3. **Native browser progressive JPEG encoding** — not supported in any canvas API as of 2026. Skip.

**Files to touch:**
- `package.json` — add `@jsquash/jpeg` or `mozjpeg-wasm` (whichever maintains better; check at the time).
- `lib/image-variants.ts` — after the `encodeVariant(bitmap, MID_WIDTH, MID_QUALITY)` call, pass the result through the wasm re-encoder with `{ progressive: true }`. Keep thumb baseline (small, progressive doesn't help at 240px).
- `components/blur-up-image.tsx` — add a `progressive?: boolean` prop. When true: simplify internally — skip the curtain mask, use a straight opacity crossfade over 400ms. The browser's native scan-by-scan render provides the blur-up.
- `components/output-area.tsx` — pass `progressive={entry.confirmed === true}` (only confirmed entries have progressive mid; in-flight ones may be baseline if re-encode hasn't finished).

**Gotchas:**
- The re-encode adds ~50-100ms on generation complete. Do it AFTER `updateHistory` fires with the baseline blob, so the UI sees the card immediately. Swap to the progressive blob in a second `updateHistory` call when ready.
- Don't break `cacheBlob` — the same URL must not carry different bytes. Use a separate URL key (e.g. append `?p=1`) OR just live with one encode (the progressive one, done before `cacheBlob`). Latter is simpler.
- Verify with DevTools: `chrome://net-export` → check "scan" events on the image request. Or use `jpegtran -v` on a downloaded file to confirm "Progressive JPEG" output.

**Test:** Unit test `createImageVariants` with `progressive: true` opt-in, assert output bytes start with the FFD8 FFE0 marker sequence AND contain an SOF2 (progressive) marker, not SOF0 (baseline). Use a small hex-dump helper.

### FW-3. Progressive detail upgrade in ImageDialog

**When to do this:** If users zoom in the dialog and notice the 1200px mid upscaled looks soft, but waiting for the full original is annoying. This is a natural extension after FW-1 and FW-2 ship.

**Goal:** On dialog open, render mid immediately (fast, ~150 KB). In the background, fetch full. When full is ready, swap `sharpSrc` on the BlurUpImage with a 200ms crossfade. No curtain — it's an in-place quality upgrade.

**Files to touch:**
- `components/image-dialog.tsx` — add a separate `useEffect` watching `currentEntry.originalUrl`; fetch full eagerly. When its `useCachedImage` returns a blob URL, swap `sharpSrc` on BlurUpImage.
- `components/blur-up-image.tsx` — add a `quietSwap` mode or rely on the existing "new sharpSrc after previous played → done state immediately" behavior. Verify that transitioning a `<img>` src between two cached blob URLs is visually seamless (it usually is — browser renders from memory).

**Gotchas:**
- Only do this when dialog is actually open and zoom/pan is active — otherwise wasteful bytes. Detect via zoom level > 1.0.
- Cancel the full fetch if the user closes the dialog or nav arrows to a different sibling.

**Test:** Manual: open dialog on a large entry, verify mid renders ~200ms after open, full swaps in ~800ms later with no visible flicker. No unit test necessary.

### FW-4. Migrate curtain → pure progressive-JPEG-driven reveal (post-FW-2)

**Only do this after FW-2 ships and is proven stable.** The current curtain is a simulation; progressive JPEG gives you the real thing natively for free. Remove the curtain mask CSS, keep only the backdrop + opacity crossfade. Reduces code, removes the `@property --reveal` dependency, and makes the reveal genuinely tied to load progress.

**Files to touch:**
- `components/blur-up-image.tsx` — strip mask-related CSS and JS; keep backdrop logic and the done-state observable. ~40 LOC removed.
- All call-sites — no changes; API stays the same, `revealMs` now only governs the backdrop fade-out delay.
- `docs/superpowers/specs/` — supersede this design doc with a note at the top: "Superseded by FW-4 follow-up; curtain simulation removed in favor of native progressive JPEG."

**Do not do this before FW-2.** Without progressive JPEG, removing the curtain would re-expose the modem effect.

---

## Post-ship notes (2026-04-12, end of day)

The original 10-task plan landed cleanly in 10 commits (`0693ac6` → `bb9d300`,
plus `8008852` gitignore). Build green, curtain reveal working.

Three follow-up fixes surfaced during hands-on testing and were applied:

1. **`f86852d` — Dialog sizing.** Plan's `fit="natural"` used
   `max-width: 100%; max-height: 100%` on the sharp `<img>`, which resolves
   against the inline-block BlurUpImage root — circular when the root has no
   explicit size. Fix: added a `sharpClassName` prop; dialog passes
   `max-h-[82vh] max-w-[92vw] object-contain` directly onto the sharp layer.
   Globals CSS stripped the circular percentage caps from
   `.blur-up-root[data-fit="natural"] .blur-up-sharp`.

2. **`cd6cbdd` — Skip curtain for cached images.** User feedback: the
   reveal is meaningful only for genuinely-loading images; cache-warm
   re-renders (sidebar scroll, reopening history) should paint plainly.
   Fix: if the sharp `onLoad` fires within 60 ms of mount, jump straight
   to the `done` state with no curtain animation.

3. **Delete/sync race cascade.** The Output/Sidebar delete mechanism
   interacted with the concurrent-generation refetch path in ways that
   were hard to chase down. Multiple patches landed (`ecc1a84`,
   `ba9638e`, `8cb1c37`, `e994900`, `c2cb848`, `5f7db4b`, `dee4569`,
   `06a0b90`, and an attempted-then-reverted `168fe5d` / `f00bb41`)
   progressively adding optimistic cleanup, source-level filtering,
   debug logging, and HMR resilience. At time of writing, the dev-mode
   behavior is still flaky: a deleted row can re-surface in the
   sidebar after a concurrent generation completes, and HMR during
   testing can cascade the flakiness further.

   **The right response is a redesign, not more patches.** See
   `docs/superpowers/specs/2026-04-12-history-sync-mechanism-redesign.md`
   for the fresh-start design the next agent should pick up. The
   instrumentation from `06a0b90` (`lib/history-debug.ts`) survives
   into the redesign and should be retained.

   **Current state of the file tree:** the existing mechanism works
   well enough in production (no HMR, no race between concurrent
   refetches), so this is a dev-experience and maintainability issue,
   not a prod-blocking bug. BlurUpImage itself is solid.

## References

- Animation style selected in visual-companion session 2026-04-12 (mockup file: `.superpowers/brainstorm/1988-1776019611/content/curtain-reveal.html`)
- Variant pipeline: `docs/superpowers/specs/2026-04-12-history-thumbnail-first-design.md`
- Existing image cache: `lib/image-cache.ts`
- Deferred SW cache: `docs/superpowers/specs/2026-04-12-sw-image-cache-future.md`
- Redesign task: `docs/superpowers/specs/2026-04-12-history-sync-mechanism-redesign.md`
