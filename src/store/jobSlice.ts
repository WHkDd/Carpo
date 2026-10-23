import type { StateCreator } from "zustand";
import type { FileViewSlice } from "./fileViewSlice";
import type { QueueSlice } from "./queueSlice";
import { rebuildDocumentResult, type PageStateSlice } from "./pageStateSlice";
import type { SelectionSlice } from "./selectionSlice";
import type { SettingsSlice } from "./settingsSlice";
import type { UiSlice } from "./uiSlice";
import type {
  GroupedJobDone,
  JobDone,
  JobError,
  JobProgress,
  ProgressStage,
  ProofreadCategory,
  ProofreadUnit,
  WholeFileJobDone,
} from "@/lib/ipc-types";
import { t } from "@/i18n";
import { assembleDocument } from "@/lib/format-doc";
import { clearPendingJob, savePendingJob } from "@/lib/job-persistence";
import type { LayoutPage } from "@/lib/layout-document";
import {
  applySuggestions,
  type ApplySuggestionsResult,
  type ProofreadReview,
  type ProofreadTarget,
  type SuggestionVerdict,
} from "@/lib/proofread";

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
  /** Raw backend label. Only rendered when `stage` is missing (an older
   *  backend); otherwise the UI formats `stage` in the active language. */
  label: string;
  stage: ProgressStage | null;
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

/** `region` is `articleRegionKey` of the blocks sent — recorded with the
 *  result so a later batch can tell when the boxes moved since. */
export type RequestedArticle = { id: string; title: string; region?: string };

export interface GroupedActiveJob extends BaseActiveJob {
  kind: "grouped_ocr";
  requestedArticles: RequestedArticle[];
}

export interface WholeFileActiveJob extends BaseActiveJob {
  kind: "whole_file";
  requestedPages: number[];
}

export interface ProofreadActiveJob extends BaseActiveJob {
  kind: "proofread";
  /** The exact units submitted, in submission order. The done handler
   *  rebuilds each review's `baseText` from this — the text may have been
   *  edited during the run, and a review must diff against what the model
   *  actually saw. */
  units: ProofreadUnit[];
}

export type ActiveJob = GroupedActiveJob | WholeFileActiveJob | ProofreadActiveJob;

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
  /** True when the user edited the page-level OCR source directly. In that
   *  case block-level layout text may be stale, so reading exports should
   *  prefer the page text for this page. */
  textEdited?: boolean;
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
  // `next` only carries `layout` / `chunkId` / `chunkPage` when its own
  // pipeline produced them (see AppShell's conditional spread from
  // `WholeFileJobDone`). A `{ ...prev, ...next }` merge would otherwise let
  // a prior paddle_document run's layout survive underneath a fresh
  // page_image (or any other-mode) result, pairing new text with stale
  // layout metadata that no longer describes it. Once the source mode
  // changes, the old pipeline's page-shape fields are meaningless — drop
  // them before merging.
  const base = prev && (prev.sourceMode !== next.sourceMode || next.status === "failed")
    ? { ...prev, layout: undefined, chunkId: undefined, chunkPage: undefined }
    : prev;
  const merged = { ...base, ...next };
  if (merged.status !== "failed") {
    delete merged.error;
  }
  if (!next.textEdited) {
    delete merged.textEdited;
  }
  return merged;
}

/** Re-states a backend stage in terms of the pages the *user* asked for.
 *  A Paddle document job counts the pages it submitted (a chunk, or the whole
 *  PDF), which can be larger than the requested sub-range; showing that raw
 *  would make the pill claim more pages than the user picked. */
function normalizeStage(
  stage: ProgressStage,
  total: number,
  done: number
): ProgressStage {
  switch (stage.kind) {
    case "preparing_blocks":
    case "preparing_pages":
    case "preparing_articles":
    case "preparing_chunks":
    case "submitting_document":
      return { ...stage, total };
    case "document_running":
      return { ...stage, done, total };
    case "page_running":
    case "page_done":
      return {
        ...stage,
        page: Math.min(Math.max(1, stage.page), total),
        total,
      };
    default:
      return stage;
  }
}

