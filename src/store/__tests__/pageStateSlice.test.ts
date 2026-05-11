import { describe, it, expect, beforeEach } from "vitest";
import { create } from "zustand";
import { immer } from "zustand/middleware/immer";
import { createQueueSlice, type QueueSlice } from "../queueSlice";
import { createUiSlice, type UiSlice } from "../uiSlice";
import { createFileViewSlice, type FileViewSlice } from "../fileViewSlice";
import { createPageStateSlice, type PageStateSlice, EMPTY_PAGE_STATE } from "../pageStateSlice";
import { createSelectionSlice, type SelectionSlice } from "../selectionSlice";
import { createSettingsSlice, type SettingsSlice } from "../settingsSlice";

type Store =
  QueueSlice &
  UiSlice &
  FileViewSlice &
  PageStateSlice &
  SelectionSlice &
  SettingsSlice;

function makeStore() {
  return create<Store>()(
    immer((...args) => ({
      ...createQueueSlice(...args),
      ...createUiSlice(...args),
      ...createFileViewSlice(...args),
      ...createPageStateSlice(...args),
      ...createSelectionSlice(...args),
      ...createSettingsSlice(...args),
    }))
  );
}

describe("pageStateSlice", () => {
  let store: ReturnType<typeof makeStore>;

  beforeEach(() => {
    store = makeStore();
  });

  const fid = "file-1";
  const page = 1;
  const block = (id: string) => ({
    id,
    x: 0,
    y: 0,
    w: 10,
    h: 10,
    articleId: null,
    articleOrder: null,
  });

  it("returns EMPTY_PAGE_STATE for missing page", () => {
    expect(store.getState().getPageState(fid, page)).toBe(EMPTY_PAGE_STATE);
  });

  it("addBlock creates page state on first insert", () => {
    const b = { id: "b1", x: 0, y: 0, w: 10, h: 20, articleId: null, articleOrder: null };
    store.getState().addBlock(fid, page, b);
    expect(store.getState().getPageState(fid, page).blocks).toEqual([b]);
  });

  it("addBlock appends blocks", () => {
    const b1 = { id: "b1", x: 0, y: 0, w: 10, h: 10, articleId: null, articleOrder: null };
    const b2 = { id: "b2", x: 5, y: 5, w: 20, h: 20, articleId: null, articleOrder: null };
    store.getState().addBlock(fid, page, b1);
    store.getState().addBlock(fid, page, b2);
    expect(store.getState().getPageState(fid, page).blocks).toHaveLength(2);
  });

  it("updateBlock patches only specified fields", () => {
    const b = { id: "b1", x: 0, y: 0, w: 10, h: 10, articleId: null, articleOrder: null };
    store.getState().addBlock(fid, page, b);
    store.getState().updateBlock(fid, page, "b1", { x: 3, w: 30 });
    const updated = store.getState().getPageState(fid, page).blocks[0];
    expect(updated!.x).toBe(3);
    expect(updated!.w).toBe(30);
    expect(updated!.y).toBe(0);
    expect(updated!.h).toBe(10);
  });

  it("removeBlock deletes a block", () => {
    const b1 = { id: "b1", x: 0, y: 0, w: 10, h: 10, articleId: null, articleOrder: null };
    const b2 = { id: "b2", x: 0, y: 0, w: 10, h: 10, articleId: null, articleOrder: null };
    store.getState().addBlock(fid, page, b1);
    store.getState().addBlock(fid, page, b2);
    store.getState().removeBlock(fid, page, "b1");
    expect(store.getState().getPageState(fid, page).blocks).toHaveLength(1);
    expect(store.getState().getPageState(fid, page).blocks[0]!.id).toBe("b2");
  });

  it("removeBlocks deletes multiple blocks", () => {
    const b1 = { id: "b1", x: 0, y: 0, w: 10, h: 10, articleId: null, articleOrder: null };
    const b2 = { id: "b2", x: 0, y: 0, w: 10, h: 10, articleId: null, articleOrder: null };
    const b3 = { id: "b3", x: 0, y: 0, w: 10, h: 10, articleId: null, articleOrder: null };
    store.getState().addBlock(fid, page, b1);
    store.getState().addBlock(fid, page, b2);
    store.getState().addBlock(fid, page, b3);
    store.getState().removeBlocks(fid, page, ["b1", "b3"]);
    expect(store.getState().getPageState(fid, page).blocks).toHaveLength(1);
    expect(store.getState().getPageState(fid, page).blocks[0]!.id).toBe("b2");
  });

  it("removeBlocks tolerates ids not present", () => {
    const b1 = { id: "b1", x: 0, y: 0, w: 10, h: 10, articleId: null, articleOrder: null };
    store.getState().addBlock(fid, page, b1);
    store.getState().removeBlocks(fid, page, ["b1", "ghost", "also-missing"]);
    expect(store.getState().getPageState(fid, page).blocks).toEqual([]);
  });

  it("removeBlocks on missing page is a no-op", () => {
    expect(() =>
    store.getState().removeBlocks(fid, 999, ["a", "b"])
    ).not.toThrow();
    expect(store.getState().getPageState(fid, 999)).toEqual({
      blocks: [],
    });
  });

  it("isolates blocks per page", () => {
    const b = { id: "b1", x: 0, y: 0, w: 10, h: 10, articleId: null, articleOrder: null };
    store.getState().addBlock(fid, 1, b);
    expect(store.getState().getPageState(fid, 2).blocks).toEqual([]);
    expect(store.getState().getPageState(fid, 1).blocks).toHaveLength(1);
  });

  it("addArticle stores articles at document scope and orders page blocks", () => {
    const b1 = { id: "b1", x: 0, y: 0, w: 10, h: 10, articleId: null, articleOrder: null };
    const b2 = { id: "b2", x: 0, y: 0, w: 10, h: 10, articleId: null, articleOrder: null };
    store.getState().addBlock(fid, page, b1);
    store.getState().addBlock(fid, page, b2);
    store.getState().addArticle(fid, page, { id: "a1", num: 1, title: "" }, ["b2", "b1"]);

    const pageState = store.getState().getPageState(fid, page);
    const docState = store.getState().getDocumentState(fid);
    expect(docState.articles).toEqual([
      {
        id: "a1",
        num: 1,
        title: "",
        blockRefs: [
          { page, blockId: "b2", order: 1 },
          { page, blockId: "b1", order: 2 },
        ],
      },
    ]);
    expect(pageState.blocks[0]!.articleId).toBe("a1");
    expect(pageState.blocks[0]!.articleOrder).toBe(2); // b1 is second in list
    expect(pageState.blocks[1]!.articleId).toBe("a1");
    expect(pageState.blocks[1]!.articleOrder).toBe(1); // b2 is first in list
  });

  it("removeArticle deletes article blocks across document pages", () => {
    const b1 = { id: "b1", x: 0, y: 0, w: 10, h: 10, articleId: null, articleOrder: null };
    store.getState().addBlock(fid, page, b1);
    store.getState().addArticle(fid, page, { id: "a1", num: 1, title: "" }, ["b1"]);
    store.getState().removeArticle(fid, "a1");

    const state = store.getState().getPageState(fid, page);
    expect(store.getState().getDocumentState(fid).articles).toHaveLength(0);
    expect(state.blocks).toEqual([]);
  });

  it("markSelectionAsArticle creates a document-scoped article and clears temporary selection", () => {
    store.getState().addBlock(fid, page, block("b1"));
    store.getState().addBlock(fid, page, block("b2"));
    store.getState().pushSelection(fid, page, "b2");
    store.getState().pushSelection(fid, page, "b1");

    const article = store.getState().markSelectionAsArticle(fid, page);

    expect(article).toMatchObject({ num: 1, title: "报道1" });
    expect(store.getState().getSelectionOrder(fid, page)).toEqual([]);
    expect(store.getState().getDocumentState(fid).articles[0]!.blockRefs).toEqual([
      { page, blockId: "b2", order: 1 },
      { page, blockId: "b1", order: 2 },
    ]);
    expect(store.getState().getPageState(fid, page).blocks).toMatchObject([
      { id: "b1", articleOrder: 2 },
      { id: "b2", articleOrder: 1 },
    ]);
  });

  it("markSelectionAsArticle can append blocks from another page to the same article", () => {
    store.getState().addBlock(fid, 1, block("p1b1"));
    store.getState().addBlock(fid, 2, block("p2b1"));
    store.getState().pushSelection(fid, 1, "p1b1");
    const article = store.getState().markSelectionAsArticle(fid, 1);

    store.getState().pushSelection(fid, 2, "p2b1");
    store.getState().markSelectionAsArticle(fid, 2, article!.id);

    expect(store.getState().getDocumentState(fid).articles).toHaveLength(1);
    expect(store.getState().getDocumentState(fid).articles[0]!.blockRefs).toEqual([
      { page: 1, blockId: "p1b1", order: 1 },
      { page: 2, blockId: "p2b1", order: 2 },
    ]);
    expect(store.getState().getPageState(fid, 2).blocks[0]!.articleOrder).toBe(2);
  });

  it("markSelectionAsArticle creates one article from a cross-page draft queue", () => {
    store.getState().addBlock(fid, 1, block("p1b1"));
    store.getState().addBlock(fid, 1, block("p1b2"));
    store.getState().addBlock(fid, 2, block("p2b1"));
    store.getState().pushSelection(fid, 1, "p1b1");
    store.getState().pushSelection(fid, 1, "p1b2");
    store.getState().pushSelection(fid, 2, "p2b1");

    store.getState().markSelectionAsArticle(fid, 2);

    expect(store.getState().getDocumentState(fid).articles[0]!.blockRefs).toEqual([
      { page: 1, blockId: "p1b1", order: 1 },
      { page: 1, blockId: "p1b2", order: 2 },
      { page: 2, blockId: "p2b1", order: 3 },
    ]);
    expect(store.getState().getFileSelectionOrder(fid)).toEqual([]);
    expect(store.getState().getPageState(fid, 2).blocks[0]!.articleOrder).toBe(3);
  });

  it("clearArticles keeps document metadata but deletes all article blocks", () => {
    store.getState().addBlock(fid, 1, block("b1"));
    store.getState().addBlock(fid, 2, block("b2"));
    store.getState().addBlock(fid, 2, block("loose"));
    store.getState().updateDocumentMetadata(fid, {
      newspaperName: "申报",
      newspaperDate: "1923-01-01",
    });
    store.getState().addArticle(fid, 1, { id: "a1", num: 1, title: "报道1" }, ["b1"]);
    store.getState().addArticle(fid, 2, { id: "a2", num: 2, title: "报道2" }, ["b2"]);

    store.getState().clearArticles(fid);

    expect(store.getState().getDocumentState(fid)).toMatchObject({
      articles: [],
      newspaperName: "申报",
      newspaperDate: "1923-01-01",
    });
    expect(store.getState().getPageState(fid, 1).blocks).toEqual([]);
    expect(store.getState().getPageState(fid, 2).blocks.map((b) => b.id)).toEqual([
      "loose",
    ]);
  });

  it("removeBlocks prunes document article refs and removes empty articles", () => {
    store.getState().addBlock(fid, page, block("b1"));
    store.getState().addArticle(fid, page, { id: "a1", num: 1, title: "报道1" }, ["b1"]);

    store.getState().removeBlocks(fid, page, ["b1"]);

    expect(store.getState().getDocumentState(fid).articles).toEqual([]);
  });

  it("removeBlocks compacts remaining article order", () => {
    ["b1", "b2", "b3", "b4"].forEach((id) =>
      store.getState().addBlock(fid, page, block(id))
    );
    store
      .getState()
      .addArticle(fid, page, { id: "a1", num: 1, title: "报道1" }, [
        "b1",
        "b2",
        "b3",
        "b4",
      ]);

    store.getState().removeBlocks(fid, page, ["b1", "b2"]);

    expect(store.getState().getDocumentState(fid).articles[0]!.blockRefs).toEqual([
      { page, blockId: "b3", order: 1 },
      { page, blockId: "b4", order: 2 },
    ]);
    expect(store.getState().getPageState(fid, page).blocks).toMatchObject([
      { id: "b3", articleOrder: 1 },
      { id: "b4", articleOrder: 2 },
    ]);
  });

  it("stores newspaper metadata at document scope", () => {
    store.getState().updateDocumentMetadata(fid, {
      newspaperName: "申报",
      newspaperDate: "1923-01-01",
    });

    expect(store.getState().getDocumentState(fid)).toMatchObject({
      newspaperName: "申报",
      newspaperDate: "1923-01-01",
    });
    expect(store.getState().getPageState(fid, page)).toEqual({ blocks: [] });
  });
});
