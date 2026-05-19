export interface PageRange {
  from: number;
  to: number;
}

export interface PageRangePlan {
  raw: string;
  totalPages: number;
  ranges: PageRange[];
  pages: number[];
  paddlePageRanges: string;
}

export class PageRangeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PageRangeError";
  }
}

export function parsePageRangePlan(raw: string, totalPages: number): PageRangePlan {
  const normalizedTotal = Math.floor(totalPages);
  if (!Number.isFinite(normalizedTotal) || normalizedTotal < 1) {
    throw new PageRangeError("总页数无效");
  }

  const normalizedRaw = raw.trim();
  if (normalizedRaw.length === 0) {
    return makePlan(raw, normalizedTotal, [{ from: 1, to: normalizedTotal }]);
  }

  if (/[^0-9,\-\s]/.test(normalizedRaw)) {
    throw new PageRangeError("页码范围只能包含数字、逗号和连字符");
  }

  const pages = new Set<number>();
  const parts = normalizedRaw.split(",");
  for (const part of parts) {
    const token = part.trim();
    if (token.length === 0) {
      throw new PageRangeError("页码范围里有空段，请删除多余逗号");
    }
    const rangeMatch = token.match(/^(\d+)\s*-\s*(\d+)$/);
    const singleMatch = token.match(/^\d+$/);

    let from: number;
    let to: number;
    if (rangeMatch) {
      from = Number(rangeMatch[1]);
      to = Number(rangeMatch[2]);
    } else if (singleMatch) {
      from = Number(token);
      to = from;
    } else if (/^-\d+/.test(token) || /\s-\d+/.test(token)) {
      throw new PageRangeError("页码不能为负数");
    } else {
      throw new PageRangeError(`页码范围格式无效：${token}`);
    }

    validateBounds(from, to, normalizedTotal);
    for (let page = from; page <= to; page += 1) {
      pages.add(page);
    }
  }

  const sortedPages = Array.from(pages).sort((a, b) => a - b);
  return makePlan(raw, normalizedTotal, rangesFromPages(sortedPages));
}

function validateBounds(from: number, to: number, totalPages: number): void {
  if (from === 0 || to === 0) {
    throw new PageRangeError("页码从 1 开始，不能为 0");
  }
  if (from < 0 || to < 0) {
    throw new PageRangeError("页码不能为负数");
  }
  if (to < from) {
    throw new PageRangeError(`页码范围不能倒序：${from}-${to}`);
  }
  if (from > totalPages || to > totalPages) {
    throw new PageRangeError(`页码不能超过总页数 ${totalPages}`);
  }
}

function rangesFromPages(pages: number[]): PageRange[] {
  const ranges: PageRange[] = [];
  for (const page of pages) {
    const last = ranges.at(-1);
    if (last && page === last.to + 1) {
      last.to = page;
    } else {
      ranges.push({ from: page, to: page });
    }
  }
  return ranges;
}

function makePlan(
  raw: string,
  totalPages: number,
  ranges: PageRange[]
): PageRangePlan {
  const pages = ranges.flatMap((range) =>
    Array.from({ length: range.to - range.from + 1 }, (_, i) => range.from + i)
  );
  return {
    raw,
    totalPages,
    ranges,
    pages,
    paddlePageRanges: ranges.map(formatRange).join(","),
  };
}

function formatRange(range: PageRange): string {
  return range.from === range.to ? String(range.from) : `${range.from}-${range.to}`;
}

export function formatPageRangeLabel(plan: PageRangePlan): string {
  const full =
    plan.ranges.length === 1 &&
    plan.ranges[0]?.from === 1 &&
    plan.ranges[0]?.to === plan.totalPages;
  if (full) return `第 1-${plan.totalPages} 页 · 全部`;
  return `第 ${plan.paddlePageRanges} 页`;
}
