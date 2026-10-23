import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { startGroupedOcr, startWholeFileOcr, cancelJob, downloadBlob } = vi.hoisted(
  () => ({
    startGroupedOcr: vi.fn(async () => ({ job_id: "job-g" })),
    startWholeFileOcr: vi.fn(async () => ({ job_id: "job-w" })),
    cancelJob: vi.fn(async () => true),
    downloadBlob: vi.fn(),
  })
);

vi.mock("@/lib/tauri", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/tauri")>()),
  getSecret: vi.fn(async () => true),
  startGroupedOcr,
  startWholeFileOcr,
  cancelJob,
}));
vi.mock("@/lib/runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/runtime")>()),
  isTauriRuntime: () => false,
  downloadBlob,
}));
vi.mock("@/lib/desktop", () => ({
  enableNotificationsAfterUserAction: vi.fn(async () => {}),
  notifyOcrResult: vi.fn(async () => {}),
}));

import { useStore } from "@/store";
import { notifyOcrResult } from "@/lib/desktop";
import { articleRegionKey } from "@/hooks/useGroupedOcrTrigger";
import { selectJobStartBlocked } from "@/store/jobSlice";
import { t } from "@/i18n";
import {
  batchEntry,
  batchSummaryText,
  buildFileExport,
  cancelBatchExport,
  mergedDocBlocks,
  mergedMarkdown,
  missingUnits,
  planBatchFile,
  planOutputDocs,
  routeBatchJobEvent,
  sortBatchEntries,
  standaloneDocBlocks,
  startBatchExport,
} from "../batch-export";

const INITIAL = useStore.getState();

function addPdf(id: string, pdfTotal = 2) {
  useStore.getState().addFile({
    id,
    path: `/tmp/${id}.pdf`,
    name: `${id}.pdf`,
    ext: "pdf",
    kind: "pdf",
    pdfTotal,
  });
}

/** One framed article on page 1 of `fileId`. */
function frameArticle(fileId: string, articleId: string, title = "") {
  const s = useStore.getState();
  s.addBlock(fileId, 1, {
    id: `${articleId}-b`,
    x: 0,
    y: 0,
    w: 10,
    h: 10,
    articleId: null,
    articleOrder: null,
  });
  s.addArticle(fileId, 1, { id: articleId, num: 0, title }, [`${articleId}-b`]);
}

beforeEach(() => {
  useStore.setState(INITIAL, true);
  vi.clearAllMocks();
});
afterEach(() => {
  useStore.setState(INITIAL, true);
});

describe("planBatchFile", () => {
  it("framed file → grouped over its articles; unframed → whole-file range", () => {
    addPdf("framed");
    frameArticle("framed", "a1");
    addPdf("plain", 3);
    useStore.getState().setWholeFileRange("plain", "2-3");

    const framed = planBatchFile(useStore.getState(), "framed");
    expect(framed.mode).toBe("grouped");
    expect(framed.articles.map((a) => a.id)).toEqual(["a1"]);
    expect(framed.articles[0]!.blocks[0]!.rect).toEqual({
      x: 0,
      y: 0,
      width: 10,
      height: 10,
    });

    const plain = planBatchFile(useStore.getState(), "plain");
    expect(plain.mode).toBe("whole_file");
    expect(plain.pages).toEqual([2, 3]);
  });

  it("an unreadable file is planned as an error, not silently skipped", () => {
    useStore.getState().addFile({
      id: "bad",
      path: "/tmp/bad.dng",
      name: "bad.dng",
      ext: "dng",
      kind: "image",
      loadError: "no preview",
    });
    expect(planBatchFile(useStore.getState(), "bad").error).toBe("no preview");
  });
});

describe("missingUnits", () => {
  it("reuses existing results and retries failure markers", () => {
    addPdf("f");
    frameArticle("f", "a1");
    frameArticle("f", "a2");
    frameArticle("f", "a3");
    useStore.getState().setArticleOcrTexts("f", {
      a1: "已有正文",
      a2: t("job.recognizeFailed", { message: "timeout" }),
    });
    const plan = planBatchFile(useStore.getState(), "f");
    expect(missingUnits(useStore.getState(), plan).articles.map((a) => a.id)).toEqual([
      "a2",
      "a3",
    ]);

    addPdf("w", 3);
    useStore.getState().setRecognizedPages("w", {
      1: { text: "p1", status: "done", sourceMode: "page_image" },
      2: { text: "x", status: "failed", sourceMode: "page_image" },
    });
    const wPlan = planBatchFile(useStore.getState(), "w");
    expect(missingUnits(useStore.getState(), wPlan).pages).toEqual([2, 3]);
  });
});

