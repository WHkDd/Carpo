import { describe, expect, it } from "vitest";
import { create } from "zustand";
import { immer } from "zustand/middleware/immer";
import { createQueueSlice, type QueueSlice } from "../queueSlice";
import { createUiSlice, type UiSlice } from "../uiSlice";
import { createFileViewSlice, type FileViewSlice } from "../fileViewSlice";
import { createPageStateSlice, type PageStateSlice } from "../pageStateSlice";
import { createSelectionSlice, type SelectionSlice } from "../selectionSlice";
import { createSettingsSlice, type SettingsSlice } from "../settingsSlice";

type Store = QueueSlice &
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

describe("queueSlice", () => {
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

    store.getState().removeFile("file-1");

    expect(store.getState().files.map((file) => file.id)).toEqual(["file-2"]);
    expect(store.getState().currentFileId).toBe("file-2");
    expect(store.getState().fileViews["file-1"]).toBeUndefined();
    expect(store.getState().pageStates["file-1::1"]).toBeUndefined();
    expect(store.getState().selectionOrders["file-1"]).toBeUndefined();
    expect(store.getState().documentStates["file-1"]).toBeUndefined();
  });
});
