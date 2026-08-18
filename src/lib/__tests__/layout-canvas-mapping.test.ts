import { describe, expect, it } from "vitest";
import {
  LAYOUT_MAPPING_TOLERANCE,
  layoutCanvasMapping,
  polygonBoundingRect,
  scaleLayoutBBox,
  scaleLayoutPolygon,
  type LayoutBBox,
} from "@/lib/layout-document";

// A 200×300 mm page: 300 DPI for OCR, and a preview bitmap the backend clamped
// to a lower resolution while still reporting native pixels.
const LAYOUT_300DPI = { width: 2362, height: 3543 };

describe("layoutCanvasMapping", () => {
  it("derives one ratio per axis for the same page at two resolutions", () => {
    const mapping = layoutCanvasMapping(LAYOUT_300DPI, {
      width: 1181,
      height: 1771,
    });
    expect(mapping).not.toBeNull();
    expect(mapping!.sx).toBeCloseTo(0.5, 3);
    expect(mapping!.sy).toBeCloseTo(0.5, 3);
  });

  it("accepts the rounding drift of two independently rounded pixel sizes", () => {
    // 2362 / 1.5 = 1574.67 and 3543 / 1.5 = 2362 — the rounded pair is not
    // exactly isotropic, and refusing it would reject a perfectly good page.
    const mapping = layoutCanvasMapping(LAYOUT_300DPI, {
      width: 1575,
      height: 2362,
    });
    expect(mapping).not.toBeNull();
  });

  it("refuses a measured mapping whose axes disagree beyond the tolerance", () => {
    // Two measurements that cannot both be the same page.
    expect(
      layoutCanvasMapping({ width: 2000, height: 3400 }, { width: 1181, height: 1771 })
    ).toBeNull();
  });

  it("puts the tolerance boundary where it is documented", () => {
    const height = 1000;
    const layout = { width: 1000, height };
    // sy is pinned at 1; sx is pushed just inside and just outside the bound.
    const inside = 1 + LAYOUT_MAPPING_TOLERANCE * 0.9;
    const outside = 1 + LAYOUT_MAPPING_TOLERANCE * 1.1;
    expect(
      layoutCanvasMapping(layout, { width: 1000 * inside, height })
    ).not.toBeNull();
    expect(
      layoutCanvasMapping(layout, { width: 1000 * outside, height })
    ).toBeNull();
  });

  it("maps an approximate page by its long side, isotropically", () => {
    // An inferred size whose short side is 18% short of the page's. Under the
    // measured path this is a 22% axis disagreement and would be refused;
    // approximate pages carry no usable short side, so it is ignored.
    const mapping = layoutCanvasMapping(
      { width: 2224.62, height: 1277, dimensionsApproximate: true },
      { width: 1191, height: 842 }
    );
    expect(mapping).not.toBeNull();
    expect(mapping!.sx).toBe(mapping!.sy);
    expect(mapping!.sx).toBeCloseTo(1191 / 2224.62, 6);
  });

  it("matches long side to long side regardless of the inferred orientation", () => {
    // The importer guesses orientation from block extents; the bitmap is the
    // page itself. A disagreement must not change the scale factor.
    const landscape = layoutCanvasMapping(
      { width: 2224.62, height: 1590.18, dimensionsApproximate: true },
      { width: 1191, height: 842 }
    );
    const transposed = layoutCanvasMapping(
      { width: 1590.18, height: 2224.62, dimensionsApproximate: true },
      { width: 1191, height: 842 }
    );
    expect(landscape!.sx).toBeCloseTo(transposed!.sx, 10);
  });

  it("still refuses degenerate dimensions on the approximate path", () => {
    const image = { width: 1191, height: 842 };
    expect(
      layoutCanvasMapping({ width: 0, height: 1590, dimensionsApproximate: true }, image)
    ).toBeNull();
    expect(
      layoutCanvasMapping({ width: 2224, height: 1590, dimensionsApproximate: true }, {
        width: 0,
        height: 0,
      })
    ).toBeNull();
  });

  it("refuses missing or degenerate dimensions instead of dividing by zero", () => {
    const image = { width: 1181, height: 1771 };
    expect(layoutCanvasMapping(null, image)).toBeNull();
    expect(layoutCanvasMapping(undefined, image)).toBeNull();
    expect(layoutCanvasMapping(LAYOUT_300DPI, null)).toBeNull();
    expect(layoutCanvasMapping({ width: 0, height: 3543 }, image)).toBeNull();
    expect(layoutCanvasMapping({ width: 2362, height: 0 }, image)).toBeNull();
    expect(layoutCanvasMapping(LAYOUT_300DPI, { width: 0, height: 0 })).toBeNull();
    expect(
      layoutCanvasMapping({ width: -2362, height: -3543 }, image)
    ).toBeNull();
  });
});

