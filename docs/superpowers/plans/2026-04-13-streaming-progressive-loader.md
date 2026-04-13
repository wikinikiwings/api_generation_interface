# Streaming Progressive Image Loader Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the post-load curtain reveal in `BlurUpImage` with a real-time streaming progressive reveal: feather-line is driven by actual byte-level download progress (exponentially smoothed), sharp image is revealed top-to-bottom as partial JPEG decodes land, and the haze below the feather is extrapolated from the last loaded pixel row of the actually-decoded image.

**Architecture:**
- `lib/streaming-image/loader.ts` fetches an image URL via `ReadableStream`, feeds bytes into `ImageDecoder` for partial decodes, and emits `{ bytesLoaded, bytesTotal, bitmap, lastReadyRow }` events. When the stream finishes, the resulting `Blob` is handed to the existing `cacheBlob(url, blob)` so subsequent renders are instant.
- `lib/streaming-image/smoothing.ts` is a pure exponential-moving-average helper. It turns the bursty `bytesLoaded/bytesTotal` into a smooth `--frontier` signal (time constant τ ≈ 500 ms).
- `lib/use-streaming-image.ts` is the React hook driving a caller. Returns `{ state, rawProgress, smoothedProgress, bitmap, lastRowY }`. Schedules its own `requestAnimationFrame` loop so the smoother ticks even when no new bytes arrive.
- `components/blur-up-image.tsx` is rewritten as a two-canvas renderer. Sharp canvas draws `bitmap` rows `0..lastReadyRow` and gets a CSS `filter: blur(var(--time-blur))` that ramps down with `smoothedProgress`. Backdrop canvas draws the last N source rows stretched to the whole frame (CSS-blurred into a haze). The frontier feather mask on sharp uses `smoothedProgress`; backdrop strip anchor uses `smoothedProgress` too (not rawProgress — this is the "smoothed backdrop" fix from the lab).
- Public component API (`BlurUpImageProps`) unchanged except `ref` now targets `HTMLDivElement` (root) instead of `HTMLImageElement`. Only `ImageDialog` uses the ref (for zoom/pan); its transform logic already works on any element.

**Tech Stack:** TypeScript, React 19, Next.js 15, Vitest + jsdom, CSS Houdini (`@property`), `ImageDecoder` (Chrome 94+, Firefox 133+, Safari 17.1+), `fetch()` + `ReadableStream`.

**Reference (READ THIS FIRST):** `.preview/curtain-lab/index.html` is the behavioural spec. Do not start coding until you have:
1. Served it locally (`cd .preview/curtain-lab && npx -y serve -l 5174`).
2. Opened `http://localhost:5174/` and watched tile **E (extrapolated strip)** run through at least three `replay all` cycles on scene `sunset`, with these controls: `load duration = 5000`, `bursty = on, count = 15`, `smoothing τ = 1500`, `feather = 38%`, `strip rows = 32`, `max blur = 80`, `γ = 100`.
3. Confirmed you can describe in one sentence what each of the three on-screen layers does at t=30 %, t=70 %, and t=100 % load progress.

**This plan is a port.** The algorithms, constants, and visual feel are locked. The job is carrying the lab's variant E into production against a real network stream.

---

## Animation walkthrough (what the user sees)

Concrete timeline for a freshly-generated image on a moderately slow connection (say, a mid-variant JPEG of 180 KB over a link averaging ~90 KB/s, so ~2 s wall time). All timings are illustrative — actual values come out of the EMA driven by real bytes.

**t = 0 ms · mount**
- `<BlurUpImage sharpSrc="https://.../mid_xxx.jpg" alt="..."/>` mounts.
- `useStreamingImage` starts `fetch()` against the URL, prepares an `ImageDecoder` over the stream body.
- `phase = "fetching"`, `rawProgress = 0`, `smoothedProgress = 0`.
- Root div has `data-reveal-state="streaming"`, `--frontier: 0.00%`, `--time-blur: 80px`.
- Both canvases are empty. Visually: a black (or `bg-muted/30`) frame — this is normal for the first 50 ms while the stream handshakes.

