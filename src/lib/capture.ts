/**
 * Turning a page bitmap (or a region of one) into the base64 JPEG the
 * proofread request carries.
 *
 * The bitmaps this reads are the ones the canvas already draws — the page
 * blobs held by the shared LRU (`usePageBitmapCache`) — so proofreading
 * never triggers a second, higher-DPI render of a page the user is looking
 * at. Cropping happens against that same bitmap, which is why block
 * rectangles (stored in preview-DPI pixels, see `ACTIVE_PREVIEW_DPI`) can be
 * used here verbatim with no scaling.
 */

/**
 * Long-edge ceiling for an image sent to the model. A 150 DPI newspaper page
 * is roughly 2500–3200px on its long edge, so a full page is scaled down and
 * a cropped article usually is not — which is the right trade: the article
 * crop is where per-character legibility matters, and it keeps its native
 * resolution.
 */
export const PROOFREAD_IMAGE_MAX_EDGE = 2000;

/** JPEG quality for the same. Newspaper scans are grey text on grey paper;
 *  0.85 is well past the point where artefacts could be mistaken for glyph
 *  detail, and roughly a third the size of 1.0. */
export const PROOFREAD_IMAGE_JPEG_QUALITY = 0.85;

export interface CaptureRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface Size {
  width: number;
  height: number;
}

/**
 * Intersects a crop with the bitmap's bounds, rounded outwards so a rect that
 * straddles a pixel boundary keeps every pixel it touches. Returns `null`
 * when nothing is left — a block whose coordinates were drawn against a
 * different bitmap than the one we ended up with, which must fall back to
 * text-only rather than send a sliver of the margin.
 */
export function clampCrop(
  rect: CaptureRect,
  bitmap: Size
): CaptureRect | null {
  if (!(bitmap.width > 0) || !(bitmap.height > 0)) return null;
  const left = Math.max(0, Math.floor(rect.x));
  const top = Math.max(0, Math.floor(rect.y));
  const right = Math.min(bitmap.width, Math.ceil(rect.x + rect.width));
  const bottom = Math.min(bitmap.height, Math.ceil(rect.y + rect.height));
  const width = right - left;
  const height = bottom - top;
  if (!(width > 0) || !(height > 0)) return null;
  return { x: left, y: top, width, height };
}

/**
 * Size after the long-edge cap. Never upscales: a small crop enlarged to
 * 2000px would cost tokens proportional to its new size while carrying no
 * more detail than it already had.
 */
export function fitWithinLongEdge(
  size: Size,
  maxEdge = PROOFREAD_IMAGE_MAX_EDGE
): Size {
  const longEdge = Math.max(size.width, size.height);
  if (!(longEdge > maxEdge)) {
    return {
      width: Math.max(1, Math.round(size.width)),
      height: Math.max(1, Math.round(size.height)),
    };
  }
  const scale = maxEdge / longEdge;
  return {
    width: Math.max(1, Math.round(size.width * scale)),
    height: Math.max(1, Math.round(size.height * scale)),
  };
}

export interface EncodeOptions {
  maxEdge?: number;
  quality?: number;
}

/**
 * Encodes a region of `source` as bare base64 JPEG — no `data:` prefix, which
 * the backend refuses on purpose (it chooses the mime type itself, see
 * `check_image_b64` in Rust).
 *
 * Throws rather than returning a placeholder on every failure path: the
 * caller's fallback is to send the unit as text only, and that decision
 * belongs to the caller, not to a silently empty string that would reach the
 * request as a corrupt image.
 */
export async function encodeRegionAsJpegBase64(
  source: Blob,
  crop: CaptureRect | null,
  options: EncodeOptions = {}
): Promise<string> {
  const bitmap = await createImageBitmap(source);
  try {
    const full: CaptureRect = {
      x: 0,
      y: 0,
      width: bitmap.width,
      height: bitmap.height,
    };
    const region = crop ? clampCrop(crop, bitmap) : full;
    if (!region) {
      throw new Error("crop does not overlap the page bitmap");
    }
    const target = fitWithinLongEdge(region, options.maxEdge);

    const canvas = document.createElement("canvas");
    canvas.width = target.width;
    canvas.height = target.height;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("2d canvas context unavailable");
    ctx.drawImage(
      bitmap,
      region.x,
      region.y,
      region.width,
      region.height,
      0,
      0,
      target.width,
      target.height
    );

    const dataUrl = canvas.toDataURL(
      "image/jpeg",
      options.quality ?? PROOFREAD_IMAGE_JPEG_QUALITY
    );
    // `toDataURL` falls back to PNG when the requested type is unsupported,
    // and does so silently. The backend labels whatever it receives as JPEG,
    // so shipping PNG bytes under that label would hand the model a broken
    // attachment — refuse instead.
    if (!dataUrl.startsWith("data:image/jpeg")) {
      throw new Error("canvas cannot encode JPEG");
    }
    const comma = dataUrl.indexOf(",");
    if (comma < 0) throw new Error("malformed data URL from canvas");
    return dataUrl.slice(comma + 1);
  } finally {
    bitmap.close?.();
  }
}
