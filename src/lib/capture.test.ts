import { describe, expect, it } from "vitest";
import { clampCrop, fitWithinLongEdge } from "./capture";

describe("clampCrop", () => {
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
});

describe("fitWithinLongEdge", () => {
  it("never returns a zero dimension", () => {
    // A one-line sliver scaled by a large factor must still be an image.
    expect(fitWithinLongEdge({ width: 10000, height: 3 }, 100)).toEqual({
      width: 100,
      height: 1,
    });
  });
});
