import type { StateCreator } from "zustand";
import type { FileViewSlice } from "./fileViewSlice";
import type { QueueSlice } from "./queueSlice";
import { rebuildDocumentResult, type PageStateSlice } from "./pageStateSlice";
import type { SelectionSlice } from "./selectionSlice";
import type { SettingsSlice } from "./settingsSlice";
import type { UiSlice } from "./uiSlice";
import type {
  JobDone,
  JobError,
  JobProgress,
} from "@/lib/ipc-types";
import type { LayoutPage } from "@/lib/layout-document";

export type JobStatus =
  | "running"
  | "cancelling"
  | "done"
  | "error"
  | "cancelled";

interface BaseActiveJob {
  jobId: string;
  status: JobStatus;
  done: number;
  total: number;
  label: string;
  /** Set when status is "error". */
  error?: string;
  /** Captured on `done`. The shape depends on `kind`. */
  result?: JobDone;
  /** Snapshot of which file was submitted. Captured at startJob time so the
   *  result handler can write back even if the user navigates away mid-OCR. */
  fileId: string;
  newspaperName: string;
  newspaperDate: string;
}

export interface GroupedActiveJob extends BaseActiveJob {
  kind: "grouped_ocr";
  requestedArticles: Array<{ id: string; title: string }>;
}

export interface WholeFileActiveJob extends BaseActiveJob {
  kind: "whole_file";
  requestedPages: number[];
}

export type ActiveJob = GroupedActiveJob | WholeFileActiveJob;

export type RecognizedPageStatus = "pending" | "running" | "done" | "failed";

export type RecognizedPageSourceMode =
  | "page_image"
  | "paddle_document"
  | "paddle_document_chunk"
  | "paddle_json_import";

export interface RecognizedPage {
  text: string;
  layout?: LayoutPage;
  status: RecognizedPageStatus;
  error?: string;
  sourceMode: RecognizedPageSourceMode;
  sourceJobId?: string;
  chunkId?: string;
  chunkPage?: number;
}

export type RecognizedPages = Record<string, Record<number, RecognizedPage>>;

function mergeRecognizedPage(
  prev: RecognizedPage | undefined,
  next: RecognizedPage
): RecognizedPage {
  const merged = { ...prev, ...next };
  if (merged.status !== "failed") {
    delete merged.error;
  }
  return merged;
}

function normalizeWholeFileProgress(
  job: WholeFileActiveJob,
  progress: JobProgress
): Pick<JobProgress, "done" | "total" | "label"> {
  const requestedTotal = job.requestedPages.length;
  if (requestedTotal === 0) {
    return {
      done: progress.done,
      total: progress.total,
      label: progress.label,
    };
  }

  const total = requestedTotal;
  const done = Math.min(Math.max(0, progress.done), total);
  const label = progress.label
    .replace(/共\s+\d+\s+页/g, `共 ${total} 页`)
    .replace(/已完成\s+\d+\s*\/\s*\d+\s+页/g, `已完成 ${done}/${total} 页`)
    .replace(/第(\d+)\s*\/\s*\d+页/g, (_match, pageIndex: string) => {
      const current = Math.min(Math.max(1, Number(pageIndex)), total);
      return `第${current}/${total}页`;
    });

  return { done, total, label };
}

export type StartJobInfo =
  | {
      jobId: string;
      kind: "grouped_ocr";
      fileId: string;
      newspaperName: string;
      newspaperDate: string;
      requestedArticles: Array<{ id: string; title: string }>;
      label?: string;
    }
  | {
      jobId: string;
      kind: "whole_file";
      fileId: string;
      newspaperName: string;
      newspaperDate: string;
      requestedPages: number[];
      label?: string;
    };

