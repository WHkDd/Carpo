import { invoke } from "@tauri-apps/api/core";
import { t } from "@/i18n";
import { isTauriRuntime } from "./runtime";
import { HttpAppError } from "./ipc-types";
import type {
  GroupedOcrRequest,
  JobEventEnvelope,
  JobListEntry,
  JobStarted,
  NonSecretSettings,
  PdfInfo,
  ProofreadRequest,
  RenderPagePayload,
  SecretKey,
  WholeFileOcrRequest,
} from "./ipc-types";
import type {
  LayoutPdfExportRequest,
  LayoutPdfExportResult,
  PaddleJsonImport,
  PaddleJsonPreflightReport,
  ReadingMarkdownExportResult,
} from "./layout-document";

/**
 * Typed wrappers around invoke<>(). One thin function per command keeps the
 * tauri::command surface explicit — when a backend signature changes, TypeScript
 * compilation breaks loudly here rather than at every call site.
 */

export async function ping(): Promise<string> {
  if (!isTauriRuntime()) return httpText("/healthz");
  return invoke<string>("ping");
}

export interface FetchedBitmap {
  width: number;
  height: number;
  blob: Blob;
}

/** Decodes the binary wire format used by `render_page` and
 *  `load_raster_image`: 4 bytes width (LE u32) + 4 bytes height (LE u32) +
 *  JPEG bytes. The backend used to send PNG and switched to JPEG for the
 *  preview path (see `encode_preview_jpeg`); the OCR pipeline still works
 *  with the original file directly. Returns a Blob the caller can pass to
 *  `URL.createObjectURL`. */
function unpackPageBytes(buffer: ArrayBuffer): FetchedBitmap {
  if (buffer.byteLength < 8) {
    throw new Error("renderPage response too short");
  }
  const view = new DataView(buffer);
  const width = view.getUint32(0, true);
  const height = view.getUint32(4, true);
  const imageBytes = new Uint8Array(buffer, 8);
  return {
    width,
    height,
    blob: new Blob([imageBytes], { type: "image/jpeg" }),
  };
}

export async function loadRasterImage(path: string): Promise<FetchedBitmap> {
  if (!isTauriRuntime()) {
    return unpackPageBytes(await httpArrayBuffer(`/api/files/${path}/raster`));
  }
  const buffer = await invoke<ArrayBuffer>("load_raster_image", { path });
  return unpackPageBytes(buffer);
}

export async function listSupportedExtensions(): Promise<string[]> {
  if (!isTauriRuntime()) {
    return ["png", "jpg", "jpeg", "tif", "tiff", "bmp", "pdf"];
  }
  return invoke<string[]>("list_supported_extensions");
}

export interface ClipboardImageImport {
  path: string;
  name: string;
}

/** Writes the system clipboard's image to a PNG under the app cache dir and
 *  returns its path, or `null` when the clipboard holds no image. Desktop
 *  only — the browser build has no equivalent file to hand the OCR pipeline,
 *  so it reports "nothing to paste" rather than half-supporting the gesture. */
export async function importClipboardImage(): Promise<ClipboardImageImport | null> {
  if (!isTauriRuntime()) return null;
  return invoke<ClipboardImageImport | null>("import_clipboard_image");
}

export async function getPdfInfo(path: string): Promise<PdfInfo> {
  if (!isTauriRuntime()) {
    return httpJson<PdfInfo>(`/api/files/${path}/pdf-info`);
  }
  return invoke<PdfInfo>("get_pdf_info", { path });
}

export async function renderPage(
  payload: RenderPagePayload
): Promise<FetchedBitmap> {
  if (!isTauriRuntime()) {
    const params = new URLSearchParams({
      dpi: String(payload.dpi),
      purpose: payload.purpose,
    });
    return unpackPageBytes(
      await httpArrayBuffer(
        `/api/files/${payload.path}/pages/${payload.page}?${params}`
      )
    );
  }
  const buffer = await invoke<ArrayBuffer>("render_page", {
    path: payload.path,
    page: payload.page,
    dpi: payload.dpi,
    purpose: payload.purpose,
  });
  return unpackPageBytes(buffer);
}

