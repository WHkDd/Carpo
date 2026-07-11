import { describe, it, expect, beforeEach } from "vitest";
import { create } from "zustand";
import { immer } from "zustand/middleware/immer";
import { createQueueSlice, type QueueSlice } from "../queueSlice";
import { createUiSlice, type UiSlice } from "../uiSlice";
import { createFileViewSlice, type FileViewSlice } from "../fileViewSlice";
import { createPageStateSlice, type PageStateSlice } from "../pageStateSlice";
import { createSelectionSlice, type SelectionSlice } from "../selectionSlice";
import { createSettingsSlice, type SettingsSlice } from "../settingsSlice";
import { createJobSlice, type JobSlice } from "../jobSlice";
import type { LayoutPage } from "@/lib/layout-document";

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

describe("jobSlice", () => {
  let store: ReturnType<typeof makeStore>;
  beforeEach(() => {
    store = makeStore();
  });

  it("starts with no active job", () => {
    expect(store.getState().activeJob).toBeNull();
  });

  it("startJob seeds running state with empty totals", () => {
    store.getState().startJob({ jobId: "a", kind: "grouped_ocr", fileId: "f1", newspaperName: "申报", newspaperDate: "1945-08-15", requestedArticles: [{ id: "art1", title: "胜利" }] });
    const job = store.getState().activeJob;
    expect(job).toMatchObject({
      jobId: "a",
      status: "running",
      done: 0,
      total: 0,
    });
  });

  it("applyProgress only updates when job_id matches", () => {
    store.getState().startJob({ jobId: "a", kind: "grouped_ocr", fileId: "f1", newspaperName: "申报", newspaperDate: "1945-08-15", requestedArticles: [{ id: "art1", title: "胜利" }] });
    store.getState().applyProgress({
      job_id: "other",
      done: 5,
      total: 10,
      label: "ignored",
    });
    expect(store.getState().activeJob?.done).toBe(0);

    store.getState().applyProgress({
      job_id: "a",
      done: 3,
      total: 10,
      label: "报道1 · 第3/10块",
    });
    expect(store.getState().activeJob).toMatchObject({
      done: 3,
      total: 10,
      label: "报道1 · 第3/10块",
    });
  });

  it("normalizes whole-file progress to the requested page count", () => {
    store.getState().startJob({
      jobId: "a",
      kind: "whole_file",
      fileId: "f1",
      newspaperName: "申报",
      newspaperDate: "1945-08-15",
      requestedPages: [31, 32, 33, 34, 35, 36, 37, 38, 39, 40, 41],
    });

    store.getState().applyProgress({
      job_id: "a",
      done: 8,
      total: 270,
      label: "识别中 · 已完成 8/270 页",
    });

    expect(store.getState().activeJob).toMatchObject({
      done: 8,
      total: 11,
      label: "识别中 · 已完成 8/11 页",
    });
  });

  it("clamps whole-file progress when provider progress exceeds the requested page count", () => {
    store.getState().startJob({
      jobId: "a",
      kind: "whole_file",
      fileId: "f1",
      newspaperName: "申报",
      newspaperDate: "1945-08-15",
      requestedPages: [31, 32, 33],
    });

    store.getState().applyProgress({
      job_id: "a",
      done: 8,
      total: 270,
      label: "识别中 · 第8/270页",
    });

    expect(store.getState().activeJob).toMatchObject({
      done: 3,
      total: 3,
      label: "识别中 · 第3/3页",
    });
  });

  it("applyJobDone pins progress to total on a clean finish", () => {
    store.getState().startJob({ jobId: "a", kind: "grouped_ocr", fileId: "f1", newspaperName: "申报", newspaperDate: "1945-08-15", requestedArticles: [{ id: "art1", title: "胜利" }] });
    store.getState().applyProgress({
      job_id: "a",
      done: 4,
      total: 5,
      label: "...",
    });
    store.getState().applyJobDone({
      job_id: "a",
      results: [],
      errors: [],
      cancelled: false,
    });
    expect(store.getState().activeJob).toMatchObject({
      status: "done",
      done: 5,
      total: 5,
    });
  });

  it("applyJobDone with cancelled=true sets cancelled status and keeps partial done", () => {
    store.getState().startJob({ jobId: "a", kind: "grouped_ocr", fileId: "f1", newspaperName: "申报", newspaperDate: "1945-08-15", requestedArticles: [{ id: "art1", title: "胜利" }] });
    store.getState().applyProgress({
      job_id: "a",
      done: 2,
      total: 5,
      label: "...",
    });
    store.getState().markCancelling();
    store.getState().applyJobDone({
      job_id: "a",
      results: [],
      errors: [],
      cancelled: true,
    });
    expect(store.getState().activeJob).toMatchObject({
      status: "cancelled",
      done: 2,
      total: 5,
    });
  });

  it("clearActiveJob refuses while running, allows after terminal", () => {
    store.getState().startJob({ jobId: "a", kind: "grouped_ocr", fileId: "f1", newspaperName: "申报", newspaperDate: "1945-08-15", requestedArticles: [{ id: "art1", title: "胜利" }] });
    store.getState().clearActiveJob();
    expect(store.getState().activeJob).not.toBeNull();

    store.getState().applyJobError({ job_id: "a", error: "boom" });
    expect(store.getState().activeJob?.status).toBe("error");
    store.getState().clearActiveJob();
    expect(store.getState().activeJob).toBeNull();
  });

  it("markCancelling only transitions from running", () => {
    store.getState().startJob({ jobId: "a", kind: "grouped_ocr", fileId: "f1", newspaperName: "申报", newspaperDate: "1945-08-15", requestedArticles: [{ id: "art1", title: "胜利" }] });
    store.getState().applyJobDone({
      job_id: "a",
      results: [],
      errors: [],
      cancelled: false,
    });
    store.getState().markCancelling();
    expect(store.getState().activeJob?.status).toBe("done");
  });

  it("mirrors legacy page OCR text into recognizedPages", () => {
    store.getState().setPageOcrTexts("file-1", {
      1: "第一页",
      3: "第三页",
    });

    expect(store.getState().pageOcrTexts["file-1"]).toEqual({
      1: "第一页",
      3: "第三页",
    });
    expect(store.getState().recognizedPages["file-1"]).toMatchObject({
      1: {
        text: "第一页",
        status: "done",
        sourceMode: "page_image",
      },
      3: {
        text: "第三页",
        status: "done",
        sourceMode: "page_image",
      },
    });
  });

  it("mirrors recognizedPages text back to the legacy page map", () => {
    store.getState().setRecognizedPages("file-1", {
      2: {
        text: "第二页",
        status: "done",
        sourceMode: "paddle_document",
        sourceJobId: "job-1",
      },
      4: {
        text: "[识别失败：timeout]",
        status: "failed",
        error: "timeout",
        sourceMode: "page_image",
        sourceJobId: "job-2",
      },
    });

    expect(store.getState().pageOcrTexts["file-1"]).toEqual({
      2: "第二页",
      4: "[识别失败：timeout]",
    });
    expect(store.getState().recognizedPages["file-1"]?.[2]).toMatchObject({
      text: "第二页",
      status: "done",
      sourceMode: "paddle_document",
      sourceJobId: "job-1",
    });
    expect(store.getState().recognizedPages["file-1"]?.[4]).toMatchObject({
      text: "[识别失败：timeout]",
      status: "failed",
      error: "timeout",
    });
  });

  it("clears stale page errors when a later result succeeds", () => {
    store.getState().setRecognizedPages("file-1", {
      1: {
        text: "[识别失败：timeout]",
        status: "failed",
        error: "timeout",
        sourceMode: "page_image",
      },
    });

    store.getState().setRecognizedPages("file-1", {
      1: {
        text: "重跑成功",
        status: "done",
        sourceMode: "paddle_document",
      },
    });

    expect(store.getState().recognizedPages["file-1"]?.[1]).toEqual({
      text: "重跑成功",
      status: "done",
      sourceMode: "paddle_document",
    });
  });

  function addQueuedFile(id: string) {
    store.getState().addFile({
      id,
      path: `/tmp/${id}.pdf`,
      name: `${id}.pdf`,
      ext: "pdf",
      kind: "pdf",
    });
  }

  function makeLayout(): LayoutPage {
    return {
      index: 1,
      width: 100,
      height: 200,
      blocks: [
        {
          label: "text",
          text: "第一块",
          bbox: [0, 0, 50, 20],
          order: 2,
        },
        {
          label: "title",
          text: "标题块",
          bbox: [0, 30, 80, 50],
          order: 1,
        },
      ],
    };
  }

  it("updateRecognizedPageText edits text but keeps layout/source metadata", () => {
    addQueuedFile("file-1");
    store.getState().setRecognizedPages("file-1", {
      2: {
        text: "原始识别",
        status: "done",
        sourceMode: "paddle_document",
        sourceJobId: "job-1",
      },
    });

    store.getState().updateRecognizedPageText("file-1", 2, "人工校对后");

    expect(store.getState().recognizedPages["file-1"]?.[2]).toEqual({
      text: "人工校对后",
      status: "done",
      sourceMode: "paddle_document",
      sourceJobId: "job-1",
    });
    expect(store.getState().pageOcrTexts["file-1"]?.[2]).toBe("人工校对后");
  });

  it("updateRecognizedPageText creates a minimal entry for unseen pages", () => {
    addQueuedFile("file-1");
    store.getState().updateRecognizedPageText("file-1", 5, "手动补录");

    expect(store.getState().recognizedPages["file-1"]?.[5]).toEqual({
      text: "手动补录",
      status: "done",
      sourceMode: "page_image",
    });
    expect(store.getState().pageOcrTexts["file-1"]?.[5]).toBe("手动补录");
  });

  it("updateLayoutBlockText edits only the targeted block text and keeps block metadata", () => {
    addQueuedFile("file-1");
    store.getState().setRecognizedPages("file-1", {
      1: {
        text: "第一块\n标题块",
        layout: makeLayout(),
        status: "done",
        sourceMode: "paddle_document",
      },
    });

    store.getState().updateLayoutBlockText("file-1", 1, 1, "校对标题");

    const blocks =
      store.getState().recognizedPages["file-1"]?.[1]?.layout?.blocks;
    expect(blocks?.[1]).toEqual({
      label: "title",
      text: "校对标题",
      bbox: [0, 30, 80, 50],
      order: 1,
    });
    expect(blocks?.[0]).toEqual({
      label: "text",
      text: "第一块",
      bbox: [0, 0, 50, 20],
      order: 2,
    });
  });

  it("updateLayoutBlockText mirrors a unique old block text into page text and legacy page map", () => {
    addQueuedFile("file-1");
    store.getState().setRecognizedPages("file-1", {
      1: {
        text: "前缀 第一块 后缀",
        layout: makeLayout(),
        status: "done",
        sourceMode: "paddle_document",
      },
    });

    store.getState().updateLayoutBlockText("file-1", 1, 0, "校对第一块");

    expect(store.getState().recognizedPages["file-1"]?.[1]?.text).toBe(
      "前缀 校对第一块 后缀"
    );
    expect(store.getState().pageOcrTexts["file-1"]?.[1]).toBe(
      "前缀 校对第一块 后缀"
    );
  });

  it("updateLayoutBlockText does not mirror when old block text appears multiple times", () => {
    addQueuedFile("file-1");
    store.getState().setRecognizedPages("file-1", {
      1: {
        text: "第一块 / 第一块",
        layout: makeLayout(),
        status: "done",
        sourceMode: "paddle_document",
      },
    });

    store.getState().updateLayoutBlockText("file-1", 1, 0, "校对第一块");

    expect(
      store.getState().recognizedPages["file-1"]?.[1]?.layout?.blocks[0]?.text
    ).toBe("校对第一块");
    expect(store.getState().recognizedPages["file-1"]?.[1]?.text).toBe(
      "第一块 / 第一块"
    );
    expect(store.getState().pageOcrTexts["file-1"]?.[1]).toBe(
      "第一块 / 第一块"
    );
  });

  it("updateLayoutBlockText does not mirror blank old block text", () => {
    addQueuedFile("file-1");
    const layout = makeLayout();
    layout.blocks[0]!.text = "   ";
    store.getState().setRecognizedPages("file-1", {
      1: {
        text: "页面文本",
        layout,
        status: "done",
        sourceMode: "paddle_document",
      },
    });

    store.getState().updateLayoutBlockText("file-1", 1, 0, "校对第一块");

    expect(
      store.getState().recognizedPages["file-1"]?.[1]?.layout?.blocks[0]?.text
    ).toBe("校对第一块");
    expect(store.getState().recognizedPages["file-1"]?.[1]?.text).toBe(
      "页面文本"
    );
    expect(store.getState().pageOcrTexts["file-1"]?.[1]).toBe("页面文本");
  });

  it("updateLayoutBlockText no-ops for invalid targets and removed files", () => {
    addQueuedFile("file-1");
    store.getState().setRecognizedPages("file-1", {
      1: {
        text: "第一块",
        layout: makeLayout(),
        status: "done",
        sourceMode: "paddle_document",
      },
      2: {
        text: "无版面",
        status: "done",
        sourceMode: "page_image",
      },
    });

    expect(() =>
      store.getState().updateLayoutBlockText("file-1", 1, 99, "越界")
    ).not.toThrow();
    expect(() =>
      store.getState().updateLayoutBlockText("file-1", 2, 0, "无版面")
    ).not.toThrow();
    expect(
      store.getState().recognizedPages["file-1"]?.[1]?.layout?.blocks[0]?.text
    ).toBe("第一块");
    expect(store.getState().recognizedPages["file-1"]?.[2]?.text).toBe(
      "无版面"
    );

    store.getState().removeFile("file-1");
    expect(() =>
      store.getState().updateLayoutBlockText("file-1", 1, 0, "迟到")
    ).not.toThrow();
    expect(store.getState().recognizedPages["file-1"]).toBeUndefined();
  });

  it("updateLayoutBlockText treats replacement text containing $& literally", () => {
    addQueuedFile("file-1");
    store.getState().setRecognizedPages("file-1", {
      1: {
        text: "前缀 第一块 后缀",
        layout: makeLayout(),
        status: "done",
        sourceMode: "paddle_document",
      },
    });

    store.getState().updateLayoutBlockText("file-1", 1, 0, "校对$&第一块");

    expect(store.getState().recognizedPages["file-1"]?.[1]?.text).toBe(
      "前缀 校对$&第一块 后缀"
    );
    expect(store.getState().pageOcrTexts["file-1"]?.[1]).toBe(
      "前缀 校对$&第一块 后缀"
    );
  });

  it("updateArticleOcrText edits the article and re-assembles the document", () => {
    addQueuedFile("file-1");
    store.getState().addArticle(
      "file-1",
      1,
      { id: "art-1", num: 1, title: "胜利" },
      ["blk-1"]
    );
    store.getState().setArticleOcrTexts("file-1", { "art-1": "原始文本" });
    store.getState().setDocumentResult("file-1", "旧的组装结果");

    store.getState().updateArticleOcrText("file-1", "art-1", "校对文本");

    expect(store.getState().articleOcrTexts["file-1"]?.["art-1"]).toBe(
      "校对文本"
    );
    expect(store.getState().documentResults["file-1"]).toContain("校对文本");
    expect(store.getState().documentResults["file-1"]).not.toContain(
      "原始文本"
    );
  });

  it("edit write-backs after removeFile do not resurrect file state", () => {
    addQueuedFile("file-1");
    store.getState().removeFile("file-1");

    store.getState().updateRecognizedPageText("file-1", 1, "迟到的写回");
    store.getState().updateArticleOcrText("file-1", "art-1", "迟到的写回");

    expect(store.getState().pageOcrTexts["file-1"]).toBeUndefined();
    expect(store.getState().recognizedPages["file-1"]).toBeUndefined();
    expect(store.getState().articleOcrTexts["file-1"]).toBeUndefined();
  });
});
