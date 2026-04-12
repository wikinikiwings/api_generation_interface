# Pretty Image Loading Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the line-by-line JPEG paint of `<img>` elements with a reusable `<BlurUpImage />` component that shows a blurred backdrop + sharp-layer "curtain with feathered edge" reveal, applied to Output strip, history sidebar, and ImageDialog.

**Architecture:** One new client component (`components/blur-up-image.tsx`) with two layered `<img>` tags — a blurred backdrop (thumb URL, or the sharp URL itself with CSS `blur(32px)` as fallback) and a sharp layer masked with a `linear-gradient` whose soft edge sweeps top-to-bottom via an animated `@property --reveal` CSS variable. Plays once per mount; callers re-mount via `key` for fresh reveal (ImageDialog arrow-nav). Internally uses `useCachedImage` so call-sites pass logical URLs and get automatic blob-cache hits.

**Tech Stack:** Next.js 15, React 19, TypeScript, Tailwind, vanilla CSS keyframes. **No test runner in repo** — plan uses type-check (`npm run build`), runtime dev-server verification, and focused ad-hoc Node scripts for pure-function checks. Matches the verification style of `2026-04-12-history-thumbnail-first.md`.

---

## Spec reference

`docs/superpowers/specs/2026-04-12-pretty-image-loading-design.md`

## File Structure

### New files

- **`components/blur-up-image.tsx`** — reusable image renderer with curtain reveal. Knows nothing about history entries, stores, or SSE. Internal: `useCachedImage` wiring, `hasPlayedRef` for play-once-per-mount, reduced-motion detection, fallback mode when `backdropSrc` is absent. Exports `BlurUpImage` (forwardRef).
- **`lib/history-urls.ts`** — pure helper: `thumbUrlForEntry(entry)` returns the thumb URL for a `HistoryEntry`, preferring the new `thumbUrl` field and falling back to deriving `thumb_<base>.jpg` from `originalUrl`/`outputUrl`.

### Modified files

- **`types/wavespeed.ts`** — add optional `thumbUrl?: string` to `HistoryEntry`.
- **`app/globals.css`** — add the `@property --reveal` declaration, `@keyframes blur-up-breathe`, `@keyframes blur-up-curtain`, and the three `.blur-up-*` class rules including `prefers-reduced-motion` override.
- **`components/generate-form.tsx`** — at the three `updateHistory({...})` call sites (lines ~305, ~343, ~404), add `thumbUrl` alongside the other URL fields.
- **`components/output-area.tsx`** — in the `serverToday` mapping (existing `thumbUrl` local variable at line ~99), write it onto the adapted remote entry; replace OutputCard's inline `<img>` with `<BlurUpImage>`.
- **`components/history-sidebar.tsx`** — replace the card `<img>` (line ~410) with `<BlurUpImage sharpSrc={cardSrc} revealMs={500}>`.
- **`components/image-dialog.tsx`** — remove the external `useCachedImage(currentEntry.outputUrl)` call (lines ~220-225); refactor `ZoomableImage`'s inner `<img>` to a `<BlurUpImage revealMs={400}>`; pass `key={currentEntry.id}` from `ImageDialog` down to `ZoomableImage` so arrow-nav re-mounts and re-animates. The zoom/pan transform stays on a wrapper `<div>`, not on the image itself.

### No changes

- `lib/image-variants.ts`, `lib/history-upload.ts`, `lib/image-cache.ts`, `stores/history-store.ts`, `app/api/history/*`, `hooks/use-history.ts`, `hooks/use-generation-events.ts`, `lib/pending-history.ts`, `lib/server-gen-adapter.ts`.

---

## Verification approach (no test runner)

Because this repo has no vitest/jest, we verify via:
1. **Type check** — `npm run build` after each task produces type errors the moment a call-site mismatches.
2. **Ad-hoc Node scripts** for pure functions (Task 2: `lib/history-urls.ts`). A one-off script exercises the function and is deleted after the task.
3. **Manual dev-server** checks for UI tasks (Tasks 3, 7–10). Each task lists the exact clicks + expected visual behavior.
4. **Manual regression checklist** at the end (Task 11).

Every task ends with a `git commit` using a message that reflects the scope. Commits are small and atomic so reverting any single task leaves the rest working.

---

## Task 1: Add `thumbUrl` to `HistoryEntry`

**Files:**
- Modify: `types/wavespeed.ts`

Foundation for all later tasks. Pure type change; no runtime effect until Task 5 populates it.

- [ ] **Step 1: Add the field to the interface**

Edit `types/wavespeed.ts`. After the existing `previewUrl?` block (around line 45), add:

```ts
  /**
   * Thumb (~240px) preview URL. Populated alongside `previewUrl`/`originalUrl`
   * on entries generated after the pretty-image-loading work ships. Legacy
   * entries lack it — use `thumbUrlForEntry()` from `lib/history-urls` to
   * derive one on demand. Used by `<BlurUpImage>` as the backdrop source.
   */
  thumbUrl?: string;
```

Place it immediately after the `originalUrl?` block for locality.

- [ ] **Step 2: Type-check**

Run: `npm run build`
Expected: build succeeds with no new errors. (Any existing build failures are out of scope for this plan — raise them separately.)

- [ ] **Step 3: Commit**

```bash
git add types/wavespeed.ts
git commit -m "types(history): add optional thumbUrl field to HistoryEntry"
```

---

## Task 2: Create `lib/history-urls.ts`

**Files:**
- Create: `lib/history-urls.ts`

Pure function, no React, no DOM. Exercised by an ad-hoc Node script before we commit.

