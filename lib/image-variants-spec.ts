/**
 * Variant resize parameters shared by the client (Canvas/OffscreenCanvas
 * pipeline in lib/image-variants.ts) and the server (sharp pipeline in
 * lib/variants-builder.ts).
 *
 * Quality values are JPEG quality on a 1..100 integer scale (sharp's
 * native unit). The client API `canvas.toBlob(_, 'image/jpeg', q)` takes
 * a 0..1 float — call sites divide by 100 at the call site to keep this
 * module agnostic of the consumer's API.
 */

export const THUMB_WIDTH = 240;
export const THUMB_QUALITY = 70;
export const MID_WIDTH = 1200;
export const MID_QUALITY = 85;
