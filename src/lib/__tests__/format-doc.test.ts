import { describe, it, expect } from "vitest";
import { assembleDocument } from "../format-doc";

/**
 * Cross-checked against the Python implementation in newspaper_ocr.py:2532-2549
 * with a small Python harness. Snapshots below are the byte-for-byte expected
 * output for each scenario.
 */
describe("assembleDocument", () => {
  it("joins header + each article body separated by blank lines, rstrips trailing whitespace", () => {
    const out = assembleDocument({
      newspaperName: "申报",
      newspaperDate: "1945-08-15",
      articles: [
        { title: "胜利", text: "今晨, 日本宣布投降。\n全城欢腾。" },
        { title: "号外", text: "本报特刊。\n" },
      ],
    });
    expect(out).toBe(
      "申报\n1945-08-15\n\n胜利\n今晨, 日本宣布投降。\n全城欢腾。\n\n号外\n本报特刊。"
    );
  });

  it("falls back to the first OCR line when the article has no title", () => {
    const out = assembleDocument({
      newspaperName: "申报",
      newspaperDate: "1945-08-15",
      articles: [
        { title: "", text: "  推断标题\n第二行\n第三行  " },
      ],
    });
    expect(out).toBe("申报\n1945-08-15\n\n推断标题\n第二行\n第三行");
  });

  it('substitutes "（无标题）" when both title and OCR text are empty', () => {
    const out = assembleDocument({
      newspaperName: "字林西报",
      newspaperDate: "1937-08-13",
      articles: [{ title: "", text: "" }],
    });
    expect(out).toBe("字林西报\n1937-08-13\n\n（无标题）");
  });

  it("emits header + trailing blank-line-stripping even with zero articles", () => {
    const out = assembleDocument({
      newspaperName: "申报",
      newspaperDate: "1945-08-15",
      articles: [],
    });
    expect(out).toBe("申报\n1945-08-15");
  });

  it("keeps a whitespace-only title as-is (Python parity: only empty string is falsy)", () => {
    const out = assembleDocument({
      newspaperName: "N",
      newspaperDate: "D",
      articles: [{ title: "   ", text: "首行\n余下" }],
    });
    expect(out).toBe("N\nD\n\n   \n首行\n余下");
  });
});