- [ ] **Step 1: Create the file**

```ts
// lib/history-urls.ts

import type { HistoryEntry } from "@/types/wavespeed";

/**
 * Returns a thumb (~240px) URL for a history entry, or `undefined` when
 * no such URL can be known without a server roundtrip.
 *
 * Resolution order:
 *   1. `entry.thumbUrl` if set (modern entries fill this in directly).
 *   2. Derive `thumb_<uuid>.jpg` from `originalUrl`/`outputUrl` when that
 *      URL points at our history-image endpoint (legacy rows from before
 *      the pretty-image-loading work).
 *   3. Otherwise `undefined` — caller should fall back to a blur-on-sharp
 *      backdrop (see `<BlurUpImage>`'s fallback mode).
 *
 * Blob URLs always return `undefined`: client-generated variants live
 * in separate blob URLs that the caller tracks independently (see
 * `components/generate-form.tsx`).
 */
export function thumbUrlForEntry(
  entry: Pick<HistoryEntry, "thumbUrl" | "originalUrl" | "outputUrl">
): string | undefined {
  if (entry.thumbUrl) return entry.thumbUrl;
  const src = entry.originalUrl ?? entry.outputUrl;
  if (!src) return undefined;
  if (src.startsWith("blob:")) return undefined;
  // Match /api/history/image/<basename>.<ext> — encodeURIComponent-safe
  // because server filenames are UUIDs + one extension, no slashes.
  const match = src.match(/\/api\/history\/image\/([^?/]+)\.[^./?]+$/);
  if (!match) return undefined;
  const base = decodeURIComponent(match[1]);
  return `/api/history/image/${encodeURIComponent(`thumb_${base}.jpg`)}`;
}
```

- [ ] **Step 2: Write an ad-hoc verification script**

Create `scripts/verify-history-urls.ts`:

```ts
// Temporary verification harness for lib/history-urls.ts.
// Delete after Task 2 is committed.
import { thumbUrlForEntry } from "../lib/history-urls";

const cases = [
  {
    name: "explicit thumbUrl wins",
    input: { thumbUrl: "explicit", originalUrl: "ignored" },
    expected: "explicit",
  },
  {
    name: "blob URL → undefined",
    input: { outputUrl: "blob:abc" },
    expected: undefined,
  },
  {
    name: "server URL with .png → thumb derivation",
    input: { originalUrl: "/api/history/image/deadbeef.png" },
    expected: "/api/history/image/thumb_deadbeef.jpg",
  },
  {
    name: "server URL with .jpg → thumb derivation",
    input: { outputUrl: "/api/history/image/abc123.jpg" },
    expected: "/api/history/image/thumb_abc123.jpg",
  },
  {
    name: "no usable URL → undefined",
    input: {},
    expected: undefined,
  },
  {
    name: "unrecognized URL → undefined",
    input: { outputUrl: "https://example.com/some.jpg" },
    expected: undefined,
  },
];

let failures = 0;
for (const c of cases) {
  const got = thumbUrlForEntry(c.input);
  const ok = got === c.expected;
  console.log(`${ok ? "PASS" : "FAIL"}  ${c.name}  got=${JSON.stringify(got)}  expected=${JSON.stringify(c.expected)}`);
  if (!ok) failures++;
}
if (failures > 0) {
  console.error(`\n${failures} failure(s)`);
  process.exit(1);
}
console.log("\nAll cases passed.");
```

- [ ] **Step 3: Run the verification script**

Run: `npx -y tsx scripts/verify-history-urls.ts`
Expected output: 6 PASS lines, then "All cases passed."

Do NOT add `tsx` to `package.json` — it's a one-shot dev tool for this task. `npx -y` downloads and runs it ephemerally.

- [ ] **Step 4: Delete the verification script**

Run: `rm scripts/verify-history-urls.ts`

- [ ] **Step 5: Type-check**

Run: `npm run build`
Expected: build succeeds.

- [ ] **Step 6: Commit**

```bash
git add lib/history-urls.ts
git commit -m "feat(history-urls): thumbUrlForEntry helper"
```

---

## Task 3: Add blur-up CSS to `app/globals.css`

**Files:**
- Modify: `app/globals.css`

Adds the keyframes, `@property`, and class selectors the component will rely on. Done before the component so the component can be authored with the final CSS contract in mind.

- [ ] **Step 1: Append to `app/globals.css`**

Append these blocks to the END of `app/globals.css` (after the custom-scrollbar section):

