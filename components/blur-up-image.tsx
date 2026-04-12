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
   * Extra className for the sharp `<img>` directly — useful in
   * `fit="natural"` mode where the sharp img drives the layout and
   * the caller needs to impose max-width / max-height / object-fit
   * directly on the bitmap layer.
   */
  sharpClassName?: string;
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
 * If the sharp layer's `onLoad` fires within this window after mount,
 * treat the image as "already available" (blob-URL, HTTP cache, or
 * decoded by a previous mount) and skip the curtain animation — the
 * reveal is only meaningful for genuinely-loading images, not for
 * cache-warm re-renders.
 */
const INSTANT_LOAD_THRESHOLD_MS = 60;

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
      sharpClassName,
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

    const revealMsRef = React.useRef(revealMs);
    revealMsRef.current = revealMs;

    // Timestamp at mount so we can measure how long the sharp layer
    // took to load. Fast loads (< INSTANT_LOAD_THRESHOLD_MS) mean the
    // image was already in the HTTP/blob cache — no reveal needed.
    const mountTimeRef = React.useRef<number>(
      typeof performance !== "undefined" ? performance.now() : 0
    );

    // Trigger reveal exactly once per mount when sharp first loads.
    React.useEffect(() => {
      if (!sharpLoaded) return;
      if (hasPlayedRef.current) return;
      hasPlayedRef.current = true;

      const elapsed =
        typeof performance !== "undefined"
          ? performance.now() - mountTimeRef.current
          : Number.POSITIVE_INFINITY;

      if (reducedMotion || elapsed < INSTANT_LOAD_THRESHOLD_MS) {
        // Skip curtain: either the user prefers reduced motion, or the
        // image was already cached and arrived too fast to animate
        // without looking silly / being theatrical for no reason.
        setRevealState("done");
        return;
      }

      setRevealState("playing");
      const t = window.setTimeout(() => {
        setRevealState("done");
      }, revealMsRef.current);
      return () => window.clearTimeout(t);
      // revealMs intentionally omitted from deps: it's read through
      // a ref so a prop change mid-reveal doesn't cancel the timer
      // and strand the state machine at "playing".
    }, [sharpLoaded, reducedMotion]);

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
          className={cn("blur-up-sharp", imgFitClass, sharpClassName)}
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
  const [reduced, setReduced] = React.useState<boolean>(() => {
    if (typeof window === "undefined" || !window.matchMedia) return false;
    return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  });
  React.useEffect(() => {
    if (typeof window === "undefined" || !window.matchMedia) return;
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    // Also re-read here in case the value changed between the lazy
    // initialiser and effect (hot reload, SSR hand-off).
    setReduced(mq.matches);
    const onChange = () => setReduced(mq.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);
  return reduced;
}
