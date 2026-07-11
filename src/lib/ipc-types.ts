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
  ocr_prompt: string;
  paddle_url: string;
  paddle_model: string;
  paddle_document_options: PaddleDocumentOptions;
  openai_model: string;
  openrouter_model: string;
  openai_compatible_base_url: string;
  openai_compatible_model: string;
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

export type JobKind = "grouped_ocr" | "whole_file";

export interface JobListEntry {
  job_id: string;
  kind: JobKind;
}

export interface JobStarted {
  job_id: string;
}

export interface JobProgress {
  job_id: string;
  done: number;
  total: number;
  label: string;
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

/** Wire payload for `JOB_DONE`. The two shapes are disambiguated by the
 *  active job's `kind` snapshot — the wire payload itself does not carry a
 *  discriminator field, so callers must narrow via `activeJob.kind` before
 *  reading per-arm fields. */
export type JobDone = GroupedJobDone | WholeFileJobDone;

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
  JOB_PROGRESS: "xcvt://job/progress",
  JOB_DONE: "xcvt://job/done",
  JOB_ERROR: "xcvt://job/error",
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
