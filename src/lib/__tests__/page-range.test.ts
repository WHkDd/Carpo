import { describe, expect, it } from "vitest";
import {
  formatPageRangeLabel,
  PageRangeError,
  parsePageRangePlan,
} from "../page-range";

describe("parsePageRangePlan", () => {
  it("treats an empty range as all pages", () => {
    const plan = parsePageRangePlan("   ", 4);

    expect(plan.pages).toEqual([1, 2, 3, 4]);
    expect(plan.ranges).toEqual([{ from: 1, to: 4 }]);
    expect(plan.paddlePageRanges).toBe("1-4");
    expect(formatPageRangeLabel(plan)).toBe("第 1-4 页 · 全部");
  });

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

  it("rejects page zero", () => {
    expect(() => parsePageRangePlan("0,1", 10)).toThrow("页码从 1 开始");
  });

  it("rejects reversed ranges", () => {
    expect(() => parsePageRangePlan("9-3", 10)).toThrow("页码范围不能倒序");
  });

  it("rejects pages above the total", () => {
    expect(() => parsePageRangePlan("1-11", 10)).toThrow("页码不能超过总页数 10");
  });

  it("rejects illegal characters", () => {
    expect(() => parsePageRangePlan("1;2", 10)).toThrow(PageRangeError);
    expect(() => parsePageRangePlan("1;2", 10)).toThrow(
      "页码范围只能包含数字、逗号和连字符"
    );
  });

  it("rejects empty comma segments", () => {
    expect(() => parsePageRangePlan("1,,2", 10)).toThrow("空段");
  });
});
