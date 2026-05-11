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
  JobKind,
  JobProgress,
} from "@/lib/ipc-types";

export type JobStatus =
  | "running"
  | "cancelling"
  | "done"
  | "error"
  | "cancelled";

export interface ActiveJob {
  jobId: string;
  kind: JobKind;
  status: JobStatus;
  done: number;
  total: number;
  label: string;
  /** Set when status is "error". */
  error?: string;
  /** Captured on `done` so the result drawer (T5.7) can consume it. */
  result?: JobDone;
  /** Snapshot of which file + articles were submitted. Captured at startJob
   *  time so the document can be assembled even if the user edits the
   *  underlying state mid-OCR. */
  fileId: string;
  newspaperName: string;
  newspaperDate: string;
  requestedArticles: Array<{ id: string; title: string }>;
}

export interface JobSlice {
  activeJob: ActiveJob | null;
  /** Map of fileId → last-assembled document. Populated on a non-cancelled
   *  successful finish; T5.7 ResultDrawer renders against this. */
  documentResults: Record<string, string>;
  resultDrawerOpen: boolean;
  /** Called immediately after `startGroupedOcr` returns the job id. The first
   *  `JobProgress` event will fill in `total`; until then we show 0/0. */
  startJob: (info: {
    jobId: string;
    kind: JobKind;
    fileId: string;
    newspaperName: string;
    newspaperDate: string;
    requestedArticles: Array<{ id: string; title: string }>;
    label?: string;
  }) => void;
  applyProgress: (p: JobProgress) => void;
  markCancelling: () => void;
  applyJobDone: (d: JobDone) => void;
  applyJobError: (e: JobError) => void;
  /** Dismiss the dialog. Only allowed in a terminal status — guards against
   *  closing a still-running job. */
  clearActiveJob: () => void;
  setDocumentResult: (fileId: string, document: string) => void;
  openResultDrawer: () => void;
  closeResultDrawer: () => void;
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
  resultDrawerOpen: false,
  startJob: ({
    jobId,
    kind,
    fileId,
    newspaperName,
    newspaperDate,
    requestedArticles,
    label,
  }) =>
    set((state) => {
      state.activeJob = {
        jobId,
        kind,
        status: "running",
        done: 0,
        total: 0,
        label: label ?? "准备中…",
        fileId,
        newspaperName,
        newspaperDate,
        requestedArticles: requestedArticles.map((a) => ({ ...a })),
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
  openResultDrawer: () =>
    set((state) => {
      state.resultDrawerOpen = true;
    }),
  closeResultDrawer: () =>
    set((state) => {
      state.resultDrawerOpen = false;
    }),
});
