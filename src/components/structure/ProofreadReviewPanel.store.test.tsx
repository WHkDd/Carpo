// @vitest-environment jsdom

/**
 * The review panel against the REAL zustand store — deliberately no
 * `vi.mock("@/store")`.
 *
 * Two things only a real store can show. First, that the canvas can actually
 * *read back* what the panel writes: the panel calls `setFocusedRegion`, the
 * canvas asks `getFocusedRegionRect(fileId, page)`, and the unit-level suites
 * on either side of that seam both pass even if the two disagree about shape
 * or page scoping. Second, subscription stability — zustand v5 feeds a
 * selector's result straight to `useSyncExternalStore`, and a snapshot that is
 * a fresh object per call re-renders forever (React #185, the blank-window
 * crash this repo has shipped once already).
 */

import { cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ProofreadReviewPanel } from "./ProofreadReviewPanel";
import { useStore } from "@/store";
import type { ProofreadReview } from "@/lib/proofread";

vi.mock("@/lib/confirm", () => ({
  confirmDestructive: vi.fn(async () => true),
}));

const FILE_ID = "f1";
/** Filled by the fixture: the id the store minted for the article. */
let ARTICLE_ID = "";

/** Builds the article the way the app does — blocks selected across two
 *  pages, then marked as one report. `addArticle` is per-page and pushes a
 *  new entry each call, so calling it twice would make two articles that
 *  happen to share a title, not one report continued across a page break. */
function seedGroupedArticleAcrossTwoPages() {
  const state = useStore.getState();
  state.addFile({
    id: FILE_ID,
    path: "/tmp/a.pdf",
    name: "a.pdf",
    ext: "pdf",
    kind: "pdf",
  });
  state.addBlock(FILE_ID, 1, {
    id: "b-1",
    x: 100,
    y: 200,
    w: 400,
    h: 600,
    articleId: null,
    articleOrder: null,
  });
  state.addBlock(FILE_ID, 2, {
    id: "b-2",
    x: 0,
    y: 0,
    w: 300,
    h: 300,
    articleId: null,
    articleOrder: null,
  });
  state.pushSelection(FILE_ID, 1, "b-1");
  state.pushSelection(FILE_ID, 2, "b-2");
  const article = useStore.getState().markSelectionAsArticle(FILE_ID, 1);
  if (!article) throw new Error("fixture did not create an article");
  ARTICLE_ID = article.id;
  expect(article.blockRefs.map((ref) => ref.page)).toEqual([1, 2]);
  useStore.getState().setArticleOcrTexts(FILE_ID, {
    [ARTICLE_ID]: "本埠新聞，巳於昨日到達。",
  });
}

function groupedReview(): ProofreadReview {
  return {
    target: { mode: "grouped", articleId: ARTICLE_ID },
    baseText: "本埠新聞，巳於昨日到達。",
    suggestions: [
      {
        before: "巳",
        after: "已",
        context_before: "本埠新聞，",
        category: "charform",
        confidence: 0.9,
        reason: "形近字误识",
        verdict: "pending",
      },
    ],
    model: "gpt-4o",
    discarded: 0,
    status: "pending",
    createdAt: 1,
  };
}

beforeEach(() => {
  const state = useStore.getState();
  [...state.files].forEach((file) => state.removeFile(file.id));
});

afterEach(cleanup);

describe("ProofreadReviewPanel against the real store", () => {
  it("leaves the region where the canvas looks for it, page by page", () => {
    seedGroupedArticleAcrossTwoPages();
    const { rerender } = render(
      <ProofreadReviewPanel
        fileId={FILE_ID}
        targetKey={`article:${ARTICLE_ID}`}
        review={groupedReview()}
        onClose={vi.fn()}
        onReProofread={vi.fn()}
      />
    );
    // A second render must not change anything — an unstable subscription
    // would already have thrown by here.
    rerender(
      <ProofreadReviewPanel
        fileId={FILE_ID}
        targetKey={`article:${ARTICLE_ID}`}
        review={groupedReview()}
        onClose={vi.fn()}
        onReProofread={vi.fn()}
      />
    );

    const read = (page: number) =>
      useStore.getState().getFocusedRegionRect(FILE_ID, page);

    // Page 1: the block at 100,200 400×600, grown by 2% on every side.
    const first = read(1);
    expect(first).not.toBeNull();
    expect(first!.x).toBeCloseTo(100 - 400 * 0.02);
    expect(first!.y).toBeCloseTo(200 - 600 * 0.02);
    expect(first!.width).toBeCloseTo(400 * 1.04);
    expect(first!.height).toBeCloseTo(600 * 1.04);

    // Page 2: the continuation lights up there too, with its own rect.
    const second = read(2);
    expect(second).not.toBeNull();
    expect(second!.width).toBeCloseTo(300 * 1.04);

    // A page the article never touches stays clear.
    expect(read(3)).toBeNull();
  });

  it("clears the region when the panel closes", () => {
    seedGroupedArticleAcrossTwoPages();
    const { unmount } = render(
      <ProofreadReviewPanel
        fileId={FILE_ID}
        targetKey={`article:${ARTICLE_ID}`}
        review={groupedReview()}
        onClose={vi.fn()}
        onReProofread={vi.fn()}
      />
    );
    expect(useStore.getState().getFocusedRegionRect(FILE_ID, 1)).not.toBeNull();
    unmount();
    expect(useStore.getState().getFocusedRegionRect(FILE_ID, 1)).toBeNull();
  });
});
