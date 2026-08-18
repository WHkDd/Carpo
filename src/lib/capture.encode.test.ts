// @vitest-environment jsdom

/**
 * `encodeRegionAsJpegBase64` against stubbed browser primitives.
 *
 * jsdom has neither `createImageBitmap` nor a canvas encoder, so both are
 * stubbed here. That is not a weaker test than it looks: the browser's JPEG
 * encoder is not the code under test — what is, is everything around it. Which
 * source rectangle reaches `drawImage`, what the destination size is, whether
 * a silent PNG fallback is caught, whether the `data:` prefix is stripped, and
 * whether the decoded bitmap is released. Those are all this module's own
 * decisions, and every one of them is a way to hand the model a picture of the
 * wrong thing.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  encodeRegionAsJpegBase64,
  PROOFREAD_IMAGE_JPEG_QUALITY,
  PROOFREAD_IMAGE_MAX_EDGE,
} from "./capture";

interface DrawCall {
  sx: number;
  sy: number;
  sw: number;
  sh: number;
  dx: number;
  dy: number;
  dw: number;
  dh: number;
}

const drawCalls: DrawCall[] = [];
const toDataUrl = vi.fn(
  (type?: string, quality?: number) =>
    `data:${type};base64,ENCODED(${quality})`
);
const close = vi.fn();
let bitmapSize = { width: 3000, height: 4000 };

beforeEach(() => {
  drawCalls.length = 0;
  toDataUrl.mockClear();
  close.mockClear();
  bitmapSize = { width: 3000, height: 4000 };

  vi.stubGlobal("createImageBitmap", async () => ({
    width: bitmapSize.width,
    height: bitmapSize.height,
    close,
  }));

  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(
    () =>
      ({
        drawImage: (
          _image: unknown,
          sx: number,
          sy: number,
          sw: number,
          sh: number,
          dx: number,
          dy: number,
          dw: number,
          dh: number
        ) => {
          drawCalls.push({ sx, sy, sw, sh, dx, dy, dw, dh });
        },
      }) as unknown as CanvasRenderingContext2D
  );
  vi.spyOn(HTMLCanvasElement.prototype, "toDataURL").mockImplementation(
    toDataUrl as unknown as HTMLCanvasElement["toDataURL"]
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const blob = () => new Blob(["ignored"]);

describe("encodeRegionAsJpegBase64", () => {
  it("returns bare base64, with the data: prefix stripped", () => {
    // The backend refuses a payload carrying its own prefix — it chooses the
    // mime type itself — so leaving it on would fail every request.
    return expect(encodeRegionAsJpegBase64(blob(), null)).resolves.toBe(
      `ENCODED(${PROOFREAD_IMAGE_JPEG_QUALITY})`
    );
  });

  it("draws the whole bitmap when there is no crop, scaled to the long edge", async () => {
    await encodeRegionAsJpegBase64(blob(), null);
    expect(drawCalls).toHaveLength(1);
    const call = drawCalls[0]!;
    expect({ sx: call.sx, sy: call.sy, sw: call.sw, sh: call.sh }).toEqual({
      sx: 0,
      sy: 0,
      sw: 3000,
      sh: 4000,
    });
    // 3000×4000 → long edge capped at 2000.
    expect({ dw: call.dw, dh: call.dh }).toEqual({
      dw: 1500,
      dh: PROOFREAD_IMAGE_MAX_EDGE,
    });
  });

  it("draws exactly the requested crop at native size when it fits", async () => {
    // An article crop is the case that matters most: it must land on the
    // article, and it must not be downscaled when it is already small enough
    // — per-character legibility is the whole point of sending the image.
    await encodeRegionAsJpegBase64(blob(), {
      x: 120,
      y: 240,
      width: 800,
      height: 1000,
    });
    expect(drawCalls[0]).toEqual({
      sx: 120,
      sy: 240,
      sw: 800,
      sh: 1000,
      dx: 0,
      dy: 0,
      dw: 800,
      dh: 1000,
    });
  });

  it("clamps a crop that the 2% padding pushed off the page", async () => {
    await encodeRegionAsJpegBase64(blob(), {
      x: -50,
      y: -50,
      width: 4000,
      height: 5000,
    });
    expect(drawCalls[0]).toMatchObject({ sx: 0, sy: 0, sw: 3000, sh: 4000 });
  });

  it("rejects a crop that lies outside the bitmap instead of sending a sliver", async () => {
    await expect(
      encodeRegionAsJpegBase64(blob(), {
        x: 9000,
        y: 0,
        width: 100,
        height: 100,
      })
    ).rejects.toThrow(/crop/);
  });

  it("refuses the silent PNG fallback", async () => {
    // `toDataURL` falls back to PNG when JPEG is unsupported and says nothing
    // about it. The backend labels whatever arrives as JPEG, so PNG bytes
    // under that label are a broken attachment.
    toDataUrl.mockReturnValueOnce("data:image/png;base64,WRONG");
    await expect(encodeRegionAsJpegBase64(blob(), null)).rejects.toThrow(
      /JPEG/
    );
  });

  it("asks for JPEG at the documented quality", async () => {
    await encodeRegionAsJpegBase64(blob(), null);
    expect(toDataUrl).toHaveBeenCalledWith(
      "image/jpeg",
      PROOFREAD_IMAGE_JPEG_QUALITY
    );
  });

  it("releases the decoded bitmap, including on failure", async () => {
    await encodeRegionAsJpegBase64(blob(), null);
    expect(close).toHaveBeenCalledTimes(1);

    // A batch of 20 pages that leaked its bitmaps would hold hundreds of
    // megabytes of decoded pixels until GC caught up.
    close.mockClear();
    toDataUrl.mockReturnValueOnce("data:image/png;base64,WRONG");
    await expect(encodeRegionAsJpegBase64(blob(), null)).rejects.toThrow();
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("honours an explicit max edge and quality", async () => {
    await encodeRegionAsJpegBase64(blob(), null, {
      maxEdge: 400,
      quality: 0.5,
    });
    expect(drawCalls[0]).toMatchObject({ dw: 300, dh: 400 });
    expect(toDataUrl).toHaveBeenCalledWith("image/jpeg", 0.5);
  });
});