export async function getSettings(): Promise<NonSecretSettings> {
  if (!isTauriRuntime()) return httpJson<NonSecretSettings>("/api/settings");
  return invoke<NonSecretSettings>("get_settings");
}

export async function setSettings(s: NonSecretSettings): Promise<void> {
  if (!isTauriRuntime()) {
    await httpJson<NonSecretSettings>("/api/settings", {
      method: "PUT",
      body: JSON.stringify(s),
    });
    return;
  }
  return invoke("set_settings", { s });
}

export async function getSecret(key: SecretKey): Promise<boolean> {
  if (!isTauriRuntime()) {
    const status = await getKeyStatus();
    return status[key] ?? false;
  }
  return invoke<boolean>("get_secret", { key });
}

export async function setSecret(key: SecretKey, value: string): Promise<void> {
  if (!isTauriRuntime()) {
    await httpJson<KeyStatus>("/api/settings/secrets", {
      method: "PUT",
      body: JSON.stringify({ key, value }),
    });
    return;
  }
  return invoke("set_secret", { key, value });
}

export async function deleteSecret(key: SecretKey): Promise<void> {
  if (!isTauriRuntime()) {
    await httpJson<KeyStatus>(`/api/settings/secrets/${key}`, {
      method: "DELETE",
    });
    return;
  }
  return invoke("delete_secret", { key });
}

export async function startGroupedOcr(
  req: GroupedOcrRequest
): Promise<JobStarted> {
  if (!isTauriRuntime()) {
    return httpJson<JobStarted>("/api/ocr/grouped", {
      method: "POST",
      body: JSON.stringify({
        file_id: req.file_id,
        preview_dpi: req.preview_dpi,
        ocr_dpi: req.ocr_dpi,
        articles: req.articles,
        newspaper_name: req.newspaper_name,
        newspaper_date: req.newspaper_date,
      }),
    });
  }
  return invoke<JobStarted>("start_grouped_ocr", { req });
}

export async function startWholeFileOcr(
  req: WholeFileOcrRequest
): Promise<JobStarted> {
  if (!isTauriRuntime()) {
    return httpJson<JobStarted>("/api/ocr/whole-file", {
      method: "POST",
      body: JSON.stringify({
        file_id: req.file_id,
        pages: req.pages,
        ocr_dpi: req.ocr_dpi,
        newspaper_name: req.newspaper_name,
        newspaper_date: req.newspaper_date,
      }),
    });
  }
  return invoke<JobStarted>("start_whole_file_ocr", { req });
}

export async function startProofread(
  req: ProofreadRequest
): Promise<JobStarted> {
  if (!isTauriRuntime()) {
    return httpJson<JobStarted>("/api/ocr/proofread", {
      method: "POST",
      body: JSON.stringify({
        file_id: req.file_id,
        units: req.units,
        provider: req.provider ?? null,
        model: req.model ?? null,
        prompt: req.prompt ?? null,
      }),
    });
  }
  return invoke<JobStarted>("start_proofread", { req });
}

export async function listProviderModels(opts?: {
  settings?: NonSecretSettings;
  secret?: string;
}): Promise<string[]> {
  if (!isTauriRuntime()) {
    return httpJson<string[]>("/api/ocr/models", {
      method: "POST",
      body: JSON.stringify({
        settings: opts?.settings ?? null,
        secret: opts?.secret ?? null,
      }),
    });
  }
  return invoke<string[]>("list_provider_models", {
    settings: opts?.settings,
    secret: opts?.secret,
  });
}

export async function cancelJob(jobId: string): Promise<boolean> {
  if (!isTauriRuntime()) {
    return httpJson<boolean>(`/api/jobs/${jobId}/cancel`, { method: "POST" });
  }
  return invoke<boolean>("cancel_job", { jobId });
}

export async function listJobs(): Promise<JobListEntry[]> {
  if (!isTauriRuntime()) return httpJson<JobListEntry[]>("/api/jobs");
  return invoke<JobListEntry[]>("list_jobs");
}

