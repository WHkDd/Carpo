import { invoke } from "@tauri-apps/api/core";
import type {
  NonSecretSettings,
  PdfInfo,
  RenderPagePayload,
  RenderedPagePayload,
  SecretKey,
} from "./ipc-types";

/**
 * Typed wrappers around invoke<>(). One thin function per command keeps the
 * tauri::command surface explicit — when a backend signature changes, TypeScript
 * compilation breaks loudly here rather than at every call site.
 */

export async function ping(): Promise<string> {
  return invoke<string>("ping");
}

export async function loadRasterImage(
  path: string
): Promise<RenderedPagePayload> {
  return invoke<RenderedPagePayload>("load_raster_image", { path });
}

export async function listSupportedExtensions(): Promise<string[]> {
  return invoke<string[]>("list_supported_extensions");
}

export async function getPdfInfo(path: string): Promise<PdfInfo> {
  return invoke<PdfInfo>("get_pdf_info", { path });
}

export async function renderPage(
  payload: RenderPagePayload
): Promise<RenderedPagePayload> {
  return invoke<RenderedPagePayload>("render_page", {
    path: payload.path,
    page: payload.page,
    dpi: payload.dpi,
    purpose: payload.purpose,
  });
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