describe("export content", () => {
  it("merged: 报刊名 → 日期 · 文件名 + tags → article / page headings", () => {
    addPdf("g");
    frameArticle("g", "a1", "標題");
    useStore.getState().setArticleOcrTexts("g", { a1: "正文" });
    useStore.getState().updateDocumentMetadata("g", {
      newspaperName: "申報",
      newspaperDate: "1936-05-12",
    });
    useStore.getState().addTagToFiles(["g"], "社會");
    addPdf("w", 1);
    useStore.getState().setRecognizedPages("w", {
      1: { text: "## 小節\n內容", status: "done", sourceMode: "page_image" },
    });

    const s = useStore.getState();
    const entries = sortBatchEntries(
      ["w", "g"].map((id) => batchEntry(s, planBatchFile(s, id)))
    );
    const contents = new Map(
      entries.map((e) => [
        e.fileId,
        buildFileExport(s, planBatchFile(s, e.fileId), e),
      ])
    );
    const [doc] = planOutputDocs("merged", entries);
    expect(mergedMarkdown(doc!, contents)).toBe(
      [
        "# 申報",
        "## 1936-05-12 · g.pdf",
        t("batch.tagLine", { tags: "社會" }),
        "### 標題",
        "正文",
        `# ${t("batch.unnamedGroup")}`,
        "## w.pdf",
        `### ${t("batch.pageHeading", { name: "w.pdf", page: 1 })}`,
        "##### 小節\n內容",
      ].join("\n\n")
    );
    expect(mergedDocBlocks(doc!, contents).slice(0, 5)).toEqual([
      { kind: "heading", level: 1, text: "申報" },
      { kind: "heading", level: 2, text: "1936-05-12 · g.pdf" },
      { kind: "paragraph", text: t("batch.tagLine", { tags: "社會" }) },
      { kind: "heading", level: 3, text: "標題" },
      { kind: "paragraph", text: "正文" },
    ]);

    // A file exported on its own keeps the single-file export format.
    const g = contents.get("g")!;
    expect(g.markdown).toBe("申報\n1936-05-12\n\n標題\n正文");
    expect(standaloneDocBlocks(g)).toEqual([
      { kind: "paragraph", text: "申報" },
      { kind: "paragraph", text: "1936-05-12" },
      { kind: "heading", level: 1, text: "標題" },
      { kind: "paragraph", text: "正文" },
    ]);
  });
});

describe("background runner", () => {
  it("runs files in order beside the foreground slot and writes results back", async () => {
    addPdf("g");
    frameArticle("g", "a1", "標題");
    addPdf("w", 1);
    addPdf("other", 1); // added last → current file

    const result = await startBatchExport({
      fileIds: ["g", "w"],
      layout: "separate",
      format: "md",
    });
    expect(result).toEqual({ status: "started" });

    await vi.waitFor(() =>
      expect(useStore.getState().batchExport?.currentJobId).toBe("job-g")
    );
    // The foreground stays usable on another file, and refuses the busy one.
    expect(useStore.getState().activeJob).toBeNull();
    expect(selectJobStartBlocked(useStore.getState())).toBe(false);
    useStore.getState().setCurrent("g");
    expect(selectJobStartBlocked(useStore.getState())).toBe(true);
    expect(useStore.getState().claimJobStart("whole_file")).toBeNull();
    useStore.getState().setCurrent("other");
    const owner = useStore.getState().claimJobStart("whole_file");
    expect(owner).not.toBeNull();
    useStore.getState().releaseJobStart(owner!);

    // A batch event is consumed by the runner and never reaches activeJob.
    expect(
      routeBatchJobEvent("progress", { job_id: "job-g", done: 0, total: 1, label: "" })
    ).toBe(true);
    expect(
      routeBatchJobEvent("done", {
        job_id: "job-g",
        results: [{ article_id: "a1", text: "正文" }],
        errors: [],
        cancelled: false,
      })
    ).toBe(true);

    await vi.waitFor(() =>
      expect(useStore.getState().batchExport?.currentJobId).toBe("job-w")
    );
    expect(useStore.getState().articleOcrTexts.g).toEqual({ a1: "正文" });
    expect(startWholeFileOcr).toHaveBeenCalledWith(
      expect.objectContaining({ file_id: "w", pages: [1] })
    );
    routeBatchJobEvent("done", {
      job_id: "job-w",
      results: [],
      errors: [{ page: 1, message: "boom" }],
      cancelled: false,
    });

    await vi.waitFor(() => expect(useStore.getState().batchExport?.status).toBe("done"));
    const items = useStore.getState().batchExport!.items;
    // w.pdf's only page failed: a document of failure markers is not
    // exported, and the file counts as failed.
    expect(items.map((i) => [i.status, i.failedUnits])).toEqual([
      ["done", 0],
      ["failed", 1],
    ]);
    expect(useStore.getState().recognizedPages.w?.[1]?.status).toBe("failed");
    expect(downloadBlob.mock.calls.map((c) => c[1])).toEqual(["g.md"]);
    expect(useStore.getState().activeJob).toBeNull();
  });

  it("starts no job when every unit already has a result", async () => {
    addPdf("g");
    frameArticle("g", "a1");
    useStore.getState().setArticleOcrTexts("g", { a1: "已有" });

    await startBatchExport({ fileIds: ["g"], layout: "merged", format: "docx" });
    await vi.waitFor(() => expect(useStore.getState().batchExport?.status).toBe("done"));
    expect(startGroupedOcr).not.toHaveBeenCalled();
    expect(downloadBlob).toHaveBeenCalledTimes(1);
    expect(downloadBlob.mock.calls[0]![1]).toBe(
      `${t("batch.mergedDefaultName")}.docx`
    );
  });
});

