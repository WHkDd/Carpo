import { describe, it, expect, beforeEach } from "vitest";
import { create } from "zustand";
import { immer } from "zustand/middleware/immer";
import { createQueueSlice, type QueueSlice } from "../queueSlice";
import { createUiSlice, type UiSlice } from "../uiSlice";
import { createFileViewSlice, type FileViewSlice } from "../fileViewSlice";
import { createPageStateSlice, type PageStateSlice } from "../pageStateSlice";
import { createSelectionSlice, type SelectionSlice } from "../selectionSlice";
import { createJobSlice, type JobSlice } from "../jobSlice";
import { createSettingsSlice, type SettingsSlice } from "../settingsSlice";

type Store =
  QueueSlice &
  UiSlice &
  FileViewSlice &
  PageStateSlice &
  SelectionSlice &
  SettingsSlice &
  JobSlice;

function makeStore() {
  return create<Store>()(
    immer((...args) => ({
      ...createQueueSlice(...args),
      ...createUiSlice(...args),
      ...createFileViewSlice(...args),
      ...createPageStateSlice(...args),
      ...createSelectionSlice(...args),
      ...createSettingsSlice(...args),
      ...createJobSlice(...args),
    }))
  );
}

describe("selectionSlice", () => {
  let store: ReturnType<typeof makeStore>;

  beforeEach(() => {
    store = makeStore();
  });

  const fid = "file-1";
  const page = 1;

  it("starts with empty selection", () => {
    expect(store.getState().getSelectionOrder(fid, page)).toEqual([]);
  });

  it("pushSelection appends a new id", () => {
    store.getState().pushSelection(fid, page, "a");
    store.getState().pushSelection(fid, page, "b");
    expect(store.getState().getSelectionOrder(fid, page)).toEqual(["a", "b"]);
    expect(store.getState().getFileSelectionOrder(fid)).toEqual([
      { page, blockId: "a" },
      { page, blockId: "b" },
    ]);
  });

  it("pushSelection re-orders duplicates (moves to end)", () => {
    store.getState().pushSelection(fid, page, "a");
    store.getState().pushSelection(fid, page, "b");
    store.getState().pushSelection(fid, page, "a");
    expect(store.getState().getSelectionOrder(fid, page)).toEqual(["b", "a"]);
  });

  it("popSelection removes the last id", () => {
    store.getState().pushSelection(fid, page, "a");
    store.getState().pushSelection(fid, page, "b");
    store.getState().popSelection(fid, page);
    expect(store.getState().getSelectionOrder(fid, page)).toEqual(["a"]);
  });

  it("popSelection is a no-op on empty selection", () => {
    store.getState().popSelection(fid, page);
    expect(store.getState().getSelectionOrder(fid, page)).toEqual([]);
  });

  it("removeFromSelection removes a specific id", () => {
    store.getState().pushSelection(fid, page, "a");
    store.getState().pushSelection(fid, page, "b");
    store.getState().pushSelection(fid, page, "c");
    store.getState().removeFromSelection(fid, page, "b");
    expect(store.getState().getSelectionOrder(fid, page)).toEqual(["a", "c"]);
  });

  it("clearSelection removes all ids", () => {
    store.getState().pushSelection(fid, page, "a");
    store.getState().clearSelection(fid, page);
    expect(store.getState().getSelectionOrder(fid, page)).toEqual([]);
  });

  it("keeps a file-level order while filtering display by page", () => {
    store.getState().pushSelection(fid, page, "a");
    store.getState().pushSelection(fid, 2, "x");
    expect(store.getState().getSelectionOrder(fid, page)).toEqual(["a"]);
    expect(store.getState().getSelectionOrder(fid, 2)).toEqual(["x"]);
    expect(store.getState().getFileSelectionOrder(fid)).toEqual([
      { page: 1, blockId: "a" },
      { page: 2, blockId: "x" },
    ]);
  });

  it("clearSelection clears the file-level draft queue", () => {
    store.getState().pushSelection(fid, 1, "a");
    store.getState().pushSelection(fid, 2, "x");
    store.getState().clearSelection(fid, 1);
    expect(store.getState().getFileSelectionOrder(fid)).toEqual([]);
  });

  it("toggleDrawMode toggles boolean", () => {
    expect(store.getState().manualDrawMode).toBe(false);
    store.getState().toggleDrawMode();
    expect(store.getState().manualDrawMode).toBe(true);
    store.getState().toggleDrawMode();
    expect(store.getState().manualDrawMode).toBe(false);
  });

  it("whole_file mode forces browse state and clears draw toggle", () => {
    store.getState().pushSelection(fid, page, "a");
    store.getState().setSelectedArticleIds(["art1"]);
    store.getState().setEditingBlock(fid, { page, blockId: "b1" });
    store.getState().setDrawMode(true);

    store.getState().setRecognitionMode("whole_file");

    expect(store.getState().recognitionMode).toBe("whole_file");
    expect(store.getState().manualDrawMode).toBe(false);
    expect(store.getState().getSelectionOrder(fid, page)).toEqual([]);
    expect(store.getState().selectedArticleIds).toEqual([]);
    expect(store.getState().getEditingBlockId(fid, page)).toBe(null);
  });

  it("toggleDrawMode is ignored in whole_file mode", () => {
    store.getState().setRecognitionMode("whole_file");
    store.getState().toggleDrawMode();
    expect(store.getState().manualDrawMode).toBe(false);
  });

  it("setEditingBlock stores and clears a single edit target per file", () => {
    expect(store.getState().getEditingBlockId(fid, page)).toBe(null);
    store.getState().setEditingBlock(fid, { page, blockId: "b1" });
    expect(store.getState().getEditingBlockId(fid, page)).toBe("b1");
    store.getState().setEditingBlock(fid, null);
    expect(store.getState().getEditingBlockId(fid, page)).toBe(null);
  });

  it("getEditingBlockId is scoped to the current page", () => {
    store.getState().setEditingBlock(fid, { page: 1, blockId: "b1" });
    expect(store.getState().getEditingBlockId(fid, 1)).toBe("b1");
    expect(store.getState().getEditingBlockId(fid, 2)).toBe(null);
  });

  it("setEditingLayoutBlock stores and clears the focused layout block", () => {
    expect(store.getState().getEditingLayoutBlockIndex(fid, page)).toBe(null);
    store.getState().setEditingLayoutBlock(fid, { page, index: 3 });
    expect(store.getState().getEditingLayoutBlockIndex(fid, page)).toBe(3);
    store.getState().setEditingLayoutBlock(fid, null);
    expect(store.getState().getEditingLayoutBlockIndex(fid, page)).toBe(null);
  });

  it("treats block index 0 as a real target, not as absent", () => {
    store.getState().setEditingLayoutBlock(fid, { page, index: 0 });
    expect(store.getState().getEditingLayoutBlockIndex(fid, page)).toBe(0);
  });

  it("getEditingLayoutBlockIndex is scoped to the current page", () => {
    // This is what makes a page turn drop the highlight without any cleanup:
    // the ref carries the page it was set on.
    store.getState().setEditingLayoutBlock(fid, { page: 1, index: 2 });
    expect(store.getState().getEditingLayoutBlockIndex(fid, 1)).toBe(2);
    expect(store.getState().getEditingLayoutBlockIndex(fid, 2)).toBe(null);
  });

  it("keeps the focused layout block separate per file", () => {
    store.getState().setEditingLayoutBlock(fid, { page, index: 1 });
    store.getState().setEditingLayoutBlock("other", { page, index: 7 });
    expect(store.getState().getEditingLayoutBlockIndex(fid, page)).toBe(1);
    expect(store.getState().getEditingLayoutBlockIndex("other", page)).toBe(7);
  });

  it("returns the focused region's rect only on the page it covers", () => {
    // A grouped article continued across a page break carries a rect per
    // page; the canvas asks for the one it is currently showing.
    const rects = [
      { page: 1, rect: { x: 10, y: 10, width: 100, height: 100 } },
      { page: 2, rect: { x: 0, y: 0, width: 50, height: 50 } },
    ];
    store.getState().setFocusedRegion(fid, { rects });
    expect(store.getState().getFocusedRegionRect(fid, 1)).toEqual(rects[0]!.rect);
    expect(store.getState().getFocusedRegionRect(fid, 2)).toEqual(rects[1]!.rect);
    expect(store.getState().getFocusedRegionRect(fid, 3)).toBe(null);
    store.getState().setFocusedRegion(fid, null);
    expect(store.getState().getFocusedRegionRect(fid, 1)).toBe(null);
  });

  it("hands back the same rect object on every call", () => {
    // This getter feeds a zustand v5 selector, whose snapshot must be
    // referentially stable: returning a fresh object per call re-renders the
    // canvas forever (React #185 — the blank-window class of bug).
    store.getState().setFocusedRegion(fid, {
      rects: [{ page: 1, rect: { x: 1, y: 2, width: 3, height: 4 } }],
    });
    const first = store.getState().getFocusedRegionRect(fid, 1);
    const second = store.getState().getFocusedRegionRect(fid, 1);
    expect(first).toBe(second);
  });

  it("keeps the focused region separate per file", () => {
    store.getState().setFocusedRegion(fid, {
      rects: [{ page, rect: { x: 1, y: 1, width: 1, height: 1 } }],
    });
    store.getState().setFocusedRegion("other", {
      rects: [{ page, rect: { x: 9, y: 9, width: 9, height: 9 } }],
    });
    expect(store.getState().getFocusedRegionRect(fid, page)?.x).toBe(1);
    expect(store.getState().getFocusedRegionRect("other", page)?.x).toBe(9);
  });
});
