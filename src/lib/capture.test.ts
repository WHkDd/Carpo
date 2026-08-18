import { describe, expect, it } from "vitest";
import {
  clampCrop,
  fitWithinLongEdge,
  PROOFREAD_IMAGE_MAX_EDGE,
} from "./capture";

describe("clampCrop", () => {
  it("keeps a crop that is fully inside the bitmap", () => {
    expect(
      clampCrop({ x: 10, y: 20, width: 100, height: 50 }, {
        width: 500,
        height: 400,
      })
    ).toEqual({ x: 10, y: 20, width: 100, height: 50 });
  });

  it("rounds outwards so a straddled pixel is not dropped", () => {
    // A padded article rect lands on fractions almost every time; rounding
    // inwards would shave a column of glyphs off the edge of the crop.
    expect(
      clampCrop({ x: 10.4, y: 20.6, width: 100.2, height: 50.1 }, {
        width: 500,
        height: 400,
      })
    ).toEqual({ x: 10, y: 20, width: 101, height: 51 });
  });

  it("clips a crop that runs past the edges", () => {
    // The 2% padding pushes an article at the page margin out of bounds.
    expect(
      clampCrop({ x: -20, y: -10, width: 200, height: 100 }, {
        width: 150,
        height: 60,
      })
    ).toEqual({ x: 0, y: 0, width: 150, height: 60 });
  });

  it("returns null when nothing overlaps", () => {
    // Coordinates drawn against a different bitmap than the one we got.
    expect(
      clampCrop({ x: 600, y: 10, width: 50, height: 50 }, {
        width: 500,
        height: 400,
      })
    ).toBeNull();
    expect(
      clampCrop({ x: 0, y: 0, width: 10, height: 10 }, { width: 0, height: 0 })
    ).toBeNull();
  });
});

describe("fitWithinLongEdge", () => {
  it("leaves anything already under the cap alone", () => {
    // A cropped article keeps its native resolution — where legibility
    // matters most, nothing is thrown away.
    expect(fitWithinLongEdge({ width: 800, height: 1200 })).toEqual({
      width: 800,
      height: 1200,
    });
  });

  it("scales the long edge down and keeps the aspect ratio", () => {
    const out = fitWithinLongEdge({ width: 2400, height: 3200 });
    expect(out.height).toBe(PROOFREAD_IMAGE_MAX_EDGE);
    expect(out.width).toBe(1500);
  });

  it("measures the long edge on either axis", () => {
    const out = fitWithinLongEdge({ width: 4000, height: 1000 });
    expect(out).toEqual({ width: 2000, height: 500 });
  });

  it("never returns a zero dimension", () => {
    // A one-line sliver scaled by a large factor must still be an image.
    expect(fitWithinLongEdge({ width: 10000, height: 3 }, 100)).toEqual({
      width: 100,
      height: 1,
    });
  });
});