/** Web/Docker only — recovers a job's cached terminal event after a lost SSE
 *  `done` (reconnect gap or page refresh). Returns `null` on 404, i.e. the
 *  job is neither running nor within the server's retention window, which
 *  callers treat as "unrecoverable, give up". Desktop has no equivalent gap
 *  (native events don't survive a reload either, but a Tauri window reload
 *  is not a normal user action), so it always returns `null`. */
export async function getJobResult(
  jobId: string
): Promise<JobEventEnvelope | null> {
  if (isTauriRuntime()) return null;
  const res = await fetch(`/api/jobs/${jobId}/result`);
  if (res.status === 404) return null;
  if (!res.ok) throw await httpError(res);
  return (await res.json()) as JobEventEnvelope;
}

export async function openLogDir(): Promise<string> {
  if (!isTauriRuntime()) {
    throw new Error(t("runtime.logDirDesktopOnly"));
  }
  return invoke<string>("open_log_dir");
}

export async function analyzePaddleJson(
  path: string
): Promise<PaddleJsonPreflightReport> {
  if (!isTauriRuntime()) {
    throw new Error(t("runtime.paddleJsonDesktopOnly"));
  }
  return invoke<PaddleJsonPreflightReport>("analyze_paddle_json", { path });
}

export async function importPaddleJson(
  path: string
): Promise<PaddleJsonImport> {
  if (!isTauriRuntime()) {
    throw new Error(t("runtime.paddleJsonDesktopOnly"));
  }
  return invoke<PaddleJsonImport>("import_paddle_json", { path });
}

export async function exportLayoutPdf(
  req: LayoutPdfExportRequest
): Promise<LayoutPdfExportResult> {
  if (!isTauriRuntime()) {
    throw new Error(t("runtime.layoutPdfDesktopOnly"));
  }
  return invoke<LayoutPdfExportResult>("export_layout_pdf", { req });
}

export async function exportReadingMarkdown(
  req: LayoutPdfExportRequest
): Promise<ReadingMarkdownExportResult> {
  if (!isTauriRuntime()) {
    throw new Error(t("runtime.markdownExportDesktopOnly"));
  }
  return invoke<ReadingMarkdownExportResult>("export_reading_markdown", { req });
}

export interface UploadedFile {
  fileId: string;
  name: string;
  ext: string;
  kind: "image" | "pdf";
}

export async function uploadFile(file: File): Promise<UploadedFile> {
  if (isTauriRuntime()) {
    throw new Error("uploadFile is only used by the browser runtime");
  }
  const form = new FormData();
  form.append("file", file, file.name);
  return httpJson<UploadedFile>("/api/files", {
    method: "POST",
    body: form,
    headers: {},
  });
}

export type KeyStatus = Record<SecretKey, boolean>;

export async function getKeyStatus(): Promise<KeyStatus> {
  const raw = await httpJson<{
    paddle_token: boolean;
    openai_key: boolean;
    openrouter_key: boolean;
    openai_compatible_key: boolean;
  }>("/api/settings/key-status");
  return raw;
}

async function httpText(path: string): Promise<string> {
  const res = await fetch(path);
  if (!res.ok) throw await httpError(res);
  return res.text();
}

async function httpArrayBuffer(path: string): Promise<ArrayBuffer> {
  const res = await fetch(path);
  if (!res.ok) throw await httpError(res);
  return res.arrayBuffer();
}

async function httpJson<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  if (init.body !== undefined && !(init.body instanceof FormData)) {
    headers.set("content-type", "application/json");
  }
  const res = await fetch(path, { ...init, headers });
  if (!res.ok) throw await httpError(res);
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

async function httpError(res: Response): Promise<Error> {
  const contentType = res.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) {
    try {
      return new HttpAppError(await res.json());
    } catch {
      // Fall through to a generic HTTP error.
    }
  }
  return new Error(`${res.status} ${res.statusText}: ${await res.text()}`);
}
