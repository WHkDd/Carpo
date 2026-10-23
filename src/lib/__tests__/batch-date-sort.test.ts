import { describe, expect, it } from "vitest";
import { t } from "@/i18n";
import {
  parseSortDate,
  safeFileStem,
  planOutputDocs,
  sortBatchEntries,
  type BatchEntry,
} from "../batch-export";

function entry(
  name: string,
  newspaperName = "",
  dateText = "",
  tags: string[] = []
): BatchEntry {
  return {
    fileId: name,
    name,
    newspaperName,
    dateText,
    date: parseSortDate(dateText),
    tags,
  };
}

const names = (entries: BatchEntry[]) => entries.map((e) => e.name);

describe("parseSortDate", () => {
  it.each([
    ["1936-05-12", { year: 1936, month: 5, day: 12 }],
    ["1936.5.12", { year: 1936, month: 5, day: 12 }],
    ["1936/5/12", { year: 1936, month: 5, day: 12 }],
    ["1936年5月12日", { year: 1936, month: 5, day: 12 }],
    [" 1936 年 5 月 12 日 ", { year: 1936, month: 5, day: 12 }],
    ["１９３６－０５－１２", { year: 1936, month: 5, day: 12 }],
    ["1936-05", { year: 1936, month: 5 }],
    ["1936年5月", { year: 1936, month: 5 }],
    ["1936", { year: 1936 }],
    ["1936年", { year: 1936 }],
    ["1936-02-29", { year: 1936, month: 2, day: 29 }], // leap year
  ])("parses %s", (raw, expected) => {
    expect(parseSortDate(raw)).toEqual(expected);
  });

  it.each([
    "",
    "   ",
    "民國二十五年五月十二日",
    "民国25年5月12日",
    "25年5月12日",
    "1936-13-01",
    "1937-02-29",
    "1936-04-31",
    "1936-5/12", // mixed separators
    "1936年5月12",
    "五月十二日",
    "36-5-12",
  ])("rejects %j", (raw) => {
    expect(parseSortDate(raw)).toBeNull();
  });
});

describe("sortBatchEntries", () => {
  it("orders by newspaper, then date, then natural file name", () => {
    const sorted = sortBatchEntries([
      entry("申報-0512-10.jpg", "申報", "1936-05-12"),
      entry("大公報-1.jpg", "大公報", "1936-05-13"),
      entry("申報-0512-2.jpg", "申報", "1936-05-12"),
      entry("申報-0511.jpg", "申報", "1936年5月11日"),
      entry("申報-0512-1.jpg", "申報", "1936.5.12"),
    ]);
    // 大公報 (dà) sorts before 申報 (shēn) by pinyin; same-day pages of one
    // issue fall back to natural order, so 2 precedes 10.
    expect(names(sorted)).toEqual([
      "大公報-1.jpg",
      "申報-0511.jpg",
      "申報-0512-1.jpg",
      "申報-0512-2.jpg",
      "申報-0512-10.jpg",
    ]);
  });

  it("puts unnamed files last and undated files at the end of their group", () => {
    const sorted = sortBatchEntries([
      entry("無名.jpg"),
      entry("b.jpg", "申報", "日期不明"),
      entry("a.jpg", "申報", ""),
      entry("c.jpg", "申報", "1936-05-12"),
      entry("y.jpg", "申報", "1936"),
    ]);
    // Year-only precedes the full dates of that year; unparseable and empty
    // dates trail in file-name order.
    expect(names(sorted)).toEqual(["y.jpg", "c.jpg", "a.jpg", "b.jpg", "無名.jpg"]);
  });
});

describe("planOutputDocs", () => {
  const sorted = sortBatchEntries([
    entry("1.jpg", "申報", "1936-05-12", ["社會", "經濟"]),
    entry("2.jpg", "申報", "1936-05-13", ["社會"]),
    entry("3.jpg", "大公報", "1936-05-12"),
  ]);

  it("by tag: a multi-tag file appears in each tag doc, untagged files last", () => {
    const docs = planOutputDocs("by_tag", sorted);
    expect(docs.map((d) => [d.stem, names(d.entries)])).toEqual([
      ["經濟", ["1.jpg"]],
      ["社會", ["1.jpg", "2.jpg"]],
      [t("batch.untagged"), ["3.jpg"]],
    ]);
  });

  it("merged: one document holding every file exactly once", () => {
    const docs = planOutputDocs("merged", sorted);
    expect(docs).toHaveLength(1);
    expect(names(docs[0]!.entries)).toEqual(["3.jpg", "1.jpg", "2.jpg"]);
  });

  it("separate: one document per file, in sort order", () => {
    expect(planOutputDocs("separate", sorted).map((d) => d.stem)).toEqual([
      "3",
      "1",
      "2",
    ]);
  });
});

describe("safeFileStem", () => {
  it.each([
    ["社會/經濟", "社會_經濟"],
    ["a\u007fb\u0085c", "a_b_c"],
    ["結尾. . ", "結尾"],
    ["CON", "_CON"],
    ["nul.txt", "_nul.txt"],
    ["COM1", "_COM1"],
    ["console", "console"],
    ["///", "___"],
    ["", "_"],
  ])("%j → %j", (raw, expected) => {
    expect(safeFileStem(raw)).toBe(expected);
  });

  it("cuts an over-long name to 200 UTF-8 bytes on a code-point boundary", () => {
    const stem = safeFileStem("報".repeat(400) + "😀");
    expect(new TextEncoder().encode(stem).length).toBeLessThanOrEqual(200);
    expect(stem).toBe("報".repeat(66));
  });
});
