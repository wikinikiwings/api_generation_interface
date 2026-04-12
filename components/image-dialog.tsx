"use client";

import * as React from "react";
import { Download, ChevronLeft, ChevronRight } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import type { HistoryEntry } from "@/types/wavespeed";
import { BlurUpImage } from "@/components/blur-up-image";
import { thumbUrlForEntry } from "@/lib/history-urls";

export interface ImageDialogProps {
  entry: HistoryEntry;
  children: React.ReactNode;
  /**
   * Optional URL used for the Download button. When the dialog is showing
   * a downscaled preview (e.g. `mid_*.png`), callers should pass the full
   * original URL here so “Download” still saves the full-resolution file.
   * Falls back to `entry.outputUrl` when omitted.
   */
  downloadUrl?: string;
  /**
   * Full sibling list — enables in-dialog prev/next navigation via arrow
   * buttons (hover left/right edges) and keyboard arrows. When omitted,
   * the dialog behaves as a single-image viewer.
   */
  siblings?: HistoryEntry[];
  /** Index of `entry` inside `siblings`. Required when siblings is set. */
  initialIndex?: number;
  /**
   * Fired when navigation advances within N positions of the tail of
   * `siblings`, where `remainingAhead = siblings.length - currentIdx - 1`.
   * Consumers typically call `loadMore()` in response. Throttled: only
   * fires when `remainingAhead` strictly decreases from the last fire,
   * so stuck-at-end arrow mashing doesn't re-trigger.
   */
  onNearEnd?: (remainingAhead: number) => void;
}

/**
 * Wraps a clickable thumbnail. On click, opens a full-size dialog
 * showing the generated image with a download button.
 */