function normalizeWholeFileProgress(
  job: WholeFileActiveJob,
  progress: JobProgress
): Pick<JobProgress, "done" | "total" | "label" | "stage"> {
  const requestedTotal = job.requestedPages.length;
  if (requestedTotal === 0) {
    return {
      done: progress.done,
      total: progress.total,
      label: progress.label,
      ...(progress.stage ? { stage: progress.stage } : {}),
    };
  }

  const total = requestedTotal;
  const done = Math.min(Math.max(0, progress.done), total);

  return {
    done,
    total,
    label: progress.label,
    ...(progress.stage
      ? { stage: normalizeStage(progress.stage, total, done) }
      : {}),
  };
}

export type StartJobInfo =
  | {
      jobId: string;
      kind: "grouped_ocr";
      fileId: string;
      newspaperName: string;
      newspaperDate: string;
      requestedArticles: RequestedArticle[];
      stage?: ProgressStage;
    }
  | {
      jobId: string;
      kind: "whole_file";
      fileId: string;
      newspaperName: string;
      newspaperDate: string;
      requestedPages: number[];
      stage?: ProgressStage;
    }
  | {
      jobId: string;
      kind: "proofread";
      fileId: string;
      newspaperName: string;
      newspaperDate: string;
      units: ProofreadUnit[];
      stage?: ProgressStage;
    };

export type BatchExportLayout = "separate" | "merged" | "by_tag";
export type BatchExportFormat = "docx" | "md";
export type BatchFileMode = "grouped" | "whole_file";
export type BatchItemStatus = "pending" | "running" | "done" | "failed" | "skipped";

export interface BatchExportItem {
  fileId: string;
  name: string;
  /** Decided once at batch start: articles with blocks → grouped, else
   *  whole-file. */
  mode: BatchFileMode;
  /** Articles (grouped) or pages (whole-file) in the file's plan. */
  unitCount: number;
  status: BatchItemStatus;
  /** Progress of this file's OCR job. Stays 0/0 when every unit already had
   *  a result and no job was started. */
  done: number;
  total: number;
  /** Units whose OCR returned an error; the export still includes their
   *  failure marker. */
  failedUnits: number;
  error?: string;
}

/** Background batch OCR + export. Runs beside — never inside — `activeJob`,
 *  so the foreground entry points stay usable while it works through its
 *  queue. The runner lives in `src/lib/batch-export.ts`; this is only its
 *  observable state. In-memory only: quitting the app stops the batch. */
export interface BatchExportState {
  status: "running" | "cancelling" | "done" | "cancelled";
  layout: BatchExportLayout;
  format: BatchExportFormat;
  items: BatchExportItem[];
  /** Index of the file being processed, or null between files. */
  currentIndex: number | null;
  currentJobId: string | null;
  /** Directory (separate / by_tag) or file path (merged). Empty for
   *  browser downloads. */
  target: string;
  /** Batch-level failure, e.g. the merged file could not be written. */
  error?: string;
}

/** File the background batch is working on right now, or null. The
 *  foreground entry points refuse that one file so the two writers cannot
 *  overwrite each other's results. */
export function batchBusyFileId(
  s: Partial<Pick<JobSlice, "batchExport">>
): string | null {
  const batch = s.batchExport;
  if (!batch || (batch.status !== "running" && batch.status !== "cancelling")) {
    return null;
  }
  if (batch.currentIndex === null) return null;
  return batch.items[batch.currentIndex]?.fileId ?? null;
}

let jobStartOwnerSeq = 0;