```css
/* =====================================================================
 * Pretty image loading — <BlurUpImage /> (components/blur-up-image.tsx)
 *
 * The curtain reveal is driven by an animated CSS variable `--reveal`
 * (percentage) that moves from -25% → 125% while the mask-image's
 * feathered edge sweeps top-to-bottom. `@property` is what makes the
 * percentage interpolate smoothly rather than jumping.
 *
 * Feather width = 22% of the frame height, hard-coded into the
 * mask-image gradient stops below.
 * ===================================================================== */
@property --reveal {
  syntax: "<percentage>";
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

.blur-up-root {
  position: relative;
  overflow: hidden;
}

/* "natural" fit: the root collapses to the sharp layer's intrinsic size
 * so callers (e.g. ImageDialog) who don't give the wrapper an explicit
 * width/height still get a sensibly sized image. */
.blur-up-root[data-fit="natural"] {
  display: inline-block;
}

.blur-up-root[data-fit="natural"] .blur-up-sharp {
  position: relative;
  inset: auto;
  width: auto;
  height: auto;
  max-width: 100%;
  max-height: 100%;
  display: block;
}

.blur-up-backdrop {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  filter: blur(32px) saturate(1.2) brightness(0.95);
  transform: scale(1.15);
  animation: blur-up-breathe 2.5s ease-in-out infinite;
  transition: opacity 300ms linear;
  pointer-events: none;
}

.blur-up-sharp {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  -webkit-mask-image: linear-gradient(
    to bottom,
    black 0%,
    black calc(var(--reveal, -25%)),
    transparent calc(var(--reveal, -25%) + 22%),
    transparent 100%
  );
  mask-image: linear-gradient(
    to bottom,
    black 0%,
    black calc(var(--reveal, -25%)),
    transparent calc(var(--reveal, -25%) + 22%),
    transparent 100%
  );
}

.blur-up-sharp[data-reveal-state="playing"] {
  animation: blur-up-curtain var(--reveal-ms, 700ms)
    cubic-bezier(0.4, 0, 0.2, 1) forwards;
}

.blur-up-sharp[data-reveal-state="done"] {
  --reveal: 125%;
  animation: none;
}

.blur-up-root[data-reveal-state="done"] .blur-up-backdrop {
  opacity: 0;
  animation-play-state: paused;
}

@media (prefers-reduced-motion: reduce) {
  .blur-up-backdrop {
    animation: none;
    transition: opacity 150ms linear;
  }
  .blur-up-sharp,
  .blur-up-sharp[data-reveal-state="playing"],
  .blur-up-sharp[data-reveal-state="done"] {
    -webkit-mask-image: none;
    mask-image: none;
    animation: none;
  }
}
```

- [ ] **Step 2: Type-check + dev-server smoke**

Run: `npm run build`
Expected: build succeeds.

Run: `npm run dev`
In the browser, open any existing page. Expected: no visual regression (nothing uses these classes yet).

- [ ] **Step 3: Commit**

```bash
git add app/globals.css
git commit -m "style(globals): add blur-up keyframes and classes"
```

---

## Task 4: Create `components/blur-up-image.tsx`

**Files:**
- Create: `components/blur-up-image.tsx`

The core new component. This task is larger than the others because splitting it would leave the component in a non-working state between commits.

- [ ] **Step 1: Create the file with the full implementation**