export function ImageDialog({ entry, children, downloadUrl, siblings, initialIndex = 0, onNearEnd }: ImageDialogProps) {
  // Navigation state — which sibling is currently shown, tracked by id
  // (not index) so that a reactive siblings array (entries inserted /
  // removed while the dialog is open) keeps pointing at the right slide.
  //
  // Seed with the clicked entry's id so that if the sibling array is
  // empty or doesn't yet contain the entry, we still render the trigger
  // entry rather than crashing.
  const siblingsList = React.useMemo(() => siblings ?? [], [siblings]);
  const hasSiblings = siblingsList.length > 1;

  const [currentId, setCurrentId] = React.useState<string>(() => {
    const seed = siblingsList[initialIndex]?.id ?? entry.id;
    return seed;
  });

  // Computed: where `currentId` sits in the (possibly reactive) siblings.
  // -1 means "not present" — handled by the disappearance effect in Task 5.
  const currentIdx = React.useMemo(() => {
    if (!hasSiblings) return 0;
    return siblingsList.findIndex((s) => s.id === currentId);
  }, [hasSiblings, siblingsList, currentId]);

  const currentEntry = hasSiblings
    ? (siblingsList[currentIdx] ?? entry)
    : entry;
  const currentDownloadUrl =
    (hasSiblings ? currentEntry.originalUrl ?? currentEntry.outputUrl : downloadUrl) ??
    currentEntry.outputUrl;

  const goPrev = React.useCallback(() => {
    if (!hasSiblings) return;
    const idx = siblingsList.findIndex((s) => s.id === currentId);
    if (idx < 0) return;
    const next = (idx - 1 + siblingsList.length) % siblingsList.length;
    setCurrentId(siblingsList[next].id);
  }, [hasSiblings, siblingsList, currentId]);

  const goNext = React.useCallback(() => {
    if (!hasSiblings) return;
    const idx = siblingsList.findIndex((s) => s.id === currentId);
    if (idx < 0) return;
    const next = (idx + 1) % siblingsList.length;
    setCurrentId(siblingsList[next].id);
  }, [hasSiblings, siblingsList, currentId]);

  const [previewSrc, setPreviewSrc] = React.useState<string | undefined>(
    currentEntry.outputUrl
  );
  const triedFallbackRef = React.useRef(false);

  // ============================================================
  // FLIP open/close animation. Instead of relying on Radix's default
  // `zoom-in-95` keyframe (which scales from a static origin), we run
  // our own Web Animations API transition: the dialog content visually
  // "flies" from the clicked thumbnail's rect to its natural centered
  // rect, scaling and translating in one motion. On close, the reverse.
  //
  // - We disable the built-in keyframe via `!animate-none` on DialogContent
  //   (see className override below).
  // - We keep the `inset-0 + m-auto` centering trick so `transform` is
  //   free for our own animation (see ANIMATIONS.md §3).
  // - For close, we intercept `onOpenChange(false)`, play the reverse
  //   animation, then actually flip the open state so Radix unmounts.
  // ============================================================
  const triggerRef = React.useRef<HTMLDivElement>(null);
  const contentRef = React.useRef<HTMLDivElement>(null);
  const lastTriggerRectRef = React.useRef<DOMRect | null>(null);
  // Guard: callback ref fires multiple times (Strict Mode mount/unmount,
  // re-renders). Without this, the 2nd run measures the already-centered
  // node → FLIP collapses to identity → a no-op animation overrides the
  // real one. Reset to false on close so the next open animates again.
  const openAnimPlayedRef = React.useRef(false);
  const [open, setOpen] = React.useState(false);

  const ANIM_OPEN_MS = 280;
  const ANIM_CLOSE_MS = 220;
  const EASING_OUT = "cubic-bezier(0.16, 1, 0.3, 1)"; // ease-out-expo-ish
  const EASING_IN = "cubic-bezier(0.4, 0, 1, 1)";

  function captureTriggerRect() {
    const el = triggerRef.current?.firstElementChild as HTMLElement | null;
    // Prefer the inner tile (the actual image card) over the wrapper div,
    // so the FLIP source matches what the user visually clicked.
    const target = el ?? triggerRef.current;
    if (target) lastTriggerRectRef.current = target.getBoundingClientRect();
  }

  function computeFlipFromRects(content: HTMLElement, thumb: DOMRect) {
    const cr = content.getBoundingClientRect();
    const tx = thumb.left + thumb.width / 2 - (cr.left + cr.width / 2);
    const ty = thumb.top + thumb.height / 2 - (cr.top + cr.height / 2);
    // Use the smaller scale so the thumbnail "shape" inscribes the
    // dialog content, not stretches it. ALSO clamp to <= 1: on narrow
    // viewports the thumb can be bigger than the dialog content rect
    // (or content hasn't laid out yet because <img> is still loading),
    // which would give s > 1 → dialog appears huge and shrinks. Clamping
    // to 1 means we just slide from the thumb position without zoom in
    // those cases, which reads as a clean transition.
    const raw = Math.min(thumb.width / cr.width, thumb.height / cr.height);
    const s = Math.min(raw, 1);
    return { tx, ty, s };
  }

  function handleOpenChange(next: boolean) {
    if (next) {
      captureTriggerRect();
      openAnimPlayedRef.current = false;
      // Reset by id so subsequent re-opens start on the tile that was
      // actually clicked, not the sibling we navigated to last time.
      const seed = siblingsList[initialIndex]?.id ?? entry.id;
      setCurrentId(seed);
      setOpen(true);
      return;
    }
    // Closing — simple fade out, then unmount.
    openAnimPlayedRef.current = false;
    const el = contentRef.current;
    if (!el) {
      setOpen(false);
      return;
    }
    const anim = el.animate(
      [{ opacity: 1 }, { opacity: 0 }],
      { duration: ANIM_CLOSE_MS, easing: EASING_IN, fill: "forwards" }
    );
    anim.onfinish = () => setOpen(false);
    anim.oncancel = () => setOpen(false);
  }

  // Open animation: triggered via a callback ref. We can't use a normal
  // useEffect here because <DialogPortal> mounts content in a separate
  // React tree, and the parent ImageDialog's effect fires *before* the
  // portal child commits — so contentRef.current would still be null.
  // A callback ref runs synchronously when the DOM node attaches, which
  // is exactly when we want to measure & animate.
  const contentCallbackRef = React.useCallback((node: HTMLDivElement | null) => {
    contentRef.current = node;
    if (!node) return;
    if (openAnimPlayedRef.current) return;
    const tr = lastTriggerRectRef.current;
    if (!tr) return;
    openAnimPlayedRef.current = true;
    requestAnimationFrame(() => {
      if (!node.isConnected) return;
      try {
        const { tx, ty, s } = computeFlipFromRects(node, tr);
        // Defensive: if FLIP collapsed to identity, skip — pointless no-op.
        if (tx === 0 && ty === 0 && s === 1) return;
        node.animate(
          [
            { transform: `translate(${tx}px, ${ty}px) scale(${s})`, opacity: 0.4 },
            { transform: "translate(0,0) scale(1)", opacity: 1 },
          ],
          // fill: "none" — don't leave transform stuck on the node after
          // the animation finishes. The inline `transform: none` style
          // takes back over and the dialog rests at its centered position.
          { duration: ANIM_OPEN_MS, easing: EASING_OUT, fill: "none" }
        );
      } catch (err) {
        console.error("[ImageDialog] open animation failed:", err);
      }
    });
  }, []);

  React.useEffect(() => {
    setPreviewSrc(currentEntry.outputUrl);
    triedFallbackRef.current = false;
  }, [currentEntry.outputUrl]);

  // BlurUpImage handles its own cache integration via useCachedImage
  // internally; we just pass the logical URL here.
  const effectivePreviewSrc = previewSrc;

  // Keyboard navigation: ← / → switch siblings while the dialog is open.
  React.useEffect(() => {
    if (!open || !hasSiblings) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "ArrowLeft") { e.preventDefault(); goPrev(); }
      else if (e.key === "ArrowRight") { e.preventDefault(); goNext(); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, hasSiblings, goPrev, goNext]);

  // Near-end prefetch signal. Fires onNearEnd when navigation lands
  // within 2 positions of the end of siblings, with strict-decrease
  // throttling so a user mashing → at the tail doesn't re-trigger.
  // Reset the throttle when siblings grow (a new batch loaded in).
  const NEAR_END_THRESHOLD = 2;
  const lastFiredRemainingRef = React.useRef<number | null>(null);
  const lastSiblingsLenRef = React.useRef<number>(siblingsList.length);

  React.useEffect(() => {
    // Siblings grew (loadMore brought in more rows) → reset dedup so we
    // can fire again when the user approaches the new tail.
    if (siblingsList.length > lastSiblingsLenRef.current) {
      lastFiredRemainingRef.current = null;
    }
    lastSiblingsLenRef.current = siblingsList.length;
  }, [siblingsList.length]);

  React.useEffect(() => {
    if (!open || !hasSiblings || !onNearEnd) return;
    if (currentIdx < 0) return;
    const remaining = siblingsList.length - currentIdx - 1;
    if (remaining > NEAR_END_THRESHOLD) return;
    // Strict-decrease throttle: only fire when remaining gets smaller
    // than the last value we fired at. Prevents hammering while the
    // user sits on the last slide.
    const last = lastFiredRemainingRef.current;
    if (last !== null && remaining >= last) return;
    lastFiredRemainingRef.current = remaining;
    onNearEnd(remaining);
  }, [open, hasSiblings, onNearEnd, currentIdx, siblingsList.length]);

  // Disappearance handling. If `currentId` is no longer present in the
  // (reactive) siblings — typically because the SSE `generation.deleted`
  // event removed it, or because a filter tightened — snap to the sibling
  // that occupies the same index the deleted one used to hold, clamped
  // to the new end. If siblings becomes empty, close the dialog.
  //
  // We read the "old index" by remembering the last-known idx for this
  // currentId in a ref. Why: once the entry is gone, `siblingsList.findIndex`
  // returns -1 and we've lost positional context without this memo.
  const lastKnownIdxRef = React.useRef<number>(currentIdx);
  React.useEffect(() => {
    if (currentIdx >= 0) {
      lastKnownIdxRef.current = currentIdx;
    }
  }, [currentIdx]);

  React.useEffect(() => {
    if (!open) return;
    if (!hasSiblings) return;
    // currentId is still in siblings → nothing to do.
    if (currentIdx >= 0) return;
    // currentId vanished. If siblings empty — close; otherwise clamp.
    if (siblingsList.length === 0) {
      handleOpenChange(false);
      return;
    }
    const clamped = Math.min(
      Math.max(lastKnownIdxRef.current, 0),
      siblingsList.length - 1
    );
    setCurrentId(siblingsList[clamped].id);
    // Note: we do NOT call onNearEnd here; the follow-up index-change
    // effect in Task 4 will handle that naturally if the clamped slot
    // is near the tail.
  }, [open, hasSiblings, currentIdx, siblingsList]);

  const effectiveDownloadUrl = currentDownloadUrl;

  if (!entry.outputUrl) {
    // Nothing to preview — just render the trigger as-is
    return <>{children}</>;
  }

  async function handleDownload() {
    if (!effectiveDownloadUrl) return;
    try {
      const res = await fetch(effectiveDownloadUrl);
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `wavespeed-${currentEntry.taskId || currentEntry.id}.${currentEntry.outputFormat}`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch (err) {
      console.error("Download failed", err);
    }
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogTrigger asChild>
        <div
          ref={triggerRef}
          // ============================================================
          // Drag-to-new-tab: redirect to the original.
          //
          // Native browser behavior on dragging an <img> onto the tab
          // bar / address bar is to open whatever URL is in `src` —
          // for us that's the optimized mid_* preview. We override the
          // drag payload here so the dropped URL is the full-resolution
          // original instead. The original is NOT fetched at this point;
          // we only put a string into DataTransfer. The browser fetches
          // it lazily if and when the user actually drops the link.
          //
          // Why setData on the wrapper and not on the inner <img>:
          // dragstart bubbles, and putting it here means every consumer
          // of <ImageDialog> (output tiles, sidebar history, etc.) gets
          // this behavior for free without touching their JSX.
          //
          // We use `entry` (not `currentEntry`) because the dialog isn't
          // open yet at drag time — the trigger represents the original
          // tile the user grabbed. `text/uri-list` is the spec MIME for
          // tab/address-bar drops; `text/plain` is the legacy fallback
          // some platforms still read.
          //
          // CRITICAL: must be an *absolute* URL. Our backend serves images
          // under relative paths like `/api/history/image/<id>.png`, but
          // Chrome's address bar treats relative paths as plain text and
          // routes them to the default search engine instead of opening
          // them as URLs. `new URL(rel, origin).href` resolves to e.g.
          // `http://localhost:3000/api/history/image/<id>.png`, which
          // Chrome correctly recognizes. Already-absolute URLs pass
          // through unchanged because the URL constructor ignores the
          // base when the input is already absolute.
          // ============================================================
          onDragStart={(e) => {
            const orig = entry.originalUrl ?? downloadUrl ?? entry.outputUrl;
            if (!orig || orig === entry.outputUrl) return;
            try {
              const absolute = new URL(orig, window.location.origin).href;
              e.dataTransfer.setData("text/uri-list", absolute);
              e.dataTransfer.setData("text/plain", absolute);
            } catch {
              // Malformed URL — fall back to native browser behavior
              // (drag will use the inner <img src>, i.e. the mid preview).
            }
          }}
        >
          {children}
        </div>
      </DialogTrigger>
      <DialogContent
        ref={contentCallbackRef as React.Ref<HTMLDivElement>}
        // Tell Radix "this dialog has no description" — silences the
        // "Missing `Description` or `aria-describedby={undefined}` for
        // {DialogContent}" warning without forcing us to add one. The
        // dialog content (an image) is fully described by DialogTitle
        // and the image's own alt text.
        aria-describedby={undefined}
        // Inline style wins over Tailwind utilities unconditionally — our
        // previous `!left-0 !translate-x-0` className override was being
        // beaten by shadcn's base `left-1/2 -translate-x-1/2`, leaving a
        // permanent translate(-50%, -50%) on the node that fought our
        // WAAPI transform. Style prop bypasses the cascade entirely.
        style={{
          left: 0,
          top: 0,
          right: 0,
          bottom: 0,
          margin: "auto",
          transform: "none",
          width: "fit-content",
          height: "fit-content",
          maxWidth: "92vw",
          maxHeight: "92vh",
        }}
        className={
          // `!animate-none` kills the default zoom-in-95 keyframe — we
          // drive both open and close via element.animate() ourselves.
          "!animate-none data-[state=open]:!animate-none data-[state=closed]:!animate-none " +
          "border-0 bg-transparent p-0 shadow-none"
        }
      >
        <DialogTitle className="sr-only">Generation result</DialogTitle>
        <div className="flex flex-col items-center gap-3">
          <div className="group/nav relative overflow-hidden rounded-lg bg-background/20 shadow-2xl">
            <ZoomableImage
              key={currentEntry.id}
              src={effectivePreviewSrc}
              backdropSrc={thumbUrlForEntry(currentEntry)}
              alt={currentEntry.prompt}
              originalUrl={effectiveDownloadUrl}
              downloadFilename={`wavespeed-${currentEntry.taskId || currentEntry.id}.${currentEntry.outputFormat}`}
              onLoadError={() => {
                if (
                  !triedFallbackRef.current &&
                  effectiveDownloadUrl &&
                  previewSrc !== effectiveDownloadUrl
                ) {
                  triedFallbackRef.current = true;
                  setPreviewSrc(effectiveDownloadUrl);
                }
              }}
            />
            {hasSiblings && (
              <>
                {/* Left hover zone — prev. Gradient + chevron fade in on hover. */}
                <button
                  type="button"
                  onClick={(e) => { e.stopPropagation(); goPrev(); }}
                  aria-label="Previous image"
                  className="group/prev absolute inset-y-0 left-0 z-10 flex w-1/4 items-center justify-start pl-3 focus:outline-none"
                >
                  <span className="pointer-events-none absolute inset-0 bg-gradient-to-r from-black/35 to-transparent to-50% opacity-0 transition-opacity duration-200 group-hover/prev:opacity-100" />
                  <ChevronLeft className="relative h-10 w-10 text-white drop-shadow-lg opacity-0 transition-opacity duration-200 group-hover/prev:opacity-100" />
                </button>
                {/* Right hover zone — next. */}
                <button
                  type="button"
                  onClick={(e) => { e.stopPropagation(); goNext(); }}
                  aria-label="Next image"
                  className="group/next absolute inset-y-0 right-0 z-10 flex w-1/4 items-center justify-end pr-3 focus:outline-none"
                >
                  <span className="pointer-events-none absolute inset-0 bg-gradient-to-l from-black/35 to-transparent to-50% opacity-0 transition-opacity duration-200 group-hover/next:opacity-100" />
                  <ChevronRight className="relative h-10 w-10 text-white drop-shadow-lg opacity-0 transition-opacity duration-200 group-hover/next:opacity-100" />
                </button>
              </>
            )}
          </div>
          <div className="flex items-center gap-2">
            <Button onClick={handleDownload} size="sm">
              <Download />
              Скачать
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

// ============================================================
// ZoomableImage — simple model: wheel = zoom (cursor-centered, 1–5x),
// drag = pan (when zoomed in), double-click = toggle 1× ↔ 2× centered
// on the cursor. Mirrors macOS Preview / Windows Photos behavior —
// zero cognitive overhead.
// ============================================================

const WHEEL_MIN = 1.0;
const WHEEL_MAX = 5.0;
const WHEEL_SENSITIVITY = 0.0015; // delta-per-pixel
const DBL_CLICK_ZOOM = 2.0; // double-click toggles between 1× and this

interface ZoomableImageProps {
  src: string | undefined;
  /**
   * Optional backdrop (thumb URL) for the blur-up reveal. Passed through
   * to BlurUpImage. Undefined → BlurUpImage uses `src` as its own backdrop.
   */
  backdropSrc?: string;
  alt: string;
  onLoadError: () => void;
  /**
   * Full-resolution URL of the original image. Used by the custom
   * context menu to copy/download/open the original on demand —
   * the on-screen <img> stays pointed at the optimized `src` so
   * loading the dialog never costs the full file's bandwidth.
   * Falls back to `src` when omitted.
   */
  originalUrl?: string;
  /** Suggested filename for the "Download" menu item. */
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
  const containerRef = React.useRef<HTMLDivElement>(null);
  const [scale, setScale] = React.useState(1);
  const [tx, setTx] = React.useState(0);
  const [ty, setTy] = React.useState(0);
  const [isPanning, setIsPanning] = React.useState(false);
  // Mirror live state in refs so the wheel handler (registered once via
  // addEventListener) reads up-to-date values without re-subscribing.
  const scaleRef = React.useRef(scale);
  const txRef = React.useRef(tx);
  const tyRef = React.useRef(ty);
  React.useEffect(() => {
    scaleRef.current = scale;
    txRef.current = tx;
    tyRef.current = ty;
  }, [scale, tx, ty]);
  // Mouse drag state for pan. Active only when scale > 1; mousedown
  // captures the starting offset, mousemove updates tx/ty in real time.
  const dragStateRef = React.useRef<{
    startX: number;
    startY: number;
    startTx: number;
    startTy: number;
  } | null>(null);

  // Reset transform when the source image changes (e.g. dialog reopened
  // for a different entry, or fallback mid → original).
  React.useEffect(() => {
    setScale(1);
    setTx(0);
    setTy(0);
  }, [src]);

  /**
   * Clamp pan offsets so the scaled image cannot be dragged completely
   * out of the container. The allowable travel on each axis is half the
   * overflow on that axis: ((scale - 1) * size) / 2. At scale === 1 the
   * range collapses to 0 and the image stays centered.
   */
  const clampPan = React.useCallback(
    (nextTx: number, nextTy: number, nextScale: number) => {
      const el = containerRef.current;
      if (!el) return { tx: nextTx, ty: nextTy };
      const rect = el.getBoundingClientRect();
      const maxX = Math.max(0, ((nextScale - 1) * rect.width) / 2);
      const maxY = Math.max(0, ((nextScale - 1) * rect.height) / 2);
      return {
        tx: Math.max(-maxX, Math.min(maxX, nextTx)),
        ty: Math.max(-maxY, Math.min(maxY, nextTy)),
      };
    },
    []
  );

  // Wheel zoom centered on the cursor. We use a manual addEventListener
  // with { passive: false } because React's onWheel prop is passive by
  // default in React 17+ and preventDefault() is silently ignored there.
  React.useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const rect = el.getBoundingClientRect();
      // Cursor offset from container CENTER (since transform-origin is center).
      const cx = e.clientX - rect.left - rect.width / 2;
      const cy = e.clientY - rect.top - rect.height / 2;

      const prevScale = scaleRef.current;
      const factor = Math.exp(-e.deltaY * WHEEL_SENSITIVITY);
      const nextScale = Math.max(
        WHEEL_MIN,
        Math.min(WHEEL_MAX, prevScale * factor)
      );
      if (nextScale === prevScale) return;

      // Cursor-centered zoom: keep the point under the cursor stationary.
      // tx_new = cx - (cx - tx_old) * (nextScale / prevScale)
      const ratio = nextScale / prevScale;
      const rawTx = cx - (cx - txRef.current) * ratio;
      const rawTy = cy - (cy - tyRef.current) * ratio;
      const clamped = clampPan(rawTx, rawTy, nextScale);

      setScale(nextScale);
      setTx(clamped.tx);
      setTy(clamped.ty);
    };

    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [clampPan]);

  // ============================================================
  // Touch support: pinch-zoom (2 fingers, center between them),
  // pan (1 finger when zoomed), double-tap toggle 1× ↔ 2×. Lives
  // in its own effect block so the existing mouse handlers above
  // remain untouched. All touch events are registered manually with
  // { passive: false } so we can preventDefault() the browser's
  // native pinch/scroll while gestures are in progress.
  // ============================================================
  React.useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    let pinchInitialDistance = 0;
    let pinchInitialScale = 1;
    let pinchCenterX = 0;
    let pinchCenterY = 0;
    let pinchInitialTx = 0;
    let pinchInitialTy = 0;
    let panLastX = 0;
    let panLastY = 0;
    let panActive = false;
    let lastTapTime = 0;
    let lastTapX = 0;
    let lastTapY = 0;
    const DOUBLE_TAP_MS = 300;
    const DOUBLE_TAP_PX = 30;

    const dist = (t1: Touch, t2: Touch) =>
      Math.hypot(t2.clientX - t1.clientX, t2.clientY - t1.clientY);

    const onTouchStart = (e: TouchEvent) => {
      const rect = el.getBoundingClientRect();
      if (e.touches.length === 2) {
        e.preventDefault();
        const [t1, t2] = [e.touches[0], e.touches[1]];
        pinchInitialDistance = dist(t1, t2);
        pinchInitialScale = scaleRef.current;
        pinchInitialTx = txRef.current;
        pinchInitialTy = tyRef.current;
        // Center between fingers, relative to container CENTER.
        pinchCenterX =
          (t1.clientX + t2.clientX) / 2 - rect.left - rect.width / 2;
        pinchCenterY =
          (t1.clientY + t2.clientY) / 2 - rect.top - rect.height / 2;
        panActive = false;
      } else if (e.touches.length === 1) {
        const t = e.touches[0];
        // Double-tap detection: same spot, within DOUBLE_TAP_MS.
        const now = Date.now();
        const dx = t.clientX - lastTapX;
        const dy = t.clientY - lastTapY;
        if (
          now - lastTapTime < DOUBLE_TAP_MS &&
          Math.hypot(dx, dy) < DOUBLE_TAP_PX
        ) {
          e.preventDefault();
          // Toggle 1× ↔ DBL_CLICK_ZOOM, centered on the tap point.
          if (scaleRef.current > 1) {
            setScale(1);
            setTx(0);
            setTy(0);
          } else {
            const cx = t.clientX - rect.left - rect.width / 2;
            const cy = t.clientY - rect.top - rect.height / 2;
            const ratio = DBL_CLICK_ZOOM;
            const rawTx = cx - cx * ratio;
            const rawTy = cy - cy * ratio;
            const clamped = clampPan(rawTx, rawTy, DBL_CLICK_ZOOM);
            setScale(DBL_CLICK_ZOOM);
            setTx(clamped.tx);
            setTy(clamped.ty);
          }
          lastTapTime = 0; // consume — prevent triple-tap chains
          return;
        }
        lastTapTime = now;
        lastTapX = t.clientX;
        lastTapY = t.clientY;
        // Single-finger pan only when already zoomed in.
        if (scaleRef.current > 1) {
          e.preventDefault();
          panLastX = t.clientX;
          panLastY = t.clientY;
          panActive = true;
        }
      }
    };

    const onTouchMove = (e: TouchEvent) => {
      if (e.touches.length === 2 && pinchInitialDistance > 0) {
        e.preventDefault();
        const [t1, t2] = [e.touches[0], e.touches[1]];
        const currentDistance = dist(t1, t2);
        const rawScale =
          (currentDistance / pinchInitialDistance) * pinchInitialScale;
        const nextScale = Math.max(WHEEL_MIN, Math.min(WHEEL_MAX, rawScale));

        // Cursor-centered (pinch-center, really) zoom relative to the
        // pinch start so the midpoint between fingers stays put.
        const ratio = nextScale / pinchInitialScale;
        const rawTx = pinchCenterX - (pinchCenterX - pinchInitialTx) * ratio;
        const rawTy = pinchCenterY - (pinchCenterY - pinchInitialTy) * ratio;
        const clamped = clampPan(rawTx, rawTy, nextScale);

        setScale(nextScale);
        setTx(clamped.tx);
        setTy(clamped.ty);
      } else if (e.touches.length === 1 && panActive) {
        e.preventDefault();
        const t = e.touches[0];
        const dx = t.clientX - panLastX;
        const dy = t.clientY - panLastY;
        panLastX = t.clientX;
        panLastY = t.clientY;
        const clamped = clampPan(
          txRef.current + dx,
          tyRef.current + dy,
          scaleRef.current
        );
        setTx(clamped.tx);
        setTy(clamped.ty);
      }
    };

    const onTouchEnd = (e: TouchEvent) => {
      // Reset gesture tracking when fingers lift. We check remaining
      // touches so partial lifts (2→1 finger) handoff cleanly into pan.
      if (e.touches.length < 2) {
        pinchInitialDistance = 0;
      }
      if (e.touches.length === 0) {
        panActive = false;
      } else if (e.touches.length === 1 && scaleRef.current > 1) {
        // 2→1 finger lift: switch from pinch to pan seamlessly.
        const t = e.touches[0];
        panLastX = t.clientX;
        panLastY = t.clientY;
        panActive = true;
      }
    };

    el.addEventListener("touchstart", onTouchStart, { passive: false });
    el.addEventListener("touchmove", onTouchMove, { passive: false });
    el.addEventListener("touchend", onTouchEnd);
    el.addEventListener("touchcancel", onTouchEnd);
    return () => {
      el.removeEventListener("touchstart", onTouchStart);
      el.removeEventListener("touchmove", onTouchMove);
      el.removeEventListener("touchend", onTouchEnd);
      el.removeEventListener("touchcancel", onTouchEnd);
    };
  }, [clampPan]);

  // ============================================================
  // Custom context menu — right-click on the image opens our own
  // menu instead of Chrome's native one. The native menu's "Copy
  // image" would copy the optimized mid_* bytes (since that's what
  // <img src> points at); our menu fetches the *original* on demand
  // and writes it to the clipboard. The dialog stays cheap to open
  // because the original is only fetched when the user explicitly
  // asks for it.
  // ============================================================
  type CopyState = "idle" | "loading" | "done" | "error";
  const [menuPos, setMenuPos] = React.useState<{ x: number; y: number } | null>(null);
  const [copyState, setCopyState] = React.useState<CopyState>("idle");
  const fullUrl = originalUrl ?? src;

  const closeMenu = React.useCallback(() => {
    setMenuPos(null);
    // Reset feedback after a beat so reopening the menu shows "idle".
    setTimeout(() => setCopyState("idle"), 200);
  }, []);

  // Close on outside click / Escape / scroll. Bound only while open.
  React.useEffect(() => {
    if (!menuPos) return;
    const onDown = (e: MouseEvent) => {
      const target = e.target as HTMLElement | null;
      if (target?.closest("[data-image-context-menu]")) return;
      closeMenu();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") closeMenu();
    };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    window.addEventListener("scroll", closeMenu, true);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("scroll", closeMenu, true);
    };
  }, [menuPos, closeMenu]);

  function handleContextMenu(e: React.MouseEvent) {
    e.preventDefault();
    // Position the menu at the cursor, but clamp to viewport so it
    // doesn't overflow off-screen on edge clicks. We use rough
    // estimates for menu size since we don't measure it pre-render.
    const MENU_W = 240;
    const MENU_H = 140;
    const x = Math.min(e.clientX, window.innerWidth - MENU_W - 8);
    const y = Math.min(e.clientY, window.innerHeight - MENU_H - 8);
    setMenuPos({ x: Math.max(8, x), y: Math.max(8, y) });
    setCopyState("idle");
  }

  /**
   * Fetches the original image and writes it to the clipboard as PNG.
   *
   * Why convert to PNG via canvas:
   * - `navigator.clipboard.write` + `ClipboardItem` only reliably
   *   supports `image/png` across browsers. JPEG/WebP blobs either
   *   silently fail or throw NotAllowedError in Chrome.
   * - Drawing through a canvas re-encodes whatever format the
   *   original is into a fresh PNG, which costs ~100–300ms on a
   *   typical generation but works universally.
   * - For images with CORS issues we'd hit a tainted canvas; the
   *   originals come from our own backend / proxied providers, so
   *   this isn't a concern in practice. If it ever becomes one,
   *   the fetch path below will throw and we surface "error".
   */
  async function copyOriginalToClipboard() {
    if (!fullUrl) return;
    setCopyState("loading");
    try {
      const res = await fetch(fullUrl);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const blob = await res.blob();
      // Decode → draw on canvas → re-encode as PNG.
      const bitmap = await createImageBitmap(blob);
      const canvas = document.createElement("canvas");
      canvas.width = bitmap.width;
      canvas.height = bitmap.height;
      const ctx = canvas.getContext("2d");
      if (!ctx) throw new Error("2D context unavailable");
      ctx.drawImage(bitmap, 0, 0);
      bitmap.close?.();
      const pngBlob: Blob = await new Promise((resolve, reject) => {
        canvas.toBlob(
          (b) => (b ? resolve(b) : reject(new Error("toBlob returned null"))),
          "image/png"
        );
      });
      await navigator.clipboard.write([
        new ClipboardItem({ "image/png": pngBlob }),
      ]);
      setCopyState("done");
      setTimeout(closeMenu, 600);
    } catch (err) {
      console.error("[ImageDialog] copy original failed:", err);
      setCopyState("error");
      setTimeout(closeMenu, 1200);
    }
  }

  async function downloadOriginal() {
    if (!fullUrl) return;
    try {
      const res = await fetch(fullUrl);
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = downloadFilename || "image.png";
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch (err) {
      console.error("[ImageDialog] download original failed:", err);
    }
    closeMenu();
  }

  function openOriginalInNewTab() {
    if (!fullUrl) return;
    window.open(fullUrl, "_blank", "noopener,noreferrer");
    closeMenu();
  }

  function handleMouseDown(e: React.MouseEvent) {
    if (e.button !== 0) return; // left button only
    if (scale <= 1) return; // nothing to pan when not zoomed
    dragStateRef.current = {
      startX: e.clientX,
      startY: e.clientY,
      startTx: tx,
      startTy: ty,
    };
    setIsPanning(true);
  }

  function handleMouseMove(e: React.MouseEvent) {
    const drag = dragStateRef.current;
    if (!drag) return;
    const dx = e.clientX - drag.startX;
    const dy = e.clientY - drag.startY;
    const clamped = clampPan(drag.startTx + dx, drag.startTy + dy, scale);
    setTx(clamped.tx);
    setTy(clamped.ty);
  }

  function handleMouseUp() {
    dragStateRef.current = null;
    setIsPanning(false);
  }

  // Double-click toggles between 1× and DBL_CLICK_ZOOM, centered on the
  // cursor (so the point you're inspecting stays under your pointer).
  function handleDoubleClick(e: React.MouseEvent) {
    const el = containerRef.current;
    if (!el) return;
    if (scale > 1) {
      // Already zoomed → reset.
      setScale(1);
      setTx(0);
      setTy(0);
      return;
    }
    const rect = el.getBoundingClientRect();
    const cx = e.clientX - rect.left - rect.width / 2;
    const cy = e.clientY - rect.top - rect.height / 2;
    // Same cursor-centered formula as wheel zoom, going from 1 → DBL_CLICK_ZOOM.
    const ratio = DBL_CLICK_ZOOM / 1;
    const rawTx = cx - cx * ratio;
    const rawTy = cy - cy * ratio;
    const clamped = clampPan(rawTx, rawTy, DBL_CLICK_ZOOM);
    setScale(DBL_CLICK_ZOOM);
    setTx(clamped.tx);
    setTy(clamped.ty);
  }

  const isZoomed = scale > 1;
  const cursor = isPanning
    ? "grabbing"
    : isZoomed
      ? "grab"
      : "zoom-in";

  return (
    <div
      ref={containerRef}
      className="relative flex max-h-[82vh] max-w-[92vw] items-center justify-center overflow-hidden select-none"
      style={{ cursor, touchAction: "none" }}
      onMouseDown={handleMouseDown}
      onMouseMove={handleMouseMove}
      onMouseUp={handleMouseUp}
      onMouseLeave={() => {
        // Cancel any in-progress drag if the cursor escapes the container.
        if (dragStateRef.current) {
          dragStateRef.current = null;
          setIsPanning(false);
        }
      }}
      onDoubleClick={handleDoubleClick}
      onContextMenu={handleContextMenu}
    >
      {/* Zoom/pan transform now lives on this wrapper div so both the
          sharp and backdrop layers transform together. The BlurUpImage
          root is sized by the sharp image's intrinsic dimensions
          (fit="natural"), capped by max-h/max-w on the wrapper. */}
      <div
        className="max-h-[82vh] max-w-[92vw]"
        style={{
          transform: `translate(${tx}px, ${ty}px) scale(${scale})`,
          transformOrigin: "center center",
          // Smooth transition only for click-step / dbl-click zoom, not
          // wheel or pan (those need to feel instantaneous to be usable).
          transition: isPanning ? "none" : "transform 120ms ease-out",
          willChange: "transform",
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
      {menuPos && (
        <div
          data-image-context-menu
          // Fixed positioning with viewport coords — the menu floats
          // above everything, including the dialog overlay. We stop
          // pointer events from bubbling so clicks inside the menu
          // don't immediately trigger the outside-click close handler.
          style={{
            position: "fixed",
            left: menuPos.x,
            top: menuPos.y,
            zIndex: 100,
          }}
          className="min-w-[220px] overflow-hidden rounded-md border border-border/60 bg-popover/95 py-1 text-sm text-popover-foreground shadow-2xl backdrop-blur-md"
          onContextMenu={(e) => e.preventDefault()}
        >
          <button
            type="button"
            onClick={copyOriginalToClipboard}
            disabled={copyState === "loading" || !fullUrl}
            className="flex w-full items-center justify-between gap-3 px-3 py-2 text-left hover:bg-accent hover:text-accent-foreground disabled:cursor-wait disabled:opacity-70"
          >
            <span>
              {copyState === "loading" && "Копирование…"}
              {copyState === "done" && "Скопировано ✓"}
              {copyState === "error" && "Ошибка копирования"}
              {copyState === "idle" && "Копировать изображение"}
            </span>
            <span className="text-xs text-muted-foreground">оригинал</span>
          </button>
          <button
            type="button"
            onClick={downloadOriginal}
            disabled={!fullUrl}
            className="flex w-full items-center justify-between gap-3 px-3 py-2 text-left hover:bg-accent hover:text-accent-foreground disabled:opacity-50"
          >
            <span>Скачать</span>
            <span className="text-xs text-muted-foreground">оригинал</span>
          </button>
          <button
            type="button"
            onClick={openOriginalInNewTab}
            disabled={!fullUrl}
            className="flex w-full items-center justify-between gap-3 px-3 py-2 text-left hover:bg-accent hover:text-accent-foreground disabled:opacity-50"
          >
            <span>Открыть в новой вкладке</span>
            <span className="text-xs text-muted-foreground">оригинал</span>
          </button>
        </div>
      )}
    </div>
  );
}