export interface JobSlice {
  activeJob: ActiveJob | null;
  /** Map of fileId → last-assembled document. Re-built on every grouped-OCR
   *  finish from the merged per-article texts, so partial OCR runs keep the
   *  assembled output coherent with the current article order. */
  documentResults: Record<string, string>;
  /** fileId → articleId → raw OCR text. Merged across runs so a partial
   *  re-OCR doesn't wipe results for articles outside the new selection.
   *  Cleared when the file is removed from the queue. */
  articleOcrTexts: Record<string, Record<string, string>>;
  /** fileId → page → raw OCR text. Populated by whole-file OCR runs and
   *  rendered in the "按页" tab of the OCR text panel. Merged across runs so
   *  re-running a subrange doesn't wipe the previous pages' results.
   *  Cleared when the file is removed from the queue. */
  pageOcrTexts: Record<string, Record<number, string>>;
  /** fileId → original PDF page → normalized page OCR/layout result. This is
   *  the forward-compatible store for page-image OCR, Paddle document jobs,
   *  chunked document jobs, and imported Paddle JSON. During migration it is
   *  kept in sync with `pageOcrTexts` so older UI paths continue to work. */
  recognizedPages: RecognizedPages;
  /** Called immediately after `startGroupedOcr` / `startWholeFileOcr` returns
   *  the job id. The first `JobProgress` event will fill in `total`; until
   *  then we show 0/0. */
  startJob: (info: StartJobInfo) => void;
  applyProgress: (p: JobProgress) => void;
  markCancelling: () => void;
  applyJobDone: (d: JobDone) => void;
  applyJobError: (e: JobError) => void;
  /** Dismiss the inline progress widget. Only allowed in a terminal status —
   *  guards against closing a still-running job. */
  clearActiveJob: () => void;
  setDocumentResult: (fileId: string, document: string) => void;
  setArticleOcrTexts: (fileId: string, texts: Record<string, string>) => void;
  /** Merge per-page OCR text into the file-scoped map. Callers pass only the
   *  pages they have new data for; pages outside the patch are preserved. An
   *  explicit empty string is a valid value (e.g. an error sentinel) so the
   *  slot exists. */
  setPageOcrTexts: (fileId: string, texts: Record<number, string>) => void;
  /** Merge normalized per-page results and mirror their text into
   *  `pageOcrTexts` for compatibility with older consumers. */
  setRecognizedPages: (
    fileId: string,
    pages: Record<number, RecognizedPage>
  ) => void;
  /** Persist a user edit of one page's text. Preserves the recognized page's
   *  layout / status / source metadata and mirrors into `pageOcrTexts`. */
  updateRecognizedPageText: (fileId: string, page: number, text: string) => void;
  /** Persist a user edit of one layout block's text. When the old block text
   *  appears exactly once in the page text, mirror the edit back to the page
   *  text as a one-way block -> page sync. */
  updateLayoutBlockText: (
    fileId: string,
    page: number,
    blockIndex: number,
    text: string
  ) => void;
  /** Persist a user edit of one article's OCR text, then re-assemble the
   *  document result so bulk copy / export reflect the edit. */
  updateArticleOcrText: (fileId: string, articleId: string, text: string) => void;
}

export const createJobSlice: StateCreator<
  QueueSlice &
    UiSlice &
    FileViewSlice &
    PageStateSlice &
    SelectionSlice &
    SettingsSlice &
    JobSlice,
  [["zustand/immer", never]],
  [],
  JobSlice
