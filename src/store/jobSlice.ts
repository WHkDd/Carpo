import type { StateCreator } from "zustand";
import type { FileViewSlice } from "./fileViewSlice";
import type { QueueSlice } from "./queueSlice";
import type { PageStateSlice } from "./pageStateSlice";
import type { SelectionSlice } from "./selectionSlice";
import type { SettingsSlice } from "./settingsSlice";
import type { UiSlice } from "./uiSlice";
import type {
  JobDone,
  JobError,
  JobProgress,
} from "@/lib/ipc-types";

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
      job.done = p.done;
      job.total = p.total;
      job.label = p.label;
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
    }),
});

// Re-export so legacy types referenced by tests / callers still resolve.
export type { JobKind } from "@/lib/ipc-types";
