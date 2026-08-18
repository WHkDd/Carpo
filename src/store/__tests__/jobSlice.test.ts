import { describe, expect, it } from "vitest";
import { create } from "zustand";
import { immer } from "zustand/middleware/immer";
import { createQueueSlice, type QueueSlice } from "../queueSlice";
import { createUiSlice, type UiSlice } from "../uiSlice";
import { createFileViewSlice, type FileViewSlice } from "../fileViewSlice";
import { createPageStateSlice, type PageStateSlice } from "../pageStateSlice";
import { createSelectionSlice, type SelectionSlice } from "../selectionSlice";
import {
  createJobSlice,
  selectJobStartBlocked,
  type JobSlice,
} from "../jobSlice";
import { createSettingsSlice, type SettingsSlice } from "../settingsSlice";
import type { ProofreadReview } from "@/lib/proofread";

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

function openFile(store: ReturnType<typeof makeStore>) {
  store.getState().addFile({
    id: "file-1",
    path: "/tmp/a.pdf",
    name: "a.pdf",
    ext: "pdf",
    kind: "pdf",
  });
}

function pageReview(overrides: Partial<ProofreadReview> = {}): ProofreadReview {
  return {
    target: { mode: "whole_file", page: 1 },
    baseText: "本埠新聞，巳於昨日到達。",
    suggestions: [
      {
        before: "巳",
        after: "已",
        context_before: "本埠新聞，",
        category: "charform",
        confidence: 0.9,
        reason: "形近字误识",
        verdict: "accepted",
      },
    ],
    model: "gpt-4o",
    discarded: 0,
    status: "pending",
    createdAt: 1,
    ...overrides,
  };
}

describe("proofread jobs", () => {
  it("startJob records a proofread job with its submitted units", () => {
    const store = makeStore();
    openFile(store);
    store.getState().startJob({
      jobId: "job-1",
      kind: "proofread",
      fileId: "file-1",
      newspaperName: "申报",
      newspaperDate: "1945-08-15",
      units: [{ key: "page:1", text: "本埠新聞" }],
      stage: { kind: "proofread_running", index: 0, count: 1 },
    });
    const job = store.getState().activeJob;
    expect(job?.kind).toBe("proofread");
    if (job?.kind === "proofread") {
      expect(job.units).toEqual([{ key: "page:1", text: "本埠新聞" }]);
    }
  });
});

describe("job start claim", () => {
  function startProofreadJob(store: ReturnType<typeof makeStore>, jobId = "job-1") {
    store.getState().startJob({
      jobId,
      kind: "proofread",
      fileId: "file-1",
      newspaperName: "申报",
      newspaperDate: "1945-08-15",
      units: [{ key: "page:1", text: "本埠新聞" }],
      stage: { kind: "proofread_running", index: 0, count: 1 },
    });
  }

  it("grants the slot once and refuses every later attempt", () => {
    const store = makeStore();
    const first = store.getState().claimJobStart("proofread");
    expect(first).not.toBeNull();
    expect(store.getState().claimJobStart("whole_file")).toBeNull();
    expect(store.getState().claimJobStart("grouped_ocr")).toBeNull();
    store.getState().releaseJobStart(first!);
    expect(store.getState().claimJobStart("grouped_ocr")).not.toBeNull();
  });

  it("ignores a release from an attempt that no longer holds the slot", () => {
    const store = makeStore();
    const owner = store.getState().claimJobStart("proofread")!;
    store.getState().releaseJobStart("whole_file:999");
    expect(store.getState().jobStartClaim).toBe(owner);
    // Idempotent for the real owner: releasing twice is not an error.
    store.getState().releaseJobStart(owner);
    store.getState().releaseJobStart(owner);
    expect(store.getState().jobStartClaim).toBeNull();
  });

  it("refuses while a job is running or cancelling, allows once terminal", () => {
    const store = makeStore();
    openFile(store);
    const owner = store.getState().claimJobStart("proofread")!;
    startProofreadJob(store);
    // startJob hands the slot over in the same update — no gap where both
    // the claim and a running job are absent.
    expect(store.getState().jobStartClaim).toBeNull();
    store.getState().releaseJobStart(owner);

    expect(store.getState().claimJobStart("whole_file")).toBeNull();
    store.getState().markCancelling();
    expect(store.getState().claimJobStart("whole_file")).toBeNull();

    store.getState().applyJobDone({
      job_id: "job-1",
      cancelled: true,
      results: [],
      errors: [],
    });
    expect(store.getState().claimJobStart("whole_file")).not.toBeNull();
  });

  it("selectJobStartBlocked covers the claim and the running job alike", () => {
    const store = makeStore();
    openFile(store);
    expect(selectJobStartBlocked(store.getState())).toBe(false);

    const owner = store.getState().claimJobStart("proofread")!;
    expect(selectJobStartBlocked(store.getState())).toBe(true);

    startProofreadJob(store);
    store.getState().releaseJobStart(owner);
    expect(selectJobStartBlocked(store.getState())).toBe(true);

    store.getState().applyJobError({ job_id: "job-1", error: "boom" });
    expect(selectJobStartBlocked(store.getState())).toBe(false);
  });
});

