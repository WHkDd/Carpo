import { describe, expect, it } from "vitest";
import {
  isFullyVisible,
  panToCenterRect,
  projectRect,
  wheelDeltaPixels,
  wheelZoomFactor,
} from "./usePanZoom";

describe("wheel normalization", () => {
  it("normalizes pixel, line, and page deltas", () => {
    expect(wheelDeltaPixels(12, 0, 800)).toBe(12);
    expect(wheelDeltaPixels(3, 1, 800)).toBe(48);
    expect(wheelDeltaPixels(-1, 2, 800)).toBe(-800);
  });

  it("produces continuous bounded zoom factors", () => {
    expect(wheelZoomFactor(-20)).toBeGreaterThan(1);
    expect(wheelZoomFactor(20)).toBeLessThan(1);
    expect(wheelZoomFactor(-100_000)).toBe(2);
    expect(wheelZoomFactor(100_000)).toBe(0.5);
  });
});

describe("revealRect geometry", () => {
  it("projects a canvas rect through scale and pan", () => {
    expect(
      projectRect({ x: 100, y: 200, width: 30, height: 40 }, 2, {
        x: -50,
        y: 10,
      })
    ).toEqual({ left: 150, top: 410, right: 210, bottom: 490 });
  });

  it("counts a rect fully inside, or flush against an edge, as visible", () => {
    const inside = { left: 10, top: 10, right: 90, bottom: 90 };
    expect(isFullyVisible(inside, 100, 100)).toBe(true);
    const flush = { left: 0, top: 0, right: 100, bottom: 100 };
    expect(isFullyVisible(flush, 100, 100)).toBe(true);
  });

  it("rejects a rect poking out of any edge", () => {
    const rect = { left: 20, top: 20, right: 80, bottom: 80 };
    expect(isFullyVisible({ ...rect, left: -1 }, 100, 100)).toBe(false);
    expect(isFullyVisible({ ...rect, top: -1 }, 100, 100)).toBe(false);
    expect(isFullyVisible({ ...rect, right: 101 }, 100, 100)).toBe(false);
    expect(isFullyVisible({ ...rect, bottom: 101 }, 100, 100)).toBe(false);
  });

  it("centres the rect in the viewport without touching the zoom", () => {
    // Zoom only enters as the multiplier on the rect; the result is a pan.
    expect(
      panToCenterRect({ x: 100, y: 200, width: 40, height: 20 }, 2, 800, 600)
    ).toEqual({ x: 400 - 120 * 2, y: 300 - 210 * 2 });
  });

  it("centres a zero-size rect like a point", () => {
    expect(
      panToCenterRect({ x: 50, y: 50, width: 0, height: 0 }, 1, 800, 600)
    ).toEqual({ x: 350, y: 250 });
  });
});