> = (set) => ({
  activeJob: null,
  documentResults: {},
  articleOcrTexts: {},
  pageOcrTexts: {},
  recognizedPages: {},
  startJob: (info) =>
    set((state) => {
      const base: BaseActiveJob = {
        jobId: info.jobId,
        status: "running",
        done: 0,
        total: 0,
        label: info.label ?? "准备中…",
        fileId: info.fileId,
        newspaperName: info.newspaperName,
        newspaperDate: info.newspaperDate,
      };
      state.activeJob =
        info.kind === "grouped_ocr"
          ? {
              ...base,
              kind: "grouped_ocr",
              requestedArticles: info.requestedArticles.map((a) => ({ ...a })),
            }
          : {
              ...base,
              kind: "whole_file",
              requestedPages: [...info.requestedPages],
            };
    }),
  applyProgress: (p) =>
    set((state) => {
      const job = state.activeJob;
      if (!job || job.jobId !== p.job_id) return;
      const progress =
        job.kind === "whole_file" ? normalizeWholeFileProgress(job, p) : p;
      job.done = progress.done;
      job.total = progress.total;
      job.label = progress.label;
    }),
  markCancelling: () =>
    set((state) => {
      const job = state.activeJob;
      if (!job || job.status !== "running") return;
      job.status = "cancelling";
    }),
  applyJobDone: (d) =>
    set((state) => {
      const job = state.activeJob;
      if (!job || job.jobId !== d.job_id) return;
      job.status = d.cancelled ? "cancelled" : "done";
      job.result = d;
      // Pin the bar to full on a clean finish so the user sees 100%.
      if (!d.cancelled && job.total > 0) job.done = job.total;
    }),
  applyJobError: (e) =>
    set((state) => {
      const job = state.activeJob;
      if (!job || job.jobId !== e.job_id) return;
      job.status = "error";
      job.error = e.error;
    }),
  clearActiveJob: () =>
    set((state) => {
      const job = state.activeJob;
      if (!job) return;
      // Refuse to clear an in-flight job — caller should cancel first.
      if (job.status === "running" || job.status === "cancelling") return;
      state.activeJob = null;
    }),
  setDocumentResult: (fileId, document) =>
    set((state) => {
      state.documentResults[fileId] = document;
    }),
  setArticleOcrTexts: (fileId, texts) =>
    set((state) => {
      const prev = state.articleOcrTexts[fileId] ?? {};
      state.articleOcrTexts[fileId] = { ...prev, ...texts };
    }),
  setPageOcrTexts: (fileId, texts) =>
    set((state) => {
      const prev = state.pageOcrTexts[fileId] ?? {};
      state.pageOcrTexts[fileId] = { ...prev, ...texts };

      const prevPages = state.recognizedPages[fileId] ?? {};
      const nextPages: Record<number, RecognizedPage> = { ...prevPages };
      Object.entries(texts).forEach(([rawPage, text]) => {
        const page = Number(rawPage);
        if (!Number.isFinite(page)) return;
        nextPages[page] = mergeRecognizedPage(prevPages[page], {
          text,
          status: "done",
          sourceMode: "page_image",
        });
      });
      state.recognizedPages[fileId] = nextPages;
    }),
  setRecognizedPages: (fileId, pages) =>
    set((state) => {
      const prevPages = state.recognizedPages[fileId] ?? {};
      const nextPages: Record<number, RecognizedPage> = { ...prevPages };
      const prevTexts = state.pageOcrTexts[fileId] ?? {};
      const nextTexts: Record<number, string> = { ...prevTexts };

      Object.entries(pages).forEach(([rawPage, pageResult]) => {
        const page = Number(rawPage);
        if (!Number.isFinite(page)) return;
        nextPages[page] = mergeRecognizedPage(prevPages[page], pageResult);
        nextTexts[page] = pageResult.text;
      });

      state.recognizedPages[fileId] = nextPages;
      state.pageOcrTexts[fileId] = nextTexts;
    }),
  updateRecognizedPageText: (fileId, page, text) =>
    set((state) => {
      // A debounced editor write-back can fire after the file was removed
      // from the queue — don't resurrect state for it.
      if (!state.files.some((f) => f.id === fileId)) return;
      const prevTexts = state.pageOcrTexts[fileId] ?? {};
      state.pageOcrTexts[fileId] = { ...prevTexts, [page]: text };

      const prevPages = state.recognizedPages[fileId] ?? {};
      const prev = prevPages[page];
      state.recognizedPages[fileId] = {
        ...prevPages,
        [page]: prev
          ? { ...prev, text }
          : { text, status: "done", sourceMode: "page_image" },
      };
    }),
  updateLayoutBlockText: (fileId, page, blockIndex, text) =>
    set((state) => {
      // A debounced editor write-back can fire after the file was removed
      // from the queue — don't resurrect state for it.
      if (!state.files.some((f) => f.id === fileId)) return;
      const pageResult = state.recognizedPages[fileId]?.[page];
      const layout = pageResult?.layout;
      if (!layout || blockIndex < 0 || blockIndex >= layout.blocks.length) {
        return;
      }

      const block = layout.blocks[blockIndex];
      if (!block) return;
      const oldText = block.text;
      block.text = text;

      if (oldText.trim().length === 0) return;
      const pageText = pageResult.text;
      const index = pageText.indexOf(oldText);
      if (index === -1 || index !== pageText.lastIndexOf(oldText)) return;

      const nextPageText =
        pageText.slice(0, index) + text + pageText.slice(index + oldText.length);
      pageResult.text = nextPageText;
      const prevTexts = state.pageOcrTexts[fileId] ?? {};
      state.pageOcrTexts[fileId] = { ...prevTexts, [page]: nextPageText };
    }),
  updateArticleOcrText: (fileId, articleId, text) =>
    set((state) => {
      if (!state.files.some((f) => f.id === fileId)) return;
      const prev = state.articleOcrTexts[fileId] ?? {};
      state.articleOcrTexts[fileId] = { ...prev, [articleId]: text };
      const doc = state.documentStates[fileId];
      if (doc) rebuildDocumentResult(state, fileId, doc);
    }),
});

// Re-export so legacy types referenced by tests / callers still resolve.
export type { JobKind } from "@/lib/ipc-types";