describe("background runner, by tag", () => {
  it("recognizes a multi-tag file once and writes it into every tag document", async () => {
    addPdf("g1");
    frameArticle("g1", "a1", "甲");
    addPdf("g2");
    frameArticle("g2", "a2", "乙");
    useStore.getState().addTagToFiles(["g1"], "A");
    useStore.getState().addTagToFiles(["g1"], "B");
    startGroupedOcr
      .mockResolvedValueOnce({ job_id: "job-1" })
      .mockResolvedValueOnce({ job_id: "job-2" });

    await startBatchExport({ fileIds: ["g1", "g2"], layout: "by_tag", format: "md" });
    await vi.waitFor(() =>
      expect(useStore.getState().batchExport?.currentJobId).toBe("job-1")
    );
    routeBatchJobEvent("done", {
      job_id: "job-1",
      results: [{ article_id: "a1", text: "一" }],
      errors: [],
      cancelled: false,
    });
    await vi.waitFor(() =>
      expect(useStore.getState().batchExport?.currentJobId).toBe("job-2")
    );
    routeBatchJobEvent("done", {
      job_id: "job-2",
      results: [{ article_id: "a2", text: "二" }],
      errors: [],
      cancelled: false,
    });
    await vi.waitFor(() => expect(useStore.getState().batchExport?.status).toBe("done"));

    expect(startGroupedOcr).toHaveBeenCalledTimes(2);
    const written = await Promise.all(
      downloadBlob.mock.calls.map(async ([blob, name]) => [
        name,
        await (blob as Blob).text(),
      ])
    );
    expect(written.map(([name]) => name)).toEqual([
      "A.md",
      "B.md",
      `${t("batch.untagged")}.md`,
    ]);
    for (const [, text] of written.slice(0, 2)) {
      expect(text.match(/^## g1\.pdf$/gm)).toHaveLength(1);
      expect(text).not.toContain("g2.pdf");
    }
    expect(written[2]![1]).toContain("## g2.pdf");
  });
});

/** Drives one batch job to completion once the runner has sent it. */
async function finishJob(jobId: string, done: Record<string, unknown>) {
  await vi.waitFor(() =>
    expect(useStore.getState().batchExport?.currentJobId).toBe(jobId)
  );
  routeBatchJobEvent("done", { job_id: jobId, errors: [], cancelled: false, ...done } as never);
}

describe("review regressions", () => {
  it("re-recognizes an article whose boxes changed after its OCR", () => {
    addPdf("g");
    frameArticle("g", "a1", "標題");
    const plan = planBatchFile(useStore.getState(), "g");
    useStore.getState().writeGroupedJobResults(
      "g",
      [{ id: "a1", title: "標題", region: articleRegionKey(plan.articles[0]!) }],
      { job_id: "j", results: [{ article_id: "a1", text: "舊文" }], errors: [], cancelled: false },
      "",
      ""
    );
    expect(missingUnits(useStore.getState(), plan).articles).toEqual([]);

    useStore.getState().updateBlock("g", 1, "a1-b", { x: 5 });
    const moved = planBatchFile(useStore.getState(), "g");
    expect(missingUnits(useStore.getState(), moved).articles.map((a) => a.id)).toEqual([
      "a1",
    ]);
  });

  it("waits for a foreground start on the same file even after a file switch", async () => {
    addPdf("other", 1);
    addPdf("g");
    frameArticle("g", "a1");
    // Foreground claims while g is current, then the user moves on.
    const owner = useStore.getState().claimJobStart("grouped_ocr")!;
    useStore.getState().setCurrent("other");

    await startBatchExport({ fileIds: ["g"], layout: "separate", format: "md" });
    await new Promise((r) => setTimeout(r, 20));
    expect(startGroupedOcr).not.toHaveBeenCalled();

    useStore.getState().releaseJobStart(owner);
    await vi.waitFor(() => expect(startGroupedOcr).toHaveBeenCalledTimes(1));
    await finishJob("job-g", { results: [{ article_id: "a1", text: "正文" }] });
    await vi.waitFor(() => expect(useStore.getState().batchExport?.status).toBe("done"));
  });

  it("cancels the job of a file removed while its start RPC was in flight", async () => {
    addPdf("g");
    frameArticle("g", "a1");
    let release!: (v: { job_id: string }) => void;
    startGroupedOcr.mockImplementationOnce(
      () => new Promise((resolve) => (release = resolve))
    );
    await startBatchExport({ fileIds: ["g"], layout: "separate", format: "md" });
    await vi.waitFor(() => expect(startGroupedOcr).toHaveBeenCalled());

    useStore.getState().removeFile("g");
    release({ job_id: "job-late" });
    await vi.waitFor(() => expect(cancelJob).toHaveBeenCalledWith("job-late"));
    routeBatchJobEvent("done", {
      job_id: "job-late",
      results: [],
      errors: [],
      cancelled: true,
    });
    await vi.waitFor(() => expect(useStore.getState().batchExport?.status).toBe("done"));
    expect(useStore.getState().batchExport!.items[0]!.status).toBe("skipped");
  });

  it("stops writing tag documents once cancelled mid-write", async () => {
    addPdf("g");
    frameArticle("g", "a1");
    useStore.getState().setArticleOcrTexts("g", { a1: "已有" });
    useStore.getState().addTagToFiles(["g"], "A");
    useStore.getState().addTagToFiles(["g"], "B");
    downloadBlob.mockImplementationOnce(() => cancelBatchExport());

    await startBatchExport({ fileIds: ["g"], layout: "by_tag", format: "md" });
    await vi.waitFor(() =>
      expect(useStore.getState().batchExport?.status).toBe("cancelled")
    );
    expect(downloadBlob.mock.calls.map((c) => c[1])).toEqual(["A.md"]);
    expect(notifyOcrResult).not.toHaveBeenCalled();
  });

  it("counts partly and wholly failed files in the summary", async () => {
    addPdf("g");
    frameArticle("g", "a1", "一");
    frameArticle("g", "a2", "二");
    addPdf("w", 1);
    startGroupedOcr.mockResolvedValueOnce({ job_id: "job-1" });
    startWholeFileOcr.mockResolvedValueOnce({ job_id: "job-2" });

    await startBatchExport({ fileIds: ["g", "w"], layout: "separate", format: "md" });
    await finishJob("job-1", {
      results: [{ article_id: "a1", text: "正文" }],
      errors: [{ article_id: "a2", message: "timeout" }],
    });
    await finishJob("job-2", { results: [], errors: [{ page: 1, message: "boom" }] });
    await vi.waitFor(() => expect(useStore.getState().batchExport?.status).toBe("done"));

    const items = useStore.getState().batchExport!.items;
    expect(items.map((i) => [i.status, i.failedUnits])).toEqual([
      ["done", 1],
      ["failed", 1],
    ]);
    const summary = t("batch.summaryPartial", { ok: 0, partial: 1, failed: 1 });
    expect(batchSummaryText(items)).toBe(summary);
    expect(notifyOcrResult).toHaveBeenCalledWith(expect.objectContaining({ body: summary }));
    // The partly failed file is still exported, failure marker included.
    expect(downloadBlob.mock.calls.map((c) => c[1])).toEqual(["g.md"]);
  });

  it.each(["# 社論", "##社論"])(
    "strips the Markdown hashes of %j promoted to article title",
    (firstLine) => {
      addPdf("g");
      frameArticle("g", "a1", "");
      useStore.getState().setArticleOcrTexts("g", { a1: `${firstLine}\n正文` });
      const s = useStore.getState();
      const plan = planBatchFile(s, "g");
      const content = buildFileExport(s, plan, batchEntry(s, plan));
      expect(content.units[0]).toMatchObject({ title: "社論", body: "正文" });
    }
  );

  it("a whole-file document exported alone has no header lines in either format", () => {
    addPdf("w", 1);
    useStore.getState().updateDocumentMetadata("w", {
      newspaperName: "申報",
      newspaperDate: "1936-05-12",
    });
    useStore.getState().setRecognizedPages("w", {
      1: { text: "內容", status: "done", sourceMode: "page_image" },
    });
    const s = useStore.getState();
    const plan = planBatchFile(s, "w");
    const content = buildFileExport(s, plan, batchEntry(s, plan));
    expect(content.markdown).not.toContain("申報");
    expect(standaloneDocBlocks(content)).toEqual([
      { kind: "heading", level: 1, text: t("ocr.pageHeading", { page: 1 }) },
      { kind: "paragraph", text: "內容" },
    ]);
  });
});
