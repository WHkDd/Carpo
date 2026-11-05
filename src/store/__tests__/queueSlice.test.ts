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

  it("rotating an image swaps its source and drops pixel-bound work only", () => {
    const store = makeStore();
    const fid = "img-1";
    store.getState().addFile({
      id: fid,
      path: "/tmp/a.jpg",
      name: "a.jpg",
      ext: "jpg",
      kind: "image",
      payload: { width: 400, height: 300, objectUrl: "blob:old" },
    });
    store.getState().setFileView(fid, {
      zoomPercent: 40,
      panX: 5,
      panY: 6,
      isFit: false,
    });
    store.getState().addBlock(fid, 1, {
      id: "b1",
      x: 0,
      y: 0,
      w: 10,
      h: 10,
      articleId: null,
      articleOrder: null,
    });
    store.getState().addArticle(fid, 1, { id: "a1", num: 1, title: "" }, ["b1"]);
    store.getState().updateDocumentMetadata(fid, {
      newspaperName: "申报",
      newspaperDate: "1932-01-01",
    });
    store.getState().addTagToFiles([fid], "上海");
    store.setState((s) => {
      s.pageOcrTexts[fid] = { 1: "text" };
      s.documentResults[fid] = "doc";
    });

    store.setState((s) => {
      s.articleOcrTexts[fid] = { a1: "t" };
      s.articleOcrRegions[fid] = { a1: "r" };
      s.recognizedPages[fid] = { 1: { status: "done", text: "x" } } as never;
      s.proofreadReviews[fid] = { k: {} } as never;
      s.selectedArticleIds = ["a1"];
    });

    store.getState().replaceRotatedImage(fid, "/cache/rotated-1.png");

    const s = store.getState();
    const file = s.files.find((f) => f.id === fid)!;
    expect(file.path).toBe("/cache/rotated-1.png");
    expect(file.name).toBe("a.jpg");
    // Cleared so the old-orientation bitmap can't be shown; the page sync
    // hook reloads it from the new path.
    expect(file.payload).toBeUndefined();
    expect(s.getPageState(fid, 1).blocks).toEqual([]);
    expect(s.getDocumentState(fid).articles).toEqual([]);
    expect(s.getDocumentState(fid).newspaperName).toBe("申报");
    expect(s.getDocumentState(fid).newspaperDate).toBe("1932-01-01");
    expect(s.getDocumentState(fid).tags).toEqual(["上海"]);
    expect(s.pageOcrTexts[fid]).toBeUndefined();
    expect(s.documentResults[fid]).toBeUndefined();
    expect(s.articleOcrTexts[fid]).toBeUndefined();
    expect(s.articleOcrRegions[fid]).toBeUndefined();
    expect(s.recognizedPages[fid]).toBeUndefined();
    expect(s.proofreadReviews[fid]).toBeUndefined();
    expect(s.selectedArticleIds).toEqual([]);
    // Dropped so the canvas seeds a fresh fit when the new size arrives —
    // also for square images, whose size doesn't change.
    expect(s.fileViews[fid]).toBeUndefined();
  });
});
