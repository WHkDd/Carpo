import type { Language } from "@/i18n";
import type { LayoutPage } from "./layout-document";

/**
 * IPC DTOs — kept in sync by hand with src-tauri/src DTOs until we adopt
 * specta or ts-rs. Anything sent across the Tauri boundary lives here.
 */

export type Provider =
  | "paddleocr"
  | "openai"
  | "openrouter"
  | "openai_compatible";

export type OcrProfile = "standard" | "fast";

export interface PaddleDocumentOptions {
  includeHeader: boolean;
  includeFooter: boolean;
  includePageNumber: boolean;
  includeAsideText: boolean;
  includeHeaderImage: boolean;
  includeFooterImage: boolean;
  includeFootnote: boolean;
  useDocOrientationClassify: boolean;
  useDocUnwarping: boolean;
  useLayoutDetection: boolean;
  useChartRecognition: boolean;
  useSealRecognition: boolean;
  useOcrForImageBlock: boolean;
  mergeTables: boolean;
  relevelTitles: boolean;
  layoutShapeMode: string;
  promptLabel: string;
  repetitionPenalty: number;
  temperature: number;
  topP: number;
  minPixels: number;
  maxPixels: number;
  layoutNms: boolean;
  restructurePages: boolean;
}

export type SecretKey =
  | "paddle_token"
  | "openai_key"
  | "openrouter_key"
  | "openai_compatible_key";

export interface NonSecretSettings {
  provider: Provider;
  ocr_profile: OcrProfile;
  /** UI language. Also sent to the backend so job progress and error
   *  messages come back in the same language as the interface.
   *  `null` means the user has never chosen one — the app then follows the
   *  system locale and saves that choice. */
  language: Language | null;
  ocr_prompt: string;
  paddle_url: string;
  paddle_model: string;
  paddle_document_options: PaddleDocumentOptions;
  openai_model: string;
  openrouter_model: string;
  openai_compatible_base_url: string;
  openai_compatible_model: string;
  /** Which provider runs the LLM proofread pass. `null` = follow the OCR
   *  provider. Mirrors `config::NonSecretSettings::proofread_provider`;
   *  older settings.json files parse to `null` via serde default. */
  proofread_provider: Provider | null;
  /** Model for the proofread pass. Empty = fall back to the resolved
   *  provider's OCR model (mirrors `resolve_proofread_model` in Rust). */
  proofread_model: string;
  /** System prompt for the proofread pass. Empty = built-in default at call
   *  time, in the active UI language (mirrors `resolve_proofread_prompt`).
   *  The frontend hydrates an empty value to the built-in default so the
   *  settings dialog never shows a blank prompt. */
  proofread_prompt: string;
}

export interface PdfInfo {
  page_count: number;
  title?: string;
}

export type RenderPurpose = "preview" | "ocr";

export interface RenderPagePayload {
  path: string;
  page: number;
  dpi: number;
  purpose: RenderPurpose;
}

/** Bitmap displayed by the canvas. The backend returns raw PNG bytes via
 *  `tauri::ipc::Response`; the frontend wraps them in a Blob and registers
 *  the object URL with the bitmap cache. `objectUrl` is always set — there
 *  is no base64 fallback. */
export interface RenderedPagePayload {
  width: number;
  height: number;
  objectUrl: string;
}

export type FileKind = "image" | "pdf";

export interface FileEntry {
  id: string;
  path: string;
  name: string;
  ext: string;
  kind: FileKind;
  pdfTotal?: number;
  currentPage?: number;
  payload?: RenderedPagePayload;
  // Page number that `payload` was rendered for. PDFs only; undefined for images.
  payloadPage?: number;
  /** Why this file has no `payload`. Set when the backend refused to decode it
   *  — a DNG with no usable embedded preview, a corrupt scan, a PDF PDFium
   *  won't open. The entry still joins the queue so the failure is visible and
   *  attributable instead of the file silently never appearing. Carries the
   *  backend's own message, which for DNG tells the user what to re-export. */
  loadError?: string;
}

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface ArticleRequest {
  id: string;
  title: string;
  num: number;
  blocks: Rect[];
}

