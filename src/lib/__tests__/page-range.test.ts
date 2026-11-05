import { describe, expect, it } from "vitest";
import { parsePageRangePlan } from "../page-range";

describe("parsePageRangePlan", () => {
  it("parses sparse ranges, dedupes pages, sorts, and merges continuity", () => {
    const plan = parsePageRangePlan("8-10, 1-5, 10, 6, 12", 20);

    expect(plan.pages).toEqual([1, 2, 3, 4, 5, 6, 8, 9, 10, 12]);
    expect(plan.ranges).toEqual([
      { from: 1, to: 6 },
      { from: 8, to: 10 },
      { from: 12, to: 12 },
    ]);
    expect(plan.paddlePageRanges).toBe("1-6,8-10,12");
  });

  it("rejects pages above the total", () => {
    expect(() => parsePageRangePlan("1-11", 10)).toThrow("页码不能超过总页数 10");
  });
});