describe("scaleLayoutBBox", () => {
  const mapping = { sx: 0.5, sy: 0.5 };

  it("converts corners into x/y/width/height", () => {
    expect(scaleLayoutBBox([100, 200, 500, 800], mapping)).toEqual({
      x: 50,
      y: 100,
      width: 200,
      height: 300,
    });
  });

  it("normalizes corners given in the wrong order", () => {
    // Konva draws a negative width as nothing, so a reversed bbox would
    // silently produce no highlight at all.
    expect(scaleLayoutBBox([500, 800, 100, 200], mapping)).toEqual({
      x: 50,
      y: 100,
      width: 200,
      height: 300,
    });
  });

  it("scales each axis by its own factor", () => {
    const bbox: LayoutBBox = [0, 0, 100, 100];
    expect(scaleLayoutBBox(bbox, { sx: 2, sy: 3 })).toEqual({
      x: 0,
      y: 0,
      width: 200,
      height: 300,
    });
  });
});

describe("scaleLayoutPolygon", () => {
  const mapping = { sx: 0.5, sy: 0.5 };

  it("flattens points the way Konva's Line wants them", () => {
    expect(
      scaleLayoutPolygon(
        [
          [100, 200],
          [500, 200],
          [500, 800],
          [100, 800],
        ],
        mapping
      )
    ).toEqual([50, 100, 250, 100, 250, 400, 50, 400]);
  });

  it("returns null for a polygon that cannot enclose anything", () => {
    expect(scaleLayoutPolygon(undefined, mapping)).toBeNull();
    expect(scaleLayoutPolygon([], mapping)).toBeNull();
    expect(
      scaleLayoutPolygon(
        [
          [0, 0],
          [10, 10],
        ],
        mapping
      )
    ).toBeNull();
  });

  it("returns null when a coordinate is not a number", () => {
    expect(
      scaleLayoutPolygon(
        [
          [0, 0],
          [Number.NaN, 10],
          [10, 10],
        ],
        mapping
      )
    ).toBeNull();
  });
});

describe("polygonBoundingRect", () => {
  it("bounds a flat point list with min/max on each axis", () => {
    // The shape of the input is exactly what scaleLayoutPolygon produces.
    expect(polygonBoundingRect([10, 20, 40, 5, 15, 30])).toEqual({
      x: 10,
      y: 5,
      width: 30,
      height: 25,
    });
  });

  it("returns null for a list with fewer than two points", () => {
    expect(polygonBoundingRect([])).toBeNull();
    expect(polygonBoundingRect([1, 2])).toBeNull();
  });

  it("ignores a trailing dangling coordinate", () => {
    // An odd-length list still bounds every complete pair.
    expect(polygonBoundingRect([2, 2, 8, 8, 5])).toEqual({
      x: 2,
      y: 2,
      width: 6,
      height: 6,
    });
  });

  it("returns null when a coordinate is not finite", () => {
    expect(polygonBoundingRect([0, 0, 4, Number.NaN])).toBeNull();
  });
});