/** Reference to a block, scoped to a specific page within a file. Mirrors
 *  `jobs::grouped::BlockRef` in Rust. `order` is 1-based to match the labels
 *  shown on the canvas. */
export interface BlockRef {
  page: number;
  block_id: string;
  rect: Rect;
  order: number;
}

/** File-scoped article: cross-page block list. Mirrors
 *  `jobs::grouped::ArticleOcrPlan` in Rust. */
export interface ArticleOcrPlan {
  id: string;
  title: string;
  num: number;
  blocks: BlockRef[];
}

/** Payload for `invoke("start_grouped_ocr", { req })`. Mirrors
 *  `jobs::grouped::GroupedOcrRequest` in Rust. */
export interface GroupedOcrRequest {
  file_id: string;
  path: string;
  kind: FileKind;
  /** DPI used to render the preview the user drew on. Ignored for images. */
  preview_dpi: number;
  /** Target DPI for the backend's OCR-grade re-render. */
  ocr_dpi: number;
  articles: ArticleOcrPlan[];
  newspaper_name: string;
  newspaper_date: string;
}

export type JobKind = "grouped_ocr" | "whole_file" | "proofread";

export interface JobListEntry {
  job_id: string;
  kind: JobKind;
}

export interface JobStarted {
  job_id: string;
}

/** Structured description of what a job is doing right now. The backend
 *  emits this alongside the (Chinese) `label` so the UI can render progress
 *  in whatever language the user picked instead of parsing prose. */
export type ProgressStage =
  | { kind: "preparing_blocks"; total: number }
  | { kind: "preparing_pages"; total: number }
  | { kind: "preparing_articles"; total: number }
  | { kind: "preparing_chunks"; total: number }
  | { kind: "submitting_document"; total: number }
  | { kind: "chunk_submitting"; chunk: number; chunks: number; pages: number }
  | {
      kind: "chunk_running";
      chunk: number;
      chunks: number;
      done: number;
      total: number;
    }
  | { kind: "document_running"; done: number; total: number }
  | { kind: "page_running"; page: number; total: number }
  | { kind: "page_done"; page: number; total: number }
  | { kind: "block_running"; article_num: number; index: number; count: number }
  | { kind: "block_done"; article_num: number; index: number; count: number }
  | { kind: "proofread_running"; index: number; count: number };

export interface JobProgress {
  job_id: string;
  done: number;
  total: number;
  label: string;
  /** Absent only when talking to a backend older than the i18n rollout, in
   *  which case the UI falls back to showing `label` verbatim. */
  stage?: ProgressStage;
  current_block?: number;
  article_total?: number;
}

export interface GroupedOcrResultEntry {
  article_id: string;
  text: string;
}
export interface GroupedOcrErrorEntry {
  article_id: string;
  message: string;
}
export interface WholeFileOcrResultEntry {
  page: number;
  text: string;
  layout?: LayoutPage;
  /** Set only when `WholeFileJobDone.source === "paddle_document_chunk"`.
   *  Identifies which chunk PDF this page came from — purely
   *  informational, since the UI keys everything off the original PDF's
   *  `page`. */
  chunk_id?: string;
  /** 1-based position of the page inside its chunk PDF. Same scope as
   *  `chunk_id`. */
  chunk_page?: number;
}
export interface WholeFileOcrErrorEntry {
  page: number;
  message: string;
}

/** Grouped-OCR job result. Used by `start_grouped_ocr`. */
export interface GroupedJobDone {
  job_id: string;
  results: GroupedOcrResultEntry[];
  errors: GroupedOcrErrorEntry[];
  cancelled: boolean;
}