describe("proofreadReviews", () => {
  it("setProofreadReviews merges per key and replaces on re-run", () => {
    const store = makeStore();
    openFile(store);
    store.getState().setProofreadReviews("file-1", {
      "page:1": pageReview(),
    });
    store.getState().setProofreadReviews("file-1", {
      "page:1": pageReview({ createdAt: 2, discarded: 3 }),
      "page:2": pageReview({ target: { mode: "whole_file", page: 2 } }),
    });
    const reviews = store.getState().proofreadReviews["file-1"]!;
    expect(Object.keys(reviews).sort()).toEqual(["page:1", "page:2"]);
    expect(reviews["page:1"]!.createdAt).toBe(2);
  });

  it("ignores reviews for files that were removed", () => {
    const store = makeStore();
    store.getState().setProofreadReviews("ghost", { "page:1": pageReview() });
    expect(store.getState().proofreadReviews["ghost"]).toBeUndefined();
  });

  it("setProofreadSuggestionVerdict updates one suggestion", () => {
    const store = makeStore();
    openFile(store);
    store.getState().setProofreadReviews("file-1", {
      "page:1": pageReview(),
    });
    store
      .getState()
      .setProofreadSuggestionVerdict("file-1", "page:1", 0, "rejected");
    expect(
      store.getState().proofreadReviews["file-1"]!["page:1"]!.suggestions[0]!
        .verdict
    ).toBe("rejected");

    store
      .getState()
      .setProofreadSuggestionVerdict("file-1", "page:1", 0, "edited", "己");
    const edited = store.getState().proofreadReviews["file-1"]!["page:1"]!
      .suggestions[0]!;
    expect(edited.verdict).toBe("edited");
    expect(edited.editedAfter).toBe("己");
  });

  it("setProofreadCategoryVerdict flips a whole category", () => {
    const store = makeStore();
    openFile(store);
    store.getState().setProofreadReviews("file-1", {
      "page:1": pageReview({
        suggestions: [
          ...pageReview().suggestions,
          {
            before: "到達",
            after: "抵達",
            context_before: "昨日",
            category: "semantic",
            confidence: 0.7,
            reason: "",
            verdict: "pending",
          },
        ],
      }),
    });
    store
      .getState()
      .setProofreadCategoryVerdict("file-1", "page:1", "semantic", "accepted");
    const suggestions = store.getState().proofreadReviews["file-1"]!["page:1"]!
      .suggestions;
    expect(suggestions.map((s) => s.verdict)).toEqual([
      "accepted",
      "accepted",
    ]);
  });

  describe("applyProofreadReview", () => {
    it("writes accepted suggestions into the page text and marks applied", () => {
      const store = makeStore();
      openFile(store);
      store.getState().setRecognizedPages("file-1", {
        1: {
          text: "本埠新聞，巳於昨日到達。",
          status: "done",
          sourceMode: "page_image",
        },
      });
      store.getState().setProofreadReviews("file-1", {
        "page:1": pageReview(),
      });
      expect(store.getState().applyProofreadReview("file-1", "page:1")).toBe(
        true
      );
      expect(store.getState().pageOcrTexts["file-1"]?.[1]).toBe(
        "本埠新聞，已於昨日到達。"
      );
      const review = store.getState().proofreadReviews["file-1"]!["page:1"]!;
      expect(review.status).toBe("applied");
      expect(review.appliedText).toBe("本埠新聞，已於昨日到達。");
    });

    it("records the conflict-skipped count and clears it on undo", () => {
      const store = makeStore();
      openFile(store);
      store.getState().setRecognizedPages("file-1", {
        1: { text: "甲\n巳", status: "done", sourceMode: "page_image" },
      });
      store.getState().setProofreadReviews("file-1", {
        "page:1": pageReview({
          baseText: "甲\n巳",
          suggestions: [
            {
              before: "甲巳",
              after: "甲乙巳",
              context_before: "",
              category: "garble",
              confidence: 0.9,
              reason: "缺字",
              verdict: "accepted",
            },
            {
              before: "甲巳",
              after: "甲丙巳",
              context_before: "",
              category: "garble",
              confidence: 0.9,
              reason: "缺字",
              verdict: "accepted",
            },
          ],
        }),
      });
      expect(store.getState().applyProofreadReview("file-1", "page:1")).toBe(
        true
      );
      const review = store.getState().proofreadReviews["file-1"]!["page:1"]!;
      // The second insertion sits on the first one's point: skipped, and the
      // count is stored where the applied banner can show it.
      expect(review.appliedConflictSkipped).toBe(1);
      expect(store.getState().pageOcrTexts["file-1"]?.[1]).toBe("甲\n乙巳");
      expect(store.getState().undoProofreadReview("file-1", "page:1")).toBe(
        true
      );
      expect(
        store.getState().proofreadReviews["file-1"]!["page:1"]!
          .appliedConflictSkipped
      ).toBeUndefined();
    });

    it("refuses when the live text no longer equals the base snapshot", () => {
      const store = makeStore();
      openFile(store);
      store.getState().setRecognizedPages("file-1", {
        1: {
          text: "用户手动改过的文本",
          status: "done",
          sourceMode: "page_image",
        },
      });
      store.getState().setProofreadReviews("file-1", {
        "page:1": pageReview(),
      });
      expect(store.getState().applyProofreadReview("file-1", "page:1")).toBe(
        false
      );
      expect(store.getState().pageOcrTexts["file-1"]?.[1]).toBe(
        "用户手动改过的文本"
      );
      expect(
        store.getState().proofreadReviews["file-1"]!["page:1"]!.status
      ).toBe("pending");
    });

    it("refuses to apply twice", () => {
      const store = makeStore();
      openFile(store);
      store.getState().setRecognizedPages("file-1", {
        1: {
          text: "本埠新聞，巳於昨日到達。",
          status: "done",
          sourceMode: "page_image",
        },
      });
      store
        .getState()
        .setProofreadReviews("file-1", { "page:1": pageReview() });
      expect(store.getState().applyProofreadReview("file-1", "page:1")).toBe(
        true
      );
      expect(store.getState().applyProofreadReview("file-1", "page:1")).toBe(
        false
      );
    });

    it("writes into the article path for grouped targets and re-assembles", () => {
      const store = makeStore();
      openFile(store);
      store
        .getState()
        .addArticle("file-1", 1, { id: "a_1", num: 1, title: "报道1" }, []);
      store
        .getState()
        .setArticleOcrTexts("file-1", { a_1: "本埠新聞，巳於昨日到達。" });
      store.getState().setProofreadReviews("file-1", {
        "article:a_1": pageReview({
          target: { mode: "grouped", articleId: "a_1" },
        }),
      });
      expect(
        store.getState().applyProofreadReview("file-1", "article:a_1")
      ).toBe(true);
      expect(store.getState().articleOcrTexts["file-1"]?.["a_1"]).toBe(
        "本埠新聞，已於昨日到達。"
      );
    });
  });

  describe("undoProofreadReview", () => {
    it("restores the base text and re-opens the review", () => {
      const store = makeStore();
      openFile(store);
      store.getState().setRecognizedPages("file-1", {
        1: {
          text: "本埠新聞，巳於昨日到達。",
          status: "done",
          sourceMode: "page_image",
        },
      });
      store.getState().setProofreadReviews("file-1", {
        "page:1": pageReview(),
      });
      expect(store.getState().applyProofreadReview("file-1", "page:1")).toBe(
        true
      );
      expect(store.getState().undoProofreadReview("file-1", "page:1")).toBe(
        true
      );
      expect(store.getState().pageOcrTexts["file-1"]?.[1]).toBe(
        "本埠新聞，巳於昨日到達。"
      );
      expect(
        store.getState().proofreadReviews["file-1"]!["page:1"]!.status
      ).toBe("pending");
    });

    it("refuses when the text was edited after applying", () => {
      const store = makeStore();
      openFile(store);
      store.getState().setRecognizedPages("file-1", {
        1: {
          text: "本埠新聞，巳於昨日到達。",
          status: "done",
          sourceMode: "page_image",
        },
      });
      store.getState().setProofreadReviews("file-1", {
        "page:1": pageReview(),
      });
      store.getState().applyProofreadReview("file-1", "page:1");
      store
        .getState()
        .updateRecognizedPageText("file-1", 1, "应用后又改过的文本");
      expect(store.getState().undoProofreadReview("file-1", "page:1")).toBe(
        false
      );
      expect(store.getState().pageOcrTexts["file-1"]?.[1]).toBe(
        "应用后又改过的文本"
      );
    });
  });

  it("discardProofreadReview removes only that key", () => {
    const store = makeStore();
    openFile(store);
    store.getState().setProofreadReviews("file-1", {
      "page:1": pageReview(),
      "page:2": pageReview({ target: { mode: "whole_file", page: 2 } }),
    });
    store.getState().discardProofreadReview("file-1", "page:1");
    expect(Object.keys(store.getState().proofreadReviews["file-1"]!)).toEqual([
      "page:2",
    ]);
    store.getState().discardProofreadReview("file-1", "page:2");
    expect(store.getState().proofreadReviews["file-1"]).toBeUndefined();
  });

  it("removeFile clears the file's reviews", () => {
    const store = makeStore();
    openFile(store);
    store.getState().setProofreadReviews("file-1", {
      "page:1": pageReview(),
    });
    store.getState().removeFile("file-1");
    expect(store.getState().proofreadReviews["file-1"]).toBeUndefined();
  });
});
