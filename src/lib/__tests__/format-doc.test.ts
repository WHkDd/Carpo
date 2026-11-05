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
});