/** Discriminator stamped onto whole-file `JOB_DONE` payloads by the runner.
 *  Mirrors `jobs::whole_file::DoneSource` in Rust. The frontend uses this to
 *  pick the `RecognizedPageSourceMode` when writing per-page results so the
 *  panel can later tell `paddle_document` runs apart from per-page PNG runs
 *  (e.g. for the layout-rebuilt PDF export). Older job payloads without the
 *  field are treated as `page_image`.
 *
 *  `paddle_document_chunk` is emitted when the Paddle PDF path had to
 *  split the source into smaller chunks (50 MB / 1000-page Paddle caps);
 *  the per-result `chunk_id` / `chunk_page` fields are populated only
 *  for that source, never for `page_image` or single-shot
 *  `paddle_document`. */
export type WholeFileDoneSource =
  | "page_image"
  | "paddle_document"
  | "paddle_document_chunk";

/** Whole-file-OCR job result. Used by `start_whole_file_ocr`. */
export interface WholeFileJobDone {
  job_id: string;
  results: WholeFileOcrResultEntry[];
  errors: WholeFileOcrErrorEntry[];
  cancelled: boolean;
  /** Optional for back-compat with older job payloads. */
  source?: WholeFileDoneSource;
}

/** Wire payload for `JOB_DONE`. The shapes are disambiguated by the
 *  active job's `kind` snapshot — the wire payload itself does not carry a
 *  discriminator field, so callers must narrow via `activeJob.kind` before
 *  reading per-arm fields. */
export type JobDone = GroupedJobDone | WholeFileJobDone | ProofreadJobDone;

// --- Proofread (LLM pass) ---------------------------------------------------

/** Mirrors `ocr::proofread::ProofreadCategory` in Rust. `semantic` is the
 *  category the review view defaults to rejecting: a historical transcript
 *  keeps its original wording. */
export type ProofreadCategory =
  | "punct"
  | "charform"
  | "garble"
  | "layout"
  | "semantic";

export interface ProofreadSuggestion {
  before: string;
  after: string;
  context_before: string;
  category: ProofreadCategory;
  confidence: number;
  reason: string;
}

/** One text unit to proofread. `key` is an opaque frontend-supplied id
 *  (`page:12` or `article:a_xxx`) echoed back verbatim. */
export interface ProofreadUnit {
  key: string;
  text: string;
  /** Scans of the original this text came from, as bare base64 JPEG (no
   *  `data:` prefix — the backend adds the wrapper, and refuses a payload
   *  that brings its own). One per page the unit occupies; empty only when
   *  capture failed, which sends the unit as text alone. */
  images?: string[];
}

/** Payload for `invoke("start_proofread", { req })`. */
export interface ProofreadRequest {
  file_id: string;
  units: ProofreadUnit[];
  /** Snapshot of the settings the user confirmed when the job started —
   *  the backend validates and runs exactly this view, so the timing of the
   *  settings write-back never changes which model actually runs. */
  provider?: Provider;
  model?: string;
  prompt?: string;
}

export interface ProofreadResultEntry {
  key: string;
  /** Only anchor-validated suggestions — the model's output has already
   *  been filtered by the backend. */
  suggestions: ProofreadSuggestion[];
  /** Suggestions the model sent but anchor validation dropped. */
  discarded: number;
  model: string;
}

export interface ProofreadErrorEntry {
  key: string;
  message: string;
}

/** Proofread job result. Used by `start_proofread`. */
export interface ProofreadJobDone {
  job_id: string;
  results: ProofreadResultEntry[];
  errors: ProofreadErrorEntry[];
  cancelled: boolean;
}

export interface JobError {
  job_id: string;
  error: string;
}

/** Payload for `invoke("start_whole_file_ocr", { req })`. */
export interface WholeFileOcrRequest {
  file_id: string;
  path: string;
  kind: FileKind;
  pages: number[];
  ocr_dpi: number;
  newspaper_name: string;
  newspaper_date: string;
}

