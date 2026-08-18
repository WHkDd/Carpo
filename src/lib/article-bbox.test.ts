import { describe, expect, it } from "vitest";
import {
  articleRectsByPage,
  padRect,
  unionBlockRect,
  ARTICLE_RECT_PADDING,
} from "./article-bbox";
import { pageKey, type Article, type Block } from "@/store/pageStateSlice";

function block(
  id: string,
  x: number,
  y: number,
  w: number,
  h: number
): Block {
  return { id, x, y, w, h, articleId: null, articleOrder: null };
}

function article(
  refs: Array<{ page: number; blockId: string }>
): Article {
  return {
    id: "a-1",
    num: 1,
    title: "报道1",
    blockRefs: refs.map((ref, index) => ({ ...ref, order: index + 1 })),
  };
}

describe("unionBlockRect", () => {
  it("spans every block", () => {
    expect(
      unionBlockRect([block("b1", 10, 20, 30, 40), block("b2", 100, 5, 20, 20)])
    ).toEqual({ x: 10, y: 5, width: 110, height: 55 });
  });

  it("normalizes a block dragged right-to-left", () => {
    // A selection drawn bottom-right → top-left is stored with negative
    // width/height; taking x/x+w literally would produce an inverted rect
    // that crops to nothing.
    expect(unionBlockRect([block("b1", 100, 100, -40, -60)])).toEqual({
      x: 60,
      y: 40,
      width: 40,
      height: 60,
    });
  });

  it("returns null for no blocks or a degenerate one", () => {
    expect(unionBlockRect([])).toBeNull();
    expect(unionBlockRect([block("b1", 10, 10, 0, 0)])).toBeNull();
  });
});

describe("padRect", () => {
  it("grows by a fraction of its own size on every side", () => {
    expect(padRect({ x: 100, y: 200, width: 1000, height: 500 }, 0.02)).toEqual({
      x: 80,
      y: 190,
      width: 1040,
      height: 520,
    });
  });
});

describe("articleRectsByPage", () => {
  it("returns one padded rect per page, in page order", () => {
    // A report continued across a page break: one crop each, and the two
    // must not be merged into a single rect spanning both sheets.
    const pageStates = {
      [pageKey("f1", 3)]: { blocks: [block("b2", 0, 0, 100, 100)] },
      [pageKey("f1", 1)]: {
        blocks: [block("b1", 10, 10, 90, 90), block("b3", 50, 50, 100, 100)],
      },
    };
    const rects = articleRectsByPage(
      article([
        { page: 1, blockId: "b1" },
        { page: 3, blockId: "b2" },
        { page: 1, blockId: "b3" },
      ]),
      pageStates,
      "f1"
    );
    expect(rects.map((r) => r.page)).toEqual([1, 3]);
    expect(rects[0]!.rect).toEqual(
      padRect({ x: 10, y: 10, width: 140, height: 140 }, ARTICLE_RECT_PADDING)
    );
    expect(rects[1]!.rect).toEqual(
      padRect({ x: 0, y: 0, width: 100, height: 100 }, ARTICLE_RECT_PADDING)
    );
  });

  it("skips a reference whose block is gone but keeps the rest", () => {
    // The text was already recognized from all of them; losing one block
    // should shrink the crop, not cancel the article's proofread.
    const pageStates = {
      [pageKey("f1", 1)]: { blocks: [block("b1", 10, 10, 90, 90)] },
    };
    const rects = articleRectsByPage(
      article([
        { page: 1, blockId: "b1" },
        { page: 1, blockId: "deleted" },
      ]),
      pageStates,
      "f1"
    );
    expect(rects).toHaveLength(1);
    expect(rects[0]!.rect.width).toBeCloseTo(90 * (1 + ARTICLE_RECT_PADDING * 2));
  });

  it("returns nothing when every block is gone", () => {
    // The caller sends that unit as text only rather than cropping blindly.
    expect(
      articleRectsByPage(article([{ page: 1, blockId: "gone" }]), {}, "f1")
    ).toEqual([]);
  });

  it("tolerates an article restored without its refs", () => {
    const malformed = { id: "a-1", num: 1, title: "报道1" } as unknown as Article;
    expect(articleRectsByPage(malformed, {}, "f1")).toEqual([]);
  });
});