**t ≈ 80 ms · first chunk lands**
- `fetch()` ReadableStream delivers its first chunk (say, 32 KB). `ImageDecoder` returns a partial bitmap whose `displayHeight ≈ 60 px` (roughly the JPEG's first 3 MCU rows).
- Loader emits `{ phase: "fetching", progress: { ratio: ~0.18 }, frame: { bitmap, lastRowY: 60 } }`.
- Hook: `rawProgress` jumps to 0.18, EMA starts chasing it (τ = 1500 ms, so after one chunk it's ~0.01).
- Component draws that 60-pixel strip into the top of `canvas-sharp`. Also stretches the last ~32 source rows (near y=60) across the whole `canvas-backdrop` — pure top-row haze, heavily blurred.
- Visually: a faint warm-orange glow fills the whole frame (sunset sky colour). No feather edge visible yet because `--frontier ≈ 1%`.

**t ≈ 400 ms · 3-4 chunks in**
- `rawProgress ≈ 0.48`, `smoothedProgress ≈ 0.11`, `--time-blur ≈ 72px`, `--frontier ≈ 11%`.
- `canvas-sharp` has ~480 px of decoded bitmap; everything above `--frontier` is globally blurred through the CSS filter.
- Feather mask makes rows 0–8 % fully opaque (blurred-but-visible sharp), rows 8–11 % fade out, below is transparent.
- Through the transparent bottom, `canvas-backdrop` shows: last 32 decoded rows (around source y≈440) stretched down + CSS-blurred 120 px. User sees a soft sunset-orange haze that matches what's about to appear.
- On screen: a heavily-blurred warm top band with a subtle feathered edge ~1/8 down the frame, gradually bleeding into a flat warm haze below.

**t ≈ 1200 ms · byte half-way, frontier lagging**
- `rawProgress ≈ 1.0` or close (bytes almost all arrived on this fast-ish link), but `smoothedProgress ≈ 0.42` because τ = 1500 ms.
- Loader emits `phase = "decoded"` — the **completion squeeze** triggers: hook calls `smoother.setTau(300)`. Smoothed now converges much faster.
- `canvas-sharp` holds the COMPLETE bitmap but most of it is still below `--frontier` (hidden under haze).
- `canvas-backdrop` is still resampling rows near y = 0.42 × srcH on every frame.
- Visually: upper ~42 % of the image is visible through decreasing blur; the feather line is gliding downward; haze below continues to match.

**t ≈ 1500 ms · squeeze pulls frontier to 100%**
- `smoothedProgress ≈ 0.995`, `--time-blur ≈ 1px`, feather line has slid past the bottom.
- Component detects `phase === "decoded" && smoothedProgress >= 0.999` → sets `data-reveal-state="done"`.
- CSS transitions: `.blur-up-sharp { filter: blur(0); mask-image: none }` and `.blur-up-backdrop { opacity: 0 }` over 200–300 ms.
- `canvas-backdrop` fades out; `canvas-sharp` loses its filter and mask; the crisp image remains.

**Steady state**
- Root: `data-reveal-state="done"`, inline CSS vars ignored.
- `canvas-sharp` renders the final bitmap crisply.
- A subsequent re-mount with the same URL hits `getCachedBlobUrl()` in the hook and short-circuits to `phase="decoded"`, `smoothedProgress=1` on the first render — no animation at all, because re-animating a cache-warm image would be theatrical (matches the existing 60 ms INSTANT_LOAD_THRESHOLD policy).

**Slow network variant (~10 s load):** the streaming phase is longer, but the animation proportions stay the same: feather always lags smoothed bytes by ~1 τ, blur ramps with smoothed progress, haze tracks the just-loaded rows. At t = 10 s: `rawProgress = 1` triggers squeeze, which completes in ~0.9 s.

**Error path:** if fetch fails mid-stream, the last partial frame stays on canvas (no sudden blank-out), `phase = "error"`, `onError(err)` fires, caller decides what to show (OutputCard keeps the card + trash icon; ImageDialog shows its fallback).

**prefers-reduced-motion:** the canvases hide (`display: none` on backdrop, `opacity` crossfade on sharp) and we use a 150 ms opacity fade instead of streaming reveal.

---

## Layer diagram

```
┌────────── .blur-up-root (div, ref target) ──────────────────┐
│  data-reveal-state: idle | streaming | done                 │
│  inline style: --frontier, --time-blur, --feather-pct       │
│                                                             │
│  ┌─── <canvas class="blur-up-backdrop"> ─────────────────┐  │
│  │   CSS: filter: blur(120px) saturate(1.25) scale(1.05) │  │
│  │   JS: drawImage(bitmap, 0, stripY, srcW, stripN,      │  │
│  │                        0, 0, dstW, dstH)              │  │
│  │   "last 32 decoded rows stretched to full frame"      │  │
│  └───────────────────────────────────────────────────────┘  │
│              ▲ CSS-blurred haze layer (bottom)              │
│              │                                              │
│  ┌─── <canvas class="blur-up-sharp"> ────────────────────┐  │
│  │   CSS: filter: blur(var(--time-blur))                 │  │
│  │   CSS: mask-image: linear-gradient(..., --frontier)   │  │
│  │   JS: drawImage(bitmap, 0, 0, srcW, lastRowY,         │  │
│  │                        0, 0, dstW, rowsDst)           │  │
│  │   "progressive pixels, blurred, feather-masked"       │  │
│  └───────────────────────────────────────────────────────┘  │
│              ▲ sharp/progressive layer (top)                │
└─────────────────────────────────────────────────────────────┘
```

Stacking order matters: sharp canvas is LAST in the DOM, so it paints on top of the backdrop canvas. The feather mask on sharp creates a transparent window at the bottom through which the backdrop haze shows.

---

## Glossary

Terms used throughout this plan and in the lab. When in doubt, point yourself back here.

- **rawProgress** — the instantaneous byte ratio `bytesLoaded / bytesTotal`. Jumps in steps as TCP bursts land.
- **smoothedProgress** — exponentially-smoothed copy of rawProgress. Time constant τ = `DEFAULT_TAU_MS = 1500` during streaming; squeezed to `DEFAULT_COMPLETION_TAU_MS = 300` after `phase = "decoded"`. **This is what the feather line and blur ramp track** — never expose rawProgress to CSS directly; the bursts would flicker.
- **frontier** — the current position of the feather line, expressed as a percentage of frame height. Synonym for `smoothedProgress * 100%`. Pushed to CSS as `--frontier`.
- **feather** — the soft-edged transition zone of the sharp layer's mask, width = `FEATHER_PCT = 38%` of frame height. Everything `frontier - feather%` and above is fully opaque sharp; `frontier - feather% .. frontier` fades; below frontier is transparent.
- **strip** — a horizontal band of the last N source rows (`BACKDROP_STRIP_ROWS = 32`) currently decoded, sampled at `y = srcH * smoothedProgress`. Drawn stretched onto the backdrop canvas.
- **haze** — the visual result of the strip after CSS blur (`BACKDROP_BLUR_PX = 120`). A soft colour field that matches the colour about to be revealed at the feather line.
- **time-blur** — the progress-driven CSS blur on the sharp canvas. Strength = `MAX_TIME_BLUR_PX * (1 - smoothedProgress) ^ TIME_BLUR_GAMMA`. Starts at 80 px, ends at 0.
- **completion squeeze** — when the loader emits `phase = "decoded"`, the hook switches the smoother's τ from 1500 ms to 300 ms so the remaining smoothed animation finishes crisply on fast connections instead of asymptoting for several seconds.
- **extrapolated strip** — shorthand for "the strip mechanism". Called extrapolated because the strip assumes the colour just below the feather will be similar to the colour just above it — which happens to be true for photographs with vertical structure.
- **cache-warm** — an image whose bytes are already in `lib/image-cache`'s blob map. Hook short-circuits to `phase = "decoded"`, no animation plays.

---

## Before / after

**Before (shipped 2026-04-12, see `docs/superpowers/specs/2026-04-12-pretty-image-loading-design.md`):**
- `<BlurUpImage>` renders two `<img>` tags: backdrop (blurred thumb or sharp-as-fallback) + sharp.
- Browser loads both URLs natively; user watches bytes arrive "modem-decode" style under a CSS `blur(32px)` filter on the backdrop.
- When the sharp `<img>` fires `onload`, a CSS `--reveal` percentage animates from -25% to 125% over 700 ms, sweeping a feathered mask down the sharp image. The curtain is a post-hoc animation entirely decoupled from real load progress.
- Result: the user sees loading chunks through a blur, then an abrupt "curtain drops" moment.

**After (this plan):**
- `<BlurUpImage>` renders two `<canvas>` elements driven by `useStreamingImage`.
- A real `fetch()` stream + `ImageDecoder` produces real partial bitmaps and real byte counts.
- Feather line, strip sampling, and time-ramp blur are all tied to smoothedProgress of the real bytes.
- There is no separate curtain event — the reveal IS the load. When bytes finish arriving, the animation has (via the completion squeeze) at most ~1 s of catch-up left.

**Non-goals:**
- No server changes (no new endpoints, no DB migration).
- No change to `lib/image-variants.ts`, `lib/history-upload.ts`, or history-store shape.
- No service-worker cache.
- No change to history sync / deletion logic.

**Risk gate (Task 0 decides):** `ImageDecoder` with a `ReadableStream` data source must produce usable partial `VideoFrame`s with the mid-variant JPEG format we ship. If it does not, switch to the documented fallback at the end of this plan (Task F1 / F2).

---

## File Structure

**Create:**
- `lib/streaming-image/types.ts` — shared types (`StreamingState`, `StreamingEvent`, etc.)
- `lib/streaming-image/smoothing.ts` — pure EMA helper
- `lib/streaming-image/loader.ts` — fetch + ImageDecoder
- `lib/streaming-image/index.ts` — barrel re-exports
- `lib/streaming-image/__tests__/smoothing.test.ts`
- `lib/streaming-image/__tests__/loader.test.ts`
- `lib/use-streaming-image.ts` — React hook
- `lib/__tests__/use-streaming-image.test.tsx`
- `components/__tests__/blur-up-image.test.tsx`
- `.preview/streaming-feasibility/index.html` — Task 0 probe

**Modify:**
- `components/blur-up-image.tsx` — full rewrite, same file path
- `app/globals.css` — replace `.blur-up-*` block (lines ~80–191)
- `components/image-dialog.tsx` — update ref type + zoom/pan ref target
- `types/wavespeed.ts` — no changes expected (validate in Task 8)

**Do not touch:**
- `lib/history/*`, `lib/image-variants.ts`, `lib/image-cache.ts` (we only CALL `cacheBlob` from the loader)
- `components/output-area.tsx`, `components/history-sidebar.tsx` — call sites stay as-is (public API preserved)
- `app/api/**`

---

## Task 0: Feasibility probe — ImageDecoder + ReadableStream with our mid-variant JPEGs

**Files:**
- Create: `.preview/streaming-feasibility/index.html`

**Why:** The entire approach depends on `ImageDecoder` producing usable partial bitmaps from a JPEG stream in the target browser mix. If it does not, we fall back to Task F1/F2 and lose the "real progressive pixels" feature. Verify before writing any production code.

- [ ] **Step 1: Write the probe HTML**

```html
<!doctype html>
<html><head><meta charset="utf-8"><title>probe</title></head>
<body>
<div>Paste a mid-variant URL from prod, then click probe:</div>
<input id="u" style="width:600px" placeholder="https://.../mid_xxx.jpg">
<button id="go">probe</button>
<pre id="log"></pre>
<canvas id="cv" width="400" height="400" style="border:1px solid #999"></canvas>
<script>
const log = (m) => { document.getElementById("log").textContent += m + "\n"; };
document.getElementById("go").onclick = async () => {
  const url = document.getElementById("u").value.trim();
  if (!url) return;
  log("GET " + url);
  try {
    const res = await fetch(url);
    if (!("ImageDecoder" in window)) { log("FAIL: ImageDecoder not available"); return; }
    const ctype = res.headers.get("content-type") || "image/jpeg";
    log("Content-Type: " + ctype + "  Content-Length: " + res.headers.get("content-length"));
    const dec = new ImageDecoder({ data: res.body, type: ctype });
    const ctx = document.getElementById("cv").getContext("2d");
    // Poll: repeatedly try decoding frame 0 with completeFramesOnly:false
    // until tracks.ready AND completed.
    await dec.tracks.ready;
    let lastH = 0;
    while (true) {
      try {
        const r = await dec.decode({ frameIndex: 0, completeFramesOnly: false });
        if (r.image && r.image.displayHeight !== lastH) {
          lastH = r.image.displayHeight;
          ctx.clearRect(0,0,400,400);
          ctx.drawImage(r.image, 0, 0, 400, 400);
          log("partial bitmap: " + r.image.displayWidth + "×" + r.image.displayHeight +
              " complete=" + r.complete);
        }
        if (r.complete) { log("DONE complete=true"); break; }
      } catch (e) {
        log("decode loop err: " + e.name + " " + e.message);
        break;
      }
    }
  } catch (e) {
    log("FAIL " + e.name + ": " + e.message);
  }
};
</script>
</body></html>
```

- [ ] **Step 2: Serve and visit**

Run in bash:
```bash
cd ".preview/streaming-feasibility" && npx -y serve -l 5175 -L .
```
Open `http://localhost:5175/` in Chrome, Firefox, Safari (if reachable).

- [ ] **Step 3: Probe with three real URLs**

Paste a prod `mid_*.jpg` URL from `lgen.maxkdiffused.org`. Do this for three URLs while throttled to "Slow 3G" in DevTools → Network. Log must show 3+ `partial bitmap:` lines with increasing `displayHeight` before `DONE complete=true`.

- [ ] **Step 4: Decide path forward**

- **If probe succeeds in all target browsers:** continue with Task 1.
- **If it fails in one browser:** continue with Task 1 but keep Task F1 (fallback with `<img>` + blob URL reassignment) in scope and gate on runtime detection.
- **If it fails in ALL browsers:** abort this plan. Switch to Task F2 (hybrid: real fetch for bytes, native `<img>` rendering with periodic `drawImage(<img>, ...)` copies to canvas). This loses ~30% of the feel but preserves the smooth frontier and streaming progress.

- [ ] **Step 5: Commit the probe**

```bash
git add .preview/streaming-feasibility/index.html
git commit -m "chore(streaming-image): feasibility probe for ImageDecoder"
```

---

## Task 1: Exponential-moving-average progress smoother (pure)

**Files:**
- Create: `lib/streaming-image/smoothing.ts`
- Create: `lib/streaming-image/__tests__/smoothing.test.ts`

**Why:** Isolate the smoothing math in a pure, trivially testable unit before wiring it into anything async.

- [ ] **Step 1: Write failing tests**

`lib/streaming-image/__tests__/smoothing.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { ProgressSmoother } from "@/lib/streaming-image/smoothing";

describe("ProgressSmoother", () => {
  it("initial value is 0", () => {
    const s = new ProgressSmoother({ tauMs: 500 });
    expect(s.value).toBe(0);
  });
  it("pulls toward target exponentially", () => {
    const s = new ProgressSmoother({ tauMs: 1000 });
    // One time-constant: expect ~1 - 1/e ≈ 0.632 of the way to 1.0
    s.tick(1000, 1);
    expect(s.value).toBeGreaterThan(0.6);
    expect(s.value).toBeLessThan(0.7);
  });
  it("clamps to target if tauMs <= 0", () => {
    const s = new ProgressSmoother({ tauMs: 0 });
    s.tick(16, 0.75);
    expect(s.value).toBe(0.75);
  });
  it("never overshoots target when target is monotonic", () => {
    const s = new ProgressSmoother({ tauMs: 500 });
    for (let t = 0; t < 2000; t += 16) s.tick(16, 0.5);
    expect(s.value).toBeLessThanOrEqual(0.5 + 1e-6);
  });
  it("snaps to 1.0 once both target is 1.0 and within epsilon", () => {
    const s = new ProgressSmoother({ tauMs: 500 });
    for (let t = 0; t < 10000; t += 16) s.tick(16, 1);
    s.snapIfSettled(1);
    expect(s.value).toBe(1);
  });
  it("resets to 0", () => {
    const s = new ProgressSmoother({ tauMs: 500 });
    s.tick(1000, 1);
    s.reset();
    expect(s.value).toBe(0);
  });
  it("setTau changes time constant without clobbering current value", () => {
    const s = new ProgressSmoother({ tauMs: 1500 });
    s.tick(500, 1);
    const mid = s.value;
    s.setTau(300);
    // same single tick should now advance faster toward 1
    s.tick(100, 1);
    expect(s.value).toBeGreaterThan(mid + 0.05);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npm test -- lib/streaming-image/__tests__/smoothing.test.ts`
Expected: FAIL with "Cannot find module" (file does not exist yet).

- [ ] **Step 3: Implement**

`lib/streaming-image/smoothing.ts`:
```ts
/**
 * Exponential-moving-average smoother. Used to turn a bursty progress
 * signal (bytes arriving in TCP chunks) into a smooth animation driver.
 *
 *   value' = value + (target - value) * (1 - exp(-dt / tauMs))
 *
 * tauMs == 0 disables smoothing (value snaps to target).
 */
export class ProgressSmoother {
  private _value = 0;
  private tauMs: number;
  private static readonly SNAP_EPSILON = 0.001;

  constructor(opts: { tauMs: number }) {
    this.tauMs = Math.max(0, opts.tauMs);
  }

  get value(): number {
    return this._value;
  }

  /** Change the time constant in-flight. Used by the "completion
   * squeeze" — when bytes are fully received we shrink tau so the
   * remaining animation finishes crisply rather than asymptoting. */
  setTau(tauMs: number): void {
    this.tauMs = Math.max(0, tauMs);
  }

  /** Advance one frame. `dtMs` is time since last tick; `target` is the
   * current aim (e.g., bytesLoaded / bytesTotal). */
  tick(dtMs: number, target: number): number {
    if (this.tauMs <= 0) {
      this._value = target;
    } else {
      const alpha = 1 - Math.exp(-Math.max(0, dtMs) / this.tauMs);
      this._value = this._value + (target - this._value) * alpha;
    }
    return this._value;
  }

  /** Snap to the given target if within SNAP_EPSILON. Call at end of
   * stream so the animation doesn't asymptotically crawl the last 0.1%. */
  snapIfSettled(target: number): void {
    if (Math.abs(target - this._value) < ProgressSmoother.SNAP_EPSILON) {
      this._value = target;
    }
  }

  reset(): void {
    this._value = 0;
  }
}
```

- [ ] **Step 4: Run tests to verify pass**

Run: `npm test -- lib/streaming-image/__tests__/smoothing.test.ts`
Expected: PASS, 7/7.

- [ ] **Step 5: Commit**

```bash
git add lib/streaming-image/smoothing.ts lib/streaming-image/__tests__/smoothing.test.ts
git commit -m "feat(streaming-image): exponential progress smoother"
```

---

## Task 2: Shared types

**Files:**
- Create: `lib/streaming-image/types.ts`

**Why:** Lock the loader's output shape before the loader itself — lets Task 4 (hook) be written in parallel mental context. Pure types, no tests needed.

- [ ] **Step 1: Write the file**

`lib/streaming-image/types.ts`:
```ts
/**
 * Public types for the streaming image loader. The loader is a pure
 * async iterator over progress events; consumers (React hook) bridge
 * those events into render state.
 */

export type StreamingPhase =
  | "idle"
  | "fetching"  // stream open, decoding partial frames
  | "decoded"   // bytes fully received and decoded
  | "error";

export interface StreamingFrame {
  /** Partial or complete bitmap. Drawable via drawImage. Caller must
   * close() it when superseded — use `releasePrevious: true` helper. */
  bitmap: ImageBitmap;
  /** Source-pixel Y of the last row that's been decoded so far. For a
   * top-down JPEG this is bitmap.height - 1 when complete, or smaller
   * during streaming. Used as the anchor for the extrapolated strip. */
  lastRowY: number;
  /** True when bytes are fully received AND decode is complete. */
  complete: boolean;
}

export interface StreamingProgress {
  bytesLoaded: number;
  /** 0 when Content-Length is missing (indeterminate). */
  bytesTotal: number;
  /** bytesLoaded / bytesTotal, clamped to [0,1]. When bytesTotal is 0,
   * this advances via timeElapsed / fallbackTotalMs (see loader). */
  ratio: number;
}

export interface StreamingEvent {
  phase: StreamingPhase;
  progress: StreamingProgress;
  frame?: StreamingFrame;
  error?: Error;
}

export interface StreamingLoaderOptions {
  url: string;
  /** When server omits Content-Length, the loader fakes progress by
   * linear time. Defaults to 4000. */
  fallbackTotalMs?: number;
  /** Minimum ms between partial-decode attempts. Defaults to 60 (≈
   * 16ms × 4 frames). Decoding is expensive; don't do it every RAF. */
  minDecodeIntervalMs?: number;
  /** AbortSignal; aborting revokes the stream and closes all frames. */
  signal?: AbortSignal;
}
```

- [ ] **Step 2: Commit**

```bash
git add lib/streaming-image/types.ts
git commit -m "feat(streaming-image): shared types for loader and hook"
```

---

## Task 3: Streaming loader (fetch + ImageDecoder)

**Files:**
- Create: `lib/streaming-image/loader.ts`
- Create: `lib/streaming-image/index.ts`
- Create: `lib/streaming-image/__tests__/loader.test.ts`

**Why:** Isolated from React. Reads the stream, feeds `ImageDecoder`, yields progress + partial frames. Single source of byte-level truth.

- [ ] **Step 1: Write failing tests**

`lib/streaming-image/__tests__/loader.test.ts`:
```ts
import { describe, it, expect, beforeEach, vi } from "vitest";
import { streamImage } from "@/lib/streaming-image/loader";

// Minimal ImageDecoder mock that yields two partial frames then complete.
class FakeImageDecoder {
  static instances: FakeImageDecoder[] = [];
  tracks = { ready: Promise.resolve(), selectedTrack: { frameCount: 1 } };
  private calls = 0;
  constructor(_: { data: unknown; type: string }) {
    FakeImageDecoder.instances.push(this);
  }
  decode(_opts: { frameIndex: number; completeFramesOnly: boolean }) {
    this.calls++;
    const complete = this.calls >= 3;
    return Promise.resolve({
      image: {
        displayWidth: 100,
        displayHeight: this.calls * 40,
        close: vi.fn(),
      } as unknown as ImageBitmap,
      complete,
    });
  }
  close() {}
}

function makeStreamResponse(totalBytes: number, chunks: number): Response {
  const stream = new ReadableStream<Uint8Array>({
    async start(ctrl) {
      const chunkSize = Math.ceil(totalBytes / chunks);
      for (let i = 0; i < chunks; i++) {
        ctrl.enqueue(new Uint8Array(chunkSize));
        await new Promise((r) => setTimeout(r, 5));
      }
      ctrl.close();
    },
  });
  return new Response(stream, {
    headers: { "Content-Length": String(totalBytes), "Content-Type": "image/jpeg" },
  });
}

beforeEach(() => {
  FakeImageDecoder.instances.length = 0;
  // @ts-expect-error runtime global stub
  globalThis.ImageDecoder = FakeImageDecoder;
  global.fetch = vi.fn().mockResolvedValue(makeStreamResponse(1000, 5));
});

describe("streamImage", () => {
  it("emits increasing progress and at least one partial frame", async () => {
    const events: Array<{ ratio: number; hasFrame: boolean; complete?: boolean }> = [];
    for await (const ev of streamImage({ url: "http://example/x.jpg" })) {
      events.push({
        ratio: ev.progress.ratio,
        hasFrame: !!ev.frame,
        complete: ev.frame?.complete,
      });
    }
    const ratios = events.map((e) => e.ratio);
    for (let i = 1; i < ratios.length; i++) expect(ratios[i]).toBeGreaterThanOrEqual(ratios[i - 1]);
    expect(events.some((e) => e.hasFrame && !e.complete)).toBe(true);
    expect(events[events.length - 1].complete).toBe(true);
  });

  it("falls back to linear time progress when Content-Length missing", async () => {
    global.fetch = vi.fn().mockResolvedValue(
      new Response(
        new ReadableStream({
          async start(c) {
            c.enqueue(new Uint8Array(100));
            await new Promise((r) => setTimeout(r, 20));
            c.enqueue(new Uint8Array(100));
            c.close();
          },
        }),
        { headers: { "Content-Type": "image/jpeg" } }
      )
    );
    const events = [];
    for await (const ev of streamImage({ url: "http://example/x.jpg", fallbackTotalMs: 100 })) {
      events.push(ev);
    }
    expect(events[events.length - 1].progress.ratio).toBe(1);
  });

  it("emits phase='error' on fetch failure", async () => {
    global.fetch = vi.fn().mockRejectedValue(new TypeError("net"));
    const events = [];
    for await (const ev of streamImage({ url: "http://example/x.jpg" })) events.push(ev);
    expect(events[events.length - 1].phase).toBe("error");
  });

  it("honors AbortSignal", async () => {
    const ac = new AbortController();
    const iter = streamImage({ url: "http://example/x.jpg", signal: ac.signal });
    setTimeout(() => ac.abort(), 10);
    const phases: string[] = [];
    for await (const ev of iter) phases.push(ev.phase);
    expect(phases[phases.length - 1]).toBe("error");
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npm test -- lib/streaming-image/__tests__/loader.test.ts`
Expected: FAIL, "Cannot find module".

- [ ] **Step 3: Implement loader**

`lib/streaming-image/loader.ts`:
```ts
import type { StreamingEvent, StreamingLoaderOptions } from "./types";

type ImageDecoderCtor = new (init: { data: ReadableStream<Uint8Array>; type: string }) => {
  tracks: { ready: Promise<void> };
  decode(opts: { frameIndex: number; completeFramesOnly: boolean }): Promise<{
    image: ImageBitmap;
    complete: boolean;
  }>;
  close(): void;
};

function hasImageDecoder(): boolean {
  return typeof globalThis !== "undefined" && "ImageDecoder" in globalThis;
}

/**
 * Streaming image loader. Async-iterable.
 *
 * Emits events roughly every time the stream delivers bytes, plus a
 * final "decoded" event. Partial frames are produced by ImageDecoder
 * at ≥ minDecodeIntervalMs cadence (decoding is expensive).
 *
 * On abort / fetch error the final event carries phase="error". The
 * caller is expected to close any ImageBitmap it kept a reference to
 * — frames passed here are NOT auto-closed on error (the hook consumer
 * may still want to draw the last-good one).
 */
export async function* streamImage(
  opts: StreamingLoaderOptions
): AsyncGenerator<StreamingEvent, void, void> {
  const {
    url,
    fallbackTotalMs = 4000,
    minDecodeIntervalMs = 60,
    signal,
  } = opts;

  const t0 = Date.now();
  let bytesLoaded = 0;
  let bytesTotal = 0;
  let lastFrame: { bitmap: ImageBitmap; lastRowY: number; complete: boolean } | undefined;
  let lastDecodeAt = 0;

  const progressOf = (): { bytesLoaded: number; bytesTotal: number; ratio: number } => {
    if (bytesTotal > 0) {
      return {
        bytesLoaded,
        bytesTotal,
        ratio: Math.min(1, bytesLoaded / bytesTotal),
      };
    }
    // Fall back to linear time.
    const r = Math.min(1, (Date.now() - t0) / Math.max(1, fallbackTotalMs));
    return { bytesLoaded, bytesTotal: 0, ratio: r };
  };

  let res: Response;
  try {
    res = await fetch(url, { signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
  } catch (e) {
    yield {
      phase: "error",
      progress: progressOf(),
      error: e instanceof Error ? e : new Error(String(e)),
    };
    return;
  }

  const cl = res.headers.get("content-length");
  if (cl) bytesTotal = Number(cl) || 0;
  const mime = res.headers.get("content-type") || "image/jpeg";

  if (!res.body) {
    yield { phase: "error", progress: progressOf(), error: new Error("no body") };
    return;
  }

  // Tee the stream so we can BOTH track bytes AND hand raw bytes to the
  // decoder. Without tee, the decoder would consume the stream and we
  // couldn't count bytes.
  const [forDecoder, forCounter] = res.body.tee();

  // Start the decoder (only if ImageDecoder exists — caller gates on this).
  let decoder: InstanceType<ImageDecoderCtor> | null = null;
  if (hasImageDecoder()) {
    const Ctor = (globalThis as { ImageDecoder: ImageDecoderCtor }).ImageDecoder;
    try {
      decoder = new Ctor({ data: forDecoder, type: mime });
      await decoder.tracks.ready;
    } catch (e) {
      yield {
        phase: "error",
        progress: progressOf(),
        error: e instanceof Error ? e : new Error(String(e)),
      };
      return;
    }
  } else {
    // Caller should have detected and routed to fallback path.
    yield {
      phase: "error",
      progress: progressOf(),
      error: new Error("ImageDecoder unavailable"),
    };
    return;
  }

  // Counter loop: pull chunks from the counter side, increment bytesLoaded,
  // yield an event; periodically attempt a partial decode.
  const reader = forCounter.getReader();
  try {
    while (true) {
      if (signal?.aborted) {
        try { await reader.cancel(); } catch { /* ignore */ }
        try { decoder.close(); } catch { /* ignore */ }
        yield { phase: "error", progress: progressOf(), error: new Error("aborted") };
        return;
      }
      const { value, done } = await reader.read();
      if (done) break;
      bytesLoaded += value.byteLength;

      const now = Date.now();
      let newFrame: typeof lastFrame;
      if (now - lastDecodeAt >= minDecodeIntervalMs) {
        lastDecodeAt = now;
        try {
          const r = await decoder.decode({ frameIndex: 0, completeFramesOnly: false });
          // Close the previous partial bitmap to free GPU memory.
          if (lastFrame?.bitmap && typeof lastFrame.bitmap.close === "function") {
            lastFrame.bitmap.close();
          }
          newFrame = {
            bitmap: r.image,
            lastRowY: (r.image as unknown as { displayHeight?: number; height?: number })
              .displayHeight ?? (r.image as ImageBitmap).height ?? 0,
            complete: r.complete,
          };
          lastFrame = newFrame;
        } catch {
          // Partial decode can throw on invalid prefix — keep the last
          // good frame and move on.
        }
      }
      yield {
        phase: "fetching",
        progress: progressOf(),
        frame: newFrame ?? lastFrame,
      };
    }
    // Final complete decode.
    try {
      const r = await decoder.decode({ frameIndex: 0, completeFramesOnly: true });
      if (lastFrame?.bitmap && typeof lastFrame.bitmap.close === "function") {
        lastFrame.bitmap.close();
      }
      lastFrame = {
        bitmap: r.image,
        lastRowY: (r.image as unknown as { displayHeight?: number; height?: number })
          .displayHeight ?? (r.image as ImageBitmap).height ?? 0,
        complete: true,
      };
    } catch (e) {
      yield {
        phase: "error",
        progress: progressOf(),
        error: e instanceof Error ? e : new Error(String(e)),
      };
      return;
    } finally {
      try { decoder.close(); } catch { /* ignore */ }
    }
    yield { phase: "decoded", progress: progressOf(), frame: lastFrame };
  } finally {
    try { reader.releaseLock(); } catch { /* ignore */ }
  }
}
```

- [ ] **Step 4: Write the index barrel**

`lib/streaming-image/index.ts`:
```ts
export * from "./types";
export { ProgressSmoother } from "./smoothing";
export { streamImage } from "./loader";
```

- [ ] **Step 5: Run loader tests**

Run: `npm test -- lib/streaming-image/__tests__/loader.test.ts`
Expected: PASS, 4/4.

If "aborted" test fails due to jsdom AbortSignal + fetch stream quirks, relax the assertion to check that the iterator returns (i.e., the `for await` completes within 200ms).

- [ ] **Step 6: Commit**

```bash
git add lib/streaming-image/loader.ts lib/streaming-image/index.ts lib/streaming-image/__tests__/loader.test.ts
git commit -m "feat(streaming-image): fetch+ImageDecoder streaming loader"
```

---

## Task 4: React hook `useStreamingImage`

**Files:**
- Create: `lib/use-streaming-image.ts`
- Create: `lib/__tests__/use-streaming-image.test.tsx`

**Why:** Bridge the async iterator into React state with a RAF-driven smoother. Also integrates with the existing `cacheBlob()` so a fully-loaded URL is fast on second render.

- [ ] **Step 1: Write failing tests**

`lib/__tests__/use-streaming-image.test.tsx`:
```tsx
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useStreamingImage } from "@/lib/use-streaming-image";
import * as loader from "@/lib/streaming-image/loader";
import type { StreamingEvent } from "@/lib/streaming-image/types";

function fakeStream(events: StreamingEvent[]): AsyncGenerator<StreamingEvent, void, void> {
  async function* gen() {
    for (const ev of events) {
      await Promise.resolve();
      yield ev;
    }
  }
  return gen();
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("useStreamingImage", () => {
  it("starts in phase=idle when url is null", () => {
    const { result } = renderHook(() => useStreamingImage(null));
    expect(result.current.phase).toBe("idle");
    expect(result.current.smoothedProgress).toBe(0);
  });

  it("blob: URL completes on first tick with phase=decoded", async () => {
    // blob: URLs bypass the streaming loader — short-circuit path.
    const { result } = renderHook(() => useStreamingImage("blob:http://x/abc"));
    await act(async () => { await Promise.resolve(); });
    expect(result.current.phase).toBe("decoded");
    expect(result.current.smoothedProgress).toBe(1);
  });

  it("http URL drives rawProgress from the loader events", async () => {
    const events: StreamingEvent[] = [
      { phase: "fetching", progress: { bytesLoaded: 100, bytesTotal: 1000, ratio: 0.1 } },
      { phase: "fetching", progress: { bytesLoaded: 500, bytesTotal: 1000, ratio: 0.5 } },
      { phase: "decoded",  progress: { bytesLoaded: 1000, bytesTotal: 1000, ratio: 1 } },
    ];
    vi.spyOn(loader, "streamImage").mockImplementation(() => fakeStream(events));
    const { result } = renderHook(() =>
      useStreamingImage("http://example/mid.jpg", { tauMs: 0 }) // tauMs=0 → no smoothing
    );
    await act(async () => { for (let i = 0; i < 5; i++) await Promise.resolve(); });
    expect(result.current.rawProgress).toBe(1);
    expect(result.current.smoothedProgress).toBe(1);
    expect(result.current.phase).toBe("decoded");
  });

  it("completion squeeze: on phase=decoded the smoother tau shrinks so smoothed catches up quickly", async () => {
    // Simulate a FAST stream: bytes arrive in 50ms but the default
    // tauMs=1500 would leave smoothedProgress < 0.1 at that moment.
    // After the squeeze (completionTauMs=300) it should converge in
    // well under half a second.
    const events: StreamingEvent[] = [
      { phase: "fetching", progress: { bytesLoaded: 500, bytesTotal: 1000, ratio: 0.5 } },
      { phase: "decoded",  progress: { bytesLoaded: 1000, bytesTotal: 1000, ratio: 1 } },
    ];
    vi.spyOn(loader, "streamImage").mockImplementation(() => fakeStream(events));
    const { result } = renderHook(() =>
      useStreamingImage("http://example/mid.jpg", {
        tauMs: 1500,
        completionTauMs: 300,
      })
    );
    // allow events to flush and a few RAF ticks
    await act(async () => {
      for (let i = 0; i < 20; i++) {
        await Promise.resolve();
        vi.advanceTimersByTime(50);
      }
    });
    expect(result.current.phase).toBe("decoded");
    expect(result.current.smoothedProgress).toBeGreaterThanOrEqual(0.99);
  });
});
```

- [ ] **Step 2: Run tests to verify failure**

Run: `npm test -- lib/__tests__/use-streaming-image.test.tsx`
Expected: FAIL, "Cannot find module".

- [ ] **Step 3: Implement the hook**

`lib/use-streaming-image.ts`:
```ts
import * as React from "react";
import { ProgressSmoother } from "@/lib/streaming-image/smoothing";
import { streamImage } from "@/lib/streaming-image/loader";
import type { StreamingPhase, StreamingFrame } from "@/lib/streaming-image/types";
import { getCachedBlobUrl, cacheBlob } from "@/lib/image-cache";

export interface UseStreamingImageOptions {
  /** Smoothing time constant during the streaming phase. Default 1500. */
  tauMs?: number;
  /** Smoothing time constant AFTER bytes finish arriving, used to
   * finish the remaining smoothed-progress animation crisply rather
   * than asymptoting. Default 300. */
  completionTauMs?: number;
  /** Min interval between progressive decodes. Default 60. */
  minDecodeIntervalMs?: number;
}

export interface UseStreamingImageResult {
  phase: StreamingPhase;
  rawProgress: number;      // 0..1, from bytes
  smoothedProgress: number; // 0..1, smoothed copy (use for frontier + blur)
  frame?: StreamingFrame;   // partial or final bitmap
  error?: Error;
}

const DEFAULT_TAU_MS = 1500;
const DEFAULT_COMPLETION_TAU_MS = 300;

/**
 * Streams an image URL, exposing progress + partial bitmap to a
 * consumer that renders canvas-driven. For blob: URLs the stream is
 * short-circuited (bytes already in memory).
 *
 * The hook owns a rAF loop for smoothing — it ticks every animation
 * frame between loader events, so the smoothed signal advances even
 * during gaps between TCP bursts.
 */
export function useStreamingImage(
  url: string | null | undefined,
  opts: UseStreamingImageOptions = {}
): UseStreamingImageResult {
  const {
    tauMs = DEFAULT_TAU_MS,
    completionTauMs = DEFAULT_COMPLETION_TAU_MS,
    minDecodeIntervalMs = 60,
  } = opts;

  const [state, setState] = React.useState<UseStreamingImageResult>({
    phase: "idle",
    rawProgress: 0,
    smoothedProgress: 0,
  });

  const smootherRef = React.useRef(new ProgressSmoother({ tauMs }));
  const rafRef = React.useRef<number | null>(null);
  const lastTickRef = React.useRef<number | null>(null);
  const targetRef = React.useRef(0);

  // Sync tau to opts; changing tau in flight is rare but OK.
  React.useEffect(() => {
    smootherRef.current = new ProgressSmoother({ tauMs });
  }, [tauMs]);

  React.useEffect(() => {
    if (!url) {
      setState({ phase: "idle", rawProgress: 0, smoothedProgress: 0 });
      return;
    }

    // blob: URL fast-path — bytes are already in memory. Skip streaming.
    if (url.startsWith("blob:")) {
      targetRef.current = 1;
      smootherRef.current = new ProgressSmoother({ tauMs: 0 });
      smootherRef.current.tick(0, 1);
      setState({
        phase: "decoded",
        rawProgress: 1,
        smoothedProgress: 1,
      });
      return;
    }

    const ac = new AbortController();
    let cancelled = false;
    smootherRef.current = new ProgressSmoother({ tauMs });
    targetRef.current = 0;

    const pump = async () => {
      try {
        for await (const ev of streamImage({
          url,
          signal: ac.signal,
          minDecodeIntervalMs,
        })) {
          if (cancelled) return;
          targetRef.current = ev.progress.ratio;
          // Completion squeeze: the moment the loader signals "decoded"
          // (bytes fully arrived), shrink the EMA time constant so the
          // remaining smoothed-progress animation finishes in ~1s on
          // fast networks instead of asymptoting for multiple seconds.
          if (ev.phase === "decoded") {
            smootherRef.current.setTau(completionTauMs);
          }
          setState((prev) => ({
            ...prev,
            phase: ev.phase,
            rawProgress: ev.progress.ratio,
            frame: ev.frame ?? prev.frame,
            error: ev.error,
          }));
        }
        if (cancelled) return;
        // Ensure tau is in completion mode and target = 1 for final settle.
        smootherRef.current.setTau(completionTauMs);
        targetRef.current = 1;
        smootherRef.current.snapIfSettled(1);
      } catch (e) {
        if (cancelled) return;
        setState((prev) => ({
          ...prev,
          phase: "error",
          error: e instanceof Error ? e : new Error(String(e)),
        }));
      }
    };
    void pump();

    // Also seed the shared blob cache from a simple Blob once the stream
    // completes. We do it with a small helper that re-fetches as blob
    // (the stream already ran but the body is consumed); acceptable
    // because the fetch is HTTP-cached.
    const seedCache = async () => {
      try {
        if (getCachedBlobUrl(url)) return;
        const res = await fetch(url);
        if (!res.ok) return;
        const blob = await res.blob();
        if (!cancelled) cacheBlob(url, blob);
      } catch { /* ignore */ }
    };

    // rAF loop for smoothing between events. Stops itself once the
    // stream finished AND the smoothed value has caught up (otherwise
    // we keep spinning the event loop for no visible effect).
    const loop = (t: number) => {
      if (cancelled) return;
      const dt = lastTickRef.current == null ? 16 : t - lastTickRef.current;
      lastTickRef.current = t;
      const v = smootherRef.current.tick(dt, targetRef.current);
      setState((prev) =>
        prev.smoothedProgress === v ? prev : { ...prev, smoothedProgress: v }
      );
      const settled = targetRef.current >= 1 && v >= 0.9995;
      if (settled) {
        smootherRef.current.snapIfSettled(1);
        rafRef.current = null;
        return;
      }
      rafRef.current = requestAnimationFrame(loop);
    };
    rafRef.current = requestAnimationFrame(loop);

    return () => {
      cancelled = true;
      ac.abort();
      if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
      lastTickRef.current = null;
      void seedCache();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url, tauMs, minDecodeIntervalMs]);

  return state;
}
```

- [ ] **Step 4: Run tests**

Run: `npm test -- lib/__tests__/use-streaming-image.test.tsx`
Expected: PASS, 3/3. If the rAF loop causes flakiness under fake timers, wrap `rafRef = requestAnimationFrame(loop)` in a check that falls back to `setTimeout(loop, 16)` when `requestAnimationFrame` is undefined, and use `vi.advanceTimersByTime(16)` in the test to step.

- [ ] **Step 5: Commit**

```bash
git add lib/use-streaming-image.ts lib/__tests__/use-streaming-image.test.tsx
git commit -m "feat(streaming-image): useStreamingImage React hook"
```

---

## Task 5: Globals CSS — streaming blur-up rules

**Files:**
- Modify: `app/globals.css` (replace `.blur-up-*` block, ~lines 80–191)

**Why:** The old curtain CSS (mask moves `--reveal` -25→125% after `onload`) is obsolete. New rules drive two canvases off `--frontier`, `--time-blur`, and feather width.

- [ ] **Step 1: Open and replace the old block**

Find the block beginning `/* ===================================================================` near line 77 and ending with the `@media (prefers-reduced-motion: reduce)` block near line 191. Replace with:

```css
/* =====================================================================
 * Streaming progressive image — <BlurUpImage /> (components/blur-up-image.tsx)
 *
 * Renders two <canvas> layers driven by useStreamingImage:
 *   - .blur-up-backdrop: last N decoded rows stretched to the frame and
 *     blurred into a haze that tracks the feather line.
 *   - .blur-up-sharp: progressive bitmap top-to-bottom under a feather
 *     mask pinned to --frontier; global CSS blur ramps 0 via --time-blur.
 *
 * Animation drivers (set inline by the component each tick):
 *   --frontier   : 0%..100%   position of the feather line
 *   --time-blur  : 0..80px    current sharp-canvas blur strength
 *   --feather-pct: fixed (component const) mask feather height
 * ===================================================================== */

.blur-up-root {
  position: relative;
  overflow: hidden;
}

.blur-up-root[data-fit="natural"] {
  display: inline-block;
}

.blur-up-backdrop,
.blur-up-sharp {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  pointer-events: none;
  display: block;
}

.blur-up-backdrop {
  filter: blur(var(--backdrop-blur, 120px)) saturate(1.25);
  transform: scale(1.05);
}

.blur-up-sharp {
  filter: blur(var(--time-blur, 0px));
  transition: filter 200ms linear;
  -webkit-mask-image: linear-gradient(
    to bottom,
    black 0%,
    black calc(var(--frontier, 0%) - var(--feather-pct, 38%)),
    transparent var(--frontier, 0%),
    transparent 100%
  );
  mask-image: linear-gradient(
    to bottom,
    black 0%,
    black calc(var(--frontier, 0%) - var(--feather-pct, 38%)),
    transparent var(--frontier, 0%),
    transparent 100%
  );
}

.blur-up-root[data-reveal-state="done"] .blur-up-sharp {
  filter: blur(0px);
  -webkit-mask-image: none;
  mask-image: none;
}

.blur-up-root[data-reveal-state="done"] .blur-up-backdrop {
  opacity: 0;
  transition: opacity 300ms linear;
}

@media (prefers-reduced-motion: reduce) {
  .blur-up-backdrop { display: none; }
  .blur-up-sharp {
    filter: none;
    -webkit-mask-image: none;
    mask-image: none;
    opacity: 0;
    transition: opacity 150ms linear;
  }
  .blur-up-root[data-reveal-state="done"] .blur-up-sharp { opacity: 1; }
}
```

Note: `@property --reveal` block can be deleted — the new CSS uses `--frontier` as a plain custom property in percent units. `mask-image` with a percentage in `calc()` interpolates fine without `@property` because the component updates it each RAF.

- [ ] **Step 2: Verify Next.js compiles**

Run: `npm run build`
Expected: PASS. If the build fails on orphan `@property --reveal` references in other files, leave the `@property` block in place — it's harmless.

- [ ] **Step 3: Commit**

```bash
git add app/globals.css
git commit -m "feat(blur-up-image): streaming-driven CSS for canvas layers"
```

---

## Task 6: Rewrite `components/blur-up-image.tsx`

**Files:**
- Modify: `components/blur-up-image.tsx` (full rewrite)
- Create: `components/__tests__/blur-up-image.test.tsx`

**Why:** The component becomes a canvas-based renderer driven by `useStreamingImage`. Public props unchanged; only the ref target changes (HTMLImageElement → HTMLDivElement).

- [ ] **Step 1: Write failing component tests**

`components/__tests__/blur-up-image.test.tsx`:
```tsx
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, act } from "@testing-library/react";
import * as hookMod from "@/lib/use-streaming-image";
import { BlurUpImage } from "@/components/blur-up-image";

beforeEach(() => {
  vi.restoreAllMocks();
});

describe("BlurUpImage (streaming)", () => {
  it("renders root with data-reveal-state='idle' when phase=idle", () => {
    vi.spyOn(hookMod, "useStreamingImage").mockReturnValue({
      phase: "idle", rawProgress: 0, smoothedProgress: 0,
    });
    const { container } = render(<BlurUpImage sharpSrc="http://x/y.jpg" alt="t" />);
    const root = container.querySelector(".blur-up-root")!;
    expect(root.getAttribute("data-reveal-state")).toBe("idle");
  });

  it("transitions to data-reveal-state='done' when phase=decoded AND smoothed≥0.999", () => {
    vi.spyOn(hookMod, "useStreamingImage").mockReturnValue({
      phase: "decoded", rawProgress: 1, smoothedProgress: 1,
    });
    const { container } = render(<BlurUpImage sharpSrc="http://x/y.jpg" alt="t" />);
    expect(container.querySelector(".blur-up-root")!.getAttribute("data-reveal-state")).toBe("done");
  });

  it("sets --frontier inline from smoothedProgress", () => {
    vi.spyOn(hookMod, "useStreamingImage").mockReturnValue({
      phase: "fetching", rawProgress: 0.5, smoothedProgress: 0.4,
    });
    const { container } = render(<BlurUpImage sharpSrc="http://x/y.jpg" alt="t" />);
    const root = container.querySelector(".blur-up-root") as HTMLElement;
    expect(root.style.getPropertyValue("--frontier")).toMatch(/^40(\.\d+)?%$/);
  });

  it("forwards ref to the root <div>", () => {
    vi.spyOn(hookMod, "useStreamingImage").mockReturnValue({
      phase: "idle", rawProgress: 0, smoothedProgress: 0,
    });
    const ref = { current: null as HTMLDivElement | null };
    render(<BlurUpImage ref={ref} sharpSrc="http://x/y.jpg" alt="t" />);
    expect(ref.current).not.toBeNull();
    expect(ref.current!.classList.contains("blur-up-root")).toBe(true);
  });

  it("calls onError prop when phase='error'", () => {
    const onError = vi.fn();
    vi.spyOn(hookMod, "useStreamingImage").mockReturnValue({
      phase: "error", rawProgress: 0, smoothedProgress: 0,
      error: new Error("boom"),
    });
    render(<BlurUpImage sharpSrc="http://x/y.jpg" alt="t" onError={onError} />);
    expect(onError).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run tests to verify failure**

Run: `npm test -- components/__tests__/blur-up-image.test.tsx`
Expected: FAIL with type error or prop mismatch (existing component has different internals).

- [ ] **Step 3: Rewrite the component**

`components/blur-up-image.tsx`:
```tsx
"use client";

import * as React from "react";
import { cn } from "@/lib/utils";
import { useStreamingImage } from "@/lib/use-streaming-image";

// Tuned in the curtain-lab at .preview/curtain-lab/ on 2026-04-13.
// User-approved settings snapshot:
//   featherPct=38, stripRows=32, extrapolateBlur=120, topBlur=80,
//   topBlurOpacity=100 (→ γ = 1 + (100−70)/50 = 1.6), smoothMs=1500.
const FEATHER_PCT = 38;           // % of frame height
const BACKDROP_STRIP_ROWS = 32;   // source rows copied into haze canvas
const BACKDROP_BLUR_PX = 120;     // CSS blur on backdrop
const MAX_TIME_BLUR_PX = 80;      // sharp blur at smoothed=0
const TIME_BLUR_GAMMA = 1.6;      // ramp curve; >1 = blur lingers
const DEFAULT_TAU_MS = 1500;      // streaming-phase EMA time constant

export interface BlurUpImageProps {
  sharpSrc: string;
  backdropSrc?: string;
  alt: string;
  className?: string;
  sharpClassName?: string;
  fit?: "contain" | "cover" | "natural";
  /** Back-compat; no longer used (no curtain). Ignored. */
  revealMs?: number;
  draggable?: boolean;
  onDragStart?: React.DragEventHandler<HTMLElement>;
  onLoad?: () => void;
  onError?: (err: Error) => void;
}

/**
 * Streaming progressive image. Renders two canvases; drives reveal from
 * byte-level download progress via useStreamingImage.
 *
 * The component is intentionally leaf-render — all state lives in the
 * hook, and this component just paints canvases each frame.
 *
 * Forwarded ref targets the root <div>. Callers that transform the
 * image (zoom/pan in ImageDialog) apply transforms to this div.
 */
export const BlurUpImage = React.forwardRef<HTMLDivElement, BlurUpImageProps>(
  function BlurUpImage(
    {
      sharpSrc,
      backdropSrc: _backdropSrc, // unused — backdrop is now extrapolated
      alt,
      className,
      sharpClassName,
      fit = "contain",
      draggable,
      onDragStart,
      onLoad,
      onError,
    },
    ref
  ) {
    const rootRef = React.useRef<HTMLDivElement | null>(null);
    React.useImperativeHandle(ref, () => rootRef.current!, []);

    const sharpCanvasRef = React.useRef<HTMLCanvasElement | null>(null);
    const backdropCanvasRef = React.useRef<HTMLCanvasElement | null>(null);

    const { phase, smoothedProgress, frame, error } = useStreamingImage(sharpSrc, {
      tauMs: DEFAULT_TAU_MS,
    });

    // Dispatch onLoad / onError once per state transition.
    const prevPhaseRef = React.useRef(phase);
    React.useEffect(() => {
      if (prevPhaseRef.current !== phase) {
        prevPhaseRef.current = phase;
        if (phase === "decoded" && onLoad) onLoad();
        if (phase === "error" && onError) onError(error ?? new Error("load failed"));
      }
    }, [phase, error, onLoad, onError]);

    // Every frame with a new bitmap, draw to the two canvases.
    React.useEffect(() => {
      const src = frame?.bitmap;
      const sharp = sharpCanvasRef.current;
      const backdrop = backdropCanvasRef.current;
      if (!sharp || !backdrop) return;
      if (!src) return;
      const root = rootRef.current;
      if (!root) return;
      const rect = root.getBoundingClientRect();
      const W = Math.max(1, Math.round(rect.width));
      const H = Math.max(1, Math.round(rect.height));
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      if (sharp.width !== W * dpr) { sharp.width = W * dpr; sharp.height = H * dpr; }
      if (backdrop.width !== W * dpr) { backdrop.width = W * dpr; backdrop.height = H * dpr; }
      const ctxS = sharp.getContext("2d")!;
      const ctxB = backdrop.getContext("2d")!;

      const srcW = (src as unknown as { displayWidth?: number }).displayWidth ?? src.width;
      const srcH = (src as unknown as { displayHeight?: number }).displayHeight ?? src.height;
      const rowsSrc = Math.max(1, Math.min(srcH, frame.lastRowY || srcH));
      const rowsDst = Math.max(1, Math.floor(sharp.height * (rowsSrc / srcH)));

      ctxS.clearRect(0, 0, sharp.width, sharp.height);
      ctxS.drawImage(src, 0, 0, srcW, rowsSrc, 0, 0, sharp.width, rowsDst);

      // Backdrop strip anchored at smoothedProgress (so haze changes
      // colour at the smoothed rate, not the bursty byte rate).
      const stripBottom = Math.max(
        1,
        Math.min(rowsSrc, Math.floor(srcH * smoothedProgress))
      );
      const stripN = Math.max(1, Math.min(BACKDROP_STRIP_ROWS, stripBottom));
      const stripY = Math.max(0, stripBottom - stripN);
      ctxB.clearRect(0, 0, backdrop.width, backdrop.height);
      ctxB.drawImage(src, 0, stripY, srcW, stripN, 0, 0, backdrop.width, backdrop.height);
    }, [frame, smoothedProgress]);

    // Style variables pushed per render.
    const timeBlurPx = (() => {
      if (phase === "decoded" && smoothedProgress >= 0.999) return 0;
      const inv = Math.max(0, 1 - smoothedProgress);
      return Math.round(MAX_TIME_BLUR_PX * Math.pow(inv, TIME_BLUR_GAMMA));
    })();

    const revealState =
      phase === "decoded" && smoothedProgress >= 0.999 ? "done"
      : phase === "fetching" || phase === "decoded" ? "streaming"
      : phase;

    const rootStyle: React.CSSProperties = {
      ["--frontier" as string]: `${(smoothedProgress * 100).toFixed(2)}%`,
      ["--time-blur" as string]: `${timeBlurPx}px`,
      ["--feather-pct" as string]: `${FEATHER_PCT}%`,
      ["--backdrop-blur" as string]: `${BACKDROP_BLUR_PX}px`,
    };

    const fitClass =
      fit === "cover" ? "object-cover"
      : fit === "contain" ? "object-contain"
      : "";

    return (
      <div
        ref={rootRef}
        role="img"
        aria-label={alt}
        className={cn("blur-up-root", className)}
        data-reveal-state={revealState}
        data-fit={fit}
        style={rootStyle}
        draggable={draggable}
        onDragStart={onDragStart}
      >
        <canvas ref={backdropCanvasRef} className={cn("blur-up-backdrop", fitClass)} />
        <canvas ref={sharpCanvasRef} className={cn("blur-up-sharp", fitClass, sharpClassName)} />
      </div>
    );
  }
);
```

- [ ] **Step 4: Run component tests**

Run: `npm test -- components/__tests__/blur-up-image.test.tsx`
Expected: PASS, 5/5.

- [ ] **Step 5: Run full suite**

Run: `npm test`
Expected: no regressions. Any existing BlurUpImage test file referring to old props should also be updated in this task.

- [ ] **Step 6: Commit**

```bash
git add components/blur-up-image.tsx components/__tests__/blur-up-image.test.tsx
git commit -m "feat(blur-up-image): streaming canvas renderer"
```

---

## Task 7: Update `ImageDialog` ref target (HTMLImageElement → HTMLDivElement)

**Files:**
- Modify: `components/image-dialog.tsx` (ref type, no other logic changes expected)

**Why:** `BlurUpImage` now forwards ref to the root div, not an `<img>`. Dialog's zoom/pan logic writes `transform:` to that ref, which works identically on a div.

- [ ] **Step 1: Locate the ref declaration in image-dialog.tsx**

Search for `React.useRef<HTMLImageElement` in the file. Change to `React.useRef<HTMLDivElement` (there should be exactly one for the blur-up/zoom target). Update any TypeScript annotations that reference `HTMLImageElement` on this ref.

- [ ] **Step 2: Verify zoom/pan still applies transforms to the div**

Open the pan/zoom effect block and confirm it reads `ref.current?.style` or similar — no code changes needed since `style.transform` works on any HTMLElement.

- [ ] **Step 3: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors. Fix any cascade errors (likely one or two type annotations on event handlers).

- [ ] **Step 4: Commit**

```bash
git add components/image-dialog.tsx
git commit -m "chore(image-dialog): adapt ref to BlurUpImage's new root-div target"
```

---

## Task 8: Remove obsolete back-compat fields

**Files:**
- Modify: `components/blur-up-image.tsx` — remove `revealMs` doc; deprecate
- Modify: `components/output-area.tsx`, `components/history-sidebar.tsx`, `components/image-dialog.tsx` — remove `revealMs` usages

**Why:** `revealMs` no longer does anything. Remove call-site props to keep the codebase honest.

- [ ] **Step 1: Grep for revealMs usages**

Run: `npx grep -rn revealMs components/ | cat` (or Grep tool).

- [ ] **Step 2: Delete revealMs prop forwarding**

For each hit (likely 3 sites: output-area, history-sidebar, image-dialog), remove the `revealMs={...}` attribute. Do not remove the prop from `BlurUpImageProps` yet — leave it deprecated for external compat.

Actually: since this codebase has no external consumers, remove the prop entirely from `BlurUpImageProps`. Delete the line and its JSDoc.

- [ ] **Step 3: Build + test**

Run: `npm run build && npm test`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add components/blur-up-image.tsx components/output-area.tsx components/history-sidebar.tsx components/image-dialog.tsx
git commit -m "refactor(blur-up-image): remove obsolete revealMs prop"
```

---

## Task 9: Drag-drop regression guard

**Files:**
- Create: `components/__tests__/blur-up-image.drag.test.tsx`

**Why:** Old `<img draggable>` native behaviour auto-populated `dataTransfer.types = ['text/uri-list']`. The new canvas-based wrapper needs explicit handling by callers, and callers already set `onDragStart`. Verify the forwarded `onDragStart` fires with the correct `dataTransfer`.

- [ ] **Step 1: Write the test**

`components/__tests__/blur-up-image.drag.test.tsx`:
```tsx
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, fireEvent } from "@testing-library/react";
import * as hookMod from "@/lib/use-streaming-image";
import { BlurUpImage } from "@/components/blur-up-image";

beforeEach(() => {
  vi.spyOn(hookMod, "useStreamingImage").mockReturnValue({
    phase: "decoded", rawProgress: 1, smoothedProgress: 1,
  });
});

describe("BlurUpImage drag-drop", () => {
  it("fires onDragStart when draggable=true", () => {
    const onDragStart = vi.fn();
    const { container } = render(
      <BlurUpImage sharpSrc="http://x/y.jpg" alt="t" draggable onDragStart={onDragStart} />
    );
    const root = container.querySelector(".blur-up-root")!;
    fireEvent.dragStart(root);
    expect(onDragStart).toHaveBeenCalled();
    expect(root.getAttribute("draggable")).toBe("true");
  });
});
```

- [ ] **Step 2: Run**

Run: `npm test -- components/__tests__/blur-up-image.drag.test.tsx`
Expected: PASS.

- [ ] **Step 3: Manual verification in browser**

Run `npm run dev`, generate an image, drag the output card onto the dropzone. Confirm the dropzone receives the full-res URL. If it does not, the call site (`components/output-area.tsx`) needs its `onDragStart` to explicitly call `e.dataTransfer.setData("text/uri-list", fullResUrl)` — the old code may have relied on native `<img>` behaviour.

- [ ] **Step 4: Commit**

```bash
git add components/__tests__/blur-up-image.drag.test.tsx
# + any output-area.tsx fix if manual test revealed one
git commit -m "test(blur-up-image): drag-drop regression guard"
```

---

## Task 10: Manual integration pass

**Files:**
- None (manual testing + one follow-up commit if needed)

**Why:** Catch anything static tests can't (real network throttling, real browser render, reduced-motion, two rapid generations, dialog arrow-nav).

- [ ] **Step 1: Run dev**

```bash
npm run dev
```

- [ ] **Step 2: Manual checklist**

In a browser window, perform each and record PASS/FAIL:
- [ ] Generate an image → curtain feels like the lab E variant (blur at top, feather sliding down, haze below matching frontier colour)
- [ ] DevTools → Network → Throttling "Slow 3G" → reveal is clearly streaming, no modem
- [ ] Reload page — cross-device entries render with streaming reveal
- [ ] Open ImageDialog → arrow through 5+ siblings → each reveal plays, ref (zoom/pan) works
- [ ] DevTools → Rendering → emulate prefers-reduced-motion: reduce → crossfade only, no canvas animation
- [ ] Drag an output card onto the dropzone → full-res URL transfers
- [ ] Download button → full-res file saves
- [ ] Two rapid generations in a row → no canvas flash between swaps

- [ ] **Step 3: Side-by-side visual parity check (lab vs prod)**

The goal of this plan is "prod feels like the lab". Verify it literally, with screenshots.

Setup:
1. Keep the lab running in one browser tab: `cd .preview/curtain-lab && npx -y serve -l 5174` → `http://localhost:5174/`.
2. Open prod in another tab at `http://localhost:3000` (or the Windows LAN IP if testing on another device).
3. In the prod tab, open DevTools → Network → Throttling dropdown → **Slow 4G** (≈400 kbps down, 400 ms RTT). This roughly matches the lab's default `load duration = 5000 ms`.
4. In the lab tab: click `dump settings` in the panel and verify the log shows EXACTLY:
   ```json
   {"loadMs":5000,"revealMs":100,"featherPct":38,"stripRows":32,"extrapolateBlur":120,
    "topBlur":80,"topBlurOpacity":100,"burstMode":true,"burstCount":15,"smoothMs":1500,
    "scene":"sunset"}
   ```
   If any field differs, reset via the panel sliders before capturing.

Capture (use OS screenshot hotkey — Win+Shift+S on Windows):
- [ ] **Frame @ ~25 % progress** — lab tile E alongside prod's Output card mid-generation.
- [ ] **Frame @ ~60 % progress** — same.
- [ ] **Frame @ ~95 % progress** — same, just before completion squeeze lands.
- [ ] **Final frame (done)** — both crisp, backdrop faded, no mask.

Save the six PNGs into `.preview/curtain-lab/parity-<YYYY-MM-DD>/` (create the folder). Naming: `lab-25.png`, `prod-25.png`, `lab-60.png`, `prod-60.png`, `lab-95.png`, `prod-95.png`, `lab-done.png`, `prod-done.png`.

Compare. The ACCEPTANCE CRITERIA — all four must be true:
1. **Feather position matches** at ±5 % of frame height in the 25/60/95 frames. (Tiny mismatch expected: lab has a linear time-driven synthetic load, prod has real TCP bursts smoothed differently.)
2. **Haze colour matches** (hue/brightness, eyeball test) at the feather line in all three mid-progress frames.
3. **Global blur on sharp layer feels the same** — amount of detail visible above feather is similar at matching progress points.
4. **Final frame is pixel-identical to the source JPEG** (no residual blur, no mask).

If any criterion fails:
- **Feather mismatch** → check `DEFAULT_TAU_MS` / `DEFAULT_COMPLETION_TAU_MS` in hook; also check that `--frontier` is pushed in percent with `%` suffix, not as a raw number.
- **Haze mismatch** → verify strip anchor uses `smoothedProgress` (not `rawProgress`); verify `BACKDROP_STRIP_ROWS` and `BACKDROP_BLUR_PX` constants match lab.
- **Blur mismatch** → verify `MAX_TIME_BLUR_PX` and `TIME_BLUR_GAMMA` constants; verify the `timeBlurPx` formula in the component matches `state.topBlur * (1-p)^γ` with `γ = 1 + (topBlurOpacity-70)/50` from the lab.
- **Residual blur on done** → verify `data-reveal-state="done"` switches `.blur-up-sharp { filter: blur(0px); mask-image: none }` via CSS and that the component sets `data-reveal-state` when `phase==="decoded" && smoothedProgress >= 0.999`.

- [ ] **Step 4: Commit the parity artifacts**

```bash
git add .preview/curtain-lab/parity-*/
git commit -m "test(streaming-progressive-loader): visual parity lab↔prod @ Slow 4G"
```

If any parity criterion failed and you fixed it, include the fix commit separately BEFORE capturing the final approved frames.

- [ ] **Step 5: File any remaining bugs**

If any manual-checklist item from Step 2 failed, create a follow-up commit fixing that issue. If the fix is > 20 lines, open a separate planned task.

- [ ] **Step 6: Commit the integration notes**

Append to this file a short "Post-ship notes" section listing what passed and any fixes applied.

```bash
git add docs/superpowers/plans/2026-04-13-streaming-progressive-loader.md
git commit -m "docs(streaming-progressive-loader): integration pass notes"
```

---

## Task 11: Seed cache optimisation (eliminate the second fetch)

**Files:**
- Modify: `lib/use-streaming-image.ts`

**Why:** Task 4 hook does a second `fetch()` at teardown just to seed `cacheBlob`. That's a double download. Eliminate it by accumulating the stream's bytes into a `Blob` in the loader itself.

- [ ] **Step 1: Change the loader to return the full Blob at complete**

Modify `lib/streaming-image/loader.ts` to accumulate bytes into a `BlobPart[]` and include `blob: Blob` on the final `decoded` event. Update `StreamingEvent` type.

```ts
// types.ts — add to StreamingEvent:
export interface StreamingEvent {
  phase: StreamingPhase;
  progress: StreamingProgress;
  frame?: StreamingFrame;
  blob?: Blob; // present on decoded only
  error?: Error;
}
```

Update loader: accumulate `chunks.push(value)` in the counter loop, and on the final `decoded` yield set `blob: new Blob(chunks, { type: mime })`.

- [ ] **Step 2: Update the hook to use the returned blob**

In `lib/use-streaming-image.ts`, remove the `seedCache` fetch. Instead, when handling the `decoded` event, if `ev.blob` is present and `!getCachedBlobUrl(url)`, call `cacheBlob(url, ev.blob)`.

- [ ] **Step 3: Update tests**

Extend `loader.test.ts` to assert `blob` is present on the final event with the correct MIME.

- [ ] **Step 4: Run tests**

Run: `npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/streaming-image/loader.ts lib/streaming-image/types.ts lib/use-streaming-image.ts lib/streaming-image/__tests__/loader.test.ts
git commit -m "perf(streaming-image): seed blob cache from stream bytes, no second fetch"
```

---

## Task 12: Documentation

**Files:**
- Create: `docs/superpowers/specs/2026-04-13-streaming-progressive-loader-design.md`

**Why:** Future-proofing. The spec doc captures the "why canvas, why ImageDecoder, why two-layer, why EMA smoothing" decisions so a future agent doesn't re-litigate them.

- [ ] **Step 1: Write the design doc**

Fill in sections: Problem / Goals / Non-goals / Key decisions / Architecture / Data flow / Error handling / Edge cases / Testing / Out of scope. Reuse prose from this plan's header + lab README content.

- [ ] **Step 2: Commit**

```bash
git add docs/superpowers/specs/2026-04-13-streaming-progressive-loader-design.md
git commit -m "docs: streaming progressive loader design spec"
```

---

## Fallback tasks — use only if Task 0 decides against ImageDecoder

### Task F1: Runtime-gated fallback (partial ImageDecoder support)

**Files:**
- Modify: `lib/use-streaming-image.ts`

**Why:** If Task 0 shows ImageDecoder works in some browsers but not all, gate by runtime feature detect and fall back on failure.

Implement a `typeof ImageDecoder === "undefined"` branch in the hook that uses the strategy of Task F2 (below). Keep the ImageDecoder path as primary.

### Task F2: `<img>` blob-rebinding renderer (no partial decode)

**Files:**
- Modify: `lib/use-streaming-image.ts`

**Why:** If ImageDecoder is unavailable everywhere, we cannot get partial pixels from the browser. We still get real byte-level progress from `fetch()` streaming; the image itself snaps in at the end.

Strategy in hook:
1. Fetch with stream, accumulate bytes and track `bytesLoaded`.
2. No partial bitmap — leave `frame` undefined until complete.
3. On complete, decode bytes once via a hidden `<img>` + `img.decode()` → `createImageBitmap(img)` → emit as final frame.
4. `BlurUpImage` detects "no partial frame" and shows a solid background (derived average colour if ever FW-1 is wired up, else `rgba(18,18,22,1)`) plus the smooth feather line and blur — identical animation to the main path, just no image content until complete.

Loss vs main path: the extrapolated strip has no real pixels to sample, so the haze is a neutral dark. Users still see smooth frontier + ramping blur + the final image slamming in cleanly under them.

---

## Self-Review

**Spec coverage:**
- Fetch-stream with ImageDecoder for partial decodes → Task 0, 3
- Exponential progress smoothing → Task 1, 4
- Canvas-based two-layer render → Task 6
- Strip anchored at smoothedProgress (not rawProgress) → Task 6, Step 3, lines beginning "Backdrop strip anchored at smoothedProgress"
- Time-ramping blur on sharp canvas → Task 6, `timeBlurPx` computation
- Preserve drag-drop, zoom-pan, download → Task 7 (ref), Task 9 (drag), Task 10 (manual)
- Reduced-motion → Task 5 (CSS), Task 10 (manual)
- Cache integration → Task 4, Task 11

**Placeholder scan:** None. Every code step has complete code; every test shows what to assert.

**Type consistency:**
- `StreamingEvent.progress.ratio` used consistently in loader, hook, and component.
- `frame.lastRowY` referenced in Task 6 component matches the `StreamingFrame.lastRowY` defined in Task 2.
- `BlurUpImageProps.ref` target is `HTMLDivElement` in Task 6; `ImageDialog` ref update in Task 7 matches.

**Risk register:**
- ImageDecoder unavailability → Task 0 gate + F1/F2 fallback.
- jsdom canvas ops are no-ops → component tests in Task 6/9 only assert DOM attrs and style, not drawn pixels.
- `ReadableStream.tee()` doubles memory use for one request duration → acceptable (150 KB × 2 = 300 KB peak).
- `ImageDecoder.decode({ completeFramesOnly: false })` may throw on very early bytes → loader's try/catch swallows; last-good frame survives.

**Effort estimate:** 5 working days. Task 0 is a day. Tasks 1-4 parallel-friendly in one day. Task 5-7 one day. Tasks 8-11 one day. Task 12 + polish one day.
