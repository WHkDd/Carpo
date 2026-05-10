import { describe, it, expect, beforeEach } from "vitest";
import { create } from "zustand";
import { immer } from "zustand/middleware/immer";
import { createQueueSlice, type QueueSlice } from "../queueSlice";
import { createUiSlice, type UiSlice } from "../uiSlice";
import { createFileViewSlice, type FileViewSlice } from "../fileViewSlice";
import { createPageStateSlice, type PageStateSlice } from "../pageStateSlice";
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

  it("isolates selection per page", () => {
    store.getState().pushSelection(fid, page, "a");
    store.getState().pushSelection(fid, 2, "x");
    expect(store.getState().getSelectionOrder(fid, page)).toEqual(["a"]);
    expect(store.getState().getSelectionOrder(fid, 2)).toEqual(["x"]);
  });

  it("toggleDrawMode toggles boolean", () => {
    expect(store.getState().manualDrawMode).toBe(false);
    store.getState().toggleDrawMode();
    expect(store.getState().manualDrawMode).toBe(true);
    store.getState().toggleDrawMode();
    expect(store.getState().manualDrawMode).toBe(false);
  });
});