/** Wire shape of a cached terminal job event, returned by
 *  `GET /api/jobs/:job_id/result`. Mirrors Rust `JobEvent` /
 *  `JobEventKind::as_sse_name`. Only `"done"` and `"error"` are ever cached
 *  (see `EventBus::recent`); `payload` is `JobDone` or `JobError`
 *  respectively — narrow on `kind` before reading it. */
export interface JobEventEnvelope {
  kind: "progress" | "done" | "error";
  payload: unknown;
}

export const EVENTS = {
  JOB_PROGRESS: "carpo://job/progress",
  JOB_DONE: "carpo://job/done",
  JOB_ERROR: "carpo://job/error",
} as const;

// --- AppError ---------------------------------------------------------------

export type AppErrorKind =
  | "Config"
  | "FileNotFound"
  | "Pdf"
  | "Image"
  | "Ocr"
  | "Network"
  | "Cancelled"
  /** Job admission refused because the process is already at
   *  `MAX_ACTIVE_JOBS` (HTTP 429 on the web runtime). The UI keeps its own
   *  gate in front of this (`selectJobStartBlocked`), so it surfaces through
   *  the ordinary error line rather than needing its own treatment. */
  | "Busy"
  | "Internal";

/** Wire shape mirroring Rust `AppError` (`#[serde(tag = "kind", content =
 *  "data")]`). `data` is a string for every variant except `Ocr`, which
 *  carries structured fields. */
export type AppErrorPayload =
  | { kind: Exclude<AppErrorKind, "Ocr">; data: string }
  | {
      kind: "Ocr";
      data: { provider: string; message: string; retryable: boolean };
    };

export interface ParsedAppError {
  kind: AppErrorKind;
  message: string;
  retryable: boolean;
  provider?: string;
}

/** Wraps a JSON `AppErrorPayload` body from a failed `fetch()` (web/Docker
 *  runtime) so callers always get a real `Error` to throw/catch — a bare
 *  `{kind, data}` object satisfies `parseAppError`'s duck-typed branch below
 *  but fails `instanceof Error` checks anywhere else in the call chain.
 *  `parseAppError` unwraps `.payload` back to the structured shape, so
 *  nothing downstream needs to know this wrapper exists. */
export class HttpAppError extends Error {
  payload: unknown;
  constructor(payload: unknown) {
    super(typeof payload === "string" ? payload : JSON.stringify(payload));
    this.name = "HttpAppError";
    this.payload = payload;
  }
}

/** Normalises whatever an `invoke()` rejection (or generic JS error) handed us
 *  back into a single, ergonomic shape. The Tauri 2 IPC bridge delivers
 *  AppError as a structured `{kind, data}` object; older code paths may pass
 *  a string or an `Error`. */
export function parseAppError(value: unknown): ParsedAppError {
  if (value instanceof HttpAppError) {
    return parseAppError(value.payload);
  }
  if (value && typeof value === "object" && "kind" in value) {
    const p = value as AppErrorPayload;
    if (p.kind === "Ocr" && typeof p.data === "object" && p.data !== null) {
      return {
        kind: "Ocr",
        message: p.data.message,
        retryable: !!p.data.retryable,
        provider: p.data.provider,
      };
    }
    if (typeof (p as { data?: unknown }).data === "string") {
      return {
        kind: p.kind,
        message: (p as { data: string }).data,
        retryable: p.kind === "Network",
      };
    }
  }
  if (value instanceof Error) {
    return { kind: "Internal", message: value.message, retryable: false };
  }
  if (typeof value === "string") {
    return { kind: "Internal", message: value, retryable: false };
  }
  return { kind: "Internal", message: String(value), retryable: false };
}

/** Convenience wrapper for `setError(parseAppError(e).message)` style call
 *  sites. */
export function appErrorMessage(value: unknown): string {
  return parseAppError(value).message;
}
