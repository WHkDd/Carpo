import { describe, expect, it } from "vitest";
import { wheelDeltaPixels, wheelZoomFactor } from "./usePanZoom";

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
