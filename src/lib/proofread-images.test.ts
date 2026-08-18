import { describe, expect, it } from "vitest";
import {
  MAX_PROOFREAD_IMAGES,
  planProofreadImages,
  type PlanSource,
} from "./proofread-images";
import { pageKey, type Article, type Block } from "@/store/pageStateSlice";
import type { ProofreadTarget } from "./proofread";

function block(id: string, x = 0, y = 0, w = 100, h = 100): Block {
  return { id, x, y, w, h, articleId: null, articleOrder: null };
}

function source(
  articles: Article[],
  pageStates: PlanSource["pageStates"] = {}
): PlanSource {
  return { pageStates, getDocumentState: () => ({ articles }) };
}

function article(
  id: string,
  refs: Array<{ page: number; blockId: string }>
): Article {
  return {
    id,
    num: 1,
    title: id,
    blockRefs: refs.map((ref, index) => ({ ...ref, order: index + 1 })),
  };
}

describe("planProofreadImages", () => {
  it("plans one whole-page image per whole-file target", () => {
    const targets: ProofreadTarget[] = [
      { mode: "whole_file", page: 4 },
      { mode: "whole_file", page: 7 },
    ];
    expect(planProofreadImages(source([]), "f1", targets)).toEqual([
      { key: "page:4", page: 4, crop: null },
      { key: "page:7", page: 7, crop: null },
    ]);
  });

  it("plans one crop per page a grouped article occupies", () => {
    // A report running across a page break needs both sheets — this is why
    // the cap counts images and not units.
    const plans = planProofreadImages(
      source(
        [article("a-1", [
          { page: 1, blockId: "b1" },
          { page: 2, blockId: "b2" },
        ])],
        {
          [pageKey("f1", 1)]: { blocks: [block("b1")] },
          [pageKey("f1", 2)]: { blocks: [block("b2")] },
        }
      ),
      "f1",
      [{ mode: "grouped", articleId: "a-1" }]
    );
    expect(plans).toHaveLength(2);
    expect(plans.map((p) => p.page)).toEqual([1, 2]);
    expect(plans.every((p) => p.key === "article:a-1")).toBe(true);
    expect(plans[0]!.crop).not.toBeNull();
  });

  it("plans nothing for an article whose blocks are gone", () => {
    // The unit is still proofread — as text only.
    expect(
      planProofreadImages(
        source([article("a-1", [{ page: 1, blockId: "gone" }])]),
        "f1",
        [{ mode: "grouped", articleId: "a-1" }]
      )
    ).toEqual([]);
  });

  it("plans nothing for a target whose article no longer exists", () => {
    expect(
      planProofreadImages(source([]), "f1", [
        { mode: "grouped", articleId: "removed" },
      ])
    ).toEqual([]);
  });

  it("counts past the cap so the caller can refuse before capturing", () => {
    // One block each, all on one page: 21 articles is 21 images, and the
    // whole point of planning first is knowing that without encoding any.
    const count = MAX_PROOFREAD_IMAGES + 1;
    const articles = Array.from({ length: count }, (_, i) =>
      article(`a-${i}`, [{ page: 1, blockId: `b-${i}` }])
    );
    const blocks = Array.from({ length: count }, (_, i) => block(`b-${i}`));
    const targets: ProofreadTarget[] = articles.map((a) => ({
      mode: "grouped",
      articleId: a.id,
    }));
    const plans = planProofreadImages(
      source(articles, { [pageKey("f1", 1)]: { blocks } }),
      "f1",
      targets
    );
    expect(plans).toHaveLength(count);
    expect(plans.length > MAX_PROOFREAD_IMAGES).toBe(true);
  });
});
