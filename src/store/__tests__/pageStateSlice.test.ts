import { describe, it, expect, beforeEach } from "vitest";
import { create } from "zustand";
import { immer } from "zustand/middleware/immer";
import { createQueueSlice, type QueueSlice } from "../queueSlice";
import { createUiSlice, type UiSlice } from "../uiSlice";
import { createFileViewSlice, type FileViewSlice } from "../fileViewSlice";
import { createPageStateSlice, type PageStateSlice, EMPTY_PAGE_STATE } from "../pageStateSlice";
import { createSelectionSlice, type SelectionSlice } from "../selectionSlice";

type Store = QueueSlice & UiSlice & FileViewSlice & PageStateSlice & SelectionSlice;

function makeStore() {
  return create<Store>()(
    immer((...args) => ({
      ...createQueueSlice(...args),
      ...createUiSlice(...args),
      ...createFileViewSlice(...args),
      ...createPageStateSlice(...args),
      ...createSelectionSlice(...args),
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
      articles: [],
      newspaperName: "",
      newspaperDate: "",
    });
  });

  it("isolates blocks per page", () => {
    const b = { id: "b1", x: 0, y: 0, w: 10, h: 10, articleId: null, articleOrder: null };
    store.getState().addBlock(fid, 1, b);
    expect(store.getState().getPageState(fid, 2).blocks).toEqual([]);
    expect(store.getState().getPageState(fid, 1).blocks).toHaveLength(1);
  });

  it("addArticle assigns blocks and orders them", () => {
    const b1 = { id: "b1", x: 0, y: 0, w: 10, h: 10, articleId: null, articleOrder: null };
    const b2 = { id: "b2", x: 0, y: 0, w: 10, h: 10, articleId: null, articleOrder: null };
    store.getState().addBlock(fid, page, b1);
    store.getState().addBlock(fid, page, b2);
    store.getState().addArticle(fid, page, { id: "a1", num: 1, title: "" }, ["b2", "b1"]);

    const state = store.getState().getPageState(fid, page);
    expect(state.articles).toHaveLength(1);
    expect(state.blocks[0]!.articleId).toBe("a1");
    expect(state.blocks[0]!.articleOrder).toBe(2); // b1 is second in list
    expect(state.blocks[1]!.articleId).toBe("a1");
    expect(state.blocks[1]!.articleOrder).toBe(1); // b2 is first in list
  });

  it("removeArticle unassigns blocks and removes article", () => {
    const b1 = { id: "b1", x: 0, y: 0, w: 10, h: 10, articleId: null, articleOrder: null };
    store.getState().addBlock(fid, page, b1);
    store.getState().addArticle(fid, page, { id: "a1", num: 1, title: "" }, ["b1"]);
    store.getState().removeArticle(fid, page, "a1");

    const state = store.getState().getPageState(fid, page);
    expect(state.articles).toHaveLength(0);
    expect(state.blocks[0]!.articleId).toBeNull();
    expect(state.blocks[0]!.articleOrder).toBeNull();
  });
});
