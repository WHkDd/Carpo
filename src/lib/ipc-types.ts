/**
 * IPC DTOs — kept in sync by hand with src-tauri/src DTOs until we adopt
 * specta or ts-rs. Anything sent across the Tauri boundary lives here.
 */

export type Provider = "paddleocr" | "openai" | "claude" | "openrouter";

export type OcrProfile = "standard" | "fast";

export type SecretKey =
  | "paddle_token"
  | "openai_key"
  | "claude_key"
  | "openrouter_key";

export interface NonSecretSettings {
  provider: Provider;
  ocr_profile: OcrProfile;
  ocr_prompt: string;
  paddle_url: string;
  openai_model: string;
  claude_model: string;
  openrouter_model: string;
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
}

export type FileKind = "image" | "pdf";

export interface FileEntry {
  id: string;
  path: string;
  name: string;
  ext: string;
  kind: FileKind;
  payload?: RenderedPagePayload;
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

export interface JobDone {
  job_id: string;
  results: Array<{ article_id: string; text: string }>;
  errors: Array<{ article_id: string; message: string }>;
}

export interface JobError {
  job_id: string;
  error: string;
}

export const EVENTS = {
  JOB_STARTED: "xcvt://job/started",
  JOB_PROGRESS: "xcvt://job/progress",
  JOB_ITEM_DONE: "xcvt://job/item-done",
  JOB_ITEM_ERROR: "xcvt://job/item-error",
  JOB_DONE: "xcvt://job/done",
  JOB_ERROR: "xcvt://job/error",
} as const;
