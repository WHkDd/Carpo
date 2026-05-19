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
});
