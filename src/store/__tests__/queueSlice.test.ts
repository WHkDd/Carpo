import { describe, expect, it } from "vitest";
import { create } from "zustand";
import { immer } from "zustand/middleware/immer";
import { createQueueSlice, type QueueSlice } from "../queueSlice";
import { createUiSlice, type UiSlice } from "../uiSlice";
import { createFileViewSlice, type FileViewSlice } from "../fileViewSlice";
import { createPageStateSlice, type PageStateSlice } from "../pageStateSlice";
import { createSelectionSlice, type SelectionSlice } from "../selectionSlice";
import { createJobSlice, type JobSlice } from "../jobSlice";
import { createSettingsSlice, type SettingsSlice } from "../settingsSlice";

type Store = QueueSlice &
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

describe("queueSlice", () => {
  it("selects the most recently added file", () => {
    const store = makeStore();

    store.getState().addFile({
      id: "file-1",
      path: "/tmp/a.pdf",
      name: "a.pdf",
      ext: "pdf",
      kind: "pdf",
      pdfTotal: 2,
    });
    expect(store.getState().currentFileId).toBe("file-1");
    expect(store.getState().pdfTotal).toBe(2);

    store.getState().addFile({
      id: "file-2",
      path: "/tmp/b.pdf",
      name: "b.pdf",
      ext: "pdf",
      kind: "pdf",
      pdfTotal: 3,
    });

    expect(store.getState().currentFileId).toBe("file-2");
    expect(store.getState().pdfTotal).toBe(3);
    expect(store.getState().currentPage).toBe(1);
  });

  it("removeFile clears file-scoped state and selects the next file", () => {
    const store = makeStore();

    store.getState().addFile({
      id: "file-1",
      path: "/tmp/a.pdf",
      name: "a.pdf",
      ext: "pdf",
      kind: "pdf",
    });
    store.getState().addFile({
      id: "file-2",
      path: "/tmp/b.pdf",
      name: "b.pdf",
      ext: "pdf",
      kind: "pdf",
    });
    store.getState().setCurrent("file-1");
    store.getState().setFileZoomAndPan("file-1", 120, 10, 20);
    store.getState().addBlock("file-1", 1, {
      id: "b1",
      x: 0,
      y: 0,
      w: 10,
      h: 10,
      articleId: null,
      articleOrder: null,
    });
    store.getState().pushSelection("file-1", 1, "b1");
    store
      .getState()
      .updateDocumentMetadata("file-1", { newspaperName: "申报" });
    store.getState().setRecognizedPages("file-1", {
      1: {
        text: "第一页",
        status: "done",
        sourceMode: "page_image",
      },
    });
    store.getState().setEditingBlock("file-1", { page: 1, blockId: "b1" });
    store.getState().setEditingLayoutBlock("file-1", { page: 1, index: 0 });
    store.getState().setFocusedRegion("file-1", {
      rects: [{ page: 1, rect: { x: 0, y: 0, width: 10, height: 10 } }],
    });

    store.getState().removeFile("file-1");

    expect(store.getState().files.map((file) => file.id)).toEqual(["file-2"]);
    expect(store.getState().currentFileId).toBe("file-2");
    expect(store.getState().fileViews["file-1"]).toBeUndefined();
    expect(store.getState().pageStates["file-1::1"]).toBeUndefined();
    expect(store.getState().selectionOrders["file-1"]).toBeUndefined();
    expect(store.getState().documentStates["file-1"]).toBeUndefined();
    expect(store.getState().recognizedPages["file-1"]).toBeUndefined();
    expect(store.getState().pageOcrTexts["file-1"]).toBeUndefined();
    expect(store.getState().editingBlock["file-1"]).toBeUndefined();
    expect(store.getState().editingLayoutBlock["file-1"]).toBeUndefined();
    expect(store.getState().focusedRegion["file-1"]).toBeUndefined();
  });
});
