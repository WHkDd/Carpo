import { describe, expect, it } from "vitest";
import { isFullyVisible, wheelDeltaPixels } from "./usePanZoom";

describe("wheel normalization", () => {
  it("normalizes pixel, line, and page deltas", () => {
    expect(wheelDeltaPixels(12, 0, 800)).toBe(12);
    expect(wheelDeltaPixels(3, 1, 800)).toBe(48);
    expect(wheelDeltaPixels(-1, 2, 800)).toBe(-800);
  });
});

describe("revealRect geometry", () => {
  it("counts a rect fully inside, or flush against an edge, as visible", () => {
    const inside = { left: 10, top: 10, right: 90, bottom: 90 };
    expect(isFullyVisible(inside, 100, 100)).toBe(true);
    const flush = { left: 0, top: 0, right: 100, bottom: 100 };
    expect(isFullyVisible(flush, 100, 100)).toBe(true);
  });
});
