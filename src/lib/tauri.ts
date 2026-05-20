import { invoke } from "@tauri-apps/api/core";
import type {
  GroupedOcrRequest,
  JobListEntry,
  JobStarted,
  NonSecretSettings,
  PdfInfo,
  RenderPagePayload,
  SecretKey,
  WholeFileOcrRequest,
} from "./ipc-types";
import type {
  PaddleJsonImport,
  PaddleJsonPreflightReport,
} from "./layout-document";

/**
 * Typed wrappers around invoke<>(). One thin function per command keeps the
 * tauri::command surface explicit — when a backend signature changes, TypeScript
 * compilation breaks loudly here rather than at every call site.
 */

export async function ping(): Promise<string> {
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
  const buffer = await invoke<ArrayBuffer>("load_raster_image", { path });
  return unpackPageBytes(buffer);
}

export async function listSupportedExtensions(): Promise<string[]> {
  return invoke<string[]>("list_supported_extensions");
}

export async function getPdfInfo(path: string): Promise<PdfInfo> {
  return invoke<PdfInfo>("get_pdf_info", { path });
}

export async function renderPage(
  payload: RenderPagePayload
): Promise<FetchedBitmap> {
  const buffer = await invoke<ArrayBuffer>("render_page", {
    path: payload.path,
    page: payload.page,
    dpi: payload.dpi,
    purpose: payload.purpose,
  });
  return unpackPageBytes(buffer);
}

export async function getSettings(): Promise<NonSecretSettings> {
  return invoke<NonSecretSettings>("get_settings");
}

export async function setSettings(s: NonSecretSettings): Promise<void> {
  return invoke("set_settings", { s });
}

export async function getSecret(key: SecretKey): Promise<boolean> {
  return invoke<boolean>("get_secret", { key });
}

export async function setSecret(key: SecretKey, value: string): Promise<void> {
  return invoke("set_secret", { key, value });
}

export async function deleteSecret(key: SecretKey): Promise<void> {
  return invoke("delete_secret", { key });
}

export async function startGroupedOcr(
  req: GroupedOcrRequest
): Promise<JobStarted> {
  return invoke<JobStarted>("start_grouped_ocr", { req });
}

export async function startWholeFileOcr(
  req: WholeFileOcrRequest
): Promise<JobStarted> {
  return invoke<JobStarted>("start_whole_file_ocr", { req });
}

export async function listProviderModels(opts?: {
  settings?: NonSecretSettings;
  secret?: string;
}): Promise<string[]> {
  return invoke<string[]>("list_provider_models", {
    settings: opts?.settings,
    secret: opts?.secret,
  });
}

export async function cancelJob(jobId: string): Promise<boolean> {
  return invoke<boolean>("cancel_job", { jobId });
}

export async function listJobs(): Promise<JobListEntry[]> {
  return invoke<JobListEntry[]>("list_jobs");
}

export async function openLogDir(): Promise<string> {
  return invoke<string>("open_log_dir");
}

export async function analyzePaddleJson(
  path: string
): Promise<PaddleJsonPreflightReport> {
  return invoke<PaddleJsonPreflightReport>("analyze_paddle_json", { path });
}

export async function importPaddleJson(
  path: string
): Promise<PaddleJsonImport> {
  return invoke<PaddleJsonImport>("import_paddle_json", { path });
}