export interface JobSlice {
  activeJob: ActiveJob | null;
  /** Owner id of the start attempt currently holding the single job slot, or
   *  null when the slot is free.
   *
   *  `activeJob` alone cannot guard the slot: it is only written once the
   *  start RPC *returns*, so for one IPC / network round trip every entry
   *  point still sees `activeJob === null` and happily starts a second job —
   *  which then overwrites the first, orphaning a job that keeps running,
   *  keeps spending API quota, and can no longer be cancelled. The three
   *  triggers (proofread / whole-file / grouped) each own a local `starting`
   *  flag that the other two cannot see, so the claim has to live here. */
  jobStartClaim: string | null;
  /** File the current claim is for — the current file at claim time, which
   *  is what every foreground entry point acts on. Recorded because the user
   *  can switch files while the start RPC is in flight; the batch runner
   *  must keep away from the claimed file, not the one now on screen. */
  jobStartClaimFileId: string | null;
  /** Takes the job slot, synchronously, and returns the owner token that
   *  `releaseJobStart` needs — or null when a job is running or another
   *  attempt already holds the slot. The test-and-set happens inside one
   *  `set()`; split across two, the claim would just be a second race.
   *
   *  The token is minted here rather than passed in so no caller can hand in
   *  a value another caller is already using. Every caller must pair this
   *  with `releaseJobStart` in a `finally` that covers *every* early return:
   *  a leaked claim locks all three entry points with no UI to unlock them. */
  claimJobStart: (kind: string) => string | null;
  /** Frees the slot, but only if `owner` still holds it — so a late release
   *  from an abandoned attempt cannot clear a newer one's claim. Idempotent. */
  releaseJobStart: (owner: string) => void;
  /** Map of fileId → last-assembled document. Re-built on every grouped-OCR
   *  finish from the merged per-article texts, so partial OCR runs keep the
   *  assembled output coherent with the current article order. */
  documentResults: Record<string, string>;
  /** fileId → articleId → raw OCR text. Merged across runs so a partial
   *  re-OCR doesn't wipe results for articles outside the new selection.
   *  Cleared when the file is removed from the queue. */
  articleOcrTexts: Record<string, Record<string, string>>;
  /** fileId → articleId → `articleRegionKey` of the blocks the article's
   *  current OCR text was recognized from. A mismatch means the boxes were
   *  edited afterwards and the text no longer describes them. */
  articleOcrRegions: Record<string, Record<string, string>>;
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
  /** fileId → proofread target key (`page:12` / `article:a_xxx`) → review.
   *  Session-scoped like `recognizedPages` itself — a review never outlives
   *  the text it was diffed against. */
  proofreadReviews: Record<string, Record<string, ProofreadReview>>;
  /** Merge finished job results into the review map. Reviews for the same
   *  key are replaced — a re-run supersedes the previous verdicts. */
  setProofreadReviews: (
    fileId: string,
    reviews: Record<string, ProofreadReview>
  ) => void;
  /** One suggestion's verdict. `editedAfter` only applies to `edited`. */
  setProofreadSuggestionVerdict: (
    fileId: string,
    key: string,
    index: number,
    verdict: SuggestionVerdict,
    editedAfter?: string
  ) => void;
  /** Bulk verdict flip for one category, driven by the category chips. */
  setProofreadCategoryVerdict: (
    fileId: string,
    key: string,
    category: ProofreadCategory,
    verdict: SuggestionVerdict
  ) => void;
  /** Writes accepted / edited suggestions into the underlying text and marks
   *  the review `applied`. Refuses (returns false) when the review is
   *  missing, already applied, or stale — the live text no longer equals
   *  `baseText` — because silently applying would overwrite the user's
   *  manual edits. The caller's stale banner is the only legal path from
   *  there. */
  applyProofreadReview: (fileId: string, key: string) => boolean;
  /** Rolls an applied review back to `baseText` and re-opens it for review.
   *  Refuses when the text changed after the apply — undoing would destroy
   *  edits the user made on top of the applied text. */
  undoProofreadReview: (fileId: string, key: string) => boolean;
  /** Drops a review without touching the text. */
  discardProofreadReview: (fileId: string, key: string) => void;
  /** Writes a finished grouped-OCR payload back into the file: per-article
   *  texts (failure markers for errored ones), then the re-assembled
   *  document. Shared by the foreground job handler and the batch runner. */
  writeGroupedJobResults: (
    fileId: string,
    requested: RequestedArticle[],
    payload: GroupedJobDone,
    newspaperName: string,
    newspaperDate: string
  ) => void;
  /** Writes a finished whole-file payload back as normalized page results.
   *  Pages that came back without a result are recorded as failed. */
  writeWholeFileJobResults: (
    fileId: string,
    jobId: string,
    requestedPages: number[],
    payload: WholeFileJobDone
  ) => void;
  batchExport: BatchExportState | null;
  setBatchExport: (next: BatchExportState | null) => void;
  /** Mutates the running batch in place; no-op when there is none. */
  updateBatchExport: (fn: (draft: BatchExportState) => void) => void;
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

/** Whether starting a job would be refused right now — a job is running or
 *  cancelling, or another entry point is mid-start. The single source of
 *  truth for every trigger's `disabled`, so the three entry points cannot
 *  drift apart again. */
export const selectJobStartBlocked = (
  s: Pick<JobSlice, "activeJob" | "jobStartClaim"> &
    Partial<Pick<JobSlice, "batchExport">> & { currentFileId?: string | null }
): boolean =>
  s.jobStartClaim !== null ||
  (s.activeJob !== null &&
    (s.activeJob.status === "running" || s.activeJob.status === "cancelling")) ||
  (!!s.currentFileId && batchBusyFileId(s) === s.currentFileId);

/** Reads the live text a review target points at, or `null` when the target
 *  no longer exists. Exported for the review panel's stale check. */
export function proofreadTargetText(
  state: Pick<
    JobSlice,
    "recognizedPages" | "pageOcrTexts" | "articleOcrTexts"
  >,
  fileId: string,
  target: ProofreadTarget
): string | null {
  if (target.mode === "whole_file") {
    const page = state.recognizedPages[fileId]?.[target.page];
    if (page) return page.text;
    return state.pageOcrTexts[fileId]?.[target.page] ?? null;
  }
  return state.articleOcrTexts[fileId]?.[target.articleId] ?? null;
}

/** The text a review would write if applied right now, plus how many
 *  suggestions the overlap model had to skip (visible to the user after
 *  applying — a skipped correction must never be silent). */
function reviewOutput(review: ProofreadReview): ApplySuggestionsResult {
  return applySuggestions(review.baseText, review.suggestions);
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
> = (set, get) => ({
  activeJob: null,
  jobStartClaim: null,
  jobStartClaimFileId: null,
  batchExport: null,
  documentResults: {},
  articleOcrTexts: {},
  articleOcrRegions: {},
  pageOcrTexts: {},
  recognizedPages: {},
  proofreadReviews: {},
  claimJobStart: (kind) => {
    jobStartOwnerSeq += 1;
    const owner = `${kind}:${jobStartOwnerSeq}`;
    let granted = false;
    set((state) => {
      if (state.jobStartClaim !== null) return;
      const job = state.activeJob;
      if (job && (job.status === "running" || job.status === "cancelling")) {
        return;
      }
      // Every foreground entry point acts on the current file.
      if (state.currentFileId && batchBusyFileId(state) === state.currentFileId) {
        return;
      }
      state.jobStartClaim = owner;
      state.jobStartClaimFileId = state.currentFileId;
      granted = true;
    });
    return granted ? owner : null;
  },
  releaseJobStart: (owner) =>
    set((state) => {
      if (state.jobStartClaim !== owner) return;
      state.jobStartClaim = null;
      state.jobStartClaimFileId = null;
    }),
  startJob: (info) =>
    set((state) => {
      savePendingJob(info);
      // Hand the slot from the claim to the job in one update: any gap here
      // is a window where both are empty and a second start slips through.
      state.jobStartClaim = null;
      state.jobStartClaimFileId = null;
      const base: BaseActiveJob = {
        jobId: info.jobId,
        status: "running",
        done: 0,
        total: 0,
        label: "",
        stage: info.stage ?? null,
        fileId: info.fileId,
        newspaperName: info.newspaperName,
        newspaperDate: info.newspaperDate,
      };
      if (info.kind === "grouped_ocr") {
        state.activeJob = {
          ...base,
          kind: "grouped_ocr",
          requestedArticles: info.requestedArticles.map((a) => ({ ...a })),
        };
      } else if (info.kind === "proofread") {
        state.activeJob = {
          ...base,
          kind: "proofread",
          units: info.units.map((u) => ({ ...u })),
        };
      } else {
        state.activeJob = {
          ...base,
          kind: "whole_file",
          requestedPages: [...info.requestedPages],
        };
      }
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
      job.stage = progress.stage ?? null;
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
      clearPendingJob();
    }),
  applyJobError: (e) =>
    set((state) => {
      const job = state.activeJob;
      if (!job || job.jobId !== e.job_id) return;
      job.status = "error";
      job.error = e.error;
      clearPendingJob();
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
          ? { ...prev, text, textEdited: true }
          : { text, status: "done", sourceMode: "page_image", textEdited: true },
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
  setProofreadReviews: (fileId, reviews) =>
    set((state) => {
      if (!state.files.some((f) => f.id === fileId)) return;
      const prev = state.proofreadReviews[fileId] ?? {};
      state.proofreadReviews[fileId] = { ...prev, ...reviews };
    }),
  setProofreadSuggestionVerdict: (fileId, key, index, verdict, editedAfter) =>
    set((state) => {
      const suggestion = state.proofreadReviews[fileId]?.[key]?.suggestions[
        index
      ];
      if (!suggestion) return;
      suggestion.verdict = verdict;
      if (verdict === "edited") {
        suggestion.editedAfter = editedAfter ?? "";
      } else {
        delete suggestion.editedAfter;
      }
    }),
  setProofreadCategoryVerdict: (fileId, key, category, verdict) =>
    set((state) => {
      const review = state.proofreadReviews[fileId]?.[key];
      if (!review) return;
      for (const suggestion of review.suggestions) {
        if (suggestion.category === category) {
          suggestion.verdict = verdict;
          if (verdict !== "edited") delete suggestion.editedAfter;
        }
      }
    }),
  applyProofreadReview: (fileId, key) => {
    const state = get();
    const review = state.proofreadReviews[fileId]?.[key];
    if (!review || review.status === "applied") return false;
    const current = proofreadTargetText(state, fileId, review.target);
    if (current === null || current !== review.baseText) return false;
    const result = reviewOutput(review);
    const nextText = result.text;
    if (review.target.mode === "whole_file") {
      get().updateRecognizedPageText(fileId, review.target.page, nextText);
    } else {
      get().updateArticleOcrText(fileId, review.target.articleId, nextText);
    }
    set((s) => {
      const r = s.proofreadReviews[fileId]?.[key];
      if (!r) return;
      r.status = "applied";
      r.appliedText = nextText;
      r.appliedConflictSkipped = result.conflictSkipped;
    });
    return true;
  },
  undoProofreadReview: (fileId, key) => {
    const state = get();
    const review = state.proofreadReviews[fileId]?.[key];
    if (!review || review.status !== "applied") return false;
    const current = proofreadTargetText(state, fileId, review.target);
    if (review.appliedText !== undefined && current !== review.appliedText) {
      return false;
    }
    if (review.target.mode === "whole_file") {
      get().updateRecognizedPageText(fileId, review.target.page, review.baseText);
    } else {
      get().updateArticleOcrText(fileId, review.target.articleId, review.baseText);
    }
    set((s) => {
      const r = s.proofreadReviews[fileId]?.[key];
      if (!r) return;
      r.status = "pending";
      delete r.appliedText;
      delete r.appliedConflictSkipped;
    });
    return true;
  },
  discardProofreadReview: (fileId, key) =>
    set((state) => {
      const byFile = state.proofreadReviews[fileId];
      if (!byFile) return;
      delete byFile[key];
      if (Object.keys(byFile).length === 0) {
        delete state.proofreadReviews[fileId];
      }
    }),
  writeGroupedJobResults: (
    fileId,
    requested,
    payload,
    newspaperName,
    newspaperDate
  ) => {
    const requestedArticleIds = requested.map((a) => a.id);
    // Build a per-article text map for the articles that were part of
    // *this* run. Errored articles get a sentinel so the slot exists and the
    // user sees an explicit failure marker.
    const errorById = new Map(
      payload.errors.map((er) => [er.article_id, er.message])
    );
    const resultById = new Map(
      payload.results.map((r) => [r.article_id, r.text])
    );
    const perArticle: Record<string, string> = {};
    for (const id of requestedArticleIds) {
      const text = resultById.get(id);
      const errMsg = errorById.get(id);
      perArticle[id] = text !== undefined
        ? text
        : errMsg
          ? t("job.recognizeFailed", { message: errMsg })
          : t("job.notRecognized");
    }
    // Merge into the per-file map first, then re-assemble the full document
    // from *every* article that has text — including ones OCR'd in prior
    // partial runs. The article order follows the current document state so
    // re-ordering after OCR is honored.
    get().setArticleOcrTexts(fileId, perArticle);
    set((state) => {
      const regions = { ...(state.articleOcrRegions[fileId] ?? {}) };
      for (const a of requested) {
        // A failure marker describes no region; it is retried regardless.
        if (resultById.has(a.id) && a.region !== undefined) regions[a.id] = a.region;
        else delete regions[a.id];
      }
      state.articleOcrRegions[fileId] = regions;
    });
    const doc = get().getDocumentState(fileId);
    const merged = get().articleOcrTexts[fileId] ?? {};
    const ordered = doc.articles
      .map((a) => ({ id: a.id, title: a.title, text: merged[a.id] ?? "" }))
      .filter((a) => a.text.length > 0);
    get().setDocumentResult(
      fileId,
      assembleDocument({ newspaperName, newspaperDate, articles: ordered })
    );
  },
  writeWholeFileJobResults: (fileId, jobId, requestedPages, payload) => {
    // Zip requestedPages with results/errors, then write normalized page
    // results while keeping legacy page text in sync for older consumers.
    const sourceMode: RecognizedPageSourceMode =
      payload.source === "paddle_document_chunk"
        ? "paddle_document_chunk"
        : payload.source === "paddle_document"
          ? "paddle_document"
          : "page_image";
    const errorByPage = new Map(
      payload.errors.map((er) => [er.page, er.message])
    );
    const resultByPage = new Map(payload.results.map((r) => [r.page, r]));
    const perPage: Record<number, RecognizedPage> = {};
    for (const page of requestedPages) {
      const row = resultByPage.get(page);
      const errMsg = errorByPage.get(page);
      perPage[page] =
        row !== undefined
          ? {
              text: row.text,
              status: "done",
              sourceMode,
              sourceJobId: jobId,
              ...(row.layout !== undefined ? { layout: row.layout } : {}),
              ...(row.chunk_id !== undefined ? { chunkId: row.chunk_id } : {}),
              ...(row.chunk_page !== undefined
                ? { chunkPage: row.chunk_page }
                : {}),
            }
          : {
              text:
                errMsg !== undefined
                  ? t("job.recognizeFailed", { message: errMsg })
                  : t("job.notRecognized"),
              status: "failed",
              error: errMsg ?? t("job.noResultReturned"),
              sourceMode,
              sourceJobId: jobId,
            };
    }
    get().setRecognizedPages(fileId, perPage);
  },
  setBatchExport: (next) =>
    set((state) => {
      state.batchExport = next;
    }),
  updateBatchExport: (fn) =>
    set((state) => {
      if (state.batchExport) fn(state.batchExport);
    }),
});

// Re-export so legacy types referenced by tests / callers still resolve.
export type { JobKind } from "@/lib/ipc-types";
