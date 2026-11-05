import { describe, expect, it } from "vitest";
import {
  applySuggestions,
  buildProofreadReview,
  findBlockIndexForSuggestion,
  findSuggestionSpan,
  resolveProofreadModel,
  type ProofreadSuggestionWithVerdict,
} from "../proofread";
import type { NonSecretSettings, ProofreadCategory } from "../ipc-types";
import type { LayoutPage } from "../layout-document";

function suggestion(
  before: string,
  after: string,
  context_before: string,
  category: ProofreadCategory = "charform"
): ProofreadSuggestionWithVerdict {
  return {
    before,
    after,
    context_before,
    category,
    confidence: 0.9,
    reason: "test",
    verdict: "accepted",
  };
}

function settings(overrides: Partial<NonSecretSettings>): NonSecretSettings {
  return {
    provider: "openai",
    ocr_profile: "standard",
    language: "zh",
    ocr_prompt: "",
    paddle_url: "",
    paddle_model: "",
    paddle_document_options: {},
    openai_model: "gpt-4o",
    openrouter_model: "google/gemini-2.5-flash",
    openai_compatible_base_url: "",
    openai_compatible_model: "",
    proofread_provider: null,
    proofread_model: "",
    proofread_prompt: "",
    ...overrides,
  } as NonSecretSettings;
}

describe("findSuggestionSpan", () => {
  it("maps through whitespace in the source text", () => {
    // The model's rendering of line breaks is irrelevant — the span still
    // covers exactly the raw `before`, and `rawIndices` lists the raw offset
    // of each non-whitespace character inside it (slot boundaries for the
    // write-back projection).
    const span = findSuggestionSpan("本埠新聞，\n巳於昨日到達。", {
      before: "巳",
      context_before: "本埠新聞，",
    });
    expect(span).toEqual({ start: 6, end: 7, rawIndices: [6] });
  });

  it("reports every non-whitespace raw offset for a multi-character before", () => {
    const span = findSuggestionSpan("甲\n乙\n丙", {
      before: "甲乙",
      context_before: "",
    });
    expect(span).toEqual({ start: 0, end: 3, rawIndices: [0, 2] });
  });

  it("counts overlapping candidates as ambiguous — contract table with the Rust side", () => {
    // `哈哈` occurs at offsets 0 and 1; non-overlap counting would call that
    // unique and apply the correction to the first candidate, which may be
    // exactly the wrong one. The Rust `count_occurrences` asserts the same
    // numbers.
    expect(
      findSuggestionSpan("哈哈哈", { before: "哈哈", context_before: "" })
    ).toBeNull();
    expect(
      findSuggestionSpan("一一一一", { before: "一一", context_before: "" })
    ).toBeNull();
    // A non-overlapping single occurrence still anchors.
    expect(
      findSuggestionSpan("甲乙丙丁", { before: "乙丙", context_before: "" })
    ).toEqual({ start: 1, end: 3, rawIndices: [1, 2] });
  });
});