```tsx
"use client";

import * as React from "react";
import { useCachedImage } from "@/lib/image-cache";
import { cn } from "@/lib/utils";

export interface BlurUpImageProps {
  /** Final sharp image URL (mid or full). Required. */
  sharpSrc: string;
  /**
   * Optional thumb URL shown as a blurred backdrop. When omitted the
   * component falls back to using `sharpSrc` as its own backdrop
   * (browser decodes once, CSS blur(32px) on the second paint layer).
   */
  backdropSrc?: string;
  alt: string;
  className?: string;
  /**
   * Sizing mode:
   *   "contain" / "cover" — both layers absolutely positioned inside
   *     the caller's fixed-size wrapper (Output, Sidebar use these).
   *   "natural" — sharp layer flows in normal positioning and drives
   *     the root size; backdrop stays absolute behind. Needed by
   *     ImageDialog where the image's intrinsic dimensions determine
   *     the layout size.
   * Default "contain".
   */
  fit?: "contain" | "cover" | "natural";
  /** Reveal animation duration in ms. Default 700. */
  revealMs?: number;
  draggable?: boolean;
  onDragStart?: React.DragEventHandler<HTMLImageElement>;
  /** Forwarded to the sharp <img>. Fires when the sharp layer decodes. */
  onLoad?: React.ReactEventHandler<HTMLImageElement>;
  /** Forwarded to the sharp <img>. Fires on 404 / network failure. */
  onError?: React.ReactEventHandler<HTMLImageElement>;
}

const DEFAULT_REVEAL_MS = 700;
const REDUCED_MOTION_CROSSFADE_MS = 150;

/**
 * Two-layer image with a "curtain with feathered edge" reveal.
 *
 *   - Backdrop layer: blurred thumb (or sharp src as fallback) with a
 *     gentle breathing pulse while waiting for the sharp layer.
 *   - Sharp layer: full image under a mask-image whose feathered edge
 *     sweeps top-to-bottom when `onLoad` fires.
 *
 * Play-once-per-mount: subsequent `sharpSrc` changes in the same mount
 * do NOT replay the curtain. Callers that want a fresh reveal on src
 * change (e.g. ImageDialog arrow-nav) should pass a `key` prop so React
 * re-mounts the component.
 *
 * Reduced-motion: replaces the reveal with a 150ms opacity crossfade.
 */
export const BlurUpImage = React.forwardRef<HTMLImageElement, BlurUpImageProps>(
  function BlurUpImage(
    {
      sharpSrc,
      backdropSrc,
      alt,
      className,
      fit = "contain",
      revealMs = DEFAULT_REVEAL_MS,
      draggable,
      onDragStart,
      onLoad,
      onError,
    },
    ref
  ) {
    // Cache integration: non-blob URLs go through useCachedImage so we
    // render from the in-memory blob cache when available. Blob URLs
    // (already in memory) bypass the hook.
    const cachedSharp = useCachedImage(
      sharpSrc && !sharpSrc.startsWith("blob:") ? sharpSrc : null
    );
    const cachedBackdrop = useCachedImage(
      backdropSrc && !backdropSrc.startsWith("blob:") ? backdropSrc : null
    );
    const renderedSharpSrc = cachedSharp ?? sharpSrc;
    const renderedBackdropSrc =
      cachedBackdrop ?? backdropSrc ?? sharpSrc;

    const [sharpLoaded, setSharpLoaded] = React.useState(false);
    const [backdropLoaded, setBackdropLoaded] = React.useState(false);
    const [backdropFailed, setBackdropFailed] = React.useState(false);
    const hasPlayedRef = React.useRef(false);
    const [revealState, setRevealState] = React.useState<
      "idle" | "playing" | "done"
    >("idle");

    const reducedMotion = useReducedMotion();

    // Trigger reveal exactly once per mount when sharp first loads.
    React.useEffect(() => {
      if (!sharpLoaded) return;
      if (hasPlayedRef.current) return;
      hasPlayedRef.current = true;

      if (reducedMotion) {
        // Skip curtain: go straight to done after a minimal crossfade.
        setRevealState("done");
        return;
      }

      setRevealState("playing");
      const t = window.setTimeout(() => {
        setRevealState("done");
      }, revealMs);
      return () => window.clearTimeout(t);
    }, [sharpLoaded, reducedMotion, revealMs]);

    // If the backdrop URL 404s, fall back to using sharpSrc as backdrop.
    const effectiveBackdropSrc = backdropFailed ? renderedSharpSrc : renderedBackdropSrc;

    // In "natural" fit the sharp layer flows in-document, so object-fit
    // is meaningless. Only contain/cover apply the utility class.
    const imgFitClass =
      fit === "cover"
        ? "object-cover"
        : fit === "contain"
        ? "object-contain"
        : "";

    // Inline CSS variable so callers can have different revealMs per
    // instance (Dialog=400, Output=700) without multiple class variants.
    // Cast once on the outer object; TS's CSSProperties doesn't model
    // custom properties, so a single `as` cast is the standard workaround.
    const rootStyle = {
      "--reveal-ms": `${
        reducedMotion ? REDUCED_MOTION_CROSSFADE_MS : revealMs
      }ms`,
    } as React.CSSProperties;

    return (
      <div
        className={cn("blur-up-root", className)}
        data-reveal-state={revealState}
        data-fit={fit}
        style={rootStyle}
      >
        {/* Backdrop — blurred thumb (or sharp as fallback). */}
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          className={cn("blur-up-backdrop", imgFitClass)}
          src={effectiveBackdropSrc}
          alt=""
          aria-hidden
          draggable={false}
          onLoad={() => setBackdropLoaded(true)}
          onError={() => setBackdropFailed(true)}
          // Hide the backdrop entirely until it has something to show —
          // avoids a split-second of broken-image chrome on cold loads.
          style={{ opacity: backdropLoaded || backdropFailed ? undefined : 0 }}
        />

        {/* Sharp — forwarded ref goes here so callers (zoom/pan) address
            the real bitmap layer. */}
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          ref={ref}
          className={cn("blur-up-sharp", imgFitClass)}
          src={renderedSharpSrc}
          alt={alt}
          draggable={draggable}
          onDragStart={onDragStart}
          data-reveal-state={revealState}
          onLoad={(e) => {
            setSharpLoaded(true);
            onLoad?.(e);
          }}
          onError={onError}
          // Reduced-motion: short opacity crossfade instead of the mask.
          style={
            reducedMotion
              ? {
                  opacity: sharpLoaded ? 1 : 0,
                  transition: `opacity ${REDUCED_MOTION_CROSSFADE_MS}ms linear`,
                }
              : undefined
          }
        />
      </div>
    );
  }
);

function useReducedMotion(): boolean {
  const [reduced, setReduced] = React.useState(false);
  React.useEffect(() => {
    if (typeof window === "undefined" || !window.matchMedia) return;
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    setReduced(mq.matches);
    const onChange = () => setReduced(mq.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);
  return reduced;
}
```

- [ ] **Step 2: Type-check**

Run: `npm run build`
Expected: build succeeds. Fix any type errors before continuing.

- [ ] **Step 3: Smoke in isolation (optional harness page)**

If you want a smoke check before integrating (recommended):

Create `app/dev-blur-up/page.tsx`:

```tsx
"use client";

import { BlurUpImage } from "@/components/blur-up-image";

export default function DevBlurUp() {
  return (
    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 24, padding: 24 }}>
      <div>
        <p>With backdrop (thumb from server)</p>
        <div style={{ width: 300, height: 300 }}>
          <BlurUpImage
            sharpSrc="https://picsum.photos/seed/bu1/1200/1200"
            backdropSrc="https://picsum.photos/seed/bu1/240/240"
            alt="demo"
            className="h-full w-full"
            revealMs={900}
          />
        </div>
      </div>
      <div>
        <p>Without backdrop (blur-on-sharp fallback)</p>
        <div style={{ width: 300, height: 300 }}>
          <BlurUpImage
            sharpSrc="https://picsum.photos/seed/bu2/1200/1200"
            alt="demo"
            className="h-full w-full"
            revealMs={900}
          />
        </div>
      </div>
    </div>
  );
}
```

Run: `npm run dev`. Visit `http://localhost:3000/dev-blur-up`.
Expected: two tiles, each shows a blurred backdrop first, then a sharp image curtain-reveals top-to-bottom. The second tile uses the sharp source as its own backdrop.

- [ ] **Step 4: Remove the harness page**

Run: `rm -r app/dev-blur-up`

- [ ] **Step 5: Commit**

```bash
git add components/blur-up-image.tsx
git commit -m "feat(blur-up-image): curtain-reveal image component"
```

---

## Task 5: Populate `thumbUrl` in `generate-form.tsx`

**Files:**
- Modify: `components/generate-form.tsx`

