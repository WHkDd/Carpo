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
    })),
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
    store
      .getState()
      .addArticle(fid, 1, { id: "a1", num: 1, title: "" }, ["b1"]);
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

describe("restoreSnapshot", () => {
  it("round-trips a file's work through JSON and leaves already-queued files alone", async () => {
    const { buildSnapshot, parseSnapshot } = await import(
      "@/lib/session-snapshot"
    );
    const source = makeStore();
    const s = source.getState();
    s.addFile({
      id: "file-1",
      path: "/scans/a.pdf",
      name: "a.pdf",
      ext: "pdf",
      kind: "pdf",
      pdfTotal: 12,
      currentPage: 7,
      payload: { width: 10, height: 10, objectUrl: "blob:a" },
      payloadPage: 7,
    });
    s.addFile({
      id: "file-2",
      path: "/scans/b.jpg",
      name: "b.jpg",
      ext: "jpg",
      kind: "image",
    });
    s.addBlock("file-1", 7, {
      id: "b1",
      x: 1,
      y: 2,
      w: 3,
      h: 4,
      articleId: null,
      articleOrder: null,
    });
    s.updateDocumentMetadata("file-1", {
      newspaperName: "申报",
      newspaperDate: "1932-01-01",
    });
    s.setWholeFileRange("file-1", "3-9");
    s.setRecognizedPages("file-1", {
      7: { text: "第七页", status: "done", sourceMode: "page_image" },
    });
    s.setProofreadReviews("file-1", {
      "page:7": {
        target: { mode: "whole_file", page: 7 },
        baseText: "第七页",
        suggestions: [],
        model: "m",
        discarded: 0,
        status: "pending",
        createdAt: 1,
      } as never,
    });
    s.setCurrent("file-1");

    const snapshot = parseSnapshot(
      JSON.stringify(buildSnapshot(source.getState() as never)),
    );
    expect(snapshot.files[0]).not.toHaveProperty("payload");

    const target = makeStore();
    target
      .getState()
      .addFile({
        id: "file-2",
        path: "/live/b.jpg",
        name: "b.jpg",
        ext: "jpg",
        kind: "image",
      });
    target
      .getState()
      .updateDocumentMetadata("file-2", { newspaperName: "live" });

    expect(target.getState().restoreSnapshot(snapshot)).toEqual({
      added: 1,
      skipped: 1,
    });

    const restored = target.getState();
    const before = source.getState();
    expect(restored.files.map((f) => f.id)).toEqual(["file-2", "file-1"]);
    expect(restored.currentFileId).toBe("file-1");
    expect(restored.currentPage).toBe(7);
    expect(restored.pdfTotal).toBe(12);
    expect(restored.pageStates["file-1::7"]).toEqual(
      before.pageStates["file-1::7"],
    );
    expect(restored.documentStates["file-1"]).toEqual(
      before.documentStates["file-1"],
    );
    expect(restored.wholeFileRange["file-1"]).toBe("3-9");
    expect(restored.recognizedPages["file-1"]).toEqual(
      before.recognizedPages["file-1"],
    );
    expect(restored.pageOcrTexts["file-1"]).toEqual(
      before.pageOcrTexts["file-1"],
    );
    expect(restored.proofreadReviews["file-1"]).toEqual(
      before.proofreadReviews["file-1"],
    );
    // The queued copy of file-2 keeps its live state and path.
    expect(restored.files[0]!.path).toBe("/live/b.jpg");
    expect(restored.documentStates["file-2"]!.newspaperName).toBe("live");
  });
});

describe("queue selection and manual order", () => {
  function queued() {
    const store = makeStore();
    for (const id of ["a", "b", "c", "d"])
      store
        .getState()
        .addFile({
          id,
          path: `/tmp/${id}.pdf`,
          name: `${id}.pdf`,
          ext: "pdf",
          kind: "pdf",
        });
    return store;
  }
  it("uses visible order for Shift and command selection, deduplicating grouped files", () => {
    const store = queued();
    const visible = ["d", "b", "d", "a", "c"];
    store.getState().selectQueueFile("b", visible);
    store.getState().selectQueueFile("c", visible, false, true);
    expect(store.getState().selectedQueueFileIds).toEqual(["b", "a", "c"]);
    store.getState().selectQueueFile("a", visible, true);
    expect(store.getState().selectedQueueFileIds).toEqual(["b", "c"]);
    expect(store.getState().currentFileId).toBe("b");
    store.getState().selectQueueFile("d", visible, true);
    expect(store.getState().selectedQueueFileIds).toEqual(["b", "c", "d"]);
    expect(store.getState().currentFileId).toBe("d");
  });
  it("moves a whole selection in order and refuses cross-star, sorted, grouped and filtered drags", () => {
    const store = queued();
    store.getState().moveQueueFiles(["c", "b"], "d", true);
    expect(store.getState().manualQueueFileIds).toEqual(["a", "d", "b", "c"]);
    store.getState().setQueueStarred(["a"], true);
    store.getState().moveQueueFiles(["b"], "a");
    expect(store.getState().manualQueueFileIds).toEqual(["a", "d", "b", "c"]);
    for (const patch of [
      { queueSortField: "name" as const },
      { queueGroupMode: "tag" as const },
      { queueSearchText: "b" },
    ]) {
      store
        .getState()
        .setQueueView({
          queueSortField: "manual",
          queueGroupMode: "none",
          queueSearchText: "",
          ...patch,
        });
      store.getState().moveQueueFiles(["c"], "d");
      expect(store.getState().manualQueueFileIds).toEqual(["a", "d", "b", "c"]);
    }
  });
  it("round-trips stars and manual order, appends restored files in snapshot order, and reads old snapshots", async () => {
    const { buildSnapshot } = await import("@/lib/session-snapshot");
    const source = queued();
    source.getState().moveQueueFiles(["d"], "a");
    source.getState().setQueueStarred(["b"], true);
    const snapshot = JSON.parse(
      JSON.stringify(buildSnapshot(source.getState())),
    );
    const target = makeStore();
    target
      .getState()
      .addFile({
        id: "a",
        path: "/live/a.pdf",
        name: "a.pdf",
        ext: "pdf",
        kind: "pdf",
      });
    target.getState().restoreSnapshot(snapshot);
    expect(target.getState().manualQueueFileIds).toEqual(["a", "d", "b", "c"]);
    expect(
      target.getState().files.find((file) => file.id === "b")?.isStarred,
    ).toBe(true);
    expect(target.getState().files.find((file) => file.id === "a")?.path).toBe(
      "/live/a.pdf",
    );
    delete snapshot.manualQueueFileIds;
    const legacy = makeStore();
    legacy.getState().restoreSnapshot(snapshot);
    expect(legacy.getState().manualQueueFileIds).toEqual(["a", "b", "c", "d"]);
  });
  it("bulk removal clears work once per file and retains unrelated article selection", () => {
    const store = queued();
    store.getState().setSelectedArticleIds(["story"]);
    store.getState().removeFiles(["a", "a", "b"]);
    expect(store.getState().files.map((file) => file.id)).toEqual(["c", "d"]);
    expect(store.getState().selectedArticleIds).toEqual(["story"]);
    store.getState().removeFiles(["d"]);
    expect(store.getState().currentFileId).toBe("c");
    expect(store.getState().selectedArticleIds).toEqual([]);
    expect(store.getState().manualQueueFileIds).toEqual(["c"]);
    expect(store.getState().selectedQueueFileIds).toEqual(["c"]);
  });
});
