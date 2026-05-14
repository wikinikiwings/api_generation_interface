/**
 * Client-side image variant generator.
 *
 * Produces downscaled JPEGs suitable for history UI:
 *   - thumb: 240px JPEG q70  (~15 KB typical)
 *   - mid:   1200px JPEG q85 (~150 KB typical)
 *
 * If the source is smaller than the target width, the variant equals
 * the source (re-encoded as JPEG for format normalization).
 *
 * Uses OffscreenCanvas off the main thread when available; falls back
 * to HTMLCanvasElement on older browsers (notably iOS < 16.4).
 */

import {
  THUMB_WIDTH,
  THUMB_QUALITY as THUMB_QUALITY_INT,
  MID_WIDTH,
  MID_QUALITY as MID_QUALITY_INT,
} from "@/lib/image-variants-spec";

// Canvas APIs take a 0..1 float; the shared spec uses a 1..100 int.
const THUMB_QUALITY = THUMB_QUALITY_INT / 100;
const MID_QUALITY = MID_QUALITY_INT / 100;

export interface ImageVariants {
  /** 240px JPEG q70. */
  thumb: Blob;
  /** 1200px JPEG q85. */
  mid: Blob;
  /** Source blob, unchanged (pass-through). */
  full: Blob;
}

export interface VariantCallbacks {
  onFullReady?: (blob: Blob) => void;
  onThumbReady?: (blob: Blob) => void;
  onMidReady?: (blob: Blob) => void;
}

export async function createImageVariants(
  source: Blob | string,
  callbacks?: VariantCallbacks
): Promise<ImageVariants> {
  const full =
    typeof source === "string" ? await fetchAsBlob(source) : source;
  callbacks?.onFullReady?.(full);

  const bitmap = await decode(full);
  try {
    const thumb = await encodeVariant(bitmap, THUMB_WIDTH, THUMB_QUALITY);
    callbacks?.onThumbReady?.(thumb);
    const mid = await encodeVariant(bitmap, MID_WIDTH, MID_QUALITY);
    callbacks?.onMidReady?.(mid);
    return { thumb, mid, full };
  } finally {
    // ImageBitmap is GC-able but close() releases GPU memory eagerly.
    if ("close" in bitmap) bitmap.close();
    // For the HTMLImageElement facade path, revoke the blob URL here — after
    // both encodeVariant calls complete — so the image element retains its
    // decoded backing through both draw passes.
    const f = bitmap as unknown as { __blobUrl?: string };
    if (f.__blobUrl) URL.revokeObjectURL(f.__blobUrl);
  }
}

async function fetchAsBlob(url: string): Promise<Blob> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`fetch ${url}: HTTP ${res.status}`);
  return res.blob();
}

async function decode(blob: Blob): Promise<ImageBitmap> {
  if (typeof createImageBitmap === "function") {
    return createImageBitmap(blob);
  }
  return decodeViaImageElement(blob);
}

async function decodeViaImageElement(blob: Blob): Promise<ImageBitmap> {
  const url = URL.createObjectURL(blob);
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const el = new Image();
      el.onload = () => resolve(el);
      el.onerror = () => reject(new Error("decode failed"));
      el.src = url;
    });
    // Wrap HTMLImageElement in an ImageBitmap-like facade. We only need
    // width/height and the ability to draw it, which `drawImage` accepts
    // on both HTMLImageElement and ImageBitmap.
    return {
      width: img.naturalWidth,
      height: img.naturalHeight,
      close: () => {},
      // @ts-ignore — the outer `as unknown as ImageBitmap` cast silences the
      // type mismatch before @ts-expect-error can engage (TS2578), so we use
      // @ts-ignore instead. The HTMLImageElement stands in for ImageBitmap.
      __img: img,
      __blobUrl: url,
    } as unknown as ImageBitmap;
  } catch (e) {
    URL.revokeObjectURL(url);
    throw e;
  }
}

async function encodeVariant(
  bitmap: ImageBitmap,
  targetWidth: number,
  quality: number
): Promise<Blob> {
  const { width: sw, height: sh } = bitmap;
  const scale = sw <= targetWidth ? 1 : targetWidth / sw;
  const dw = Math.round(sw * scale);
  const dh = Math.round(sh * scale);

  if (typeof OffscreenCanvas !== "undefined") {
    const canvas = new OffscreenCanvas(dw, dh);
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("OffscreenCanvas 2d ctx unavailable");
    drawInto(ctx, bitmap, dw, dh);
    return canvas.convertToBlob({ type: "image/jpeg", quality });
  }

  const canvas = document.createElement("canvas");
  canvas.width = dw;
  canvas.height = dh;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Canvas 2d ctx unavailable");
  drawInto(ctx, bitmap, dw, dh);
  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(
      (b) => (b ? resolve(b) : reject(new Error("canvas.toBlob returned null"))),
      "image/jpeg",
      quality
    );
  });
}

function drawInto(
  ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
  bitmap: ImageBitmap,
  dw: number,
  dh: number
) {
  const source =
    (bitmap as unknown as { __img?: CanvasImageSource }).__img ?? bitmap;
  ctx.drawImage(source, 0, 0, dw, dh);
}
