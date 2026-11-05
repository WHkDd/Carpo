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

  it("getEditingBlockId is scoped to the current page", () => {
    store.getState().setEditingBlock(fid, { page: 1, blockId: "b1" });
    expect(store.getState().getEditingBlockId(fid, 1)).toBe("b1");
    expect(store.getState().getEditingBlockId(fid, 2)).toBe(null);
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
});