Three `updateHistory` call sites need `thumbUrl` added. The underlying values already exist as local variables (`thumbBlobUrl` and `res.thumbUrl`).

- [ ] **Step 1: First call site — local variants ready (~line 305)**

Find this block (currently lines ~305-313):

```ts
      updateHistory(historyId, {
        previewUrl: midBlobUrl,
        originalUrl: fullBlobUrl,
        outputUrl: midBlobUrl,
        confirmed: false,
        localBlobUrls: [thumbBlobUrl, midBlobUrl, fullBlobUrl].filter(
          (u): u is string => Boolean(u)
        ),
      });
```

Change to:

```ts
      updateHistory(historyId, {
        previewUrl: midBlobUrl,
        originalUrl: fullBlobUrl,
        outputUrl: midBlobUrl,
        thumbUrl: thumbBlobUrl,
        confirmed: false,
        localBlobUrls: [thumbBlobUrl, midBlobUrl, fullBlobUrl].filter(
          (u): u is string => Boolean(u)
        ),
      });
```

- [ ] **Step 2: Second call site — retry success (~line 343)**

Find this block inside the `retry` closure (currently lines ~343-350):

```ts
            updateHistory(historyId, {
              serverGenId: res.serverGenId,
              previewUrl: res.midUrl,
              originalUrl: res.fullUrl,
              outputUrl: res.midUrl,
              confirmed: true,
              localBlobUrls: undefined,
            });
```

Change to:

```ts
            updateHistory(historyId, {
              serverGenId: res.serverGenId,
              previewUrl: res.midUrl,
              originalUrl: res.fullUrl,
              outputUrl: res.midUrl,
              thumbUrl: res.thumbUrl,
              confirmed: true,
              localBlobUrls: undefined,
            });
```

- [ ] **Step 3: Third call site — first-time upload success (~line 404)**

Find this block (currently lines ~404-411):

```ts
        updateHistory(historyId, {
          serverGenId: res.serverGenId,
          previewUrl: res.midUrl,
          originalUrl: res.fullUrl,
          outputUrl: res.midUrl,
          confirmed: true,
          localBlobUrls: undefined,
        });
```

Change to:

```ts
        updateHistory(historyId, {
          serverGenId: res.serverGenId,
          previewUrl: res.midUrl,
          originalUrl: res.fullUrl,
          outputUrl: res.midUrl,
          thumbUrl: res.thumbUrl,
          confirmed: true,
          localBlobUrls: undefined,
        });
```

- [ ] **Step 4: Type-check**

Run: `npm run build`
Expected: build succeeds.

- [ ] **Step 5: Commit**

```bash
git add components/generate-form.tsx
git commit -m "feat(generate-form): populate thumbUrl on updateHistory calls"
```

---

## Task 6: Populate `thumbUrl` in `output-area.tsx` remote mapping

**Files:**
- Modify: `components/output-area.tsx`

The `serverToday` mapping in `output-area.tsx` already computes a `thumbUrl` local variable (line ~99) and then comments that it's "not currently surfaced" (line 113-114). We lift the void suppression and write it onto the entry.

- [ ] **Step 1: Update the remote-entry push**

Find this block (currently lines ~106-115):

```ts
      remote.push({
        ...adapted,
        previewUrl: midUrl,
        originalUrl: fullUrl,
        outputUrl: midUrl,
      });
      // Suppress unused var warning for thumbUrl (not currently
      // surfaced to OutputArea — sidebar preloader handles it).
      void thumbUrl;
```

Change to:

```ts
      remote.push({
        ...adapted,
        previewUrl: midUrl,
        originalUrl: fullUrl,
        outputUrl: midUrl,
        thumbUrl,
      });
```

- [ ] **Step 2: Type-check**

Run: `npm run build`
Expected: build succeeds. If `thumbUrl` isn't recognized on the HistoryEntry type, Task 1 wasn't applied — go check.

- [ ] **Step 3: Commit**

```bash
git add components/output-area.tsx
git commit -m "feat(output-area): surface thumbUrl on remote entries"
```

---

## Task 7: Integrate `<BlurUpImage>` into OutputCard

**Files:**
- Modify: `components/output-area.tsx`

Replace the plain `<img>` in `OutputCard` with `<BlurUpImage>`. Drag-drop and hover scale stay; the actual reveal now runs per mount.

- [ ] **Step 1: Add imports at the top of `output-area.tsx`**

Find the existing imports block. Add these two imports alongside the others:

```ts
import { BlurUpImage } from "@/components/blur-up-image";
import { thumbUrlForEntry } from "@/lib/history-urls";
```

- [ ] **Step 2: Replace the OutputCard `<img>`**