// ---------------------------------------------------------------------
// Regression: TNA `FO 17/1007`, page 1.
//
// A real PaddleOCR-VL 1.6 web export with no `page_size` and no `dataInfo`
// on any of its 88 pages. Its landscape pages are 1191×842pt and the server
// rendered them at 2×, so `block_bbox` lives in a 2382×1684 space. Nothing
// in the JSON states that, so the importer has to infer it; the export's own
// `layout_det_res` visualization is what pins it down for this test (2000
// ×1413, drawing the page's boxes down to y=1308 where the tallest bbox is
// y=1559: 1559 × 1413/1308 = 1684).
// ---------------------------------------------------------------------
describe("FO 17/1007 page 1", () => {
  /** The page as the canvas draws it: the PDF's own 1191×842 pt/px frame. */
  const BITMAP = { width: 1191, height: 842 };
  /** The space `block_bbox` actually lives in. */
  const TRUE_LAYOUT = { width: 2382, height: 1684 };
  /** `text` block #5 — the handwritten paragraph "The Grand Secretary Li…". */
  const BLOCK: LayoutBBox = [1276, 586, 1993, 1320];
  /** What the importer infers, pooled over all 88 pages and padded 2%: the
   *  furthest right any page's content reached (page 21, x=2273) and the
   *  furthest down any page's reached (page 88, y=1645). */
  const INFERRED = {
    width: 2273 * 1.02,
    height: 1645 * 1.02,
    dimensionsApproximate: true,
  };

  const truth = scaleLayoutBBox(BLOCK, layoutCanvasMapping(TRUE_LAYOUT, BITMAP)!);

  const relativeError = (got: number, want: number) => Math.abs(got / want - 1);

  it("lands the block within 1% of where it really is", () => {
    const mapping = layoutCanvasMapping(INFERRED, BITMAP);
    expect(mapping).not.toBeNull();
    const rect = scaleLayoutBBox(BLOCK, mapping!);
    for (const key of ["x", "y", "width", "height"] as const) {
      expect(relativeError(rect[key], truth[key])).toBeLessThan(0.01);
    }
  });

  it("takes the tighter of the two bounds, not the long side alone", () => {
    // Page 21 got within 4.6% of the right edge; page 88 got within 2.3% of
    // the bottom. Reading the long side alone would inherit the worse of the
    // two, so the height is what actually carries this file.
    const longSideOnly =
      Math.max(BITMAP.width, BITMAP.height) /
      Math.max(INFERRED.width, INFERRED.height);
    const chosen = layoutCanvasMapping(INFERRED, BITMAP)!.sx;
    const trueScale = BITMAP.width / TRUE_LAYOUT.width;
    expect(chosen).toBeLessThan(longSideOnly);
    expect(relativeError(chosen, trueScale)).toBeLessThan(
      relativeError(longSideOnly, trueScale)
    );
  });

  it("would have been ~19% off had the 2000px image echo been trusted", () => {
    // Both `inputImage` and `outputImages` come back capped at 2000px on the
    // long side while layout ran on the larger internal render. The echo
    // keeps the page's aspect ratio exactly, so this mapping is accepted by
    // the measured path — it is wrong without being detectably wrong, which
    // is why the importer no longer reads it.
    const echo = { width: 2000, height: 1413 };
    const mapping = layoutCanvasMapping(echo, BITMAP);
    expect(mapping).not.toBeNull();
    const rect = scaleLayoutBBox(BLOCK, mapping!);
    expect(relativeError(rect.x, truth.x)).toBeGreaterThan(0.15);
    expect(rect.x).toBeGreaterThan(truth.x);
    expect(rect.y).toBeGreaterThan(truth.y);
  });

  it("no longer refuses a page whose content stops short of the margin", () => {
    // Page 15's own extent is 2167×1252 — an aspect of 1.73 against the
    // page's 1.414. As a per-page estimate that is a 22% axis disagreement
    // and the overlay drew nothing at all; 56 of the file's 88 pages were
    // refused this way.
    const perPageEstimate = { width: 2167 * 1.02, height: 1252 * 1.02 };
    expect(layoutCanvasMapping(perPageEstimate, BITMAP)).toBeNull();
    expect(
      layoutCanvasMapping({ ...perPageEstimate, dimensionsApproximate: true }, BITMAP)
    ).not.toBeNull();
    // …and page 15 gets the document's size, not its own, so it maps as well
    // as page 1 does.
    const rect = scaleLayoutBBox(BLOCK, layoutCanvasMapping(INFERRED, BITMAP)!);
    expect(relativeError(rect.x, truth.x)).toBeLessThan(0.02);
  });
});
