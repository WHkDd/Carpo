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

export interface RenderedPagePayload {
  width: number;
  height: number;
  png_base64: string;
  // Set by the frontend after decoding `png_base64` into a Blob and registering
  // it with the bitmap cache. Backend never sets this.
  objectUrl?: string;
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

export interface JobItemDone {
  job_id: string;
  file_id: string;
  page: number;
  label: string;
  text: string;
}

export interface JobItemError {
  job_id: string;
  file_id: string;
  page: number;
  label: string;
  error: string;
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

/** Whole-file-OCR job result. Used by `start_whole_file_ocr`. */
export interface WholeFileJobDone {
  job_id: string;
  results: WholeFileOcrResultEntry[];
  errors: WholeFileOcrErrorEntry[];
  cancelled: boolean;
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

export const EVENTS = {
  JOB_STARTED: "xcvt://job/started",
  JOB_PROGRESS: "xcvt://job/progress",
  JOB_ITEM_DONE: "xcvt://job/item-done",
  JOB_ITEM_ERROR: "xcvt://job/item-error",
  JOB_DONE: "xcvt://job/done",
  JOB_ERROR: "xcvt://job/error",
} as const;