Find this block (currently lines ~258-282, inside OutputCard's `card` JSX):

```tsx
      {isDone && (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={entry.previewUrl ?? entry.outputUrl}
          alt={entry.prompt}
          draggable
          onDragStart={(e) => {
            // Carry the FULL-RESOLUTION URL via the same custom MIME the
            // History sidebar uses, so dropping back into the dropzone
            // re-ingests the original (not the mid preview the tile
            // visually shows).
            const dragUrl = entry.originalUrl ?? entry.outputUrl;
            if (!dragUrl) return;
            const payload = {
              url: dragUrl,
              filename: `wavespeed-${entry.taskId || entry.id}.${entry.outputFormat}`,
              contentType: `image/${entry.outputFormat === "jpeg" ? "jpeg" : "png"}`,
            };
            e.dataTransfer.setData(
              "application/x-viewcomfy-media",
              JSON.stringify(payload)
            );
            e.dataTransfer.effectAllowed = "copy";
          }}
          className="h-full w-full object-contain transition-transform group-hover:scale-[1.02]"
        />
      )}
```

Change to:

```tsx
      {isDone && (
        <BlurUpImage
          sharpSrc={(entry.previewUrl ?? entry.outputUrl)!}
          backdropSrc={thumbUrlForEntry(entry)}
          alt={entry.prompt}
          draggable
          onDragStart={(e) => {
            // Carry the FULL-RESOLUTION URL via the same custom MIME the
            // History sidebar uses, so dropping back into the dropzone
            // re-ingests the original (not the mid preview the tile
            // visually shows).
            const dragUrl = entry.originalUrl ?? entry.outputUrl;
            if (!dragUrl) return;
            const payload = {
              url: dragUrl,
              filename: `wavespeed-${entry.taskId || entry.id}.${entry.outputFormat}`,
              contentType: `image/${entry.outputFormat === "jpeg" ? "jpeg" : "png"}`,
            };
            e.dataTransfer.setData(
              "application/x-viewcomfy-media",
              JSON.stringify(payload)
            );
            e.dataTransfer.effectAllowed = "copy";
          }}
          fit="contain"
          revealMs={700}
          className="h-full w-full transition-transform group-hover:scale-[1.02]"
        />
      )}
```

Rationale for the change in `className`: BlurUpImage is the root `<div>`, so Tailwind classes that used to sit on the `<img>` now sit on the wrapper. `object-contain` moves inside BlurUpImage via the `fit` prop; hover scale stays on the wrapper.

- [ ] **Step 3: Type-check**

Run: `npm run build`
Expected: build succeeds.

- [ ] **Step 4: Manual verification**

Run: `npm run dev`
In the browser:
1. Submit a generation. When it completes, the card should show a blurred color pulse then a top-down curtain reveal — not a line-by-line paint.
2. Hover the card — still scales slightly (`group-hover:scale-[1.02]`).
3. Drag the card into the dropzone area. Verify it carries the full-resolution URL (the dropzone accepts it; the existing preview in the dropzone should show the full image).
4. Click the card to open the dialog — should still work (dialog integration is Task 9, so styling inside dialog hasn't changed yet).

- [ ] **Step 5: Commit**

```bash
git add components/output-area.tsx
git commit -m "feat(output-card): render with BlurUpImage curtain reveal"
```

---

## Task 8: Integrate `<BlurUpImage>` into HistorySidebar

**Files:**
- Modify: `components/history-sidebar.tsx`

The sidebar card's `<img>` uses `cardSrc` (thumb URL or cached blob). Swap for `<BlurUpImage>` with `revealMs={500}` (shorter because the tile is small; 700ms would drag).

- [ ] **Step 1: Add the import at the top of `history-sidebar.tsx`**

Find the existing imports. Add:

```ts
import { BlurUpImage } from "@/components/blur-up-image";
```

- [ ] **Step 2: Replace the `thumbJsx` block**

Find this block (currently lines ~408-437):

```tsx
  const thumbJsx = cardSrc && fullSrc && midSrc ? (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={cardSrc}
      alt={data.prompt || "generation"}
      width={140}
      height={140}
      loading="lazy"
      draggable
      onDragStart={(e) => {
        const payload = {
          url: fullSrc!,
          filename: firstImage!.filename,
          contentType: firstImage!.content_type,
        };
        e.dataTransfer.setData(
          "application/x-viewcomfy-media",
          JSON.stringify(payload)
        );
        e.dataTransfer.effectAllowed = "copy";
      }}
      className="h-[140px] w-[140px] cursor-zoom-in rounded-md border border-border object-cover transition-all hover:scale-[1.03] hover:shadow-md"
      onError={() => {
        if (!triedFullRef.current && fullSrc && cardSrc !== fullSrc) {
          triedFullRef.current = true;
          setCardSrc(fullSrc);
        }
      }}
    />
  ) : null;
```

Change to:

```tsx
  const thumbJsx = cardSrc && fullSrc && midSrc ? (
    <BlurUpImage
      sharpSrc={cardSrc}
      // No explicit backdrop: the card already renders thumb-level detail,
      // and BlurUpImage's fallback (blur(32px) on sharpSrc) gives us the
      // color pulse without a second HTTP request.
      alt={data.prompt || "generation"}
      draggable
      onDragStart={(e) => {
        const payload = {
          url: fullSrc!,
          filename: firstImage!.filename,
          contentType: firstImage!.content_type,
        };
        e.dataTransfer.setData(
          "application/x-viewcomfy-media",
          JSON.stringify(payload)
        );
        e.dataTransfer.effectAllowed = "copy";
      }}
      fit="cover"
      revealMs={500}
      className="h-[140px] w-[140px] cursor-zoom-in rounded-md border border-border transition-all hover:scale-[1.03] hover:shadow-md"
      onError={() => {
        if (!triedFullRef.current && fullSrc && cardSrc !== fullSrc) {
          triedFullRef.current = true;
          setCardSrc(fullSrc);
        }
      }}
    />
  ) : null;
```

Notes:
- `width={140}` and `height={140}` HTML attributes are dropped — the wrapper's `h-[140px] w-[140px]` covers sizing. BlurUpImage's layers are `absolute inset-0` so they fill the wrapper.
- `loading="lazy"` is also dropped: the sidebar already manually `preloadImage`s offscreen entries via `preloadImages`, and BlurUpImage's `<img>` tags will still inherit default loading behavior.
- `object-cover` moves into `fit="cover"` on BlurUpImage.

- [ ] **Step 3: Type-check**

Run: `npm run build`
Expected: build succeeds.

- [ ] **Step 4: Manual verification**

Run: `npm run dev`
1. Open the history sidebar. Existing cards should show their thumb with a brief curtain reveal (~500ms) on mount.
2. Scroll down. Newly-visible cards that were offscreen should also animate once as they enter the viewport (they're preloaded, so mostly fast).
3. Drag a card into the dropzone. Verify the full-resolution URL is carried.
4. Click a card. Dialog still opens.

- [ ] **Step 5: Commit**

```bash
git add components/history-sidebar.tsx
git commit -m "feat(history-sidebar): use BlurUpImage for card thumbnails"
```

---

## Task 9: Integrate `<BlurUpImage>` into `ImageDialog`

**Files:**
- Modify: `components/image-dialog.tsx`

This is the most structural change: the `ZoomableImage`'s inner `<img>` becomes `<BlurUpImage>`. Zoom transform moves to the wrapping `<div>`. The external `useCachedImage` call at the `ImageDialog` level is removed (BlurUpImage handles it).

- [ ] **Step 1: Add imports**

Find the existing imports in `image-dialog.tsx`. Add:

```ts
import { BlurUpImage } from "@/components/blur-up-image";
import { thumbUrlForEntry } from "@/lib/history-urls";
```

- [ ] **Step 2: Remove the external `useCachedImage` wiring**

Find this block (currently lines ~216-225):

```ts
  React.useEffect(() => {
    setPreviewSrc(currentEntry.outputUrl);
    triedFallbackRef.current = false;
  }, [currentEntry.outputUrl]);

  // Consult the image-cache for the preview URL. If cached, we render
  // from memory; if not, we fall back to the direct URL which will
  // populate the cache as it loads.
  const cachedPreview = useCachedImage(
    currentEntry.outputUrl && !currentEntry.outputUrl.startsWith("blob:")
      ? currentEntry.outputUrl
      : null
  );
  const effectivePreviewSrc = cachedPreview ?? previewSrc;
```

Change to:

```ts
  React.useEffect(() => {
    setPreviewSrc(currentEntry.outputUrl);
    triedFallbackRef.current = false;
  }, [currentEntry.outputUrl]);

  // BlurUpImage handles its own cache integration via useCachedImage
  // internally; we just pass the logical URL here.
  const effectivePreviewSrc = previewSrc;
```

Also remove the `useCachedImage` import if it is now unused. Check for other usages first via search.

- [ ] **Step 3: Update the `<ZoomableImage>` call to pass thumb and key**

Find the `<ZoomableImage ... />` usage (around line 418). Change:

```tsx
            <ZoomableImage
              src={effectivePreviewSrc}
              alt={currentEntry.prompt}
              originalUrl={effectiveDownloadUrl}
              ...
```

to:

```tsx
            <ZoomableImage
              key={currentEntry.id}
              src={effectivePreviewSrc}
              backdropSrc={thumbUrlForEntry(currentEntry)}
              alt={currentEntry.prompt}
              originalUrl={effectiveDownloadUrl}
              ...
```

The `key` prop forces `ZoomableImage` (and the `BlurUpImage` inside it) to re-mount on each sibling change, which triggers a fresh 400ms reveal for that slide.

- [ ] **Step 4: Extend `ZoomableImageProps` and refactor the `<img>`**

Find `ZoomableImageProps` (around line 486) and the `ZoomableImage` function body (around line 499). We add a `backdropSrc` prop and replace the inner `<img>` with `<BlurUpImage>`.

Before (abbreviated; preserve everything else):

```tsx
interface ZoomableImageProps {
  src: string | undefined;
  alt: string;
  onLoadError: () => void;
  originalUrl?: string;
  downloadFilename?: string;
}

function ZoomableImage({ src, alt, onLoadError, originalUrl, downloadFilename }: ZoomableImageProps) {
  // ... state and handlers ...
  return (
    <div
      // ... wrapper with zoom/pan event handlers ...
    >
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={src}
        alt={alt}
        draggable={false}
        onError={onLoadError}
        className="max-h-[82vh] max-w-[92vw] object-contain"
        style={{
          transform: `translate(${tx}px, ${ty}px) scale(${scale})`,
          transformOrigin: "center center",
          transition: isPanning ? "none" : "transform 120ms ease-out",
          willChange: "transform",
        }}
      />
      {menuPos && ( ... )}
    </div>
  );
}
```

After:

```tsx
interface ZoomableImageProps {
  src: string | undefined;
  /**
   * Optional backdrop (thumb URL) for the blur-up reveal. Passed through
   * to BlurUpImage. Undefined → BlurUpImage uses `src` as its own backdrop.
   */
  backdropSrc?: string;
  alt: string;
  onLoadError: () => void;
  originalUrl?: string;
  downloadFilename?: string;
}

function ZoomableImage({
  src,
  backdropSrc,
  alt,
  onLoadError,
  originalUrl,
  downloadFilename,
}: ZoomableImageProps) {
  // ... state and handlers unchanged ...
  return (
    <div
      // ... wrapper with zoom/pan event handlers unchanged ...
    >
      {/* Zoom/pan transform now lives on this wrapper div so both the
          sharp and backdrop layers transform together. The BlurUpImage
          root is 100% × 100% of this wrapper. */}
      <div
        className="max-h-[82vh] max-w-[92vw]"
        style={{
          transform: `translate(${tx}px, ${ty}px) scale(${scale})`,
          transformOrigin: "center center",
          transition: isPanning ? "none" : "transform 120ms ease-out",
          willChange: "transform",
          // Fixed aspect/sizing is driven by the sharp image's natural
          // dimensions once it loads. Until then, a transparent
          // placeholder sized to max-h/max-w keeps the menu positioned.
        }}
      >
        {src ? (
          <BlurUpImage
            sharpSrc={src}
            backdropSrc={backdropSrc}
            alt={alt}
            fit="natural"
            revealMs={400}
            draggable={false}
            onError={onLoadError}
          />
        ) : null}
      </div>
      {menuPos && ( ... )}
    </div>
  );
}
```

**Why `fit="natural"`:** The dialog needs the image to size itself from its natural dimensions (so zoom/pan math in `ZoomableImage` keeps working). The `"natural"` mode sets the sharp layer to `position: relative; max-width: 100%; max-height: 100%; display: block;` and the root to `display: inline-block`, so the wrapper collapses to the image's intrinsic size, capped by the `max-h-[82vh] max-w-[92vw]` on the transform div. The backdrop stays absolutely positioned behind.

- [ ] **Step 5: Type-check**

Run: `npm run build`
Expected: build succeeds.

- [ ] **Step 6: Manual verification**

Run: `npm run dev`
1. Click a completed generation in Output. Dialog opens. Image should show curtain reveal (~400ms).
2. Press `→` — navigate to next sibling. Fresh curtain reveal plays for that slide.
3. Press `→` rapidly several times. Each reveal plays cleanly; no stutter.
4. Press `←` / `→` to navigate back. Reveal plays each time (remount via `key`).
5. Zoom with scroll wheel and pan by dragging. Both layers should transform together smoothly.
6. Test the onError fallback: open a dialog on an entry where `outputUrl` is valid (normal case). The fallback to `effectiveDownloadUrl` is triggered only on 404, which is hard to reproduce manually — accept that this path is covered by the existing `onLoadError` forwarding in BlurUpImage.
7. If sizing is wrong (dialog empty or image stretched full-wrapper), apply the fallback from Step 4 and document in the commit.

- [ ] **Step 7: Commit**

```bash
git add components/image-dialog.tsx
git commit -m "feat(image-dialog): curtain reveal via BlurUpImage, per-slide remount"
```

---

## Task 10: Full regression sweep + cleanup

**Files:**
- None (manual verification).

- [ ] **Step 1: Manual regression checklist**

Run `npm run dev`. Walk through every item:

- [ ] Generate an image. Output card shows curtain reveal (not modem).
- [ ] Generate concurrently (submit twice back-to-back). Both cards reveal independently; no cross-contamination.
- [ ] Open a second tab to the same app; generate in one. The other tab's Output strip receives the SSE event and shows curtain reveal for the cross-device card.
- [ ] Reload the page. Cross-device cards that load from `serverToday` paint with curtain, not modem.
- [ ] Open the sidebar. Scroll. Cards reveal cleanly.
- [ ] Click a card. Dialog opens with curtain. Arrow-nav fires per-slide reveal.
- [ ] Enable "Emulate CSS prefers-reduced-motion: reduce" in DevTools → Rendering. Generate another image. Animation is a short opacity crossfade (~150ms). No breathing, no curtain.
- [ ] Throttle network to "Slow 4G" (DevTools → Network). Generate an image. Backdrop visible during the wait; curtain fires when sharp finishes loading.
- [ ] Download from Output hover button → full-res file.
- [ ] Drag Output card into dropzone → full-res URL transferred.
- [ ] DevTools → disable cache → reload. Sidebar + Output still paint curtain (not modem). Image-cache still bypasses DevTools cache (regression guard).
- [ ] Light and dark themes both look clean.

- [ ] **Step 2: Final type-check**

Run: `npm run build`
Expected: build succeeds, no warnings introduced.

- [ ] **Step 3: Update `MEMORY.md` progressive-loading note**

Find `C:\Users\admin_korneev\.claude\projects\E--my-stable-viewcomfy-wavespeed-claude\memory\project_future_progressive_loading.md`. Mark it resolved: either delete the file and the pointer in `MEMORY.md`, or update the content to point at the shipped spec.

Recommended minimal edit — replace the body with:

```markdown
---
name: Progressive blur-up loading shipped
description: Curtain-reveal BlurUpImage shipped 2026-04-12 via docs/superpowers/specs/2026-04-12-pretty-image-loading-design.md. Keep this memory as a breadcrumb for the Future Work items in that spec.
type: project
---

Progressive blur-up loading in the Output window shipped on
2026-04-12 as a reusable `<BlurUpImage />` component applied to
Output strip, history sidebar, and ImageDialog.

See `docs/superpowers/specs/2026-04-12-pretty-image-loading-design.md`,
section "Future Work — Detailed Instructions for a Future Agent",
for follow-ups (FW-1 LQIP, FW-2 progressive JPEG, FW-3 dialog
progressive detail, FW-4 remove simulated curtain post-FW-2).
```

And update the one-line hook in `MEMORY.md` to reflect the shipped state.

- [ ] **Step 4: Final commit**

```bash
git add -A
git commit -m "chore(memory): mark progressive blur-up as shipped"
```

---

## Success criteria (re-stated from spec)

- No line-by-line JPEG paint visible in any of the three call sites on cold or warm load
- Under `prefers-reduced-motion: reduce`, animation total ≤ 150ms
- Bundle size increase ≤ 2 KB gzipped (one small component + CSS)
- No visible flash when `outputUrl` swaps from provider URL to blob mid URL during generation
- Dialog arrow-nav: no stutter on rapid presses
- All existing drag-drop / download / keyboard-nav behaviors preserved