describe("applySuggestions", () => {
  it("skips a suggestion whose anchor an earlier edit consumed", () => {
    // Both suggestions resolve against the original text, but the second
    // lies inside the first's touched interval — it must be skipped and
    // counted, not double-applied.
    const result = applySuggestions("本埠新聞，巳於昨日到達。", [
      suggestion("巳於昨日", "已於昨日", "本埠新聞，"),
      suggestion("巳", "已", "本埠新聞，"),
    ]);
    expect(result.text).toBe("本埠新聞，已於昨日到達。");
    expect(result.conflictSkipped).toBe(1);
  });

  it("skips a span that overlaps an applied span even when their edits do not touch", () => {
    // s1 edits the first character, s2 the last; the two spans share 五日,
    // and the span-by-span rebuild would emit that shared run twice. The
    // second span must be skipped and counted — for a historical
    // transcript, a missed correction beats a duplicated run of text.
    const result = applySuggestions("叁月五日下芋", [
      suggestion("叁月五日", "三月五日", ""),
      suggestion("五日下芋", "五日下午", ""),
    ]);
    expect(result.text).toBe("三月五日下芋");
    expect(result.conflictSkipped).toBe(1);
  });

  it("applies disjoint suggestions in source order", () => {
    const result = applySuggestions("甲已過，乙已過。", [
      suggestion("已過", "巳過", "乙"),
      suggestion("已過", "巳過", "甲"),
    ]);
    expect(result.text).toBe("甲巳過，乙巳過。");
  });

  it("keeps the newline when only the second character changes", () => {
    // Public-prefix case: the untouched first character's trailing newline
    // must survive the replacement of the second character.
    const result = applySuggestions("甲\n巳", [
      suggestion("甲巳", "甲已", ""),
    ]);
    expect(result.text).toBe("甲\n已");
  });

  it("aligns an equal-length replacement to the slots", () => {
    // The acceptance case for the slot projection: both characters change,
    // and each replacement character lands in its slot — the newline between
    // them is kept, which the old common-prefix algorithm could not do.
    const result = applySuggestions("甲\n巳", [
      suggestion("甲巳", "乙丙", ""),
    ]);
    expect(result.text).toBe("乙\n丙");
  });

  it("keeps the last slot's trailing whitespace on an unequal replacement", () => {
    // Two characters collapse into one: the replacement lands at the first
    // slot, the run's internal newline is dropped, but the newline after the
    // last slot survives — the replacement must not merge into the next
    // line.
    const result = applySuggestions("甲\n乙\n丙", [
      suggestion("甲乙", "丁", ""),
    ]);
    expect(result.text).toBe("丁\n丙");
  });

  it("keeps the dangling line break of a pure deletion", () => {
    // Deleting the last character of a line leaves the break in place — for
    // newspaper OCR, keeping a visible break beats silently merging two
    // lines.
    const result = applySuggestions("於\n是\n乎", [
      suggestion("是乎", "是", "", "garble"),
    ]);
    expect(result.text).toBe("於\n是\n");
  });

  it("writes a pure insertion between slots without consuming whitespace", () => {
    const result = applySuggestions("甲\n巳", [
      suggestion("甲巳", "甲乙巳", ""),
    ]);
    expect(result.text).toBe("甲\n乙巳");
  });

  it("keeps the inner characters' line breaks through an LCS keep", () => {
    // The middle two characters are untouched, so all three newlines
    // survive even though both ends of the span change.
    const result = applySuggestions("甲\n乙\n丙\n丁", [
      suggestion("甲乙丙丁", "戊乙丙己", ""),
    ]);
    expect(result.text).toBe("戊\n乙\n丙\n己");
  });

  it("preserves full-width spaces and tabs around a changed character", () => {
    const fullWidth = applySuggestions("甲\u3000乙", [
      suggestion("甲乙", "甲丙", ""),
    ]);
    expect(fullWidth.text).toBe("甲\u3000丙");
    const tab = applySuggestions("甲\t乙", [
      suggestion("甲乙", "丙乙", ""),
    ]);
    expect(tab.text).toBe("丙\t乙");
  });

  it("inserts whitespace inside after verbatim", () => {
    // `after` is the user-approved text: its whitespace is written as-is,
    // never normalized.
    const result = applySuggestions("甲巳", [
      suggestion("甲巳", "甲\n已", ""),
    ]);
    expect(result.text).toBe("甲\n已");
  });

  it("refuses the second insertion at the same point and counts it", () => {
    // Two suggestions both insert between the same two characters. Applying
    // both would drop one silently; the second must be skipped and visible
    // through `conflictSkipped`.
    const result = applySuggestions("甲\n巳", [
      suggestion("甲巳", "甲乙巳", ""),
      suggestion("甲巳", "甲丙巳", ""),
    ]);
    expect(result.text).toBe("甲\n乙巳");
    expect(result.conflictSkipped).toBe(1);
  });

  it("applies multiple suggestions across one line break in order", () => {
    const result = applySuggestions("甲\n乙", [
      suggestion("甲", "丙", ""),
      suggestion("乙", "丁", ""),
    ]);
    expect(result.text).toBe("丙\n丁");
    expect(result.conflictSkipped).toBe(0);
  });

  it("skips a no-op replacement without claiming its span", () => {
    const result = applySuggestions("甲\n巳", [
      suggestion("甲巳", "甲巳", ""),
      suggestion("巳", "已", "甲"),
    ]);
    expect(result.text).toBe("甲\n已");
    expect(result.conflictSkipped).toBe(0);
  });
});

describe("resolveProofread*", () => {
  it("falls back to the provider's OCR model field", () => {
    expect(
      resolveProofreadModel(
        settings({ proofread_provider: "openrouter", proofread_model: "" })
      )
    ).toBe("google/gemini-2.5-flash");
  });
});

describe("buildProofreadReview", () => {
  it("defaults punct / charform / garble to accepted, the rest to pending", () => {
    const review = buildProofreadReview(
      { key: "page:1", text: "原文" },
      {
        key: "page:1",
        model: "gpt-4o",
        discarded: 2,
        suggestions: [
          suggestion("a", "b", "", "punct"),
          suggestion("c", "d", "", "charform"),
          suggestion("e", "f", "", "garble"),
          suggestion("g", "h", "", "layout"),
          suggestion("i", "j", "", "semantic"),
        ],
      },
      undefined,
      1234
    );
    expect(review).not.toBeNull();
    expect(review!.suggestions.map((s) => s.verdict)).toEqual([
      "accepted",
      "accepted",
      "accepted",
      "pending",
      "pending",
    ]);
    expect(review!.discarded).toBe(2);
    expect(review!.createdAt).toBe(1234);
    expect(review!.status).toBe("pending");
  });
});

describe("findBlockIndexForSuggestion", () => {
  const layout: LayoutPage = {
    index: 1,
    width: 100,
    height: 100,
    blocks: [
      { label: "text", text: "本埠新聞，巳於昨日到達。", bbox: [0, 0, 1, 1] },
      { label: "text", text: "第二欄內容。", bbox: [0, 0, 1, 1] },
    ],
  };

  it("tolerates line breaks in the block text", () => {
    const broken: LayoutPage = {
      ...layout,
      blocks: [{ ...layout.blocks[0]!, text: "本埠新聞，\n巳於昨日到達。" }],
    };
    expect(
      findBlockIndexForSuggestion(broken, { before: "巳", context_before: "本埠新聞，" })
    ).toBe(0);
  });
});
